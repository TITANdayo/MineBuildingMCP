import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { createServer, type Logger, type ViteDevServer } from "vite";
import { WebSocket, WebSocketServer } from "ws";
import type {
  CameraControlParams,
  CameraStateSnapshot,
  CompiledBlockDefinition,
  InspectResult,
  InspectViewId,
  TraceRecord,
  ViewDirection,
  VoxelData,
  WsRequest,
  WsResponse,
} from "../types/shared.js";
import { defaultJarAssetLoader } from "../assets/jar-loader.js";

function parseEnvBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function openUrlInDefaultBrowser(url: string): void {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`Refusing to open non-HTTP(S) URL: ${url}`);
  }

  const child =
    process.platform === "win32"
      ? spawn("cmd", ["/c", "start", "", url], {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        })
      : process.platform === "darwin"
        ? spawn("open", [url], {
            detached: true,
            stdio: "ignore",
          })
        : spawn("xdg-open", [url], {
            detached: true,
            stdio: "ignore",
          });

  child.on("error", (err) => {
    process.stderr.write(`[WsBridge] Failed to launch default browser: ${String(err)}\n`);
  });
  child.unref();
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "../..");

function createStderrLogger(): Logger {
  const loggedErrors = new WeakSet<Error>();
  const warnedMessages = new Set<string>();

  const writeStderr = (level: string, msg: string) => {
    process.stderr.write(`[Vite:${level}] ${msg}\n`);
  };

  return {
    hasWarned: false,
    info(msg: string) {
      writeStderr("info", msg);
    },
    warn(msg: string) {
      this.hasWarned = true;
      writeStderr("warn", msg);
    },
    warnOnce(msg: string) {
      if (warnedMessages.has(msg)) return;
      warnedMessages.add(msg);
      this.hasWarned = true;
      writeStderr("warn", msg);
    },
    error(msg: string, options?: { error?: Error | null }) {
      this.hasWarned = true;
      writeStderr("error", msg);
      if (options?.error) {
        loggedErrors.add(options.error);
      }
    },
    clearScreen() {
      // no-op to preserve stderr stream
    },
    hasErrorLogged(error: Error) {
      return loggedErrors.has(error);
    },
  };
}

interface PendingRequest<T extends WsResponse = WsResponse> {
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
  expectedType: T["type"];
}

export interface SyncWorldParams {
  voxels: VoxelData[];
  size: [number, number, number];
  traces?: Record<number, TraceRecord>;
  textures?: Record<string, string>;
  blockModels?: Record<string, CompiledBlockDefinition>;
}

export interface WsBridgeOptions {
  vitePort?: number;
  wsPort?: number;
  headless?: boolean;
  openViewer?: boolean;
  openUrlFn?: (url: string) => void | Promise<void>;
  requestTimeoutMs?: number;
}

export class WsBridge {
  private viteServer: ViteDevServer | null = null;
  private wss: WebSocketServer | null = null;
  private upgradeWss: WebSocketServer | null = null;
  private browser: Browser | null = null;
  private page: Page | null = null;
  private launchingBrowserPromise: Promise<void> | null = null;
  private startingPromise: Promise<void> | null = null;

  private clients = new Set<WebSocket>();
  private clientRoles = new Map<WebSocket, "headless" | "browser">();
  private pendingRequests = new Map<string, PendingRequest<any>>();
  private latestSyncPayload: Extract<WsRequest, { type: "SYNC_WORLD" }> | null = null;
  private latestCameraRequest: Extract<WsRequest, { type: "RENDER_CAMERA" }> | null = null;
  private viewerAutoOpened = false;

  private vitePort: number;
  private wsPort: number;
  private readonly headless: boolean;
  private readonly openViewer: boolean;
  private readonly openUrlFn?: (url: string) => void | Promise<void>;
  private readonly requestTimeoutMs: number;

  constructor(options: WsBridgeOptions = {}) {
    this.vitePort =
      options.vitePort ??
      (Number(process.env.MINEBUILDING_VITE_PORT || process.env.CRAFTSTUDIO_VITE_PORT) || 5173);
    this.wsPort =
      options.wsPort ??
      (Number(process.env.MINEBUILDING_WS_PORT || process.env.CRAFTSTUDIO_WS_PORT) || 3001);
    this.headless =
      options.headless ??
      (process.env.MINEBUILDING_HEADLESS !== "false" &&
        process.env.CRAFTSTUDIO_HEADLESS !== "false");

    const hasOpenViewerFlag = process.argv.includes("--open-viewer");
    const envOpenViewer = parseEnvBool(
      process.env.MINEBUILDING_OPEN_VIEWER ?? process.env.CRAFTSTUDIO_OPEN_VIEWER
    );
    this.openViewer =
      options.openViewer ?? (hasOpenViewerFlag || envOpenViewer === true);
    this.openUrlFn = options.openUrlFn;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  public getViteUrl(): string {
    return `http://127.0.0.1:${this.vitePort}?wsPort=${this.wsPort}`;
  }

  public getWsPort(): number {
    return this.wsPort;
  }

  public getVitePort(): number {
    return this.vitePort;
  }

  public getConnectedClientCount(): number {
    let count = 0;
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        count++;
      }
    }
    return count;
  }

  public getVisibleClientCount(): number {
    let count = 0;
    for (const client of this.clients) {
      if (
        client.readyState === WebSocket.OPEN &&
        this.clientRoles.get(client) !== "headless"
      ) {
        count++;
      }
    }
    return count;
  }

  public shouldAutoOpenViewer(): boolean {
    return this.openViewer;
  }

  public hasSyncedWorld(): boolean {
    return this.latestSyncPayload !== null;
  }

  public prepareWorldPayload(params: SyncWorldParams): void {
    let textures = params.textures;
    let blockModels = params.blockModels;
    if (!blockModels) {
      const uniqueNames = Array.from(new Set(params.voxels.map((v) => v.name)));
      blockModels = defaultJarAssetLoader.getBlockModelsForBlocks(uniqueNames);
      const modelTextures = defaultJarAssetLoader.getTexturesForBlocks(uniqueNames);
      textures = textures ? { ...modelTextures, ...textures } : modelTextures;
    }

    this.latestSyncPayload = {
      type: "SYNC_WORLD",
      id: randomUUID(),
      voxels: params.voxels,
      size: params.size,
      traces: params.traces,
      textures,
      blockModels,
    };
  }

  public async openViewerInBrowser(opts?: { force?: boolean }): Promise<{
    opened: boolean;
    url: string;
    visibleClients: number;
    reason: "opened" | "already_connected" | "already_opened";
  }> {
    await this.start();
    const url = this.getViteUrl();
    const visibleClients = this.getVisibleClientCount();
    const force = Boolean(opts?.force);

    if (!force) {
      if (visibleClients > 0) {
        return {
          opened: false,
          url,
          visibleClients,
          reason: "already_connected",
        };
      }
      if (this.viewerAutoOpened) {
        return {
          opened: false,
          url,
          visibleClients,
          reason: "already_opened",
        };
      }
    }

    this.viewerAutoOpened = true;
    if (this.openUrlFn) {
      await this.openUrlFn(url);
    } else {
      openUrlInDefaultBrowser(url);
    }

    return {
      opened: true,
      url,
      visibleClients,
      reason: "opened",
    };
  }

  /**
   * Starts the Vite dev server and WebSocket servers if not already running.
   */
  public async start(): Promise<void> {
    if (this.viteServer && this.wss) {
      return;
    }
    if (this.startingPromise) {
      return this.startingPromise;
    }

    this.startingPromise = (async () => {
      await this.startWebSocketServer();
      await this.startViteServer();
    })();

    try {
      await this.startingPromise;
    } finally {
      this.startingPromise = null;
    }
  }

  private async startWebSocketServer(): Promise<void> {
    if (this.wss) return;

    const tryListen = (port: number): Promise<WebSocketServer> =>
      new Promise((resolve, reject) => {
        const server = new WebSocketServer({ host: "127.0.0.1", port });
        const onError = (err: Error) => {
          server.removeListener("listening", onListening);
          server.close();
          reject(err);
        };
        const onListening = () => {
          server.removeListener("error", onError);
          resolve(server);
        };
        server.once("error", onError);
        server.once("listening", onListening);
      });

    try {
      this.wss = await tryListen(this.wsPort);
    } catch {
      // Fallback to OS-assigned free port if default port (3001) is busy
      this.wss = await tryListen(0);
    }

    const addr = this.wss.address();
    if (addr && typeof addr === "object") {
      this.wsPort = addr.port;
    }

    this.wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
      this.handleNewConnection(ws, req);
    });

    process.stderr.write(`[WsBridge] WebSocket server listening on ws://127.0.0.1:${this.wsPort}\n`);
  }

  private async startViteServer(): Promise<void> {
    if (this.viteServer) return;

    const customLogger = createStderrLogger();
    const server = await createServer({
      root: PROJECT_ROOT,
      configFile: path.join(PROJECT_ROOT, "vite.config.ts"),
      customLogger,
      clearScreen: false,
      server: {
        port: this.vitePort,
        strictPort: false,
        host: "127.0.0.1",
      },
      define: {
        __MINEBUILDING_WS_PORT__: JSON.stringify(this.wsPort),
      },
    });

    await server.listen();
    this.viteServer = server;

    const address = server.httpServer?.address();
    if (address && typeof address === "object") {
      this.vitePort = address.port;
    }

    // Attach /ws upgrade handler on the Vite HTTP server so browsers opening
    // http://localhost:5173 can connect to either ws://localhost:3001 or ws://localhost:5173/ws
    if (server.httpServer) {
      this.upgradeWss = new WebSocketServer({ noServer: true });
      this.upgradeWss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
        this.handleNewConnection(ws, req);
      });

      server.httpServer.on("upgrade", (req, socket, head) => {
        const protocol = req.headers["sec-websocket-protocol"];
        if (protocol === "vite-hmr") {
          return; // Let Vite handle its own HMR websocket
        }
        const url = req.url ?? "";
        if (url === "/ws" || url.startsWith("/ws?")) {
          this.upgradeWss?.handleUpgrade(req, socket, head, (ws) => {
            this.upgradeWss?.emit("connection", ws, req);
          });
        }
      });
    }

    process.stderr.write(
      `[WsBridge] Vite viewer server running at http://127.0.0.1:${this.vitePort}?wsPort=${this.wsPort}\n`
    );
  }

  private handleNewConnection(ws: WebSocket, req: IncomingMessage): void {
    let role: "headless" | "browser" = "browser";
    try {
      const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      if (reqUrl.searchParams.get("client") === "headless") {
        role = "headless";
      }
    } catch {
      // default to "browser"
    }

    this.clients.add(ws);
    this.clientRoles.set(ws, role);
    process.stderr.write(
      `[WsBridge] Viewer client (${role}) connected (active clients: ${this.getConnectedClientCount()}, visible: ${this.getVisibleClientCount()})\n`
    );

    ws.on("message", (raw) => {
      try {
        const text = typeof raw === "string" ? raw : raw.toString("utf-8");
        const parsed = JSON.parse(text) as WsResponse;
        this.handleClientMessage(parsed);
      } catch (err) {
        process.stderr.write(`[WsBridge] Failed to parse message from viewer: ${String(err)}\n`);
      }
    });

    ws.on("close", () => {
      this.clients.delete(ws);
      this.clientRoles.delete(ws);
      process.stderr.write(
        `[WsBridge] Viewer client disconnected (active clients: ${this.getConnectedClientCount()})\n`
      );
    });

    ws.on("error", (err) => {
      process.stderr.write(`[WsBridge] WebSocket client error: ${String(err)}\n`);
      this.clients.delete(ws);
      this.clientRoles.delete(ws);
    });

    // Immediately push cached world state to newly connected tab/browser
    if (this.latestSyncPayload && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(this.latestSyncPayload));
        if (this.latestCameraRequest) {
          ws.send(
            JSON.stringify({
              ...this.latestCameraRequest,
              id: "init-camera-sync",
            })
          );
        }
      } catch (err) {
        process.stderr.write(`[WsBridge] Error sending initial SYNC_WORLD: ${String(err)}\n`);
      }
    }
  }

  private handleClientMessage(msg: WsResponse): void {
    if (!msg || typeof msg !== "object" || !("id" in msg) || !("type" in msg)) {
      return;
    }

    const pending = this.pendingRequests.get(msg.id);
    if (!pending) {
      return;
    }

    if (msg.type === pending.expectedType) {
      clearTimeout(pending.timer);
      this.pendingRequests.delete(msg.id);
      pending.resolve(msg);
    }
  }

  /**
   * Ensures at least one viewer client is connected, launching headless Chromium if needed.
   */
  public async ensureClientConnected(timeoutMs = 20_000): Promise<void> {
    await this.start();

    if (this.getConnectedClientCount() > 0) {
      return;
    }

    await this.launchHeadlessBrowser();

    const startTime = Date.now();
    while (this.getConnectedClientCount() === 0) {
      if (Date.now() - startTime > timeoutMs) {
        throw new Error(
          `Timed out waiting for Three.js viewer WebSocket client to connect at ${this.getViteUrl()}`
        );
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  private async launchHeadlessBrowser(): Promise<void> {
    if (this.launchingBrowserPromise) {
      return this.launchingBrowserPromise;
    }

    this.launchingBrowserPromise = (async () => {
      try {
        if (this.page && !this.page.isClosed() && this.getConnectedClientCount() > 0) {
          return;
        }

        if (!this.browser || !this.browser.isConnected()) {
          process.stderr.write("[WsBridge] Launching headless Chromium for Three.js viewer...\n");
          const fs = await import("node:fs");
          const envPaths = [
            process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
            process.env.CHROME_PATH,
          ].filter((p): p is string => Boolean(p && fs.existsSync(p)));

          const systemPaths = [
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          ].filter((p) => fs.existsSync(p));

          const defaultExecPath = chromium.executablePath();
          const hasDefaultExec = Boolean(defaultExecPath && fs.existsSync(defaultExecPath));

          type LaunchTarget = { label: string; executablePath?: string; channel?: string };
          const targets: LaunchTarget[] = [
            ...envPaths.map((p) => ({ label: `env:${p}`, executablePath: p })),
            { label: "channel:chrome", channel: "chrome" },
            { label: "channel:msedge", channel: "msedge" },
            ...(hasDefaultExec ? [{ label: "playwright-chromium", executablePath: defaultExecPath }] : []),
            ...systemPaths.map((p) => ({ label: `system:${p}`, executablePath: p })),
            ...(hasDefaultExec ? [] : [{ label: "playwright-default" }]),
          ];

          const launchArgs = [
            "--use-gl=angle",
            "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader",
            "--enable-webgl",
            "--ignore-gpu-blocklist",
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
          ];

          let lastError: unknown;
          for (const target of targets) {
            try {
              this.browser = await chromium.launch({
                headless: this.headless,
                ...(target.executablePath ? { executablePath: target.executablePath } : {}),
                ...(target.channel ? { channel: target.channel } : {}),
                args: launchArgs,
              });
              process.stderr.write(`[WsBridge] Launched headless browser via ${target.label}\n`);
              break;
            } catch (err) {
              lastError = err;
              process.stderr.write(
                `[WsBridge] Launch attempt (${target.label}) failed, trying next fallback...\n`
              );
            }
          }

          if (!this.browser) {
            throw lastError instanceof Error
              ? lastError
              : new Error(`Failed to launch any headless browser: ${String(lastError)}`);
          }
        }

        if (this.page && !this.page.isClosed()) {
          await this.page.close().catch(() => {});
        }

        const context = await this.browser.newContext({
          viewport: { width: 1024, height: 1024 },
        });
        const page = await context.newPage();

        page.on("console", (msg) => {
          process.stderr.write(`[ViewerConsole:${msg.type()}] ${msg.text()}\n`);
        });
        page.on("pageerror", (err) => {
          process.stderr.write(`[ViewerPageError] ${String(err)}\n`);
        });

        const baseUrl = this.getViteUrl();
        const targetUrl = this.headless ? `${baseUrl}&client=headless` : baseUrl;
        process.stderr.write(`[WsBridge] Navigating Chromium to ${targetUrl}\n`);
        await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
        this.page = page;
      } catch (err) {
        process.stderr.write(`[WsBridge] Failed to launch headless browser: ${String(err)}\n`);
        throw err;
      }
    })();

    try {
      await this.launchingBrowserPromise;
    } finally {
      this.launchingBrowserPromise = null;
    }
  }

  private getOpenClients(): WebSocket[] {
    const open: WebSocket[] = [];
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        open.push(client);
      }
    }
    return open;
  }

  /**
   * Broadcasts `SYNC_WORLD` to all connected clients (human + headless),
   * caches the payload for future connections, and awaits `SYNC_ACK` from at least one client.
   */
  public async syncWorld(params: SyncWorldParams): Promise<void> {
    let textures = params.textures;
    let blockModels = params.blockModels;
    if (!blockModels) {
      const uniqueNames = Array.from(new Set(params.voxels.map((v) => v.name)));
      blockModels = defaultJarAssetLoader.getBlockModelsForBlocks(uniqueNames);
      const modelTextures = defaultJarAssetLoader.getTexturesForBlocks(uniqueNames);
      textures = textures ? { ...modelTextures, ...textures } : modelTextures;
    }

    const id = randomUUID();
    const request: Extract<WsRequest, { type: "SYNC_WORLD" }> = {
      type: "SYNC_WORLD",
      id,
      voxels: params.voxels,
      size: params.size,
      traces: params.traces,
      textures,
      blockModels,
    };

    await this.ensureClientConnected();

    const prevSize = this.latestSyncPayload?.size;
    if (
      prevSize &&
      (prevSize[0] !== params.size[0] ||
        prevSize[1] !== params.size[1] ||
        prevSize[2] !== params.size[2])
    ) {
      this.latestCameraRequest = null;
    }

    // Cache latest world state so any newly connecting browser receives it immediately
    this.latestSyncPayload = request;

    await this.sendRequestWithRetry<Extract<WsResponse, { type: "SYNC_ACK" }>>(
      request,
      "SYNC_ACK",
      true // broadcast to ALL connected clients
    );
  }

  /**
   * Requests 4-angle (`NE`, `SE`, `SW`, `NW`) offscreen renders at the specified resolution.
   */
  public async renderViews(resolution = 512): Promise<Record<ViewDirection, string>> {
    await this.ensureClientConnected();

    const id = randomUUID();
    const request: Extract<WsRequest, { type: "RENDER_VIEWS" }> = {
      type: "RENDER_VIEWS",
      id,
      resolution,
    };

    const response = await this.sendRequestWithRetry<
      Extract<WsResponse, { type: "RENDER_RESULT" }>
    >(request, "RENDER_RESULT", false);

    return response.images;
  }

  /**
   * Moves/zooms the camera and renders a single view + populates the "custom" ID picker buffer.
   */
  public async renderCamera(
    params: CameraControlParams = {}
  ): Promise<{ image: string; camera: CameraStateSnapshot }> {
    await this.ensureClientConnected();

    const id = randomUUID();
    const request: Extract<WsRequest, { type: "RENDER_CAMERA" }> = {
      type: "RENDER_CAMERA",
      id,
      params,
    };

    const response = await this.sendRequestWithRetry<
      Extract<WsResponse, { type: "RENDER_CAMERA_RESULT" }>
    >(request, "RENDER_CAMERA_RESULT", true);

    this.latestCameraRequest = request;

    return {
      image: response.image,
      camera: response.camera,
    };
  }

  /**
   * Queries the offscreen RGBA picking buffer at pixel or normalized coordinates `(u, v)`.
   */
  public async inspectPixel(
    view: InspectViewId,
    u: number,
    v: number
  ): Promise<InspectResult> {
    await this.ensureClientConnected();

    const id = randomUUID();
    const request: Extract<WsRequest, { type: "INSPECT_PIXEL" }> = {
      type: "INSPECT_PIXEL",
      id,
      view,
      u,
      v,
    };

    const response = await this.sendRequestWithRetry<
      Extract<WsResponse, { type: "INSPECT_RESULT" }>
    >(request, "INSPECT_RESULT", false);

    return response.data;
  }

  private async sendRequestWithRetry<T extends WsResponse>(
    request: WsRequest,
    expectedType: T["type"],
    broadcastToAll: boolean,
    maxAttempts = 2
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.ensureClientConnected();
        return await this.sendRequestOnce<T>(request, expectedType, broadcastToAll);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        process.stderr.write(
          `[WsBridge] Request ${request.type} (attempt ${attempt}/${maxAttempts}) failed: ${lastError.message}\n`
        );

        if (attempt < maxAttempts) {
          // Force relaunch/reconnect of headless browser if clients became unresponsive
          if (this.getConnectedClientCount() === 0 || this.page) {
            try {
              if (this.page && !this.page.isClosed()) {
                await this.page.reload({ waitUntil: "domcontentloaded", timeout: 10_000 });
              } else {
                await this.launchHeadlessBrowser();
              }
            } catch {
              // ignore reload error and let next attempt handle ensureClientConnected
            }
          }
        }
      }
    }

    throw lastError ?? new Error(`Request ${request.type} failed`);
  }

  private sendRequestOnce<T extends WsResponse>(
    request: WsRequest,
    expectedType: T["type"],
    broadcastToAll: boolean
  ): Promise<T> {
    const openClients = this.getOpenClients();
    if (openClients.length === 0) {
      return Promise.reject(new Error("No connected WebSocket viewer clients available"));
    }

    const serialized = JSON.stringify(request);

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(request.id);
        reject(
          new Error(
            `Timed out waiting for ${expectedType} (request id=${request.id}, type=${request.type}) after ${this.requestTimeoutMs}ms`
          )
        );
      }, this.requestTimeoutMs);

      this.pendingRequests.set(request.id, {
        resolve,
        reject,
        timer,
        expectedType,
      });

      try {
        if (broadcastToAll) {
          for (const client of openClients) {
            client.send(serialized);
          }
        } else {
          // Prefer the most recently connected active client (or broadcast so whichever responds first resolves)
          for (const client of openClients) {
            client.send(serialized);
          }
        }
      } catch (err) {
        clearTimeout(timer);
        this.pendingRequests.delete(request.id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Gracefully shuts down the headless browser, WebSocket server, and Vite server.
   */
  public async stop(): Promise<void> {
    for (const [id, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("WsBridge shutting down"));
      this.pendingRequests.delete(id);
    }

    for (const client of this.clients) {
      try {
        client.close();
      } catch {
        // ignore
      }
    }
    this.clients.clear();
    this.clientRoles.clear();

    if (this.page && !this.page.isClosed()) {
      await this.page.close().catch(() => {});
      this.page = null;
    }

    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }

    if (this.upgradeWss) {
      await new Promise<void>((resolve) => this.upgradeWss!.close(() => resolve()));
      this.upgradeWss = null;
    }

    if (this.wss) {
      await new Promise<void>((resolve) => this.wss!.close(() => resolve()));
      this.wss = null;
    }

    if (this.viteServer) {
      await this.viteServer.close().catch(() => {});
      this.viteServer = null;
    }
  }
}

#!/usr/bin/env node

import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { format as utilFormat } from "node:util";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type GetPromptResult,
} from "@modelcontextprotocol/sdk/types.js";
import { defaultJarAssetLoader, JarAssetLoader } from "../assets/jar-loader.js";
import { clampResolution } from "../core/block-name.js";
import { executeBuildScript } from "../core/builder-dsl.js";
import { loadStructureNbt, saveStructureNbt } from "../core/nbt-io.js";
import { formatLintReportSummary } from "../core/structure-linter.js";
import { VoxelWorld } from "../core/voxel-world.js";
import type {
  BlockState,
  CameraControlParams,
  CameraPreset,
  CameraProjection,
  CardinalDirection,
  CompiledBlockDefinition,
  InspectResult,
  InspectViewId,
  RenderInteriorRoomCamera,
  StructureEvaluation,
  TraceRecord,
  Vec3,
  ViewDirection,
} from "../types/shared.js";
import { WsBridge, type WsBridgeOptions } from "./ws-bridge.js";

let consoleRedirectedToStderr = false;

/**
 * Redirects `console.log/info/warn/debug` to stderr so stdio MCP JSON-RPC frames
 * are never polluted. Safe against circular objects, BigInts, and Error instances.
 */
function redirectConsoleToStderr(): void {
  if (consoleRedirectedToStderr) return;
  consoleRedirectedToStderr = true;
  const writeStderr = (...args: unknown[]) => {
    process.stderr.write(`${utilFormat(...args)}\n`);
  };
  console.log = writeStderr;
  console.info = writeStderr;
  console.warn = writeStderr;
  console.debug = writeStderr;
}

export const MAX_LINT_FLOATING_BLOCKS = 100;
export const MAX_LINT_ISSUES = 200;
const MAX_REPORT_WARNINGS = 50;
const MAX_REPORT_LINT_ISSUES = 50;
const MAX_REPORT_TRACES = 200;
const DEFAULT_MAX_INTERIOR_ROOMS = 8;
const MAX_FULL_HEIGHTMAP_DIM = 64;

const VIEW_DIRECTIONS: ViewDirection[] = ["NE", "SE", "SW", "NW"];
const CARDINAL_DIRECTIONS: CardinalDirection[] = ["N", "S", "E", "W"];
const INSPECT_VIEWS: InspectViewId[] = ["NE", "SE", "SW", "NW", "custom"];
const CAMERA_PRESETS: CameraPreset[] = [
  "NE",
  "SE",
  "SW",
  "NW",
  "N",
  "S",
  "E",
  "W",
  "TOP",
  "FRONT",
  "BACK",
  "LEFT",
  "RIGHT",
  "RESET",
];
const CAMERA_PROJECTIONS: CameraProjection[] = ["perspective", "orthographic"];

function parseOptionalFiniteNumber(
  val: unknown,
  fieldName: string
): number | undefined {
  if (val === undefined || val === null) return undefined;
  if (typeof val === "string" && val.trim() === "") {
    throw new Error(`Argument "${fieldName}" must be a finite number.`);
  }
  const num = Number(val);
  if (!Number.isFinite(num)) {
    throw new Error(`Argument "${fieldName}" must be a finite number.`);
  }
  return num;
}

function parseOptionalBoolean(
  val: unknown,
  fieldName: string
): boolean | undefined {
  if (val === undefined || val === null) return undefined;
  if (typeof val === "boolean") return val;
  if (typeof val === "string") {
    const lower = val.trim().toLowerCase();
    if (lower === "true") return true;
    if (lower === "false") return false;
  }
  throw new Error(`Argument "${fieldName}" must be a boolean.`);
}

function parseOptionalVec3(val: unknown, fieldName: string): Vec3 | undefined {
  if (val === undefined || val === null) return undefined;
  if (typeof val !== "object" || Array.isArray(val)) {
    throw new Error(`Argument "${fieldName}" must be an object { x, y, z }.`);
  }
  const obj = val as Record<string, unknown>;
  const x = parseOptionalFiniteNumber(obj.x, `${fieldName}.x`);
  const y = parseOptionalFiniteNumber(obj.y, `${fieldName}.y`);
  const z = parseOptionalFiniteNumber(obj.z, `${fieldName}.z`);
  if (x === undefined || y === undefined || z === undefined) {
    throw new Error(
      `Argument "${fieldName}" must include finite numeric x, y, and z.`
    );
  }
  return { x, y, z };
}

function parseOptionalPartialVec3(
  val: unknown,
  fieldName: string
): Partial<Vec3> | undefined {
  if (val === undefined || val === null) return undefined;
  if (typeof val !== "object" || Array.isArray(val)) {
    throw new Error(
      `Argument "${fieldName}" must be an object with optional x, y, z.`
    );
  }
  const obj = val as Record<string, unknown>;
  const out: Partial<Vec3> = {};
  const x = parseOptionalFiniteNumber(obj.x, `${fieldName}.x`);
  const y = parseOptionalFiniteNumber(obj.y, `${fieldName}.y`);
  const z = parseOptionalFiniteNumber(obj.z, `${fieldName}.z`);
  if (x !== undefined) out.x = x;
  if (y !== undefined) out.y = y;
  if (z !== undefined) out.z = z;
  return out;
}

function parseCameraControlParams(
  raw: Record<string, unknown>
): CameraControlParams {
  const params: CameraControlParams = {};

  if (raw.preset !== undefined && raw.preset !== null) {
    const preset = String(raw.preset).toUpperCase() as CameraPreset;
    if (!CAMERA_PRESETS.includes(preset)) {
      throw new Error(
        `Invalid preset "${String(raw.preset)}". Expected one of: ${CAMERA_PRESETS.join(", ")}.`
      );
    }
    params.preset = preset;
  }

  if (raw.projection !== undefined && raw.projection !== null) {
    const projection = String(raw.projection).toLowerCase() as CameraProjection;
    if (!CAMERA_PROJECTIONS.includes(projection)) {
      throw new Error(
        `Invalid projection "${String(raw.projection)}". Expected "perspective" or "orthographic".`
      );
    }
    params.projection = projection;
  }

  const target = parseOptionalVec3(raw.target, "target");
  if (target) params.target = target;

  const position = parseOptionalVec3(raw.position, "position");
  if (position) params.position = position;

  const pan = parseOptionalPartialVec3(raw.pan, "pan");
  if (pan) params.pan = pan;

  const yaw = parseOptionalFiniteNumber(raw.yaw, "yaw");
  if (yaw !== undefined) params.yaw = yaw;

  const pitch = parseOptionalFiniteNumber(raw.pitch, "pitch");
  if (pitch !== undefined) params.pitch = pitch;

  const distance = parseOptionalFiniteNumber(raw.distance, "distance");
  if (distance !== undefined) {
    if (distance <= 0) {
      throw new Error('Argument "distance" must be greater than 0.');
    }
    params.distance = distance;
  }

  const zoom = parseOptionalFiniteNumber(raw.zoom, "zoom");
  if (zoom !== undefined) {
    if (zoom <= 0) {
      throw new Error('Argument "zoom" must be greater than 0.');
    }
    params.zoom = zoom;
  }

  const fov = parseOptionalFiniteNumber(raw.fov, "fov");
  if (fov !== undefined) {
    if (fov <= 0) {
      throw new Error('Argument "fov" must be greater than 0.');
    }
    params.fov = fov;
  }

  const orthoSize = parseOptionalFiniteNumber(raw.orthoSize, "orthoSize");
  if (orthoSize !== undefined) {
    if (orthoSize <= 0) {
      throw new Error('Argument "orthoSize" must be greater than 0.');
    }
    params.orthoSize = orthoSize;
  }

  const zoomFactor = parseOptionalFiniteNumber(raw.zoomFactor, "zoomFactor");
  if (zoomFactor !== undefined) {
    if (zoomFactor <= 0) {
      throw new Error('Argument "zoomFactor" must be greater than 0.');
    }
    params.zoomFactor = zoomFactor;
  }

  const deltaYaw = parseOptionalFiniteNumber(raw.deltaYaw, "deltaYaw");
  if (deltaYaw !== undefined) params.deltaYaw = deltaYaw;

  const deltaPitch = parseOptionalFiniteNumber(raw.deltaPitch, "deltaPitch");
  if (deltaPitch !== undefined) params.deltaPitch = deltaPitch;

  const deltaDistance = parseOptionalFiniteNumber(
    raw.deltaDistance,
    "deltaDistance"
  );
  if (deltaDistance !== undefined) params.deltaDistance = deltaDistance;

  const resolution = parseOptionalFiniteNumber(raw.resolution, "resolution");
  if (resolution !== undefined) {
    params.resolution = clampResolution(resolution);
  }

  const syncViewer = parseOptionalBoolean(raw.syncViewer, "syncViewer");
  if (syncViewer !== undefined) {
    params.syncViewer = syncViewer;
  }

  return params;
}

/**
 * Creates a default 32x32x32 world with a flat grass/dirt/stone base (Y=0..3)
 * so `run_build_script` works out-of-the-box even before `load_terrain` is called.
 */
export function createDefaultTerrainWorld(
  size: [number, number, number] = [32, 32, 32]
): VoxelWorld {
  const world = new VoxelWorld(size);
  const [sx, , sz] = world.size;
  for (let x = 0; x < sx; x++) {
    for (let z = 0; z < sz; z++) {
      world.setVoxel(x, 0, z, "minecraft:stone", undefined, true, 0);
      world.setVoxel(x, 1, z, "minecraft:stone", undefined, true, 0);
      world.setVoxel(x, 2, z, "minecraft:dirt", undefined, true, 0);
      world.setVoxel(x, 3, z, "minecraft:grass_block", undefined, true, 0);
    }
  }
  world.saveInitialTerrainSnapshot();
  return world;
}

function stripDataUrlPrefix(base64OrDataUrl: string): string {
  const commaIdx = base64OrDataUrl.indexOf(",");
  if (base64OrDataUrl.startsWith("data:") && commaIdx !== -1) {
    return base64OrDataUrl.slice(commaIdx + 1);
  }
  return base64OrDataUrl;
}

export function buildArchitecturalWorkflowPrompt(theme?: string): string {
  const targetTheme = theme?.trim() ? `「${theme.trim()}」` : "対象テーマ";
  return [
    `# MineBuildingMCP 標準建築ワークフロー＆設計前リサーチ指針（${targetTheme}）`,
    "",
    "Minecraft建築を開始する際は、いきなり `run_build_script` でDSLを書き始めず、必ず以下の3フェーズを順番に実行してください。",
    "",
    "## Phase 1: 設計前リサーチ（Minecraft建築の定番イディオム調査）",
    `建築テーマ（${targetTheme}）やモチーフが決まったら、まずWeb検索（\`search_web\` 等）を用いて **そのテーマにおけるMinecraft特有の建築イディオム・表現技法** を調査・整理してください：`,
    "1. **屋根の勾配と軒先（Roof Pitch & Overhangs）**：階段・ハーフブロック・フルブロックの組み合わせ比率（急勾配のゴシック屋根 vs 緩勾配の和風/ファンタジー屋根）、破風（Gable）やドーマーの縁取り表現。",
    "2. **壁面の奥行きとフレーム構造（Wall Depth & Framing）**：のっぺりした1層の壁を避け、柱（原木・石レンガ塀）を1ブロック手前に出す2層構造や、階段・トラップドア・塀（`*_wall`）による凹凸ディテール。",
    "3. **ブロックパレットの混色（Palette Texturing & Gradient）**：単一ブロックのベタ塗りを避け、同系色3〜4種類（例：`stone_bricks` + `cracked_stone_bricks` + `andesite` + `mossy_stone_bricks`）をグラデーションやノイズ状に混ぜる手法。",
    "4. **鎖・照明・接続パーツのバニラ仕様（Vanilla Block Mechanics）**：",
    "   - **鎖（`chain` / `iron_chain`）のT字・L字直結禁止**：Minecraftの鎖は単一軸（`axis=x/y/z`）しか持てず、横方向の鎖（`axis=x/z`）の途中から縦方向の鎖（`axis=y`）や吊り下げランタンを直接分岐させると見た目が破綻します。必ず交点に **フェンス（`*_fence`）・塀（`*_wall`）・砥石（`grindstone`）・ホッパー（`hopper`）・フルブロック** 等の中継パーツを噛ませてください。",
    "   - **支持体（Support Block）の確保**：吊り下げランタン（`hanging=true`）の直上、壁張り付きブロック（`vine` / `glow_lichen`）の背面、壁掛け松明等の接続面には必ず有効な支持ブロックを配置してください。",
    "",
    "## Phase 2: 地形読み込みと段階的DSL構築",
    "- `load_terrain` で地形のHeightmapと傾斜を確認し、`placeFoundation` 等で土台を接地させてから外壁・屋根・内装を構築します。",
    "",
    "## Phase 3: バニラ建築整合性リンター（`lint_structure`）と視覚確認ループ",
    "- `run_build_script` 実行時に自動出力される **Vanilla Building Linter** の警告、または `lint_structure` ツールを実行して、以下が **0件** になるまで修正を繰り返してください：",
    "  - `axis_mismatch_junction`：鎖などの単軸細身ブロックが異なる `axis` で直接隣接している箇所（交点にフェンス・塀・砥石・フルブロック等を挟んで解決）。",
    "  - `missing_support`：ツタ等の壁張り付きブロックや `hanging=true/false` のランタン等の支持先が空気（または横向きの鎖など非支持ブロック）になっている箇所。",
    "- 視覚的に気になる箇所は `render_camera` でズームし、`inspect_pixel(view, u, v)` で3D座標とDSL行番号（`line`）を逆引きしてピンポイントで修正してから `export_structure` で完了としてください。",
  ].join("\n");
}

function formatBuildReport(
  opCount: number,
  traces: Record<number, TraceRecord>,
  evaluation: StructureEvaluation,
  world: VoxelWorld,
  resolution: number,
  viewerUrl: string
): string {
  const lines: string[] = [];
  lines.push("=== MineBuildingMCP Build Execution Report ===");
  lines.push(
    `World Size: ${world.size[0]}x${world.size[1]}x${world.size[2]} | Total Voxels: ${world.voxels.size} | Build Voxels Placed: ${evaluation.totalBuildBlocks} | DSL Operations: ${opCount}`
  );
  lines.push(`Live 3D Viewer URL: ${viewerUrl}`);
  lines.push(
    `Static Structural Check: ${evaluation.valid ? "PASSED (Grounded & In-Bounds)" : "WARNINGS DETECTED"}`
  );

  if (evaluation.warnings.length > 0) {
    lines.push("");
    lines.push("--- Structural Warnings ---");
    const previewWarnings = evaluation.warnings.slice(0, MAX_REPORT_WARNINGS);
    for (const warning of previewWarnings) {
      lines.push(`- [!] ${warning}`);
    }
    if (evaluation.warnings.length > previewWarnings.length) {
      lines.push(
        `  ... and ${evaluation.warnings.length - previewWarnings.length} more warning(s) omitted.`
      );
    }
  }

  if (evaluation.floatingBlocks.length > 0) {
    lines.push(
      `Floating Blocks Count: ${evaluation.floatingBlocks.length} across ${evaluation.floatingClustersCount} cluster(s)`
    );
    const previewFloating = evaluation.floatingBlocks.slice(0, 10);
    for (const fb of previewFloating) {
      const traceStr = fb.trace
        ? `Line ${fb.trace.line} (${fb.trace.codeSnippet})`
        : `opId=${fb.opId}`;
      lines.push(
        `  * (${fb.x}, ${fb.y}, ${fb.z}) ${fb.name} [distanceToGround=${fb.distanceToGround}] -> ${traceStr}`
      );
    }
    if (evaluation.floatingBlocks.length > previewFloating.length) {
      lines.push(
        `  ... and ${evaluation.floatingBlocks.length - previewFloating.length} more floating block(s).`
      );
    }
  }

  const lintIssues = evaluation.lintIssues ?? [];
  lines.push("");
  lines.push("--- Vanilla Building Linter (Minecraft Block Spec Check) ---");
  lines.push(formatLintReportSummary(lintIssues, MAX_REPORT_LINT_ISSUES));

  const traceEntries = Object.values(traces).sort((a, b) => a.opId - b.opId);
  if (traceEntries.length > 0) {
    lines.push("");
    lines.push("--- Operation Trace Table (opId -> Line -> Code) ---");
    const previewTraces = traceEntries.slice(0, MAX_REPORT_TRACES);
    for (const t of previewTraces) {
      lines.push(`  opId #${t.opId} | Line ${t.line}: ${t.codeSnippet}`);
    }
    if (traceEntries.length > previewTraces.length) {
      lines.push(
        `  ... and ${traceEntries.length - previewTraces.length} more trace entry(ies) omitted.`
      );
    }
  }

  lines.push("");
  lines.push(
    `Rendered 4 Orthographic Views (NE, SE, SW, NW) at ${resolution}x${resolution}px. Use inspect_pixel(view, u, v) with u,v in [0.0, 1.0] to query exact 3D coordinates and source code lines for any pixel, and run lint_structure to verify 0 spec warnings before completion.`
  );

  return lines.join("\n");
}

export class MineBuildingMcpServer {
  public readonly server: Server;
  public readonly wsBridge: WsBridge;
  public readonly assetLoader: JarAssetLoader;
  public world: VoxelWorld;

  constructor(options: WsBridgeOptions = {}) {
    this.world = createDefaultTerrainWorld([32, 32, 32]);
    this.assetLoader = defaultJarAssetLoader;
    this.wsBridge = new WsBridge(options);

    this.server = new Server(
      {
        name: "MineBuildingMCP",
        version: "1.1.0",
      },
      {
        capabilities: {
          tools: {},
          prompts: {},
        },
      }
    );

    this.registerHandlers();
  }

  private collectWorldAssets(): {
    textures: Record<string, string>;
    blockModels: Record<string, CompiledBlockDefinition>;
  } {
    const uniqueNames = this.world.getUniqueBlockNames();
    return {
      textures: this.assetLoader.getTexturesForBlocks(uniqueNames),
      blockModels: this.assetLoader.getBlockModelsForBlocks(uniqueNames),
    };
  }

  private async syncCurrentWorldToViewer(): Promise<{
    textures: Record<string, string>;
    blockModels: Record<string, CompiledBlockDefinition>;
    resolvedMap: Map<string, BlockState>;
  }> {
    const { textures, blockModels } = this.collectWorldAssets();
    const { resolvedMap } = this.world.resolveBlockStatesWithMap(blockModels);
    const voxels = this.world.getAllVoxels();
    const traces = this.world.getTracesObject();
    await this.wsBridge.syncWorld({
      voxels,
      size: [...this.world.size],
      traces,
      textures,
      blockModels,
    });
    return { textures, blockModels, resolvedMap };
  }

  private async maybeAutoOpenViewer(): Promise<void> {
    if (!this.wsBridge.shouldAutoOpenViewer()) return;
    await this.wsBridge.openViewerInBrowser().catch((err) => {
      process.stderr.write(
        `[MineBuildingMCP] Failed to auto-open viewer browser: ${String(err)}\n`
      );
    });
  }

  public async handleLoadTerrain(args: { nbtPath: string }): Promise<CallToolResult> {
    if (!args?.nbtPath || typeof args.nbtPath !== "string") {
      throw new Error("Missing or invalid required argument: nbtPath (string)");
    }

    const resolvedPath = path.resolve(args.nbtPath);
    this.world = await loadStructureNbt(resolvedPath);
    const summary = this.world.getTerrainSummary();

    await this.syncCurrentWorldToViewer();
    await this.maybeAutoOpenViewer();

    const [sizeX, , sizeZ] = summary.size;
    let payloadHeightmap: number[][] = summary.heightmap;
    let heightmapStep: [number, number] | undefined;
    if (sizeX > MAX_FULL_HEIGHTMAP_DIM || sizeZ > MAX_FULL_HEIGHTMAP_DIM) {
      const stepX = Math.max(1, Math.ceil(sizeX / 32));
      const stepZ = Math.max(1, Math.ceil(sizeZ / 32));
      heightmapStep = [stepX, stepZ];
      payloadHeightmap = [];
      for (let x = 0; x < sizeX; x += stepX) {
        const row: number[] = [];
        for (let z = 0; z < sizeZ; z += stepZ) {
          row.push(summary.heightmap[x][z]);
        }
        payloadHeightmap.push(row);
      }
    }

    const payload = {
      status: "ok",
      nbtPath: resolvedPath,
      viewerUrl: this.wsBridge.getViteUrl(),
      size: summary.size,
      minY: summary.minY,
      maxY: summary.maxY,
      averageY: summary.averageY,
      slopeSummary: summary.slopeSummary,
      blockCounts: summary.blockCounts,
      ...(heightmapStep ? { heightmapStep } : {}),
      heightmap: payloadHeightmap,
    };

    return {
      content: [
        {
          type: "text",
          text: `${summary.textSummary}\n\nJSON Details:\n${JSON.stringify(payload, null, 2)}`,
        },
      ],
    };
  }

  public async handleRunBuildScript(args: {
    jsCode: string;
    resolution?: number;
    resetBeforeRun?: boolean;
  }): Promise<CallToolResult> {
    if (!args || typeof args.jsCode !== "string") {
      throw new Error("Missing or invalid required argument: jsCode (string)");
    }

    const resolution = clampResolution(args.resolution, 512);
    const resetBeforeRun = args.resetBeforeRun !== false;

    const execResult = executeBuildScript(
      this.world,
      args.jsCode,
      resetBeforeRun,
      { evaluate: false }
    );
    const { blockModels, resolvedMap } = await this.syncCurrentWorldToViewer();
    const evaluation = this.world.evaluateStructure(blockModels, {
      preResolvedStates: resolvedMap,
    });
    await this.maybeAutoOpenViewer();
    const images = await this.wsBridge.renderViews(resolution);

    const reportText = formatBuildReport(
      execResult.opCount,
      execResult.traces,
      evaluation,
      this.world,
      resolution,
      this.wsBridge.getViteUrl()
    );

    const content: CallToolResult["content"] = [
      {
        type: "text",
        text: reportText,
      },
    ];

    for (const dir of VIEW_DIRECTIONS) {
      const rawImage = images[dir];
      if (rawImage) {
        content.push({
          type: "text",
          text: `[View: ${dir} (${resolution}x${resolution}px) — pass view="${dir}" and normalized u,v in [0.0, 1.0] to inspect_pixel]`,
        });
        content.push({
          type: "image",
          mimeType: "image/png",
          data: stripDataUrlPrefix(rawImage),
        });
      }
    }

    return { content };
  }

  public async handleRenderCamera(
    args: CameraControlParams = {}
  ): Promise<CallToolResult> {
    const params = parseCameraControlParams(
      (args ?? {}) as Record<string, unknown>
    );

    if (!this.wsBridge.hasSyncedWorld()) {
      await this.syncCurrentWorldToViewer();
    }

    const { image, camera } = await this.wsBridge.renderCamera(params);
    await this.maybeAutoOpenViewer();

    const summaryLines = [
      `=== MineBuildingMCP Custom Camera Render ===`,
      `Projection: ${camera.projection} | Resolution: ${camera.resolution}x${camera.resolution}px | Zoom: ${camera.zoom}x`,
      `Target: (${camera.target.x.toFixed(2)}, ${camera.target.y.toFixed(2)}, ${camera.target.z.toFixed(2)}) | Position: (${camera.position.x.toFixed(2)}, ${camera.position.y.toFixed(2)}, ${camera.position.z.toFixed(2)})`,
      `Orientation: yaw=${camera.yaw}°, pitch=${camera.pitch}°, distance=${camera.distance}`,
      `Live 3D Viewer URL: ${this.wsBridge.getViteUrl()}`,
      `Use inspect_pixel(view="custom", u, v) with u,v in [0.0, 1.0] (or integer pixels [0, ${camera.resolution - 1}]) to inspect any block in this custom view.`,
      "",
      `Camera State JSON:\n${JSON.stringify(camera, null, 2)}`,
    ];

    return {
      content: [
        {
          type: "text",
          text: summaryLines.join("\n"),
        },
        {
          type: "image",
          mimeType: "image/png",
          data: stripDataUrlPrefix(image),
        },
      ],
    };
  }

  public async handleOpenViewer(args?: {
    force?: boolean;
  }): Promise<CallToolResult> {
    await this.wsBridge.start();

    if (this.wsBridge.getConnectedClientCount() > 0) {
      await this.syncCurrentWorldToViewer();
    } else if (!this.wsBridge.hasSyncedWorld()) {
      const { textures, blockModels } = this.collectWorldAssets();
      this.world.resolveBlockStates(blockModels);
      const voxels = this.world.getAllVoxels();
      const traces = this.world.getTracesObject();
      this.wsBridge.prepareWorldPayload({
        voxels,
        size: [...this.world.size],
        traces,
        textures,
        blockModels,
      });
    }

    const result = await this.wsBridge.openViewerInBrowser({
      force: Boolean(args?.force),
    });

    const payload = {
      status: "ok",
      opened: result.opened,
      reason: result.reason,
      viewerUrl: result.url,
      visibleClients: result.visibleClients,
    };

    const msg =
      result.reason === "opened"
        ? `Opened 3D viewer in default browser: ${result.url}`
        : result.reason === "already_connected"
          ? `A visible 3D viewer browser is already connected (${result.visibleClients} client(s)): ${result.url}`
          : `3D viewer was already opened earlier in this session (${result.url}). Pass force=true to open another tab.`;

    return {
      content: [
        {
          type: "text",
          text: `${msg}\n\n${JSON.stringify(payload, null, 2)}`,
        },
      ],
    };
  }

  public async handleInspectPixel(args: {
    view: InspectViewId;
    u: number;
    v: number;
  }): Promise<CallToolResult> {
    if (!args || !INSPECT_VIEWS.includes(args.view)) {
      throw new Error(
        `Invalid view "${String(args?.view)}". Expected one of: ${INSPECT_VIEWS.join(", ")}.`
      );
    }
    const u = Number(args.u);
    const v = Number(args.v);
    if (!Number.isFinite(u) || !Number.isFinite(v) || u < 0 || v < 0) {
      throw new Error(
        "Arguments u and v must be non-negative finite numbers (either pixel coordinates [0, resolution-1] or normalized [0.0, 1.0])."
      );
    }

    const viewerInspect = await this.wsBridge.inspectPixel(
      args.view,
      u,
      v
    );

    let finalResult: InspectResult;
    if (!viewerInspect.hit || !viewerInspect.coord) {
      finalResult = { hit: false };
    } else {
      const { x, y, z } = viewerInspect.coord;
      const pickerOpId = viewerInspect.trace?.opId;
      const worldInspect = this.world.inspectAt(x, y, z, pickerOpId);
      if (worldInspect.hit) {
        finalResult = worldInspect;
      } else {
        // Fallback if voxel was only reported by viewer
        const trace =
          pickerOpId !== undefined ? this.world.traces.get(pickerOpId) : viewerInspect.trace;
        finalResult = {
          hit: true,
          coord: { x, y, z },
          block: viewerInspect.block ?? "minecraft:unknown",
          ...(viewerInspect.state ? { state: viewerInspect.state } : {}),
          isTerrain: viewerInspect.isTerrain ?? (pickerOpId === 0),
          ...(trace ? { trace } : {}),
          distanceToGround:
            viewerInspect.distanceToGround ?? this.world.getDistanceToGround(x, y, z),
        };
      }
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(finalResult, null, 2),
        },
      ],
    };
  }

  public async handleInspectInterior(args: {
    cutY?: number;
    resolution?: number;
    maxRooms?: number;
  }): Promise<CallToolResult> {
    const resolution = clampResolution(args?.resolution, 512);
    const maxRooms =
      typeof args?.maxRooms === "number" && Number.isFinite(args.maxRooms)
        ? Math.max(0, Math.min(32, Math.floor(args.maxRooms)))
        : DEFAULT_MAX_INTERIOR_ROOMS;

    const analysis = this.world.detectInteriorRooms();
    const cutY =
      typeof args?.cutY === "number" && Number.isFinite(args.cutY)
        ? Math.floor(args.cutY)
        : analysis.suggestedCutY;

    const renderedRooms = analysis.rooms.slice(0, maxRooms);
    const roomCameras: RenderInteriorRoomCamera[] = renderedRooms.map((r) => ({
      roomId: r.roomId,
      eyePosition: r.eyePosition,
    }));

    await this.syncCurrentWorldToViewer();
    await this.maybeAutoOpenViewer();
    const renderRes = await this.wsBridge.renderInterior(cutY, roomCameras, resolution);

    const roomsOmittedCount = Math.max(0, analysis.rooms.length - renderedRooms.length);
    const payload = {
      cutY: renderRes.cutY,
      validFlow: analysis.validFlow,
      roomsCount: analysis.rooms.length,
      eyeViewsRenderedRooms: renderedRooms.length,
      ...(roomsOmittedCount > 0 ? { eyeViewsOmittedRooms: roomsOmittedCount } : {}),
      rooms: analysis.rooms.map((r) => ({
        roomId: r.roomId,
        floorY: r.floorY,
        ceilingY: r.ceilingY,
        center: r.center,
        eyePosition: r.eyePosition,
        bounds: r.bounds,
        volume: r.volume,
        lightingCount: r.lightingCount,
        doors: r.doors,
        innerWallCount: r.innerWallPositions.length,
      })),
      flowIssues: analysis.flowIssues,
    };

    const omittedNote =
      roomsOmittedCount > 0
        ? ` Eye-level renders capped to first ${renderedRooms.length} of ${analysis.rooms.length} room(s) (pass maxRooms to adjust).`
        : "";
    const content: CallToolResult["content"] = [
      {
        type: "text",
        text: `${analysis.summaryText}\n\nCutaway Height: cutY=${renderRes.cutY} (Offscreen ID Picker is now synchronized to this Dollhouse Cutaway! Call inspect_pixel(view, u, v) to inspect interior furniture, floors, and inner walls directly).${omittedNote}\n\nJSON Details:\n${JSON.stringify(payload, null, 2)}`,
      },
    ];

    for (const dir of VIEW_DIRECTIONS) {
      const rawImage = renderRes.cutawayImages[dir];
      if (rawImage) {
        content.push({
          type: "text",
          text: `[Dollhouse Cutaway View: ${dir} at cutY=${renderRes.cutY} (${resolution}x${resolution}px) — pass view="${dir}" and u,v to inspect_pixel to reverse-lookup interior furniture & walls]`,
        });
        content.push({
          type: "image",
          mimeType: "image/png",
          data: stripDataUrlPrefix(rawImage),
        });
      }
    }

    for (const room of renderedRooms) {
      const eyeMap = renderRes.roomEyeImages[room.roomId];
      if (!eyeMap) continue;
      for (const dir of CARDINAL_DIRECTIONS) {
        const rawEye = eyeMap[dir];
        if (rawEye) {
          content.push({
            type: "text",
            text: `[Room #${room.roomId} Eye-Level View (${dir}) from (${room.eyePosition.x.toFixed(1)}, ${room.eyePosition.y.toFixed(1)}, ${room.eyePosition.z.toFixed(1)})]`,
          });
          content.push({
            type: "image",
            mimeType: "image/png",
            data: stripDataUrlPrefix(rawEye),
          });
        }
      }
    }

    return { content };
  }

  public async handleExportStructure(args: {
    outputPath: string;
  }): Promise<CallToolResult> {
    if (!args?.outputPath || typeof args.outputPath !== "string") {
      throw new Error("Missing or invalid required argument: outputPath (string)");
    }

    const resolvedPath = path.resolve(args.outputPath);
    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
    const uniqueNames = this.world.getUniqueBlockNames();
    const blockModels = this.assetLoader.getBlockModelsForBlocks(uniqueNames);
    const { resolvedMap } = this.world.resolveBlockStatesWithMap(blockModels);
    await saveStructureNbt(this.world, resolvedPath, blockModels, resolvedMap);

    const totalVoxels = this.world.voxels.size;
    let buildVoxels = 0;
    let terrainVoxels = 0;
    for (const v of this.world.voxels.values()) {
      if (v.isTerrain) terrainVoxels++;
      else buildVoxels++;
    }

    const format = resolvedPath.toLowerCase().endsWith(".mcstructure")
      ? "Bedrock Edition (.mcstructure)"
      : "Java Edition (.nbt)";

    const resultSummary = {
      status: "exported",
      format,
      outputPath: resolvedPath,
      size: this.world.size,
      totalVoxels,
      terrainVoxels,
      buildVoxels,
    };

    return {
      content: [
        {
          type: "text",
          text: `Successfully exported structure (${format}) to ${resolvedPath} (size: ${this.world.size.join("x")}, total voxels: ${totalVoxels}, build voxels: ${buildVoxels}, terrain voxels: ${terrainVoxels}).\n${JSON.stringify(resultSummary, null, 2)}`,
        },
      ],
    };
  }

  public async handleLintStructure(): Promise<CallToolResult> {
    const uniqueNames = this.world.getUniqueBlockNames();
    const blockModels = this.assetLoader.getBlockModelsForBlocks(uniqueNames);
    const { resolvedMap } = this.world.resolveBlockStatesWithMap(blockModels);
    const lintReport = this.world.lintStructure(blockModels, resolvedMap);
    const evaluation = this.world.evaluateStructure(blockModels, {
      includeLint: false,
    });

    const floatingBlocksSample = evaluation.floatingBlocks.slice(
      0,
      MAX_LINT_FLOATING_BLOCKS
    );
    const floatingBlocksTruncatedCount = Math.max(
      0,
      evaluation.floatingBlocks.length - floatingBlocksSample.length
    );
    const issuesSample = lintReport.issues.slice(0, MAX_LINT_ISSUES);
    const issuesTruncatedCount = Math.max(
      0,
      lintReport.issues.length - issuesSample.length
    );

    const payload = {
      valid: lintReport.valid && evaluation.valid,
      lintValid: lintReport.valid,
      structuralValid: evaluation.valid,
      issueCount: lintReport.issueCount,
      issuesTruncatedCount,
      countsByType: lintReport.countsByType,
      issues: issuesSample,
      floatingBlocksCount: evaluation.floatingBlocks.length,
      floatingClustersCount: evaluation.floatingClustersCount,
      floatingBlocksTruncatedCount,
      floatingBlocks: floatingBlocksSample,
    };

    const lines: string[] = [
      "=== MineBuildingMCP Vanilla Building Linter Report ===",
      formatLintReportSummary(lintReport.issues, MAX_LINT_ISSUES),
    ];
    if (evaluation.floatingBlocks.length > 0) {
      const truncNote =
        floatingBlocksTruncatedCount > 0
          ? ` (showing first ${floatingBlocksSample.length}, ${floatingBlocksTruncatedCount} omitted)`
          : "";
      lines.push(
        `Floating Blocks: ${evaluation.floatingBlocks.length} across ${evaluation.floatingClustersCount} cluster(s)${truncNote}`
      );
    }
    if (issuesTruncatedCount > 0) {
      lines.push(
        `Lint Issues JSON: showing first ${issuesSample.length} of ${lintReport.issueCount} (${issuesTruncatedCount} omitted)`
      );
    }
    if (evaluation.warnings.length > 0) {
      lines.push("");
      lines.push("--- Structural Warnings ---");
      const previewWarnings = evaluation.warnings.slice(0, MAX_REPORT_WARNINGS);
      for (const w of previewWarnings) {
        lines.push(`- [!] ${w}`);
      }
      if (evaluation.warnings.length > previewWarnings.length) {
        lines.push(
          `  ... and ${evaluation.warnings.length - previewWarnings.length} more warning(s) omitted.`
        );
      }
    }
    lines.push("");
    lines.push(`JSON Details:\n${JSON.stringify(payload, null, 2)}`);

    return {
      content: [
        {
          type: "text",
          text: lines.join("\n"),
        },
      ],
    };
  }

  private registerHandlers(): void {
    this.server.setRequestHandler(ListPromptsRequestSchema, async () => {
      return {
        prompts: [
          {
            name: "minecraft_building_workflow",
            description:
              "Standard Minecraft building workflow guide: (1) Pre-Design Minecraft Idiom Research via web search (roof pitch, wall depth, block palette mixing, chain/lantern/fence joint techniques), (2) DSL construction, and (3) Vanilla Building Linter (lint_structure) & visual pixel-picker verification loop.",
            arguments: [
              {
                name: "theme",
                description:
                  "Architectural theme or motif to research and build (e.g. 'Medieval Cliffside Monastery', 'Gothic Cathedral', 'Japanese Castle', 'Suspension Bridge').",
                required: false,
              },
            ],
          },
        ],
      };
    });

    this.server.setRequestHandler(
      GetPromptRequestSchema,
      async (request): Promise<GetPromptResult> => {
        if (request.params.name !== "minecraft_building_workflow") {
          throw new Error(`Unknown prompt: ${request.params.name}`);
        }
        const theme =
          typeof request.params.arguments?.theme === "string"
            ? request.params.arguments.theme
            : undefined;
        return {
          description:
            "Pre-design Minecraft idiom research & post-build vanilla linter verification workflow",
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text: buildArchitecturalWorkflowPrompt(theme),
              },
            },
          ],
        };
      }
    );

    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: "load_terrain",
            description:
              "Load a Minecraft Structure file (Java Edition .nbt or Bedrock Edition .mcstructure) as the initial terrain, sync it to the 3D viewer, and return a terrain heightmap & slope summary.",
            inputSchema: {
              type: "object",
              properties: {
                nbtPath: {
                  type: "string",
                  description:
                    "Path to the input Minecraft structure file (.nbt or .mcstructure)",
                },
              },
              required: ["nbtPath"],
            },
          },
          {
            name: "run_build_script",
            description:
              "Execute JavaScript building DSL code (setBlock, fillBox, clearArea, placeFoundation, buildWall, buildPitchedRoof, line, placeDoor, placeLighting, placeBed, placeTable, placeChair, furnishRoom, detectRooms, getRoomById, getSurfaceY, getDistanceToGround), auto-resolve neighbor block states, run the Vanilla Building Linter (axis_mismatch_junction, missing_support) & floating-block check, sync to the 3D viewer, and return 4 orthographic PNG renders (NE, SE, SW, NW) with an operation trace table. WORKFLOW GUIDELINE: (1) Before writing jsCode for a new architectural theme, research Minecraft-specific building idioms for that theme (roof pitch ratios, 2-layer wall depth/framing, block palette mixing, and vanilla chain/lantern/fence joint techniques) via web search so you avoid real-world physics assumptions that break in Minecraft (such as T-joining horizontal and vertical chains without a joint block). (2) After building, verify both the rendered views and the Vanilla Building Linter report (or call lint_structure + inspect_pixel) and fix every traced DSL line warning before finishing.",
            inputSchema: {
              type: "object",
              properties: {
                jsCode: {
                  type: "string",
                  description:
                    "JavaScript code using the BuilderDSL functions to construct buildings and interiors on the voxel world.",
                },
                resolution: {
                  type: "number",
                  description:
                    "Square image resolution in pixels for each of the 4 rendered views (default: 512).",
                  default: 512,
                },
                resetBeforeRun: {
                  type: "boolean",
                  description:
                    "Whether to reset previous build blocks back to the initial terrain before executing jsCode (default: true).",
                  default: true,
                },
              },
              required: ["jsCode"],
            },
          },
          {
            name: "lint_structure",
            description:
              "Run the static Vanilla Building Linter on the current VoxelWorld to detect Minecraft block-specification mismatches: (1) 'axis_mismatch_junction' where slender single-axis blocks like chains adjoin with different axes (T-junction / L-junction breaks that require a fence, wall, grindstone, hopper, or full block at the intersection), and (2) 'missing_support' where wall-clinging blocks (vine, glow_lichen), hanging/standing blocks (lanterns with hanging=true/false), or mounted blocks lack a valid supporting neighbor. Returns each issue's type, 3D coordinates (x, y, z), traced DSL line number & codeSnippet, and an actionable fix hint.",
            inputSchema: {
              type: "object",
              properties: {},
            },
          },
          {
            name: "render_camera",
            description:
              "Move, orbit, pan, or zoom the 3D camera freely (perspective or orthographic) and render a close-up or custom-angle PNG image. Also caches the \"custom\" offscreen ID picker buffer so inspect_pixel(view=\"custom\", u, v) works on the custom view, and optionally syncs the live browser viewer.",
            inputSchema: {
              type: "object",
              properties: {
                preset: {
                  type: "string",
                  enum: CAMERA_PRESETS,
                  description:
                    "Optional preset direction (NE, SE, SW, NW, N, S, E, W, TOP, FRONT, BACK, LEFT, RIGHT) or RESET to restore default framing.",
                },
                projection: {
                  type: "string",
                  enum: CAMERA_PROJECTIONS,
                  description:
                    "Camera projection mode: \"perspective\" (default, natural 3D depth) or \"orthographic\".",
                },
                target: {
                  type: "object",
                  description: "3D look-at target coordinate { x, y, z } in block units.",
                  properties: {
                    x: { type: "number" },
                    y: { type: "number" },
                    z: { type: "number" },
                  },
                  required: ["x", "y", "z"],
                },
                position: {
                  type: "object",
                  description:
                    "Explicit 3D camera position { x, y, z } in block units (overrides yaw/pitch/distance).",
                  properties: {
                    x: { type: "number" },
                    y: { type: "number" },
                    z: { type: "number" },
                  },
                  required: ["x", "y", "z"],
                },
                yaw: {
                  type: "number",
                  description:
                    "Compass azimuth angle in degrees (0=N/-Z, 45=NE, 90=E/+X, 135=SE, 180=S/+Z, 225=SW, 270=W/-X, 315=NW).",
                },
                pitch: {
                  type: "number",
                  description:
                    "Elevation angle in degrees [-89, 89] (0=eye-level horizontal, 45=elevated, 89=top-down, negative=looking up).",
                },
                distance: {
                  type: "number",
                  description: "Distance from camera to target in blocks (>0).",
                },
                zoom: {
                  type: "number",
                  description:
                    "Zoom multiplier [0.1, 50] (>1 zooms in, <1 zooms out).",
                },
                fov: {
                  type: "number",
                  description:
                    "Vertical field of view in degrees [10, 120] for perspective projection (default: 45).",
                },
                orthoSize: {
                  type: "number",
                  description:
                    "Base orthographic frustum span in blocks before zoom.",
                },
                zoomFactor: {
                  type: "number",
                  description:
                    "Relative zoom multiplier applied to current zoom (e.g., 2.0 zooms in 2x, 0.5 zooms out 2x).",
                },
                deltaYaw: {
                  type: "number",
                  description: "Relative yaw offset in degrees added to current yaw.",
                },
                deltaPitch: {
                  type: "number",
                  description: "Relative pitch offset in degrees added to current pitch.",
                },
                deltaDistance: {
                  type: "number",
                  description:
                    "Relative distance offset in blocks added to current distance (negative moves closer).",
                },
                pan: {
                  type: "object",
                  description: "Relative { x?, y?, z? } offset added to current target.",
                  properties: {
                    x: { type: "number" },
                    y: { type: "number" },
                    z: { type: "number" },
                  },
                },
                resolution: {
                  type: "number",
                  description:
                    "Square PNG resolution in pixels [64, 2048] (default: 512).",
                },
                syncViewer: {
                  type: "boolean",
                  description:
                    "Whether to synchronize the live interactive browser camera to match (default: true).",
                },
              },
            },
          },
          {
            name: "inspect_pixel",
            description:
              "Inspect a specific pixel (u, v as integer pixel coordinates [0, resolution-1] or normalized [0.0, 1.0]) on one of the 4 rendered views (NE, SE, SW, NW) or the latest custom camera render (\"custom\") using the O(1) offscreen RGBA hardware ID picker. Works on exterior views, Dollhouse Cutaway interior views, and custom free-camera views! Returns exact 3D voxel coordinates, block name/state, distanceToGround, and the TraceRecord (opId, line number, codeSnippet) that placed the block.",
            inputSchema: {
              type: "object",
              properties: {
                view: {
                  type: "string",
                  enum: ["NE", "SE", "SW", "NW", "custom"],
                  description:
                    "Which camera view to inspect (NE, SE, SW, NW, or custom from the latest render_camera call).",
                },
                u: {
                  type: "number",
                  description:
                    "Horizontal pixel coordinate from left (0 to resolution-1, or normalized 0.0 to 1.0).",
                },
                v: {
                  type: "number",
                  description:
                    "Vertical pixel coordinate from top (0 to resolution-1, or normalized 0.0 to 1.0).",
                },
              },
              required: ["view", "u", "v"],
            },
          },
          {
            name: "inspect_interior",
            description:
              "Automatically detect interior rooms, check interior flow & doorway clearance, render 4 Dollhouse Cutaway views (slicing above cutY and peeling back camera-facing outer walls while syncing the offscreen ID picker buffer), and render first-person Room Eye-Level views (N, S, E, W) from the center of each room.",
            inputSchema: {
              type: "object",
              properties: {
                cutY: {
                  type: "number",
                  description:
                    "Optional Y coordinate ceiling cutoff for Dollhouse Cutaway views. Voxels above cutY are hidden. If omitted, automatically uses the detected room cutaway height.",
                },
                resolution: {
                  type: "number",
                  description:
                    "Square image resolution in pixels for rendered views (default: 512).",
                  default: 512,
                },
                maxRooms: {
                  type: "number",
                  description:
                    "Maximum number of rooms for which 4-direction first-person eye-level PNG views are rendered (default: 8, range 0..32).",
                  default: 8,
                },
              },
            },
          },
          {
            name: "open_viewer",
            description:
              "Open the live interactive 3D Three.js viewer in the user's default browser (skips if a visible browser viewer is already connected unless force=true).",
            inputSchema: {
              type: "object",
              properties: {
                force: {
                  type: "boolean",
                  description:
                    "Open a new browser tab even if a visible viewer is already connected or was opened earlier (default: false).",
                },
              },
            },
          },
          {
            name: "export_structure",
            description:
              "Export the current VoxelWorld (terrain + built structure) to either a Java Edition Structure (.nbt) file or a Bedrock Edition Structure (.mcstructure) file (automatically determined by file extension).",
            inputSchema: {
              type: "object",
              properties: {
                outputPath: {
                  type: "string",
                  description:
                    "Destination file path for the exported structure (.nbt or .mcstructure)",
                },
              },
              required: ["outputPath"],
            },
          },
        ],
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: rawArgs } = request.params;
      const args = (rawArgs ?? {}) as Record<string, unknown>;

      try {
        switch (name) {
          case "load_terrain":
            return await this.handleLoadTerrain({
              nbtPath: args.nbtPath as string,
            });

          case "run_build_script":
            return await this.handleRunBuildScript({
              jsCode: args.jsCode as string,
              resolution: parseOptionalFiniteNumber(args.resolution, "resolution"),
              resetBeforeRun: parseOptionalBoolean(
                args.resetBeforeRun,
                "resetBeforeRun"
              ),
            });

          case "lint_structure":
            return await this.handleLintStructure();

          case "render_camera":
            return await this.handleRenderCamera(
              args as unknown as CameraControlParams
            );

          case "open_viewer":
            return await this.handleOpenViewer({
              force: parseOptionalBoolean(args.force, "force"),
            });

          case "inspect_pixel": {
            const u = parseOptionalFiniteNumber(args.u, "u");
            const v = parseOptionalFiniteNumber(args.v, "v");
            if (u === undefined || v === undefined) {
              throw new Error(
                "Missing required numeric arguments u and v for inspect_pixel."
              );
            }
            return await this.handleInspectPixel({
              view: String(args.view ?? "") as InspectViewId,
              u,
              v,
            });
          }

          case "inspect_interior":
            return await this.handleInspectInterior({
              cutY: parseOptionalFiniteNumber(args.cutY, "cutY"),
              resolution: parseOptionalFiniteNumber(args.resolution, "resolution"),
              maxRooms: parseOptionalFiniteNumber(args.maxRooms, "maxRooms"),
            });

          case "export_structure":
            return await this.handleExportStructure({
              outputPath: args.outputPath as string,
            });

          default:
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `Unknown tool: ${name}`,
                },
              ],
            };
        }
      } catch (err) {
        const message = err instanceof Error ? err.stack ?? err.message : String(err);
        process.stderr.write(`[MineBuildingMCP] Tool "${name}" error: ${message}\n`);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error executing ${name}: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    });
  }

  public async startStdio(): Promise<void> {
    redirectConsoleToStderr();
    // Start Vite + WebSocket server in background and sync initial default world
    await this.wsBridge.start();
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    process.stderr.write("[MineBuildingMCP] MCP Server connected via stdio transport\n");
    await this.maybeAutoOpenViewer();
  }

  public async close(): Promise<void> {
    await this.server.close().catch(() => {});
    await this.wsBridge.stop().catch(() => {});
  }
}

export { MineBuildingMcpServer as CraftStudioMcpServer };

export async function startMcpServer(): Promise<MineBuildingMcpServer> {
  redirectConsoleToStderr();
  const mcpServer = new MineBuildingMcpServer();
  await mcpServer.startStdio();

  const cleanup = async () => {
    await mcpServer.close();
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  return mcpServer;
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    const normalizePathForCompare = (p: string): string => {
      let resolved = path.resolve(p);
      try {
        resolved = fsSync.realpathSync(resolved);
      } catch {
        // Keep path.resolve result when path cannot be realpath'd
      }
      const posix = resolved.replace(/\\/g, "/");
      return process.platform === "win32" ? posix.toLowerCase() : posix;
    };
    const currentFile = normalizePathForCompare(fileURLToPath(import.meta.url));
    const entryFile = normalizePathForCompare(process.argv[1]);
    return (
      currentFile === entryFile ||
      currentFile.replace(/\.ts$/, ".js") === entryFile ||
      entryFile.endsWith("/mcp/server.ts") ||
      entryFile.endsWith("/mcp/server.js")
    );
  } catch {
    return false;
  }
})();

if (isMain) {
  redirectConsoleToStderr();
  startMcpServer().catch((err) => {
    process.stderr.write(`[MineBuildingMCP] Fatal startup error: ${String(err)}\n`);
    process.exit(1);
  });
}

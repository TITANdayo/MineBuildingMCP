#!/usr/bin/env node

// Redirect console output to stderr immediately so stdio MCP JSON-RPC is never polluted
const writeStderr = (...args: unknown[]) => {
  const formatted = args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ");
  process.stderr.write(`${formatted}\n`);
};
console.log = writeStderr;
console.info = writeStderr;
console.warn = writeStderr;
console.debug = writeStderr;

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { JarAssetLoader } from "../assets/jar-loader.js";
import { executeBuildScript } from "../core/builder-dsl.js";
import { loadStructureNbt, saveStructureNbt } from "../core/nbt-io.js";
import { VoxelWorld } from "../core/voxel-world.js";
import type {
  InspectResult,
  StructureEvaluation,
  TraceRecord,
  ViewDirection,
} from "../types/shared.js";
import { WsBridge, type WsBridgeOptions } from "./ws-bridge.js";

const VIEW_DIRECTIONS: ViewDirection[] = ["NE", "SE", "SW", "NW"];

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

function formatBuildReport(
  opCount: number,
  traces: Record<number, TraceRecord>,
  evaluation: StructureEvaluation,
  world: VoxelWorld,
  resolution: number,
  viewerUrl: string
): string {
  const lines: string[] = [];
  lines.push("=== CraftStudio Build Execution Report ===");
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
    for (const warning of evaluation.warnings) {
      lines.push(`- [!] ${warning}`);
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

  const traceEntries = Object.values(traces).sort((a, b) => a.opId - b.opId);
  if (traceEntries.length > 0) {
    lines.push("");
    lines.push("--- Operation Trace Table (opId -> Line -> Code) ---");
    for (const t of traceEntries) {
      lines.push(`  opId #${t.opId} | Line ${t.line}: ${t.codeSnippet}`);
    }
  }

  lines.push("");
  lines.push(
    `Rendered 4 Orthographic Views (NE, SE, SW, NW) at ${resolution}x${resolution}px. Use inspect_pixel(view, u, v) with u,v in [0.0, 1.0] to query exact 3D coordinates and source code lines for any pixel.`
  );

  return lines.join("\n");
}

export class CraftStudioMcpServer {
  public readonly server: Server;
  public readonly wsBridge: WsBridge;
  public readonly assetLoader: JarAssetLoader;
  public world: VoxelWorld;

  constructor(options: WsBridgeOptions = {}) {
    this.world = createDefaultTerrainWorld([32, 32, 32]);
    this.assetLoader = new JarAssetLoader();
    this.wsBridge = new WsBridge(options);

    this.server = new Server(
      {
        name: "craftstudio-mcp",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.registerHandlers();
  }

  private collectWorldTextures(): Record<string, string> {
    const uniqueNames = new Set<string>();
    for (const voxel of this.world.voxels.values()) {
      uniqueNames.add(voxel.name);
    }
    const rawMap = this.assetLoader.getTexturesForBlocks(Array.from(uniqueNames));
    const expanded: Record<string, string> = {};
    for (const [shortName, dataUrl] of Object.entries(rawMap)) {
      expanded[shortName] = dataUrl;
      expanded[`minecraft:${shortName}`] = dataUrl;
    }
    return expanded;
  }

  private async syncCurrentWorldToViewer(): Promise<void> {
    const voxels = this.world.getAllVoxels();
    const traces = this.world.getTracesObject();
    const textures = this.collectWorldTextures();
    await this.wsBridge.syncWorld({
      voxels,
      size: [...this.world.size],
      traces,
      textures,
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
      heightmap: summary.heightmap,
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

    const resolution =
      typeof args.resolution === "number" && Number.isFinite(args.resolution)
        ? Math.max(64, Math.min(2048, Math.floor(args.resolution)))
        : 512;
    const resetBeforeRun = args.resetBeforeRun !== false;

    const execResult = executeBuildScript(this.world, args.jsCode, resetBeforeRun);
    await this.syncCurrentWorldToViewer();
    const images = await this.wsBridge.renderViews(resolution);

    const reportText = formatBuildReport(
      execResult.opCount,
      execResult.traces,
      execResult.evaluation,
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

  public async handleInspectPixel(args: {
    view: ViewDirection;
    u: number;
    v: number;
  }): Promise<CallToolResult> {
    if (!args || !VIEW_DIRECTIONS.includes(args.view)) {
      throw new Error(
        `Invalid view "${String(args?.view)}". Expected one of: NE, SE, SW, NW.`
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

  public async handleExportStructure(args: {
    outputPath: string;
  }): Promise<CallToolResult> {
    if (!args?.outputPath || typeof args.outputPath !== "string") {
      throw new Error("Missing or invalid required argument: outputPath (string)");
    }

    const resolvedPath = path.resolve(args.outputPath);
    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
    await saveStructureNbt(this.world, resolvedPath);

    const totalVoxels = this.world.voxels.size;
    let buildVoxels = 0;
    let terrainVoxels = 0;
    for (const v of this.world.voxels.values()) {
      if (v.isTerrain) terrainVoxels++;
      else buildVoxels++;
    }

    const resultSummary = {
      status: "exported",
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
          text: `Successfully exported structure NBT to ${resolvedPath} (size: ${this.world.size.join("x")}, total voxels: ${totalVoxels}, build voxels: ${buildVoxels}, terrain voxels: ${terrainVoxels}).\n${JSON.stringify(resultSummary, null, 2)}`,
        },
      ],
    };
  }

  private registerHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: "load_terrain",
            description:
              "Load a Minecraft Structure (.nbt) file as the initial terrain, sync it to the 3D viewer, and return a terrain heightmap & slope summary.",
            inputSchema: {
              type: "object",
              properties: {
                nbtPath: {
                  type: "string",
                  description: "Path to the input Minecraft structure .nbt file",
                },
              },
              required: ["nbtPath"],
            },
          },
          {
            name: "run_build_script",
            description:
              "Execute JavaScript building DSL code (setBlock, fillBox, clearArea, placeFoundation, buildWall, buildPitchedRoof, line, getSurfaceY, getDistanceToGround), evaluate floating blocks, sync to the 3D viewer, and return 4 orthographic PNG renders (NE, SE, SW, NW) with an operation trace table.",
            inputSchema: {
              type: "object",
              properties: {
                jsCode: {
                  type: "string",
                  description:
                    "JavaScript code using the BuilderDSL functions to construct buildings on the voxel world.",
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
            name: "inspect_pixel",
            description:
              "Inspect a specific pixel (u, v as integer pixel coordinates [0, resolution-1] or normalized [0.0, 1.0]) on one of the 4 rendered views (NE, SE, SW, NW) using the O(1) offscreen RGBA hardware ID picker. Returns exact 3D voxel coordinates, block name/state, distanceToGround, and the TraceRecord (opId, line number, codeSnippet) that placed the block.",
            inputSchema: {
              type: "object",
              properties: {
                view: {
                  type: "string",
                  enum: ["NE", "SE", "SW", "NW"],
                  description: "Which of the 4 orthographic camera views to inspect.",
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
            name: "export_structure",
            description:
              "Export the current VoxelWorld (terrain + built structure) to a standard Gzipped Minecraft Structure (.nbt) file.",
            inputSchema: {
              type: "object",
              properties: {
                outputPath: {
                  type: "string",
                  description: "Destination file path for the exported .nbt file",
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
              nbtPath: String(args.nbtPath ?? ""),
            });

          case "run_build_script":
            return await this.handleRunBuildScript({
              jsCode: String(args.jsCode ?? ""),
              resolution:
                args.resolution !== undefined ? Number(args.resolution) : undefined,
              resetBeforeRun:
                args.resetBeforeRun !== undefined
                  ? Boolean(args.resetBeforeRun)
                  : undefined,
            });

          case "inspect_pixel":
            return await this.handleInspectPixel({
              view: String(args.view ?? "") as ViewDirection,
              u: Number(args.u),
              v: Number(args.v),
            });

          case "export_structure":
            return await this.handleExportStructure({
              outputPath: String(args.outputPath ?? ""),
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
        process.stderr.write(`[CraftStudioMCP] Tool "${name}" error: ${message}\n`);
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
    // Start Vite + WebSocket server in background and sync initial default world
    await this.wsBridge.start();
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    process.stderr.write("[CraftStudioMCP] MCP Server connected via stdio transport\n");
  }

  public async close(): Promise<void> {
    await this.server.close().catch(() => {});
    await this.wsBridge.stop().catch(() => {});
  }
}

export async function startMcpServer(): Promise<CraftStudioMcpServer> {
  const mcpServer = new CraftStudioMcpServer();
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
    const currentFile = fileURLToPath(import.meta.url);
    const entryFile = path.resolve(process.argv[1]);
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
  startMcpServer().catch((err) => {
    process.stderr.write(`[CraftStudioMCP] Fatal startup error: ${String(err)}\n`);
    process.exit(1);
  });
}

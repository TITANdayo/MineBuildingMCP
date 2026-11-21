#!/usr/bin/env node
/**
 * Generic Programmatic Multi-Angle Perspective Renderer, Linter & Exporter
 * using MineBuildingMcpServer directly (bypasses stdio JSON-RPC line limits,
 * supports custom ports/timeouts, and enforces real JAR asset checks).
 *
 * Usage:
 *   node batch_render.mjs --canvas <canvas.nbt> --out-dir <renders/> [options] <script1.js> [...]
 *
 * Options:
 *   --canvas <path.nbt>          Input terrain/void canvas .nbt (optional)
 *   --lib <path.js>              Shared helper JS prepended before each script (repeatable)
 *   --cameras <cameras.json>     JSON array of `{ "id": "...", "params": { ...render_camera } }`
 *                                (defaults to 4 auto-framed views incl. reverse +180 deg & closeup)
 *   --out-dir <dir>              Directory to write rendered PNGs (default: ./renders)
 *   --prefix <name>              Filename prefix for PNGs (default: build)
 *   --resolution <px>            Default render resolution when camera omits it (default: 768)
 *   --export-nbt <path.nbt>      Export final Java .nbt structure
 *   --export-mcstructure <path>  Export final Bedrock .mcstructure (large uncompressed dense array)
 *   --vite-port <port>           Dedicated Vite port to avoid MCP collision (default: 5188)
 *   --ws-port <port>             Dedicated WebSocket port to avoid MCP collision (default: 3088)
 *   --timeout <ms>               Request timeout ms (default: 60000)
 *   --require-jar                Fail immediately if local Minecraft .jar was not detected
 *   --mcp-dir <path>             Path to MineBuildingMCP (auto-detected if omitted)
 *   --help, -h                   Show help
 */

import fs from "node:fs";
import path from "node:path";
import { importMcpModule, resolveMcpDistDir } from "./resolve_mcp.mjs";

function parseArgs(argv) {
  const opts = {
    canvas: null,
    libs: [],
    scripts: [],
    cameras: null,
    outDir: "./renders",
    prefix: "build",
    resolution: 768,
    exportNbt: null,
    exportMcstructure: null,
    vitePort: 5188,
    wsPort: 3088,
    timeout: 60000,
    requireJar: false,
    mcpDir: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--canvas") opts.canvas = argv[++i];
    else if (arg === "--lib") opts.libs.push(argv[++i]);
    else if (arg === "--cameras") opts.cameras = argv[++i];
    else if (arg === "--out-dir") opts.outDir = argv[++i];
    else if (arg === "--prefix") opts.prefix = argv[++i];
    else if (arg === "--resolution") opts.resolution = Number(argv[++i]);
    else if (arg === "--export-nbt") opts.exportNbt = argv[++i];
    else if (arg === "--export-mcstructure") opts.exportMcstructure = argv[++i];
    else if (arg === "--vite-port") opts.vitePort = Number(argv[++i]);
    else if (arg === "--ws-port") opts.wsPort = Number(argv[++i]);
    else if (arg === "--timeout") opts.timeout = Number(argv[++i]);
    else if (arg === "--require-jar") opts.requireJar = true;
    else if (arg === "--mcp-dir") opts.mcpDir = argv[++i];
    else if (!arg.startsWith("-")) opts.scripts.push(arg);
    else throw new Error(`Unknown option: ${arg}`);
  }
  return opts;
}

function printHelp() {
  console.log(`Usage: node batch_render.mjs [options] <script1.js> [script2.js ...]

Options:
  --canvas <path.nbt>          Input terrain/void canvas .nbt
  --lib <path.js>              Shared helper JS prepended before each script (repeatable)
  --cameras <cameras.json>     JSON array of { id, params } for render_camera
  --out-dir <dir>              Output directory for PNGs (default: ./renders)
  --prefix <name>              PNG filename prefix (default: build)
  --resolution <px>            Default render resolution (default: 768)
  --export-nbt <path.nbt>      Export Java .nbt structure
  --export-mcstructure <path>  Export Bedrock .mcstructure structure
  --vite-port <port>           Dedicated Vite port (default: 5188)
  --ws-port <port>             Dedicated WebSocket port (default: 3088)
  --timeout <ms>               WebSocket render timeout ms (default: 60000)
  --require-jar                Abort if local Minecraft .jar is not detected
  --mcp-dir <path>             Path to MineBuildingMCP (auto-detected if omitted)
  --help, -h                   Show help`);
}

function computeDefaultCameras(world, resolution) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const v of world.voxels.values()) {
    if (v.x < minX) minX = v.x; if (v.x > maxX) maxX = v.x;
    if (v.y < minY) minY = v.y; if (v.y > maxY) maxY = v.y;
    if (v.z < minZ) minZ = v.z; if (v.z > maxZ) maxZ = v.z;
  }
  if (!Number.isFinite(minX)) {
    minX = 0; maxX = world.size[0]; minY = 0; maxY = world.size[1]; minZ = 0; maxZ = world.size[2];
  }
  const target = {
    x: Math.round((minX + maxX) / 2),
    y: Math.round((minY + maxY) / 2),
    z: Math.round((minZ + maxZ) / 2),
  };
  const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 16);
  const distOverview = Math.round(span * 1.45);
  const distClose = Math.max(18, Math.round(span * 0.45));

  return [
    {
      id: "cam1_hero_oblique",
      params: { projection: "perspective", target, yaw: 140, pitch: 24, distance: distOverview, fov: 45, resolution, syncViewer: false },
    },
    {
      id: "cam2_reverse_180",
      params: { projection: "perspective", target, yaw: 320, pitch: 22, distance: distOverview, fov: 45, resolution, syncViewer: false },
    },
    {
      id: "cam3_low_dramatic",
      params: { projection: "perspective", target, yaw: 50, pitch: -4, distance: Math.round(span * 1.15), fov: 48, resolution, syncViewer: false },
    },
    {
      id: "cam4_detail_closeup",
      params: { projection: "perspective", target, yaw: 135, pitch: 15, distance: distClose, fov: 45, resolution, syncViewer: false },
    },
  ];
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }
  if (opts.scripts.length === 0 && !opts.canvas) {
    printHelp();
    throw new Error("Provide at least one build script or --canvas <path.nbt>.");
  }

  const distDir = resolveMcpDistDir(opts.mcpDir);
  const { MineBuildingMcpServer } = await importMcpModule(distDir, "mcp/server.js");

  const libCode = opts.libs
    .map((p) => fs.readFileSync(path.resolve(p), "utf8"))
    .join("\n\n");

  const server = new MineBuildingMcpServer({
    vitePort: opts.vitePort,
    wsPort: opts.wsPort,
    headless: true,
    openViewer: false,
    requestTimeoutMs: opts.timeout,
  });

  try {
    const status = server.assetLoader.getStatus();
    console.log(`[Assets] jarFound=${status.jarFound} | jarPath=${status.jarPath ?? "null"}`);
    if (opts.requireJar && !status.jarFound) {
      throw new Error(
        "Local Minecraft .jar not detected (jarFound=false). Run outside sandbox or set MINECRAFT_JAR_PATH."
      );
    }

    if (opts.canvas) {
      await server.handleLoadTerrain({ nbtPath: path.resolve(opts.canvas) });
    }

    for (let i = 0; i < opts.scripts.length; i++) {
      const code = fs.readFileSync(path.resolve(opts.scripts[i]), "utf8");
      const t0 = Date.now();
      await server.handleRunBuildScript({
        jsCode: (libCode ? libCode + "\n" : "") + code,
        resetBeforeRun: i === 0,
        resolution: 512,
      });
      console.log(
        `[Build ${i + 1}/${opts.scripts.length}] ${path.basename(opts.scripts[i])} done in ${Date.now() - t0}ms | Voxels: ${server.world.voxels.size.toLocaleString()} | OOB: ${server.world.outOfBoundsCount}`
      );
    }

    const lintRes = await server.handleLintStructure();
    const lintText = lintRes.content.find((c) => c.type === "text")?.text ?? "";
    console.log(`[Lint] ${lintText.split("\n").slice(0, 3).join(" | ")}`);

    if (opts.exportNbt) {
      const nbtOut = path.resolve(opts.exportNbt);
      fs.mkdirSync(path.dirname(nbtOut), { recursive: true });
      await server.handleExportStructure({ outputPath: nbtOut });
      console.log(`[Export] ${nbtOut} (${(fs.statSync(nbtOut).size / 1024).toFixed(1)} KB)`);
    }

    if (opts.exportMcstructure) {
      const mcOut = path.resolve(opts.exportMcstructure);
      fs.mkdirSync(path.dirname(mcOut), { recursive: true });
      await server.handleExportStructure({ outputPath: mcOut });
      console.log(`[Export] ${mcOut} (${(fs.statSync(mcOut).size / 1024 / 1024).toFixed(2)} MB)`);
    }

    const cameras = opts.cameras
      ? JSON.parse(fs.readFileSync(path.resolve(opts.cameras), "utf8"))
      : computeDefaultCameras(server.world, opts.resolution);

    const outDir = path.resolve(opts.outDir);
    fs.mkdirSync(outDir, { recursive: true });

    for (const cam of cameras) {
      const params = {
        projection: "perspective",
        resolution: opts.resolution,
        syncViewer: false,
        ...cam.params,
      };
      const res = await server.handleRenderCamera(params);
      const imgPart = res.content.find((c) => c.type === "image");
      if (imgPart && imgPart.data) {
        const pngPath = path.join(outDir, `${opts.prefix}_${cam.id}.png`);
        fs.writeFileSync(pngPath, Buffer.from(imgPart.data, "base64"));
        console.log(`[Render] ${pngPath} (${Math.round(fs.statSync(pngPath).size / 1024)} KB)`);
      }
    }
  } finally {
    await server.close();
  }
}

main().catch((err) => {
  console.error(`[batch_render] Error: ${err.message}`);
  process.exit(1);
});

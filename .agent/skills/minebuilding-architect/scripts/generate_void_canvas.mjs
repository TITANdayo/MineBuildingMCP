#!/usr/bin/env node
/**
 * Generic Void Canvas (.nbt) Generator for MineBuildingMCP.
 *
 * Creates a sized VoxelWorld (.nbt) canvas (up to 256x256x256; <=254 recommended
 * to avoid RGBA8 picker 255 sky-sentinel collision) with an optional concealed
 * isTerrain=true seed anchor so aerial/floating builds can use evaluateStructure()
 * as a 6-connected structural continuity verifier.
 *
 * Usage:
 *   node generate_void_canvas.mjs --out ./terrain/void_canvas.nbt [options]
 *
 * Options:
 *   --out <path>            Output .nbt file path (required)
 *   --size <X,Y,Z>          World dimensions (default: 254,224,254; max 256 per axis)
 *   --seed <mode>           Seed pattern: single | cube3 | none (default: single)
 *   --seed-pos <x,y,z>      Seed center coordinate (default: floor(size / 2))
 *   --seed-block <blockId>  Seed block ID (default: minecraft:black_concrete)
 *   --mcp-dir <path>        Path to MineBuildingMCP directory (auto-detected if omitted)
 *   --help                  Show this usage help
 */

import fs from "node:fs";
import path from "node:path";
import { importMcpModule, resolveMcpDistDir } from "./resolve_mcp.mjs";

function parseTriple(str, flagName) {
  const parts = String(str)
    .split(/[x,]/i)
    .map((s) => Number(s.trim()));
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`Invalid ${flagName} "${str}". Expected X,Y,Z (e.g. 254,224,254).`);
  }
  return parts.map((n) => Math.floor(n));
}

function parseArgs(argv) {
  const opts = {
    out: null,
    size: [254, 224, 254],
    seed: "single",
    seedPos: null,
    seedBlock: "minecraft:black_concrete",
    mcpDir: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else if (arg === "--out" || arg === "-o") {
      opts.out = argv[++i];
    } else if (arg === "--size") {
      opts.size = parseTriple(argv[++i], "--size");
    } else if (arg === "--seed") {
      opts.seed = String(argv[++i] || "single").toLowerCase();
    } else if (arg === "--seed-pos") {
      opts.seedPos = parseTriple(argv[++i], "--seed-pos");
    } else if (arg === "--seed-block") {
      opts.seedBlock = String(argv[++i] || "minecraft:black_concrete");
    } else if (arg === "--mcp-dir") {
      opts.mcpDir = argv[++i];
    } else if (!arg.startsWith("-") && !opts.out) {
      opts.out = arg;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`Usage: node generate_void_canvas.mjs --out <path.nbt> [options]

Options:
  --out, -o <path>        Output .nbt file path (required)
  --size <X,Y,Z>          World size (default: 254,224,254; hard max: 256 per axis)
  --seed <mode>           single | cube3 | none (default: single)
  --seed-pos <x,y,z>      Seed center coordinate (default: world center)
  --seed-block <id>       Opaque block ID for terrain seed (default: minecraft:black_concrete)
  --mcp-dir <path>        Path to MineBuildingMCP (auto-detected if omitted)
  --help, -h              Show help`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }
  if (!opts.out) {
    printHelp();
    throw new Error("Missing required --out <path.nbt>.");
  }

  for (let i = 0; i < 3; i++) {
    if (opts.size[i] < 1 || opts.size[i] > 256) {
      throw new Error(
        `World dimension index ${i} (${opts.size[i]}) out of MineBuildingMCP hard limit [1..256].`
      );
    }
  }
  if (opts.size.some((d) => d > 254)) {
    console.warn(
      `[Warn] Dimension > 254 detected (${opts.size.join("x")}). Keep placed blocks within [0..254] (safe box [2..253]) to avoid RGBA8 picker 255 sky collision.`
    );
  }

  const distDir = resolveMcpDistDir(opts.mcpDir);
  const { VoxelWorld } = await importMcpModule(distDir, "core/voxel-world.js");
  const { saveStructureNbt } = await importMcpModule(distDir, "core/nbt-io.js");

  const world = new VoxelWorld(opts.size);
  const [sx, sy, sz] = world.size;
  const [cx, cy, cz] = opts.seedPos ?? [
    Math.floor(sx / 2),
    Math.floor(sy / 2),
    Math.floor(sz / 2),
  ];

  if (opts.seed === "single") {
    world.setVoxel(cx, cy, cz, opts.seedBlock, undefined, true, 0);
  } else if (opts.seed === "cube3") {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          world.setVoxel(cx + dx, cy + dy, cz + dz, opts.seedBlock, undefined, true, 0);
        }
      }
    }
  } else if (opts.seed !== "none") {
    throw new Error(`Invalid --seed "${opts.seed}". Expected single | cube3 | none.`);
  }

  world.saveInitialTerrainSnapshot();

  const outPath = path.resolve(opts.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await saveStructureNbt(world, outPath);

  console.log(`Generated void canvas NBT: ${outPath}`);
  console.log(
    `Size: ${world.size.join("x")} | Seed Mode: ${opts.seed} @ (${cx},${cy},${cz}) | Seed Voxels: ${world.voxels.size}`
  );
}

main().catch((err) => {
  console.error(`[generate_void_canvas] Error: ${err.message}`);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Generic Local Headless Dry-Run Validator, Bundler & Auto-Anchor Emitter
 * for MineBuildingMCP build scripts (2-6s per run, zero Chromium/WebSocket overhead).
 *
 * Usage:
 *   node dry_run_validator.mjs [options] <script1.js> [script2.js ...]
 *
 * Options:
 *   --canvas <path.nbt>          Initial terrain/void canvas .nbt (optional; else clean VoxelWorld)
 *   --size <X,Y,Z>               World dimensions when --canvas is omitted (default: 256,256,256)
 *   --lib <path.js>              Shared helper JS prepended before each phase (repeatable)
 *   --safe-box <x0,x1,y0,y1,z0,z1> Safe coordinate bounds (default: 2,253,2,250,2,253)
 *   --max-voxels <N>             Voxel count warning/strict ceiling (default: 240000)
 *   --max-floating <N>           Allowed floating block ceiling in --strict mode (default: 0)
 *   --bundle-out <path.js>       Write concatenated self-contained JS bundle (libs + scripts)
 *   --emit-anchors <path.nbt>    Extract 1 faithful isTerrain=true seed per ungrounded cluster
 *                                >= min-cluster and re-verify reload (clean floatingBlocks=0)
 *   --anchor-min-cluster <N>     Minimum 6-connected cluster size for auto-anchor (default: 25)
 *   --checkpoint-out <path.nbt>  Save resulting VoxelWorld as .nbt checkpoint
 *   --strict                     Exit with code 1 if OOB > 0, safe-box violated, lint > 0,
 *                                voxels > max-voxels, or floating > max-floating
 *   --require-jar                Exit with code 1 if local Minecraft .jar is not detected
 *   --mcp-dir <path>             Path to MineBuildingMCP (auto-detected if omitted)
 *   --help, -h                   Show help
 */

import fs from "node:fs";
import path from "node:path";
import { importMcpModule, resolveMcpDistDir } from "./resolve_mcp.mjs";

const OPAQUE_ANCHOR_CANDIDATES = new Set([
  "minecraft:black_concrete", "minecraft:white_concrete", "minecraft:gray_concrete",
  "minecraft:orange_concrete", "minecraft:yellow_concrete", "minecraft:blue_concrete",
  "minecraft:deepslate", "minecraft:cobbled_deepslate", "minecraft:deepslate_bricks",
  "minecraft:polished_deepslate", "minecraft:deepslate_tiles", "minecraft:tuff",
  "minecraft:tuff_bricks", "minecraft:stone", "minecraft:cobblestone", "minecraft:stone_bricks",
  "minecraft:andesite", "minecraft:diorite", "minecraft:blackstone", "minecraft:polished_blackstone",
  "minecraft:obsidian", "minecraft:calcite", "minecraft:smooth_quartz", "minecraft:quartz_block",
  "minecraft:smooth_sandstone", "minecraft:cut_copper", "minecraft:gold_block",
  "minecraft:ochre_froglight", "minecraft:sea_lantern", "minecraft:magma_block",
  "minecraft:blue_ice", "minecraft:packed_ice", "minecraft:nether_bricks",
  "minecraft:red_terracotta", "minecraft:purple_terracotta", "minecraft:white_terracotta",
  "minecraft:spruce_planks", "minecraft:dark_oak_planks", "minecraft:oak_planks",
]);

function parseNums(str, expectedCount, flagName) {
  const parts = String(str)
    .split(/[x,]/i)
    .map((s) => Number(s.trim()));
  if (parts.length !== expectedCount || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`Invalid ${flagName} "${str}". Expected ${expectedCount} comma-separated numbers.`);
  }
  return parts.map((n) => Math.floor(n));
}

function parseArgs(argv) {
  const opts = {
    canvas: null,
    size: [256, 256, 256],
    libs: [],
    scripts: [],
    safeBox: [2, 253, 2, 250, 2, 253],
    maxVoxels: 240000,
    maxFloating: 0,
    bundleOut: null,
    emitAnchors: null,
    anchorMinCluster: 25,
    checkpointOut: null,
    strict: false,
    requireJar: false,
    mcpDir: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else if (arg === "--canvas") {
      opts.canvas = argv[++i];
    } else if (arg === "--size") {
      opts.size = parseNums(argv[++i], 3, "--size");
    } else if (arg === "--lib") {
      opts.libs.push(argv[++i]);
    } else if (arg === "--safe-box") {
      opts.safeBox = parseNums(argv[++i], 6, "--safe-box");
    } else if (arg === "--max-voxels") {
      opts.maxVoxels = Number(argv[++i]);
    } else if (arg === "--max-floating") {
      opts.maxFloating = Number(argv[++i]);
    } else if (arg === "--bundle-out") {
      opts.bundleOut = argv[++i];
    } else if (arg === "--emit-anchors") {
      opts.emitAnchors = argv[++i];
    } else if (arg === "--anchor-min-cluster") {
      opts.anchorMinCluster = Math.max(1, Math.floor(Number(argv[++i])));
    } else if (arg === "--checkpoint-out") {
      opts.checkpointOut = argv[++i];
    } else if (arg === "--strict") {
      opts.strict = true;
    } else if (arg === "--require-jar") {
      opts.requireJar = true;
    } else if (arg === "--mcp-dir") {
      opts.mcpDir = argv[++i];
    } else if (!arg.startsWith("-")) {
      opts.scripts.push(arg);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`Usage: node dry_run_validator.mjs [options] <script1.js> [script2.js ...]

Options:
  --canvas <path.nbt>              Initial terrain/void canvas .nbt
  --size <X,Y,Z>                   World size when --canvas is omitted (default: 256,256,256)
  --lib <path.js>                  Shared helper JS prepended before each phase (repeatable)
  --safe-box <x0,x1,y0,y1,z0,z1>   Safe coordinate bounds (default: 2,253,2,250,2,253)
  --max-voxels <N>                 Voxel budget ceiling (default: 240000)
  --max-floating <N>               Max floating blocks allowed in --strict mode (default: 0)
  --bundle-out <path.js>           Write concatenated bundle (libs + scripts)
  --emit-anchors <path.nbt>        Emit 1 opaque anchor per 6-connected cluster >= min-cluster
  --anchor-min-cluster <N>         Cluster threshold for --emit-anchors (default: 25)
  --checkpoint-out <path.nbt>      Save final VoxelWorld to .nbt
  --strict                         Exit 1 on OOB, safe-box, lint, voxel-cap, or floating failure
  --require-jar                    Exit 1 if local Minecraft .jar is not detected
  --mcp-dir <path>                 Path to MineBuildingMCP (auto-detected if omitted)
  --help, -h                       Show help`);
}

function summarizeClusters(floatingBlocks) {
  const fMap = new Map();
  for (const fb of floatingBlocks) {
    fMap.set(`${fb.x},${fb.y},${fb.z}`, fb);
  }
  const vis = new Set();
  const clusters = [];
  const dirs = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];

  for (const [k, fb] of fMap.entries()) {
    if (vis.has(k)) continue;
    vis.add(k);
    const q = [fb];
    let head = 0;
    while (head < q.length) {
      const c = q[head++];
      for (const [dx, dy, dz] of dirs) {
        const nk = `${c.x + dx},${c.y + dy},${c.z + dz}`;
        if (fMap.has(nk) && !vis.has(nk)) {
          vis.add(nk);
          q.push(fMap.get(nk));
        }
      }
    }
    clusters.push({ size: q.length, sample: q[0] });
  }
  clusters.sort((a, b) => b.size - a.size);
  return clusters;
}

const NEIGHBOR_DEPENDENT_STATE_KEYS = new Set([
  "north", "south", "east", "west", "up", "down", "shape",
]);

function hasNeighborDependentState(voxel) {
  if (!voxel.state) return false;
  for (const k of Object.keys(voxel.state)) {
    if (NEIGHBOR_DEPENDENT_STATE_KEYS.has(k.toLowerCase())) return true;
  }
  return false;
}

function isNeighborDependentBlockName(name) {
  const shortName = String(name).replace(/^minecraft:/, "");
  return (
    shortName.endsWith("_stairs") ||
    shortName.endsWith("_fence") ||
    shortName.endsWith("_fence_gate") ||
    shortName.endsWith("_wall") ||
    shortName.endsWith("_pane") ||
    shortName.endsWith("_bars") ||
    shortName === "vine" ||
    shortName === "glow_lichen"
  );
}

function getAnchorOpaqueTier(voxel) {
  const isCandidate = OPAQUE_ANCHOR_CANDIDATES.has(voxel.name);
  const stateKeys = voxel.state ? Object.keys(voxel.state) : [];
  if (isCandidate && stateKeys.length === 0) return 3;
  if (isCandidate && !hasNeighborDependentState(voxel)) return 2;
  if (!hasNeighborDependentState(voxel) && !isNeighborDependentBlockName(voxel.name)) return 1;
  return 0;
}

function countSixNeighbors(world, voxel, dirs) {
  let count = 0;
  for (const [dx, dy, dz] of dirs) {
    if (world.voxels.has(`${voxel.x + dx},${voxel.y + dy},${voxel.z + dz}`)) {
      count++;
    }
  }
  return count;
}

function isBetterAnchorCandidate(cand, best) {
  if (!best) return true;
  if (cand.opaqueTier !== best.opaqueTier) return cand.opaqueTier > best.opaqueTier;
  if (cand.enclosure !== best.enclosure) return cand.enclosure > best.enclosure;
  if (Math.abs(cand.dist2 - best.dist2) > 1e-9) return cand.dist2 < best.dist2;
  if (cand.voxel.y !== best.voxel.y) return cand.voxel.y < best.voxel.y;
  if (cand.voxel.z !== best.voxel.z) return cand.voxel.z < best.voxel.z;
  return cand.voxel.x < best.voxel.x;
}

function extractClusterAnchors(world, minClusterSize) {
  const dirs = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
  const existingTerrain = [];
  const groundedKeys = new Set();
  const groundQueue = [];

  for (const [key, v] of world.voxels.entries()) {
    if (v.isTerrain) {
      existingTerrain.push(v);
      groundedKeys.add(key);
      groundQueue.push(v);
    } else if (v.y === 0) {
      groundedKeys.add(key);
      groundQueue.push(v);
    }
  }

  let gHead = 0;
  while (gHead < groundQueue.length) {
    const cur = groundQueue[gHead++];
    for (const [dx, dy, dz] of dirs) {
      const nk = `${cur.x + dx},${cur.y + dy},${cur.z + dz}`;
      if (!groundedKeys.has(nk)) {
        const nv = world.voxels.get(nk);
        if (nv) {
          groundedKeys.add(nk);
          groundQueue.push(nv);
        }
      }
    }
  }

  const visited = new Set();
  const anchors = [];
  let residualSmall = 0;

  for (const [key, startV] of world.voxels.entries()) {
    if (groundedKeys.has(key) || visited.has(key)) continue;
    visited.add(key);
    const cluster = [startV];
    let head = 0;

    while (head < cluster.length) {
      const cur = cluster[head++];
      for (const [dx, dy, dz] of dirs) {
        const nk = `${cur.x + dx},${cur.y + dy},${cur.z + dz}`;
        if (!groundedKeys.has(nk) && !visited.has(nk)) {
          const nv = world.voxels.get(nk);
          if (nv) {
            visited.add(nk);
            cluster.push(nv);
          }
        }
      }
    }

    if (cluster.length >= minClusterSize) {
      let sumX = 0, sumY = 0, sumZ = 0;
      for (const v of cluster) {
        sumX += v.x;
        sumY += v.y;
        sumZ += v.z;
      }
      const cx = sumX / cluster.length;
      const cy = sumY / cluster.length;
      const cz = sumZ / cluster.length;

      let best = null;
      for (const v of cluster) {
        const cand = {
          voxel: v,
          opaqueTier: getAnchorOpaqueTier(v),
          enclosure: countSixNeighbors(world, v, dirs),
          dist2: (v.x - cx) ** 2 + (v.y - cy) ** 2 + (v.z - cz) ** 2,
        };
        if (isBetterAnchorCandidate(cand, best)) {
          best = cand;
        }
      }
      anchors.push(best.voxel);
    } else {
      residualSmall += cluster.length;
    }
  }

  return { anchors, existingTerrain, residualSmall };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }
  if (opts.scripts.length === 0) {
    printHelp();
    throw new Error("Provide at least one build script file to validate.");
  }

  const distDir = resolveMcpDistDir(opts.mcpDir);
  const { VoxelWorld } = await importMcpModule(distDir, "core/voxel-world.js");
  const { loadStructureNbt, saveStructureNbt } = await importMcpModule(distDir, "core/nbt-io.js");
  const { executeBuildScript } = await importMcpModule(distDir, "core/builder-dsl.js");
  const { defaultJarAssetLoader } = await importMcpModule(distDir, "assets/jar-loader.js");

  const libCode = opts.libs
    .map((p) => fs.readFileSync(path.resolve(p), "utf8"))
    .join("\n\n");
  const scriptTexts = opts.scripts.map((p) => ({
    filePath: path.resolve(p),
    code: fs.readFileSync(path.resolve(p), "utf8"),
  }));

  if (opts.bundleOut) {
    const bundlePath = path.resolve(opts.bundleOut);
    fs.mkdirSync(path.dirname(bundlePath), { recursive: true });
    const bundleContent =
      (libCode ? libCode + "\n\n" : "") +
      scriptTexts.map((s) => s.code).join("\n\n") +
      "\n";
    fs.writeFileSync(bundlePath, bundleContent, "utf8");
    console.log(`[Bundle] Wrote ${bundlePath} (${(bundleContent.length / 1024).toFixed(1)} KB)`);
  }

  let world = opts.canvas
    ? await loadStructureNbt(path.resolve(opts.canvas))
    : new VoxelWorld(opts.size);

  for (let i = 0; i < scriptTexts.length; i++) {
    const { filePath, code } = scriptTexts[i];
    const beforeCount = world.voxels.size;
    const t0 = Date.now();
    executeBuildScript(world, (libCode ? libCode + "\n" : "") + code, false, { evaluate: false });
    const dt = Date.now() - t0;
    const afterCount = world.voxels.size;
    console.log(
      `[Phase ${i + 1}: ${path.basename(filePath)}] +${afterCount - beforeCount} voxels (total: ${afterCount.toLocaleString()}) in ${dt}ms | OOB: ${world.outOfBoundsCount}`
    );
  }

  if (opts.emitAnchors) {
    const preAnchorNames = world.getUniqueBlockNames();
    const preAnchorModels = defaultJarAssetLoader.getBlockModelsForBlocks(preAnchorNames);
    world.resolveBlockStates(preAnchorModels);

    const { anchors, existingTerrain, residualSmall } = extractClusterAnchors(world, opts.anchorMinCluster);
    const anchorWorld = new VoxelWorld([...world.size]);
    for (const t of existingTerrain) {
      anchorWorld.setVoxel(
        t.x,
        t.y,
        t.z,
        t.name,
        t.state ? { ...t.state } : undefined,
        true,
        0
      );
    }
    for (const a of anchors) {
      anchorWorld.setVoxel(
        a.x,
        a.y,
        a.z,
        a.name,
        a.state ? { ...a.state } : undefined,
        true,
        0
      );
    }
    anchorWorld.saveInitialTerrainSnapshot();
    const anchorPath = path.resolve(opts.emitAnchors);
    fs.mkdirSync(path.dirname(anchorPath), { recursive: true });
    await saveStructureNbt(anchorWorld, anchorPath, preAnchorModels);
    console.log(
      `[Anchors] Wrote ${anchorPath} (${anchors.length} new anchors + ${existingTerrain.length} existing terrain for ungrounded clusters >= ${opts.anchorMinCluster}; est residual small: ${residualSmall})`
    );

    // Re-run cleanly on top of the anchor canvas to verify exact anchored metrics
    world = await loadStructureNbt(anchorPath);
    for (const { code } of scriptTexts) {
      executeBuildScript(world, (libCode ? libCode + "\n" : "") + code, false, { evaluate: false });
    }
    let preservedAnchors = 0;
    for (const v of world.voxels.values()) {
      if (v.isTerrain) preservedAnchors++;
    }
    const expectedTerrainCount = existingTerrain.length + anchors.length;
    if (preservedAnchors < expectedTerrainCount) {
      console.warn(
        `[Anchors Warn] ${expectedTerrainCount - preservedAnchors}/${expectedTerrainCount} anchor(s) were overwritten (isTerrain cleared). Use pSet/fSet from geometry_helpers.js to preserve isTerrain seeds.`
      );
    }
  }

  // Stats, bounding box & block histogram
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  const blockCounts = {};
  for (const v of world.voxels.values()) {
    if (v.x < minX) minX = v.x;
    if (v.x > maxX) maxX = v.x;
    if (v.y < minY) minY = v.y;
    if (v.y > maxY) maxY = v.y;
    if (v.z < minZ) minZ = v.z;
    if (v.z > maxZ) maxZ = v.z;
    blockCounts[v.name] = (blockCounts[v.name] || 0) + 1;
  }

  const uniqueNames = Object.keys(blockCounts);
  const jarStatus = defaultJarAssetLoader.getStatus();
  const blockModels = defaultJarAssetLoader.getBlockModelsForBlocks(uniqueNames);

  const tEval = Date.now();
  const { resolvedMap } = world.resolveBlockStatesWithMap(blockModels);
  const lint = world.lintStructure(blockModels, resolvedMap);
  const evalRes = world.evaluateStructure(blockModels, { includeLint: false });
  const dtEval = Date.now() - tEval;

  const [sx0, sx1, sy0, sy1, sz0, sz1] = opts.safeBox;
  const hasVoxels = world.voxels.size > 0;
  const safeOk =
    !hasVoxels ||
    (minX >= sx0 && maxX <= sx1 && minY >= sy0 && maxY <= sy1 && minZ >= sz0 && maxZ <= sz1);
  const budgetOk = world.voxels.size <= opts.maxVoxels;

  const topBlocks = Object.entries(blockCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([k, v]) => `${k.replace("minecraft:", "")}:${v}`)
    .join(", ");

  console.log("\n================ DRY-RUN SUMMARY ================");
  console.log(
    `World Size   : ${world.size.join("x")} | Total Voxels: ${world.voxels.size.toLocaleString()} (Cap: ${opts.maxVoxels.toLocaleString()} -> ${budgetOk ? "OK" : "OVER"}) | Unique Blocks: ${uniqueNames.length}`
  );
  console.log(
    `JAR Assets   : jarFound=${jarStatus.jarFound} (${jarStatus.jarPath ?? "FALLBACK - chain/vine tag lint requires real JAR or MCP lint_structure"})`
  );
  console.log(
    `Bounds (XYZ) : ${hasVoxels ? `X[${minX}..${maxX}] Y[${minY}..${maxY}] Z[${minZ}..${maxZ}]` : "(empty)"} | SafeBox [${sx0}..${sx1},${sy0}..${sy1},${sz0}..${sz1}]: ${safeOk ? "OK" : "VIOLATED"} | OOB: ${evalRes.outOfBoundsCount}`
  );
  console.log(
    `Resolve+Lint : ${dtEval}ms | Floating: ${evalRes.floatingBlocks.length} (${evalRes.floatingClustersCount} clusters)`
  );
  console.log(
    `Vanilla Lint : ${lint.valid ? "PASSED (0 issues)" : `FAILED (${lint.issueCount} issues)`} ${JSON.stringify(lint.countsByType)}`
  );
  console.log(`Top Blocks   : ${topBlocks}`);

  if (evalRes.floatingBlocks.length > 0) {
    const clusters = summarizeClusters(evalRes.floatingBlocks);
    console.log(
      `Largest Clusters (top 8): ${clusters
        .slice(0, 8)
        .map((c) => `${c.size}@(${c.sample.x},${c.sample.y},${c.sample.z} ${c.sample.name})`)
        .join(", ")}`
    );
    if (clusters.length > 8) {
      console.log(
        `Smallest Clusters (5)  : ${clusters
          .slice(-5)
          .map((c) => `${c.size}@(${c.sample.x},${c.sample.y},${c.sample.z} ${c.sample.name})`)
          .join(", ")}`
      );
    }
  }

  if (lint.issueCount > 0) {
    console.log("Lint Issues (first 15):");
    for (const iss of lint.issues.slice(0, 15)) {
      console.log(
        `  - [${iss.type}] (${iss.coord.x},${iss.coord.y},${iss.coord.z}) ${iss.block}: ${iss.message}`
      );
    }
  }

  if (opts.checkpointOut) {
    const cpPath = path.resolve(opts.checkpointOut);
    fs.mkdirSync(path.dirname(cpPath), { recursive: true });
    await saveStructureNbt(world, cpPath, blockModels, resolvedMap);
    const kb = (fs.statSync(cpPath).size / 1024).toFixed(1);
    console.log(`[Checkpoint] Saved ${cpPath} (${kb} KB)`);
  }

  if (opts.requireJar && !jarStatus.jarFound) {
    console.error("[Require JAR FAILED] Local Minecraft .jar not detected (jarFound=false).");
    process.exit(1);
  }

  if (opts.strict) {
    const failures = [];
    if (evalRes.outOfBoundsCount > 0) failures.push(`OOB=${evalRes.outOfBoundsCount}`);
    if (!safeOk) failures.push("SafeBox violated");
    if (!budgetOk) failures.push(`Voxels ${world.voxels.size} > ${opts.maxVoxels}`);
    if (!lint.valid) failures.push(`Lint issues=${lint.issueCount}`);
    if (evalRes.floatingBlocks.length > opts.maxFloating) {
      failures.push(`Floating ${evalRes.floatingBlocks.length} > ${opts.maxFloating}`);
    }
    if (failures.length > 0) {
      console.error(`[Strict Mode FAILED] ${failures.join(" | ")}`);
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error(`[dry_run_validator] Error: ${err.message}`);
  process.exit(1);
});

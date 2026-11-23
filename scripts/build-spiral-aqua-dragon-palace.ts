import fs from "node:fs";
import path from "node:path";
import { loadStructureNbt, saveStructureNbt } from "../src/core/nbt-io.js";
import { executeBuildScript } from "../src/core/builder-dsl.js";
import { defaultJarAssetLoader } from "../src/assets/jar-loader.js";

const SAMPLE_DIR = path.resolve(
  process.cwd(),
  "samples",
  "spiral_aqua_dragon_palace"
);
const HELPER_PATH = path.resolve(
  process.cwd(),
  ".agent",
  "skills",
  "minebuilding-architect",
  "scripts",
  "geometry_helpers.js"
);
const CANVAS_PATH = path.join(SAMPLE_DIR, "anchored_canvas.nbt");
const OUT_NBT_PATH = path.resolve(
  process.cwd(),
  "samples",
  "spiral_aqua_dragon_palace.nbt"
);

const PHASE_FILES = [
  "01_sea_gate_vortex.js",
  "02_vortex_column.js",
  "03_aqua_dragon.js",
  "04_islands_palaces.js",
  "05_bridges_waterfalls.js",
];

async function main() {
  const helperCode = fs.readFileSync(HELPER_PATH, "utf8");
  const configCode = fs.readFileSync(path.join(SAMPLE_DIR, "00_config.js"), "utf8");
  const prelude = `${helperCode}\n\n${configCode}\n`;

  const world = await loadStructureNbt(CANVAS_PATH);

  console.log("=== Spiral Aqua-Dragon Palace Build Report ===");
  for (let i = 0; i < PHASE_FILES.length; i++) {
    const file = PHASE_FILES[i];
    const phaseCode = fs.readFileSync(path.join(SAMPLE_DIR, file), "utf8");
    const t0 = Date.now();
    executeBuildScript(world, `${prelude}\n${phaseCode}`, false);
    console.log(
      `[Phase ${i + 1}/${PHASE_FILES.length}] ${file} -> ${world.voxels.size.toLocaleString()} voxels in ${Date.now() - t0}ms (OOB: ${world.outOfBoundsCount})`
    );
  }

  const uniqueNames = Array.from(new Set(Array.from(world.voxels.values(), (v) => v.name)));
  const blockModels = defaultJarAssetLoader.getBlockModelsForBlocks(uniqueNames);
  const jarStatus = defaultJarAssetLoader.getStatus();

  world.resolveBlockStates(blockModels);
  const lint = world.lintStructure(blockModels);
  const evalRes = world.evaluateStructure(blockModels);

  console.log(`JAR Assets      : jarFound=${jarStatus.jarFound}`);
  console.log(`Total Voxels    : ${world.voxels.size.toLocaleString()}`);
  console.log(`Out-of-Bounds   : ${evalRes.outOfBoundsCount}`);
  console.log(`Floating Blocks : ${evalRes.floatingBlocks.length} (${evalRes.floatingClustersCount} clusters)`);
  console.log(`Vanilla Lint    : ${lint.valid ? "PASSED (0 issues)" : `FAILED (${lint.issueCount} issues)`}`);

  await saveStructureNbt(world, OUT_NBT_PATH, blockModels);
  const kb = (fs.statSync(OUT_NBT_PATH).size / 1024).toFixed(1);
  console.log(`Saved Spiral Aqua-Dragon Palace NBT to: ${OUT_NBT_PATH} (${kb} KB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

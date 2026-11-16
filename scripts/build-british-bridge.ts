import path from "node:path";
import { loadStructureNbt, saveStructureNbt } from "../src/core/nbt-io.js";
import { executeBuildScript } from "../src/core/builder-dsl.js";

export const BRITISH_BRIDGE_SCRIPT = `// British Retro Victorian Stone & Brick Arch Bridge over the River
// Span: X=8..24, Centerline Z=21 (Width Z=19..23)

// 1. Grounded Stone Abutments & Weathered Riverbed Bases
placeFoundation(10, 19, 11, 23, 12, "stone_bricks");
placeFoundation(18, 19, 19, 23, 11, "stone_bricks");
// Mossy waterline weathering on abutments
fillBox(11, 3, 19, 11, 6, 23, "mossy_stone_bricks", false);
fillBox(18, 3, 19, 18, 6, 23, "mossy_stone_bricks", false);

// 2. Triangular Cutwaters (Upstream Z=18, Downstream Z=24)
placeFoundation(11, 18, 11, 18, 8, "mossy_cobblestone");
placeFoundation(11, 24, 11, 24, 8, "mossy_cobblestone");
placeFoundation(18, 18, 18, 18, 8, "mossy_cobblestone");
placeFoundation(18, 24, 18, 24, 8, "mossy_cobblestone");
setBlock(11, 9, 18, "stone_brick_stairs", { facing: "south", half: "bottom" });
setBlock(11, 9, 24, "stone_brick_stairs", { facing: "north", half: "bottom" });
setBlock(18, 9, 18, "stone_brick_stairs", { facing: "south", half: "bottom" });
setBlock(18, 9, 24, "stone_brick_stairs", { facing: "north", half: "bottom" });

// 3. Main Segmental Arch Vault (X=12..17, Z=19..23)
// Haunches at X=12 and X=17
fillBox(12, 8, 19, 12, 12, 23, "stone_bricks", false);
fillBox(17, 8, 19, 17, 12, 23, "stone_bricks", false);
// Inner arch curve (inverted stairs for smooth soffit)
for (let z = 19; z <= 23; z++) {
  setBlock(12, 8, z, "stone_brick_stairs", { facing: "west", half: "top" });
  setBlock(17, 8, z, "stone_brick_stairs", { facing: "east", half: "top" });
  setBlock(13, 10, z, "stone_brick_stairs", { facing: "west", half: "top" });
  setBlock(16, 10, z, "stone_brick_stairs", { facing: "east", half: "top" });
}
// Upper arch ring & crown vault
fillBox(13, 11, 19, 13, 12, 23, "stone_bricks", false);
fillBox(16, 11, 19, 16, 12, 23, "stone_bricks", false);
fillBox(14, 11, 19, 15, 13, 23, "stone_bricks", false);

// 4. Victorian Red Brick Spandrels & Chiseled Keystones on Facades (Z=19, Z=23)
fillBox(12, 10, 19, 13, 12, 19, "bricks", false);
fillBox(16, 10, 19, 17, 12, 19, "bricks", false);
fillBox(12, 10, 23, 13, 12, 23, "bricks", false);
fillBox(16, 10, 23, 17, 12, 23, "bricks", false);
// Keystones at arch crown
setBlock(14, 12, 19, "chiseled_stone_bricks");
setBlock(15, 12, 19, "chiseled_stone_bricks");
setBlock(14, 12, 23, "chiseled_stone_bricks");
setBlock(15, 12, 23, "chiseled_stone_bricks");

// 5. Humpback Cobblestone & Andesite Road Deck (Z=20..22)
// West approach (X=7..11, Y=13)
placeFoundation(7, 19, 9, 23, 12, "cobblestone");
fillBox(7, 13, 20, 11, 13, 22, "cobblestone", false);
fillBox(12, 13, 20, 13, 13, 22, "andesite", false);
// Crown (X=14..15, Y=14) with gentle stair ramps
fillBox(14, 14, 20, 15, 14, 22, "cobblestone", false);
for (let z = 20; z <= 22; z++) {
  setBlock(13, 14, z, "cobblestone_stairs", { facing: "east", half: "bottom" });
  setBlock(16, 14, z, "cobblestone_stairs", { facing: "west", half: "bottom" });
}
fillBox(16, 13, 20, 17, 13, 22, "andesite", false);
// East stepped descent (X=18..24)
fillBox(18, 12, 20, 19, 12, 22, "cobblestone", false);
placeFoundation(20, 19, 23, 23, 9, "stone_bricks");
fillBox(20, 11, 20, 20, 11, 22, "andesite", false);
fillBox(21, 10, 20, 21, 10, 22, "cobblestone", false);
fillBox(22, 9, 20, 22, 9, 22, "andesite", false);
fillBox(23, 8, 20, 25, 8, 22, "cobblestone", false);
for (let z = 20; z <= 22; z++) {
  setBlock(18, 13, z, "stone_brick_stairs", { facing: "west", half: "bottom" });
  setBlock(20, 12, z, "stone_brick_stairs", { facing: "west", half: "bottom" });
  setBlock(21, 11, z, "stone_brick_stairs", { facing: "west", half: "bottom" });
  setBlock(22, 10, z, "stone_brick_stairs", { facing: "west", half: "bottom" });
}

// 6. Brick & Stone Parapet Walls (Z=19 and Z=23)
for (const z of [19, 23]) {
  // West approach & main span parapets
  fillBox(9, 14, z, 12, 14, z, "bricks", false);
  fillBox(13, 14, z, 16, 15, z, "bricks", false);
  fillBox(17, 14, z, 18, 14, z, "bricks", false);
  // Stone coping slabs along the parapet top
  fillBox(9, 15, z, 12, 15, z, "stone_brick_slab", false, { type: "bottom" });
  fillBox(13, 16, z, 16, 16, z, "stone_brick_slab", false, { type: "bottom" });
  fillBox(17, 15, z, 18, 15, z, "stone_brick_slab", false, { type: "bottom" });
  // East stepped parapet
  setBlock(19, 13, z, "bricks");
  setBlock(19, 14, z, "stone_brick_slab", { type: "bottom" });
  setBlock(20, 12, z, "bricks");
  setBlock(20, 13, z, "stone_brick_slab", { type: "bottom" });
  setBlock(21, 11, z, "bricks");
  setBlock(21, 12, z, "stone_brick_slab", { type: "bottom" });
  setBlock(22, 10, z, "bricks");
  setBlock(22, 11, z, "stone_brick_slab", { type: "bottom" });
}

// 7. Stone Pilasters & Victorian Wrought-Iron Street Lamps
for (const z of [19, 23]) {
  // West entrance pilasters (X=9)
  setBlock(9, 14, z, "stone_bricks");
  setBlock(9, 15, z, "chiseled_stone_bricks");
  setBlock(9, 16, z, "dark_oak_fence");
  setBlock(9, 17, z, "dark_oak_fence");
  setBlock(9, 18, z, "lantern");

  // Crown pilasters (X=14)
  setBlock(14, 15, z, "stone_bricks");
  setBlock(14, 16, z, "chiseled_stone_bricks");
  setBlock(14, 17, z, "dark_oak_fence");
  setBlock(14, 18, z, "lantern");

  // East entrance pilasters (X=19)
  setBlock(19, 13, z, "stone_bricks");
  setBlock(19, 14, z, "chiseled_stone_bricks");
  setBlock(19, 15, z, "dark_oak_fence");
  setBlock(19, 16, z, "dark_oak_fence");
  setBlock(19, 17, z, "lantern");
}
`;

async function main() {
  const samplePath = path.resolve(
    process.cwd(),
    "samples",
    "sloped_river_terrain.nbt"
  );
  const outPath = path.resolve(
    process.cwd(),
    "samples",
    "british_bridge_terrain.nbt"
  );

  const world = await loadStructureNbt(samplePath);
  const result = executeBuildScript(world, BRITISH_BRIDGE_SCRIPT, true);

  console.log("=== British Retro Bridge Build Report ===");
  console.log(`DSL Operations: ${result.opCount}`);
  console.log(`Build Voxels Placed: ${result.evaluation.totalBuildBlocks}`);
  console.log(`Out-of-Bounds Count: ${result.evaluation.outOfBoundsCount}`);
  console.log(`Static Structural Valid: ${result.evaluation.valid}`);
  console.log(`Floating Blocks: ${result.evaluation.floatingBlocks.length}`);
  if (result.evaluation.warnings.length > 0) {
    console.log("Warnings:", result.evaluation.warnings);
  }

  await saveStructureNbt(world, outPath);
  console.log(`Saved bridge NBT to: ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

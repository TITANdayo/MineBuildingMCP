import path from "node:path";
import fs from "node:fs";
import { VoxelWorld } from "../src/core/voxel-world.js";
import { saveStructureNbt } from "../src/core/nbt-io.js";

/**
 * Generates a 32x32x32 sample terrain (.nbt) with:
 * - A sloped hillside / cliff rising toward the North-West
 * - A gentle grassy meadow in the center
 * - A winding small river with sand/gravel banks in the South-East
 *
 * Usage: npx tsx scripts/generate-sample-terrain.ts [outputPath]
 */
async function main() {
  const outPath =
    process.argv[2] ||
    path.resolve(process.cwd(), "samples", "sloped_river_terrain.nbt");

  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const sizeX = 32;
  const sizeY = 32;
  const sizeZ = 32;
  const world = new VoxelWorld([sizeX, sizeY, sizeZ]);

  const waterLevel = 4;

  for (let x = 0; x < sizeX; x++) {
    for (let z = 0; z < sizeZ; z++) {
      // Create a winding river running roughly along x + z ≈ 38..44
      const riverCenter = 38 + Math.sin(x * 0.25) * 3.0 + Math.cos(z * 0.2) * 2.0;
      const distFromRiver = Math.abs(x + z - riverCenter);

      // Base elevation slopes up toward North-West (small x, small z)
      const nwFactor = Math.max(0, (32 - x) * 0.22 + (32 - z) * 0.22);
      // Add a steeper cliff shelf in the NW corner (x < 12, z < 12)
      const cliffBoost =
        x < 12 && z < 12
          ? Math.min(5, Math.floor((12 - Math.max(x, z)) * 0.8))
          : 0;

      // Gentle rolling wave
      const wave = Math.sin(x * 0.18) * 1.2 + Math.cos(z * 0.18) * 1.2;

      let surfaceY = Math.round(5 + nwFactor + cliffBoost + wave);

      if (distFromRiver < 3.2) {
        // Riverbed depression
        const depth = Math.round((3.2 - distFromRiver) * 1.3);
        surfaceY = Math.max(2, waterLevel - depth);
      } else if (distFromRiver < 5.5) {
        // Smooth transition to river bank
        const t = (distFromRiver - 3.2) / 2.3;
        surfaceY = Math.round(waterLevel + t * (surfaceY - waterLevel));
      }

      surfaceY = Math.max(1, Math.min(sizeY - 10, surfaceY));

      for (let y = 0; y <= Math.max(surfaceY, waterLevel); y++) {
        if (y === 0) {
          world.setVoxel(x, y, z, "minecraft:stone", undefined, true, 0);
        } else if (y < surfaceY - 2) {
          world.setVoxel(x, y, z, "minecraft:stone", undefined, true, 0);
        } else if (y < surfaceY) {
          // Subsurface layer
          const isCliffFace = cliffBoost >= 3 && y > 11;
          world.setVoxel(
            x,
            y,
            z,
            isCliffFace ? "minecraft:stone" : "minecraft:dirt",
            undefined,
            true,
            0
          );
        } else if (y === surfaceY) {
          // Surface block
          if (surfaceY < waterLevel) {
            world.setVoxel(x, y, z, "minecraft:sand", undefined, true, 0);
          } else if (surfaceY === waterLevel && distFromRiver < 5.2) {
            world.setVoxel(x, y, z, "minecraft:sand", undefined, true, 0);
          } else if (cliffBoost >= 3 && surfaceY >= 14) {
            world.setVoxel(x, y, z, "minecraft:stone", undefined, true, 0);
          } else {
            world.setVoxel(x, y, z, "minecraft:grass_block", undefined, true, 0);
          }
        } else if (y <= waterLevel && y > surfaceY) {
          // Fill river water up to waterLevel
          world.setVoxel(x, y, z, "minecraft:water", undefined, true, 0);
        }
      }
    }
  }

  await saveStructureNbt(world, outPath);
  const summary = world.getTerrainSummary();
  console.log(`Generated sample terrain NBT at: ${outPath}`);
  console.log(`Size: ${summary.size.join("x")}, Voxels: ${world.getAllVoxels().length}`);
  console.log(`Elevation: minY=${summary.minY}, maxY=${summary.maxY}, avgY=${summary.averageY.toFixed(1)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

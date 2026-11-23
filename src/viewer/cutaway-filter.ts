import { coordKey, toShortBlockId } from "../core/block-name.js";
import type { ViewDirection, VoxelData } from "../types/shared.js";

function isCutawayExteriorProp(name: string): boolean {
  const shortName = toShortBlockId(name);
  return (
    shortName.includes("fence") ||
    shortName.includes("torch") ||
    shortName.includes("lantern") ||
    shortName.includes("candle") ||
    shortName.includes("flower") ||
    shortName.includes("potted") ||
    shortName.includes("carpet") ||
    shortName.includes("pressure_plate") ||
    shortName.includes("button") ||
    shortName.includes("lever") ||
    shortName.includes("sign") ||
    shortName.includes("banner") ||
    shortName.includes("rail") ||
    shortName.includes("leaves") ||
    shortName.includes("sapling")
  );
}

function isCutawayFurnitureBlock(name: string): boolean {
  const shortName = toShortBlockId(name);
  return (
    shortName.includes("chest") ||
    shortName.includes("barrel") ||
    shortName.includes("shulker_box") ||
    shortName.endsWith("_bed") ||
    shortName.endsWith("_stairs") ||
    shortName.includes("crafting_table") ||
    shortName.includes("furnace") ||
    shortName.includes("smoker") ||
    shortName.includes("anvil") ||
    shortName.includes("enchanting_table") ||
    shortName.includes("lectern") ||
    shortName.includes("brewing_stand") ||
    shortName.includes("cauldron") ||
    shortName.includes("composter") ||
    shortName.includes("loom") ||
    shortName.includes("cartography_table") ||
    shortName.includes("fletching_table") ||
    shortName.includes("smithing_table") ||
    shortName.includes("grindstone") ||
    shortName.includes("stonecutter") ||
    shortName.includes("jukebox") ||
    shortName.includes("note_block") ||
    shortName.includes("bookshelf") ||
    shortName === "bell" ||
    shortName.includes("beacon") ||
    shortName.includes("hopper") ||
    shortName.includes("scaffolding") ||
    shortName.includes("ladder") ||
    shortName.includes("campfire")
  );
}

/**
 * Filters world voxels for Dollhouse Cutaway mode at height `cutY` and camera `view`:
 * 1. Ceiling/Roof Cut: Hides all voxels with `voxel.y > cutY`.
 * 2. Camera-Facing Outer Wall Cutaway: Computes the outer structural wall X/Z perimeter
 *    (ignoring exterior props like fences, torches, lanterns, and isolated single-column posts),
 *    then hides non-terrain blocks on the two outer walls facing the camera direction
 *    (`NE`, `SE`, `SW`, `NW`) so the interior floor, back walls, partitions, and furniture are visible.
 */
export function filterVoxelsForCutaway(
  voxels: VoxelData[],
  cutY: number,
  view?: ViewDirection
): VoxelData[] {
  let minBY = Infinity;
  const nonTerrainCoords = new Set<string>();
  const terrainCoords = new Set<string>();
  const allOccupiedCoords = new Set<string>();
  const structuralByY = new Map<number, VoxelData[]>();
  const allStructuralCoords = new Set<string>();

  for (const v of voxels) {
    const key = coordKey(v.x, v.y, v.z);
    allOccupiedCoords.add(key);
    if (v.isTerrain) {
      terrainCoords.add(key);
    } else {
      if (v.y < minBY) {
        minBY = v.y;
      }
      nonTerrainCoords.add(key);
      if (!isCutawayExteriorProp(v.name)) {
        allStructuralCoords.add(key);
        if (v.y <= cutY) {
          let list = structuralByY.get(v.y);
          if (!list) {
            list = [];
            structuralByY.set(v.y, list);
          }
          list.push(v);
        }
      }
    }
  }

  interface LayerExtrema {
    xzSet: Set<string>;
    minXByZ: Map<number, number>;
    maxXByZ: Map<number, number>;
    minZByX: Map<number, number>;
    maxZByX: Map<number, number>;
  }

  const layerExtremaByY = new Map<number, LayerExtrema>();
  for (const [y, list] of structuralByY.entries()) {
    const xzSet = new Set<string>();
    const minXByZ = new Map<number, number>();
    const maxXByZ = new Map<number, number>();
    const minZByX = new Map<number, number>();
    const maxZByX = new Map<number, number>();
    for (const v of list) {
      xzSet.add(`${v.x},${v.z}`);
      const cxMin = minXByZ.get(v.z);
      if (cxMin === undefined || v.x < cxMin) minXByZ.set(v.z, v.x);
      const cxMax = maxXByZ.get(v.z);
      if (cxMax === undefined || v.x > cxMax) maxXByZ.set(v.z, v.x);
      const czMin = minZByX.get(v.x);
      if (czMin === undefined || v.z < czMin) minZByX.set(v.x, v.z);
      const czMax = maxZByX.get(v.x);
      if (czMax === undefined || v.z > czMax) maxZByX.set(v.x, v.z);
    }
    layerExtremaByY.set(y, { xzSet, minXByZ, maxXByZ, minZByX, maxZByX });
  }

  const isEnclosedInLayer = (x: number, z: number, y: number): boolean => {
    const ex = layerExtremaByY.get(y);
    if (!ex) return false;
    return (
      (ex.minXByZ.get(z) ?? Infinity) < x &&
      (ex.maxXByZ.get(z) ?? -Infinity) > x &&
      (ex.minZByX.get(x) ?? Infinity) < z &&
      (ex.maxZByX.get(x) ?? -Infinity) > z
    );
  };

  const isBracketedInLayer = (x: number, z: number, y: number): boolean => {
    const ex = layerExtremaByY.get(y);
    if (!ex) return false;
    const negX = (ex.minXByZ.get(z) ?? Infinity) < x;
    const posX = (ex.maxXByZ.get(z) ?? -Infinity) > x;
    const negZ = (ex.minZByX.get(x) ?? Infinity) < z;
    const posZ = (ex.maxZByX.get(x) ?? -Infinity) > z;
    return (
      (negX && posX && (negZ || posZ)) || (negZ && posZ && (negX || posX))
    );
  };

  // 1. Detect all qualifying floor slab Y levels below cutY.
  const yFloorStats: Array<{
    y: number;
    coveredByAir: number;
    enclosedCovered: number;
    bracketedCovered: number;
    nonFurnitureCovered: number;
    total: number;
    nextYCount: number;
  }> = [];

  for (const [y, list] of structuralByY.entries()) {
    if (y >= cutY) continue;
    let coveredByAir = 0;
    let enclosedCovered = 0;
    let bracketedCovered = 0;
    let nonFurnitureCovered = 0;
    for (const v of list) {
      const aboveKey = coordKey(v.x, v.y + 1, v.z);
      if (!allStructuralCoords.has(aboveKey) && !terrainCoords.has(aboveKey)) {
        coveredByAir++;
        if (isEnclosedInLayer(v.x, v.z, y + 1)) {
          enclosedCovered++;
        }
        if (isBracketedInLayer(v.x, v.z, y + 1)) {
          bracketedCovered++;
        }
        if (!isCutawayFurnitureBlock(v.name)) {
          nonFurnitureCovered++;
        }
      }
    }
    const nextYCount = structuralByY.get(y + 1)?.length ?? 0;
    yFloorStats.push({
      y,
      coveredByAir,
      enclosedCovered,
      bracketedCovered,
      nonFurnitureCovered,
      total: list.length,
      nextYCount,
    });
  }

  yFloorStats.sort((a, b) => a.y - b.y);

  const isTerrainFloorFirstStory = (
    s: (typeof yFloorStats)[number]
  ): boolean => {
    if (s.y !== minBY) return false;
    const list = structuralByY.get(s.y);
    if (!list || list.length === 0) return false;
    let onTerrainCount = 0;
    for (const v of list) {
      if (terrainCoords.has(coordKey(v.x, s.y - 1, v.z))) {
        onTerrainCount++;
      }
    }
    if (onTerrainCount * 2 < list.length) return false;

    const adjTerrainAirKeys = new Set<string>();
    for (const v of list) {
      for (const [dx, dz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nx = v.x + dx;
        const nz = v.z + dz;
        const nKey = coordKey(nx, s.y, nz);
        if (allStructuralCoords.has(nKey) || terrainCoords.has(nKey)) continue;
        if (
          terrainCoords.has(coordKey(nx, s.y - 1, nz)) &&
          isBracketedInLayer(nx, nz, s.y)
        ) {
          adjTerrainAirKeys.add(`${nx},${nz}`);
        }
      }
    }
    const adjInteriorTerrainAir = adjTerrainAirKeys.size;
    return (
      (adjInteriorTerrainAir > 0 &&
        s.nonFurnitureCovered <= adjInteriorTerrainAir) ||
      (s.coveredByAir > 0 && s.nonFurnitureCovered === 0)
    );
  };

  const wallSupportingFloors = yFloorStats.filter(
    (s) => s.total >= 9 && s.nextYCount >= 4 && !isTerrainFloorFirstStory(s)
  );

  const qualifiesAsFloor = (
    s: (typeof yFloorStats)[number],
    useBracketed: boolean
  ): boolean => {
    const eff = useBracketed ? s.bracketedCovered : s.enclosedCovered;
    return eff >= 4 || (s.total <= 25 && eff >= 2);
  };

  const hasEnclosedFloor = wallSupportingFloors.some((s) =>
    qualifiesAsFloor(s, false)
  );
  const useBracketed = !hasEnclosedFloor;
  const hasQualifyingFloor = wallSupportingFloors.some((s) =>
    qualifiesAsFloor(s, useBracketed)
  );

  const prevCoversCandidate = (prevY: number, candY: number): boolean => {
    const prevXZ = layerExtremaByY.get(prevY)?.xzSet;
    const candList = structuralByY.get(candY);
    if (!prevXZ || !candList || candList.length === 0) return false;
    for (const v of candList) {
      if (!prevXZ.has(`${v.x},${v.z}`)) return false;
    }
    return true;
  };

  const preferBroaderLowerSlab = (
    candidate: (typeof yFloorStats)[number],
    minYAllowed = -Infinity
  ) => {
    const prev = yFloorStats.find(
      (s) =>
        s.y === candidate.y - 1 &&
        s.y >= minYAllowed &&
        !isTerrainFloorFirstStory(s) &&
        ((s.enclosedCovered >= 1 && s.total > candidate.total) ||
          (candidate.coveredByAir > 0 &&
            candidate.nonFurnitureCovered * 2 < candidate.coveredByAir &&
            s.total >= candidate.total &&
            prevCoversCandidate(s.y, candidate.y)))
    );
    return prev ?? candidate;
  };

  const floorSlabYs: number[] = [];
  if (hasQualifyingFloor) {
    const rawPrimary = wallSupportingFloors.find((s) =>
      qualifiesAsFloor(s, useBracketed)
    );
    if (rawPrimary) {
      const primary = preferBroaderLowerSlab(rawPrimary);
      floorSlabYs.push(primary.y);
      for (const stat of wallSupportingFloors) {
        if (stat.y < floorSlabYs[floorSlabYs.length - 1] + 3) continue;
        if (qualifiesAsFloor(stat, useBracketed)) {
          const chosen = preferBroaderLowerSlab(
            stat,
            floorSlabYs[floorSlabYs.length - 1] + 3
          );
          floorSlabYs.push(chosen.y);
        }
      }
    }
  } else if (wallSupportingFloors.some((s) => s.bracketedCovered >= 1)) {
    const rawPrimary = wallSupportingFloors.find(
      (s) => s.bracketedCovered >= 1
    );
    if (rawPrimary) {
      const primary = preferBroaderLowerSlab(rawPrimary);
      floorSlabYs.push(primary.y);
      for (const stat of wallSupportingFloors) {
        if (stat.y < floorSlabYs[floorSlabYs.length - 1] + 3) continue;
        if (stat.bracketedCovered >= 2) {
          const chosen = preferBroaderLowerSlab(
            stat,
            floorSlabYs[floorSlabYs.length - 1] + 3
          );
          floorSlabYs.push(chosen.y);
        }
      }
    }
  } else {
    const platform = yFloorStats.find(
      (s) =>
        s.y === minBY &&
        !isTerrainFloorFirstStory(s) &&
        s.coveredByAir >= 4 &&
        s.total >= 9
    );
    if (platform) {
      floorSlabYs.push(platform.y);
    }
  }

  const floorSlabSet = new Set(floorSlabYs);
  let lowestFloorY = floorSlabYs.length > 0 ? floorSlabYs[0] : -Infinity;

  interface StoryRange {
    floorY: number;
    minY: number;
    maxY: number;
    topY: number;
  }

  const stories: StoryRange[] = [];
  if (floorSlabYs.length > 0) {
    if (Number.isFinite(minBY) && floorSlabYs[0] - minBY >= 3) {
      const y1 = floorSlabYs[0] - 1;
      const y2 = floorSlabYs[0] - 2;
      const y1Ex = layerExtremaByY.get(y1);
      const y2Ex = layerExtremaByY.get(y2);
      const firstSlabList = structuralByY.get(floorSlabYs[0]) ?? [];
      const hasHollowRoomBelow =
        (y1Ex?.xzSet.size ?? 0) >= 4 &&
        (y2Ex?.xzSet.size ?? 0) >= 4 &&
        firstSlabList.some((v) => {
          if (
            allOccupiedCoords.has(coordKey(v.x, y1, v.z)) ||
            allOccupiedCoords.has(coordKey(v.x, y2, v.z))
          ) {
            return false;
          }
          if (!isEnclosedInLayer(v.x, v.z, y1)) {
            return false;
          }
          let hitsY2 = 0;
          if ((y2Ex!.minXByZ.get(v.z) ?? Infinity) < v.x) hitsY2++;
          if ((y2Ex!.maxXByZ.get(v.z) ?? -Infinity) > v.x) hitsY2++;
          if ((y2Ex!.minZByX.get(v.x) ?? Infinity) < v.z) hitsY2++;
          if ((y2Ex!.maxZByX.get(v.x) ?? -Infinity) > v.z) hitsY2++;
          return hitsY2 >= 3;
        });
      if (hasHollowRoomBelow) {
        const max1FY = Math.min(cutY, floorSlabYs[0] - 1);
        if (minBY <= max1FY) {
          stories.push({
            floorY: minBY - 1,
            minY: minBY,
            maxY: max1FY,
            topY: floorSlabYs[0] - 1,
          });
          lowestFloorY = minBY;
        }
      }
    }
    for (let i = 0; i < floorSlabYs.length; i++) {
      const floorY = floorSlabYs[i];
      const minY = floorY + 1;
      const maxY =
        i + 1 < floorSlabYs.length
          ? Math.min(cutY, floorSlabYs[i + 1] - 1)
          : cutY;
      const topY =
        i + 1 < floorSlabYs.length ? floorSlabYs[i + 1] - 1 : Infinity;
      if (minY <= maxY) {
        stories.push({ floorY, minY, maxY, topY });
      }
    }
  } else if (Number.isFinite(minBY) && minBY <= cutY) {
    stories.push({ floorY: minBY - 1, minY: minBY, maxY: cutY, topY: Infinity });
  }

  // 2. For each story, identify structural wall columns and compute per-Z / per-X outermost columns to peel.
  interface ColInfo {
    x: number;
    z: number;
    belowCutCount: number;
    fullCount: number;
    hasBase1: boolean;
    hasBase2: boolean;
  }

  interface StoryPeelInfo {
    minY: number;
    maxY: number;
    peelCoords: Set<string>;
  }

  const storyPeels: StoryPeelInfo[] = [];

  if (view) {
    for (const story of stories) {
      const colMap = new Map<string, ColInfo>();
      for (const v of voxels) {
        if (
          !v.isTerrain &&
          !isCutawayExteriorProp(v.name) &&
          v.y >= story.minY &&
          v.y <= story.topY
        ) {
          const key = `${v.x},${v.z}`;
          let cur = colMap.get(key);
          if (!cur) {
            cur = {
              x: v.x,
              z: v.z,
              belowCutCount: 0,
              fullCount: 0,
              hasBase1: false,
              hasBase2: false,
            };
            colMap.set(key, cur);
          }
          cur.fullCount++;
          if (v.y <= story.maxY) {
            cur.belowCutCount++;
          }
          if (v.y === story.minY) {
            cur.hasBase1 = true;
          } else if (v.y === story.minY + 1) {
            cur.hasBase2 = true;
          }
        }
      }

      const allCols = Array.from(colMap.values()).filter(
        (c) => c.belowCutCount > 0
      );
      const baseTwoCols = allCols.filter((c) => c.hasBase1 && c.hasBase2);
      const baseTallCols = allCols.filter(
        (c) => c.hasBase1 && c.fullCount >= 2
      );
      const fullTallCols = allCols.filter((c) => c.fullCount >= 2);

      if (fullTallCols.length < 4) {
        continue;
      }

      const rawCandidates =
        baseTwoCols.length >= 4
          ? baseTwoCols
          : baseTallCols.length >= 4
            ? baseTallCols
            : fullTallCols;

      let cMinX = Infinity;
      let cMaxX = -Infinity;
      let cMinZ = Infinity;
      let cMaxZ = -Infinity;
      for (const c of rawCandidates) {
        if (c.x < cMinX) cMinX = c.x;
        if (c.x > cMaxX) cMaxX = c.x;
        if (c.z < cMinZ) cMinZ = c.z;
        if (c.z > cMaxZ) cMaxZ = c.z;
      }
      if (cMaxX - cMinX < 2 || cMaxZ - cMinZ < 2) {
        continue;
      }

      // Filter out isolated porch pillars (4-connected components of < 3 columns)
      const candMap = new Map<string, ColInfo>();
      for (const c of rawCandidates) {
        candMap.set(`${c.x},${c.z}`, c);
      }
      const visited = new Set<string>();
      const wallCols: ColInfo[] = [];

      for (const [startKey, startCol] of candMap.entries()) {
        if (visited.has(startKey)) continue;
        visited.add(startKey);
        const comp: ColInfo[] = [startCol];
        let head = 0;
        while (head < comp.length) {
          const cur = comp[head++];
          for (const [dx, dz] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ]) {
            const nKey = `${cur.x + dx},${cur.z + dz}`;
            if (visited.has(nKey)) continue;
            const nCol = candMap.get(nKey);
            if (nCol) {
              visited.add(nKey);
              comp.push(nCol);
            }
          }
        }
        if (comp.length >= 3) {
          for (const c of comp) {
            wallCols.push(c);
          }
        }
      }

      if (wallCols.length < 4) {
        continue;
      }

      const minXByZ = new Map<number, number>();
      const maxXByZ = new Map<number, number>();
      const minZByX = new Map<number, number>();
      const maxZByX = new Map<number, number>();

      for (const c of wallCols) {
        const curMinX = minXByZ.get(c.z);
        if (curMinX === undefined || c.x < curMinX) minXByZ.set(c.z, c.x);
        const curMaxX = maxXByZ.get(c.z);
        if (curMaxX === undefined || c.x > curMaxX) maxXByZ.set(c.z, c.x);
        const curMinZ = minZByX.get(c.x);
        if (curMinZ === undefined || c.z < curMinZ) minZByX.set(c.x, c.z);
        const curMaxZ = maxZByX.get(c.x);
        if (curMaxZ === undefined || c.z > curMaxZ) maxZByX.set(c.x, c.z);
      }

      const wallColSet = new Set<string>();
      for (const c of wallCols) {
        wallColSet.add(`${c.x},${c.z}`);
      }

      const hasFrontLintelInDirection = (
        x: number,
        z: number,
        dx: number,
        dz: number
      ): boolean => {
        const hasBuiltFloor = floorSlabSet.has(story.floorY);
        if (
          hasBuiltFloor &&
          !nonTerrainCoords.has(coordKey(x + dx, story.floorY, z + dz))
        ) {
          return false;
        }
        const px = dz !== 0 ? 1 : 0;
        const pz = dx !== 0 ? 1 : 0;
        const maxScan = 32;
        const isSingleWallOnAxis =
          dx !== 0
            ? minXByZ.get(z) === maxXByZ.get(z)
            : minZByX.get(x) === maxZByX.get(x);
        const maxCheckY = Math.min(
          story.minY + (isSingleWallOnAxis ? 5 : 3),
          story.topY
        );
        const isJambCol = (jx: number, jz: number): boolean => {
          if (wallColSet.has(`${jx},${jz}`)) return true;
          if (!candMap.has(`${jx},${jz}`)) return false;
          for (const dir of [-1, 1]) {
            for (let d = 1; d <= 4; d++) {
              const nx = jx + px * dir * d;
              const nz = jz + pz * dir * d;
              if (wallColSet.has(`${nx},${nz}`)) return true;
              let hasLintel = false;
              for (let y = story.minY + 1; y <= maxCheckY; y++) {
                if (allStructuralCoords.has(coordKey(nx, y, nz))) {
                  hasLintel = true;
                  break;
                }
              }
              if (!hasLintel) break;
            }
          }
          return false;
        };
        for (let step = 2; step <= maxScan; step++) {
          const tx = x + dx * step;
          const tz = z + dz * step;
          if (isJambCol(tx, tz)) {
            continue;
          }
          let kNeg = 0;
          for (let k = 1; k <= 5; k++) {
            if (isJambCol(tx - px * k, tz - pz * k)) {
              kNeg = k;
              break;
            }
          }
          let kPos = 0;
          for (let k = 1; k <= 5; k++) {
            if (isJambCol(tx + px * k, tz + pz * k)) {
              kPos = k;
              break;
            }
          }
          if (kNeg > 0 && kPos > 0) {
            const openingWidth = kNeg + kPos - 1;
            if (openingWidth <= 5) {
              for (let y = story.minY + 1; y <= maxCheckY; y++) {
                if (allStructuralCoords.has(coordKey(tx, y, tz))) {
                  return true;
                }
              }
            }
            if (
              openingWidth <= 3 &&
              (!hasBuiltFloor ||
                nonTerrainCoords.has(coordKey(tx, story.floorY, tz)) ||
                nonTerrainCoords.has(coordKey(tx - dx, story.floorY, tz - dz)))
            ) {
              const negBehindIsWall = wallColSet.has(
                `${tx - px * kNeg - dx},${tz - pz * kNeg - dz}`
              );
              const posBehindIsWall = wallColSet.has(
                `${tx + px * kPos - dx},${tz + pz * kPos - dz}`
              );
              if (!negBehindIsWall || !posBehindIsWall) {
                return true;
              }
            }
          }
        }
        return false;
      };

      const peelCoords = new Set<string>();
      for (const c of wallCols) {
        let shouldPeel = false;
        const isEastEdge =
          c.x === maxXByZ.get(c.z) && !hasFrontLintelInDirection(c.x, c.z, 1, 0);
        const isWestEdge =
          c.x === minXByZ.get(c.z) &&
          !hasFrontLintelInDirection(c.x, c.z, -1, 0);
        const isNorthEdge =
          c.z === minZByX.get(c.x) &&
          !hasFrontLintelInDirection(c.x, c.z, 0, -1);
        const isSouthEdge =
          c.z === maxZByX.get(c.x) && !hasFrontLintelInDirection(c.x, c.z, 0, 1);

        switch (view) {
          case "NE":
            shouldPeel = isEastEdge || isNorthEdge;
            break;
          case "SE":
            shouldPeel = isEastEdge || isSouthEdge;
            break;
          case "SW":
            shouldPeel = isWestEdge || isSouthEdge;
            break;
          case "NW":
            shouldPeel = isWestEdge || isNorthEdge;
            break;
        }

        if (shouldPeel) {
          peelCoords.add(`${c.x},${c.z}`);
        }
      }

      if (peelCoords.size > 0) {
        storyPeels.push({ minY: story.minY, maxY: story.maxY, peelCoords });
      }
    }
  }

  return voxels.filter((v) => {
    if (v.y > cutY) {
      return false;
    }

    if (v.isTerrain || floorSlabSet.has(v.y) || v.y < lowestFloorY) {
      return true;
    }

    const colKey = `${v.x},${v.z}`;
    for (const sp of storyPeels) {
      if (v.y >= sp.minY && v.y <= sp.maxY && sp.peelCoords.has(colKey)) {
        return false;
      }
    }

    return true;
  });
}

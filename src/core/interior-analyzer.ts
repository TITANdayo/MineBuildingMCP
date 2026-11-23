import type {
  CardinalDirection,
  InteriorAnalysisReport,
  InteriorFlowIssue,
  InteriorRoom,
  TerrainSummary,
  TraceRecord,
  VoxelData,
} from "../types/shared.js";
import { coordKey, isAirBlock, toFullBlockId } from "./block-name.js";

const LIGHT_BLOCK_KEYWORDS = [
  "lantern",
  "torch",
  "glowstone",
  "sea_lantern",
  "shroomlight",
  "froglight",
  "end_rod",
  "lamp",
  "candle",
  "campfire",
  "jack_o_lantern",
  "beacon",
  "copper_bulb",
];

const CARDINALS_2D: ReadonlyArray<[number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

const DIRS_6: ReadonlyArray<[number, number, number]> = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

export interface InteriorWorldView {
  readonly size: [number, number, number];
  readonly voxels: Map<string, VoxelData>;
  readonly traces: Map<number, TraceRecord>;
  getTerrainSummary(): TerrainSummary;
}

export function isDoorBlockName(name: string): boolean {
  const norm = toFullBlockId(name);
  if (norm.includes("trapdoor")) return false;
  return norm.endsWith("_door");
}

export function isLightBlockName(name: string): boolean {
  const norm = toFullBlockId(name);
  if (norm === "minecraft:light") return true;
  return LIGHT_BLOCK_KEYWORDS.some((kw) => norm.includes(kw));
}

export function isPassableNonBlockingBlock(name: string): boolean {
  const norm = toFullBlockId(name);
  if (isAirBlock(norm) || isDoorBlockName(norm)) return true;
  return (
    norm.includes("carpet") ||
    norm.includes("pressure_plate") ||
    norm.includes("button") ||
    norm.includes("lever") ||
    norm.includes("torch") ||
    norm.includes("sign") ||
    norm.includes("banner") ||
    norm.includes("rail")
  );
}

export function isInteriorFixtureBlock(name: string): boolean {
  const norm = toFullBlockId(name);
  if (isDoorBlockName(norm)) return false;
  if (isPassableNonBlockingBlock(norm) || isLightBlockName(norm)) {
    return (
      !norm.includes("glowstone") &&
      !norm.includes("sea_lantern") &&
      !norm.includes("froglight") &&
      !norm.includes("shroomlight") &&
      !norm.includes("lamp") &&
      !norm.includes("jack_o_lantern") &&
      !norm.includes("beacon") &&
      !norm.includes("copper_bulb")
    );
  }
  return (
    norm.endsWith("_bed") ||
    norm.includes("bookshelf") ||
    norm.includes("chiseled_bookshelf") ||
    norm.includes("flower_pot") ||
    norm.includes("candle") ||
    norm.includes("lectern") ||
    norm.includes("anvil") ||
    norm.includes("cauldron") ||
    norm.includes("chest") ||
    norm.includes("furnace") ||
    norm.includes("smoker") ||
    norm.includes("blast_furnace") ||
    norm.includes("crafting_table") ||
    norm.includes("cartography_table") ||
    norm.includes("fletching_table") ||
    norm.includes("smithing_table") ||
    norm.includes("loom") ||
    norm.includes("stonecutter") ||
    norm.includes("grindstone") ||
    norm.includes("enchanting_table") ||
    norm.includes("brewing_stand") ||
    norm.includes("barrel") ||
    norm.includes("bell") ||
    norm.includes("jukebox") ||
    norm.includes("note_block")
  );
}

/**
 * Checks whether an air voxel (x, y, z) acts as a narrow 1- or 2-block-wide
 * doorway or window aperture in a wall (with vertical wall pillars on both sides and a lintel above).
 */
function isWallAperture(
  world: InteriorWorldView,
  x: number,
  y: number,
  z: number
): boolean {
  const { voxels, size } = world;
  const self = voxels.get(coordKey(x, y, z));
  if (
    self &&
    (isDoorBlockName(self.name) || !isPassableNonBlockingBlock(self.name))
  ) {
    return false;
  }

  // Must have a non-terrain lintel/header block directly above within 1..4 blocks
  const hasLintelAt = (lx: number, ly: number, lz: number): boolean => {
    for (let dy = 1; dy <= 4 && ly + dy < size[1]; dy++) {
      const above = voxels.get(coordKey(lx, ly + dy, lz));
      if (above && !above.isTerrain && !isInteriorFixtureBlock(above.name)) {
        return true;
      }
    }
    return false;
  };

  if (!hasLintelAt(x, y, z)) return false;

  const isOpenAt = (ox: number, oy: number, oz: number): boolean => {
    const v = voxels.get(coordKey(ox, oy, oz));
    return !v || isInteriorFixtureBlock(v.name);
  };

  // A true wall pillar at (wx, wy, wz) must be >= 2 blocks tall (solid at wy AND wy+1,
  // or at wy-1 when (x, wy-1, z) is open such as the upper level of a doorway).
  // Never treat a 1-block-tall floor object or a *_fence + *_slab table as a wall pillar.
  const isWallPillarAt = (wx: number, wy: number, wz: number): boolean => {
    const v = voxels.get(coordKey(wx, wy, wz));
    if (!v || isInteriorFixtureBlock(v.name)) return false;
    const vDown = voxels.get(coordKey(wx, wy - 1, wz));
    if (v.isTerrain && (!vDown || isInteriorFixtureBlock(vDown.name))) {
      return false;
    }
    if (v.name.endsWith("_slab") && vDown?.name.endsWith("_fence")) {
      return false;
    }
    const vUp = voxels.get(coordKey(wx, wy + 1, wz));
    if (vUp && !isInteriorFixtureBlock(vUp.name)) {
      if (
        v.name.endsWith("_fence") &&
        vUp.name.endsWith("_slab") &&
        !vDown?.name.endsWith("_fence") &&
        !isOpenAt(x, wy - 1, z)
      ) {
        return false;
      }
      return true;
    }
    return Boolean(
      vDown &&
        !vDown.isTerrain &&
        !isInteriorFixtureBlock(vDown.name) &&
        isOpenAt(x, wy - 1, z)
    );
  };

  /**
   * Symmetric 1-wide / 2-wide wall-opening test along either wall axis:
   * - `wallAxis === "x"`: wall runs along X (`q = x`), passage runs along Z (`p = z`).
   * - `wallAxis === "z"`: wall runs along Z (`q = z`), passage runs along X (`p = x`).
   */
  const matchesWallAxis = (wallAxis: "x" | "z"): boolean => {
    const selfQ = wallAxis === "x" ? x : z;
    const selfP = wallAxis === "x" ? z : x;
    const toXZ = (q: number, p: number): [number, number] =>
      wallAxis === "x" ? [q, p] : [p, q];

    const openQP = (q: number, p: number): boolean => {
      const [cx, cz] = toXZ(q, p);
      return isOpenAt(cx, y, cz);
    };
    const lintelQP = (q: number, p: number): boolean => {
      const [cx, cz] = toXZ(q, p);
      return hasLintelAt(cx, y, cz);
    };
    const pillarQP = (q: number, p: number): boolean => {
      const [cx, cz] = toXZ(q, p);
      return isWallPillarAt(cx, y, cz);
    };

    if (!openQP(selfQ, selfP - 1) || !openQP(selfQ, selfP + 1)) {
      return false;
    }

    const isNarrowlyEnclosedSlice = (
      np: number,
      lq: number,
      rq: number
    ): boolean => {
      if (!lintelQP(selfQ, np)) return false;
      let hasLow = false;
      for (let wq = lq; wq < selfQ; wq++) {
        if (pillarQP(wq, np)) {
          hasLow = true;
          break;
        }
      }
      if (!hasLow) return false;
      for (let wq = selfQ + 1; wq <= rq; wq++) {
        if (pillarQP(wq, np)) return true;
      }
      return false;
    };

    const isCorridorCornerTurn = (lq: number, rq: number): boolean => {
      const prevEnclosed = isNarrowlyEnclosedSlice(selfP - 1, lq, rq);
      const nextEnclosed = isNarrowlyEnclosedSlice(selfP + 1, lq, rq);
      if (prevEnclosed === nextEnclosed) return false;

      const openP = prevEnclosed ? selfP + 1 : selfP - 1;
      const dpTurn = openP - selfP;
      if (!lintelQP(selfQ, openP)) return false;

      const checkTurnSide = (contWallQ: number, turnWallQ: number): boolean => {
        if (!pillarQP(contWallQ, openP)) return false;
        if (!openQP(turnWallQ, openP)) return false;
        if (!lintelQP(turnWallQ, openP)) return false;
        return (
          pillarQP(turnWallQ, openP + dpTurn) ||
          pillarQP(turnWallQ, openP + 2 * dpTurn)
        );
      };

      return checkTurnSide(lq, rq) || checkTurnSide(rq, lq);
    };

    const isCorridorTJunction = (lq: number, rq: number): boolean => {
      const prevEnclosed = isNarrowlyEnclosedSlice(selfP - 1, lq, rq);
      const nextEnclosed = isNarrowlyEnclosedSlice(selfP + 1, lq, rq);
      if (prevEnclosed === nextEnclosed) return false;

      const openP = prevEnclosed ? selfP + 1 : selfP - 1;
      const dpTurn = openP - selfP;

      for (let aq = lq; aq <= rq; aq++) {
        if (!openQP(aq, openP) || !lintelQP(aq, openP)) {
          return false;
        }
      }

      const p1 = openP + dpTurn;
      if (pillarQP(lq, p1) && pillarQP(rq, p1)) {
        return true;
      }

      for (let aq = lq; aq <= rq; aq++) {
        if (!openQP(aq, p1) || !lintelQP(aq, p1)) {
          return false;
        }
      }
      const p2 = openP + 2 * dpTurn;
      return pillarQP(lq, p2) && pillarQP(rq, p2);
    };

    const isRecessedAlcove = (lq: number, rq: number): boolean => {
      const prevEnclosed = isNarrowlyEnclosedSlice(selfP - 1, lq, rq);
      const nextEnclosed = isNarrowlyEnclosedSlice(selfP + 1, lq, rq);
      if (prevEnclosed === nextEnclosed) return false;

      const dp = nextEnclosed ? 1 : -1;
      const p1 = selfP + dp;
      for (let aq = lq + 1; aq <= rq - 1; aq++) {
        if (!openQP(aq, p1) || !lintelQP(aq, p1)) return false;
      }
      if (!pillarQP(lq, p1) || !pillarQP(rq, p1)) return false;

      const p2 = selfP + 2 * dp;
      let backWallAtP2 = true;
      for (let aq = lq + 1; aq <= rq - 1; aq++) {
        if (!pillarQP(aq, p2)) {
          backWallAtP2 = false;
          break;
        }
      }
      if (backWallAtP2) return true;

      for (let aq = lq + 1; aq <= rq - 1; aq++) {
        if (!openQP(aq, p2) || !lintelQP(aq, p2)) return false;
      }
      if (!pillarQP(lq, p2) || !pillarQP(rq, p2)) return false;

      const p3 = selfP + 3 * dp;
      for (let aq = lq + 1; aq <= rq - 1; aq++) {
        if (!pillarQP(aq, p3)) return false;
      }
      return true;
    };

    const isTrueApertureSpan = (lq: number, rq: number): boolean =>
      !(
        isNarrowlyEnclosedSlice(selfP - 1, lq, rq) &&
        isNarrowlyEnclosedSlice(selfP + 1, lq, rq)
      ) &&
      !isCorridorCornerTurn(lq, rq) &&
      !isCorridorTJunction(lq, rq) &&
      !isRecessedAlcove(lq, rq);

    const wall1 =
      pillarQP(selfQ - 1, selfP) &&
      pillarQP(selfQ + 1, selfP) &&
      isTrueApertureSpan(selfQ - 1, selfQ + 1);
    const wall2Low =
      pillarQP(selfQ - 1, selfP) &&
      openQP(selfQ + 1, selfP) &&
      pillarQP(selfQ + 2, selfP) &&
      isTrueApertureSpan(selfQ - 1, selfQ + 2);
    const wall2High =
      pillarQP(selfQ - 2, selfP) &&
      openQP(selfQ - 1, selfP) &&
      pillarQP(selfQ + 1, selfP) &&
      isTrueApertureSpan(selfQ - 2, selfQ + 1);

    return wall1 || wall2Low || wall2High;
  };

  return matchesWallAxis("x") || matchesWallAxis("z");
}

/**
 * Inspects a door (at its lower block dx, dy, dz) for front/back clearance obstructions.
 */
function inspectDoorClearance(
  world: InteriorWorldView,
  dx: number,
  dy: number,
  dz: number,
  doorVoxel: VoxelData
): {
  x: number;
  y: number;
  z: number;
  block: string;
  blocked: boolean;
  reason?: string;
  obstructingVoxel?: VoxelData;
  trace?: TraceRecord;
} {
  const { voxels, traces } = world;
  const isStructuralWall = (wx: number, wy: number, wz: number): boolean => {
    const v = voxels.get(coordKey(wx, wy, wz));
    if (!v) return false;
    return !isInteriorFixtureBlock(v.name);
  };

  // Determine passage offsets: check surrounding walls first, then fall back to door facing state
  const wallsAlongX =
    isStructuralWall(dx - 1, dy, dz) && isStructuralWall(dx + 1, dy, dz);
  const wallsAlongZ =
    isStructuralWall(dx, dy, dz - 1) && isStructuralWall(dx, dy, dz + 1);

  let passageOffsets: Array<[number, number]>;
  if (wallsAlongX && !wallsAlongZ) {
    passageOffsets = [
      [0, -1],
      [0, 1],
    ];
  } else if (wallsAlongZ && !wallsAlongX) {
    passageOffsets = [
      [-1, 0],
      [1, 0],
    ];
  } else {
    const facing = doorVoxel.state?.facing?.toLowerCase();
    if (facing === "east" || facing === "west") {
      passageOffsets = [
        [-1, 0],
        [1, 0],
      ];
    } else {
      passageOffsets = [
        [0, -1],
        [0, 1],
      ];
    }
  }

  for (const [ox, oz] of passageOffsets) {
    const nx = dx + ox;
    const nz = dz + oz;
    for (const checkY of [dy, dy + 1]) {
      const neighbor = voxels.get(coordKey(nx, checkY, nz));
      if (neighbor && !isPassableNonBlockingBlock(neighbor.name)) {
        const trace = neighbor.opId > 0 ? traces.get(neighbor.opId) : undefined;
        const traceDesc = trace
          ? ` (Line ${trace.line}: \`${trace.codeSnippet}\`)`
          : "";
        return {
          x: dx,
          y: dy,
          z: dz,
          block: doorVoxel.name,
          blocked: true,
          reason: `Door at (${dx}, ${dy}, ${dz}) is blocked at (${nx}, ${checkY}, ${nz}) by ${neighbor.name}${traceDesc}`,
          obstructingVoxel: neighbor,
          ...(trace ? { trace } : {}),
        };
      }
    }
  }

  return {
    x: dx,
    y: dy,
    z: dz,
    block: doorVoxel.name,
    blocked: false,
  };
}

/**
 * Automatically detects enclosed interior rooms per floor, checks door clearance and lighting,
 * and computes first-person eye positions and a suggested horizontal cutaway Y height.
 */
export function analyzeInteriorRooms(
  world: InteriorWorldView
): InteriorAnalysisReport {
  const { voxels, traces, size } = world;
  const [sizeX, sizeY, sizeZ] = size;

  // Bounding box of built (non-terrain) blocks
  let minBuildX = sizeX;
  let maxBuildX = -1;
  let minBuildY = sizeY;
  let maxBuildY = -1;
  let minBuildZ = sizeZ;
  let maxBuildZ = -1;

  const nonTerrainVoxels: VoxelData[] = [];

  for (const voxel of voxels.values()) {
    if (!voxel.isTerrain) {
      nonTerrainVoxels.push(voxel);
      if (voxel.x < minBuildX) minBuildX = voxel.x;
      if (voxel.x > maxBuildX) maxBuildX = voxel.x;
      if (voxel.y < minBuildY) minBuildY = voxel.y;
      if (voxel.y > maxBuildY) maxBuildY = voxel.y;
      if (voxel.z < minBuildZ) minBuildZ = voxel.z;
      if (voxel.z > maxBuildZ) maxBuildZ = voxel.z;
    }
  }

  if (maxBuildY < 0) {
    const summary = world.getTerrainSummary();
    const fallbackCutY = Math.max(
      1,
      Math.round((summary.minY + summary.maxY) / 2)
    );
    return {
      rooms: [],
      suggestedCutY: fallbackCutY,
      flowIssues: [],
      validFlow: true,
      summaryText: "No built structures or interior rooms detected.",
    };
  }

  const isStructuralSolid = (x: number, y: number, z: number): boolean => {
    const v = voxels.get(coordKey(x, y, z));
    if (!v) return false;
    return !isInteriorFixtureBlock(v.name);
  };

  // Index only cells that have a non-terrain lintel (dy in 1..4) or potential ceiling (dy in 1..16)
  // so sparse builds on large 256^3 worlds avoid O(span^3) scans over empty sky.
  const clampedMinBuildY = Math.max(0, minBuildY);
  const clampedMaxBuildY = Math.min(sizeY - 1, maxBuildY);
  const clampedMinBuildX = Math.max(0, minBuildX);
  const clampedMaxBuildX = Math.min(sizeX - 1, maxBuildX);
  const clampedMinBuildZ = Math.max(0, minBuildZ);
  const clampedMaxBuildZ = Math.min(sizeZ - 1, maxBuildZ);

  const lintelCandidates = new Map<string, [number, number, number]>();
  const roofedColsByY = new Map<number, Map<string, [number, number]>>();

  for (const v of nonTerrainVoxels) {
    if (isInteriorFixtureBlock(v.name)) continue;

    for (let dy = 1; dy <= 4; dy++) {
      const cy = v.y - dy;
      if (cy < clampedMinBuildY || cy > clampedMaxBuildY) continue;
      const cKey = coordKey(v.x, cy, v.z);
      if (!lintelCandidates.has(cKey)) {
        lintelCandidates.set(cKey, [v.x, cy, v.z]);
      }
    }

    if (!isDoorBlockName(v.name)) {
      const colKey = `${v.x},${v.z}`;
      for (let dy = 1; dy <= 16; dy++) {
        const cy = v.y - dy;
        if (cy < clampedMinBuildY || cy > clampedMaxBuildY) continue;
        let cols = roofedColsByY.get(cy);
        if (!cols) {
          cols = new Map<string, [number, number]>();
          roofedColsByY.set(cy, cols);
        }
        if (!cols.has(colKey)) {
          cols.set(colKey, [v.x, v.z]);
        }
      }
    }
  }

  // Precompute wall apertures among cells with a non-terrain lintel above them
  const apertureKeys = new Set<string>();
  for (const [key, [x, y, z]] of lintelCandidates.entries()) {
    if (
      x >= clampedMinBuildX &&
      x <= clampedMaxBuildX &&
      z >= clampedMinBuildZ &&
      z <= clampedMaxBuildZ &&
      isWallAperture(world, x, y, z)
    ) {
      apertureKeys.add(key);
    }
  }

  // Inspect column above (x, y, z) for a built ceiling or solid terrain obstruction.
  const inspectColumnAbove = (
    x: number,
    y: number,
    z: number
  ): { ceilingY: number; openSky: boolean } => {
    let terrainHitY = -1;
    for (let cy = y + 1; cy < sizeY && cy <= y + 16; cy++) {
      const v = voxels.get(coordKey(x, cy, z));
      if (v && !isInteriorFixtureBlock(v.name)) {
        if (isDoorBlockName(v.name)) {
          return { ceilingY: -1, openSky: terrainHitY < 0 };
        }
        if (!v.isTerrain) {
          return {
            ceilingY: terrainHitY >= 0 ? terrainHitY : cy,
            openSky: false,
          };
        }
        if (terrainHitY < 0) {
          terrainHitY = cy;
        }
      }
    }
    return { ceilingY: -1, openSky: terrainHitY < 0 };
  };

  // Detect standalone table/chair pieces resting on a floor
  const isLikelyStandaloneFurniture = (
    x: number,
    fy: number,
    z: number,
    v: VoxelData
  ): boolean => {
    if (v.isTerrain) return false;
    const norm = v.name;
    if (
      !norm.endsWith("_fence") &&
      !norm.endsWith("_stairs") &&
      !norm.endsWith("_slab")
    ) {
      return false;
    }
    const below = voxels.get(coordKey(x, fy - 1, z));
    if (!below || isInteriorFixtureBlock(below.name)) return false;
    let openSides = 0;
    for (const [dx, dz] of CARDINALS_2D) {
      const nv = voxels.get(coordKey(x + dx, fy, z + dz));
      if (!nv || isInteriorFixtureBlock(nv.name)) openSides++;
    }
    return openSides >= 2;
  };

  const findFloorBlockY = (x: number, y: number, z: number): number => {
    for (let fy = y - 1; fy >= 0 && y - fy <= 12; fy--) {
      const v = voxels.get(coordKey(x, fy, z));
      if (v && !isInteriorFixtureBlock(v.name)) {
        if (isDoorBlockName(v.name)) return -1;
        if (isLikelyStandaloneFurniture(x, fy, z, v)) {
          continue;
        }
        return fy;
      }
    }
    return -1;
  };

  // Outside-air flood fill per horizontal slice y over roofed columns only
  const outsideAirKeys = new Set<string>();
  const scanMinX = Math.max(0, minBuildX - 1);
  const scanMaxX = Math.min(sizeX - 1, maxBuildX + 1);
  const scanMinZ = Math.max(0, minBuildZ - 1);
  const scanMaxZ = Math.min(sizeZ - 1, maxBuildZ + 1);

  for (let y = clampedMinBuildY; y <= clampedMaxBuildY; y++) {
    const roofedCols = roofedColsByY.get(y);
    if (!roofedCols || roofedCols.size === 0) continue;

    const queue: Array<[number, number]> = [];
    for (const [x, z] of roofedCols.values()) {
      if (x < scanMinX || x > scanMaxX || z < scanMinZ || z > scanMaxZ) {
        continue;
      }
      const key = coordKey(x, y, z);
      if (isStructuralSolid(x, y, z) || apertureKeys.has(key)) continue;

      const onEdge =
        x === scanMinX || x === scanMaxX || z === scanMinZ || z === scanMaxZ;
      let touchesOutsideAir = onEdge || inspectColumnAbove(x, y, z).openSky;

      if (!touchesOutsideAir) {
        for (const [dx, dz] of CARDINALS_2D) {
          const nx = x + dx;
          const nz = z + dz;
          if (nx < scanMinX || nx > scanMaxX || nz < scanMinZ || nz > scanMaxZ) {
            touchesOutsideAir = true;
            break;
          }
          if (!roofedCols.has(`${nx},${nz}`)) {
            const nKey = coordKey(nx, y, nz);
            if (!isStructuralSolid(nx, y, nz) && !apertureKeys.has(nKey)) {
              touchesOutsideAir = true;
              break;
            }
          }
        }
      }

      if (touchesOutsideAir) {
        outsideAirKeys.add(key);
        queue.push([x, z]);
      }
    }

    let head = 0;
    while (head < queue.length) {
      const [cx, cz] = queue[head++];
      for (const [dx, dz] of CARDINALS_2D) {
        const nx = cx + dx;
        const nz = cz + dz;
        if (nx < scanMinX || nx > scanMaxX || nz < scanMinZ || nz > scanMaxZ) continue;
        if (!roofedCols.has(`${nx},${nz}`)) continue;
        const nKey = coordKey(nx, y, nz);
        if (
          outsideAirKeys.has(nKey) ||
          isStructuralSolid(nx, y, nz) ||
          apertureKeys.has(nKey)
        ) {
          continue;
        }
        outsideAirKeys.add(nKey);
        queue.push([nx, nz]);
      }
    }
  }

  // Ray-cast check in 4 cardinal directions (+X, -X, +Z, -Z)
  const countEnclosedDirections = (x: number, y: number, z: number): number => {
    let hits = 0;
    for (let rx = x + 1; rx <= maxBuildX && rx < sizeX; rx++) {
      if (isStructuralSolid(rx, y, z) || apertureKeys.has(coordKey(rx, y, z))) {
        hits++;
        break;
      }
    }
    for (let rx = x - 1; rx >= minBuildX && rx >= 0; rx--) {
      if (isStructuralSolid(rx, y, z) || apertureKeys.has(coordKey(rx, y, z))) {
        hits++;
        break;
      }
    }
    for (let rz = z + 1; rz <= maxBuildZ && rz < sizeZ; rz++) {
      if (isStructuralSolid(x, y, rz) || apertureKeys.has(coordKey(x, y, rz))) {
        hits++;
        break;
      }
    }
    for (let rz = z - 1; rz >= minBuildZ && rz >= 0; rz--) {
      if (isStructuralSolid(x, y, rz) || apertureKeys.has(coordKey(x, y, rz))) {
        hits++;
        break;
      }
    }
    return hits;
  };

  interface InteriorCellInfo {
    x: number;
    y: number;
    z: number;
    floorY: number;
    ceilingY: number;
  }

  const interiorMap = new Map<string, InteriorCellInfo>();
  const minIntY = Math.max(1, minBuildY);
  const maxIntY = Math.min(sizeY - 2, maxBuildY);
  const minIntX = Math.max(1, minBuildX);
  const maxIntX = Math.min(sizeX - 2, maxBuildX);
  const minIntZ = Math.max(1, minBuildZ);
  const maxIntZ = Math.min(sizeZ - 2, maxBuildZ);

  for (let y = minIntY; y <= maxIntY; y++) {
    const roofedCols = roofedColsByY.get(y);
    if (!roofedCols || roofedCols.size === 0) continue;

    for (const [x, z] of roofedCols.values()) {
      if (x < minIntX || x > maxIntX || z < minIntZ || z > maxIntZ) {
        continue;
      }
      const key = coordKey(x, y, z);
      const v = voxels.get(key);
      if (
        (v &&
          !isInteriorFixtureBlock(v.name) &&
          !isLikelyStandaloneFurniture(x, y, z, v)) ||
        apertureKeys.has(key) ||
        outsideAirKeys.has(key)
      ) {
        continue;
      }

      const floorBlockY = findFloorBlockY(x, y, z);
      if (floorBlockY < 0) continue;
      const ceilingBlockY = inspectColumnAbove(x, y, z).ceilingY;
      if (ceilingBlockY < 0) continue;

      if (countEnclosedDirections(x, y, z) < 3) continue;

      interiorMap.set(key, {
        x,
        y,
        z,
        floorY: floorBlockY + 1,
        ceilingY: ceilingBlockY - 1,
      });
    }
  }

  // Group connected interior voxels into room components per floorY
  const visited = new Set<string>();
  const rawComponents: InteriorCellInfo[][] = [];

  for (const [startKey, startCell] of interiorMap.entries()) {
    if (visited.has(startKey)) continue;
    visited.add(startKey);
    const comp: InteriorCellInfo[] = [startCell];
    let head = 0;
    while (head < comp.length) {
      const cur = comp[head++];
      for (const [dx, dy, dz] of DIRS_6) {
        const nKey = coordKey(cur.x + dx, cur.y + dy, cur.z + dz);
        if (visited.has(nKey)) continue;
        const neighbor = interiorMap.get(nKey);
        if (!neighbor) continue;
        if (neighbor.floorY === startCell.floorY) {
          visited.add(nKey);
          comp.push(neighbor);
        }
      }
    }
    rawComponents.push(comp);
  }

  // Filter out tiny crevices (< 4 floor columns or < 4 cells), while allowing 1-wide corridors >= 4 blocks long
  const validComponentsWithBounds: Array<{
    comp: InteriorCellInfo[];
    minX: number;
    minZ: number;
  }> = [];
  for (const comp of rawComponents) {
    if (comp.length < 4) continue;
    const uniqueCols = new Set<string>();
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const c of comp) {
      uniqueCols.add(`${c.x},${c.z}`);
      if (c.x < minX) minX = c.x;
      if (c.x > maxX) maxX = c.x;
      if (c.z < minZ) minZ = c.z;
      if (c.z > maxZ) maxZ = c.z;
    }
    if (uniqueCols.size >= 4 && (maxX - minX >= 1 || maxZ - minZ >= 1)) {
      validComponentsWithBounds.push({ comp, minX, minZ });
    }
  }

  // Sort rooms deterministically: floorY ascending, then minZ, then minX
  validComponentsWithBounds.sort((a, b) => {
    if (a.comp[0].floorY !== b.comp[0].floorY) {
      return a.comp[0].floorY - b.comp[0].floorY;
    }
    if (a.minZ !== b.minZ) return a.minZ - b.minZ;
    return a.minX - b.minX;
  });
  const validComponents = validComponentsWithBounds.map((entry) => entry.comp);

  // Collect all lower door blocks in the world
  const allDoors: Array<{ x: number; y: number; z: number; voxel: VoxelData }> = [];
  for (const voxel of voxels.values()) {
    if (!isDoorBlockName(voxel.name)) continue;
    const below = voxels.get(coordKey(voxel.x, voxel.y - 1, voxel.z));
    if (below && isDoorBlockName(below.name)) {
      continue;
    }
    allDoors.push({ x: voxel.x, y: voxel.y, z: voxel.z, voxel });
  }

  const rooms: InteriorRoom[] = [];
  const flowIssues: InteriorFlowIssue[] = [];
  const reportedBlockedDoorKeys = new Set<string>();

  const wallChecks: ReadonlyArray<{
    dx: number;
    dz: number;
    normal: CardinalDirection;
  }> = [
    { dx: 0, dz: -1, normal: "S" },
    { dx: 0, dz: 1, normal: "N" },
    { dx: -1, dz: 0, normal: "E" },
    { dx: 1, dz: 0, normal: "W" },
  ];

  // Manhattan distance 1..2 offsets for O(1) door-to-room border check
  const doorBorderOffsets: ReadonlyArray<[number, number]> = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [2, 0], [-2, 0], [0, 2], [0, -2],
    [1, 1], [1, -1], [-1, 1], [-1, -1],
  ];

  for (let idx = 0; idx < validComponents.length; idx++) {
    const comp = validComponents[idx];
    const roomId = idx + 1;
    const floorY = comp[0].floorY;

    let rMinX = sizeX;
    let rMaxX = 0;
    let rMinY = sizeY;
    let rMaxY = 0;
    let rMinZ = sizeZ;
    let rMaxZ = 0;

    const colCeilingMap = new Map<string, number>();

    for (const cell of comp) {
      if (cell.x < rMinX) rMinX = cell.x;
      if (cell.x > rMaxX) rMaxX = cell.x;
      if (cell.y < rMinY) rMinY = cell.y;
      if (cell.y > rMaxY) rMaxY = cell.y;
      if (cell.z < rMinZ) rMinZ = cell.z;
      if (cell.z > rMaxZ) rMaxZ = cell.z;

      const colKey = `${cell.x},${cell.z}`;
      const prevCeil = colCeilingMap.get(colKey) ?? cell.ceilingY;
      if (cell.ceilingY > prevCeil || !colCeilingMap.has(colKey)) {
        colCeilingMap.set(colKey, Math.max(prevCeil, cell.y, cell.ceilingY));
      }
    }

    const floorPositions: Array<{ x: number; y: number; z: number }> = [];
    let sumX = 0;
    let sumZ = 0;
    for (const colKey of colCeilingMap.keys()) {
      const [cxStr, czStr] = colKey.split(",");
      const cx = Number(cxStr);
      const cz = Number(czStr);
      floorPositions.push({ x: cx, y: floorY, z: cz });
      sumX += cx;
      sumZ += cz;
    }

    floorPositions.sort((a, b) => (a.z !== b.z ? a.z - b.z : a.x - b.x));

    const avgX = sumX / floorPositions.length;
    const avgZ = sumZ / floorPositions.length;

    let bestFloorPos = floorPositions[0];
    let bestDistSq = Infinity;
    for (const fp of floorPositions) {
      const dSq = (fp.x - avgX) ** 2 + (fp.z - avgZ) ** 2;
      if (dSq < bestDistSq) {
        bestDistSq = dSq;
        bestFloorPos = fp;
      }
    }

    const center = {
      x: bestFloorPos.x,
      y: floorY,
      z: bestFloorPos.z,
    };

    let ceilingY = colCeilingMap.get(`${center.x},${center.z}`) ?? rMaxY;
    for (const fp of floorPositions) {
      if (Math.abs(fp.x - center.x) <= 1 && Math.abs(fp.z - center.z) <= 1) {
        const cY = colCeilingMap.get(`${fp.x},${fp.z}`) ?? floorY;
        if (cY > ceilingY) ceilingY = cY;
      }
    }

    const eyePosition = {
      x: center.x + 0.5,
      y: Number((floorY + 1.6).toFixed(2)),
      z: center.z + 0.5,
    };

    const innerWallPositions: InteriorRoom["innerWallPositions"] = [];
    for (const fp of floorPositions) {
      for (const wc of wallChecks) {
        const wx = fp.x + wc.dx;
        const wz = fp.z + wc.dz;
        const wVoxel = voxels.get(coordKey(wx, floorY, wz));
        if (
          wVoxel &&
          !isDoorBlockName(wVoxel.name) &&
          !isInteriorFixtureBlock(wVoxel.name)
        ) {
          innerWallPositions.push({
            x: fp.x,
            y: floorY,
            z: fp.z,
            normal: wc.normal,
          });
        }
      }
    }

    // Inspect doors bordering this room (within Manhattan distance 1..2 of floorColSet)
    const floorColSet = new Set(floorPositions.map((fp) => `${fp.x},${fp.z}`));
    const roomDoors: InteriorRoom["doors"] = [];

    for (const d of allDoors) {
      if (d.y < floorY - 1 || d.y > floorY + 1) continue;
      let bordersRoom = false;
      for (const [ox, oz] of doorBorderOffsets) {
        if (floorColSet.has(`${d.x + ox},${d.z + oz}`)) {
          bordersRoom = true;
          break;
        }
      }
      if (!bordersRoom) continue;

      const clearance = inspectDoorClearance(world, d.x, d.y, d.z, d.voxel);
      roomDoors.push({
        x: clearance.x,
        y: clearance.y,
        z: clearance.z,
        block: clearance.block,
        blocked: clearance.blocked,
        ...(clearance.reason ? { reason: clearance.reason } : {}),
      });

      if (clearance.blocked) {
        const dKey = coordKey(d.x, d.y, d.z);
        reportedBlockedDoorKeys.add(dKey);
        flowIssues.push({
          type: "door_blocked",
          roomId,
          coord: clearance.obstructingVoxel
            ? {
                x: clearance.obstructingVoxel.x,
                y: clearance.obstructingVoxel.y,
                z: clearance.obstructingVoxel.z,
              }
            : { x: d.x, y: d.y, z: d.z },
          message:
            clearance.reason ??
            `Door at (${d.x}, ${d.y}, ${d.z}) in Room #${roomId} is blocked.`,
          ...(clearance.trace ? { trace: clearance.trace } : {}),
        });
      }
    }

    // Also check open doorway apertures bordering the room
    for (const fp of floorPositions) {
      for (const [dx, dz] of CARDINALS_2D) {
        const ax = fp.x + dx;
        const az = fp.z + dz;
        const aKey = coordKey(ax, floorY, az);
        if (
          apertureKeys.has(aKey) &&
          !roomDoors.some((rd) => rd.x === ax && rd.z === az)
        ) {
          const upperVoxel = voxels.get(coordKey(ax, floorY + 1, az));
          const blockedUpper = Boolean(
            upperVoxel && !isPassableNonBlockingBlock(upperVoxel.name)
          );
          if (blockedUpper && upperVoxel) {
            const trace =
              upperVoxel.opId > 0 ? traces.get(upperVoxel.opId) : undefined;
            const traceDesc = trace
              ? ` (Line ${trace.line}: \`${trace.codeSnippet}\`)`
              : "";
            const reason = `Doorway opening at (${ax}, ${floorY + 1}, ${az}) is blocked by ${upperVoxel.name}${traceDesc}`;
            roomDoors.push({
              x: ax,
              y: floorY,
              z: az,
              block: "minecraft:air (doorway_opening)",
              blocked: true,
              reason,
            });
            flowIssues.push({
              type: "door_blocked",
              roomId,
              coord: { x: ax, y: floorY + 1, z: az },
              message: reason,
              ...(trace ? { trace } : {}),
            });
          } else {
            roomDoors.push({
              x: ax,
              y: floorY,
              z: az,
              block: "minecraft:air (doorway_opening)",
              blocked: false,
            });
          }
        }
      }
    }

    // Count light-emitting blocks inside or immediately bordering the room
    const lightVoxelKeys = new Set<string>();
    for (const cell of comp) {
      for (let lx = cell.x - 1; lx <= cell.x + 1; lx++) {
        for (let ly = cell.y - 1; ly <= cell.y + 1; ly++) {
          for (let lz = cell.z - 1; lz <= cell.z + 1; lz++) {
            const lKey = coordKey(lx, ly, lz);
            if (lightVoxelKeys.has(lKey)) continue;
            const lv = voxels.get(lKey);
            if (lv && isLightBlockName(lv.name)) {
              lightVoxelKeys.add(lKey);
            }
          }
        }
      }
    }
    const lightingCount = lightVoxelKeys.size;

    const headroom = ceilingY - floorY + 1;
    if (headroom < 2) {
      flowIssues.push({
        type: "low_headroom",
        roomId,
        coord: center,
        message: `Room #${roomId} at floorY=${floorY} has low headroom (${headroom} block(s) < 2, ceilingY=${ceilingY}).`,
      });
    }

    if (lightingCount === 0) {
      flowIssues.push({
        type: "unlit_room",
        roomId,
        coord: center,
        message: `Room #${roomId} at floorY=${floorY} has no lighting (lightingCount=0). Place a lantern or torch using placeLighting() or furnishRoom().`,
      });
    }

    if (roomDoors.length === 0) {
      flowIssues.push({
        type: "isolated_room",
        roomId,
        coord: center,
        message: `Room #${roomId} at floorY=${floorY} has no doorway or entrance (doors=0). Add a door using placeDoor().`,
      });
    }

    rooms.push({
      roomId,
      floorY,
      ceilingY,
      center,
      eyePosition,
      bounds: {
        minX: rMinX,
        minY: rMinY,
        minZ: rMinZ,
        maxX: rMaxX,
        maxY: Math.max(rMaxY, ceilingY),
        maxZ: rMaxZ,
      },
      volume: comp.length,
      floorPositions,
      innerWallPositions,
      doors: roomDoors,
      lightingCount,
    });
  }

  // Check any remaining doors not attached to a detected room
  for (const d of allDoors) {
    const dKey = coordKey(d.x, d.y, d.z);
    if (reportedBlockedDoorKeys.has(dKey)) continue;
    const clearance = inspectDoorClearance(world, d.x, d.y, d.z, d.voxel);
    if (clearance.blocked) {
      reportedBlockedDoorKeys.add(dKey);
      flowIssues.push({
        type: "door_blocked",
        coord: clearance.obstructingVoxel
          ? {
              x: clearance.obstructingVoxel.x,
              y: clearance.obstructingVoxel.y,
              z: clearance.obstructingVoxel.z,
            }
          : { x: d.x, y: d.y, z: d.z },
        message:
          clearance.reason ?? `Door at (${d.x}, ${d.y}, ${d.z}) is blocked.`,
        ...(clearance.trace ? { trace: clearance.trace } : {}),
      });
    }
  }

  // Compute suggestedCutY
  let suggestedCutY: number;
  if (rooms.length > 0) {
    const r0 = rooms[0];
    suggestedCutY = Math.max(
      r0.floorY + 1,
      Math.min(r0.ceilingY, r0.floorY + 2)
    );
  } else {
    suggestedCutY = Math.round((minBuildY + maxBuildY) / 2);
  }

  const validFlow =
    flowIssues.filter(
      (i) =>
        i.type === "door_blocked" ||
        i.type === "low_headroom" ||
        i.type === "isolated_room"
    ).length === 0;

  const summaryLines: string[] = [];
  summaryLines.push(
    `Interior Analysis: ${rooms.length} room(s) detected, suggestedCutY=${suggestedCutY}, validFlow=${validFlow}.`
  );
  for (const r of rooms) {
    const blockedDoorsCount = r.doors.filter((d) => d.blocked).length;
    summaryLines.push(
      `  - Room #${r.roomId}: floorY=${r.floorY}, ceilingY=${r.ceilingY}, center=(${r.center.x},${r.center.y},${r.center.z}), eye=(${r.eyePosition.x},${r.eyePosition.y},${r.eyePosition.z}), volume=${r.volume}, lights=${r.lightingCount}, doors=${r.doors.length} (${blockedDoorsCount} blocked)`
    );
  }
  if (flowIssues.length > 0) {
    summaryLines.push(`Flow/Interior Issues (${flowIssues.length}):`);
    for (const issue of flowIssues) {
      summaryLines.push(`  - [${issue.type}] ${issue.message}`);
    }
  }

  return {
    rooms,
    suggestedCutY,
    flowIssues,
    validFlow,
    summaryText: summaryLines.join("\n"),
  };
}

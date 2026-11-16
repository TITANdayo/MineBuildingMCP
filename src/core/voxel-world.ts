import {
  BlockState,
  CardinalDirection,
  InspectResult,
  InteriorAnalysisReport,
  InteriorFlowIssue,
  InteriorRoom,
  StructureEvaluation,
  TerrainSummary,
  TraceRecord,
  VoxelData,
} from "../types/shared.js";

const AIR_BLOCKS = new Set([
  "air",
  "minecraft:air",
  "cave_air",
  "minecraft:cave_air",
  "void_air",
  "minecraft:void_air",
]);

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
];

export function isDoorBlockName(name: string): boolean {
  const norm = normalizeBlockName(name);
  if (norm.includes("trapdoor")) return false;
  return norm.endsWith("_door") || norm.includes("_door");
}

export function isLightBlockName(name: string): boolean {
  const norm = normalizeBlockName(name);
  if (norm === "minecraft:light") return true;
  return LIGHT_BLOCK_KEYWORDS.some((kw) => norm.includes(kw));
}

export function isPassableNonBlockingBlock(name: string): boolean {
  const norm = normalizeBlockName(name);
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
  const norm = normalizeBlockName(name);
  if (isDoorBlockName(norm)) return false;
  if (isPassableNonBlockingBlock(norm) || isLightBlockName(norm)) {
    return (
      !norm.includes("glowstone") &&
      !norm.includes("sea_lantern") &&
      !norm.includes("froglight") &&
      !norm.includes("shroomlight") &&
      !norm.includes("lamp") &&
      !norm.includes("jack_o_lantern") &&
      !norm.includes("beacon")
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

export function normalizeBlockName(name: string): string {
  const trimmed = name.trim().toLowerCase();
  if (!trimmed) return "minecraft:air";
  if (trimmed.includes(":")) return trimmed;
  return `minecraft:${trimmed}`;
}

export function isAirBlock(name: string): boolean {
  const normalized = normalizeBlockName(name);
  return AIR_BLOCKS.has(normalized);
}

export class VoxelWorld {
  public size: [number, number, number];
  public voxels: Map<string, VoxelData> = new Map();
  public initialTerrain: Map<string, VoxelData> = new Map();
  public traces: Map<number, TraceRecord> = new Map();
  public outOfBoundsCount = 0;

  constructor(size: [number, number, number] = [32, 32, 32]) {
    this.size = [
      Math.max(1, Math.min(256, Math.floor(size[0]))),
      Math.max(1, Math.min(256, Math.floor(size[1]))),
      Math.max(1, Math.min(256, Math.floor(size[2]))),
    ];
  }

  public static coordKey(x: number, y: number, z: number): string {
    return `${x},${y},${z}`;
  }

  public isInBounds(x: number, y: number, z: number): boolean {
    return (
      x >= 0 &&
      x < this.size[0] &&
      y >= 0 &&
      y < this.size[1] &&
      z >= 0 &&
      z < this.size[2]
    );
  }

  public setVoxel(
    x: number,
    y: number,
    z: number,
    name: string,
    state?: BlockState,
    isTerrain = false,
    opId = 0
  ): boolean {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const iz = Math.floor(z);

    if (!this.isInBounds(ix, iy, iz)) {
      if (!isTerrain) {
        this.outOfBoundsCount++;
      }
      return false;
    }

    const key = VoxelWorld.coordKey(ix, iy, iz);
    const normalized = normalizeBlockName(name);

    if (isAirBlock(normalized)) {
      this.voxels.delete(key);
      if (isTerrain) {
        this.initialTerrain.delete(key);
      }
      return true;
    }

    const voxel: VoxelData = {
      x: ix,
      y: iy,
      z: iz,
      name: normalized,
      ...(state && Object.keys(state).length > 0 ? { state: { ...state } } : {}),
      isTerrain,
      opId: isTerrain ? 0 : opId,
    };

    this.voxels.set(key, voxel);
    if (isTerrain) {
      this.initialTerrain.set(key, {
        ...voxel,
        ...(voxel.state ? { state: { ...voxel.state } } : {}),
      });
    }
    return true;
  }

  public getVoxel(x: number, y: number, z: number): VoxelData | undefined {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const iz = Math.floor(z);
    return this.voxels.get(VoxelWorld.coordKey(ix, iy, iz));
  }

  public getInitialTerrainVoxel(
    x: number,
    y: number,
    z: number
  ): VoxelData | undefined {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const iz = Math.floor(z);
    return this.initialTerrain.get(VoxelWorld.coordKey(ix, iy, iz));
  }

  public getAllVoxels(): VoxelData[] {
    return Array.from(this.voxels.values());
  }

  public saveInitialTerrainSnapshot(): void {
    this.initialTerrain.clear();
    for (const [key, voxel] of this.voxels.entries()) {
      if (voxel.isTerrain) {
        this.initialTerrain.set(key, {
          ...voxel,
          ...(voxel.state ? { state: { ...voxel.state } } : {}),
        });
      }
    }
  }

  public resetBuild(): void {
    this.voxels.clear();
    for (const [key, voxel] of this.initialTerrain.entries()) {
      this.voxels.set(key, {
        ...voxel,
        ...(voxel.state ? { state: { ...voxel.state } } : {}),
      });
    }
    this.traces.clear();
    this.outOfBoundsCount = 0;
  }

  public clear(): void {
    this.voxels.clear();
    this.initialTerrain.clear();
    this.traces.clear();
    this.outOfBoundsCount = 0;
  }

  public recordTrace(trace: TraceRecord): void {
    this.traces.set(trace.opId, trace);
  }

  public getTracesObject(): Record<number, TraceRecord> {
    const obj: Record<number, TraceRecord> = {};
    for (const [k, v] of this.traces.entries()) {
      obj[k] = v;
    }
    return obj;
  }

  /**
   * Distance from (x, y, z) straight down (y-1, y-2, ...) to the nearest non-air block below.
   * If (x, y-1, z) is non-air, distance is 0.
   * If y === 0, distance is 0 (resting on bottom boundary).
   * If no block exists down to y=0, returns y (distance to bottom y=0).
   */
  public getDistanceToGround(x: number, y: number, z: number): number {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const iz = Math.floor(z);
    if (iy <= 0) return 0;

    let dist = 0;
    for (let checkY = iy - 1; checkY >= 0; checkY--) {
      if (this.voxels.has(VoxelWorld.coordKey(ix, checkY, iz))) {
        return dist;
      }
      dist++;
    }
    return dist;
  }

  /**
   * Returns maximum y at (x, z) that has a non-air block, or -1 if column is empty.
   * If terrainOnly is true, checks initialTerrain (or blocks with isTerrain === true).
   */
  public getSurfaceY(x: number, z: number, terrainOnly = false): number {
    const ix = Math.floor(x);
    const iz = Math.floor(z);
    if (ix < 0 || ix >= this.size[0] || iz < 0 || iz >= this.size[2]) {
      return -1;
    }

    for (let y = this.size[1] - 1; y >= 0; y--) {
      const key = VoxelWorld.coordKey(ix, y, iz);
      if (terrainOnly) {
        const initVoxel = this.initialTerrain.get(key);
        const curVoxel = this.voxels.get(key);
        if (initVoxel || (curVoxel && curVoxel.isTerrain)) {
          return y;
        }
      } else {
        if (this.voxels.has(key)) {
          return y;
        }
      }
    }
    return -1;
  }

  public getTerrainSummary(): TerrainSummary {
    const [sizeX, sizeY, sizeZ] = this.size;
    const heightmap: number[][] = Array.from({ length: sizeX }, () =>
      new Array<number>(sizeZ).fill(-1)
    );
    const blockCounts: Record<string, number> = {};

    let minY = sizeY;
    let maxY = -1;
    let sumY = 0;
    let validColumns = 0;
    let waterColumns = 0;

    const sourceMap =
      this.initialTerrain.size > 0 ? this.initialTerrain : this.voxels;

    for (const voxel of sourceMap.values()) {
      blockCounts[voxel.name] = (blockCounts[voxel.name] ?? 0) + 1;
      if (voxel.y > heightmap[voxel.x][voxel.z]) {
        heightmap[voxel.x][voxel.z] = voxel.y;
      }
    }

    for (let x = 0; x < sizeX; x++) {
      for (let z = 0; z < sizeZ; z++) {
        const h = heightmap[x][z];
        if (h >= 0) {
          if (h < minY) minY = h;
          if (h > maxY) maxY = h;
          sumY += h;
          validColumns++;

          const topVoxel = sourceMap.get(VoxelWorld.coordKey(x, h, z));
          if (topVoxel && topVoxel.name.includes("water")) {
            waterColumns++;
          }
        }
      }
    }

    if (validColumns === 0) {
      minY = 0;
      maxY = 0;
    }

    const averageY =
      validColumns > 0 ? Number((sumY / validColumns).toFixed(2)) : 0;

    // Analyze slopes and flat areas
    let flatCells = 0;
    let gentleSlopeCells = 0;
    let cliffCells = 0;

    for (let x = 0; x < sizeX; x++) {
      for (let z = 0; z < sizeZ; z++) {
        const h = heightmap[x][z];
        if (h < 0) continue;
        let maxDiff = 0;
        const neighbors = [
          [x + 1, z],
          [x - 1, z],
          [x, z + 1],
          [x, z - 1],
        ];
        for (const [nx, nz] of neighbors) {
          if (nx >= 0 && nx < sizeX && nz >= 0 && nz < sizeZ) {
            const nh = heightmap[nx][nz];
            if (nh >= 0) {
              maxDiff = Math.max(maxDiff, Math.abs(h - nh));
            }
          }
        }
        if (maxDiff === 0) flatCells++;
        else if (maxDiff === 1) gentleSlopeCells++;
        else cliffCells++;
      }
    }

    const heightDiff = maxY - minY;
    const flatRatio =
      validColumns > 0 ? Math.round((flatCells / validColumns) * 100) : 100;
    const slopeParts: string[] = [];
    slopeParts.push(
      `Elevation range: Y=${minY}..${maxY} (delta=${heightDiff}, avg=${averageY}).`
    );
    slopeParts.push(
      `Surface profile: ${flatRatio}% flat (${flatCells} cols), ${gentleSlopeCells} gentle slope cols (dY=1), ${cliffCells} steep/cliff cols (dY>=2).`
    );
    if (waterColumns > 0) {
      slopeParts.push(
        `Water coverage: ${waterColumns} surface columns contain water.`
      );
    }
    const slopeSummary = slopeParts.join(" ");

    // Build compact ASCII heightmap (downsample if > 32)
    const stepX = Math.max(1, Math.ceil(sizeX / 32));
    const stepZ = Math.max(1, Math.ceil(sizeZ / 32));
    const asciiLines: string[] = [];
    asciiLines.push(
      `Terrain Summary [Size: ${sizeX}x${sizeY}x${sizeZ}] (Y range: ${minY}..${maxY}, avg: ${averageY})`
    );
    asciiLines.push(slopeSummary);

    const topBlocks = Object.entries(blockCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, count]) => `${name.replace("minecraft:", "")}: ${count}`)
      .join(", ");
    asciiLines.push(`Dominant blocks: ${topBlocks || "none"}`);
    asciiLines.push(
      `Heightmap Grid (Z rows top-to-bottom 0..${sizeZ - 1}, X cols left-to-right 0..${sizeX - 1}, base-36 Y value):`
    );

    for (let z = 0; z < sizeZ; z += stepZ) {
      let row = `z=${String(z).padStart(2, "0")}: `;
      for (let x = 0; x < sizeX; x += stepX) {
        const h = heightmap[x][z];
        if (h < 0) {
          row += ". ";
        } else if (h < 36) {
          row += h.toString(36).toUpperCase() + " ";
        } else {
          row += `${h} `;
        }
      }
      asciiLines.push(row.trimEnd());
    }

    return {
      size: [...this.size],
      minY,
      maxY,
      averageY,
      heightmap,
      slopeSummary,
      blockCounts,
      textSummary: asciiLines.join("\n"),
    };
  }

  public evaluateStructure(): StructureEvaluation {
    const buildBlocks: VoxelData[] = [];
    const groundedKeys = new Set<string>();
    const queue: VoxelData[] = [];

    for (const [key, voxel] of this.voxels.entries()) {
      if (voxel.isTerrain) {
        groundedKeys.add(key);
        queue.push(voxel);
      } else {
        buildBlocks.push(voxel);
        if (voxel.y === 0) {
          groundedKeys.add(key);
          queue.push(voxel);
        }
      }
    }

    const dirs = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ];

    // 6-neighborhood BFS from all terrain and y=0 blocks
    let head = 0;
    while (head < queue.length) {
      const cur = queue[head++];
      for (const [dx, dy, dz] of dirs) {
        const nx = cur.x + dx;
        const ny = cur.y + dy;
        const nz = cur.z + dz;
        const nKey = VoxelWorld.coordKey(nx, ny, nz);
        if (!groundedKeys.has(nKey)) {
          const neighbor = this.voxels.get(nKey);
          if (neighbor) {
            groundedKeys.add(nKey);
            queue.push(neighbor);
          }
        }
      }
    }

    const floatingVoxels: VoxelData[] = [];
    const floatingKeySet = new Set<string>();

    for (const voxel of buildBlocks) {
      const key = VoxelWorld.coordKey(voxel.x, voxel.y, voxel.z);
      if (!groundedKeys.has(key)) {
        floatingVoxels.push(voxel);
        floatingKeySet.add(key);
      }
    }

    // Count connected floating clusters via 6-neighborhood BFS among floating blocks
    let floatingClustersCount = 0;
    const visitedFloating = new Set<string>();
    for (const fv of floatingVoxels) {
      const startKey = VoxelWorld.coordKey(fv.x, fv.y, fv.z);
      if (visitedFloating.has(startKey)) continue;
      floatingClustersCount++;
      const cQueue: VoxelData[] = [fv];
      visitedFloating.add(startKey);
      let cHead = 0;
      while (cHead < cQueue.length) {
        const cur = cQueue[cHead++];
        for (const [dx, dy, dz] of dirs) {
          const nKey = VoxelWorld.coordKey(cur.x + dx, cur.y + dy, cur.z + dz);
          if (floatingKeySet.has(nKey) && !visitedFloating.has(nKey)) {
            visitedFloating.add(nKey);
            const nVoxel = this.voxels.get(nKey);
            if (nVoxel) cQueue.push(nVoxel);
          }
        }
      }
    }

    const floatingBlocks = floatingVoxels.map((v) => {
      const trace = this.traces.get(v.opId);
      return {
        x: v.x,
        y: v.y,
        z: v.z,
        name: v.name,
        opId: v.opId,
        ...(trace ? { trace } : {}),
        distanceToGround: this.getDistanceToGround(v.x, v.y, v.z),
      };
    });

    // Group warnings by opId so the AI gets clear, actionable line number feedback
    const warnings: string[] = [];
    if (floatingBlocks.length > 0) {
      const byOpId = new Map<
        number,
        Array<(typeof floatingBlocks)[number]>
      >();
      for (const fb of floatingBlocks) {
        const list = byOpId.get(fb.opId) ?? [];
        list.push(fb);
        byOpId.set(fb.opId, list);
      }

      for (const [opId, group] of byOpId.entries()) {
        const sample = group[0];
        const minDist = Math.min(...group.map((g) => g.distanceToGround));
        const maxDist = Math.max(...group.map((g) => g.distanceToGround));
        const traceInfo = sample.trace
          ? `Line ${sample.trace.line}: \`${sample.trace.codeSnippet}\``
          : `opId=${opId}`;
        warnings.push(
          `Floating structure detected (${group.length} block(s), ${sample.name} near (${sample.x}, ${sample.y}, ${sample.z}), distanceToGround=${minDist === maxDist ? minDist : `${minDist}..${maxDist}`}) caused by ${traceInfo}. Consider using placeFoundation() or lowering Y.`
        );
      }
    }

    if (this.outOfBoundsCount > 0) {
      warnings.push(
        `${this.outOfBoundsCount} block placement(s) were out of world bounds [0..${this.size[0] - 1}, 0..${this.size[1] - 1}, 0..${this.size[2] - 1}] and ignored.`
      );
    }

    return {
      valid: floatingBlocks.length === 0 && this.outOfBoundsCount === 0,
      totalBuildBlocks: buildBlocks.length,
      floatingBlocks,
      floatingClustersCount,
      outOfBoundsCount: this.outOfBoundsCount,
      warnings,
    };
  }

  public inspectAt(
    x: number,
    y: number,
    z: number,
    opIdFromPicker?: number
  ): InspectResult {
    const voxel = this.getVoxel(x, y, z);
    if (!voxel) {
      return { hit: false };
    }

    const effectiveOpId =
      voxel.opId !== 0 ? voxel.opId : (opIdFromPicker ?? 0);
    const trace =
      effectiveOpId > 0 ? this.traces.get(effectiveOpId) : undefined;

    return {
      hit: true,
      coord: { x: voxel.x, y: voxel.y, z: voxel.z },
      block: voxel.name,
      ...(voxel.state ? { state: { ...voxel.state } } : {}),
      isTerrain: voxel.isTerrain,
      ...(trace ? { trace } : {}),
      distanceToGround: this.getDistanceToGround(voxel.x, voxel.y, voxel.z),
    };
  }

  /**
   * Checks whether an air voxel (x, y, z) acts as a narrow 1- or 2-block-wide
   * doorway or window aperture in a wall (with vertical wall pillars on both sides and a lintel above).
   */
  private isWallAperture(x: number, y: number, z: number): boolean {
    if (this.voxels.has(VoxelWorld.coordKey(x, y, z))) return false;

    // Must have a non-terrain lintel/header block directly above within 1..2 blocks
    const hasLintelAt = (lx: number, ly: number, lz: number): boolean => {
      for (let dy = 1; dy <= 2 && ly + dy < this.size[1]; dy++) {
        const above = this.voxels.get(VoxelWorld.coordKey(lx, ly + dy, lz));
        if (above && !above.isTerrain && !isInteriorFixtureBlock(above.name)) {
          return true;
        }
      }
      return false;
    };

    if (!hasLintelAt(x, y, z)) return false;

    // A true wall pillar at (wx, y, wz) must be solid at y AND solid at y+1 (or y-1 if y is top of doorway)
    const isWallPillarAt = (wx: number, wy: number, wz: number): boolean => {
      const v = this.voxels.get(VoxelWorld.coordKey(wx, wy, wz));
      if (!v || isInteriorFixtureBlock(v.name)) return false;
      const vUp = this.voxels.get(VoxelWorld.coordKey(wx, wy + 1, wz));
      if (vUp && !isInteriorFixtureBlock(vUp.name)) return true;
      const vDown = this.voxels.get(VoxelWorld.coordKey(wx, wy - 1, wz));
      return Boolean(vDown && !vDown.isTerrain && !isInteriorFixtureBlock(vDown.name));
    };

    const isOpenAt = (ox: number, oy: number, oz: number): boolean => {
      const v = this.voxels.get(VoxelWorld.coordKey(ox, oy, oz));
      return !v || isInteriorFixtureBlock(v.name);
    };

    // Checks if adjacent slice along Z has a lintel and flanking wall pillars on both sides of [lx..x-1] and [x+1..rx]
    const isNarrowlyEnclosedSliceZ = (
      nz: number,
      lx: number,
      rx: number
    ): boolean => {
      if (!hasLintelAt(x, y, nz)) return false;
      let hasLeft = false;
      for (let wx = lx; wx < x; wx++) {
        if (isWallPillarAt(wx, y, nz)) {
          hasLeft = true;
          break;
        }
      }
      if (!hasLeft) return false;
      for (let wx = x + 1; wx <= rx; wx++) {
        if (isWallPillarAt(wx, y, nz)) {
          return true;
        }
      }
      return false;
    };

    // Checks if adjacent slice along X has a lintel and flanking wall pillars on both sides of [lz..z-1] and [z+1..rz]
    const isNarrowlyEnclosedSliceX = (
      nx: number,
      lz: number,
      rz: number
    ): boolean => {
      if (!hasLintelAt(nx, y, z)) return false;
      let hasNorth = false;
      for (let wz = lz; wz < z; wz++) {
        if (isWallPillarAt(nx, y, wz)) {
          hasNorth = true;
          break;
        }
      }
      if (!hasNorth) return false;
      for (let wz = z + 1; wz <= rz; wz++) {
        if (isWallPillarAt(nx, y, wz)) {
          return true;
        }
      }
      return false;
    };

    // Check 1-wide or 2-wide opening in an X-aligned wall (wall along X, passage along Z)
    const openZ = isOpenAt(x, y, z - 1) && isOpenAt(x, y, z + 1);
    if (openZ) {
      const wall1X =
        isWallPillarAt(x - 1, y, z) &&
        isWallPillarAt(x + 1, y, z) &&
        !(
          isNarrowlyEnclosedSliceZ(z - 1, x - 1, x + 1) &&
          isNarrowlyEnclosedSliceZ(z + 1, x - 1, x + 1)
        );
      const wall2XLeft =
        isWallPillarAt(x - 1, y, z) &&
        isOpenAt(x + 1, y, z) &&
        isWallPillarAt(x + 2, y, z) &&
        !(
          isNarrowlyEnclosedSliceZ(z - 1, x - 1, x + 2) &&
          isNarrowlyEnclosedSliceZ(z + 1, x - 1, x + 2)
        );
      const wall2XRight =
        isWallPillarAt(x - 2, y, z) &&
        isOpenAt(x - 1, y, z) &&
        isWallPillarAt(x + 1, y, z) &&
        !(
          isNarrowlyEnclosedSliceZ(z - 1, x - 2, x + 1) &&
          isNarrowlyEnclosedSliceZ(z + 1, x - 2, x + 1)
        );
      if (wall1X || wall2XLeft || wall2XRight) return true;
    }

    // Check 1-wide or 2-wide opening in a Z-aligned wall (wall along Z, passage along X)
    const openX = isOpenAt(x - 1, y, z) && isOpenAt(x + 1, y, z);
    if (openX) {
      const wall1Z =
        isWallPillarAt(x, y, z - 1) &&
        isWallPillarAt(x, y, z + 1) &&
        !(
          isNarrowlyEnclosedSliceX(x - 1, z - 1, z + 1) &&
          isNarrowlyEnclosedSliceX(x + 1, z - 1, z + 1)
        );
      const wall2ZNorth =
        isWallPillarAt(x, y, z - 1) &&
        isOpenAt(x, y, z + 1) &&
        isWallPillarAt(x, y, z + 2) &&
        !(
          isNarrowlyEnclosedSliceX(x - 1, z - 1, z + 2) &&
          isNarrowlyEnclosedSliceX(x + 1, z - 1, z + 2)
        );
      const wall2ZSouth =
        isWallPillarAt(x, y, z - 2) &&
        isOpenAt(x, y, z - 1) &&
        isWallPillarAt(x, y, z + 1) &&
        !(
          isNarrowlyEnclosedSliceX(x - 1, z - 2, z + 1) &&
          isNarrowlyEnclosedSliceX(x + 1, z - 2, z + 1)
        );
      if (wall1Z || wall2ZNorth || wall2ZSouth) return true;
    }

    return false;
  }

  /**
   * Inspects a door (at its lower block dx, dy, dz) for front/back clearance obstructions.
   */
  private inspectDoorClearance(
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
    const isStructuralWall = (wx: number, wy: number, wz: number): boolean => {
      const v = this.voxels.get(VoxelWorld.coordKey(wx, wy, wz));
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
      // Wall runs along X -> doorway passes North/South (along Z)
      passageOffsets = [
        [0, -1],
        [0, 1],
      ];
    } else if (wallsAlongZ && !wallsAlongX) {
      // Wall runs along Z -> doorway passes East/West (along X)
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
        const neighbor = this.voxels.get(VoxelWorld.coordKey(nx, checkY, nz));
        if (neighbor && !isPassableNonBlockingBlock(neighbor.name)) {
          const trace =
            neighbor.opId > 0 ? this.traces.get(neighbor.opId) : undefined;
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
  public detectInteriorRooms(): InteriorAnalysisReport {
    const [sizeX, sizeY, sizeZ] = this.size;

    // Bounding box of built (non-terrain) blocks
    let minBuildX = sizeX;
    let maxBuildX = -1;
    let minBuildY = sizeY;
    let maxBuildY = -1;
    let minBuildZ = sizeZ;
    let maxBuildZ = -1;

    for (const voxel of this.voxels.values()) {
      if (!voxel.isTerrain) {
        if (voxel.x < minBuildX) minBuildX = voxel.x;
        if (voxel.x > maxBuildX) maxBuildX = voxel.x;
        if (voxel.y < minBuildY) minBuildY = voxel.y;
        if (voxel.y > maxBuildY) maxBuildY = voxel.y;
        if (voxel.z < minBuildZ) minBuildZ = voxel.z;
        if (voxel.z > maxBuildZ) maxBuildZ = voxel.z;
      }
    }

    if (maxBuildY < 0) {
      // No built blocks yet; fall back to terrain bounds
      const summary = this.getTerrainSummary();
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

    // Helper: is (x, y, z) a structural barrier (wall/floor/ceiling/door/window) vs interior space (air or interior fixture)?
    const isStructuralSolid = (x: number, y: number, z: number): boolean => {
      const v = this.voxels.get(VoxelWorld.coordKey(x, y, z));
      if (!v) return false;
      return !isInteriorFixtureBlock(v.name);
    };

    // Precompute wall apertures inside the build bounding box
    const apertureKeys = new Set<string>();
    for (let y = Math.max(0, minBuildY); y <= Math.min(sizeY - 1, maxBuildY); y++) {
      for (let x = Math.max(0, minBuildX); x <= Math.min(sizeX - 1, maxBuildX); x++) {
        for (let z = Math.max(0, minBuildZ); z <= Math.min(sizeZ - 1, maxBuildZ); z++) {
          if (this.isWallAperture(x, y, z)) {
            apertureKeys.add(VoxelWorld.coordKey(x, y, z));
          }
        }
      }
    }

    // Helper: does (x, y, z) have a non-terrain ceiling/roof block above it?
    const findCeilingBlockY = (x: number, y: number, z: number): number => {
      for (let cy = y + 1; cy < sizeY && cy <= y + 16; cy++) {
        const v = this.voxels.get(VoxelWorld.coordKey(x, cy, z));
        if (v && !isInteriorFixtureBlock(v.name)) {
          if (!v.isTerrain && !isDoorBlockName(v.name)) {
            return cy;
          }
          // Hit terrain or door before a ceiling
          return -1;
        }
      }
      return -1;
    };

    // Helper: is a block likely a standalone table/chair piece resting on a floor?
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
      // Must rest directly on a solid block at fy - 1
      const below = this.voxels.get(VoxelWorld.coordKey(x, fy - 1, z));
      if (!below || isInteriorFixtureBlock(below.name)) return false;
      // Must have open/fixture space on at least 2 of 4 horizontal sides at fy
      let openSides = 0;
      for (const [dx, dz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nv = this.voxels.get(VoxelWorld.coordKey(x + dx, fy, z + dz));
        if (!nv || isInteriorFixtureBlock(nv.name)) openSides++;
      }
      return openSides >= 2;
    };

    // Helper: does (x, y, z) have a solid floor block below it within 1..12 blocks?
    const findFloorBlockY = (x: number, y: number, z: number): number => {
      for (let fy = y - 1; fy >= 0 && y - fy <= 12; fy--) {
        const v = this.voxels.get(VoxelWorld.coordKey(x, fy, z));
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

    // Outside-air flood fill per horizontal slice y in [minBuildY..maxBuildY]
    // Any cell without a non-terrain ceiling above it OR on the world boundary is seeded as outside air.
    // Flood-fill cannot pass through structural solid blocks (including doors/windows) or wall apertures.
    const outsideAirKeys = new Set<string>();
    const cardinals2D: Array<[number, number]> = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ];

    const scanMinX = Math.max(0, minBuildX - 1);
    const scanMaxX = Math.min(sizeX - 1, maxBuildX + 1);
    const scanMinZ = Math.max(0, minBuildZ - 1);
    const scanMaxZ = Math.min(sizeZ - 1, maxBuildZ + 1);

    for (let y = Math.max(0, minBuildY); y <= Math.min(sizeY - 1, maxBuildY); y++) {
      const queue: Array<[number, number]> = [];
      for (let x = scanMinX; x <= scanMaxX; x++) {
        for (let z = scanMinZ; z <= scanMaxZ; z++) {
          const key = VoxelWorld.coordKey(x, y, z);
          if (isStructuralSolid(x, y, z) || apertureKeys.has(key)) continue;
          const onEdge =
            x === scanMinX || x === scanMaxX || z === scanMinZ || z === scanMaxZ;
          const hasRoof = findCeilingBlockY(x, y, z) >= 0;
          if (onEdge || !hasRoof) {
            outsideAirKeys.add(key);
            queue.push([x, z]);
          }
        }
      }

      let head = 0;
      while (head < queue.length) {
        const [cx, cz] = queue[head++];
        for (const [dx, dz] of cardinals2D) {
          const nx = cx + dx;
          const nz = cz + dz;
          if (nx < scanMinX || nx > scanMaxX || nz < scanMinZ || nz > scanMaxZ) continue;
          const nKey = VoxelWorld.coordKey(nx, y, nz);
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
    const countEnclosedDirections = (
      x: number,
      y: number,
      z: number
    ): number => {
      let hits = 0;
      // +X
      for (let rx = x + 1; rx <= maxBuildX && rx < sizeX; rx++) {
        if (
          isStructuralSolid(rx, y, z) ||
          apertureKeys.has(VoxelWorld.coordKey(rx, y, z))
        ) {
          hits++;
          break;
        }
      }
      // -X
      for (let rx = x - 1; rx >= minBuildX && rx >= 0; rx--) {
        if (
          isStructuralSolid(rx, y, z) ||
          apertureKeys.has(VoxelWorld.coordKey(rx, y, z))
        ) {
          hits++;
          break;
        }
      }
      // +Z
      for (let rz = z + 1; rz <= maxBuildZ && rz < sizeZ; rz++) {
        if (
          isStructuralSolid(x, y, rz) ||
          apertureKeys.has(VoxelWorld.coordKey(x, y, rz))
        ) {
          hits++;
          break;
        }
      }
      // -Z
      for (let rz = z - 1; rz >= minBuildZ && rz >= 0; rz--) {
        if (
          isStructuralSolid(x, y, rz) ||
          apertureKeys.has(VoxelWorld.coordKey(x, y, rz))
        ) {
          hits++;
          break;
        }
      }
      return hits;
    };

    // Identify all candidate interior voxels and record their floorY & ceilingY
    interface InteriorCellInfo {
      x: number;
      y: number;
      z: number;
      floorY: number;
      ceilingY: number;
    }

    const interiorMap = new Map<string, InteriorCellInfo>();

    for (let y = Math.max(1, minBuildY); y <= Math.min(sizeY - 2, maxBuildY); y++) {
      for (let x = Math.max(1, minBuildX); x <= Math.min(sizeX - 2, maxBuildX); x++) {
        for (let z = Math.max(1, minBuildZ); z <= Math.min(sizeZ - 2, maxBuildZ); z++) {
          const key = VoxelWorld.coordKey(x, y, z);
          const v = this.voxels.get(key);
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
          const ceilingBlockY = findCeilingBlockY(x, y, z);
          if (ceilingBlockY < 0) continue;

          const enclosedDirs = countEnclosedDirections(x, y, z);
          if (enclosedDirs < 3) continue;

          interiorMap.set(key, {
            x,
            y,
            z,
            floorY: floorBlockY + 1,
            ceilingY: ceilingBlockY - 1,
          });
        }
      }
    }

    // Group connected interior voxels into room components per floorY
    // Two interior voxels connect if they are 6-neighbors and share the same floorY
    const visited = new Set<string>();
    const dirs6: Array<[number, number, number]> = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ];

    const rawComponents: InteriorCellInfo[][] = [];

    for (const [startKey, startCell] of interiorMap.entries()) {
      if (visited.has(startKey)) continue;
      visited.add(startKey);
      const comp: InteriorCellInfo[] = [startCell];
      let head = 0;
      while (head < comp.length) {
        const cur = comp[head++];
        for (const [dx, dy, dz] of dirs6) {
          const nKey = VoxelWorld.coordKey(cur.x + dx, cur.y + dy, cur.z + dz);
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

    // Filter out tiny crevices and 1-block-thin wall-top strips under roof eaves
    const validComponents = rawComponents.filter((comp) => {
      const uniqueCols = new Set(comp.map((c) => `${c.x},${c.z}`));
      const minX = Math.min(...comp.map((c) => c.x));
      const maxX = Math.max(...comp.map((c) => c.x));
      const minZ = Math.min(...comp.map((c) => c.z));
      const maxZ = Math.max(...comp.map((c) => c.z));
      return (
        uniqueCols.size >= 4 &&
        comp.length >= 4 &&
        maxX - minX >= 1 &&
        maxZ - minZ >= 1
      );
    });

    // Sort rooms deterministically: floorY ascending, then minZ, then minX
    validComponents.sort((a, b) => {
      if (a[0].floorY !== b[0].floorY) return a[0].floorY - b[0].floorY;
      const minZa = Math.min(...a.map((c) => c.z));
      const minZb = Math.min(...b.map((c) => c.z));
      if (minZa !== minZb) return minZa - minZb;
      const minXa = Math.min(...a.map((c) => c.x));
      const minXb = Math.min(...b.map((c) => c.x));
      return minXa - minXb;
    });

    // Collect all lower door blocks in the world for door analysis
    const allDoors: Array<{ x: number; y: number; z: number; voxel: VoxelData }> =
      [];
    for (const voxel of this.voxels.values()) {
      if (!isDoorBlockName(voxel.name)) continue;
      const below = this.voxels.get(
        VoxelWorld.coordKey(voxel.x, voxel.y - 1, voxel.z)
      );
      if (below && isDoorBlockName(below.name)) {
        // Upper half of a 2-block door; skip so we only process the lower block
        continue;
      }
      allDoors.push({ x: voxel.x, y: voxel.y, z: voxel.z, voxel });
    }

    const rooms: InteriorRoom[] = [];
    const flowIssues: InteriorFlowIssue[] = [];
    const reportedBlockedDoorKeys = new Set<string>();

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
      const roomVoxelKeys = new Set<string>();

      for (const cell of comp) {
        roomVoxelKeys.add(VoxelWorld.coordKey(cell.x, cell.y, cell.z));
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

      // Snap center to the closest actual floor position in the room
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

      // ceilingY near center
      let ceilingY =
        colCeilingMap.get(`${center.x},${center.z}`) ?? rMaxY;
      for (const fp of floorPositions) {
        if (
          Math.abs(fp.x - center.x) <= 1 &&
          Math.abs(fp.z - center.z) <= 1
        ) {
          const cY = colCeilingMap.get(`${fp.x},${fp.z}`) ?? floorY;
          if (cY > ceilingY) ceilingY = cY;
        }
      }

      const eyePosition = {
        x: center.x + 0.5,
        y: Number((floorY + 1.6).toFixed(2)),
        z: center.z + 0.5,
      };

      // Inner wall positions at floorY
      // normal points from the wall into the room:
      // wall at z-1 (North) -> normal "S" (+Z)
      // wall at z+1 (South) -> normal "N" (-Z)
      // wall at x-1 (West)  -> normal "E" (+X)
      // wall at x+1 (East)  -> normal "W" (-X)
      const innerWallPositions: Array<{
        x: number;
        y: number;
        z: number;
        normal: CardinalDirection;
      }> = [];

      const wallChecks: Array<{
        dx: number;
        dz: number;
        normal: CardinalDirection;
      }> = [
        { dx: 0, dz: -1, normal: "S" },
        { dx: 0, dz: 1, normal: "N" },
        { dx: -1, dz: 0, normal: "E" },
        { dx: 1, dz: 0, normal: "W" },
      ];

      for (const fp of floorPositions) {
        for (const wc of wallChecks) {
          const wx = fp.x + wc.dx;
          const wz = fp.z + wc.dz;
          const wVoxel = this.voxels.get(VoxelWorld.coordKey(wx, floorY, wz));
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

      // Inspect doors bordering this room (within 1..2 blocks horizontally at floorY-1..floorY+1)
      const floorColSet = new Set(floorPositions.map((fp) => `${fp.x},${fp.z}`));
      const roomDoors: InteriorRoom["doors"] = [];

      for (const d of allDoors) {
        if (d.y < floorY - 1 || d.y > floorY + 1) continue;
        // Check if door is within Manhattan distance 1 or 2 of any floor cell of this room
        let bordersRoom = false;
        for (const fp of floorPositions) {
          const manhattan = Math.abs(fp.x - d.x) + Math.abs(fp.z - d.z);
          if (manhattan >= 1 && manhattan <= 2) {
            bordersRoom = true;
            break;
          }
        }
        if (!bordersRoom) continue;

        const clearance = this.inspectDoorClearance(d.x, d.y, d.z, d.voxel);
        roomDoors.push({
          x: clearance.x,
          y: clearance.y,
          z: clearance.z,
          block: clearance.block,
          blocked: clearance.blocked,
          ...(clearance.reason ? { reason: clearance.reason } : {}),
        });

        if (clearance.blocked) {
          const dKey = VoxelWorld.coordKey(d.x, d.y, d.z);
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

      // Also check open doorway apertures bordering the room for any blocking furniture/blocks
      for (const fp of floorPositions) {
        for (const [dx, dz] of cardinals2D) {
          const ax = fp.x + dx;
          const az = fp.z + dz;
          const aKey = VoxelWorld.coordKey(ax, floorY, az);
          if (
            apertureKeys.has(aKey) &&
            !roomDoors.some((rd) => rd.x === ax && rd.z === az)
          ) {
            // Virtual doorway opening
            const upperVoxel = this.voxels.get(
              VoxelWorld.coordKey(ax, floorY + 1, az)
            );
            const blockedUpper = Boolean(
              upperVoxel && !isPassableNonBlockingBlock(upperVoxel.name)
            );
            roomDoors.push({
              x: ax,
              y: floorY,
              z: az,
              block: "minecraft:air (doorway_opening)",
              blocked: blockedUpper,
              ...(blockedUpper && upperVoxel
                ? {
                    reason: `Doorway opening at (${ax}, ${floorY + 1}, ${az}) is blocked by ${upperVoxel.name}`,
                  }
                : {}),
            });
          }
        }
      }

      // Count light-emitting blocks inside or immediately bordering the room
      const lightVoxelKeys = new Set<string>();
      for (const cell of comp) {
        for (let lx = cell.x - 1; lx <= cell.x + 1; lx++) {
          for (let ly = cell.y - 1; ly <= cell.y + 1; ly++) {
            for (let lz = cell.z - 1; lz <= cell.z + 1; lz++) {
              const lKey = VoxelWorld.coordKey(lx, ly, lz);
              if (lightVoxelKeys.has(lKey)) continue;
              const lv = this.voxels.get(lKey);
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

      // Unused variable suppression check: floorColSet is available if needed
      void floorColSet;

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

    // Check any remaining doors in the world that weren't attached to a detected room
    for (const d of allDoors) {
      const dKey = VoxelWorld.coordKey(d.x, d.y, d.z);
      if (reportedBlockedDoorKeys.has(dKey)) continue;
      const clearance = this.inspectDoorClearance(d.x, d.y, d.z, d.voxel);
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
}

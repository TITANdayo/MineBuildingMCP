import {
  BlockState,
  InspectResult,
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
}

import * as vm from "node:vm";
import {
  BlockState,
  StructureEvaluation,
  TraceRecord,
} from "../types/shared.js";
import { normalizeBlockName, VoxelWorld } from "./voxel-world.js";

const SCRIPT_FILENAME = "ai_build_script.js";

function formatArg(arg: unknown): string {
  if (typeof arg === "string") {
    return JSON.stringify(arg);
  }
  if (typeof arg === "number" || typeof arg === "boolean") {
    return String(arg);
  }
  if (arg === undefined) {
    return "undefined";
  }
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function formatCodeSnippet(funcName: string, args: unknown[]): string {
  // Trim trailing undefined arguments for cleaner snippets
  let lastDefined = args.length - 1;
  while (lastDefined >= 0 && args[lastDefined] === undefined) {
    lastDefined--;
  }
  const relevantArgs = args.slice(0, lastDefined + 1);
  return `${funcName}(${relevantArgs.map(formatArg).join(", ")})`;
}

function deriveGableBlock(stairBlock: string): string {
  const norm = normalizeBlockName(stairBlock);
  if (norm.endsWith("_stairs")) {
    const base = norm.slice(0, -"_stairs".length);
    const woodTypes = [
      "oak",
      "spruce",
      "birch",
      "jungle",
      "acacia",
      "dark_oak",
      "mangrove",
      "cherry",
      "bamboo",
      "crimson",
      "warped",
    ];
    for (const wood of woodTypes) {
      if (base === `minecraft:${wood}`) {
        return `${base}_planks`;
      }
    }
    if (
      base.endsWith("_brick") ||
      base.endsWith("_tile") ||
      base === "minecraft:nether_brick" ||
      base === "minecraft:red_nether_brick"
    ) {
      return `${base}s`;
    }
    return base;
  }
  return norm;
}

export interface BuildExecutionResult {
  opCount: number;
  traces: Record<number, TraceRecord>;
  evaluation: StructureEvaluation;
}

export class BuilderDSL {
  public readonly world: VoxelWorld;
  private opCounter = 0;
  private activeOpId = 0;
  private callDepth = 0;

  constructor(world: VoxelWorld) {
    this.world = world;
  }

  private extractLineNumber(stack?: string): number {
    if (!stack) return 1;

    // 1. Check for vm.Script filename match: ai_build_script.js:<line>:<col>
    const scriptRegex = new RegExp(`${SCRIPT_FILENAME}:(\\d+):(\\d+)`);
    const scriptMatch = stack.match(scriptRegex);
    if (scriptMatch) {
      return Math.max(1, parseInt(scriptMatch[1], 10));
    }

    // 2. Fallback for new Function("<anonymous>:<line>:<col>") where V8 adds 2 wrapper lines
    const anonMatch = stack.match(/<anonymous>:(\d+):(\d+)/);
    if (anonMatch) {
      return Math.max(1, parseInt(anonMatch[1], 10) - 2);
    }

    // 3. Fallback: first frame outside builder-dsl
    const lines = stack.split("\n");
    for (const line of lines) {
      if (
        line.includes("builder-dsl") ||
        line.includes("BuilderDSL") ||
        line.trim().startsWith("Error")
      ) {
        continue;
      }
      const m = line.match(/:(\d+):(\d+)\)?$/);
      if (m) {
        return Math.max(1, parseInt(m[1], 10));
      }
    }

    return 1;
  }

  private beginOperation(funcName: string, args: unknown[]): number {
    this.callDepth++;
    if (this.callDepth === 1) {
      this.opCounter++;
      this.activeOpId = ((this.opCounter - 1) % 255) + 1;
      const err = new Error();
      const line = this.extractLineNumber(err.stack);
      const codeSnippet = formatCodeSnippet(funcName, args);
      const trace: TraceRecord = {
        opId: this.activeOpId,
        line,
        codeSnippet,
      };
      this.world.recordTrace(trace);
    }
    return this.activeOpId;
  }

  private endOperation(): void {
    this.callDepth = Math.max(0, this.callDepth - 1);
    if (this.callDepth === 0) {
      this.activeOpId = 0;
    }
  }

  private setBlockInternal(
    x: number,
    y: number,
    z: number,
    block: string,
    state?: BlockState
  ): void {
    this.world.setVoxel(x, y, z, block, state, false, this.activeOpId);
  }

  public setBlock(
    x: number,
    y: number,
    z: number,
    block: string,
    state?: BlockState
  ): void {
    this.beginOperation("setBlock", [x, y, z, block, state]);
    try {
      this.setBlockInternal(x, y, z, block, state);
    } finally {
      this.endOperation();
    }
  }

  public fillBox(
    x1: number,
    y1: number,
    z1: number,
    x2: number,
    y2: number,
    z2: number,
    block: string,
    hollow = false,
    state?: BlockState
  ): void {
    this.beginOperation("fillBox", [
      x1,
      y1,
      z1,
      x2,
      y2,
      z2,
      block,
      hollow,
      state,
    ]);
    try {
      const minX = Math.min(Math.floor(x1), Math.floor(x2));
      const maxX = Math.max(Math.floor(x1), Math.floor(x2));
      const minY = Math.min(Math.floor(y1), Math.floor(y2));
      const maxY = Math.max(Math.floor(y1), Math.floor(y2));
      const minZ = Math.min(Math.floor(z1), Math.floor(z2));
      const maxZ = Math.max(Math.floor(z1), Math.floor(z2));

      for (let x = minX; x <= maxX; x++) {
        for (let y = minY; y <= maxY; y++) {
          for (let z = minZ; z <= maxZ; z++) {
            if (hollow) {
              const isBoundary =
                x === minX ||
                x === maxX ||
                y === minY ||
                y === maxY ||
                z === minZ ||
                z === maxZ;
              if (!isBoundary) continue;
            }
            this.setBlockInternal(x, y, z, block, state);
          }
        }
      }
    } finally {
      this.endOperation();
    }
  }

  public clearArea(
    x1: number,
    y1: number,
    z1: number,
    x2: number,
    y2: number,
    z2: number
  ): void {
    this.beginOperation("clearArea", [x1, y1, z1, x2, y2, z2]);
    try {
      const minX = Math.min(Math.floor(x1), Math.floor(x2));
      const maxX = Math.max(Math.floor(x1), Math.floor(x2));
      const minY = Math.min(Math.floor(y1), Math.floor(y2));
      const maxY = Math.max(Math.floor(y1), Math.floor(y2));
      const minZ = Math.min(Math.floor(z1), Math.floor(z2));
      const maxZ = Math.max(Math.floor(z1), Math.floor(z2));

      for (let x = minX; x <= maxX; x++) {
        for (let y = minY; y <= maxY; y++) {
          for (let z = minZ; z <= maxZ; z++) {
            this.setBlockInternal(x, y, z, "minecraft:air");
          }
        }
      }
    } finally {
      this.endOperation();
    }
  }

  /**
   * Places foundation blocks from topY straight down at each (x, z) in [x1..x2, z1..z2]
   * until hitting an original terrain block (isTerrain === true) or y === 0.
   */
  public placeFoundation(
    x1: number,
    z1: number,
    x2: number,
    z2: number,
    topY: number,
    block: string
  ): void {
    this.beginOperation("placeFoundation", [x1, z1, x2, z2, topY, block]);
    try {
      const minX = Math.min(Math.floor(x1), Math.floor(x2));
      const maxX = Math.max(Math.floor(x1), Math.floor(x2));
      const minZ = Math.min(Math.floor(z1), Math.floor(z2));
      const maxZ = Math.max(Math.floor(z1), Math.floor(z2));
      const startY = Math.floor(topY);

      for (let x = minX; x <= maxX; x++) {
        for (let z = minZ; z <= maxZ; z++) {
          for (let y = startY; y >= 0; y--) {
            const initTerrain = this.world.getInitialTerrainVoxel(x, y, z);
            const curVoxel = this.world.getVoxel(x, y, z);
            if (initTerrain || (curVoxel && curVoxel.isTerrain)) {
              break;
            }
            this.setBlockInternal(x, y, z, block);
          }
        }
      }
    } finally {
      this.endOperation();
    }
  }

  /**
   * Builds a wall of given height along the perimeter of [x1..x2, z1..z2] (or straight line if x1===x2 or z1===z2).
   * If followTerrain is true, each column starts at terrain surfaceY + 1 and goes up `height` blocks.
   * If followTerrain is false, starts at a uniform baseY (either provided or max surfaceY along footprint + 1).
   */
  public buildWall(
    x1: number,
    z1: number,
    x2: number,
    z2: number,
    height: number,
    block: string,
    followTerrain = false,
    baseY?: number
  ): void {
    this.beginOperation("buildWall", [
      x1,
      z1,
      x2,
      z2,
      height,
      block,
      followTerrain,
      baseY,
    ]);
    try {
      const minX = Math.min(Math.floor(x1), Math.floor(x2));
      const maxX = Math.max(Math.floor(x1), Math.floor(x2));
      const minZ = Math.min(Math.floor(z1), Math.floor(z2));
      const maxZ = Math.max(Math.floor(z1), Math.floor(z2));
      const h = Math.max(1, Math.floor(height));

      const footprint: Array<[number, number]> = [];
      for (let x = minX; x <= maxX; x++) {
        for (let z = minZ; z <= maxZ; z++) {
          if (x === minX || x === maxX || z === minZ || z === maxZ) {
            footprint.push([x, z]);
          }
        }
      }

      if (followTerrain) {
        for (const [x, z] of footprint) {
          const terrainY = this.world.getSurfaceY(x, z, true);
          const currentY = this.world.getSurfaceY(x, z, false);
          const colStartY =
            baseY !== undefined
              ? Math.floor(baseY)
              : Math.max(0, (terrainY >= 0 ? terrainY : currentY) + 1);
          for (let dy = 0; dy < h; dy++) {
            this.setBlockInternal(x, colStartY + dy, z, block);
          }
        }
      } else {
        let uniformStartY = baseY !== undefined ? Math.floor(baseY) : -1;
        if (uniformStartY < 0) {
          let maxSurf = -1;
          for (const [x, z] of footprint) {
            const surf = this.world.getSurfaceY(x, z, false);
            if (surf > maxSurf) maxSurf = surf;
          }
          uniformStartY = Math.max(0, maxSurf + 1);
        }

        for (const [x, z] of footprint) {
          for (let dy = 0; dy < h; dy++) {
            this.setBlockInternal(x, uniformStartY + dy, z, block);
          }
        }
      }
    } finally {
      this.endOperation();
    }
  }

  /**
   * Builds a pitched gable roof over [x1..x2, z1..z2] starting at startY.
   * Automatically fills gable ends and connects layers so no roof blocks float.
   */
  public buildPitchedRoof(
    x1: number,
    z1: number,
    x2: number,
    z2: number,
    startY: number,
    stairBlock: string,
    direction: "NS" | "EW" | "north_south" | "east_west" = "NS",
    gableBlock?: string
  ): void {
    this.beginOperation("buildPitchedRoof", [
      x1,
      z1,
      x2,
      z2,
      startY,
      stairBlock,
      direction,
      gableBlock,
    ]);
    try {
      const minX = Math.min(Math.floor(x1), Math.floor(x2));
      const maxX = Math.max(Math.floor(x1), Math.floor(x2));
      const minZ = Math.min(Math.floor(z1), Math.floor(z2));
      const maxZ = Math.max(Math.floor(z1), Math.floor(z2));
      const baseY = Math.floor(startY);
      const fillBlock = gableBlock ?? deriveGableBlock(stairBlock);

      const isNS = direction === "NS" || direction === "north_south";

      if (isNS) {
        // Ridge runs North-South (along Z); slopes step inward along X from West (minX) and East (maxX)
        let leftX = minX;
        let rightX = maxX;
        let layer = 0;

        while (leftX <= rightX) {
          const y = baseY + layer;

          // Fill gable ends at minZ and maxZ so every layer is grounded and closed
          for (let x = leftX; x <= rightX; x++) {
            this.setBlockInternal(x, y, minZ, fillBlock);
            this.setBlockInternal(x, y, maxZ, fillBlock);
          }

          if (leftX === rightX) {
            // Central ridge cap
            for (let z = minZ; z <= maxZ; z++) {
              this.setBlockInternal(leftX, y, z, fillBlock);
            }
          } else {
            for (let z = minZ; z <= maxZ; z++) {
              this.setBlockInternal(leftX, y, z, stairBlock, {
                facing: "east",
                half: "bottom",
              });
              this.setBlockInternal(rightX, y, z, stairBlock, {
                facing: "west",
                half: "bottom",
              });
            }
          }

          leftX++;
          rightX--;
          layer++;
        }
      } else {
        // Ridge runs East-West (along X); slopes step inward along Z from North (minZ) and South (maxZ)
        let northZ = minZ;
        let southZ = maxZ;
        let layer = 0;

        while (northZ <= southZ) {
          const y = baseY + layer;

          // Fill gable ends at minX and maxX so every layer is grounded and closed
          for (let z = northZ; z <= southZ; z++) {
            this.setBlockInternal(minX, y, z, fillBlock);
            this.setBlockInternal(maxX, y, z, fillBlock);
          }

          if (northZ === southZ) {
            // Central ridge cap
            for (let x = minX; x <= maxX; x++) {
              this.setBlockInternal(x, y, northZ, fillBlock);
            }
          } else {
            for (let x = minX; x <= maxX; x++) {
              this.setBlockInternal(x, y, northZ, stairBlock, {
                facing: "south",
                half: "bottom",
              });
              this.setBlockInternal(x, y, southZ, stairBlock, {
                facing: "north",
                half: "bottom",
              });
            }
          }

          northZ++;
          southZ--;
          layer++;
        }
      }
    } finally {
      this.endOperation();
    }
  }

  /**
   * Draws a 3D line of blocks from (x1, y1, z1) to (x2, y2, z2) using 3D Bresenham algorithm.
   */
  public line(
    x1: number,
    y1: number,
    z1: number,
    x2: number,
    y2: number,
    z2: number,
    block: string,
    state?: BlockState
  ): void {
    this.beginOperation("line", [x1, y1, z1, x2, y2, z2, block, state]);
    try {
      let ix1 = Math.floor(x1);
      let iy1 = Math.floor(y1);
      let iz1 = Math.floor(z1);
      const ix2 = Math.floor(x2);
      const iy2 = Math.floor(y2);
      const iz2 = Math.floor(z2);

      const dx = Math.abs(ix2 - ix1);
      const dy = Math.abs(iy2 - iy1);
      const dz = Math.abs(iz2 - iz1);
      const sx = ix1 < ix2 ? 1 : -1;
      const sy = iy1 < iy2 ? 1 : -1;
      const sz = iz1 < iz2 ? 1 : -1;

      const steps = Math.max(dx, dy, dz);
      if (steps === 0) {
        this.setBlockInternal(ix1, iy1, iz1, block, state);
        return;
      }

      for (let i = 0; i <= steps; i++) {
        const x = Math.round(ix1 + ((ix2 - ix1) * i) / steps);
        const y = Math.round(iy1 + ((iy2 - iy1) * i) / steps);
        const z = Math.round(iz1 + ((iz2 - iz1) * i) / steps);
        this.setBlockInternal(x, y, z, block, state);
      }
    } finally {
      this.endOperation();
    }
  }

  public getSurfaceY(x: number, z: number, terrainOnly = true): number {
    return this.world.getSurfaceY(x, z, terrainOnly);
  }

  public getDistanceToGround(x: number, y: number, z: number): number {
    return this.world.getDistanceToGround(x, y, z);
  }
}

export function executeBuildScript(
  world: VoxelWorld,
  jsCode: string,
  resetBeforeRun = true
): BuildExecutionResult {
  if (resetBeforeRun) {
    world.resetBuild();
  }

  const dsl = new BuilderDSL(world);

  // Bind all public DSL methods so both `dsl.fillBox(...)` and bare `fillBox(...)` work
  const scopeBindings: Record<string, unknown> = {
    dsl,
    world,
    Math,
    console,
    setBlock: dsl.setBlock.bind(dsl),
    fillBox: dsl.fillBox.bind(dsl),
    clearArea: dsl.clearArea.bind(dsl),
    placeFoundation: dsl.placeFoundation.bind(dsl),
    buildWall: dsl.buildWall.bind(dsl),
    buildPitchedRoof: dsl.buildPitchedRoof.bind(dsl),
    line: dsl.line.bind(dsl),
    getSurfaceY: dsl.getSurfaceY.bind(dsl),
    getDistanceToGround: dsl.getDistanceToGround.bind(dsl),
  };

  // Keep line 1 of jsCode on line 1 of the compiled script so line numbers match 1-to-1
  const wrappedCode = `(function(scope) { with (scope) { ${jsCode}\n} })`;
  const script = new vm.Script(wrappedCode, {
    filename: SCRIPT_FILENAME,
    lineOffset: 0,
  });

  const runner = script.runInThisContext() as (
    scope: Record<string, unknown>
  ) => void;
  runner(scopeBindings);

  const traces = world.getTracesObject();
  const evaluation = world.evaluateStructure();

  return {
    opCount: Object.keys(traces).length,
    traces,
    evaluation,
  };
}

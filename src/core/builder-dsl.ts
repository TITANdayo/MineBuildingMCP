import * as vm from "node:vm";
import {
  BlockState,
  CardinalDirection,
  InteriorRoom,
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

  /**
   * Detects all enclosed interior rooms in the current world.
   */
  public detectRooms(): InteriorRoom[] {
    return this.world.detectInteriorRooms().rooms;
  }

  /**
   * Returns a detected interior room by roomId (1-based), or the first room if omitted.
   */
  public getRoomById(roomId?: number): InteriorRoom | undefined {
    const rooms = this.detectRooms();
    if (rooms.length === 0) return undefined;
    if (roomId === undefined) return rooms[0];
    return rooms.find((r) => r.roomId === roomId);
  }

  /**
   * Places a 2-block tall door (half="lower" at y, half="upper" at y+1).
   */
  public placeDoor(
    x: number,
    y: number,
    z: number,
    doorBlock = "minecraft:oak_door",
    facing: "north" | "south" | "east" | "west" = "north"
  ): void {
    this.beginOperation("placeDoor", [x, y, z, doorBlock, facing]);
    try {
      const ix = Math.floor(x);
      const iy = Math.floor(y);
      const iz = Math.floor(z);
      this.setBlockInternal(ix, iy, iz, doorBlock, {
        facing,
        half: "lower",
      });
      this.setBlockInternal(ix, iy + 1, iz, doorBlock, {
        facing,
        half: "upper",
      });
    } finally {
      this.endOperation();
    }
  }

  /**
   * Places a light source (default "minecraft:lantern", with hanging="true" if hanging or if a solid block exists at y+1).
   */
  public placeLighting(
    x: number,
    y: number,
    z: number,
    lightBlock = "minecraft:lantern",
    hanging?: boolean
  ): void {
    this.beginOperation("placeLighting", [x, y, z, lightBlock, hanging]);
    try {
      const ix = Math.floor(x);
      const iy = Math.floor(y);
      const iz = Math.floor(z);
      const norm = normalizeBlockName(lightBlock);
      const hasCeilingAbove = Boolean(this.world.getVoxel(ix, iy + 1, iz));
      const isHanging = hanging !== undefined ? hanging : hasCeilingAbove;

      if (norm.includes("lantern")) {
        this.setBlockInternal(ix, iy, iz, norm, {
          hanging: isHanging ? "true" : "false",
        });
      } else {
        this.setBlockInternal(ix, iy, iz, norm);
      }
    } finally {
      this.endOperation();
    }
  }

  /**
   * Places a 2-block bed (part="foot" at (x,y,z) and part="head" offset by facing).
   */
  public placeBed(
    x: number,
    y: number,
    z: number,
    facing: "north" | "south" | "east" | "west" = "north",
    color = "red"
  ): void {
    this.beginOperation("placeBed", [x, y, z, facing, color]);
    try {
      const ix = Math.floor(x);
      const iy = Math.floor(y);
      const iz = Math.floor(z);

      const trimmedColor = color.trim().toLowerCase() || "red";
      let bedBlock =
        trimmedColor.endsWith("_bed") || trimmedColor.includes(":")
          ? normalizeBlockName(trimmedColor)
          : `minecraft:${trimmedColor}_bed`;
      if (bedBlock === "minecraft:" || bedBlock === "minecraft:_bed") {
        bedBlock = "minecraft:red_bed";
      }

      let dx = 0;
      let dz = -1;
      if (facing === "south") {
        dx = 0;
        dz = 1;
      } else if (facing === "east") {
        dx = 1;
        dz = 0;
      } else if (facing === "west") {
        dx = -1;
        dz = 0;
      }

      this.setBlockInternal(ix, iy, iz, bedBlock, {
        facing,
        part: "foot",
      });
      this.setBlockInternal(ix + dx, iy, iz + dz, bedBlock, {
        facing,
        part: "head",
      });
    } finally {
      this.endOperation();
    }
  }

  /**
   * Places a table (fence post at (x,y,z) with carpet/pressure_plate at (x,y+1,z), or a top-slab if fenceBlock is a slab).
   */
  public placeTable(
    x: number,
    y: number,
    z: number,
    fenceBlock = "minecraft:oak_fence",
    carpetOrSlabBlock = "minecraft:brown_carpet"
  ): void {
    this.beginOperation("placeTable", [
      x,
      y,
      z,
      fenceBlock,
      carpetOrSlabBlock,
    ]);
    try {
      const ix = Math.floor(x);
      const iy = Math.floor(y);
      const iz = Math.floor(z);
      const normBase = normalizeBlockName(fenceBlock);

      if (normBase.endsWith("_slab")) {
        this.setBlockInternal(ix, iy, iz, normBase, { type: "top" });
      } else {
        this.setBlockInternal(ix, iy, iz, normBase);
        if (carpetOrSlabBlock && !this.world.getVoxel(ix, iy + 1, iz)) {
          const normTop = normalizeBlockName(carpetOrSlabBlock);
          if (normTop.endsWith("_slab")) {
            this.setBlockInternal(ix, iy + 1, iz, normTop, { type: "bottom" });
          } else {
            this.setBlockInternal(ix, iy + 1, iz, normTop);
          }
        }
      }
    } finally {
      this.endOperation();
    }
  }

  /**
   * Places a stair block as a chair with facing and half="bottom".
   */
  public placeChair(
    x: number,
    y: number,
    z: number,
    stairBlock = "minecraft:oak_stairs",
    facing: "north" | "south" | "east" | "west" = "north"
  ): void {
    this.beginOperation("placeChair", [x, y, z, stairBlock, facing]);
    try {
      const ix = Math.floor(x);
      const iy = Math.floor(y);
      const iz = Math.floor(z);
      this.setBlockInternal(ix, iy, iz, stairBlock, {
        facing,
        half: "bottom",
      });
    } finally {
      this.endOperation();
    }
  }

  /**
   * Automatically furnishes a detected room with ceiling lighting, a central carpet/rug,
   * and style-appropriate furniture along inner walls while avoiding doorway clearances.
   */
  public furnishRoom(
    roomId?: number,
    style: "living" | "bedroom" | "study" | "workshop" | "dining" = "living"
  ): void {
    this.beginOperation("furnishRoom", [roomId, style]);
    try {
      const room = this.getRoomById(roomId);
      if (!room) return;

      const { floorY, center, floorPositions, innerWallPositions, doors } =
        room;
      const floorSet = new Set(floorPositions.map((fp) => `${fp.x},${fp.z}`));

      // Build doorway clearance exclusion set (avoid placing any obstructing block near doors)
      const doorClearanceSet = new Set<string>();
      for (const d of doors) {
        for (let dx = -2; dx <= 2; dx++) {
          for (let dz = -2; dz <= 2; dz++) {
            if (Math.abs(dx) + Math.abs(dz) <= 2) {
              doorClearanceSet.add(`${d.x + dx},${d.z + dz}`);
            }
          }
        }
      }

      // 1. Place ceiling lantern at room center (attached to ceiling block above if available)
      let lanternY = room.ceilingY;
      for (let cy = floorY + 1; cy <= room.bounds.maxY + 2; cy++) {
        if (this.world.getVoxel(center.x, cy, center.z)) {
          lanternY = cy - 1;
          break;
        }
      }
      if (lanternY > floorY && !this.world.getVoxel(center.x, lanternY, center.z)) {
        this.placeLighting(center.x, lanternY, center.z, "minecraft:lantern", true);
      } else if (!this.world.getVoxel(center.x, floorY, center.z)) {
        this.placeLighting(center.x, floorY, center.z, "minecraft:lantern", false);
      }

      // Track occupied (x, z) floor cells so furniture pieces don't overwrite each other
      const occupiedFloor = new Set<string>();
      const isCellFreeForFurniture = (x: number, z: number): boolean => {
        const key = `${x},${z}`;
        if (!floorSet.has(key)) return false;
        if (doorClearanceSet.has(key)) return false;
        if (occupiedFloor.has(key)) return false;
        const existing = this.world.getVoxel(x, floorY, z);
        if (existing && !existing.name.includes("carpet")) return false;
        return Boolean(this.world.getVoxel(x, floorY - 1, z));
      };

      const normalToFacing = (
        normal: CardinalDirection
      ): "north" | "south" | "east" | "west" => {
        switch (normal) {
          case "N":
            return "north";
          case "S":
            return "south";
          case "E":
            return "east";
          case "W":
            return "west";
        }
      };

      const normalToOffset = (normal: CardinalDirection): [number, number] => {
        switch (normal) {
          case "N":
            return [0, -1];
          case "S":
            return [0, 1];
          case "E":
            return [1, 0];
          case "W":
            return [-1, 0];
        }
      };

      // Deduplicate innerWallPositions by (x, z) keeping primary normal
      const wallSpots: Array<{
        x: number;
        z: number;
        normal: CardinalDirection;
      }> = [];
      const seenWallSpot = new Set<string>();
      for (const wp of innerWallPositions) {
        const k = `${wp.x},${wp.z}`;
        if (seenWallSpot.has(k) || doorClearanceSet.has(k)) continue;
        seenWallSpot.add(k);
        wallSpots.push({ x: wp.x, z: wp.z, normal: wp.normal });
      }

      // 2. Place style-appropriate furniture along walls
      if (style === "bedroom") {
        // Place bed along a wall where both foot and head are free
        let bedPlaced = false;
        for (const spot of wallSpots) {
          if (bedPlaced) break;
          const [ox, oz] = normalToOffset(spot.normal);
          // Foot at (spot.x + ox, spot.z + oz), head against wall at (spot.x, spot.z)
          const footX = spot.x + ox;
          const footZ = spot.z + oz;
          const headFacingMap: Record<
            CardinalDirection,
            "north" | "south" | "east" | "west"
          > = {
            S: "north",
            N: "south",
            E: "west",
            W: "east",
          };
          if (
            isCellFreeForFurniture(spot.x, spot.z) &&
            isCellFreeForFurniture(footX, footZ)
          ) {
            this.placeBed(
              footX,
              floorY,
              footZ,
              headFacingMap[spot.normal],
              "red"
            );
            occupiedFloor.add(`${spot.x},${spot.z}`);
            occupiedFloor.add(`${footX},${footZ}`);
            bedPlaced = true;
          }
        }

        // Place bookshelf and bedside table
        for (const spot of wallSpots) {
          if (isCellFreeForFurniture(spot.x, spot.z)) {
            this.setBlockInternal(
              spot.x,
              floorY,
              spot.z,
              "minecraft:bookshelf"
            );
            occupiedFloor.add(`${spot.x},${spot.z}`);
            break;
          }
        }
        for (const spot of wallSpots) {
          if (isCellFreeForFurniture(spot.x, spot.z)) {
            this.placeTable(
              spot.x,
              floorY,
              spot.z,
              "minecraft:oak_fence",
              "minecraft:white_carpet"
            );
            occupiedFloor.add(`${spot.x},${spot.z}`);
            break;
          }
        }
      } else if (style === "study") {
        let bookshelvesPlaced = 0;
        for (const spot of wallSpots) {
          if (bookshelvesPlaced >= 2) break;
          if (isCellFreeForFurniture(spot.x, spot.z)) {
            this.setBlockInternal(
              spot.x,
              floorY,
              spot.z,
              "minecraft:bookshelf"
            );
            occupiedFloor.add(`${spot.x},${spot.z}`);
            bookshelvesPlaced++;
          }
        }
        // Desk + chair
        for (const spot of wallSpots) {
          const [ox, oz] = normalToOffset(spot.normal);
          const chairX = spot.x + ox;
          const chairZ = spot.z + oz;
          if (
            isCellFreeForFurniture(spot.x, spot.z) &&
            isCellFreeForFurniture(chairX, chairZ)
          ) {
            this.placeTable(
              spot.x,
              floorY,
              spot.z,
              "minecraft:oak_fence",
              "minecraft:brown_carpet"
            );
            this.placeChair(
              chairX,
              floorY,
              chairZ,
              "minecraft:oak_stairs",
              normalToFacing(spot.normal)
            );
            occupiedFloor.add(`${spot.x},${spot.z}`);
            occupiedFloor.add(`${chairX},${chairZ}`);
            break;
          }
        }
      } else if (style === "workshop") {
        const workshopBlocks = [
          "minecraft:crafting_table",
          "minecraft:furnace",
          "minecraft:barrel",
        ];
        let bIdx = 0;
        for (const spot of wallSpots) {
          if (bIdx >= workshopBlocks.length) break;
          if (isCellFreeForFurniture(spot.x, spot.z)) {
            const blk = workshopBlocks[bIdx++];
            if (blk === "minecraft:furnace") {
              this.setBlockInternal(spot.x, floorY, spot.z, blk, {
                facing: normalToFacing(spot.normal),
              });
            } else {
              this.setBlockInternal(spot.x, floorY, spot.z, blk);
            }
            occupiedFloor.add(`${spot.x},${spot.z}`);
          }
        }
      } else if (style === "dining") {
        // Dining style: spruce dining table + chair(s) + pantry barrel/smoker
        let diningSetsPlaced = 0;
        for (const spot of wallSpots) {
          if (diningSetsPlaced >= 2) break;
          const [ox, oz] = normalToOffset(spot.normal);
          const chairX = spot.x + ox;
          const chairZ = spot.z + oz;
          if (
            isCellFreeForFurniture(spot.x, spot.z) &&
            isCellFreeForFurniture(chairX, chairZ)
          ) {
            this.placeTable(
              spot.x,
              floorY,
              spot.z,
              "minecraft:spruce_fence",
              "minecraft:white_carpet"
            );
            this.placeChair(
              chairX,
              floorY,
              chairZ,
              "minecraft:spruce_stairs",
              normalToFacing(spot.normal)
            );
            occupiedFloor.add(`${spot.x},${spot.z}`);
            occupiedFloor.add(`${chairX},${chairZ}`);
            diningSetsPlaced++;
          }
        }
        for (const spot of wallSpots) {
          if (isCellFreeForFurniture(spot.x, spot.z)) {
            this.setBlockInternal(
              spot.x,
              floorY,
              spot.z,
              "minecraft:barrel"
            );
            occupiedFloor.add(`${spot.x},${spot.z}`);
            break;
          }
        }
      } else {
        // Default "living" style: table + chair + bookshelf
        for (const spot of wallSpots) {
          const [ox, oz] = normalToOffset(spot.normal);
          const chairX = spot.x + ox;
          const chairZ = spot.z + oz;
          if (
            isCellFreeForFurniture(spot.x, spot.z) &&
            isCellFreeForFurniture(chairX, chairZ)
          ) {
            this.placeTable(
              spot.x,
              floorY,
              spot.z,
              "minecraft:oak_fence",
              "minecraft:brown_carpet"
            );
            this.placeChair(
              chairX,
              floorY,
              chairZ,
              "minecraft:oak_stairs",
              normalToFacing(spot.normal)
            );
            occupiedFloor.add(`${spot.x},${spot.z}`);
            occupiedFloor.add(`${chairX},${chairZ}`);
            break;
          }
        }
        for (const spot of wallSpots) {
          if (isCellFreeForFurniture(spot.x, spot.z)) {
            this.setBlockInternal(
              spot.x,
              floorY,
              spot.z,
              "minecraft:bookshelf"
            );
            occupiedFloor.add(`${spot.x},${spot.z}`);
            break;
          }
        }
      }

      // 3. Place central carpet if center floor cell is free
      const carpetColor =
        style === "study"
          ? "minecraft:green_carpet"
          : style === "workshop"
            ? "minecraft:gray_carpet"
            : style === "dining"
              ? "minecraft:yellow_carpet"
              : "minecraft:red_carpet";
      if (
        !occupiedFloor.has(`${center.x},${center.z}`) &&
        !this.world.getVoxel(center.x, floorY, center.z) &&
        this.world.getVoxel(center.x, floorY - 1, center.z)
      ) {
        this.setBlockInternal(center.x, floorY, center.z, carpetColor);
      }
    } finally {
      this.endOperation();
    }
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
    detectRooms: dsl.detectRooms.bind(dsl),
    getRoomById: dsl.getRoomById.bind(dsl),
    placeDoor: dsl.placeDoor.bind(dsl),
    placeLighting: dsl.placeLighting.bind(dsl),
    placeBed: dsl.placeBed.bind(dsl),
    placeTable: dsl.placeTable.bind(dsl),
    placeChair: dsl.placeChair.bind(dsl),
    furnishRoom: dsl.furnishRoom.bind(dsl),
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

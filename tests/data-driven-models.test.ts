import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it } from "vitest";
import {
  detectMinecraftJarPath,
  JarAssetLoader,
} from "../src/assets/jar-loader.js";
import {
  classifyBlockConnectionKind,
  evaluateMultipartCondition,
  resolveActiveModelParts,
  resolveEffectiveBlockState,
  resolveWorldBlockStates,
} from "../src/core/block-state-resolver.js";
import {
  parseMcstructureBuffer,
  parseStructureNbtBuffer,
  serializeMcstructureBuffer,
  serializeStructureNbtBuffer,
} from "../src/core/nbt-io.js";
import { VoxelWorld } from "../src/core/voxel-world.js";
import type { CompiledBlockDefinition, VoxelData } from "../src/types/shared.js";
import {
  applyBlockstateRotation,
  applyElementRotation,
  computeBoxLockedUv,
  getDefaultFaceUv,
  getUnrotatedFaceCorners,
} from "../src/viewer/voxel-mesh.js";

const detectedJar = detectMinecraftJarPath();
const realLoader = new JarAssetLoader(detectedJar ?? undefined);

function createSolidPngBuffer(r: number, g: number, b: number, a = 255): Buffer {
  const png = new PNG({ width: 16, height: 16 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = r;
    png.data[i + 1] = g;
    png.data[i + 2] = b;
    png.data[i + 3] = a;
  }
  return PNG.sync.write(png);
}

describe("Data-Driven Blockstate & Model Rendering + Neighbor-Aware Auto-Resolution", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("1. Multipart Condition Evaluation (OR / AND / pipe-separated / boolean)", () => {
    it("evaluates simple, pipe-separated, OR, AND, and nested multipart conditions accurately", () => {
      // Unconditional
      expect(evaluateMultipartCondition(undefined, {})).toBe(true);

      // Pipe-separated values (e.g. wall tall|low)
      expect(
        evaluateMultipartCondition({ north: "low|tall" }, { north: "low" })
      ).toBe(true);
      expect(
        evaluateMultipartCondition({ north: "low|tall" }, { north: "tall" })
      ).toBe(true);
      expect(
        evaluateMultipartCondition({ north: "low|tall" }, { north: "none" })
      ).toBe(false);

      // Boolean and string equivalence
      expect(
        evaluateMultipartCondition({ up: true }, { up: "true" })
      ).toBe(true);
      expect(
        evaluateMultipartCondition({ up: false }, { up: "false" })
      ).toBe(true);

      // OR condition (e.g. vine / glow_lichen / redstone / chiseled_bookshelf)
      const vineNorthCond = {
        OR: [
          { north: "true" },
          {
            east: "false",
            north: "false",
            south: "false",
            up: "false",
            west: "false",
          },
        ],
      };
      expect(
        evaluateMultipartCondition(vineNorthCond, {
          north: "true",
          south: "false",
          east: "false",
          west: "false",
          up: "false",
        })
      ).toBe(true);
      expect(
        evaluateMultipartCondition(vineNorthCond, {
          north: "false",
          south: "true",
          east: "false",
          west: "false",
          up: "false",
        })
      ).toBe(false);
      // All false triggers the fallback branch in OR
      expect(
        evaluateMultipartCondition(vineNorthCond, {
          north: "false",
          south: "false",
          east: "false",
          west: "false",
          up: "false",
        })
      ).toBe(true);

      // Nested AND + OR condition
      const nestedAndOr = {
        AND: [
          { slot_0_occupied: "true" },
          { OR: [{ facing: "north|south" }, { powered: "true" }] },
        ],
      };
      expect(
        evaluateMultipartCondition(nestedAndOr, {
          slot_0_occupied: "true",
          facing: "south",
          powered: "false",
        })
      ).toBe(true);
      expect(
        evaluateMultipartCondition(nestedAndOr, {
          slot_0_occupied: "true",
          facing: "east",
          powered: "false",
        })
      ).toBe(false);
      expect(
        evaluateMultipartCondition(nestedAndOr, {
          slot_0_occupied: "false",
          facing: "north",
          powered: "true",
        })
      ).toBe(false);
    });

    it("resolves vine multipart parts from JAR without turning into a 5-sided box or adding bogus up=true", () => {
      if (!detectedJar) return;

      const blockModels = realLoader.getBlockModelsForBlocks([
        "vine",
        "stone_bricks",
      ]);
      const vineDef = blockModels["vine"];
      expect(vineDef.multipart).toBeDefined();
      expect(classifyBlockConnectionKind(vineDef)).toBe("multiface_clinging");

      // Case A: Vine at (5, 5, 5) with a solid stone_bricks wall to the NORTH (5, 5, 4)
      const voxelsSingleWall: VoxelData[] = [
        { x: 5, y: 5, z: 4, name: "minecraft:stone_bricks", isTerrain: false, opId: 1 },
        { x: 5, y: 5, z: 5, name: "minecraft:vine", isTerrain: false, opId: 2 },
      ];
      const voxelMapA = new Map(voxelsSingleWall.map((v) => [`${v.x},${v.y},${v.z}`, v]));
      const resolvedA = resolveWorldBlockStates(voxelsSingleWall, blockModels);
      const stateA = resolvedA.get("5,5,5")!;
      expect(stateA).toEqual({
        north: "true",
        south: "false",
        east: "false",
        west: "false",
        up: "false",
      });

      const partsA = resolveActiveModelParts(
        voxelsSingleWall[1],
        vineDef,
        voxelMapA,
        blockModels,
        resolvedA
      );
      // Only 1 face (north: y undefined/0, x undefined/0) should be active!
      expect(partsA).toHaveLength(1);
      expect(partsA[0]).toEqual({ model: "vine" });

      // Case B: Vine in a corner with stone_bricks to NORTH (5,5,4) and EAST (6,5,5)
      const voxelsCorner: VoxelData[] = [
        { x: 5, y: 5, z: 4, name: "minecraft:stone_bricks", isTerrain: false, opId: 1 },
        { x: 6, y: 5, z: 5, name: "minecraft:stone_bricks", isTerrain: false, opId: 1 },
        { x: 5, y: 5, z: 5, name: "minecraft:vine", isTerrain: false, opId: 2 },
      ];
      const voxelMapB = new Map(voxelsCorner.map((v) => [`${v.x},${v.y},${v.z}`, v]));
      const resolvedB = resolveWorldBlockStates(voxelsCorner, blockModels);
      const partsB = resolveActiveModelParts(
        voxelsCorner[2],
        vineDef,
        voxelMapB,
        blockModels,
        resolvedB
      );
      expect(partsB).toHaveLength(2);
      expect(partsB).toEqual([
        { model: "vine" },
        { model: "vine", y: 90, uvlock: true },
      ]);

      // Case C: Explicit user state { south: "true" } without neighbors -> only south face (y: 180), up is false
      const explicitVine: VoxelData = {
        x: 0,
        y: 0,
        z: 0,
        name: "minecraft:vine",
        state: { south: "true" },
        isTerrain: false,
        opId: 1,
      };
      const mapC = new Map([[`0,0,0`, explicitVine]]);
      const partsC = resolveActiveModelParts(explicitVine, vineDef, mapC, blockModels);
      expect(partsC).toEqual([{ model: "vine", y: 180, uvlock: true }]);
    });

    it("resolves spruce_fence multipart parts (center post + connected directional arms)", () => {
      if (!detectedJar) return;
      const blockModels = realLoader.getBlockModelsForBlocks([
        "spruce_fence",
        "stone",
      ]);
      const fenceDef = blockModels["spruce_fence"];

      const voxels: VoxelData[] = [
        { x: 10, y: 4, z: 10, name: "minecraft:spruce_fence", isTerrain: false, opId: 1 },
        { x: 10, y: 4, z: 9, name: "minecraft:spruce_fence", isTerrain: false, opId: 2 }, // north
        { x: 11, y: 4, z: 10, name: "minecraft:stone", isTerrain: false, opId: 3 }, // east
      ];
      const voxelMap = new Map(voxels.map((v) => [`${v.x},${v.y},${v.z}`, v]));
      const resolved = resolveWorldBlockStates(voxels, blockModels);
      const parts = resolveActiveModelParts(
        voxels[0],
        fenceDef,
        voxelMap,
        blockModels,
        resolved
      );
      // 1 post + north side + east side = 3 parts
      expect(parts).toEqual([
        { model: "spruce_fence_post" },
        { model: "spruce_fence_side", uvlock: true },
        { model: "spruce_fence_side", y: 90, uvlock: true },
      ]);
    });
  });

  describe("2. Model Parent Inheritance, Elements Rotation, Blockstate Rotation, and UVLock", () => {
    it("resolves multi-level parent chains, texture variable indirection, and element rotations from real JAR", () => {
      if (!detectedJar) return;

      // 1) spruce_fence -> fence_post / fence_side parent inheritance
      const fenceDef = realLoader.compileBlockDefinition("spruce_fence");
      const postElements = fenceDef.models["spruce_fence_post"];
      expect(postElements).toBeDefined();
      expect(postElements).toHaveLength(1);
      expect(postElements[0].from).toEqual([6, 0, 6]);
      expect(postElements[0].to).toEqual([10, 16, 10]);
      expect(postElements[0].faces.north?.textureKey).toBe("spruce_planks");

      // 2) lantern -> template_lantern (multiple elements + rotated cross chain at 45 degrees with shade=false)
      const lanternDef = realLoader.compileBlockDefinition("lantern");
      const lanternEls = lanternDef.models["lantern"];
      expect(lanternEls).toBeDefined();
      expect(lanternEls.length).toBeGreaterThanOrEqual(3);
      const rotatedCross = lanternEls.find((el) => el.rotation !== undefined);
      expect(rotatedCross).toBeDefined();
      expect(rotatedCross?.shade).toBe(false);
      expect(rotatedCross?.faces.north?.textureKey).toBe("lantern");

      // 3) iron_chain -> template_chain (45-degree rotated cross planes)
      const chainDef = realLoader.compileBlockDefinition("iron_chain");
      const chainEls = chainDef.models["iron_chain"];
      expect(chainEls).toBeDefined();
      expect(chainEls.length).toBe(2);
      expect(chainEls[0].rotation?.origin).toEqual([8, 8, 8]);
      expect(chainEls[0].shade).toBe(false);

      // 4) vine -> flat plane from [0, 0, 0.8] to [16, 16, 0.8] with tintindex: 0 (#tinted) and shade: false
      const vineDef = realLoader.compileBlockDefinition("vine");
      const vineEls = vineDef.models["vine"];
      expect(vineEls).toHaveLength(1);
      expect(vineEls[0].from).toEqual([0, 0, 0.8]);
      expect(vineEls[0].to).toEqual([16, 16, 0.8]);
      expect(vineEls[0].shade).toBe(false);
      expect(vineEls[0].faces.north?.tintindex).toBe(0);
      expect(vineEls[0].faces.north?.textureKey).toBe("vine#tinted");

      // 5) spruce_stairs -> stairs (2 elements), inner_stairs (3 elements), outer_stairs (2 elements)
      const stairsDef = realLoader.compileBlockDefinition("spruce_stairs");
      expect(stairsDef.models["spruce_stairs"]).toHaveLength(2);
      expect(stairsDef.models["spruce_stairs_inner"]).toHaveLength(3);
      expect(stairsDef.models["spruce_stairs_outer"]).toHaveLength(2);
    });

    it("resolves multi-level parent chains, child texture overrides, and both modern/legacy tag prefixes from a synthetic JAR", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mb-parent-tag-test-"));
      tempDirs.push(tmpDir);
      const jarPath = path.join(tmpDir, "synthetic.jar");

      const zip = new AdmZip();
      zip.addFile(
        "assets/minecraft/textures/block/custom_tex.png",
        createSolidPngBuffer(200, 120, 60, 255)
      );

      // Grandparent model defines elements with #primary -> #base_tex
      zip.addFile(
        "assets/minecraft/models/block/grandparent_post.json",
        Buffer.from(
          JSON.stringify({
            textures: {
              particle: "#primary",
            },
            elements: [
              {
                from: [6, 0, 6],
                to: [10, 16, 10],
                rotation: {
                  origin: [8, 8, 8],
                  axis: "y",
                  angle: 45,
                  rescale: true,
                },
                shade: false,
                faces: {
                  north: { uv: [6, 0, 10, 16], texture: "#primary", cullface: "north" },
                  south: { uv: [6, 0, 10, 16], texture: "#primary", cullface: "south" },
                },
              },
            ],
          })
        )
      );

      // Parent model aliases #primary -> #wood
      zip.addFile(
        "assets/minecraft/models/block/parent_post.json",
        Buffer.from(
          JSON.stringify({
            parent: "minecraft:block/grandparent_post",
            textures: {
              primary: "#wood",
            },
          })
        )
      );

      // Child model sets wood -> minecraft:block/custom_tex
      zip.addFile(
        "assets/minecraft/models/block/child_post.json",
        Buffer.from(
          JSON.stringify({
            parent: "minecraft:block/parent_post",
            textures: {
              wood: "minecraft:block/custom_tex",
            },
          })
        )
      );

      zip.addFile(
        "assets/minecraft/blockstates/child_post.json",
        Buffer.from(
          JSON.stringify({
            variants: {
              "": { model: "minecraft:block/child_post", y: 90, uvlock: true },
            },
          })
        )
      );

      // Tags with recursive #tag reference across modern (tags/block/) and legacy (tags/blocks/)
      zip.addFile(
        "data/minecraft/tags/block/wooden_fences.json",
        Buffer.from(JSON.stringify({ values: ["minecraft:child_post"] }))
      );
      zip.addFile(
        "data/minecraft/tags/blocks/fences.json",
        Buffer.from(
          JSON.stringify({
            values: ["#minecraft:wooden_fences", "minecraft:nether_brick_fence"],
          })
        )
      );

      zip.writeZip(jarPath);

      const loader = new JarAssetLoader(jarPath);
      const def = loader.compileBlockDefinition("minecraft:child_post");
      expect(def.tags).toEqual(["fences", "wooden_fences"]);
      expect(loader.getBlockTagMembers("fences")).toEqual([
        "child_post",
        "nether_brick_fence",
      ]);

      const el = def.models["child_post"][0];
      expect(el.from).toEqual([6, 0, 6]);
      expect(el.to).toEqual([10, 16, 10]);
      expect(el.shade).toBe(false);
      expect(el.rotation).toEqual({
        origin: [8, 8, 8],
        axis: "y",
        angle: 45,
        rescale: true,
      });
      expect(el.faces.north?.textureKey).toBe("custom_tex");
      expect(el.faces.north?.uv).toEqual([6, 0, 10, 16]);
    });

    it("computes element rotation (legacy axis/angle + 26.x Euler x/y/z + rescale), blockstate x/y rotation, and uvlock math accurately", () => {
      // 1) Element rotation around [8,8,8] by 45 deg on Y with rescale=true
      // A point at [10, 8, 8] (dx=2, dz=0) rotated by 45 deg around Y with rescale (1/cos(45) = sqrt(2)):
      // nx = 2 * cos(45) * sqrt(2) = 2, nz = -2 * sin(45) * sqrt(2) = -2 -> [10, 8, 6]
      const legacyRotPt = applyElementRotation(
        [10, 8, 8],
        { origin: [8, 8, 8], axis: "y", angle: 45, rescale: true },
        false
      );
      expect(legacyRotPt[0]).toBeCloseTo(10, 5);
      expect(legacyRotPt[1]).toBeCloseTo(8, 5);
      expect(legacyRotPt[2]).toBeCloseTo(6, 5);

      // 2) MC 26.x style rotation { origin: [8,8,8], y: 45, rescale: true } produces the exact same coordinates
      const modernRotPt = applyElementRotation(
        [10, 8, 8],
        { origin: [8, 8, 8], y: 45, rescale: true },
        false
      );
      expect(modernRotPt[0]).toBeCloseTo(legacyRotPt[0], 5);
      expect(modernRotPt[1]).toBeCloseTo(legacyRotPt[1], 5);
      expect(modernRotPt[2]).toBeCloseTo(legacyRotPt[2], 5);

      // Normal rotation ignores rescale and stays unit length
      const rotNormal = applyElementRotation(
        [1, 0, 0],
        { origin: [8, 8, 8], y: 45, rescale: true },
        true
      );
      expect(Math.hypot(rotNormal[0], rotNormal[1], rotNormal[2])).toBeCloseTo(1, 5);
      expect(rotNormal[0]).toBeCloseTo(Math.SQRT1_2, 5);
      expect(rotNormal[2]).toBeCloseTo(-Math.SQRT1_2, 5);

      // 3) Blockstate rotation: vine north plane z=0.8 rotated by y=90 (1 step) -> east wall x = 16 - 0.8 = 15.2
      const { corners, normal } = getUnrotatedFaceCorners(
        "south",
        [0, 0, 0.8],
        [16, 16, 0.8]
      );
      const eastCorner0 = applyBlockstateRotation(corners[0], 0, 1, true);
      expect(eastCorner0[0]).toBeCloseTo(15.2, 5);
      const eastNormal = applyBlockstateRotation(normal, 0, 1, false);
      expect(eastNormal).toEqual([-1, 0, 0]);

      // 4) Default face UVs and UVLock box projection
      expect(getDefaultFaceUv("north", [6, 0, 0], [10, 16, 6])).toEqual([
        6, 0, 10, 16,
      ]);
      expect(computeBoxLockedUv("up", 0.25, 1.0, 0.75)).toEqual([0.25, 0.25]);
      expect(computeBoxLockedUv("east", 1.0, 0.5, 0.25)).toEqual([0.75, 0.5]);
    });
  });

  describe("3. Data-Driven Neighbor-Aware BlockState Auto-Resolution", () => {
    it("loads block tags dynamically from the local Minecraft JAR", () => {
      if (!detectedJar) return;

      expect(realLoader.getBlockTags("spruce_fence")).toContain("fences");
      expect(realLoader.getBlockTags("spruce_fence")).toContain("wooden_fences");
      expect(realLoader.getBlockTags("nether_brick_fence")).toContain("fences");
      expect(realLoader.getBlockTags("nether_brick_fence")).not.toContain("wooden_fences");
      expect(realLoader.getBlockTags("cobblestone_wall")).toContain("walls");
      expect(realLoader.getBlockTags("spruce_stairs")).toContain("stairs");
      expect(realLoader.getBlockTags("spruce_fence_gate")).toContain("fence_gates");
      expect(realLoader.getBlockTags("oak_leaves")).toContain("leaves");
      expect(realLoader.getBlockTags("torch")).toContain("wall_post_override");
    });

    it("resolves fence connections accurately (connects to solid cubes, wooden fences, perpendicular fence gates; ignores nether_brick_fence, leaves, panes, bars, and parallel gates)", () => {
      if (!detectedJar) return;

      const blockModels = realLoader.getBlockModelsForBlocks([
        "spruce_fence",
        "oak_fence",
        "nether_brick_fence",
        "stone_bricks",
        "oak_leaves",
        "glass_pane",
        "iron_bars",
        "spruce_fence_gate",
      ]);

      // Center spruce_fence at (5,5,5) surrounded by:
      // - North (5,5,4): oak_fence (wooden fence -> connects!)
      // - South (5,5,6): nether_brick_fence (non-wooden fence -> does NOT connect!)
      // - East  (6,5,5): stone_bricks (full opaque cube -> connects!)
      // - West  (4,5,5): oak_leaves (#leaves -> does NOT connect!)
      const voxels1: VoxelData[] = [
        { x: 5, y: 5, z: 5, name: "minecraft:spruce_fence", isTerrain: false, opId: 1 },
        { x: 5, y: 5, z: 4, name: "minecraft:oak_fence", isTerrain: false, opId: 2 },
        { x: 5, y: 5, z: 6, name: "minecraft:nether_brick_fence", isTerrain: false, opId: 3 },
        { x: 6, y: 5, z: 5, name: "minecraft:stone_bricks", isTerrain: false, opId: 4 },
        { x: 4, y: 5, z: 5, name: "minecraft:oak_leaves", isTerrain: false, opId: 5 },
      ];
      const states1 = resolveWorldBlockStates(voxels1, blockModels);
      expect(states1.get("5,5,5")).toEqual({
        north: "true",
        south: "false",
        east: "true",
        west: "false",
      });

      // Center spruce_fence at (5,5,5) surrounded by:
      // - East (6,5,5): spruce_fence_gate facing=north (perpendicular to east-west line -> connects!)
      // - West (4,5,5): spruce_fence_gate facing=east (parallel to east-west line -> does NOT connect!)
      // - North (5,5,4): glass_pane (does NOT connect to fence)
      // - South (5,5,6): iron_bars (does NOT connect to fence)
      const voxels2: VoxelData[] = [
        { x: 5, y: 5, z: 5, name: "minecraft:spruce_fence", isTerrain: false, opId: 1 },
        {
          x: 6,
          y: 5,
          z: 5,
          name: "minecraft:spruce_fence_gate",
          state: { facing: "north" },
          isTerrain: false,
          opId: 2,
        },
        {
          x: 4,
          y: 5,
          z: 5,
          name: "minecraft:spruce_fence_gate",
          state: { facing: "east" },
          isTerrain: false,
          opId: 3,
        },
        { x: 5, y: 5, z: 4, name: "minecraft:glass_pane", isTerrain: false, opId: 4 },
        { x: 5, y: 5, z: 6, name: "minecraft:iron_bars", isTerrain: false, opId: 5 },
      ];
      const states2 = resolveWorldBlockStates(voxels2, blockModels);
      expect(states2.get("5,5,5")).toEqual({
        north: "false",
        south: "false",
        east: "true",
        west: "false",
      });
    });

    it("resolves wall connections, low/tall height under solid cover, straight-line post suppression (up=false), and #wall_post_override (torch above -> up=true)", () => {
      if (!detectedJar) return;

      const blockModels = realLoader.getBlockModelsForBlocks([
        "cobblestone_wall",
        "stone_bricks",
        "iron_bars",
        "oak_leaves",
        "torch",
        "spruce_fence_gate",
      ]);

      // 1) Straight N-S wall at (5,5,5) between (5,5,4) and (5,5,6) with nothing above -> up="false", north="low", south="low"
      const straightWalls: VoxelData[] = [
        { x: 5, y: 5, z: 4, name: "minecraft:cobblestone_wall", isTerrain: false, opId: 1 },
        { x: 5, y: 5, z: 5, name: "minecraft:cobblestone_wall", isTerrain: false, opId: 2 },
        { x: 5, y: 5, z: 6, name: "minecraft:cobblestone_wall", isTerrain: false, opId: 3 },
      ];
      const resStraight = resolveWorldBlockStates(straightWalls, blockModels);
      expect(resStraight.get("5,5,5")).toEqual({
        north: "low",
        south: "low",
        east: "none",
        west: "none",
        up: "false",
      });

      // 2) Place a torch (#wall_post_override) at (5,6,5) above the middle wall -> forces up="true"!
      const straightWithTorch: VoxelData[] = [
        ...straightWalls,
        { x: 5, y: 6, z: 5, name: "minecraft:torch", isTerrain: false, opId: 4 },
      ];
      const resTorch = resolveWorldBlockStates(straightWithTorch, blockModels);
      expect(resTorch.get("5,5,5")?.up).toBe("true");

      // 3) Place a full solid block (stone_bricks) at (5,6,5) above the middle wall -> arms raise to "tall"!
      const straightWithSolidAbove: VoxelData[] = [
        ...straightWalls,
        { x: 5, y: 6, z: 5, name: "minecraft:stone_bricks", isTerrain: false, opId: 4 },
      ];
      const resTall = resolveWorldBlockStates(straightWithSolidAbove, blockModels);
      expect(resTall.get("5,5,5")).toEqual({
        north: "tall",
        south: "tall",
        east: "none",
        west: "none",
        up: "false",
      });

      // 4) Wall connects to iron_bars and perpendicular fence_gate (which gets in_wall="true"), but NOT to oak_leaves
      const mixedNeighbors: VoxelData[] = [
        { x: 5, y: 5, z: 5, name: "minecraft:cobblestone_wall", isTerrain: false, opId: 1 },
        { x: 5, y: 5, z: 4, name: "minecraft:iron_bars", isTerrain: false, opId: 2 }, // north
        { x: 5, y: 5, z: 6, name: "minecraft:oak_leaves", isTerrain: false, opId: 3 }, // south (#leaves ignored)
        {
          x: 6,
          y: 5,
          z: 5,
          name: "minecraft:spruce_fence_gate",
          state: { facing: "north" },
          isTerrain: false,
          opId: 4,
        }, // east (perpendicular gate)
      ];
      const resMixed = resolveWorldBlockStates(mixedNeighbors, blockModels);
      expect(resMixed.get("5,5,5")).toEqual({
        north: "low",
        south: "none",
        east: "low",
        west: "none",
        up: "true",
      });
      // And the fence gate automatically resolves in_wall="true" because it adjoins a wall!
      expect(resMixed.get("6,5,5")?.in_wall).toBe("true");
    });

    it("resolves stair corner shapes (straight, outer_left, outer_right, inner_left, inner_right) and does not confuse rails with stairs", () => {
      if (!detectedJar) return;

      const blockModels = realLoader.getBlockModelsForBlocks([
        "spruce_stairs",
        "oak_stairs",
        "rail",
      ]);

      // Verify rail is NOT classified as stairs despite having a `shape` property
      expect(classifyBlockConnectionKind(blockModels["rail"])).toBe("none");
      expect(classifyBlockConnectionKind(blockModels["spruce_stairs"])).toBe("stairs");

      // Outer left corner: stair at (5,5,5) facing=north, front neighbor at (5,5,4) facing=west
      const outerLeftVoxels: VoxelData[] = [
        {
          x: 5,
          y: 5,
          z: 5,
          name: "minecraft:spruce_stairs",
          state: { facing: "north", half: "bottom" },
          isTerrain: false,
          opId: 1,
        },
        {
          x: 5,
          y: 5,
          z: 4,
          name: "minecraft:oak_stairs",
          state: { facing: "west", half: "bottom" },
          isTerrain: false,
          opId: 2,
        },
      ];
      expect(
        resolveWorldBlockStates(outerLeftVoxels, blockModels).get("5,5,5")?.shape
      ).toBe("outer_left");

      // Outer right corner: stair at (5,5,5) facing=north, front neighbor at (5,5,4) facing=east
      const outerRightVoxels: VoxelData[] = [
        outerLeftVoxels[0],
        {
          x: 5,
          y: 5,
          z: 4,
          name: "minecraft:oak_stairs",
          state: { facing: "east", half: "bottom" },
          isTerrain: false,
          opId: 2,
        },
      ];
      expect(
        resolveWorldBlockStates(outerRightVoxels, blockModels).get("5,5,5")?.shape
      ).toBe("outer_right");

      // Inner left corner: stair at (5,5,5) facing=north, back neighbor at (5,5,6) facing=west
      const innerLeftVoxels: VoxelData[] = [
        outerLeftVoxels[0],
        {
          x: 5,
          y: 5,
          z: 6,
          name: "minecraft:oak_stairs",
          state: { facing: "west", half: "bottom" },
          isTerrain: false,
          opId: 2,
        },
      ];
      expect(
        resolveWorldBlockStates(innerLeftVoxels, blockModels).get("5,5,5")?.shape
      ).toBe("inner_left");

      // Inner right corner: stair at (5,5,5) facing=north, back neighbor at (5,5,6) facing=east
      const innerRightVoxels: VoxelData[] = [
        outerLeftVoxels[0],
        {
          x: 5,
          y: 5,
          z: 6,
          name: "minecraft:oak_stairs",
          state: { facing: "east", half: "bottom" },
          isTerrain: false,
          opId: 2,
        },
      ];
      expect(
        resolveWorldBlockStates(innerRightVoxels, blockModels).get("5,5,5")?.shape
      ).toBe("inner_right");

      // Mismatched half (top vs bottom) does NOT bend the stair
      const mismatchedHalfVoxels: VoxelData[] = [
        outerLeftVoxels[0],
        {
          x: 5,
          y: 5,
          z: 4,
          name: "minecraft:oak_stairs",
          state: { facing: "west", half: "top" },
          isTerrain: false,
          opId: 2,
        },
      ];
      expect(
        resolveWorldBlockStates(mismatchedHalfVoxels, blockModels).get("5,5,5")?.shape
      ).toBe("straight");
    });

    it("propagates multi-block hanging vines top-to-bottom via Y-descending sweep and re-resolves incremental world edits while preserving explicit states", () => {
      if (!detectedJar) return;

      const blockModels = realLoader.getBlockModelsForBlocks([
        "vine",
        "glow_lichen",
        "stone_bricks",
        "spruce_fence",
      ]);

      // Build a 3-block tall hanging vine at X=5, Z=5, Y=10..8 where ONLY the top vine at Y=10
      // has an adjacent solid block at (5, 10, 4) (north).
      // Even if inserted into VoxelWorld in bottom-up order (Y=8, Y=9, Y=10),
      // Y-descending resolution propagates north="true" from Y=10 -> Y=9 -> Y=8!
      const world = new VoxelWorld([16, 16, 16]);
      world.setVoxel(5, 10, 4, "minecraft:stone_bricks");
      world.setVoxel(5, 8, 5, "minecraft:vine"); // bottom
      world.setVoxel(5, 9, 5, "minecraft:vine"); // middle
      world.setVoxel(5, 10, 5, "minecraft:vine"); // top (attached to stone_bricks at z=4)

      world.resolveBlockStates(blockModels);

      for (const y of [10, 9, 8]) {
        expect(world.getVoxel(5, y, 5)?.state).toEqual({
          north: "true",
          south: "false",
          east: "false",
          west: "false",
          up: "false",
        });
      }

      // Also verify standalone resolveEffectiveBlockState on the bottom hanging vine (Y=8)
      // without a pre-populated resolvedStates map still walks upward and finds north="true"
      const rawMap = new Map(
        world.getAllVoxels().map((v) => [`${v.x},${v.y},${v.z}`, { ...v, state: undefined }])
      );
      const standaloneBottom = resolveEffectiveBlockState(
        rawMap.get("5,8,5")!,
        blockModels["vine"],
        rawMap,
        blockModels
      );
      expect(standaloneBottom.north).toBe("true");
      expect(standaloneBottom.up).toBe("false");

      // Verify incremental build re-resolution:
      // Place a single spruce_fence at (2, 4, 2) -> initially all 4 directions are "false".
      // Then place another spruce_fence at (3, 4, 2) (east) -> re-resolving updates (2, 4, 2).east to "true"!
      world.setVoxel(2, 4, 2, "minecraft:spruce_fence");
      world.resolveBlockStates(blockModels);
      expect(world.getVoxel(2, 4, 2)?.state).toEqual({
        north: "false",
        south: "false",
        east: "false",
        west: "false",
      });

      world.setVoxel(3, 4, 2, "minecraft:spruce_fence");
      world.resolveBlockStates(blockModels);
      expect(world.getVoxel(2, 4, 2)?.state?.east).toBe("true");
      expect(world.getVoxel(3, 4, 2)?.state?.west).toBe("true");

      // And if a fence has an explicit override (e.g. north: "true"), re-resolution preserves the explicit key
      world.setVoxel(2, 4, 2, "minecraft:spruce_fence", { north: "true" });
      world.resolveBlockStates(blockModels);
      expect(world.getVoxel(2, 4, 2)?.state).toEqual({
        north: "true",
        south: "false",
        east: "true",
        west: "false",
      });
    });

    it("serializes resolved neighbor-aware states into Java .nbt and Bedrock .mcstructure exports", async () => {
      if (!detectedJar) return;

      const world = new VoxelWorld([8, 8, 8]);
      // Two connected fences
      world.setVoxel(1, 1, 1, "minecraft:spruce_fence");
      world.setVoxel(2, 1, 1, "minecraft:spruce_fence");
      // Corner stairs
      world.setVoxel(4, 1, 4, "minecraft:spruce_stairs", {
        facing: "north",
        half: "bottom",
      });
      world.setVoxel(4, 1, 3, "minecraft:spruce_stairs", {
        facing: "west",
        half: "bottom",
      });
      // Vine against stone_bricks
      world.setVoxel(6, 2, 1, "minecraft:stone_bricks");
      world.setVoxel(6, 2, 2, "minecraft:vine");

      // 1) Java Edition .nbt round-trip preserves auto-resolved fence arms, stair shape, and vine face
      const javaBuf = await serializeStructureNbtBuffer(world);
      const parsedJava = await parseStructureNbtBuffer(javaBuf);

      expect(parsedJava.getVoxel(1, 1, 1)?.state).toEqual({
        north: "false",
        south: "false",
        east: "true",
        west: "false",
      });
      expect(parsedJava.getVoxel(4, 1, 4)?.state).toEqual({
        facing: "north",
        half: "bottom",
        shape: "outer_left",
      });
      expect(parsedJava.getVoxel(6, 2, 2)?.state).toEqual({
        north: "true",
        south: "false",
        east: "false",
        west: "false",
        up: "false",
      });

      // 2) Bedrock Edition .mcstructure round-trip preserves stair facing & half without leaking invalid Java-only `shape`
      const bedrockBuf = await serializeMcstructureBuffer(world);
      const parsedBedrock = await parseMcstructureBuffer(bedrockBuf);
      expect(parsedBedrock.getVoxel(4, 1, 4)?.state).toEqual({
        facing: "north",
        half: "bottom",
      });
    });
  });
});

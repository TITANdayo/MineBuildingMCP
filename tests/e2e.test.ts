import path from "node:path";
import fs from "node:fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { loadStructureNbt, saveStructureNbt } from "../src/core/nbt-io.js";
import { executeBuildScript } from "../src/core/builder-dsl.js";
import { JarAssetLoader } from "../src/assets/jar-loader.js";
import { WsBridge } from "../src/mcp/ws-bridge.js";
import { PNG } from "pngjs";

describe("MineBuildingMCP End-to-End Verification", () => {
  const sampleNbtPath = path.resolve(process.cwd(), "samples/sloped_river_terrain.nbt");
  const exportedNbtPath = path.resolve(process.cwd(), "samples/test_exported_windmill.nbt");
  let wsBridge: WsBridge;

  beforeAll(async () => {
    wsBridge = new WsBridge();
    await wsBridge.start();
  }, 30000);

  afterAll(async () => {
    if (wsBridge) {
      await wsBridge.stop();
    }
  });

  it("1. Loads sloped river terrain NBT and summarizes heightmap & slopes", async () => {
    expect(fs.existsSync(sampleNbtPath)).toBe(true);
    const world = await loadStructureNbt(sampleNbtPath);
    const summary = world.getTerrainSummary();

    expect(summary.size).toEqual([32, 32, 32]);
    expect(summary.minY).toBeGreaterThanOrEqual(1);
    expect(summary.maxY).toBeGreaterThan(summary.minY);
    expect(summary.heightmap.length).toBe(32);
    expect(summary.heightmap[0].length).toBe(32);
    expect(summary.textSummary).toContain("32");
  });

  it("2. Executes BuilderDSL script with exact 1-indexed line number stack traces & detects floating blocks", async () => {
    const world = await loadStructureNbt(sampleNbtPath);

    // Note exact line numbers in this script string:
    // Line 1: comment
    // Line 2: placeFoundation
    // Line 3: buildWall
    // Line 4: buildPitchedRoof
    // Line 5: intentional floating block at (15, 28, 15)
    const script = [
      "// Line 1: Build a cottage on the slope",
      'placeFoundation(12, 12, 18, 18, 14, "stone_bricks");',
      'buildWall(12, 12, 18, 18, 4, "oak_planks", false);',
      'buildPitchedRoof(11, 11, 19, 19, 19, "oak_stairs", "NS");',
      'setBlock(15, 28, 15, "gold_block");'
    ].join("\n");

    const execResult = executeBuildScript(world, script, true);
    expect(Object.keys(execResult.traces).length).toBe(4);

    // Verify exact line numbers!
    expect(execResult.traces[1]).toMatchObject({
      opId: 1,
      line: 2
    });
    expect(execResult.traces[1].codeSnippet).toContain("placeFoundation");

    expect(execResult.traces[2]).toMatchObject({
      opId: 2,
      line: 3
    });
    expect(execResult.traces[2].codeSnippet).toContain("buildWall");

    expect(execResult.traces[3]).toMatchObject({
      opId: 3,
      line: 4
    });
    expect(execResult.traces[3].codeSnippet).toContain("buildPitchedRoof");

    expect(execResult.traces[4]).toMatchObject({
      opId: 4,
      line: 5
    });
    expect(execResult.traces[4].codeSnippet).toContain("setBlock");

    // Static evaluation should detect the floating gold_block at (15, 28, 15) from line 5
    const evaluation = world.evaluateStructure();
    expect(evaluation.valid).toBe(false);
    expect(evaluation.floatingBlocks.some((b) => b.x === 15 && b.y === 28 && b.z === 15 && b.opId === 4)).toBe(true);
    expect(evaluation.warnings.some((w) => w.toLowerCase().includes("line 5"))).toBe(true);
  });

  it("3. Generates deterministic fallback textures via JarAssetLoader", () => {
    const loader = new JarAssetLoader();
    const textures = loader.getTexturesForBlocks([
      "minecraft:grass_block",
      "minecraft:stone_bricks",
      "minecraft:oak_planks",
      "minecraft:oak_stairs",
      "minecraft:water"
    ]);
    for (const [name, dataUrl] of Object.entries(textures)) {
      expect(dataUrl.startsWith("data:image/png;base64,")).toBe(true);
      const buf = Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ""), "base64");
      const png = PNG.sync.read(buf);
      expect(png.width).toBeGreaterThanOrEqual(16);
      expect(png.height).toBeGreaterThanOrEqual(16);
    }
  });

  it("4. Syncs world to headless Three.js WebGL viewer, renders 4 views, and reverse-looks up (u,v) pixel to 3D coord & line number", async () => {
    const world = await loadStructureNbt(sampleNbtPath);
    const script = [
      "// Line 1: Build cottage and a distinct marker block on top",
      'placeFoundation(12, 12, 18, 18, 14, "stone_bricks");',
      'buildWall(12, 12, 18, 18, 4, "oak_planks", false);',
      'buildPitchedRoof(11, 11, 19, 19, 19, "oak_stairs", "NS");',
      'fillBox(14, 24, 14, 16, 26, 16, "gold_block", false);'
    ].join("\n");

    executeBuildScript(world, script, true);

    const loader = new JarAssetLoader();
    const voxels = world.getAllVoxels();
    const uniqueBlocks = Array.from(new Set(voxels.map((v) => v.name)));
    const textures = loader.getTexturesForBlocks(uniqueBlocks);

    const tracesRecord: Record<number, any> = {};
    for (const [opId, trace] of world.traces.entries()) {
      tracesRecord[opId] = trace;
    }

    await wsBridge.syncWorld({
      voxels,
      size: world.size,
      traces: tracesRecord,
      textures
    });

    const resolution = 256;
    const images = await wsBridge.renderViews(resolution);

    for (const dir of ["NE", "SE", "SW", "NW"] as const) {
      expect(typeof images[dir]).toBe("string");
      const rawBase64 = images[dir].replace(/^data:image\/png;base64,/, "");
      const png = PNG.sync.read(Buffer.from(rawBase64, "base64"));
      expect(png.width).toBe(resolution);
      expect(png.height).toBe(resolution);
    }

    // Scan a grid of pixels near the center of NE view to find one that hits our AI-built structure (opId > 0)
    let foundBuildHit: any = null;
    for (let v = 40; v < 210 && !foundBuildHit; v += 8) {
      for (let u = 60; u < 200 && !foundBuildHit; u += 8) {
        const res = await wsBridge.inspectPixel("NE", u, v);
        if (res.hit && res.coord && !res.isTerrain && res.trace) {
          foundBuildHit = { u, v, res };
        }
      }
    }

    expect(foundBuildHit).not.toBeNull();
    expect(foundBuildHit.res.hit).toBe(true);
    expect(foundBuildHit.res.trace.line).toBeGreaterThanOrEqual(2);
    expect(foundBuildHit.res.trace.line).toBeLessThanOrEqual(5);

    // Export structure to NBT and reload to verify roundtrip
    await saveStructureNbt(world, exportedNbtPath);
    expect(fs.existsSync(exportedNbtPath)).toBe(true);
    const reloaded = await loadStructureNbt(exportedNbtPath);
    expect(reloaded.getVoxel(15, 25, 15)?.name).toBe("minecraft:gold_block");
  }, 45000);

  it("5. Full MCP Server tool flow: load_terrain -> run_build_script -> inspect_pixel (verifying Y-axis flip & line trace) -> export_structure", async () => {
    const { MineBuildingMcpServer } = await import("../src/mcp/server.js");
    // Reuse a dedicated MineBuildingMcpServer instance on an ephemeral WS port
    const mcpServer = new MineBuildingMcpServer({ wsPort: 0, vitePort: 0 });
    await mcpServer.wsBridge.start();

    try {
      // 1. load_terrain
      const loadRes = await mcpServer.handleLoadTerrain({ nbtPath: sampleNbtPath });
      expect(loadRes.isError).toBeFalsy();
      const loadText = (loadRes.content[0] as { type: "text"; text: string }).text;
      expect(loadText).toContain("32x32x32");

      // 2. run_build_script with distinct blocks at lower Y (line 3) and upper Y (line 6)
      // so we can strictly verify Y-axis inversion (top-left v vs bottom-left WebGL framebuffer)
      const jsCode = [
        "// Line 1: Test script with lower foundation and high beacon",
        "// Line 2: Place foundation in center",
        'placeFoundation(14, 14, 17, 17, 15, "stone_bricks");',
        "// Line 4: Build walls",
        'buildWall(14, 14, 17, 17, 4, "oak_planks", false);',
        'fillBox(15, 26, 15, 16, 28, 16, "diamond_block", false);'
      ].join("\n");

      const buildRes = await mcpServer.handleRunBuildScript({
        jsCode,
        resolution: 256,
        resetBeforeRun: true
      });
      expect(buildRes.isError).toBeFalsy();
      // 1 report text + 4 * (label text + image) = 9 items
      expect(buildRes.content.length).toBe(9);

      // 3. Scan vertical center column in NE view from top (small v) to bottom (large v)
      // Because image origin (0,0) is TOP-LEFT and WebGL origin is BOTTOM-LEFT:
      // The high diamond_block (Y=26..28, Line 6) MUST appear at a SMALLER `v` (higher on screen)
      // than the lower oak_planks / stone_bricks (Y<=19, Line 3 or Line 5)!
      let diamondHitV: number | null = null;
      let lowerStructureHitV: number | null = null;

      for (let v = 20; v < 236; v += 4) {
        for (let u = 112; u <= 144; u += 4) {
          const inspectRes = await mcpServer.handleInspectPixel({
            view: "NE",
            u,
            v
          });
          const parsed = JSON.parse(
            (inspectRes.content[0] as { type: "text"; text: string }).text
          );
          if (parsed.hit && !parsed.isTerrain && parsed.trace) {
            if (parsed.block === "minecraft:diamond_block" && diamondHitV === null) {
              diamondHitV = v;
              expect(parsed.trace.line).toBe(6);
              expect(parsed.trace.codeSnippet).toContain("fillBox");
              expect(parsed.coord.y).toBeGreaterThanOrEqual(26);
            } else if (
              (parsed.block === "minecraft:oak_planks" ||
                parsed.block === "minecraft:stone_bricks") &&
              lowerStructureHitV === null
            ) {
              lowerStructureHitV = v;
              expect([3, 5]).toContain(parsed.trace.line);
            }
          }
        }
      }

      expect(diamondHitV).not.toBeNull();
      expect(lowerStructureHitV).not.toBeNull();
      // High Y (diamond_block) is near the top of the image -> smaller v coordinate than lower structure!
      expect(diamondHitV!).toBeLessThan(lowerStructureHitV!);

      // 4. export_structure
      const outPath = path.resolve(process.cwd(), "samples/mcp_tool_exported.nbt");
      const exportRes = await mcpServer.handleExportStructure({ outputPath: outPath });
      expect(exportRes.isError).toBeFalsy();
      expect(fs.existsSync(outPath)).toBe(true);

      // 5. Interior Room Detection, Interior DSL, Dollhouse Cutaway & Eye-Level Renders + Cutaway Picker
      const interiorScript = [
        "// Line 1: Build an enclosed cottage with interior furniture and a blocked door test",
        'placeFoundation(10, 10, 20, 20, 14, "stone_bricks");',
        'buildWall(10, 10, 20, 20, 5, "oak_planks", false);',
        'buildPitchedRoof(9, 9, 21, 21, 20, "oak_stairs", "NS");',
        'placeDoor(15, 15, 10, "oak_door", "south");',
        'placeLighting(15, 18, 15, "lantern", true);',
        'placeBed(12, 15, 17, "north", "red");',
        'placeTable(15, 15, 15, "oak_fence", "oak_pressure_plate");',
        'placeChair(16, 15, 15, "oak_stairs", "west");',
        'setBlock(15, 15, 11, "bookshelf");' // Line 10: intentionally blocks the inner side of the door at (15,15,10)!
      ].join("\n");

      const intBuildRes = await mcpServer.handleRunBuildScript({
        jsCode: interiorScript,
        resolution: 256,
        resetBeforeRun: true
      });
      expect(intBuildRes.isError).toBeFalsy();

      // Call inspect_interior with cutY=17 (slicing off the roof and upper walls)
      const interiorRes = await mcpServer.handleInspectInterior({
        cutY: 17,
        resolution: 256
      });
      expect(interiorRes.isError).toBeFalsy();

      const interiorSummaryText = (interiorRes.content[0] as { type: "text"; text: string }).text;
      expect(interiorSummaryText).toContain("door_blocked");
      expect(interiorSummaryText).toContain("Line 10");

      // Should include: 1 report text + 4*(cutaway label + cutaway PNG) + 4*(room #1 eye-level label + PNG) = 17 items
      expect(interiorRes.content.length).toBeGreaterThanOrEqual(17);

      // Verify that after inspect_interior(cutY=17), inspect_pixel on NE view can directly pick
      // interior blocks (at Y <= 17, inside x=11..19, z=11..19) that were previously hidden under the roof!
      let pickedInteriorBlock: any = null;
      for (let v = 60; v <= 200 && !pickedInteriorBlock; v += 6) {
        for (let u = 60; u <= 200 && !pickedInteriorBlock; u += 6) {
          const pickRes = await mcpServer.handleInspectPixel({ view: "NE", u, v });
          const parsed = JSON.parse((pickRes.content[0] as { type: "text"; text: string }).text);
          if (
            parsed.hit &&
            parsed.coord &&
            parsed.coord.x >= 11 &&
            parsed.coord.x <= 19 &&
            parsed.coord.z >= 11 &&
            parsed.coord.z <= 19 &&
            parsed.coord.y >= 15 &&
            parsed.coord.y <= 17 &&
            !parsed.isTerrain
          ) {
            pickedInteriorBlock = parsed;
          }
        }
      }
      expect(pickedInteriorBlock).not.toBeNull();
      expect(pickedInteriorBlock.trace).toBeDefined();
      expect(pickedInteriorBlock.trace.line).toBeGreaterThanOrEqual(6);
      expect(pickedInteriorBlock.trace.line).toBeLessThanOrEqual(10);

      // 6. Export and reload as Bedrock Edition .mcstructure via MCP tools
      const mcstructurePath = path.resolve(process.cwd(), "samples/test_exported_cottage.mcstructure");
      const exportBedrockRes = await mcpServer.handleExportStructure({ outputPath: mcstructurePath });
      expect(exportBedrockRes.isError).toBeFalsy();
      expect(fs.existsSync(mcstructurePath)).toBe(true);

      const reloadBedrockRes = await mcpServer.handleLoadTerrain({ nbtPath: mcstructurePath });
      expect(reloadBedrockRes.isError).toBeFalsy();
      if (fs.existsSync(mcstructurePath)) {
        fs.unlinkSync(mcstructurePath);
      }
    } finally {
      await mcpServer.close();
    }
  }, 60000);

  it("6. Bidirectional Java <-> Bedrock block state translation & .mcstructure binary format verification", async () => {
    const { javaToBedrockState, bedrockToJavaState } = await import("../src/core/state-translator.js");
    const { serializeMcstructureBuffer, parseMcstructureBuffer } = await import("../src/core/nbt-io.js");
    const { VoxelWorld } = await import("../src/core/voxel-world.js");

    // 1. Verify Stairs state mapping (facing + half <-> weirdo_direction + upside_down_bit)
    const bedrockStair = javaToBedrockState("minecraft:oak_stairs", {
      facing: "north",
      half: "top"
    });
    expect(bedrockStair.name).toBe("minecraft:oak_stairs");
    expect(bedrockStair.states.weirdo_direction).toEqual({ type: "int", value: 3 });
    expect(bedrockStair.states.upside_down_bit).toEqual({ type: "byte", value: 1 });

    const roundtripStair = bedrockToJavaState(bedrockStair.name, bedrockStair.states);
    expect(roundtripStair).toEqual({
      name: "minecraft:oak_stairs",
      state: { facing: "north", half: "top" }
    });

    // 2. Verify Slab state mapping (half <-> minecraft:vertical_half)
    const bedrockSlab = javaToBedrockState("minecraft:stone_brick_slab", { half: "top" });
    expect(bedrockSlab.states["minecraft:vertical_half"]).toEqual({
      type: "string",
      value: "top"
    });
    const roundtripSlab = bedrockToJavaState(bedrockSlab.name, bedrockSlab.states);
    expect(roundtripSlab.state?.half).toBe("top");

    // 3. Verify full VoxelWorld -> .mcstructure Buffer -> VoxelWorld roundtrip with ZYX indexing
    const world = new VoxelWorld([8, 8, 8]);
    world.setVoxel(1, 2, 3, "minecraft:oak_stairs", { facing: "west", half: "bottom" }, false, 1);
    world.setVoxel(4, 5, 6, "minecraft:stone_brick_slab", { half: "top" }, false, 2);
    world.setVoxel(2, 1, 5, "minecraft:lantern", { hanging: "true" }, false, 3);

    const buf = await serializeMcstructureBuffer(world);
    // Uncompressed Little-Endian NBT starts with tag type 0x0a (Compound), NOT gzip 0x1f 0x8b
    expect(buf[0]).toBe(0x0a);

    const parsedWorld = await parseMcstructureBuffer(buf);
    expect(parsedWorld.size).toEqual([8, 8, 8]);
    expect(parsedWorld.getVoxel(1, 2, 3)).toMatchObject({
      name: "minecraft:oak_stairs",
      state: { facing: "west", half: "bottom" }
    });
    expect(parsedWorld.getVoxel(4, 5, 6)).toMatchObject({
      name: "minecraft:stone_brick_slab",
      state: { half: "top" }
    });
    expect(parsedWorld.getVoxel(2, 1, 5)).toMatchObject({
      name: "minecraft:lantern",
      state: { hanging: "true" }
    });
  });

  it("7. Detects light_gray_concrete / light_blue_stained_glass rooms accurately and preserves 2-wide headroom=2 corridors", async () => {
    const { VoxelWorld, isLightBlockName } = await import("../src/core/voxel-world.js");

    expect(isLightBlockName("minecraft:light_gray_concrete")).toBe(false);
    expect(isLightBlockName("minecraft:light_blue_stained_glass")).toBe(false);
    expect(isLightBlockName("minecraft:light_weighted_pressure_plate")).toBe(false);
    expect(isLightBlockName("minecraft:daylight_detector")).toBe(false);
    expect(isLightBlockName("minecraft:light")).toBe(true);
    expect(isLightBlockName("minecraft:lantern")).toBe(true);

    // Enclosed room built from light_gray_concrete + light_blue_stained_glass (no door, no light)
    const concreteWorld = new VoxelWorld([20, 16, 20]);
    for (let x = 4; x <= 10; x++) {
      for (let z = 4; z <= 10; z++) {
        concreteWorld.setVoxel(x, 4, z, "minecraft:light_gray_concrete", undefined, false, 1);
        concreteWorld.setVoxel(x, 8, z, "minecraft:light_gray_concrete", undefined, false, 1);
        if (x === 4 || x === 10 || z === 4 || z === 10) {
          for (let y = 5; y <= 7; y++) {
            const isWindow = y === 6 && (x === 7 || z === 7);
            concreteWorld.setVoxel(
              x,
              y,
              z,
              isWindow ? "minecraft:light_blue_stained_glass" : "minecraft:light_gray_concrete",
              undefined,
              false,
              2
            );
          }
        }
      }
    }

    const concreteReport = concreteWorld.detectInteriorRooms();
    expect(concreteReport.rooms.length).toBe(1);
    expect(concreteReport.rooms[0].lightingCount).toBe(0);
    expect(concreteReport.flowIssues.some((i) => i.type === "unlit_room")).toBe(true);
    expect(concreteReport.flowIssues.some((i) => i.type === "isolated_room")).toBe(true);
    expect(concreteReport.validFlow).toBe(false);

    // 2-wide corridor with headroom === 2 (air y=5..6, ceiling y=7)
    const corridorWorld = new VoxelWorld([24, 16, 24]);
    for (let x = 10; x <= 13; x++) {
      for (let z = 10; z <= 17; z++) {
        corridorWorld.setVoxel(x, 4, z, "minecraft:stone_bricks", undefined, false, 1);
        corridorWorld.setVoxel(x, 7, z, "minecraft:stone_bricks", undefined, false, 1);
        if (x === 10 || x === 13 || z === 10 || z === 17) {
          for (let y = 5; y <= 6; y++) {
            if (x === 11 && z === 10) {
              corridorWorld.setVoxel(
                x,
                y,
                z,
                "minecraft:oak_door",
                { facing: "south", half: y === 5 ? "lower" : "upper" },
                false,
                2
              );
            } else {
              corridorWorld.setVoxel(x, y, z, "minecraft:stone_bricks", undefined, false, 1);
            }
          }
        }
      }
    }

    const corridorReport = corridorWorld.detectInteriorRooms();
    expect(corridorReport.rooms.length).toBe(1);
    expect(corridorReport.rooms[0].volume).toBe(24);
    expect(corridorReport.rooms[0].floorY).toBe(5);
    expect(corridorReport.rooms[0].ceilingY).toBe(6);
    expect(corridorReport.rooms[0].doors.some((d) => d.block.includes("oak_door"))).toBe(true);
    expect(corridorReport.rooms[0].doors.some((d) => d.block.includes("doorway_opening"))).toBe(false);
  });

  it("8. Translates double slabs, beds, and trapdoors accurately in state-translator & .mcstructure roundtrip", async () => {
    const { javaToBedrockState, bedrockToJavaState } = await import("../src/core/state-translator.js");
    const { serializeMcstructureBuffer, parseMcstructureBuffer } = await import("../src/core/nbt-io.js");
    const { VoxelWorld } = await import("../src/core/voxel-world.js");

    // Double slabs must emit *_double_slab without invalid vertical_half="double"
    const doubleSlabBedrock = javaToBedrockState("minecraft:stone_brick_slab", { type: "double" });
    expect(doubleSlabBedrock.name).toBe("minecraft:stone_brick_double_slab");
    expect(doubleSlabBedrock.states["minecraft:vertical_half"]).toBeUndefined();

    const doubleSlabFromHalf = javaToBedrockState("minecraft:oak_slab", { half: "double" });
    expect(doubleSlabFromHalf.name).toBe("minecraft:oak_double_slab");
    expect(doubleSlabFromHalf.states["minecraft:vertical_half"]).toBeUndefined();

    expect(bedrockToJavaState(doubleSlabBedrock.name, doubleSlabBedrock.states)).toEqual({
      name: "minecraft:stone_brick_slab",
      state: { type: "double" }
    });

    // Beds (facing + part <-> direction + head_piece_bit)
    const bedBedrock = javaToBedrockState("minecraft:red_bed", {
      facing: "north",
      part: "head"
    });
    expect(bedBedrock.name).toBe("minecraft:red_bed");
    expect(bedBedrock.states.direction).toEqual({ type: "int", value: 2 });
    expect(bedBedrock.states.head_piece_bit).toEqual({ type: "byte", value: 1 });
    expect(bedrockToJavaState(bedBedrock.name, bedBedrock.states)).toEqual({
      name: "minecraft:red_bed",
      state: { facing: "north", part: "head" }
    });
    expect(javaToBedrockState("minecraft:bedrock", { infiniburn_bit: "false" }).name).toBe("minecraft:bedrock");

    // Trapdoors (facing + half + open <-> direction + upside_down_bit + open_bit)
    const trapdoorBedrock = javaToBedrockState("minecraft:oak_trapdoor", {
      facing: "east",
      half: "top",
      open: "true"
    });
    expect(trapdoorBedrock.states.direction).toEqual({ type: "int", value: 0 });
    expect(trapdoorBedrock.states.upside_down_bit).toEqual({ type: "byte", value: 1 });
    expect(trapdoorBedrock.states.open_bit).toEqual({ type: "byte", value: 1 });
    expect(bedrockToJavaState(trapdoorBedrock.name, trapdoorBedrock.states)).toEqual({
      name: "minecraft:oak_trapdoor",
      state: { facing: "east", half: "top", open: "true" }
    });

    // Full .mcstructure binary roundtrip
    const world = new VoxelWorld([8, 8, 8]);
    world.setVoxel(1, 1, 1, "minecraft:stone_brick_slab", { type: "double" }, false, 1);
    world.setVoxel(2, 1, 2, "minecraft:red_bed", { facing: "east", part: "foot" }, false, 2);
    world.setVoxel(3, 2, 3, "minecraft:oak_trapdoor", { facing: "south", half: "top", open: "true" }, false, 3);

    const buf = await serializeMcstructureBuffer(world);
    const parsed = await parseMcstructureBuffer(buf);
    expect(parsed.getVoxel(1, 1, 1)).toMatchObject({
      name: "minecraft:stone_brick_slab",
      state: { type: "double" }
    });
    expect(parsed.getVoxel(2, 1, 2)).toMatchObject({
      name: "minecraft:red_bed",
      state: { facing: "east", part: "foot" }
    });
    expect(parsed.getVoxel(3, 2, 3)).toMatchObject({
      name: "minecraft:oak_trapdoor",
      state: { facing: "south", half: "top", open: "true" }
    });
  });

  it("9. Clears JarAssetLoader texture cache on init(), filters cutaway props cleanly, and renders cutaway with blockModels", async () => {
    const AdmZip = (await import("adm-zip")).default;
    const { filterVoxelsForCutaway } = await import("../src/viewer/voxel-mesh.js");
    const { VoxelWorld } = await import("../src/core/voxel-world.js");

    // 1. Verify JarAssetLoader.init() clears textureAssetCache
    const tmpDir = path.resolve(process.cwd(), `samples/.tmp_jar_test_${process.pid}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    const makeMinimalJar = (jarFile: string, rgb: [number, number, number]) => {
      const png = new PNG({ width: 16, height: 16 });
      for (let i = 0; i < png.data.length; i += 4) {
        png.data[i] = rgb[0];
        png.data[i + 1] = rgb[1];
        png.data[i + 2] = rgb[2];
        png.data[i + 3] = 255;
      }
      const zip = new AdmZip();
      zip.addFile("assets/minecraft/textures/block/stone.png", PNG.sync.write(png));
      zip.addFile(
        "assets/minecraft/blockstates/stone.json",
        Buffer.from(JSON.stringify({ variants: { "": { model: "minecraft:block/stone" } } }))
      );
      zip.addFile(
        "assets/minecraft/models/block/stone.json",
        Buffer.from(
          JSON.stringify({
            parent: "minecraft:block/cube_all",
            textures: { all: "minecraft:block/stone" }
          })
        )
      );
      zip.writeZip(jarFile);
    };

    try {
      const jar1 = path.join(tmpDir, "pack1.jar");
      const jar2 = path.join(tmpDir, "pack2.jar");
      makeMinimalJar(jar1, [220, 30, 30]);
      makeMinimalJar(jar2, [30, 60, 230]);

      const loader = new JarAssetLoader(jar1);
      const tex1 = loader.getTexturesForBlocks(["minecraft:stone"]);
      const png1 = PNG.sync.read(
        Buffer.from(tex1["stone"].replace(/^data:image\/png;base64,/, ""), "base64")
      );
      expect([png1.data[0], png1.data[1], png1.data[2]]).toEqual([220, 30, 30]);

      loader.init(jar2);
      const tex2 = loader.getTexturesForBlocks(["minecraft:stone"]);
      const png2 = PNG.sync.read(
        Buffer.from(tex2["stone"].replace(/^data:image\/png;base64,/, ""), "base64")
      );
      expect([png2.data[0], png2.data[1], png2.data[2]]).toEqual([30, 60, 230]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // 2. Verify filterVoxelsForCutaway ignores exterior fence/lantern props when peeling outer walls
    const world = new VoxelWorld([24, 16, 24]);
    for (let x = 10; x <= 16; x++) {
      for (let z = 10; z <= 16; z++) {
        world.setVoxel(x, 4, z, "minecraft:stone_bricks", undefined, false, 1);
        world.setVoxel(x, 8, z, "minecraft:stone_bricks", undefined, false, 1);
        if (x === 10 || x === 16 || z === 10 || z === 16) {
          for (let y = 5; y <= 7; y++) {
            world.setVoxel(x, y, z, "minecraft:oak_planks", undefined, false, 2);
          }
        }
      }
    }
    world.setVoxel(13, 5, 13, "minecraft:custom_half_bench", undefined, false, 3);
    world.setVoxel(20, 5, 13, "minecraft:oak_fence", undefined, false, 4);
    world.setVoxel(20, 6, 13, "minecraft:lantern", undefined, false, 4);

    const cutNE = filterVoxelsForCutaway(world.getAllVoxels(), 6, "NE");
    expect(cutNE.some((v) => v.y > 6)).toBe(false);
    expect(cutNE.some((v) => !v.isTerrain && v.y > 4 && (v.x === 16 || v.z === 10))).toBe(false);
    expect(cutNE.some((v) => v.x === 10 && v.y === 5 && v.z === 13)).toBe(true);
    expect(cutNE.some((v) => v.x === 13 && v.y === 5 && v.z === 13)).toBe(true);

    // 3. Verify buildWorldMeshes with explicit blockModels during syncWorld + renderInterior cutaway
    const customBenchDef = {
      blockName: "custom_half_bench",
      variants: { "": [{ model: "custom_half_bench" }] },
      models: {
        custom_half_bench: [
          {
            from: [0, 0, 0] as [number, number, number],
            to: [16, 8, 16] as [number, number, number],
            faces: {
              down: { textureKey: "oak_planks", cullface: "down" as const },
              up: { textureKey: "oak_planks" },
              north: { textureKey: "oak_planks", cullface: "north" as const },
              south: { textureKey: "oak_planks", cullface: "south" as const },
              west: { textureKey: "oak_planks", cullface: "west" as const },
              east: { textureKey: "oak_planks", cullface: "east" as const }
            }
          }
        ]
      },
      isFullOpaqueCube: false,
      isFluid: false,
      isTranslucent: false
    };

    const loader = new JarAssetLoader();
    const voxels = world.getAllVoxels();
    const uniqueNames = Array.from(new Set(voxels.map((v) => v.name)));
    const blockModels = {
      ...loader.getBlockModelsForBlocks(uniqueNames),
      custom_half_bench: customBenchDef
    };
    const textures = loader.getTexturesForBlocks([...uniqueNames, "minecraft:oak_planks"]);

    await wsBridge.syncWorld({
      voxels,
      size: world.size,
      traces: {
        1: { opId: 1, line: 1, codeSnippet: "floor()" },
        2: { opId: 2, line: 2, codeSnippet: "walls()" },
        3: { opId: 3, line: 3, codeSnippet: "bench()" },
        4: { opId: 4, line: 4, codeSnippet: "fence()" }
      },
      textures,
      blockModels
    });

    const interiorRender = await wsBridge.renderInterior(
      6,
      [{ roomId: 1, eyePosition: { x: 13.5, y: 6.6, z: 13.5 } }],
      128
    );
    expect(interiorRender.cutY).toBe(6);
    const pngCut = PNG.sync.read(
      Buffer.from(interiorRender.cutawayImages.NE.replace(/^data:image\/png;base64,/, ""), "base64")
    );
    expect(pngCut.width).toBe(128);
    expect(pngCut.height).toBe(128);
  }, 45000);
});

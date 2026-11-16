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

  it("10. Validates .mcstructure & VoxelWorld bounds, double-slab/DSL edge cases, and native Node ESM nbt-io", async () => {
    const { spawnSync } = await import("node:child_process");
    const nbtNs = await import("prismarine-nbt");
    const nbt = (nbtNs as unknown as { default?: typeof nbtNs }).default ?? nbtNs;
    const { parseMcstructureBuffer } = await import("../src/core/nbt-io.js");
    const { VoxelWorld } = await import("../src/core/voxel-world.js");
    const { javaToBedrockState } = await import("../src/core/state-translator.js");

    // 1. VoxelWorld constructor rejects non-finite / non-positive dimensions
    expect(() => new VoxelWorld(["bad" as unknown as number, 4, 4])).toThrow();
    expect(() => new VoxelWorld([NaN, 4, 4])).toThrow();
    expect(() => new VoxelWorld([0, 4, 4])).toThrow();

    // 2. parseMcstructureBuffer rejects unrelated NBT compounds & non-numeric size
    const unrelatedBuf = nbt.writeUncompressed(
      nbt.comp({ hello: nbt.string("world") }, "") as any,
      "little"
    );
    await expect(parseMcstructureBuffer(unrelatedBuf)).rejects.toThrow(/Invalid \.mcstructure/);

    const badSizeBuf = nbt.writeUncompressed(
      nbt.comp(
        {
          format_version: nbt.int(1),
          size: nbt.list(nbt.string(["bad", "4", "4"])),
          structure: nbt.comp({
            block_indices: nbt.list(nbt.int([0])),
            palette: nbt.comp({}),
          }),
        },
        ""
      ) as any,
      "little"
    );
    await expect(parseMcstructureBuffer(badSizeBuf)).rejects.toThrow(/Invalid \.mcstructure/);

    // 3. Double slab with both type="double" and half="bottom" must not attach vertical_half
    const doubleSlab = javaToBedrockState("minecraft:oak_slab", {
      type: "double",
      half: "bottom",
    });
    expect(doubleSlab.name).toBe("minecraft:oak_double_slab");
    expect(doubleSlab.states["minecraft:vertical_half"]).toBeUndefined();

    // 4. DSL placeBed empty color fallback & furnishRoom("dining")
    const roomWorld = new VoxelWorld([16, 12, 16]);
    const script = [
      'fillBox(2, 0, 2, 8, 0, 8, "stone_bricks");',
      'buildWall(2, 2, 8, 8, 3, "oak_planks", false);',
      'fillBox(2, 4, 2, 8, 4, 8, "stone_bricks");',
      'placeDoor(5, 1, 2, "minecraft:oak_door", "south");',
      'furnishRoom(1, "dining");',
      'placeBed(4, 1, 7, "east", "");',
    ].join("\n");
    const execRes = executeBuildScript(roomWorld, script, true);
    expect(execRes.evaluation.valid).toBe(true);
    expect(roomWorld.getVoxel(4, 1, 7)?.name).toBe("minecraft:red_bed");
    const placedNames = new Set(roomWorld.getAllVoxels().map((v) => v.name));
    expect(placedNames.has("minecraft:spruce_fence")).toBe(true);
    expect(placedNames.has("minecraft:spruce_stairs")).toBe(true);
    expect(placedNames.has("minecraft:yellow_carpet")).toBe(true);

    // 5. Native Node ESM check on compiled dist/core/nbt-io.js (if built)
    const distNbtPath = path.resolve(process.cwd(), "dist/core/nbt-io.js");
    if (fs.existsSync(distNbtPath)) {
      const proc = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          'import { serializeMcstructureBuffer, parseMcstructureBuffer } from "./dist/core/nbt-io.js"; import { VoxelWorld } from "./dist/core/voxel-world.js"; const w = new VoxelWorld([4,4,4]); w.setVoxel(1,1,1,"minecraft:oak_stairs",{facing:"north"},false,1); const buf = await serializeMcstructureBuffer(w); const r = await parseMcstructureBuffer(buf); console.log(JSON.stringify({ bytes: buf.length, restored: r.getVoxel(1,1,1)?.name }));',
        ],
        { cwd: process.cwd(), encoding: "utf8" }
      );
      expect(proc.status).toBe(0);
      const out = JSON.parse(proc.stdout.trim());
      expect(out.bytes).toBeGreaterThan(0);
      expect(out.restored).toBe("minecraft:oak_stairs");
    }
  });

  it("11. Handles sparse 256^3 worlds rapidly, detects 3-high open doorways, and keeps L-shaped 2-wide corridors unified", async () => {
    const { VoxelWorld } = await import("../src/core/voxel-world.js");

    // 1. Sparse 256^3 benchmark: small room at 10..16 + distant block at 240
    const sparseWorld = new VoxelWorld([256, 256, 256]);
    for (let x = 10; x <= 16; x++) {
      for (let z = 10; z <= 16; z++) {
        sparseWorld.setVoxel(x, 10, z, "minecraft:stone_bricks", undefined, false, 1);
        sparseWorld.setVoxel(x, 14, z, "minecraft:stone_bricks", undefined, false, 1);
        if (x === 10 || x === 16 || z === 10 || z === 16) {
          for (let y = 11; y <= 13; y++) {
            sparseWorld.setVoxel(x, y, z, "minecraft:oak_planks", undefined, false, 1);
          }
        }
      }
    }
    sparseWorld.setVoxel(13, 11, 10, "minecraft:oak_door", { facing: "south", half: "lower" }, false, 2);
    sparseWorld.setVoxel(13, 12, 10, "minecraft:oak_door", { facing: "south", half: "upper" }, false, 2);
    sparseWorld.setVoxel(13, 13, 13, "minecraft:lantern", { hanging: "true" }, false, 3);
    sparseWorld.setVoxel(240, 240, 240, "minecraft:stone", undefined, false, 4);

    const t0 = performance.now();
    const sparseReport = sparseWorld.detectInteriorRooms();
    const elapsedMs = performance.now() - t0;
    expect(elapsedMs).toBeLessThan(500);
    expect(sparseReport.rooms.length).toBe(1);
    expect(sparseReport.validFlow).toBe(true);

    // 2. 3-block-tall open doorway (headroom=3, floorY=2, ceilingY=4, lintel at y=5)
    const tallDoorWorld = new VoxelWorld([16, 12, 16]);
    for (let x = 2; x <= 8; x++) {
      for (let z = 2; z <= 8; z++) {
        tallDoorWorld.setVoxel(x, 1, z, "minecraft:stone_bricks", undefined, false, 1);
        tallDoorWorld.setVoxel(x, 5, z, "minecraft:stone_bricks", undefined, false, 1);
        if (x === 2 || x === 8 || z === 2 || z === 8) {
          for (let y = 2; y <= 4; y++) {
            if (x === 5 && z === 2) continue; // 3-high open doorway
            tallDoorWorld.setVoxel(x, y, z, "minecraft:oak_planks", undefined, false, 1);
          }
        }
      }
    }
    tallDoorWorld.setVoxel(5, 4, 5, "minecraft:lantern", { hanging: "true" }, false, 2);
    const tallReport = tallDoorWorld.detectInteriorRooms();
    expect(tallReport.rooms.length).toBe(1);
    expect(tallReport.rooms[0].floorY).toBe(2);
    expect(tallReport.rooms[0].ceilingY).toBe(4);
    expect(tallReport.rooms[0].volume).toBe(75);
    expect(tallReport.rooms[0].doors.some((d) => d.x === 5 && d.z === 2 && !d.blocked)).toBe(true);
    expect(tallReport.validFlow).toBe(true);

    // 3. L-shaped 2-wide headroom=2 corridor must remain 1 unified room
    const lWorld = new VoxelWorld([28, 12, 28]);
    const isCorridorAir = (x: number, z: number) =>
      (x >= 11 && x <= 12 && z >= 10 && z <= 16) ||
      (x >= 11 && x <= 18 && z >= 15 && z <= 16);
    for (let x = 10; x <= 19; x++) {
      for (let z = 9; z <= 17; z++) {
        const inside = isCorridorAir(x, z);
        const adj =
          isCorridorAir(x + 1, z) ||
          isCorridorAir(x - 1, z) ||
          isCorridorAir(x, z + 1) ||
          isCorridorAir(x, z - 1);
        if (inside || adj) {
          lWorld.setVoxel(x, 4, z, "minecraft:stone_bricks", undefined, false, 1);
          lWorld.setVoxel(x, 7, z, "minecraft:stone_bricks", undefined, false, 1);
          if (!inside) {
            lWorld.setVoxel(x, 5, z, "minecraft:stone_bricks", undefined, false, 1);
            lWorld.setVoxel(x, 6, z, "minecraft:stone_bricks", undefined, false, 1);
          }
        }
      }
    }
    const lReport = lWorld.detectInteriorRooms();
    expect(lReport.rooms.length).toBe(1);
    expect(lReport.rooms[0].volume).toBe(52);
  });

  it("12. Fixes filterVoxelsForCutaway porch pillars/eaves/sloped foundation and avoids 16x16 PNG texture cache collisions", async () => {
    const { filterVoxelsForCutaway } = await import("../src/viewer/voxel-mesh.js");
    const { VoxelWorld } = await import("../src/core/voxel-world.js");

    // 1. Porch pillars, 2-layer overhanging eaves, and low-slice 1-layer trim
    const buildHouseWithExtras = () => {
      const w = new VoxelWorld([24, 16, 24]);
      for (let x = 10; x <= 16; x++) {
        for (let z = 10; z <= 16; z++) {
          w.setVoxel(x, 4, z, "minecraft:stone_bricks", undefined, false, 1);
          w.setVoxel(x, 9, z, "minecraft:stone_bricks", undefined, false, 1);
          if (x === 10 || x === 16 || z === 10 || z === 16) {
            for (let y = 5; y <= 8; y++) {
              w.setVoxel(x, y, z, "minecraft:oak_planks", undefined, false, 2);
            }
          }
        }
      }
      w.setVoxel(13, 5, 13, "minecraft:crafting_table", undefined, false, 3);
      return w;
    };

    // Case 1B: 2 porch pillars
    const porchWorld = buildHouseWithExtras();
    for (let y = 5; y <= 8; y++) {
      porchWorld.setVoxel(11, y, 8, "minecraft:oak_log", undefined, false, 4);
      porchWorld.setVoxel(15, y, 8, "minecraft:oak_log", undefined, false, 4);
    }
    const porchCut = filterVoxelsForCutaway(porchWorld.getAllVoxels(), 8, "NE");
    expect(porchCut.some((v) => v.x === 13 && v.y === 6 && v.z === 10)).toBe(false);
    expect(porchCut.some((v) => v.x === 13 && v.y === 5 && v.z === 13)).toBe(true);

    // Case 1C: 2-layer overhanging eaves
    const eavesWorld = buildHouseWithExtras();
    for (let x = 9; x <= 17; x++) {
      eavesWorld.setVoxel(x, 7, 9, "minecraft:oak_slab", { type: "top" }, false, 4);
      eavesWorld.setVoxel(x, 8, 9, "minecraft:oak_stairs", { facing: "south" }, false, 4);
    }
    const eavesCut = filterVoxelsForCutaway(eavesWorld.getAllVoxels(), 8, "NE");
    expect(eavesCut.some((v) => v.x === 13 && v.y === 6 && v.z === 10)).toBe(false);

    // Case 1D: low slice cutY=5 with 1-layer slab trim
    const trimWorld = buildHouseWithExtras();
    for (let x = 10; x <= 16; x++) {
      trimWorld.setVoxel(x, 5, 9, "minecraft:oak_slab", { type: "bottom" }, false, 4);
    }
    const trimCut = filterVoxelsForCutaway(trimWorld.getAllVoxels(), 5, "NE");
    expect(trimCut.some((v) => v.x === 13 && v.y === 5 && v.z === 10)).toBe(false);

    // Case 1E: sloped terrain with deep placeFoundation preserves floor edge (18, 14, 15)
    const slopedWorld = await loadStructureNbt(sampleNbtPath);
    executeBuildScript(
      slopedWorld,
      [
        'placeFoundation(12, 12, 18, 18, 14, "stone_bricks");',
        'buildWall(12, 12, 18, 18, 4, "oak_planks", false);',
      ].join("\n"),
      true
    );
    const slopedCut = filterVoxelsForCutaway(slopedWorld.getAllVoxels(), 17, "NE");
    expect(slopedCut.some((v) => v.x === 18 && v.y === 14 && v.z === 15)).toBe(true);
    expect(slopedCut.some((v) => v.x === 18 && v.y === 16 && v.z === 15)).toBe(false);

    // 2. resolveTextureAsset cache key uniqueness across distinct 16x16 PNGs
    const makeSolidPngUrl = (r: number, g: number, b: number): string => {
      const png = new PNG({ width: 16, height: 16 });
      for (let i = 0; i < png.data.length; i += 4) {
        png.data[i] = r;
        png.data[i + 1] = g;
        png.data[i + 2] = b;
        png.data[i + 3] = 255;
      }
      return `data:image/png;base64,${PNG.sync.write(png).toString("base64")}`;
    };

    const texWorld = new VoxelWorld([8, 8, 8]);
    texWorld.setVoxel(3, 3, 3, "minecraft:stone_cache_probe", undefined, false, 1);
    const loader = new JarAssetLoader();
    const blockModels = loader.getBlockModelsForBlocks(["minecraft:stone_cache_probe"]);

    const redUrl = makeSolidPngUrl(240, 20, 20);
    const blueUrl = makeSolidPngUrl(20, 20, 240);
    expect(redUrl.slice(0, 64)).toBe(blueUrl.slice(0, 64));

    await wsBridge.syncWorld({
      voxels: texWorld.getAllVoxels(),
      size: texWorld.size,
      textures: { stone_cache_probe: redUrl },
      blockModels,
    });
    const redViews = await wsBridge.renderViews(128);
    const redPng = PNG.sync.read(
      Buffer.from(redViews.NE.replace(/^data:image\/png;base64,/, ""), "base64")
    );
    const redCenterIdx = (64 * 128 + 64) * 4;
    expect(redPng.data[redCenterIdx]).toBeGreaterThan(redPng.data[redCenterIdx + 2] + 50);

    await wsBridge.syncWorld({
      voxels: texWorld.getAllVoxels(),
      size: texWorld.size,
      textures: { stone_cache_probe: blueUrl },
      blockModels,
    });
    const blueViews = await wsBridge.renderViews(128);
    const bluePng = PNG.sync.read(
      Buffer.from(blueViews.NE.replace(/^data:image\/png;base64,/, ""), "base64")
    );
    const blueCenterIdx = (64 * 128 + 64) * 4;
    expect(bluePng.data[blueCenterIdx + 2]).toBeGreaterThan(bluePng.data[blueCenterIdx] + 50);
  }, 45000);

  it("13. Handles T-junctions, 1-wide corridors, alcoves, terrain-under-ceiling, 4-high doorways, NBT schema & placeBed(':')", async () => {
    const nbtNs = await import("prismarine-nbt");
    const nbt = (nbtNs as unknown as { default?: typeof nbtNs }).default ?? nbtNs;
    const { parseMcstructureBuffer, parseStructureNbtBuffer } = await import("../src/core/nbt-io.js");
    const { VoxelWorld } = await import("../src/core/voxel-world.js");

    // 1. 4-high open doorway (headroom=4, lintel at y=6)
    const door4World = new VoxelWorld([16, 12, 16]);
    for (let x = 2; x <= 8; x++) {
      for (let z = 2; z <= 8; z++) {
        door4World.setVoxel(x, 1, z, "minecraft:stone_bricks", undefined, false, 1);
        door4World.setVoxel(x, 6, z, "minecraft:stone_bricks", undefined, false, 1);
        if (x === 2 || x === 8 || z === 2 || z === 8) {
          for (let y = 2; y <= 5; y++) {
            if (x === 5 && z === 2) continue;
            door4World.setVoxel(x, y, z, "minecraft:oak_planks", undefined, false, 1);
          }
        }
      }
    }
    door4World.setVoxel(5, 5, 5, "minecraft:lantern", { hanging: "true" }, false, 2);
    const door4Report = door4World.detectInteriorRooms();
    expect(door4Report.rooms.length).toBe(1);
    expect(door4Report.rooms[0].volume).toBe(100);
    expect(door4Report.rooms[0].doors.length).toBe(1);
    expect(door4Report.validFlow).toBe(true);

    // 2. 1-wide straight corridor (headroom=2, 9 cols -> vol=18)
    const straight1World = new VoxelWorld([20, 10, 20]);
    for (let x = 3; x <= 13; x++) {
      for (let z = 5; z <= 7; z++) {
        straight1World.setVoxel(x, 1, z, "minecraft:stone_bricks", undefined, false, 1);
        straight1World.setVoxel(x, 4, z, "minecraft:stone_bricks", undefined, false, 1);
        if (x === 3 || x === 13 || z === 5 || z === 7) {
          straight1World.setVoxel(x, 2, z, "minecraft:oak_planks", undefined, false, 1);
          straight1World.setVoxel(x, 3, z, "minecraft:oak_planks", undefined, false, 1);
        }
      }
    }
    straight1World.setVoxel(3, 2, 6, "minecraft:oak_door", { facing: "east", half: "lower" }, false, 2);
    straight1World.setVoxel(3, 3, 6, "minecraft:oak_door", { facing: "east", half: "upper" }, false, 2);
    straight1World.setVoxel(8, 2, 6, "minecraft:torch", undefined, false, 3);
    const straight1Report = straight1World.detectInteriorRooms();
    expect(straight1Report.rooms.length).toBe(1);
    expect(straight1Report.rooms[0].volume).toBe(18);
    expect(straight1Report.validFlow).toBe(true);

    // 3. 2-wide T-junction corridor stays 1 unified room without false doorway_opening/unlit_room
    const t2World = new VoxelWorld([24, 10, 24]);
    const insideT2 = (x: number, z: number) =>
      (x >= 4 && x <= 14 && z >= 6 && z <= 7) ||
      (x >= 9 && x <= 10 && z >= 8 && z <= 13);
    for (let x = 3; x <= 15; x++) {
      for (let z = 5; z <= 14; z++) {
        const inside = insideT2(x, z);
        const adj = insideT2(x + 1, z) || insideT2(x - 1, z) || insideT2(x, z + 1) || insideT2(x, z - 1);
        if (inside || adj) {
          t2World.setVoxel(x, 1, z, "minecraft:stone_bricks", undefined, false, 1);
          t2World.setVoxel(x, 4, z, "minecraft:stone_bricks", undefined, false, 1);
          if (!inside) {
            t2World.setVoxel(x, 2, z, "minecraft:oak_planks", undefined, false, 1);
            t2World.setVoxel(x, 3, z, "minecraft:oak_planks", undefined, false, 1);
          }
        }
      }
    }
    t2World.setVoxel(3, 2, 6, "minecraft:oak_door", { facing: "east", half: "lower" }, false, 2);
    t2World.setVoxel(3, 3, 6, "minecraft:oak_door", { facing: "east", half: "upper" }, false, 2);
    t2World.setVoxel(4, 2, 6, "minecraft:torch", undefined, false, 3);
    const t2Report = t2World.detectInteriorRooms();
    expect(t2Report.rooms.length).toBe(1);
    expect(t2Report.rooms[0].volume).toBe(68);
    expect(t2Report.rooms[0].doors.length).toBe(1);
    expect(t2Report.validFlow).toBe(true);

    // 4. 1-wide T-junction corridor stays 1 unified room
    const t1World = new VoxelWorld([24, 10, 24]);
    const insideT1 = (x: number, z: number) =>
      (x >= 4 && x <= 14 && z === 6) ||
      (x === 9 && z >= 7 && z <= 12);
    for (let x = 3; x <= 15; x++) {
      for (let z = 5; z <= 13; z++) {
        const inside = insideT1(x, z);
        const adj = insideT1(x + 1, z) || insideT1(x - 1, z) || insideT1(x, z + 1) || insideT1(x, z - 1);
        if (inside || adj) {
          t1World.setVoxel(x, 1, z, "minecraft:stone_bricks", undefined, false, 1);
          t1World.setVoxel(x, 4, z, "minecraft:stone_bricks", undefined, false, 1);
          if (!inside) {
            t1World.setVoxel(x, 2, z, "minecraft:oak_planks", undefined, false, 1);
            t1World.setVoxel(x, 3, z, "minecraft:oak_planks", undefined, false, 1);
          }
        }
      }
    }
    t1World.setVoxel(3, 2, 6, "minecraft:oak_door", { facing: "east", half: "lower" }, false, 2);
    t1World.setVoxel(3, 3, 6, "minecraft:oak_door", { facing: "east", half: "upper" }, false, 2);
    t1World.setVoxel(4, 2, 6, "minecraft:torch", undefined, false, 3);
    const t1Report = t1World.detectInteriorRooms();
    expect(t1Report.rooms.length).toBe(1);
    expect(t1Report.rooms[0].volume).toBe(34);
    expect(t1Report.validFlow).toBe(true);

    // 5. Recessed 2x2 alcove stays unified with main room
    const alcoveWorld = new VoxelWorld([20, 10, 20]);
    const insideAlcove = (x: number, z: number) =>
      (x >= 3 && x <= 7 && z >= 3 && z <= 7) ||
      (x >= 4 && x <= 5 && z >= 8 && z <= 10);
    for (let x = 2; x <= 8; x++) {
      for (let z = 2; z <= 12; z++) {
        const inside = insideAlcove(x, z);
        const adj = insideAlcove(x + 1, z) || insideAlcove(x - 1, z) || insideAlcove(x, z + 1) || insideAlcove(x, z - 1);
        if (inside || adj) {
          alcoveWorld.setVoxel(x, 1, z, "minecraft:stone_bricks", undefined, false, 1);
          alcoveWorld.setVoxel(x, 5, z, "minecraft:stone_bricks", undefined, false, 1);
          if (!inside) {
            for (let y = 2; y <= 4; y++) {
              alcoveWorld.setVoxel(x, y, z, "minecraft:oak_planks", undefined, false, 1);
            }
          }
        }
      }
    }
    alcoveWorld.setVoxel(5, 2, 2, "minecraft:oak_door", { facing: "south", half: "lower" }, false, 2);
    alcoveWorld.setVoxel(5, 3, 2, "minecraft:oak_door", { facing: "south", half: "upper" }, false, 2);
    alcoveWorld.setVoxel(5, 4, 5, "minecraft:lantern", { hanging: "true" }, false, 3);
    const alcoveReport = alcoveWorld.detectInteriorRooms();
    expect(alcoveReport.rooms.length).toBe(1);
    expect(alcoveReport.rooms[0].floorPositions.length).toBe(31);

    // 6. Terrain block under built ceiling does not shatter room
    const terrainCeilWorld = new VoxelWorld([16, 12, 16]);
    for (let x = 2; x <= 8; x++) {
      for (let z = 2; z <= 8; z++) {
        terrainCeilWorld.setVoxel(x, 1, z, "minecraft:stone_bricks", undefined, false, 1);
        terrainCeilWorld.setVoxel(x, 5, z, "minecraft:stone_bricks", undefined, false, 1);
        if (x === 2 || x === 8 || z === 2 || z === 8) {
          for (let y = 2; y <= 4; y++) {
            terrainCeilWorld.setVoxel(x, y, z, "minecraft:oak_planks", undefined, false, 1);
          }
        }
      }
    }
    terrainCeilWorld.setVoxel(5, 2, 2, "minecraft:oak_door", { facing: "south", half: "lower" }, false, 2);
    terrainCeilWorld.setVoxel(5, 3, 2, "minecraft:oak_door", { facing: "south", half: "upper" }, false, 2);
    terrainCeilWorld.setVoxel(5, 4, 4, "minecraft:lantern", { hanging: "true" }, false, 3);
    terrainCeilWorld.setVoxel(5, 4, 5, "minecraft:dirt", undefined, true, 0);
    const terrainCeilReport = terrainCeilWorld.detectInteriorRooms();
    expect(terrainCeilReport.rooms.length).toBe(1);
    expect(terrainCeilReport.rooms[0].floorPositions.length).toBe(25);
    expect(terrainCeilReport.rooms[0].volume).toBe(74);
    expect(terrainCeilReport.validFlow).toBe(true);

    // 7. Reject array palette in .mcstructure, reject unrelated NBT in parseStructureNbtBuffer, and placeBed(":") fallback
    const arrayPaletteBuf = nbt.writeUncompressed(
      nbt.comp(
        {
          format_version: nbt.int(1),
          size: nbt.list(nbt.int([2, 2, 2])),
          structure: nbt.comp({
            block_indices: nbt.list(nbt.int([0])),
            palette: nbt.list(nbt.int([1])),
          }),
        },
        ""
      ) as any,
      "little"
    );
    await expect(parseMcstructureBuffer(arrayPaletteBuf)).rejects.toThrow(/Invalid \.mcstructure/);

    const unrelatedNbtBuf = nbt.writeUncompressed(
      nbt.comp({ hello: nbt.string("world") }, "") as any,
      "big"
    );
    await expect(parseStructureNbtBuffer(unrelatedNbtBuf)).rejects.toThrow(/Invalid structure NBT/);

    const bedWorld = new VoxelWorld([8, 8, 8]);
    executeBuildScript(bedWorld, 'placeBed(3, 1, 3, "north", ":");', true);
    expect(bedWorld.getVoxel(3, 1, 3)?.name).toBe("minecraft:red_bed");
  });

  it("14. Handles filterVoxelsForCutaway across 2-story, overhanging, L-shaped, bay window, recessed porch, open platform, and 4x4 sloped tower", async () => {
    const { filterVoxelsForCutaway } = await import("../src/viewer/voxel-mesh.js");
    const { VoxelWorld } = await import("../src/core/voxel-world.js");
    const hasVoxel = (list: ReturnType<typeof filterVoxelsForCutaway>, x: number, y: number, z: number) =>
      list.some((v) => v.x === x && v.y === y && v.z === z);

    // 2A: Two-story house preserves 2nd floor slab perimeter and peels both stories' outer walls
    const house2A = new VoxelWorld([28, 20, 28]);
    for (let x = 12; x <= 18; x++) {
      for (let z = 12; z <= 18; z++) {
        house2A.setVoxel(x, 4, z, "minecraft:stone_bricks", undefined, false, 1);
        house2A.setVoxel(x, 9, z, "minecraft:stone_bricks", undefined, false, 1);
        house2A.setVoxel(x, 14, z, "minecraft:stone_bricks", undefined, false, 1);
        if (x === 12 || x === 18 || z === 12 || z === 18) {
          for (let y = 5; y <= 8; y++) house2A.setVoxel(x, y, z, "minecraft:oak_planks", undefined, false, 2);
          for (let y = 10; y <= 13; y++) house2A.setVoxel(x, y, z, "minecraft:oak_planks", undefined, false, 2);
        }
      }
    }
    const cut2A = filterVoxelsForCutaway(house2A.getAllVoxels(), 12, "NE");
    expect(hasVoxel(cut2A, 18, 9, 14)).toBe(true);
    expect(hasVoxel(cut2A, 18, 6, 14)).toBe(false);
    expect(hasVoxel(cut2A, 18, 11, 14)).toBe(false);
    expect(hasVoxel(cut2A, 12, 11, 14)).toBe(true);

    // 2F: Overhanging 2nd story peels overhanging 2nd-floor wall while keeping slab edge
    const house2F = new VoxelWorld([28, 20, 28]);
    for (let x = 10; x <= 16; x++) {
      for (let z = 10; z <= 16; z++) {
        house2F.setVoxel(x, 4, z, "minecraft:stone_bricks", undefined, false, 1);
        if (x === 10 || x === 16 || z === 10 || z === 16) {
          for (let y = 5; y <= 8; y++) house2F.setVoxel(x, y, z, "minecraft:oak_planks", undefined, false, 2);
        }
      }
      for (let z = 9; z <= 16; z++) {
        house2F.setVoxel(x, 9, z, "minecraft:stone_bricks", undefined, false, 1);
        house2F.setVoxel(x, 14, z, "minecraft:stone_bricks", undefined, false, 1);
        if (x === 10 || x === 16 || z === 9 || z === 16) {
          for (let y = 10; y <= 13; y++) house2F.setVoxel(x, y, z, "minecraft:oak_planks", undefined, false, 2);
        }
      }
    }
    const cut2F = filterVoxelsForCutaway(house2F.getAllVoxels(), 12, "NE");
    expect(hasVoxel(cut2F, 13, 11, 9)).toBe(false);
    expect(hasVoxel(cut2F, 13, 6, 10)).toBe(false);
    expect(hasVoxel(cut2F, 13, 9, 9)).toBe(true);

    // 2B: L-shaped footprint across NE/SE/SW/NW
    const house2B = new VoxelWorld([32, 16, 32]);
    const insideL = (x: number, z: number) =>
      (x >= 11 && x <= 21 && z >= 11 && z <= 15) ||
      (x >= 11 && x <= 14 && z >= 15 && z <= 23);
    for (let x = 10; x <= 22; x++) {
      for (let z = 10; z <= 24; z++) {
        const inside = insideL(x, z);
        const wall = !inside && (insideL(x + 1, z) || insideL(x - 1, z) || insideL(x, z + 1) || insideL(x, z - 1) ||
          insideL(x + 1, z + 1) || insideL(x - 1, z - 1) || insideL(x + 1, z - 1) || insideL(x - 1, z + 1));
        if (inside || wall) {
          house2B.setVoxel(x, 4, z, "minecraft:stone_bricks", undefined, false, 1);
          house2B.setVoxel(x, 9, z, "minecraft:stone_bricks", undefined, false, 1);
          if (wall) {
            for (let y = 5; y <= 8; y++) house2B.setVoxel(x, y, z, "minecraft:oak_planks", undefined, false, 2);
          }
        }
      }
    }
    const all2B = house2B.getAllVoxels();
    const cut2BNE = filterVoxelsForCutaway(all2B, 7, "NE");
    expect(hasVoxel(cut2BNE, 16, 6, 10)).toBe(false);
    expect(hasVoxel(cut2BNE, 22, 6, 13)).toBe(false);
    expect(hasVoxel(cut2BNE, 15, 6, 20)).toBe(false);
    expect(hasVoxel(cut2BNE, 10, 6, 17)).toBe(true);
    expect(hasVoxel(cut2BNE, 12, 6, 24)).toBe(true);
    const cut2BSW = filterVoxelsForCutaway(all2B, 7, "SW");
    expect(hasVoxel(cut2BSW, 10, 6, 17)).toBe(false);
    expect(hasVoxel(cut2BSW, 12, 6, 24)).toBe(false);
    expect(hasVoxel(cut2BSW, 19, 6, 16)).toBe(false);
    expect(hasVoxel(cut2BSW, 22, 6, 13)).toBe(true);

    // 2C: Bay window
    const house2C = new VoxelWorld([28, 16, 28]);
    for (let x = 10; x <= 20; x++) {
      for (let z = 10; z <= 18; z++) {
        house2C.setVoxel(x, 4, z, "minecraft:stone_bricks", undefined, false, 1);
        house2C.setVoxel(x, 9, z, "minecraft:stone_bricks", undefined, false, 1);
        if (x === 10 || x === 20 || z === 18 || (z === 10 && (x < 14 || x > 16))) {
          for (let y = 5; y <= 8; y++) house2C.setVoxel(x, y, z, "minecraft:oak_planks", undefined, false, 2);
        }
      }
    }
    for (let x = 13; x <= 17; x++) {
      house2C.setVoxel(x, 4, 9, "minecraft:stone_bricks", undefined, false, 1);
      house2C.setVoxel(x, 9, 9, "minecraft:stone_bricks", undefined, false, 1);
      for (let y = 5; y <= 8; y++) house2C.setVoxel(x, y, 9, "minecraft:oak_planks", undefined, false, 2);
    }
    const cut2C = filterVoxelsForCutaway(house2C.getAllVoxels(), 7, "NE");
    expect(hasVoxel(cut2C, 15, 6, 9)).toBe(false);
    expect(hasVoxel(cut2C, 11, 6, 10)).toBe(false);
    expect(hasVoxel(cut2C, 19, 6, 10)).toBe(false);
    expect(hasVoxel(cut2C, 20, 6, 14)).toBe(false);
    expect(hasVoxel(cut2C, 10, 6, 14)).toBe(true);

    // 2D: Recessed porch
    const house2D = new VoxelWorld([28, 16, 28]);
    for (let x = 10; x <= 20; x++) {
      for (let z = 10; z <= 18; z++) {
        if (x > 18 && z >= 12 && z <= 16) continue;
        house2D.setVoxel(x, 4, z, "minecraft:stone_bricks", undefined, false, 1);
        house2D.setVoxel(x, 9, z, "minecraft:stone_bricks", undefined, false, 1);
        const isEastEdge = (x === 20 && (z <= 11 || z >= 17)) || (x === 18 && z >= 12 && z <= 16);
        const isReturn = x === 19 && (z === 11 || z === 17);
        if (x === 10 || z === 10 || z === 18 || isEastEdge || isReturn) {
          for (let y = 5; y <= 8; y++) house2D.setVoxel(x, y, z, "minecraft:oak_planks", undefined, false, 2);
        }
      }
    }
    const cut2D = filterVoxelsForCutaway(house2D.getAllVoxels(), 7, "NE");
    expect(hasVoxel(cut2D, 20, 6, 11)).toBe(false);
    expect(hasVoxel(cut2D, 20, 6, 18)).toBe(false);
    expect(hasVoxel(cut2D, 18, 6, 14)).toBe(false);
    expect(hasVoxel(cut2D, 10, 6, 14)).toBe(true);

    // 2E1: Flat 1-block platform + furniture keeps isolated furniture intact
    const plat2E1 = new VoxelWorld([20, 12, 20]);
    for (let x = 5; x <= 14; x++) {
      for (let z = 5; z <= 14; z++) {
        plat2E1.setVoxel(x, 4, z, "minecraft:stone_bricks", undefined, false, 1);
      }
    }
    plat2E1.setVoxel(9, 5, 9, "minecraft:crafting_table", undefined, false, 2);
    const cut2E1 = filterVoxelsForCutaway(plat2E1.getAllVoxels(), 6, "NE");
    expect(hasVoxel(cut2E1, 5, 4, 5)).toBe(true);
    expect(hasVoxel(cut2E1, 9, 5, 9)).toBe(true);

    // 2E2: Small 4x4 furnished tower on sloped terrain preserves floor edge and furniture
    const tower2E2 = await loadStructureNbt(sampleNbtPath);
    executeBuildScript(
      tower2E2,
      [
        'placeFoundation(12, 12, 15, 15, 14, "stone_bricks");',
        'buildWall(12, 12, 15, 15, 4, "oak_planks", false);',
        'setBlock(13, 15, 13, "chest");',
        'setBlock(14, 15, 13, "crafting_table");',
      ].join("\n"),
      true
    );
    const cut2E2 = filterVoxelsForCutaway(tower2E2.getAllVoxels(), 17, "NE");
    expect(hasVoxel(cut2E2, 15, 14, 13)).toBe(true);
    expect(hasVoxel(cut2E2, 13, 14, 12)).toBe(true);
    expect(hasVoxel(cut2E2, 15, 16, 13)).toBe(false);
    expect(hasVoxel(cut2E2, 13, 15, 13)).toBe(true);
  });

  it("15. Fixes filterVoxelsForCutaway for flat-roof cutY=roofY+1 (3A), small-1F/large-2F (3B), terrain-floor (3C), and full-height open front gaps (3D)", async () => {
    const { filterVoxelsForCutaway } = await import("../src/viewer/voxel-mesh.js");
    const { VoxelWorld } = await import("../src/core/voxel-world.js");
    const hasVoxel = (list: ReturnType<typeof filterVoxelsForCutaway>, x: number, y: number, z: number) =>
      list.some((v) => v.x === x && v.y === y && v.z === z);

    // 3A: 1-story flat-roofed house with 2 interior furniture blocks sliced at cutY = roofY + 1
    const house3A = new VoxelWorld([24, 16, 24]);
    for (let x = 8; x <= 14; x++) {
      for (let z = 8; z <= 14; z++) {
        house3A.setVoxel(x, 4, z, "minecraft:stone_bricks", undefined, false, 1);
        house3A.setVoxel(x, 9, z, "minecraft:stone_bricks", undefined, false, 1);
        if (x === 8 || x === 14 || z === 8 || z === 14) {
          for (let y = 5; y <= 8; y++) {
            house3A.setVoxel(x, y, z, "minecraft:oak_planks", undefined, false, 2);
          }
        }
      }
    }
    house3A.setVoxel(11, 5, 11, "minecraft:crafting_table", undefined, false, 3);
    house3A.setVoxel(10, 5, 10, "minecraft:chest", undefined, false, 3);

    for (const view of ["NE", "SE", "SW", "NW"] as const) {
      const cut3A = filterVoxelsForCutaway(house3A.getAllVoxels(), 10, view);
      expect(hasVoxel(cut3A, 14, 6, 11)).toBe(view === "SW" || view === "NW");
      expect(hasVoxel(cut3A, 8, 6, 11)).toBe(view === "NE" || view === "SE");
      expect(hasVoxel(cut3A, 11, 6, 8)).toBe(view === "SE" || view === "SW");
      expect(hasVoxel(cut3A, 11, 6, 14)).toBe(view === "NE" || view === "NW");
      expect(hasVoxel(cut3A, 11, 5, 11)).toBe(true);
    }

    // 3B: Small 1F (5x5, y=4..8) + larger 2F (9x9, y=9..14) sliced at cutY=12
    const house3B = new VoxelWorld([28, 20, 28]);
    for (let x = 12; x <= 16; x++) {
      for (let z = 12; z <= 16; z++) {
        house3B.setVoxel(x, 4, z, "minecraft:stone_bricks", undefined, false, 1);
        if (x === 12 || x === 16 || z === 12 || z === 16) {
          for (let y = 5; y <= 8; y++) {
            house3B.setVoxel(x, y, z, "minecraft:oak_planks", undefined, false, 2);
          }
        }
      }
    }
    for (let x = 10; x <= 18; x++) {
      for (let z = 10; z <= 18; z++) {
        house3B.setVoxel(x, 9, z, "minecraft:stone_bricks", undefined, false, 1);
        house3B.setVoxel(x, 14, z, "minecraft:stone_bricks", undefined, false, 1);
        if (x === 10 || x === 18 || z === 10 || z === 18) {
          for (let y = 10; y <= 13; y++) {
            house3B.setVoxel(x, y, z, "minecraft:oak_planks", undefined, false, 2);
          }
        }
      }
    }
    const cut3B = filterVoxelsForCutaway(house3B.getAllVoxels(), 12, "NE");
    expect(hasVoxel(cut3B, 16, 6, 14)).toBe(false);
    expect(hasVoxel(cut3B, 14, 6, 12)).toBe(false);
    expect(hasVoxel(cut3B, 12, 6, 14)).toBe(true);
    expect(hasVoxel(cut3B, 18, 11, 14)).toBe(false);
    expect(hasVoxel(cut3B, 14, 11, 10)).toBe(false);
    expect(hasVoxel(cut3B, 18, 9, 14)).toBe(true);

    // 3C: Terrain-floor house with no artificial floor slab + north doorway
    const house3C = new VoxelWorld([20, 12, 20]);
    for (let x = 0; x < 20; x++) {
      for (let z = 0; z < 20; z++) {
        house3C.setVoxel(x, 0, z, "minecraft:grass_block", undefined, true, 0);
      }
    }
    for (let x = 5; x <= 13; x++) {
      for (let z = 5; z <= 13; z++) {
        house3C.setVoxel(x, 5, z, "minecraft:stone_bricks", undefined, false, 1);
        if (x === 5 || x === 13 || z === 5 || z === 13) {
          for (let y = 1; y <= 4; y++) {
            if (x === 9 && z === 5 && y <= 2) continue;
            house3C.setVoxel(x, y, z, "minecraft:oak_planks", undefined, false, 2);
          }
        }
      }
    }
    const cut3C = filterVoxelsForCutaway(house3C.getAllVoxels(), 3, "NE");
    expect(hasVoxel(cut3C, 7, 2, 5)).toBe(false);
    expect(hasVoxel(cut3C, 13, 2, 9)).toBe(false);
    expect(hasVoxel(cut3C, 9, 2, 13)).toBe(true);
    expect(hasVoxel(cut3C, 8, 2, 13)).toBe(true);
    expect(hasVoxel(cut3C, 5, 2, 9)).toBe(true);

    // 3D: Built-floor house with lintelled doorway (x=8) & full-height open front gap without lintel (x=10..11)
    const house3D = new VoxelWorld([24, 16, 24]);
    for (let x = 6; x <= 14; x++) {
      for (let z = 6; z <= 14; z++) {
        house3D.setVoxel(x, 4, z, "minecraft:stone_bricks", undefined, false, 1);
        house3D.setVoxel(x, 9, z, "minecraft:stone_bricks", undefined, false, 1);
        if (x === 6 || x === 14 || z === 6 || z === 14) {
          for (let y = 5; y <= 8; y++) {
            if (x === 8 && z === 6 && y <= 6) continue; // lintelled doorway
            if ((x === 10 || x === 11) && z === 6) continue; // full-height open gap without lintel
            house3D.setVoxel(x, y, z, "minecraft:oak_planks", undefined, false, 2);
          }
        }
      }
    }
    const cut3D = filterVoxelsForCutaway(house3D.getAllVoxels(), 7, "NE");
    expect(hasVoxel(cut3D, 8, 6, 14)).toBe(true);
    expect(hasVoxel(cut3D, 10, 6, 14)).toBe(true);
    expect(hasVoxel(cut3D, 11, 6, 14)).toBe(true);
    expect(hasVoxel(cut3D, 12, 6, 6)).toBe(false);
    expect(hasVoxel(cut3D, 14, 6, 10)).toBe(false);

    // 3E: U-shaped courtyard (open North) peels inner south courtyard wall while preserving wings
    const house3E = new VoxelWorld([28, 16, 28]);
    const insideU = (x: number, z: number) =>
      (x >= 7 && x <= 9 && z >= 7 && z <= 19) ||
      (x >= 17 && x <= 19 && z >= 7 && z <= 19) ||
      (x >= 7 && x <= 19 && z >= 16 && z <= 19);
    for (let x = 6; x <= 20; x++) {
      for (let z = 6; z <= 20; z++) {
        const inside = insideU(x, z);
        const wall =
          !inside &&
          (insideU(x + 1, z) ||
            insideU(x - 1, z) ||
            insideU(x, z + 1) ||
            insideU(x, z - 1) ||
            insideU(x + 1, z + 1) ||
            insideU(x - 1, z - 1) ||
            insideU(x + 1, z - 1) ||
            insideU(x - 1, z + 1));
        if (inside || wall) {
          house3E.setVoxel(x, 4, z, "minecraft:stone_bricks", undefined, false, 1);
          house3E.setVoxel(x, 9, z, "minecraft:stone_bricks", undefined, false, 1);
          if (wall) {
            for (let y = 5; y <= 8; y++) {
              house3E.setVoxel(x, y, z, "minecraft:oak_planks", undefined, false, 2);
            }
          }
        }
      }
    }
    const cut3E = filterVoxelsForCutaway(house3E.getAllVoxels(), 7, "NE");
    expect(hasVoxel(cut3E, 14, 6, 15)).toBe(false);
    expect(hasVoxel(cut3E, 20, 6, 12)).toBe(false);
    expect(hasVoxel(cut3E, 6, 6, 12)).toBe(true);
    expect(hasVoxel(cut3E, 14, 6, 20)).toBe(true);

    // 3H2: 2-room partition wall with doorways preserves partition & back wall
    const house3H2 = new VoxelWorld([24, 16, 24]);
    for (let x = 6; x <= 18; x++) {
      for (let z = 6; z <= 14; z++) {
        house3H2.setVoxel(x, 4, z, "minecraft:stone_bricks", undefined, false, 1);
        house3H2.setVoxel(x, 9, z, "minecraft:stone_bricks", undefined, false, 1);
        if (x === 6 || x === 18 || z === 6 || z === 14 || x === 12) {
          for (let y = 5; y <= 8; y++) {
            if (x === 9 && z === 6 && y <= 6) continue;
            if (x === 12 && z === 10 && y <= 6) continue;
            house3H2.setVoxel(x, y, z, "minecraft:oak_planks", undefined, false, 2);
          }
        }
      }
    }
    const cut3H2 = filterVoxelsForCutaway(house3H2.getAllVoxels(), 7, "NE");
    expect(hasVoxel(cut3H2, 7, 6, 6)).toBe(false);
    expect(hasVoxel(cut3H2, 18, 6, 10)).toBe(false);
    expect(hasVoxel(cut3H2, 12, 6, 8)).toBe(true);
    expect(hasVoxel(cut3H2, 9, 6, 14)).toBe(true);
    expect(hasVoxel(cut3H2, 6, 6, 10)).toBe(true);
  });

  it("16. Regression tests for 1-block floor objects (Adv A), non-List block_palette (Adv B), blocked virtual doorways (Adv C), placeBed(':_bed'), porch/eaves (Adv-5), terrain-floor 2-story (Adv-1), and furniture-dense 1F (Adv-2)", async () => {
    const nbtNs = await import("prismarine-nbt");
    const nbt = (nbtNs as unknown as { default?: typeof nbtNs }).default ?? nbtNs;
    const { parseMcstructureBuffer } = await import("../src/core/nbt-io.js");
    const { VoxelWorld } = await import("../src/core/voxel-world.js");
    const { filterVoxelsForCutaway } = await import("../src/viewer/voxel-mesh.js");
    const hasVoxel = (list: ReturnType<typeof filterVoxelsForCutaway>, x: number, y: number, z: number) =>
      list.some((v) => v.x === x && v.y === y && v.z === z);

    // 1. Adv A: 1-block floor objects (chair, fence table, wool, cobblestone) must NOT hallucinate doorways
    for (const [blockName, expectedVol] of [
      ["minecraft:oak_stairs", 75],
      ["minecraft:oak_fence", 75],
      ["minecraft:light_blue_wool", 72],
      ["minecraft:cobblestone", 72],
    ] as const) {
      const advA = new VoxelWorld([15, 10, 15]);
      for (let x = 3; x <= 9; x++) {
        for (let z = 3; z <= 9; z++) {
          advA.setVoxel(x, 0, z, "minecraft:stone_bricks", undefined, false, 1);
          advA.setVoxel(x, 4, z, "minecraft:stone_bricks", undefined, false, 1);
          if (x === 3 || x === 9 || z === 3 || z === 9) {
            for (let y = 1; y <= 3; y++) {
              advA.setVoxel(x, y, z, "minecraft:oak_planks", undefined, false, 1);
            }
          }
        }
      }
      advA.setVoxel(6, 3, 6, "minecraft:lantern", { hanging: "true" }, false, 2);
      advA.setVoxel(5, 1, 5, blockName, undefined, false, 3);
      const repA = advA.detectInteriorRooms();
      expect(repA.rooms.length).toBe(1);
      expect(repA.rooms[0].doors).toEqual([]);
      expect(repA.rooms[0].volume).toBe(expectedVol);
      expect(repA.flowIssues.some((i) => i.type === "isolated_room")).toBe(true);
      expect(repA.validFlow).toBe(false);
    }

    // 2. Adv B: Non-List structure.palette.default.block_palette throws clean Invalid .mcstructure error
    for (const badPalette of [nbt.int(42), nbt.comp({ foo: nbt.string("bar") })]) {
      const badMcBuf = nbt.writeUncompressed(
        nbt.comp(
          {
            format_version: nbt.int(1),
            size: nbt.list(nbt.int([2, 2, 2])),
            structure: nbt.comp({
              block_indices: nbt.list(nbt.list(nbt.int([0]))),
              palette: nbt.comp({
                default: nbt.comp({
                  block_palette: badPalette as any,
                }),
              }),
            }),
          },
          ""
        ) as any,
        "little"
      );
      await expect(parseMcstructureBuffer(badMcBuf)).rejects.toThrow(/Invalid \.mcstructure/);
    }

    // 3. Adv C: Blocked open doorway at floorY + 1 emits door_blocked and fails validFlow
    const advC = new VoxelWorld([15, 10, 15]);
    for (let x = 3; x <= 9; x++) {
      for (let z = 3; z <= 9; z++) {
        advC.setVoxel(x, 0, z, "minecraft:stone_bricks", undefined, false, 1);
        advC.setVoxel(x, 4, z, "minecraft:stone_bricks", undefined, false, 1);
        if (x === 3 || x === 9 || z === 3 || z === 9) {
          for (let y = 1; y <= 3; y++) {
            if (x === 6 && z === 3 && y <= 2) continue;
            advC.setVoxel(x, y, z, "minecraft:oak_planks", undefined, false, 1);
          }
        }
      }
    }
    advC.setVoxel(6, 3, 6, "minecraft:lantern", { hanging: "true" }, false, 2);
    advC.setVoxel(6, 2, 3, "minecraft:cobblestone", undefined, false, 3);
    const repC = advC.detectInteriorRooms();
    expect(repC.rooms.length).toBe(1);
    expect(repC.rooms[0].doors.some((d) => d.blocked)).toBe(true);
    expect(repC.flowIssues.some((i) => i.type === "door_blocked")).toBe(true);
    expect(repC.validFlow).toBe(false);

    // 4. placeBed(":_bed") falls back to minecraft:red_bed
    const bedEdgeWorld = new VoxelWorld([8, 8, 8]);
    executeBuildScript(bedEdgeWorld, 'placeBed(2, 1, 2, "north", ":_bed");', true);
    expect(bedEdgeWorld.getVoxel(2, 1, 2)?.name).toBe("minecraft:red_bed");

    // 5. Adv-5 & Diag-1: Covered porch / patio + overhanging eaves do NOT suppress front-wall peeling
    const adv5 = new VoxelWorld([28, 16, 28]);
    for (let x = 10; x <= 18; x++) {
      for (let z = 10; z <= 18; z++) {
        adv5.setVoxel(x, 4, z, "minecraft:stone_bricks", undefined, false, 1);
        adv5.setVoxel(x, 9, z, "minecraft:stone_bricks", undefined, false, 1);
        if (x === 10 || x === 18 || z === 10 || z === 18) {
          for (let y = 5; y <= 8; y++) {
            adv5.setVoxel(x, y, z, "minecraft:oak_planks", undefined, false, 2);
          }
        }
      }
      for (let z = 7; z <= 9; z++) {
        adv5.setVoxel(x, 4, z, "minecraft:stone_bricks", undefined, false, 1);
        adv5.setVoxel(x, 9, z, "minecraft:stone_bricks", undefined, false, 1);
      }
    }
    const diag1Cut = filterVoxelsForCutaway(adv5.getAllVoxels(), 7, "NE");
    expect(hasVoxel(diag1Cut, 14, 6, 10)).toBe(false);
    expect(hasVoxel(diag1Cut, 18, 6, 14)).toBe(false);
    expect(hasVoxel(diag1Cut, 14, 6, 18)).toBe(true);

    for (let y = 5; y <= 8; y++) {
      adv5.setVoxel(10, y, 7, "minecraft:oak_log", undefined, false, 3);
      adv5.setVoxel(18, y, 7, "minecraft:oak_log", undefined, false, 3);
    }
    adv5.setVoxel(14, 5, 14, "minecraft:chest", undefined, false, 4);
    const cutAdv5 = filterVoxelsForCutaway(adv5.getAllVoxels(), 7, "NE");
    expect(hasVoxel(cutAdv5, 14, 6, 10)).toBe(false);
    expect(hasVoxel(cutAdv5, 18, 6, 14)).toBe(false);
    expect(hasVoxel(cutAdv5, 10, 6, 14)).toBe(true);
    expect(hasVoxel(cutAdv5, 14, 6, 18)).toBe(true);
    expect(hasVoxel(cutAdv5, 14, 5, 14)).toBe(true);

    // 6. Adv-1: Terrain-floor 2-story structure peels 1F camera-facing walls alongside 2F
    const adv1 = new VoxelWorld([20, 16, 20]);
    for (let x = 0; x < 20; x++) {
      for (let z = 0; z < 20; z++) {
        adv1.setVoxel(x, 0, z, "minecraft:grass_block", undefined, true, 0);
      }
    }
    for (let x = 5; x <= 13; x++) {
      for (let z = 5; z <= 13; z++) {
        adv1.setVoxel(x, 5, z, "minecraft:stone_bricks", undefined, false, 1);
        adv1.setVoxel(x, 10, z, "minecraft:stone_bricks", undefined, false, 1);
        if (x === 5 || x === 13 || z === 5 || z === 13) {
          for (let y = 1; y <= 4; y++) adv1.setVoxel(x, y, z, "minecraft:oak_planks", undefined, false, 2);
          for (let y = 6; y <= 9; y++) adv1.setVoxel(x, y, z, "minecraft:oak_planks", undefined, false, 2);
        }
      }
    }
    const cutAdv1 = filterVoxelsForCutaway(adv1.getAllVoxels(), 8, "NE");
    expect(hasVoxel(cutAdv1, 13, 2, 9)).toBe(false);
    expect(hasVoxel(cutAdv1, 9, 2, 5)).toBe(false);
    expect(hasVoxel(cutAdv1, 5, 2, 9)).toBe(true);
    expect(hasVoxel(cutAdv1, 13, 7, 9)).toBe(false);
    expect(hasVoxel(cutAdv1, 9, 7, 5)).toBe(false);
    expect(hasVoxel(cutAdv1, 13, 5, 9)).toBe(true);

    // 7. Adv-2 & Adv-2b: Furniture-dense 1st floor keeps floorY=4 and peels bottom wall course y=5
    const adv2 = new VoxelWorld([20, 16, 20]);
    for (let x = 8; x <= 12; x++) {
      for (let z = 8; z <= 12; z++) {
        adv2.setVoxel(x, 4, z, "minecraft:stone_bricks", undefined, false, 1);
        adv2.setVoxel(x, 9, z, "minecraft:stone_bricks", undefined, false, 1);
        if (x === 8 || x === 12 || z === 8 || z === 12) {
          for (let y = 5; y <= 8; y++) {
            adv2.setVoxel(x, y, z, "minecraft:oak_planks", undefined, false, 2);
          }
        }
      }
    }
    for (let x = 9; x <= 11; x++) {
      for (let z = 9; z <= 10; z++) {
        adv2.setVoxel(x, 5, z, "minecraft:chest", undefined, false, 3);
      }
    }
    adv2.setVoxel(9, 5, 11, "minecraft:chest", undefined, false, 3);
    const cutAdv2 = filterVoxelsForCutaway(adv2.getAllVoxels(), 7, "NE");
    expect(hasVoxel(cutAdv2, 12, 5, 10)).toBe(false);
    expect(hasVoxel(cutAdv2, 10, 5, 8)).toBe(false);
    expect(hasVoxel(cutAdv2, 8, 5, 10)).toBe(true);
    expect(hasVoxel(cutAdv2, 9, 5, 9)).toBe(true);

    const adv2b = new VoxelWorld([20, 20, 20]);
    for (let x = 6; x <= 12; x++) {
      for (let z = 6; z <= 12; z++) {
        adv2b.setVoxel(x, 4, z, "minecraft:stone_bricks", undefined, false, 1);
        adv2b.setVoxel(x, 9, z, "minecraft:stone_bricks", undefined, false, 1);
        adv2b.setVoxel(x, 14, z, "minecraft:stone_bricks", undefined, false, 1);
        if (x === 6 || x === 12 || z === 6 || z === 12) {
          for (let y = 5; y <= 8; y++) adv2b.setVoxel(x, y, z, "minecraft:oak_planks", undefined, false, 2);
          for (let y = 10; y <= 13; y++) adv2b.setVoxel(x, y, z, "minecraft:oak_planks", undefined, false, 2);
        }
      }
    }
    let placedStairs = 0;
    for (let x = 7; x <= 11 && placedStairs < 22; x++) {
      for (let z = 7; z <= 11 && placedStairs < 22; z++) {
        adv2b.setVoxel(x, 5, z, "minecraft:oak_stairs", { facing: "north" }, false, 3);
        placedStairs++;
      }
    }
    const cutAdv2b = filterVoxelsForCutaway(adv2b.getAllVoxels(), 12, "NE");
    expect(hasVoxel(cutAdv2b, 12, 5, 9)).toBe(false);
    expect(hasVoxel(cutAdv2b, 9, 5, 6)).toBe(false);
    expect(hasVoxel(cutAdv2b, 6, 5, 9)).toBe(true);
    expect(hasVoxel(cutAdv2b, 12, 10, 9)).toBe(false);
  });
});

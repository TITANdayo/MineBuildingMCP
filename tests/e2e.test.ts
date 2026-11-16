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
    } finally {
      await mcpServer.close();
    }
  }, 45000);
});

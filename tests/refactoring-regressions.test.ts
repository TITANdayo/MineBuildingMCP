import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { PNG } from "pngjs";
import { describe, it, expect, afterEach } from "vitest";
import { WebSocket } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { JarAssetLoader } from "../src/assets/jar-loader.js";
import { resolveWorldBlockStates } from "../src/core/block-state-resolver.js";
import { executeBuildScript } from "../src/core/builder-dsl.js";
import {
  serializeMcstructureBuffer,
  parseMcstructureBuffer,
  saveStructureNbt,
} from "../src/core/nbt-io.js";
import {
  javaToBedrockState,
  bedrockToJavaState,
} from "../src/core/state-translator.js";
import {
  formatLintReportSummary,
  lintWorldStructure,
} from "../src/core/structure-linter.js";
import { VoxelWorld } from "../src/core/voxel-world.js";
import { MAX_LINT_ISSUES, MineBuildingMcpServer } from "../src/mcp/server.js";
import { WsBridge } from "../src/mcp/ws-bridge.js";
import type { CompiledBlockDefinition } from "../src/types/shared.js";
import {
  decodePickerAlphaByte,
  resolvePickerPixelCoords,
} from "../src/viewer/picker-pass.js";
import { encodePickerAlphaByte } from "../src/viewer/voxel-mesh.js";

function createSolidPng(r: number, g: number, b: number, a: number): Buffer {
  const png = new PNG({ width: 16, height: 16 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = r;
    png.data[i + 1] = g;
    png.data[i + 2] = b;
    png.data[i + 3] = a;
  }
  return PNG.sync.write(png);
}

describe("Refactoring & Bugfix Regressions", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("BuilderDSL: >255 operations preserve opId #1 trace without modulo wraparound & incremental runs preserve earlier phase traces", () => {
    const world = new VoxelWorld([32, 32, 32]);
    // Phase 1: 300 distinct setBlock calls (> 255)
    const phase1Lines = ['setBlock(0, 0, 0, "diamond_block");'];
    for (let i = 1; i <= 299; i++) {
      const x = i % 30;
      const z = Math.floor(i / 30);
      phase1Lines.push(`setBlock(${x}, 0, ${z}, "stone");`);
    }
    executeBuildScript(world, phase1Lines.join("\n"), true, { evaluate: false });

    const firstVoxel = world.getVoxel(0, 0, 0);
    expect(firstVoxel?.opId).toBe(1);
    expect(world.traces.get(1)?.line).toBe(1);
    expect(world.traces.get(1)?.codeSnippet).toContain("diamond_block");

    const op260Voxel = world.getVoxel(259 % 30, 0, Math.floor(259 / 30));
    expect(op260Voxel?.opId).toBe(260);
    expect(world.traces.get(260)?.line).toBe(260);

    // Phase 2: incremental run (resetBeforeRun=false) MUST NOT overwrite Phase 1 traces
    executeBuildScript(
      world,
      'setBlock(5, 5, 5, "gold_block");',
      false,
      { evaluate: false }
    );
    const goldVoxel = world.getVoxel(5, 5, 5);
    expect(goldVoxel?.opId).toBeGreaterThan(300);
    expect(world.traces.get(1)?.codeSnippet).toContain("diamond_block");
    expect(world.traces.get(goldVoxel!.opId)?.codeSnippet).toContain("gold_block");
  });

  it("BuilderDSL: supports 'use strict', top-level return, exact line traces, timeoutMs guard, deriveGableBlock fixes, and placeBed facing normalization", () => {
    const world = new VoxelWorld([20, 20, 20]);
    const script = [
      '"use strict";', // Line 1
      'setBlock(1, 1, 1, "emerald_block");', // Line 2
      'placeBed(4, 1, 4, "NORTH ", "blue");', // Line 3
      "if (true) return;", // Line 4
      'setBlock(2, 2, 2, "diamond_block");', // Line 5 (should not run)
    ].join("\n");

    executeBuildScript(world, script, true, { evaluate: false });
    const emerald = world.getVoxel(1, 1, 1);
    expect(emerald?.name).toBe("minecraft:emerald_block");
    expect(world.traces.get(emerald!.opId)?.line).toBe(2);
    expect(world.getVoxel(2, 2, 2)).toBeUndefined();

    // Normalized placeBed facing
    const bedFoot = world.getVoxel(4, 1, 4);
    const bedHead = world.getVoxel(4, 1, 3);
    expect(bedFoot?.name).toBe("minecraft:blue_bed");
    expect(bedFoot?.state?.facing).toBe("north");
    expect(bedHead?.state?.part).toBe("head");

    // Infinite loop aborts via timeoutMs
    expect(() =>
      executeBuildScript(world, "while (true) {}", false, {
        evaluate: false,
        timeoutMs: 100,
      })
    ).toThrow(/timed out/i);

    // deriveGableBlock special block mappings
    const roofCases: Array<[string, string]> = [
      ["brick_stairs", "minecraft:bricks"],
      ["quartz_stairs", "minecraft:quartz_block"],
      ["purpur_stairs", "minecraft:purpur_block"],
      ["pale_oak_stairs", "minecraft:pale_oak_planks"],
    ];
    for (const [stair, expectedGable] of roofCases) {
      const rw = new VoxelWorld([12, 16, 12]);
      executeBuildScript(
        rw,
        `buildPitchedRoof(2, 2, 8, 8, 2, "${stair}", "NS");`,
        true,
        { evaluate: false }
      );
      // Interior gable peak at x=5, y=4, z=2 (row=2, x ranges 4..6 -> x=5 is inner gable)
      const gableVoxel = rw.getVoxel(5, 4, 2);
      expect(gableVoxel?.name).toBe(expectedGable);
    }
  });

  it("BlockStateResolver: hasVariantProp exact key matching & stacked corner wall up=true preservation & stale state clearing", () => {
    // 1. Substring key collision test: `surface=floor` must NOT be mistaken for `face=`
    const customDef: CompiledBlockDefinition = {
      blockName: "custom_gizmo",
      variants: {
        "surface=floor,wood_type=oak": [{ model: "gizmo" }],
      },
      models: { gizmo: [] },
      isFullOpaqueCube: false,
      isFluid: false,
      isTranslucent: false,
    };
    const w1 = new VoxelWorld([4, 4, 4]);
    w1.setVoxel(1, 1, 1, "minecraft:custom_gizmo", { bogus: "x" }, false, 1);
    const resolved1 = resolveWorldBlockStates(w1.getAllVoxels(), {
      custom_gizmo: customDef,
    });
    const st1 = resolved1.get("1,1,1")!;
    // Should NOT synthesize `face` or `type` defaults when only `surface` / `wood_type` exist
    expect(st1.face).toBeUndefined();
    expect(st1.type).toBeUndefined();

    // 2. Stacked walls: bottom corner wall keeps up="true" even when wall above is straight (up="false")
    const wallDef: CompiledBlockDefinition = {
      blockName: "stone_brick_wall",
      multipart: [
        { when: { up: "true" }, apply: [{ model: "post" }] },
        { when: { north: "low" }, apply: [{ model: "side" }] },
        { when: { north: "tall" }, apply: [{ model: "side_tall" }] },
        { when: { south: "low" }, apply: [{ model: "side" }] },
        { when: { south: "tall" }, apply: [{ model: "side_tall" }] },
        { when: { east: "low" }, apply: [{ model: "side" }] },
        { when: { east: "tall" }, apply: [{ model: "side_tall" }] },
        { when: { west: "low" }, apply: [{ model: "side" }] },
        { when: { west: "tall" }, apply: [{ model: "side_tall" }] },
      ],
      models: { post: [], side: [], side_tall: [] },
      isFullOpaqueCube: false,
      isFluid: false,
      isTranslucent: false,
    };
    const w2 = new VoxelWorld([8, 8, 8]);
    // Bottom layer y=1: corner at (3,1,3) connecting north (3,1,2) and east (4,1,3)
    w2.setVoxel(3, 1, 3, "minecraft:stone_brick_wall", undefined, false, 1);
    w2.setVoxel(3, 1, 2, "minecraft:stone_brick_wall", undefined, false, 1);
    w2.setVoxel(4, 1, 3, "minecraft:stone_brick_wall", undefined, false, 1);
    // Upper layer y=2: straight N-S line passing over (3,2,3) -> up="false" on upper wall
    w2.setVoxel(3, 2, 2, "minecraft:stone_brick_wall", undefined, false, 1);
    w2.setVoxel(3, 2, 3, "minecraft:stone_brick_wall", undefined, false, 1);
    w2.setVoxel(3, 2, 4, "minecraft:stone_brick_wall", undefined, false, 1);

    const resolved2 = resolveWorldBlockStates(w2.getAllVoxels(), {
      stone_brick_wall: wallDef,
    });
    expect(resolved2.get("3,2,3")?.up).toBe("false");
    // Bottom corner at (3,1,3) connects north+east (not straight), so up MUST remain "true"
    expect(resolved2.get("3,1,3")?.up).toBe("true");
    // North arm on (3,1,3) is covered by (3,2,3)'s north arm -> becomes "tall"
    expect(resolved2.get("3,1,3")?.north).toBe("tall");

    // 3. Stale voxel.state cleared when resolved state is empty
    const w3 = new VoxelWorld([4, 4, 4]);
    w3.setVoxel(1, 1, 1, "minecraft:stone", undefined, false, 1);
    w3.getVoxel(1, 1, 1)!.state = {};
    w3.resolveBlockStatesWithMap({});
    expect(w3.getVoxel(1, 1, 1)?.state).toBeUndefined();
  });

  it("OffscreenPickerPass & VoxelMesh: normalized (u,v) boundary coordinates and sky vs (255,255,255) terrain alpha encoding", () => {
    // Normalized boundary cases (0, 0.5), (0.5, 0), (1, 0.5), (0.5, 1) MUST resolve as normalized!
    expect(resolvePickerPixelCoords(0, 0.5, 256)).toEqual({ pxU: 0, pxV: 128 });
    expect(resolvePickerPixelCoords(0.5, 0, 256)).toEqual({ pxU: 128, pxV: 0 });
    expect(resolvePickerPixelCoords(1, 0.5, 256)).toEqual({ pxU: 255, pxV: 128 });
    expect(resolvePickerPixelCoords(0.5, 1, 256)).toEqual({ pxU: 128, pxV: 255 });
    // Integer pixel coordinates remain pixel coordinates
    expect(resolvePickerPixelCoords(10, 20, 256)).toEqual({ pxU: 10, pxV: 20 });
    expect(resolvePickerPixelCoords(0, 0, 256)).toEqual({ pxU: 0, pxV: 0 });

    // Sky sentinel vs terrain (opId=0) vs build (opId>=1)
    expect(decodePickerAlphaByte(0)).toEqual({ isSky: true, opId: 0 });

    const terrainAlpha = encodePickerAlphaByte(0);
    expect(terrainAlpha).toBe(255);
    expect(decodePickerAlphaByte(terrainAlpha)).toEqual({ isSky: false, opId: 0 });

    // Build opIds 1..512 MUST never collide with 0 (sky) or 255 (terrain)
    for (let opId = 1; opId <= 512; opId++) {
      const alpha = encodePickerAlphaByte(opId);
      expect(alpha).toBeGreaterThanOrEqual(1);
      expect(alpha).toBeLessThanOrEqual(254);
      const decoded = decodePickerAlphaByte(alpha);
      expect(decoded.isSky).toBe(false);
      expect(decoded.opId).toBe(alpha);
    }
  });

  it("StateTranslator & NBT I/O: modern 1.21+ pillar/lantern translation & fast sparse .mcstructure serialization", async () => {
    for (const pillar of [
      "minecraft:iron_chain",
      "minecraft:copper_chain",
      "minecraft:ochre_froglight",
      "minecraft:muddy_mangrove_roots",
      "minecraft:bamboo_block",
    ]) {
      const br = javaToBedrockState(pillar, { axis: "x" });
      expect(br.states.pillar_axis).toEqual({ type: "string", value: "x" });
      const back = bedrockToJavaState(br.name, br.states);
      expect(back.state?.axis).toBe("x");
    }

    const copperLantern = javaToBedrockState("minecraft:copper_lantern", {
      hanging: "true",
    });
    expect(copperLantern.states.hanging).toEqual({ type: "byte", value: 1 });
    const seaLantern = javaToBedrockState("minecraft:sea_lantern", {});
    expect(seaLantern.states.hanging).toBeUndefined();

    // Empty world .mcstructure round-trip
    const emptyWorld = new VoxelWorld([4, 4, 4]);
    const emptyBuf = await serializeMcstructureBuffer(emptyWorld);
    const parsedEmpty = await parseMcstructureBuffer(emptyBuf);
    expect(parsedEmpty.voxels.size).toBe(0);

    // Sparse large 128x128x128 world serializes rapidly without scanning 2M empty cells
    const bigWorld = new VoxelWorld([128, 128, 128]);
    bigWorld.setVoxel(5, 10, 15, "minecraft:oak_stairs", { facing: "east" }, false, 1);
    bigWorld.setVoxel(120, 100, 110, "minecraft:iron_chain", { axis: "x" }, false, 2);

    const t0 = performance.now();
    const bigBuf = await serializeMcstructureBuffer(bigWorld);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(1500);

    const restoredBig = await parseMcstructureBuffer(bigBuf);
    expect(restoredBig.voxels.size).toBe(2);
    expect(restoredBig.getVoxel(5, 10, 15)?.name).toBe("minecraft:oak_stairs");
    expect(restoredBig.getVoxel(5, 10, 15)?.state?.facing).toBe("east");
    expect(restoredBig.getVoxel(120, 100, 110)?.name).toBe("minecraft:iron_chain");
    expect(restoredBig.getVoxel(120, 100, 110)?.state?.axis).toBe("x");
  });

  it("JarAssetLoader: preserves force_translucent on opaque PNG and marks only synthetic blocks with isFallback=true", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mb-jar-reg-"));
    tempDirs.push(tmpDir);
    const jarPath = path.join(tmpDir, "mock.jar");

    const zip = new AdmZip();
    // Completely opaque PNG (a=255) paired with force_translucent: true
    zip.addFile(
      "assets/minecraft/textures/block/tinted_crystal.png",
      createSolidPng(100, 180, 240, 255)
    );
    zip.addFile(
      "assets/minecraft/models/block/cube_all.json",
      Buffer.from(
        JSON.stringify({
          elements: [
            {
              from: [0, 0, 0],
              to: [16, 16, 16],
              faces: {
                down: { texture: "#all" },
                up: { texture: "#all" },
                north: { texture: "#all" },
                south: { texture: "#all" },
                west: { texture: "#all" },
                east: { texture: "#all" },
              },
            },
          ],
        })
      )
    );
    zip.addFile(
      "assets/minecraft/blockstates/tinted_crystal.json",
      Buffer.from(
        JSON.stringify({
          variants: { "": { model: "minecraft:block/tinted_crystal" } },
        })
      )
    );
    zip.addFile(
      "assets/minecraft/models/block/tinted_crystal.json",
      Buffer.from(
        JSON.stringify({
          parent: "minecraft:block/cube_all",
          textures: {
            all: {
              sprite: "minecraft:block/tinted_crystal",
              force_translucent: true,
            },
          },
        })
      )
    );
    zip.writeZip(jarPath);

    const loader = new JarAssetLoader(jarPath);
    const crystalDef = loader.compileBlockDefinition("tinted_crystal");
    expect(crystalDef.isTranslucent).toBe(true);
    expect(crystalDef.isFullOpaqueCube).toBe(false);
    expect(crystalDef.isFallback).toBeFalsy();

    const missingDef = loader.compileBlockDefinition("nonexistent_custom_block");
    expect(missingDef.isFallback).toBe(true);
  });

  it("StructureLinter & VoxelWorld: caps summary text for huge issue counts and labels decimal heightmap when maxY >= 36", () => {
    const world = new VoxelWorld([40, 50, 40]);
    world.setVoxel(1, 45, 1, "minecraft:stone", undefined, true, 0);
    const terrainSummary = world.getTerrainSummary();
    expect(terrainSummary.maxY).toBe(45);
    expect(terrainSummary.textSummary).toContain("decimal");
    expect(terrainSummary.textSummary).not.toContain("base-36");

    // Generate > 120 hanging lanterns without support
    for (let x = 0; x < 15; x++) {
      for (let z = 0; z < 10; z++) {
        world.setVoxel(
          x * 2,
          10,
          z * 2,
          "minecraft:lantern",
          { hanging: "true" },
          false,
          1
        );
      }
    }
    const report = lintWorldStructure(world.getAllVoxels(), world.traces);
    expect(report.issues.length).toBeGreaterThan(120);
    const capped = formatLintReportSummary(report.issues, 20);
    expect(capped).toContain("omitted");
    const lineCount = capped.split("\n").length;
    expect(lineCount).toBeLessThan(70);
  });

  it("WsBridge: fails fast on viewer ERROR message, routes RENDER_VIEWS only to primary client, and strips duplicate minecraft: blockModels aliases", async () => {
    const bridge = new WsBridge({ wsPort: 0, vitePort: 0, openViewer: false });
    await bridge.start();

    const headlessMsgs: any[] = [];
    const browserMsgs: any[] = [];

    const connectMock = (query: string, inbox: any[]) =>
      new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(
          `ws://127.0.0.1:${bridge.getWsPort()}${query}`
        );
        ws.on("message", (raw) => {
          const msg = JSON.parse(raw.toString());
          inbox.push(msg);
          if (msg.type === "SYNC_WORLD") {
            ws.send(JSON.stringify({ type: "SYNC_ACK", id: msg.id }));
          } else if (msg.type === "RENDER_VIEWS") {
            ws.send(
              JSON.stringify({
                type: "RENDER_RESULT",
                id: msg.id,
                images: { NE: "ne", SE: "se", SW: "sw", NW: "nw" },
              })
            );
          } else if (msg.type === "INSPECT_PIXEL") {
            ws.send(
              JSON.stringify({
                type: "ERROR",
                id: msg.id,
                message: "simulated viewer error",
              })
            );
          }
        });
        ws.once("open", () => resolve(ws));
        ws.once("error", reject);
      });

    let headlessWs: WebSocket | undefined;
    let browserWs: WebSocket | undefined;
    try {
      browserWs = await connectMock("?client=browser", browserMsgs);
      headlessWs = await connectMock("?client=headless", headlessMsgs);
      await new Promise((r) => setTimeout(r, 40));

      const stoneDef: CompiledBlockDefinition = {
        blockName: "stone",
        models: { stone: [] },
        isFullOpaqueCube: true,
        isFluid: false,
        isTranslucent: false,
      };

      // SYNC_WORLD broadcasts to both, stripping redundant "minecraft:stone" key
      await bridge.syncWorld({
        voxels: [],
        size: [8, 8, 8],
        traces: {},
        textures: {},
        blockModels: {
          stone: stoneDef,
          "minecraft:stone": stoneDef,
        },
      });
      const syncedModels = headlessMsgs.find((m) => m.type === "SYNC_WORLD")?.blockModels;
      expect(syncedModels).toBeDefined();
      expect(Object.keys(syncedModels)).toEqual(["stone"]);
      expect(browserMsgs.some((m) => m.type === "SYNC_WORLD")).toBe(true);

      // RENDER_VIEWS routes ONLY to primary (headless) client, NOT visible browser client
      const rendered = await bridge.renderViews(128);
      expect(rendered.NE).toBe("ne");
      expect(headlessMsgs.filter((m) => m.type === "RENDER_VIEWS").length).toBe(1);
      expect(browserMsgs.filter((m) => m.type === "RENDER_VIEWS").length).toBe(0);

      // ERROR response rejects immediately (not 30s timeout)
      const t0 = performance.now();
      await expect(bridge.inspectPixel("NE", 0.5, 0.5)).rejects.toThrow(
        /simulated viewer error/
      );
      expect(performance.now() - t0).toBeLessThan(2000);
    } finally {
      headlessWs?.close();
      browserWs?.close();
      await bridge.stop();
    }
  });

  it("MCP Server: bounds lint summary/JSON, downsamples >64x64 terrain heightmap, and validates CallTool arguments strictly", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mb-mcp-reg-"));
    tempDirs.push(tmpDir);
    const bigTerrainPath = path.join(tmpDir, "big_terrain.nbt");

    const bigTerrain = new VoxelWorld([80, 16, 80]);
    bigTerrain.setVoxel(0, 1, 0, "minecraft:grass_block", undefined, true, 0);
    bigTerrain.setVoxel(79, 5, 79, "minecraft:grass_block", undefined, true, 0);
    await saveStructureNbt(bigTerrain, bigTerrainPath);

    const mcpServer = new MineBuildingMcpServer({
      wsPort: 0,
      vitePort: 0,
      openViewer: false,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "regression-test-client", version: "1.0.0" },
      { capabilities: {} }
    );

    try {
      await Promise.all([
        mcpServer.server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      // 1. Strict CallTool argument validation (missing jsCode, non-numeric u/v, invalid boolean)
      const missingJs = await client.callTool({
        name: "run_build_script",
        arguments: {},
      });
      expect(missingJs.isError).toBe(true);
      expect((missingJs.content as Array<{ text: string }>)[0].text).toContain("jsCode");

      const badInspect = await client.callTool({
        name: "inspect_pixel",
        arguments: { view: "NE", u: "", v: 0.5 },
      });
      expect(badInspect.isError).toBe(true);
      expect((badInspect.content as Array<{ text: string }>)[0].text).toContain("u");

      const badBool = await client.callTool({
        name: "open_viewer",
        arguments: { force: "not-a-bool" },
      });
      expect(badBool.isError).toBe(true);
      expect((badBool.content as Array<{ text: string }>)[0].text).toContain("force");

      // 2. Large terrain heightmap JSON downsampling
      const loadRes = await mcpServer.handleLoadTerrain({ nbtPath: bigTerrainPath });
      expect(loadRes.isError).toBeFalsy();
      const loadText = (loadRes.content[0] as { type: "text"; text: string }).text;
      const jsonIdx = loadText.indexOf("JSON Details:\n");
      expect(jsonIdx).toBeGreaterThan(-1);
      const parsedTerrain = JSON.parse(
        loadText.slice(jsonIdx + "JSON Details:\n".length)
      );
      expect(parsedTerrain.heightmapStep).toEqual([3, 3]);
      expect(parsedTerrain.heightmap.length).toBeLessThanOrEqual(32);
      expect(parsedTerrain.heightmap[0].length).toBeLessThanOrEqual(32);

      // 3. handleLintStructure caps both summary text AND JSON details
      for (let x = 2; x < 52; x += 2) {
        for (let z = 2; z < 22; z += 2) {
          mcpServer.world.setVoxel(
            x,
            10,
            z,
            "minecraft:lantern",
            { hanging: "true" },
            false,
            1
          );
        }
      }
      const lintRes = await mcpServer.handleLintStructure();
      const lintText = (lintRes.content[0] as { type: "text"; text: string }).text;
      expect(lintText).toContain("omitted");
      const lintJsonIdx = lintText.indexOf("JSON Details:\n");
      const parsedLint = JSON.parse(
        lintText.slice(lintJsonIdx + "JSON Details:\n".length)
      );
      expect(parsedLint.issueCount).toBeGreaterThan(MAX_LINT_ISSUES);
      expect(parsedLint.issues.length).toBe(MAX_LINT_ISSUES);
      expect(parsedLint.issuesTruncatedCount).toBe(
        parsedLint.issueCount - MAX_LINT_ISSUES
      );
    } finally {
      await client.close();
      await mcpServer.close();
    }
  }, 30000);
});

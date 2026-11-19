import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { PNG } from "pngjs";
import { describe, it, expect, afterEach } from "vitest";
import { WebSocket } from "ws";
import { JarAssetLoader, detectMinecraftJarPath } from "../src/assets/jar-loader.js";
import { MineBuildingMcpServer } from "../src/mcp/server.js";
import { WsBridge } from "../src/mcp/ws-bridge.js";
import type { CompiledBlockDefinition } from "../src/types/shared.js";
import { resolveActiveModelParts } from "../src/viewer/voxel-mesh.js";

function createTinyPngBuffer(r: number, g: number, b: number, a: number): Buffer {
  const png = new PNG({ width: 16, height: 16 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = r;
    png.data[i + 1] = g;
    png.data[i + 2] = b;
    png.data[i + 3] = a;
  }
  return PNG.sync.write(png);
}

describe("Issue #3, #4, and Vertical Block Default Facing Unit Tests", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Issue #3: handles MC 1.21.4+ object texture references ({ sprite, force_translucent }) and malformed entries safely", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mb-jar-test-"));
    tempDirs.push(tmpDir);
    const jarPath = path.join(tmpDir, "mock-mc-1.21.4.jar");

    const zip = new AdmZip();
    const glassPng = createTinyPngBuffer(180, 230, 255, 128);
    const paneTopPng = createTinyPngBuffer(140, 200, 240, 255);
    zip.addFile("assets/minecraft/textures/block/glass.png", glassPng);
    zip.addFile("assets/minecraft/textures/block/glass_pane_top.png", paneTopPng);

    // cube_all parent model
    zip.addFile(
      "assets/minecraft/models/block/cube_all.json",
      Buffer.from(
        JSON.stringify({
          elements: [
            {
              from: [0, 0, 0],
              to: [16, 16, 16],
              faces: {
                down: { texture: "#all", cullface: "down" },
                up: { texture: "#all", cullface: "up" },
                north: { texture: "#all", cullface: "north" },
                south: { texture: "#all", cullface: "south" },
                west: { texture: "#all", cullface: "west" },
                east: { texture: "#all", cullface: "east" },
              },
            },
          ],
        })
      )
    );

    // glass blockstate + object-style texture ref
    zip.addFile(
      "assets/minecraft/blockstates/glass.json",
      Buffer.from(JSON.stringify({ variants: { "": { model: "minecraft:block/glass" } } }))
    );
    zip.addFile(
      "assets/minecraft/models/block/glass.json",
      Buffer.from(
        JSON.stringify({
          parent: "minecraft:block/cube_all",
          textures: {
            all: {
              force_translucent: true,
              sprite: "minecraft:block/glass",
            },
          },
        })
      )
    );

    // glass_pane with #pane indirection pointing to { sprite: ... }
    zip.addFile(
      "assets/minecraft/blockstates/glass_pane.json",
      Buffer.from(
        JSON.stringify({
          multipart: [{ apply: { model: "minecraft:block/glass_pane_post" } }],
        })
      )
    );
    zip.addFile(
      "assets/minecraft/models/block/template_glass_pane_post.json",
      Buffer.from(
        JSON.stringify({
          textures: { particle: "#pane" },
          elements: [
            {
              from: [7, 0, 7],
              to: [9, 16, 9],
              faces: {
                up: { texture: "#edge" },
                down: { texture: "#edge" },
                north: { texture: "#pane" },
              },
            },
          ],
        })
      )
    );
    zip.addFile(
      "assets/minecraft/models/block/glass_pane_post.json",
      Buffer.from(
        JSON.stringify({
          parent: "minecraft:block/template_glass_pane_post",
          textures: {
            edge: { force_translucent: true, sprite: "minecraft:block/glass_pane_top" },
            pane: { force_translucent: true, sprite: "minecraft:block/glass" },
          },
        })
      )
    );

    // Malformed texture object without string sprite -> graceful procedural fallback
    zip.addFile(
      "assets/minecraft/blockstates/broken_block.json",
      Buffer.from(JSON.stringify({ variants: { "": { model: "minecraft:block/broken_block" } } }))
    );
    zip.addFile(
      "assets/minecraft/models/block/broken_block.json",
      Buffer.from(
        JSON.stringify({
          parent: "minecraft:block/cube_all",
          textures: {
            all: { invalid: 123 },
          },
        })
      )
    );

    zip.writeZip(jarPath);

    const loader = new JarAssetLoader(jarPath);
    const glassDef = loader.compileBlockDefinition("minecraft:glass");
    expect(glassDef.models.glass[0].faces.north?.textureKey).toBe("glass");

    const paneDef = loader.compileBlockDefinition("minecraft:glass_pane");
    expect(paneDef.models.glass_pane_post[0].faces.up?.textureKey).toBe("glass_pane_top");
    expect(paneDef.models.glass_pane_post[0].faces.north?.textureKey).toBe("glass");

    const brokenDef = loader.compileBlockDefinition("minecraft:broken_block");
    expect(brokenDef.models.broken_block[0].faces.north?.textureKey).toBe("broken_block");

    const textures = loader.getTexturesForBlocks([
      "minecraft:glass",
      "minecraft:glass_pane",
      "minecraft:broken_block",
    ]);
    expect(textures.glass).toBe(`data:image/png;base64,${glassPng.toString("base64")}`);
    expect(textures.glass_pane_top).toBe(
      `data:image/png;base64,${paneTopPng.toString("base64")}`
    );
    expect(textures.broken_block.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("Issue #3 (local jar): compiles glass and stained glass blocks cleanly when local Minecraft .jar exists", () => {
    const detectedJar = detectMinecraftJarPath();
    if (!detectedJar) return;

    const loader = new JarAssetLoader(detectedJar);
    const blocks = [
      "glass",
      "glass_pane",
      "light_blue_stained_glass",
      "blue_stained_glass",
      "cyan_stained_glass",
    ];
    for (const block of blocks) {
      const def = loader.compileBlockDefinition(block);
      expect(def.blockName).toBe(block);
      expect(Object.keys(def.models).length).toBeGreaterThan(0);
    }
    const textures = loader.getTexturesForBlocks(blocks);
    for (const block of blocks) {
      expect(textures[block]?.startsWith("data:image/png;base64,")).toBe(true);
    }
  });

  it("Vertical block default facing: end_rod, lightning_rod, amethyst_cluster default to up; hopper to down; observer to south; barrel/stairs to north", () => {
    const emptyMap = new Map();

    const endRodDef: CompiledBlockDefinition = {
      blockName: "end_rod",
      variants: {
        "facing=down": [{ model: "end_rod", x: 180 }],
        "facing=east": [{ model: "end_rod", x: 90, y: 90 }],
        "facing=north": [{ model: "end_rod", x: 90 }],
        "facing=south": [{ model: "end_rod", x: 90, y: 180 }],
        "facing=up": [{ model: "end_rod" }],
        "facing=west": [{ model: "end_rod", x: 90, y: 270 }],
      },
      models: { end_rod: [] },
      isFullOpaqueCube: false,
      isFluid: false,
      isTranslucent: false,
    };

    // Unspecified state -> vertical UP (no x/y rotation)
    const defaultRodParts = resolveActiveModelParts(
      { x: 0, y: 0, z: 0, name: "minecraft:end_rod", isTerrain: false, opId: 1 },
      endRodDef,
      emptyMap
    );
    expect(defaultRodParts).toEqual([{ model: "end_rod" }]);

    // Explicit states respected
    expect(
      resolveActiveModelParts(
        {
          x: 0,
          y: 0,
          z: 0,
          name: "minecraft:end_rod",
          state: { facing: "north" },
          isTerrain: false,
          opId: 1,
        },
        endRodDef,
        emptyMap
      )
    ).toEqual([{ model: "end_rod", x: 90 }]);
    expect(
      resolveActiveModelParts(
        {
          x: 0,
          y: 0,
          z: 0,
          name: "minecraft:end_rod",
          state: { facing: "down" },
          isTerrain: false,
          opId: 1,
        },
        endRodDef,
        emptyMap
      )
    ).toEqual([{ model: "end_rod", x: 180 }]);
    expect(
      resolveActiveModelParts(
        {
          x: 0,
          y: 0,
          z: 0,
          name: "minecraft:end_rod",
          state: { facing: "east" },
          isTerrain: false,
          opId: 1,
        },
        endRodDef,
        emptyMap
      )
    ).toEqual([{ model: "end_rod", x: 90, y: 90 }]);
    expect(
      resolveActiveModelParts(
        {
          x: 0,
          y: 0,
          z: 0,
          name: "minecraft:end_rod",
          state: { facing: "south" },
          isTerrain: false,
          opId: 1,
        },
        endRodDef,
        emptyMap
      )
    ).toEqual([{ model: "end_rod", x: 90, y: 180 }]);
    expect(
      resolveActiveModelParts(
        {
          x: 0,
          y: 0,
          z: 0,
          name: "minecraft:end_rod",
          state: { facing: "west" },
          isTerrain: false,
          opId: 1,
        },
        endRodDef,
        emptyMap
      )
    ).toEqual([{ model: "end_rod", x: 90, y: 270 }]);

    // Lightning rod & amethyst cluster default to facing=up
    for (const upName of ["lightning_rod", "waxed_oxidized_lightning_rod", "amethyst_cluster", "large_amethyst_bud"]) {
      const def: CompiledBlockDefinition = {
        ...endRodDef,
        blockName: upName,
        variants: {
          "facing=north": [{ model: upName, x: 90 }],
          "facing=up": [{ model: upName }],
        },
      };
      expect(
        resolveActiveModelParts(
          { x: 0, y: 0, z: 0, name: `minecraft:${upName}`, isTerrain: false, opId: 1 },
          def,
          emptyMap
        )
      ).toEqual([{ model: upName }]);
    }

    // Hopper defaults to facing=down
    const hopperDef: CompiledBlockDefinition = {
      blockName: "hopper",
      variants: {
        "facing=north": [{ model: "hopper_side" }],
        "facing=down": [{ model: "hopper" }],
      },
      models: { hopper: [], hopper_side: [] },
      isFullOpaqueCube: false,
      isFluid: false,
      isTranslucent: false,
    };
    expect(
      resolveActiveModelParts(
        { x: 0, y: 0, z: 0, name: "minecraft:hopper", isTerrain: false, opId: 1 },
        hopperDef,
        emptyMap
      )
    ).toEqual([{ model: "hopper" }]);

    // Observer defaults to facing=south when north is not present (data-driven variant fallback)
    const observerDef: CompiledBlockDefinition = {
      blockName: "observer",
      variants: {
        "facing=south,powered=false": [{ model: "observer", y: 180 }],
        "facing=south,powered=true": [{ model: "observer_on", y: 180 }],
        "facing=east,powered=false": [{ model: "observer", y: 90 }],
      },
      models: { observer: [], observer_on: [] },
      isFullOpaqueCube: true,
      isFluid: false,
      isTranslucent: false,
    };
    expect(
      resolveActiveModelParts(
        { x: 0, y: 0, z: 0, name: "minecraft:observer", isTerrain: false, opId: 1 },
        observerDef,
        emptyMap
      )
    ).toEqual([{ model: "observer", y: 180 }]);

    // Barrel & oak_stairs still default to facing=north
    const barrelDef: CompiledBlockDefinition = {
      blockName: "barrel",
      variants: {
        "facing=up": [{ model: "barrel" }],
        "facing=north": [{ model: "barrel", x: 90 }],
      },
      models: { barrel: [] },
      isFullOpaqueCube: true,
      isFluid: false,
      isTranslucent: false,
    };
    expect(
      resolveActiveModelParts(
        { x: 0, y: 0, z: 0, name: "minecraft:barrel", isTerrain: false, opId: 1 },
        barrelDef,
        emptyMap
      )
    ).toEqual([{ model: "barrel", x: 90 }]);
  });

  it("Issue #4: WsBridge.openViewerInBrowser and MineBuildingMcpServer.handleOpenViewer avoid duplicate launches and respect visible clients", async () => {
    const openedUrls: string[] = [];
    const bridge = new WsBridge({
      wsPort: 0,
      vitePort: 0,
      openViewer: true,
      openUrlFn: (url) => {
        openedUrls.push(url);
      },
    });

    try {
      const first = await bridge.openViewerInBrowser();
      expect(first.opened).toBe(true);
      expect(first.reason).toBe("opened");
      expect(first.url).toBe(bridge.getViteUrl());
      expect(openedUrls).toEqual([bridge.getViteUrl()]);

      // Second call without force -> already_opened, no duplicate launch
      const second = await bridge.openViewerInBrowser();
      expect(second.opened).toBe(false);
      expect(second.reason).toBe("already_opened");
      expect(openedUrls.length).toBe(1);

      // Force opens again
      const forced = await bridge.openViewerInBrowser({ force: true });
      expect(forced.opened).toBe(true);
      expect(forced.reason).toBe("opened");
      expect(openedUrls.length).toBe(2);

      // Connect a visible browser WebSocket client -> skips opening unless forced
      const ws = new WebSocket(`ws://127.0.0.1:${bridge.getWsPort()}`);
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });
      // Allow server connection handler to register
      await new Promise((r) => setTimeout(r, 30));
      expect(bridge.getVisibleClientCount()).toBe(1);

      const third = await bridge.openViewerInBrowser();
      expect(third.opened).toBe(false);
      expect(third.reason).toBe("already_connected");
      expect(third.visibleClients).toBe(1);
      expect(openedUrls.length).toBe(2);

      ws.close();
    } finally {
      await bridge.stop();
    }

    // Verify MineBuildingMcpServer.handleOpenViewer returns viewerUrl cleanly
    const serverOpenedUrls: string[] = [];
    const mcpServer = new MineBuildingMcpServer({
      wsPort: 0,
      vitePort: 0,
      openViewer: false,
      openUrlFn: (url) => {
        serverOpenedUrls.push(url);
      },
    });
    try {
      const res = await mcpServer.handleOpenViewer();
      expect(res.isError).toBeFalsy();
      const text = (res.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain(mcpServer.wsBridge.getViteUrl());
      expect(serverOpenedUrls).toEqual([mcpServer.wsBridge.getViteUrl()]);
    } finally {
      await mcpServer.close();
    }
  });
});

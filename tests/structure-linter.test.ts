import { describe, expect, it } from "vitest";
import {
  detectMinecraftJarPath,
  JarAssetLoader,
} from "../src/assets/jar-loader.js";
import { executeBuildScript } from "../src/core/builder-dsl.js";
import {
  isSlenderAxisBlock,
  lintWorldStructure,
} from "../src/core/structure-linter.js";
import { VoxelWorld } from "../src/core/voxel-world.js";
import {
  buildArchitecturalWorkflowPrompt,
  MAX_LINT_FLOATING_BLOCKS,
  MineBuildingMcpServer,
} from "../src/mcp/server.js";

const detectedJar = detectMinecraftJarPath();
const loader = new JarAssetLoader(detectedJar ?? undefined);

describe("Vanilla Building Linter (Minecraft Spec Consistency Check) & Pre-Design Research Workflow", () => {
  it("1. Detects T-junction and L-junction cross-axis chains (axis_mismatch_junction) with DSL line trace, ignores full-cube log framing, and clears warnings when a joint block is inserted", () => {
    const world = new VoxelWorld([16, 16, 16]);

    // Build two stone pillars at x=2 and x=8, a horizontal chain beam (axis=x) at y=10, z=5 (Line 4),
    // and hang a vertical chain (axis=y) directly from the middle (5, 10, 5) down to (5, 8, 5) (Line 5 -> T-junction break!)
    const badTChainScript = [
      "// Line 1: Pillars + T-junction chain test",
      'fillBox(2, 0, 5, 2, 10, 5, "stone_bricks");',
      'fillBox(8, 0, 5, 8, 10, 5, "stone_bricks");',
      'for (let x = 3; x <= 7; x++) setBlock(x, 10, 5, "chain", { axis: "x" });',
      'for (let y = 8; y <= 9; y++) setBlock(5, y, 5, "chain", { axis: "y" });',
    ].join("\n");

    const badExec = executeBuildScript(world, badTChainScript, true);
    const blockModels = loader.getBlockModelsForBlocks([
      "stone_bricks",
      "chain",
      "iron_chain",
      "oak_log",
      "spruce_fence",
      "grindstone",
    ]);

    // Verify data-driven slender axis detection distinguishes slender chains from full-cube oak_log
    expect(
      isSlenderAxisBlock(
        { x: 3, y: 10, z: 5, name: "minecraft:chain", state: { axis: "x" }, isTerrain: false, opId: 3 },
        blockModels["chain"],
        blockModels
      )
    ).toBe(true);
    expect(
      isSlenderAxisBlock(
        { x: 0, y: 0, z: 0, name: "minecraft:oak_log", state: { axis: "x" }, isTerrain: false, opId: 1 },
        blockModels["oak_log"],
        blockModels
      )
    ).toBe(false);

    const badLint = world.lintStructure(blockModels);
    expect(badLint.valid).toBe(false);
    expect(badLint.countsByType.axis_mismatch_junction).toBeGreaterThanOrEqual(1);

    const axisIssues = badLint.issues.filter(
      (i) => i.type === "axis_mismatch_junction"
    );
    // Both the horizontal junction chain (5,10,5) (Line 4) and vertical top chain (5,9,5) (Line 5) participate
    expect(
      axisIssues.some(
        (i) =>
          i.coord.x === 5 &&
          i.coord.y === 10 &&
          i.coord.z === 5 &&
          i.line === 4 &&
          i.hint.includes("フェンス")
      )
    ).toBe(true);
    expect(
      axisIssues.some(
        (i) =>
          i.coord.x === 5 &&
          i.coord.y === 9 &&
          i.coord.z === 5 &&
          i.line === 5 &&
          i.codeSnippet?.includes("setBlock")
      )
    ).toBe(true);
    expect(badExec.evaluation.lintIssues?.some((i) => i.type === "axis_mismatch_junction")).toBe(
      true
    );

    // Fix: Insert a connector block (spruce_fence or grindstone) at the T-junction intersection (5, 10, 5)
    // and also add an oak_log T-frame (vertical oak_log axis=y meeting horizontal oak_log axis=x) to prove logs are not flagged
    const fixedTChainScript = [
      "// Line 1: Fixed T-junction with spruce_fence connector at (5, 10, 5) + valid oak_log timber frame",
      'fillBox(2, 0, 5, 2, 10, 5, "stone_bricks");',
      'fillBox(8, 0, 5, 8, 10, 5, "stone_bricks");',
      'for (let x = 3; x <= 7; x++) { if (x !== 5) setBlock(x, 10, 5, "chain", { axis: "x" }); }',
      'setBlock(5, 10, 5, "spruce_fence");',
      'for (let y = 8; y <= 9; y++) setBlock(5, y, 5, "chain", { axis: "y" });',
      'setBlock(2, 5, 2, "oak_log", { axis: "y" });',
      'setBlock(3, 5, 2, "oak_log", { axis: "x" });',
    ].join("\n");

    executeBuildScript(world, fixedTChainScript, true);
    world.resolveBlockStates(blockModels);
    const fixedLint = world.lintStructure(blockModels);
    expect(fixedLint.countsByType.axis_mismatch_junction).toBe(0);
    expect(fixedLint.valid).toBe(true);
    expect(fixedLint.issues).toEqual([]);
  });

  it("2. Detects unsupported wall-clinging blocks (vine / glow_lichen) and clears warnings once a solid backing wall is placed (including multi-block hanging vines)", () => {
    const world = new VoxelWorld([16, 16, 16]);
    const blockModels = loader.getBlockModelsForBlocks([
      "vine",
      "glow_lichen",
      "stone_bricks",
      "spruce_fence",
    ]);

    // Bad script:
    // - Line 2: Isolated vine at (5, 6, 5) with air in all directions
    // - Line 3: Vine at (10, 6, 5) explicitly set to { north: "true" } where (10, 6, 4) is air,
    //           even though a non-attached stone_bricks sits to the east at (11, 6, 5)
    // - Line 4: Isolated glow_lichen at (7, 6, 7) with air on all 6 faces
    const badVineScript = [
      "// Line 1: Unsupported wall-clinging blocks",
      'setBlock(5, 6, 5, "vine");',
      'setBlock(11, 6, 5, "stone_bricks"); setBlock(10, 6, 5, "vine", { north: "true" });',
      'setBlock(7, 6, 7, "glow_lichen");',
    ].join("\n");

    executeBuildScript(world, badVineScript, true);
    world.resolveBlockStates(blockModels);
    const badLint = world.lintStructure(blockModels);

    expect(badLint.valid).toBe(false);
    expect(badLint.countsByType.missing_support).toBe(3);
    expect(
      badLint.issues.some(
        (i) =>
          i.type === "missing_support" &&
          i.coord.x === 5 &&
          i.coord.y === 6 &&
          i.coord.z === 5 &&
          i.line === 2
      )
    ).toBe(true);
    expect(
      badLint.issues.some(
        (i) =>
          i.type === "missing_support" &&
          i.coord.x === 10 &&
          i.coord.y === 6 &&
          i.coord.z === 5 &&
          i.line === 3
      )
    ).toBe(true);
    expect(
      badLint.issues.some(
        (i) =>
          i.type === "missing_support" &&
          i.coord.x === 7 &&
          i.coord.y === 6 &&
          i.coord.z === 7 &&
          i.line === 4
      )
    ).toBe(true);

    // Fix: Place solid stone_bricks walls behind each vine/lichen, plus hang a 3-block vine curtain (y=6, 5, 4) from the top vine at (5, 6, 5)
    const fixedVineScript = [
      "// Line 1: Properly backed vines (with 3-block hanging vine curtain) & glow_lichen",
      'setBlock(5, 6, 4, "stone_bricks");',
      'setBlock(5, 6, 5, "vine"); setBlock(5, 5, 5, "vine"); setBlock(5, 4, 5, "vine");',
      'setBlock(10, 6, 4, "stone_bricks"); setBlock(10, 6, 5, "vine", { north: "true" });',
      'setBlock(7, 5, 7, "stone_bricks"); setBlock(7, 6, 7, "glow_lichen");',
    ].join("\n");

    executeBuildScript(world, fixedVineScript, true);
    world.resolveBlockStates(blockModels);
    const fixedLint = world.lintStructure(blockModels);

    expect(fixedLint.countsByType.missing_support).toBe(0);
    expect(fixedLint.valid).toBe(true);
    expect(fixedLint.issues).toEqual([]);
  });

  it("3. Detects unsupported hanging/standing blocks (lanterns, bells, wall_torch) and clears warnings when valid support is added", () => {
    const world = new VoxelWorld([16, 16, 16]);
    const blockModels = loader.getBlockModelsForBlocks([
      "lantern",
      "soul_lantern",
      "stone_bricks",
      "chain",
      "iron_chain",
      "spruce_fence",
      "bell",
      "wall_torch",
    ]);

    // Bad script:
    // - Line 2: Hanging lantern at (4, 6, 4) with AIR above at (4, 7, 4) (touching stone_bricks sideways at (4, 6, 3))
    // - Line 3: Hanging soul_lantern at (7, 6, 4) directly below a HORIZONTAL chain (axis=x) at (7, 7, 4)
    // - Line 4: Standing floor lantern (hanging=false) at (10, 6, 4) with AIR below at (10, 5, 4)
    // - Line 5: Wall torch facing=south at (12, 6, 5) with AIR at its north backing wall (12, 6, 4)
    const badSupportScript = [
      "// Line 1: Unsupported lanterns and wall_torch",
      'setBlock(4, 6, 3, "stone_bricks"); setBlock(4, 6, 4, "lantern", { hanging: "true" });',
      'setBlock(7, 7, 4, "chain", { axis: "x" }); setBlock(7, 6, 4, "soul_lantern", { hanging: "true" });',
      'setBlock(10, 6, 4, "lantern", { hanging: "false" });',
      'setBlock(12, 6, 5, "wall_torch", { facing: "south" });',
    ].join("\n");

    executeBuildScript(world, badSupportScript, true);
    world.resolveBlockStates(blockModels);
    const badLint = lintWorldStructure(
      world.getAllVoxels(),
      blockModels,
      world.traces,
      world.getExplicitStateKeysMap()
    );

    expect(badLint.valid).toBe(false);
    expect(badLint.countsByType.missing_support).toBe(4);
    expect(
      badLint.issues.some(
        (i) => i.coord.x === 4 && i.coord.y === 6 && i.coord.z === 4 && i.line === 2
      )
    ).toBe(true);
    expect(
      badLint.issues.some(
        (i) => i.coord.x === 7 && i.coord.y === 6 && i.coord.z === 4 && i.line === 3
      )
    ).toBe(true);
    expect(
      badLint.issues.some(
        (i) => i.coord.x === 10 && i.coord.y === 6 && i.coord.z === 4 && i.line === 4
      )
    ).toBe(true);
    expect(
      badLint.issues.some(
        (i) => i.coord.x === 12 && i.coord.y === 6 && i.coord.z === 5 && i.line === 5
      )
    ).toBe(true);

    // Fix:
    // - Place spruce_fence at (4, 7, 4) above the first hanging lantern
    // - Use a vertical chain (axis=y) at (7, 7, 4) anchored to stone_bricks at (7, 8, 4) above the soul_lantern
    // - Place stone_bricks floor at (10, 5, 4) below the floor lantern
    // - Place stone_bricks backing wall at (12, 6, 4) behind the south-facing wall_torch
    const fixedSupportScript = [
      "// Line 1: Properly supported lanterns and wall_torch",
      'setBlock(4, 7, 4, "spruce_fence"); setBlock(4, 6, 4, "lantern", { hanging: "true" });',
      'setBlock(7, 8, 4, "stone_bricks"); setBlock(7, 7, 4, "chain", { axis: "y" }); setBlock(7, 6, 4, "soul_lantern", { hanging: "true" });',
      'setBlock(10, 5, 4, "stone_bricks"); setBlock(10, 6, 4, "lantern", { hanging: "false" });',
      'setBlock(12, 6, 4, "stone_bricks"); setBlock(12, 6, 5, "wall_torch", { facing: "south" });',
    ].join("\n");

    executeBuildScript(world, fixedSupportScript, true);
    world.resolveBlockStates(blockModels);
    const fixedLint = world.lintStructure(blockModels);

    expect(fixedLint.countsByType.missing_support).toBe(0);
    expect(fixedLint.countsByType.axis_mismatch_junction).toBe(0);
    expect(fixedLint.valid).toBe(true);
  });

  it("4. Exposes lint_structure tool and pre-design idiom research workflow prompt via MineBuildingMcpServer", async () => {
    const promptText = buildArchitecturalWorkflowPrompt("Cliffside Monastery & Suspension Bridge");
    expect(promptText).toContain("Phase 1: 設計前リサーチ");
    expect(promptText).toContain("Cliffside Monastery & Suspension Bridge");
    expect(promptText).toContain("axis_mismatch_junction");
    expect(promptText).toContain("missing_support");
    expect(promptText).toContain("lint_structure");

    const mcpServer = new MineBuildingMcpServer({
      wsPort: 0,
      vitePort: 0,
      openViewer: false,
    });
    try {
      // Inject a broken chain T-junction into mcpServer.world and run handleLintStructure()
      executeBuildScript(
        mcpServer.world,
        [
          'setBlock(5, 5, 5, "chain", { axis: "x" });',
          'setBlock(5, 4, 5, "chain", { axis: "y" });',
        ].join("\n"),
        true
      );
      const lintRes1 = await mcpServer.handleLintStructure();
      expect(lintRes1.isError).toBeFalsy();
      const text1 = (lintRes1.content[0] as { type: "text"; text: string }).text;
      expect(text1).toContain("axis_mismatch_junction");
      expect(text1).toContain("Line 1");
      expect(text1).toContain("Line 2");

      // Fix by replacing (5,5,5) with a fence connector
      executeBuildScript(
        mcpServer.world,
        [
          'setBlock(4, 5, 5, "chain", { axis: "x" });',
          'setBlock(5, 5, 5, "spruce_fence");',
          'setBlock(6, 5, 5, "chain", { axis: "x" });',
          'setBlock(5, 4, 5, "chain", { axis: "y" });',
        ].join("\n"),
        true
      );
      const lintRes2 = await mcpServer.handleLintStructure();
      const text2 = (lintRes2.content[0] as { type: "text"; text: string }).text;
      expect(text2).toContain("PASSED (0 spec/support issues detected)");
    } finally {
      await mcpServer.close();
    }
  });

  it("5. evaluateStructure() handles >= 150,000 floating blocks sharing a single opId without V8 stack overflow", () => {
    const world = new VoxelWorld([256, 256, 256]);
    for (let x = 10; x < 110; x++) {
      for (let y = 10; y <= 24; y++) {
        for (let z = 10; z < 110; z++) {
          world.setVoxel(x, y, z, "minecraft:stone", undefined, false, 1);
        }
      }
    }

    const evaluation = world.evaluateStructure();
    expect(evaluation.valid).toBe(false);
    expect(evaluation.floatingBlocks.length).toBe(150_000);
    expect(evaluation.floatingClustersCount).toBe(1);
    expect(evaluation.warnings.length).toBe(1);
    expect(evaluation.warnings[0]).toContain("150000 block(s)");
    expect(evaluation.warnings[0]).toContain("distanceToGround=0..10");
  });

  it("6. handleLintStructure() caps serialized floatingBlocks to prevent JSON-RPC overflow while preserving small counts", async () => {
    const mcpServer = new MineBuildingMcpServer({
      wsPort: 0,
      vitePort: 0,
      openViewer: false,
    });
    try {
      // Small-count case (<= MAX_LINT_FLOATING_BLOCKS)
      for (let x = 5; x < 10; x++) {
        mcpServer.world.setVoxel(x, 10, 5, "minecraft:stone", undefined, false, 1);
      }
      const smallRes = await mcpServer.handleLintStructure();
      expect(smallRes.isError).toBeFalsy();
      const smallText = (smallRes.content[0] as { type: "text"; text: string }).text;
      expect(smallText).toContain("Floating Blocks: 5 across 1 cluster(s)");
      const smallMarker = "JSON Details:\n";
      const smallJson = JSON.parse(
        smallText.slice(smallText.indexOf(smallMarker) + smallMarker.length)
      );
      expect(smallJson.floatingBlocksCount).toBe(5);
      expect(smallJson.floatingClustersCount).toBe(1);
      expect(smallJson.floatingBlocks.length).toBe(5);
      expect(smallJson.floatingBlocksTruncatedCount).toBe(0);
      expect(smallJson.issuesTruncatedCount).toBe(0);

      // Large-count case (50,000 floating blocks)
      mcpServer.world = new VoxelWorld([64, 64, 64]);
      for (let x = 5; x < 55; x++) {
        for (let y = 10; y <= 29; y++) {
          for (let z = 5; z < 55; z++) {
            mcpServer.world.setVoxel(x, y, z, "minecraft:stone", undefined, false, 1);
          }
        }
      }

      const largeRes = await mcpServer.handleLintStructure();
      expect(largeRes.isError).toBeFalsy();
      const largeText = (largeRes.content[0] as { type: "text"; text: string }).text;
      expect(largeText.length).toBeLessThan(100_000);
      expect(largeText).toContain(
        `Floating Blocks: 50000 across 1 cluster(s) (showing first ${MAX_LINT_FLOATING_BLOCKS}, 49900 omitted)`
      );

      const largeJson = JSON.parse(
        largeText.slice(largeText.indexOf(smallMarker) + smallMarker.length)
      );
      expect(largeJson.valid).toBe(false);
      expect(largeJson.lintValid).toBe(true);
      expect(largeJson.structuralValid).toBe(false);
      expect(largeJson.floatingBlocksCount).toBe(50_000);
      expect(largeJson.floatingClustersCount).toBeGreaterThanOrEqual(1);
      expect(largeJson.floatingBlocks.length).toBe(MAX_LINT_FLOATING_BLOCKS);
      expect(largeJson.floatingBlocksTruncatedCount).toBe(50_000 - MAX_LINT_FLOATING_BLOCKS);
    } finally {
      await mcpServer.close();
    }
  });
});

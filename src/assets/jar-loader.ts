import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import AdmZip from "adm-zip";
import { PNG } from "pngjs";

const BLOCK_TEXTURE_PREFIX = "assets/minecraft/textures/block/";

/**
 * Strips "minecraft:" namespace and block state brackets `[...]` if present,
 * returning a clean lowercase block identifier (e.g., "oak_stairs").
 */
export function normalizeBlockName(blockName: string): string {
  let clean = blockName.trim().toLowerCase();
  if (clean.startsWith("minecraft:")) {
    clean = clean.slice("minecraft:".length);
  }
  const bracketIdx = clean.indexOf("[");
  if (bracketIdx !== -1) {
    clean = clean.slice(0, bracketIdx);
  }
  return clean;
}

/**
 * Explicit alias map from normalized block names to candidate PNG filenames
 * inside `assets/minecraft/textures/block/` (without `.png` extension).
 */
const EXPLICIT_TEXTURE_MAP: Record<string, string[]> = {
  // Wood stairs, slabs, fences, gates
  oak_stairs: ["oak_planks"],
  oak_slab: ["oak_planks"],
  oak_fence: ["oak_planks"],
  oak_fence_gate: ["oak_planks"],
  spruce_stairs: ["spruce_planks"],
  spruce_slab: ["spruce_planks"],
  spruce_fence: ["spruce_planks"],
  spruce_fence_gate: ["spruce_planks"],
  birch_stairs: ["birch_planks"],
  birch_slab: ["birch_planks"],
  birch_fence: ["birch_planks"],
  birch_fence_gate: ["birch_planks"],
  jungle_stairs: ["jungle_planks"],
  jungle_slab: ["jungle_planks"],
  jungle_fence: ["jungle_planks"],
  jungle_fence_gate: ["jungle_planks"],
  acacia_stairs: ["acacia_planks"],
  acacia_slab: ["acacia_planks"],
  acacia_fence: ["acacia_planks"],
  acacia_fence_gate: ["acacia_planks"],
  dark_oak_stairs: ["dark_oak_planks"],
  dark_oak_slab: ["dark_oak_planks"],
  dark_oak_fence: ["dark_oak_planks"],
  dark_oak_fence_gate: ["dark_oak_planks"],
  mangrove_stairs: ["mangrove_planks"],
  mangrove_slab: ["mangrove_planks"],
  mangrove_fence: ["mangrove_planks"],
  mangrove_fence_gate: ["mangrove_planks"],
  cherry_stairs: ["cherry_planks"],
  cherry_slab: ["cherry_planks"],
  cherry_fence: ["cherry_planks"],
  cherry_fence_gate: ["cherry_planks"],
  bamboo_stairs: ["bamboo_planks"],
  bamboo_slab: ["bamboo_planks"],
  bamboo_fence: ["bamboo_planks"],
  bamboo_fence_gate: ["bamboo_planks"],
  crimson_stairs: ["crimson_planks"],
  crimson_slab: ["crimson_planks"],
  crimson_fence: ["crimson_planks"],
  crimson_fence_gate: ["crimson_planks"],
  warped_stairs: ["warped_planks"],
  warped_slab: ["warped_planks"],
  warped_fence: ["warped_planks"],
  warped_fence_gate: ["warped_planks"],

  // Stone & brick variants
  stone_brick_stairs: ["stone_bricks"],
  stone_brick_slab: ["stone_bricks"],
  stone_brick_wall: ["stone_bricks"],
  mossy_stone_brick_stairs: ["mossy_stone_bricks"],
  mossy_stone_brick_slab: ["mossy_stone_bricks"],
  mossy_stone_brick_wall: ["mossy_stone_bricks"],
  cobblestone_stairs: ["cobblestone"],
  cobblestone_slab: ["cobblestone"],
  cobblestone_wall: ["cobblestone"],
  mossy_cobblestone_stairs: ["mossy_cobblestone"],
  mossy_cobblestone_slab: ["mossy_cobblestone"],
  mossy_cobblestone_wall: ["mossy_cobblestone"],
  stone_stairs: ["stone"],
  stone_slab: ["stone"],
  smooth_stone_slab: ["smooth_stone"],
  andesite_stairs: ["andesite"],
  andesite_slab: ["andesite"],
  andesite_wall: ["andesite"],
  polished_andesite_stairs: ["polished_andesite"],
  polished_andesite_slab: ["polished_andesite"],
  diorite_stairs: ["diorite"],
  diorite_slab: ["diorite"],
  diorite_wall: ["diorite"],
  polished_diorite_stairs: ["polished_diorite"],
  polished_diorite_slab: ["polished_diorite"],
  granite_stairs: ["granite"],
  granite_slab: ["granite"],
  granite_wall: ["granite"],
  polished_granite_stairs: ["polished_granite"],
  polished_granite_slab: ["polished_granite"],
  brick_stairs: ["bricks"],
  brick_slab: ["bricks"],
  brick_wall: ["bricks"],
  mud_brick_stairs: ["mud_bricks"],
  mud_brick_slab: ["mud_bricks"],
  mud_brick_wall: ["mud_bricks"],
  deepslate_brick_stairs: ["deepslate_bricks"],
  deepslate_brick_slab: ["deepslate_bricks"],
  deepslate_brick_wall: ["deepslate_bricks"],
  deepslate_tile_stairs: ["deepslate_tiles"],
  deepslate_tile_slab: ["deepslate_tiles"],
  deepslate_tile_wall: ["deepslate_tiles"],
  cobbled_deepslate_stairs: ["cobbled_deepslate"],
  cobbled_deepslate_slab: ["cobbled_deepslate"],
  cobbled_deepslate_wall: ["cobbled_deepslate"],
  sandstone_stairs: ["sandstone", "sandstone_top", "sandstone_side"],
  sandstone_slab: ["sandstone", "sandstone_top", "sandstone_side"],
  sandstone_wall: ["sandstone", "sandstone_top", "sandstone_side"],
  red_sandstone_stairs: ["red_sandstone", "red_sandstone_top", "red_sandstone_side"],
  red_sandstone_slab: ["red_sandstone", "red_sandstone_top", "red_sandstone_side"],
  red_sandstone_wall: ["red_sandstone", "red_sandstone_top", "red_sandstone_side"],
  quartz_stairs: ["quartz_block_side", "quartz_block_top"],
  quartz_slab: ["quartz_block_side", "quartz_block_top"],
  quartz_block: ["quartz_block_side", "quartz_block_top"],
  smooth_quartz: ["quartz_block_bottom", "quartz_block_top"],
  smooth_quartz_stairs: ["quartz_block_bottom", "quartz_block_top"],
  smooth_quartz_slab: ["quartz_block_bottom", "quartz_block_top"],

  // Natural / multi-face blocks & fluids
  grass_block: ["grass_block_side", "grass_block_top"],
  dirt_path: ["dirt_path_top", "dirt_path_side", "grass_path_top", "grass_path_side"],
  grass_path: ["grass_path_top", "dirt_path_top"],
  podzol: ["podzol_top", "podzol_side"],
  mycelium: ["mycelium_top", "mycelium_side"],
  snow_block: ["snow"],
  snow: ["snow"],
  water: ["water_still", "water_flow"],
  flowing_water: ["water_flow", "water_still"],
  lava: ["lava_still", "lava_flow"],
  flowing_lava: ["lava_flow", "lava_still"],
  glass_pane: ["glass"],
  iron_bars: ["iron_bars"],
  oak_door: ["oak_door_top", "oak_door_bottom", "oak_planks"],
  spruce_door: ["spruce_door_top", "spruce_door_bottom", "spruce_planks"],
  birch_door: ["birch_door_top", "birch_door_bottom", "birch_planks"],
  dark_oak_door: ["dark_oak_door_top", "dark_oak_door_bottom", "dark_oak_planks"],
  torch: ["torch"],
  wall_torch: ["torch"],
  lantern: ["lantern"],
};

/**
 * Compares two version strings or file paths so that standard release versions
 * (e.g., 1.21.4 > 1.20.1 > 1.19) come first, prioritizing non-snapshot releases.
 */
function parseVersionScore(filePath: string, mtimeMs: number): number {
  const base = path.basename(filePath, ".jar");
  // Match standard semantic release versions like 1.21.4 or 1.20
  const semverMatch = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(base);
  if (semverMatch) {
    const major = parseInt(semverMatch[1], 10);
    const minor = parseInt(semverMatch[2], 10);
    const patch = semverMatch[3] ? parseInt(semverMatch[3], 10) : 0;
    // High base score for clean release versions
    return 1_000_000_000_000 + major * 100_000_000 + minor * 1_000_000 + patch * 10_000;
  }
  // Pre-releases or modded versions starting with x.y.z
  const prefixMatch = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(base);
  if (prefixMatch) {
    const major = parseInt(prefixMatch[1], 10);
    const minor = parseInt(prefixMatch[2], 10);
    const patch = prefixMatch[3] ? parseInt(prefixMatch[3], 10) : 0;
    return 500_000_000_000 + major * 100_000_000 + minor * 1_000_000 + patch * 10_000;
  }
  // Fallback to modification timestamp
  return mtimeMs;
}

/**
 * Searches for `.jar` files in a given versions directory (up to depth 2).
 */
function findJarFilesInVersionsDir(versionsDir: string): Array<{ jarPath: string; score: number }> {
  const results: Array<{ jarPath: string; score: number }> = [];
  if (!fs.existsSync(versionsDir)) {
    return results;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(versionsDir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    const fullPath = path.join(versionsDir, entry.name);
    if (entry.isFile() && entry.name.endsWith(".jar")) {
      try {
        const stat = fs.statSync(fullPath);
        if (stat.size > 1024 * 100) {
          results.push({ jarPath: fullPath, score: parseVersionScore(fullPath, stat.mtimeMs) });
        }
      } catch {
        // Ignore unreadable files
      }
    } else if (entry.isDirectory()) {
      try {
        const subEntries = fs.readdirSync(fullPath, { withFileTypes: true });
        for (const sub of subEntries) {
          if (sub.isFile() && sub.name.endsWith(".jar")) {
            const jarPath = path.join(fullPath, sub.name);
            const stat = fs.statSync(jarPath);
            if (stat.size > 1024 * 100) {
              results.push({ jarPath, score: parseVersionScore(jarPath, stat.mtimeMs) });
            }
          }
        }
      } catch {
        // Ignore unreadable subdirectories
      }
    }
  }

  return results;
}

/**
 * Automatically detects the best local Minecraft client `.jar` path.
 * 1. Checks `process.env.MINECRAFT_JAR_PATH` first.
 * 2. Searches standard platform-specific Minecraft `versions` directories.
 */
export function detectMinecraftJarPath(): string | null {
  const envPath = process.env.MINECRAFT_JAR_PATH;
  if (envPath && fs.existsSync(envPath)) {
    try {
      const stat = fs.statSync(envPath);
      if (stat.isFile()) {
        return envPath;
      }
    } catch {
      // Fall through to standard directories
    }
  }

  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");

  const candidateDirs = [
    // Windows
    path.join(appData, ".minecraft", "versions"),
    // macOS
    path.join(home, "Library", "Application Support", "minecraft", "versions"),
    // Linux standard & Flatpak
    path.join(home, ".minecraft", "versions"),
    path.join(home, ".var", "app", "com.mojang.Minecraft", ".minecraft", "versions"),
  ];

  const allJars: Array<{ jarPath: string; score: number }> = [];
  for (const dir of candidateDirs) {
    const found = findJarFilesInVersionsDir(dir);
    allJars.push(...found);
  }

  if (allJars.length === 0) {
    return null;
  }

  allJars.sort((a, b) => b.score - a.score);
  return allJars[0].jarPath;
}

/**
 * Generates candidate texture base names (without `.png`) for a normalized block name.
 */
export function getTextureCandidates(normalizedBlock: string): string[] {
  const candidates = new Set<string>();

  // 1. Explicit mapping
  const explicit = EXPLICIT_TEXTURE_MAP[normalizedBlock];
  if (explicit) {
    for (const item of explicit) {
      candidates.add(item);
    }
  }

  // 2. Direct match
  candidates.add(normalizedBlock);

  // 3. Generic suffix stripping & transformations
  const suffixes = [
    "_stairs",
    "_slab",
    "_wall",
    "_fence_gate",
    "_fence",
    "_pressure_plate",
    "_button",
    "_trapdoor",
    "_door",
    "_pane",
    "_wood",
    "_hyphae",
  ];

  for (const suffix of suffixes) {
    if (normalizedBlock.endsWith(suffix)) {
      const stem = normalizedBlock.slice(0, -suffix.length);
      candidates.add(stem);
      candidates.add(`${stem}_planks`);
      candidates.add(`${stem}s`);
      candidates.add(`${stem}_block`);
      candidates.add(`${stem}_log`);
      candidates.add(`${stem}_top`);
      candidates.add(`${stem}_side`);
    }
  }

  // 4. Multi-face block conventions (`_top`, `_side`, `_front`, `_still`)
  candidates.add(`${normalizedBlock}_side`);
  candidates.add(`${normalizedBlock}_top`);
  candidates.add(`${normalizedBlock}_front`);
  candidates.add(`${normalizedBlock}_still`);
  candidates.add(`${normalizedBlock}_planks`);
  candidates.add(`${normalizedBlock}s`);

  if (normalizedBlock.endsWith("_block")) {
    const stem = normalizedBlock.slice(0, -"_block".length);
    candidates.add(stem);
    candidates.add(`${stem}_top`);
    candidates.add(`${stem}_side`);
  }

  return Array.from(candidates);
}

/**
 * Simple deterministic 32-bit FNV-1a hash for strings.
 */
function hashString(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministic pseudo-random generator (Mulberry32) seeded by block hash.
 */
function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0;
  let g = 0;
  let b = 0;

  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];

  return [
    clampByte((r + m) * 255),
    clampByte((g + m) * 255),
    clampByte((b + m) * 255),
  ];
}

type PatternKind =
  | "grass"
  | "dirt"
  | "cobble"
  | "brick"
  | "planks"
  | "log"
  | "water"
  | "sand"
  | "glass"
  | "leaves"
  | "generic";

interface ProceduralStyle {
  baseRgb: [number, number, number];
  accentRgb: [number, number, number];
  alpha: number;
  pattern: PatternKind;
}

function resolveProceduralStyle(block: string, seed: number): ProceduralStyle {
  // 1. Grass / moss
  if (block.includes("grass") || block.includes("moss") || block.includes(" turf")) {
    return {
      baseRgb: [94, 168, 58],
      accentRgb: [72, 138, 42],
      alpha: 255,
      pattern: "grass",
    };
  }

  // 2. Leaves / foliage
  if (block.includes("leaves") || block.includes("vine") || block.includes("bush")) {
    const isCherry = block.includes("cherry");
    return {
      baseRgb: isCherry ? [232, 162, 188] : [58, 128, 44],
      accentRgb: isCherry ? [204, 124, 154] : [40, 96, 30],
      alpha: 255,
      pattern: "leaves",
    };
  }

  // 3. Dirt / mud / podzol / coarse_dirt / farmland / path
  if (
    block.includes("dirt") ||
    block.includes("mud") ||
    block.includes("podzol") ||
    block.includes("farmland") ||
    block.includes("path") ||
    block.includes("soul_soil")
  ) {
    const isPodzol = block.includes("podzol");
    return {
      baseRgb: isPodzol ? [115, 82, 48] : [134, 96, 67],
      accentRgb: isPodzol ? [90, 62, 34] : [108, 75, 50],
      alpha: 255,
      pattern: "dirt",
    };
  }

  // 4. Water / ice
  if (block.includes("water") || block.includes("ice")) {
    const isIce = block.includes("ice");
    return {
      baseRgb: isIce ? [140, 200, 245] : [44, 108, 220],
      accentRgb: isIce ? [180, 225, 255] : [68, 138, 245],
      alpha: isIce ? 235 : 210,
      pattern: "water",
    };
  }

  // 5. Glass
  if (block.includes("glass")) {
    return {
      baseRgb: [200, 240, 248],
      accentRgb: [130, 195, 212],
      alpha: 160,
      pattern: "glass",
    };
  }

  // 6. Sand / sandstone
  if (block.includes("sand")) {
    const isRed = block.includes("red_sand");
    return {
      baseRgb: isRed ? [194, 106, 48] : [222, 207, 156],
      accentRgb: isRed ? [168, 86, 36] : [198, 182, 130],
      alpha: 255,
      pattern: block.includes("sandstone") ? "brick" : "sand",
    };
  }

  // 7. Wood logs / stems
  if (block.includes("_log") || block.includes("_wood") || block.includes("_stem")) {
    if (block.includes("birch")) {
      return { baseRgb: [216, 210, 198], accentRgb: [90, 85, 78], alpha: 255, pattern: "log" };
    }
    if (block.includes("spruce") || block.includes("dark_oak")) {
      return { baseRgb: [68, 46, 28], accentRgb: [48, 32, 18], alpha: 255, pattern: "log" };
    }
    if (block.includes("cherry")) {
      return { baseRgb: [66, 38, 48], accentRgb: [48, 26, 34], alpha: 255, pattern: "log" };
    }
    return { baseRgb: [108, 82, 50], accentRgb: [78, 58, 34], alpha: 255, pattern: "log" };
  }

  // 8. Wood planks / stairs / slabs / fences / doors / trapdoors
  if (
    block.includes("oak") ||
    block.includes("spruce") ||
    block.includes("birch") ||
    block.includes("jungle") ||
    block.includes("acacia") ||
    block.includes("cherry") ||
    block.includes("mangrove") ||
    block.includes("bamboo") ||
    block.includes("crimson") ||
    block.includes("warped") ||
    block.includes("plank")
  ) {
    if (block.includes("birch")) {
      return { baseRgb: [204, 186, 132], accentRgb: [176, 158, 106], alpha: 255, pattern: "planks" };
    }
    if (block.includes("spruce")) {
      return { baseRgb: [116, 86, 50], accentRgb: [92, 66, 36], alpha: 255, pattern: "planks" };
    }
    if (block.includes("dark_oak")) {
      return { baseRgb: [68, 44, 22], accentRgb: [50, 32, 14], alpha: 255, pattern: "planks" };
    }
    if (block.includes("acacia")) {
      return { baseRgb: [172, 94, 52], accentRgb: [144, 74, 38], alpha: 255, pattern: "planks" };
    }
    if (block.includes("cherry")) {
      return { baseRgb: [226, 178, 172], accentRgb: [196, 144, 138], alpha: 255, pattern: "planks" };
    }
    if (block.includes("crimson")) {
      return { baseRgb: [108, 48, 72], accentRgb: [82, 34, 54], alpha: 255, pattern: "planks" };
    }
    if (block.includes("warped")) {
      return { baseRgb: [44, 112, 104], accentRgb: [30, 86, 80], alpha: 255, pattern: "planks" };
    }
    if (block.includes("bamboo")) {
      return { baseRgb: [198, 178, 86], accentRgb: [170, 150, 66], alpha: 255, pattern: "planks" };
    }
    // Default oak / medium warm wood
    return { baseRgb: [162, 130, 78], accentRgb: [134, 104, 58], alpha: 255, pattern: "planks" };
  }

  // 9. Red brick / terracotta / copper / roof tiles
  if (
    (block.includes("brick") && !block.includes("stone") && !block.includes("deepslate") && !block.includes("mud")) ||
    block.includes("terracotta") ||
    block.includes("granite") ||
    block.includes("copper")
  ) {
    return {
      baseRgb: [156, 78, 62],
      accentRgb: [188, 172, 158], // mortar / highlight
      alpha: 255,
      pattern: "brick",
    };
  }

  // 10. Stone / cobblestone / andesite / diorite / stone_bricks / deepslate
  if (
    block.includes("stone") ||
    block.includes("cobble") ||
    block.includes("andesite") ||
    block.includes("diorite") ||
    block.includes("deepslate") ||
    block.includes("basalt") ||
    block.includes("blackstone") ||
    block.includes("gravel")
  ) {
    if (block.includes("deepslate") || block.includes("blackstone") || block.includes("basalt")) {
      return {
        baseRgb: [76, 76, 82],
        accentRgb: [52, 52, 58],
        alpha: 255,
        pattern: block.includes("brick") || block.includes("tile") ? "brick" : "cobble",
      };
    }
    if (block.includes("diorite")) {
      return {
        baseRgb: [196, 196, 200],
        accentRgb: [158, 158, 164],
        alpha: 255,
        pattern: "cobble",
      };
    }
    if (block.includes("brick") || block.includes("smooth")) {
      return {
        baseRgb: [132, 132, 136],
        accentRgb: [96, 96, 100],
        alpha: 255,
        pattern: "brick",
      };
    }
    return {
      baseRgb: [124, 124, 128],
      accentRgb: [92, 92, 96],
      alpha: 255,
      pattern: "cobble",
    };
  }

  // 11. Quartz / snow / white blocks
  if (block.includes("quartz") || block.includes("snow") || block.includes("white") || block.includes("calcite")) {
    return {
      baseRgb: [236, 234, 228],
      accentRgb: [208, 204, 196],
      alpha: 255,
      pattern: "brick",
    };
  }

  // 12. Deterministic HSV fallback for any unknown block
  const hue = seed % 360;
  const sat = 0.45 + ((seed >>> 8) % 30) / 100; // 0.45 - 0.74
  const val = 0.55 + ((seed >>> 16) % 28) / 100; // 0.55 - 0.82
  const baseRgb = hsvToRgb(hue, sat, val);
  const accentRgb = hsvToRgb(hue, Math.min(1, sat + 0.1), Math.max(0.2, val - 0.18));

  return {
    baseRgb,
    accentRgb,
    alpha: 255,
    pattern: "generic",
  };
}

/**
 * Deterministically generates a crisp 16x16 pixel-art PNG Data URL (`data:image/png;base64,...`)
 * for a given block name using `pngjs`.
 */
export function generateProceduralBlockPngDataUrl(blockName: string): string {
  const normalized = normalizeBlockName(blockName);
  const seed = hashString(normalized);
  const rng = createRng(seed);
  const style = resolveProceduralStyle(normalized, seed);

  const png = new PNG({ width: 16, height: 16 });

  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const idx = (16 * y + x) << 2;
      const isOuterBorder = x === 0 || y === 0 || x === 15 || y === 15;
      const noise = (rng() - 0.5) * 18;

      let [r, g, b] = style.baseRgb;
      let a = style.alpha;

      switch (style.pattern) {
        case "grass": {
          // speckles and blade ticks
          if ((x + y * 3 + Math.floor(rng() * 5)) % 5 === 0) {
            [r, g, b] = style.accentRgb;
          }
          if (isOuterBorder) {
            r -= 16;
            g -= 18;
            b -= 12;
          }
          break;
        }
        case "leaves": {
          // Checkerboard foliage texture
          if ((x + y) % 2 === 0 || rng() < 0.25) {
            [r, g, b] = style.accentRgb;
          }
          if (isOuterBorder) {
            r -= 14;
            g -= 14;
            b -= 14;
          }
          break;
        }
        case "dirt": {
          if (rng() < 0.28) {
            [r, g, b] = style.accentRgb;
          } else if (rng() < 0.1) {
            r += 16;
            g += 14;
            b += 12;
          }
          if (isOuterBorder) {
            r -= 15;
            g -= 12;
            b -= 10;
          }
          break;
        }
        case "planks": {
          // Horizontal plank seams every 4 pixels + staggered vertical joints
          const isHorizontalSeam = y % 4 === 0;
          const row = Math.floor(y / 4);
          const jointX = (row * 7 + 3) % 16;
          const isVerticalJoint = x === jointX;
          if (isHorizontalSeam || isVerticalJoint || isOuterBorder) {
            [r, g, b] = style.accentRgb;
          } else if (y % 4 === 1) {
            r += 8;
            g += 6;
            b += 4;
          }
          break;
        }
        case "log": {
          // Vertical bark stripes
          if (x % 3 === 0 || isOuterBorder) {
            [r, g, b] = style.accentRgb;
          }
          break;
        }
        case "brick": {
          // Classic staggered brick mortar lines
          const isMortarY = y % 4 === 0;
          const brickRow = Math.floor(y / 4);
          const isMortarX = (x + (brickRow % 2) * 4) % 8 === 0;
          if (isMortarY || isMortarX) {
            [r, g, b] = style.accentRgb;
          } else if (isOuterBorder) {
            r -= 10;
            g -= 10;
            b -= 10;
          }
          break;
        }
        case "cobble": {
          // Cellular cobble grid lines
          const cellEdge =
            (x % 4 === 0 && y % 2 === 0) ||
            (y % 4 === 0 && x % 2 === 1) ||
            ((x + y) % 5 === 0 && rng() < 0.45);
          if (cellEdge || isOuterBorder) {
            [r, g, b] = style.accentRgb;
          }
          break;
        }
        case "water": {
          // Wavy horizontal highlights
          const wave = (y % 4 === 1 && (x + Math.floor(y / 4) * 2) % 4 < 2);
          if (wave) {
            [r, g, b] = style.accentRgb;
          }
          if (isOuterBorder) {
            r -= 12;
            g -= 12;
            b -= 8;
          }
          break;
        }
        case "glass": {
          // Crisp frame with light diagonal streak and clear interior
          const isStreak = (x + y === 5 || x + y === 6) && x >= 2 && y >= 2;
          const isInnerRim = x === 1 || y === 1 || x === 14 || y === 14;
          if (isOuterBorder) {
            [r, g, b] = style.accentRgb;
            a = 240;
          } else if (isInnerRim || isStreak) {
            [r, g, b] = style.baseRgb;
            a = 210;
          } else {
            [r, g, b] = style.baseRgb;
            a = 55;
          }
          break;
        }
        case "sand": {
          // Subtle ripple speckles
          if ((x + y * 2) % 6 === 0 || rng() < 0.2) {
            [r, g, b] = style.accentRgb;
          }
          if (isOuterBorder) {
            r -= 12;
            g -= 12;
            b -= 10;
          }
          break;
        }
        default: {
          // Generic distinct voxel grid border + subtle inner highlight
          if (isOuterBorder) {
            [r, g, b] = style.accentRgb;
          } else if (x === 1 || y === 1) {
            r += 14;
            g += 14;
            b += 14;
          }
          break;
        }
      }

      if (style.pattern !== "glass") {
        r = clampByte(r + noise);
        g = clampByte(g + noise);
        b = clampByte(b + noise);
      } else {
        r = clampByte(r);
        g = clampByte(g);
        b = clampByte(b);
      }

      png.data[idx] = r;
      png.data[idx + 1] = g;
      png.data[idx + 2] = b;
      png.data[idx + 3] = clampByte(a);
    }
  }

  const buffer = PNG.sync.write(png);
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

export class JarAssetLoader {
  private jarPath: string | null = null;
  private zip: AdmZip | null = null;
  private entrySet: Set<string> = new Set();
  private textureCache: Map<string, string> = new Map();
  private initialized = false;

  constructor(customJarPath?: string) {
    if (customJarPath !== undefined) {
      this.init(customJarPath);
    }
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      this.init(detectMinecraftJarPath());
    }
  }

  private init(candidatePath: string | null): void {
    this.initialized = true;
    this.jarPath = null;
    this.zip = null;
    this.entrySet.clear();

    if (!candidatePath || !fs.existsSync(candidatePath)) {
      return;
    }

    try {
      const zip = new AdmZip(candidatePath);
      const entries = zip.getEntries();
      for (const entry of entries) {
        if (
          !entry.isDirectory &&
          entry.entryName.startsWith(BLOCK_TEXTURE_PREFIX) &&
          entry.entryName.endsWith(".png")
        ) {
          this.entrySet.add(entry.entryName);
        }
      }
      this.zip = zip;
      this.jarPath = candidatePath;
    } catch {
      this.zip = null;
      this.jarPath = null;
      this.entrySet.clear();
    }
  }

  /**
   * Returns the resolved path to the local Minecraft `.jar` file, or `null` if none was found.
   */
  public getJarPath(): string | null {
    this.ensureInitialized();
    return this.jarPath;
  }

  /**
   * Resolves a block name to a `data:image/png;base64,...` texture URL.
   * Extracts from the local Minecraft `.jar` when available, or falls back to
   * a deterministic 16x16 procedural PNG generated via `pngjs`.
   */
  public getBlockTextureDataUrl(blockName: string): string {
    this.ensureInitialized();
    const normalized = normalizeBlockName(blockName);

    const cached = this.textureCache.get(normalized);
    if (cached) {
      return cached;
    }

    let dataUrl: string | null = null;

    if (this.zip && this.entrySet.size > 0) {
      const candidates = getTextureCandidates(normalized);
      for (const candidate of candidates) {
        const entryName = `${BLOCK_TEXTURE_PREFIX}${candidate}.png`;
        if (this.entrySet.has(entryName)) {
          try {
            const buf = this.zip.readFile(entryName);
            if (buf && buf.length > 0) {
              dataUrl = `data:image/png;base64,${buf.toString("base64")}`;
              break;
            }
          } catch {
            // Try next candidate
          }
        }
      }
    }

    if (!dataUrl) {
      dataUrl = generateProceduralBlockPngDataUrl(normalized);
    }

    this.textureCache.set(normalized, dataUrl);
    return dataUrl;
  }

  /**
   * Batch-resolves an array of block names into a map of normalized block name -> Data URL.
   */
  public getTexturesForBlocks(blockNames: string[]): Record<string, string> {
    this.ensureInitialized();
    const result: Record<string, string> = {};
    for (const rawName of blockNames) {
      if (!rawName) continue;
      const normalized = normalizeBlockName(rawName);
      if (!normalized || normalized === "air") continue;
      if (!(normalized in result)) {
        result[normalized] = this.getBlockTextureDataUrl(normalized);
      }
    }
    return result;
  }

  /**
   * Returns diagnostic status about the asset loader.
   */
  public getStatus(): { jarFound: boolean; jarPath: string | null; cachedCount: number } {
    this.ensureInitialized();
    return {
      jarFound: this.jarPath !== null,
      jarPath: this.jarPath,
      cachedCount: this.textureCache.size,
    };
  }
}

// Default singleton instance and convenience exports
export const defaultJarAssetLoader = new JarAssetLoader();

export function getJarPath(): string | null {
  return defaultJarAssetLoader.getJarPath();
}

export function getBlockTextureDataUrl(blockName: string): string {
  return defaultJarAssetLoader.getBlockTextureDataUrl(blockName);
}

export function getTexturesForBlocks(blockNames: string[]): Record<string, string> {
  return defaultJarAssetLoader.getTexturesForBlocks(blockNames);
}

export function getStatus(): { jarFound: boolean; jarPath: string | null; cachedCount: number } {
  return defaultJarAssetLoader.getStatus();
}

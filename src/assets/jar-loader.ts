import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import AdmZip from "adm-zip";
import { PNG } from "pngjs";
import { toShortBlockId } from "../core/block-name.js";
import type {
  AppliedModelRef,
  CompiledBlockDefinition,
  McFaceDirection,
  MultipartCase,
  MultipartCondition,
  ResolvedModelElement,
  ResolvedModelElementRotation,
  ResolvedModelFace,
} from "../types/shared.js";

const BLOCK_TEXTURE_PREFIX = "assets/minecraft/textures/block/";
const BLOCK_MODEL_PREFIX = "assets/minecraft/models/block/";
const BLOCKSTATE_PREFIX = "assets/minecraft/blockstates/";
const BLOCK_TAG_PREFIX_MODERN = "data/minecraft/tags/block/";
const BLOCK_TAG_PREFIX_LEGACY = "data/minecraft/tags/blocks/";

const ALL_FACE_DIRECTIONS: McFaceDirection[] = [
  "down",
  "up",
  "north",
  "south",
  "west",
  "east",
];

/**
 * Strips "minecraft:" namespace and block state brackets `[...]` if present,
 * returning a clean lowercase identifier (e.g., "oak_stairs").
 */
export function normalizeBlockName(blockName: string): string {
  return toShortBlockId(blockName);
}

function normalizeModelRefName(modelRef: string): string {
  return modelRef
    .trim()
    .toLowerCase()
    .replace(/^minecraft:/, "")
    .replace(/^block\//, "");
}

function normalizeTextureRefName(texRef: string): string {
  return texRef
    .trim()
    .toLowerCase()
    .replace(/^minecraft:/, "")
    .replace(/^block\//, "");
}

function normalizeTagRefName(tagRef: string): string {
  return tagRef
    .trim()
    .toLowerCase()
    .replace(/^#/, "")
    .replace(/^minecraft:/, "");
}

/**
 * Compares two version strings or file paths so that standard release versions
 * (e.g., 1.21.4 > 1.20.1 > 1.19) come first, prioritizing non-snapshot releases.
 */
function parseVersionScore(filePath: string, mtimeMs: number): number {
  const base = path.basename(filePath, ".jar");
  const semverMatch = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(base);
  if (semverMatch) {
    const major = parseInt(semverMatch[1], 10);
    const minor = parseInt(semverMatch[2], 10);
    const patch = semverMatch[3] ? parseInt(semverMatch[3], 10) : 0;
    return 1_000_000_000_000 + major * 100_000_000 + minor * 1_000_000 + patch * 10_000;
  }
  const prefixMatch = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(base);
  if (prefixMatch) {
    const major = parseInt(prefixMatch[1], 10);
    const minor = parseInt(prefixMatch[2], 10);
    const patch = prefixMatch[3] ? parseInt(prefixMatch[3], 10) : 0;
    return 500_000_000_000 + major * 100_000_000 + minor * 1_000_000 + patch * 10_000;
  }
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
            try {
              const stat = fs.statSync(jarPath);
              if (stat.size > 1024 * 100) {
                results.push({ jarPath, score: parseVersionScore(jarPath, stat.mtimeMs) });
              }
            } catch {
              // Ignore unreadable jar files
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
    path.join(appData, ".minecraft", "versions"),
    path.join(home, "Library", "Application Support", "minecraft", "versions"),
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
  if (block.includes("grass") || block.includes("moss") || block.includes("turf")) {
    return {
      baseRgb: [94, 168, 58],
      accentRgb: [72, 138, 42],
      alpha: 255,
      pattern: "grass",
    };
  }

  if (block.includes("leaves") || block.includes("vine") || block.includes("bush")) {
    const isCherry = block.includes("cherry");
    return {
      baseRgb: isCherry ? [232, 162, 188] : [58, 128, 44],
      accentRgb: isCherry ? [204, 124, 154] : [40, 96, 30],
      alpha: 255,
      pattern: "leaves",
    };
  }

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

  if (block.includes("water") || block.includes("ice")) {
    const isIce = block.includes("ice");
    return {
      baseRgb: isIce ? [140, 200, 245] : [44, 108, 220],
      accentRgb: isIce ? [180, 225, 255] : [68, 138, 245],
      alpha: isIce ? 235 : 210,
      pattern: "water",
    };
  }

  if (block.includes("glass")) {
    return {
      baseRgb: [200, 240, 248],
      accentRgb: [130, 195, 212],
      alpha: 160,
      pattern: "glass",
    };
  }

  if (block.includes("sand")) {
    const isRed = block.includes("red_sand");
    return {
      baseRgb: isRed ? [194, 106, 48] : [222, 207, 156],
      accentRgb: isRed ? [168, 86, 36] : [198, 182, 130],
      alpha: 255,
      pattern: block.includes("sandstone") ? "brick" : "sand",
    };
  }

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
    if (block.includes("jungle")) {
      return { baseRgb: [160, 115, 80], accentRgb: [132, 92, 62], alpha: 255, pattern: "planks" };
    }
    if (block.includes("mangrove")) {
      return { baseRgb: [120, 56, 50], accentRgb: [92, 40, 36], alpha: 255, pattern: "planks" };
    }
    return { baseRgb: [162, 130, 78], accentRgb: [134, 104, 58], alpha: 255, pattern: "planks" };
  }

  if (
    (block.includes("brick") && !block.includes("stone") && !block.includes("deepslate") && !block.includes("mud")) ||
    block.includes("terracotta") ||
    block.includes("granite") ||
    block.includes("copper")
  ) {
    return {
      baseRgb: [156, 78, 62],
      accentRgb: [188, 172, 158],
      alpha: 255,
      pattern: "brick",
    };
  }

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

  if (block.includes("quartz") || block.includes("snow") || block.includes("white") || block.includes("calcite")) {
    return {
      baseRgb: [236, 234, 228],
      accentRgb: [208, 204, 196],
      alpha: 255,
      pattern: "brick",
    };
  }

  const hue = seed % 360;
  const sat = 0.45 + ((seed >>> 8) % 30) / 100;
  const val = 0.55 + ((seed >>> 16) % 28) / 100;
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
 * for a given block/texture name when no `.jar` asset is available.
 */
export function generateProceduralBlockPngDataUrl(blockName: string): string {
  const normalized = normalizeBlockName(blockName.replace(/#tinted$/, ""));
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
          if (x % 3 === 0 || isOuterBorder) {
            [r, g, b] = style.accentRgb;
          }
          break;
        }
        case "brick": {
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
          const wave = y % 4 === 1 && (x + Math.floor(y / 4) * 2) % 4 < 2;
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

type RawTextureRef =
  | string
  | {
      sprite?: unknown;
      force_translucent?: unknown;
    };

interface RawFaceJson {
  uv?: [number, number, number, number];
  texture: RawTextureRef;
  cullface?: string;
  rotation?: number;
  tintindex?: number;
}

interface RawElementJson {
  from: [number, number, number];
  to: [number, number, number];
  rotation?: {
    origin: [number, number, number];
    axis?: "x" | "y" | "z";
    angle?: number;
    x?: number;
    y?: number;
    z?: number;
    rescale?: boolean;
  };
  shade?: boolean;
  shade_direction_override?: string;
  faces: Record<string, RawFaceJson>;
}

interface RawBlockTagJson {
  values?: Array<string | { id?: string; required?: boolean }>;
}

interface RawBlockModelJson {
  parent?: string;
  textures?: Record<string, RawTextureRef>;
  elements?: RawElementJson[];
}

interface RawAppliedRefJson {
  model: string;
  x?: number;
  y?: number;
  uvlock?: boolean;
  weight?: number;
}

interface RawBlockstateJson {
  variants?: Record<string, RawAppliedRefJson | RawAppliedRefJson[]>;
  multipart?: Array<{
    when?: MultipartCondition;
    apply: RawAppliedRefJson | RawAppliedRefJson[];
  }>;
}

interface ResolvedTextureAsset {
  dataUrl: string;
  hasTranslucentAlpha: boolean;
  isOpaque: boolean;
}

interface ResolvedModelInfo {
  elements: ResolvedModelElement[];
  isFluid: boolean;
  isFallback: boolean;
  hasForcedTranslucent: boolean;
  primaryTextureKey: string | null;
}

const DEFAULT_GRASS_FOLIAGE_TINT: [number, number, number] = [121, 192, 90];
const DEFAULT_WATER_TINT: [number, number, number] = [48, 115, 255];

export class JarAssetLoader {
  private jarPath: string | null = null;
  private zip: AdmZip | null = null;
  private jarTextureEntries: Map<string, AdmZip.IZipEntry> = new Map();
  private jarBlockstateEntries: Map<string, AdmZip.IZipEntry> = new Map();
  private jarModelEntries: Map<string, AdmZip.IZipEntry> = new Map();
  private jarBlockTagEntries: Map<string, AdmZip.IZipEntry> = new Map();

  private modelJsonCache: Map<string, RawBlockModelJson | null> = new Map();
  private blockstateJsonCache: Map<string, RawBlockstateJson | null> = new Map();
  private resolvedModelCache: Map<string, ResolvedModelInfo> = new Map();
  private textureAssetCache: Map<string, ResolvedTextureAsset> = new Map();
  private blockDefCache: Map<string, CompiledBlockDefinition> = new Map();
  private resolvedTagMembersCache: Map<string, Set<string>> = new Map();
  private blockTagsIndex: Map<string, string[]> | null = null;
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

  public init(candidatePath: string | null): void {
    this.initialized = true;
    this.jarPath = null;
    this.zip = null;
    this.jarTextureEntries.clear();
    this.jarBlockstateEntries.clear();
    this.jarModelEntries.clear();
    this.jarBlockTagEntries.clear();
    this.modelJsonCache.clear();
    this.blockstateJsonCache.clear();
    this.resolvedModelCache.clear();
    this.textureAssetCache.clear();
    this.blockDefCache.clear();
    this.resolvedTagMembersCache.clear();
    this.blockTagsIndex = null;

    if (!candidatePath || !fs.existsSync(candidatePath)) {
      return;
    }

    try {
      const zip = new AdmZip(candidatePath);
      const entries = zip.getEntries();
      for (const entry of entries) {
        if (entry.isDirectory) continue;
        const name = entry.entryName;
        if (name.startsWith(BLOCK_TEXTURE_PREFIX) && name.endsWith(".png")) {
          const shortKey = name.slice(BLOCK_TEXTURE_PREFIX.length, -".png".length);
          this.jarTextureEntries.set(shortKey, entry);
        } else if (name.startsWith(BLOCKSTATE_PREFIX) && name.endsWith(".json")) {
          const shortKey = name.slice(BLOCKSTATE_PREFIX.length, -".json".length);
          this.jarBlockstateEntries.set(shortKey, entry);
        } else if (name.startsWith(BLOCK_MODEL_PREFIX) && name.endsWith(".json")) {
          const shortKey = name.slice(BLOCK_MODEL_PREFIX.length, -".json".length);
          this.jarModelEntries.set(shortKey, entry);
        } else if (name.startsWith(BLOCK_TAG_PREFIX_MODERN) && name.endsWith(".json")) {
          const shortKey = name.slice(BLOCK_TAG_PREFIX_MODERN.length, -".json".length);
          this.jarBlockTagEntries.set(shortKey, entry);
        } else if (name.startsWith(BLOCK_TAG_PREFIX_LEGACY) && name.endsWith(".json")) {
          const shortKey = name.slice(BLOCK_TAG_PREFIX_LEGACY.length, -".json".length);
          if (!this.jarBlockTagEntries.has(shortKey)) {
            this.jarBlockTagEntries.set(shortKey, entry);
          }
        }
      }
      this.zip = zip;
      this.jarPath = candidatePath;
    } catch {
      this.zip = null;
      this.jarPath = null;
      this.jarTextureEntries.clear();
      this.jarBlockstateEntries.clear();
      this.jarModelEntries.clear();
      this.jarBlockTagEntries.clear();
    }
  }

  /**
   * Returns the resolved path to the local Minecraft `.jar` file, or `null` if none was found.
   */
  public getJarPath(): string | null {
    this.ensureInitialized();
    return this.jarPath;
  }

  private resolveAliasViaTags(cleanName: string): string {
    if (this.jarBlockstateEntries.has(cleanName)) {
      return cleanName;
    }
    const pluralTag = `${cleanName}s`;
    if (this.jarBlockTagEntries.has(pluralTag)) {
      const members = this.resolveBlockTag(pluralTag);
      const preferred = `iron_${cleanName}`;
      if (members.has(preferred) && this.jarBlockstateEntries.has(preferred)) {
        return preferred;
      }
      for (const m of members) {
        if (m.endsWith(`_${cleanName}`) && this.jarBlockstateEntries.has(m)) {
          return m;
        }
      }
      for (const m of members) {
        if (this.jarBlockstateEntries.has(m)) {
          return m;
        }
      }
    }
    return cleanName;
  }

  private loadRawBlockstateJson(blockName: string): RawBlockstateJson | null {
    const clean = normalizeBlockName(blockName);
    if (this.blockstateJsonCache.has(clean)) {
      return this.blockstateJsonCache.get(clean) ?? null;
    }

    if (!this.zip) {
      this.blockstateJsonCache.set(clean, null);
      return null;
    }

    const canonical = this.resolveAliasViaTags(clean);
    const entry = this.jarBlockstateEntries.get(canonical);
    if (!entry) {
      this.blockstateJsonCache.set(clean, null);
      return null;
    }

    try {
      const parsed = JSON.parse(this.zip.readAsText(entry)) as RawBlockstateJson;
      this.blockstateJsonCache.set(clean, parsed);
      return parsed;
    } catch {
      this.blockstateJsonCache.set(clean, null);
      return null;
    }
  }

  private loadRawModelJson(modelName: string): RawBlockModelJson | null {
    const clean = normalizeModelRefName(modelName);
    if (this.modelJsonCache.has(clean)) {
      return this.modelJsonCache.get(clean) ?? null;
    }

    if (!this.zip) {
      this.modelJsonCache.set(clean, null);
      return null;
    }

    const entry = this.jarModelEntries.get(clean);
    if (!entry) {
      this.modelJsonCache.set(clean, null);
      return null;
    }

    try {
      const parsed = JSON.parse(this.zip.readAsText(entry)) as RawBlockModelJson;
      this.modelJsonCache.set(clean, parsed);
      return parsed;
    } catch {
      this.modelJsonCache.set(clean, null);
      return null;
    }
  }

  private resolveBlockTag(tagName: string, visited = new Set<string>()): Set<string> {
    const clean = normalizeTagRefName(tagName);
    const cached = this.resolvedTagMembersCache.get(clean);
    if (cached) {
      return cached;
    }
    if (visited.has(clean) || !this.zip) {
      return new Set();
    }
    visited.add(clean);
    try {
      const entry = this.jarBlockTagEntries.get(clean);
      const members = new Set<string>();
      if (!entry) {
        this.resolvedTagMembersCache.set(clean, members);
        return members;
      }

      try {
        const parsed = JSON.parse(this.zip.readAsText(entry)) as RawBlockTagJson;
        for (const rawVal of parsed.values ?? []) {
          const id =
            typeof rawVal === "string"
              ? rawVal
              : typeof rawVal?.id === "string"
                ? rawVal.id
                : null;
          if (!id) continue;
          const trimmed = id.trim();
          if (trimmed.startsWith("#")) {
            for (const sub of this.resolveBlockTag(trimmed, visited)) {
              members.add(sub);
            }
          } else {
            members.add(normalizeBlockName(trimmed));
          }
        }
      } catch {
        // Ignore malformed tag files
      }

      this.resolvedTagMembersCache.set(clean, members);
      return members;
    } finally {
      visited.delete(clean);
    }
  }

  private ensureBlockTagsIndex(): Map<string, string[]> {
    this.ensureInitialized();
    if (this.blockTagsIndex) {
      return this.blockTagsIndex;
    }

    const index = new Map<string, Set<string>>();
    for (const tagKey of this.jarBlockTagEntries.keys()) {
      const members = this.resolveBlockTag(tagKey);
      for (const blockName of members) {
        let set = index.get(blockName);
        if (!set) {
          set = new Set();
          index.set(blockName, set);
        }
        set.add(tagKey);
      }
    }

    const finalized = new Map<string, string[]>();
    for (const [blockName, tagSet] of index.entries()) {
      finalized.set(blockName, Array.from(tagSet).sort());
    }
    this.blockTagsIndex = finalized;
    return finalized;
  }

  /**
   * Returns all Minecraft block tags (e.g. `["fences", "wooden_fences"]`) that include `blockName`,
   * loaded dynamically from `data/minecraft/tags/block(s)/*.json` in the `.jar`.
   */
  public getBlockTags(blockName: string): string[] {
    const clean = normalizeBlockName(blockName);
    const index = this.ensureBlockTagsIndex();
    const direct = index.get(clean);
    if (direct && direct.length > 0) {
      return direct;
    }
    const canonical = this.resolveAliasViaTags(clean);
    return index.get(canonical) ?? [];
  }

  /**
   * Returns all normalized block names belonging to `tagName` (e.g. `"fences"`, `"#minecraft:walls"`).
   */
  public getBlockTagMembers(tagName: string): string[] {
    this.ensureInitialized();
    return Array.from(this.resolveBlockTag(tagName)).sort();
  }

  private normalizeFaceDirection(raw?: string): McFaceDirection | undefined {
    if (!raw) return undefined;
    const lower = raw.toLowerCase();
    if (ALL_FACE_DIRECTIONS.includes(lower as McFaceDirection)) {
      return lower as McFaceDirection;
    }
    return undefined;
  }

  private resolveBlockModel(modelName: string): ResolvedModelInfo {
    const cleanModel = normalizeModelRefName(modelName);
    const cached = this.resolvedModelCache.get(cleanModel);
    if (cached) {
      return cached;
    }

    const chain: RawBlockModelJson[] = [];
    const visited = new Set<string>();
    let currentRef: string | undefined = cleanModel;

    for (let depth = 0; depth < 16 && currentRef; depth++) {
      const cleanRef = normalizeModelRefName(currentRef);
      if (visited.has(cleanRef) || cleanRef.startsWith("builtin/")) break;
      visited.add(cleanRef);

      const raw = this.loadRawModelJson(cleanRef);
      if (!raw) break;
      chain.push(raw);
      currentRef = typeof raw.parent === "string" ? raw.parent : undefined;
    }

    if (chain.length === 0) {
      const fallbackInfo: ResolvedModelInfo = {
        elements: [
          {
            from: [0, 0, 0],
            to: [16, 16, 16],
            faces: Object.fromEntries(
              ALL_FACE_DIRECTIONS.map((dir) => [
                dir,
                { textureKey: cleanModel, cullface: dir } satisfies ResolvedModelFace,
              ])
            ),
          },
        ],
        isFluid: false,
        isFallback: true,
        hasForcedTranslucent: false,
        primaryTextureKey: cleanModel,
      };
      this.resolvedModelCache.set(cleanModel, fallbackInfo);
      return fallbackInfo;
    }

    // Child textures override parent textures
    const mergedTextures: Record<string, unknown> = {};
    for (let i = chain.length - 1; i >= 0; i--) {
      const texMap = chain[i].textures;
      if (texMap && typeof texMap === "object") {
        Object.assign(mergedTextures, texMap);
      }
    }

    let hasForcedTranslucent = false;

    const resolveConcreteTexture = (val: unknown): string | null => {
      let cur: unknown = val;
      for (let i = 0; i < 16 && cur != null; i++) {
        if (typeof cur === "object") {
          const obj = cur as { sprite?: unknown; force_translucent?: unknown };
          if (obj.force_translucent === true) {
            hasForcedTranslucent = true;
          }
          if (typeof obj.sprite === "string") {
            cur = obj.sprite;
          } else {
            return null;
          }
        }
        if (typeof cur !== "string") {
          return null;
        }
        const trimmed = cur.trim();
        if (!trimmed) {
          return null;
        }
        if (trimmed.startsWith("#")) {
          cur = mergedTextures[trimmed.slice(1)];
        } else {
          return normalizeTextureRefName(trimmed);
        }
      }
      return null;
    };

    const rawElements = chain.find((m) => Array.isArray(m.elements) && m.elements.length > 0)?.elements;

    if (!rawElements || rawElements.length === 0) {
      // Models without elements (e.g. fluids water/lava or entity-rendered blocks with particle texture)
      const particleTex =
        resolveConcreteTexture(mergedTextures.particle) ??
        resolveConcreteTexture(Object.values(mergedTextures)[0]) ??
        cleanModel;
      const isWaterFluid =
        particleTex === "water_still" || particleTex === "water_flow";
      const isFluid =
        isWaterFluid ||
        particleTex === "lava_still" ||
        particleTex === "lava_flow";
      const tintindex = isWaterFluid ? 0 : undefined;
      const textureKey = tintindex !== undefined ? `${particleTex}#tinted` : particleTex;

      const synthElement: ResolvedModelElement = {
        from: [0, 0, 0],
        to: [16, 16, 16],
        faces: Object.fromEntries(
          ALL_FACE_DIRECTIONS.map((dir) => [
            dir,
            {
              textureKey,
              cullface: dir,
              ...(tintindex !== undefined ? { tintindex } : {}),
            } satisfies ResolvedModelFace,
          ])
        ),
      };

      const info: ResolvedModelInfo = {
        elements: [synthElement],
        isFluid,
        isFallback: false,
        hasForcedTranslucent,
        primaryTextureKey: textureKey,
      };
      this.resolvedModelCache.set(cleanModel, info);
      return info;
    }

    const resolvedElements: ResolvedModelElement[] = [];
    let primaryTextureKey: string | null = null;

    for (const el of rawElements) {
      if (
        !el ||
        !Array.isArray(el.from) ||
        el.from.length !== 3 ||
        !Array.isArray(el.to) ||
        el.to.length !== 3
      ) {
        continue;
      }
      const faces: Partial<Record<McFaceDirection, ResolvedModelFace>> = {};
      for (const [rawDir, rawFace] of Object.entries(el.faces ?? {})) {
        const dir = this.normalizeFaceDirection(rawDir);
        if (!dir || !rawFace) continue;

        const concrete =
          resolveConcreteTexture(rawFace.texture) ??
          resolveConcreteTexture(mergedTextures.particle) ??
          cleanModel;

        const isWaterTex = concrete === "water_still" || concrete === "water_flow";
        const effectiveTint =
          rawFace.tintindex !== undefined ? rawFace.tintindex : isWaterTex ? 0 : undefined;
        const textureKey = effectiveTint !== undefined ? `${concrete}#tinted` : concrete;

        if (!primaryTextureKey) {
          primaryTextureKey = textureKey;
        }

        const resolvedFace: ResolvedModelFace = {
          textureKey,
        };
        if (Array.isArray(rawFace.uv) && rawFace.uv.length === 4) {
          resolvedFace.uv = [rawFace.uv[0], rawFace.uv[1], rawFace.uv[2], rawFace.uv[3]];
        }
        if (typeof rawFace.rotation === "number") {
          resolvedFace.rotation = rawFace.rotation;
        }
        const cull = this.normalizeFaceDirection(rawFace.cullface);
        if (cull) {
          resolvedFace.cullface = cull;
        }
        if (effectiveTint !== undefined) {
          resolvedFace.tintindex = effectiveTint;
        }

        faces[dir] = resolvedFace;
      }

      let rotation: ResolvedModelElementRotation | undefined;
      if (el.rotation && Array.isArray(el.rotation.origin) && el.rotation.origin.length === 3) {
        rotation = {
          origin: [el.rotation.origin[0], el.rotation.origin[1], el.rotation.origin[2]],
          ...(el.rotation.axis ? { axis: el.rotation.axis } : {}),
          ...(typeof el.rotation.angle === "number" ? { angle: el.rotation.angle } : {}),
          ...(typeof el.rotation.x === "number" ? { x: el.rotation.x } : {}),
          ...(typeof el.rotation.y === "number" ? { y: el.rotation.y } : {}),
          ...(typeof el.rotation.z === "number" ? { z: el.rotation.z } : {}),
          ...(typeof el.rotation.rescale === "boolean" ? { rescale: el.rotation.rescale } : {}),
        };
      }

      const effectiveShade =
        el.shade === false || el.shade_direction_override === "up"
          ? false
          : typeof el.shade === "boolean"
            ? el.shade
            : undefined;

      resolvedElements.push({
        from: [el.from[0], el.from[1], el.from[2]],
        to: [el.to[0], el.to[1], el.to[2]],
        ...(rotation ? { rotation } : {}),
        ...(typeof effectiveShade === "boolean" ? { shade: effectiveShade } : {}),
        faces,
      });
    }

    if (!primaryTextureKey) {
      primaryTextureKey = resolveConcreteTexture(mergedTextures.particle) ?? cleanModel;
    }

    const info: ResolvedModelInfo = {
      elements: resolvedElements,
      isFluid: false,
      isFallback: false,
      hasForcedTranslucent,
      primaryTextureKey,
    };
    this.resolvedModelCache.set(cleanModel, info);
    return info;
  }

  private resolveTextureAsset(textureKey: string): ResolvedTextureAsset {
    const cached = this.textureAssetCache.get(textureKey);
    if (cached) {
      return cached;
    }

    const isTinted = textureKey.endsWith("#tinted");
    const baseName = isTinted ? textureKey.slice(0, -"#tinted".length) : textureKey;
    const isWaterTex = baseName === "water_still" || baseName === "water_flow";
    const tintRgb = isTinted
      ? isWaterTex
        ? DEFAULT_WATER_TINT
        : DEFAULT_GRASS_FOLIAGE_TINT
      : null;

    if (this.zip) {
      const entry = this.jarTextureEntries.get(baseName);
      if (entry) {
        try {
          const rawBuf = this.zip.readFile(entry);
          if (rawBuf && rawBuf.length > 0) {
            const src = PNG.sync.read(rawBuf);
            const isAnimatedStrip =
              src.height > src.width && src.width > 0 && src.height % src.width === 0;
            const outW = src.width;
            const outH = isAnimatedStrip ? src.width : src.height;

            let isOpaque = true;
            let hasTranslucentAlpha = false;

            if (!isAnimatedStrip && !tintRgb && !isWaterTex) {
              for (let y = 0; y < outH; y++) {
                for (let x = 0; x < outW; x++) {
                  const a = src.data[(y * outW + x) * 4 + 3];
                  if (a < 255) isOpaque = false;
                  if (a > 10 && a < 245) hasTranslucentAlpha = true;
                }
              }
              const asset: ResolvedTextureAsset = {
                dataUrl: `data:image/png;base64,${rawBuf.toString("base64")}`,
                hasTranslucentAlpha,
                isOpaque,
              };
              this.textureAssetCache.set(textureKey, asset);
              return asset;
            }

            const out = new PNG({ width: outW, height: outH });
            for (let y = 0; y < outH; y++) {
              for (let x = 0; x < outW; x++) {
                const idx = (y * outW + x) * 4;
                let r = src.data[idx];
                let g = src.data[idx + 1];
                let b = src.data[idx + 2];
                let a = src.data[idx + 3];

                if (a < 255) isOpaque = false;
                if (a > 10 && a < 245) hasTranslucentAlpha = true;

                if (tintRgb) {
                  r = clampByte((r * tintRgb[0]) / 255);
                  g = clampByte((g * tintRgb[1]) / 255);
                  b = clampByte((b * tintRgb[2]) / 255);
                }

                if (isWaterTex && a > 0) {
                  a = Math.max(a, 224);
                }

                out.data[idx] = r;
                out.data[idx + 1] = g;
                out.data[idx + 2] = b;
                out.data[idx + 3] = a;
              }
            }

            const outBuf = PNG.sync.write(out);
            const asset: ResolvedTextureAsset = {
              dataUrl: `data:image/png;base64,${outBuf.toString("base64")}`,
              hasTranslucentAlpha,
              isOpaque,
            };
            this.textureAssetCache.set(textureKey, asset);
            return asset;
          }
        } catch {
          // Fall through to procedural PNG generation
        }
      }
    }

    const fallbackDataUrl = generateProceduralBlockPngDataUrl(baseName);
    const fallbackBuf = Buffer.from(
      fallbackDataUrl.replace(/^data:image\/png;base64,/, ""),
      "base64"
    );
    let isOpaque = true;
    let hasTranslucentAlpha = false;
    try {
      const png = PNG.sync.read(fallbackBuf);
      for (let i = 3; i < png.data.length; i += 4) {
        const a = png.data[i];
        if (a < 255) isOpaque = false;
        if (a > 10 && a < 245) hasTranslucentAlpha = true;
      }
    } catch {
      // ignore
    }

    const asset: ResolvedTextureAsset = {
      dataUrl: fallbackDataUrl,
      hasTranslucentAlpha,
      isOpaque,
    };
    this.textureAssetCache.set(textureKey, asset);
    return asset;
  }

  private normalizeAppliedRef(raw: RawAppliedRefJson): AppliedModelRef {
    return {
      model: normalizeModelRefName(raw.model),
      ...(typeof raw.x === "number" ? { x: raw.x } : {}),
      ...(typeof raw.y === "number" ? { y: raw.y } : {}),
      ...(typeof raw.uvlock === "boolean" ? { uvlock: raw.uvlock } : {}),
    };
  }

  private isFullCubeModelOpaque(elements: ResolvedModelElement[]): boolean {
    const coveredFaces = new Set<McFaceDirection>();
    for (const el of elements) {
      if (el.rotation) continue;
      if (
        el.from[0] !== 0 ||
        el.from[1] !== 0 ||
        el.from[2] !== 0 ||
        el.to[0] !== 16 ||
        el.to[1] !== 16 ||
        el.to[2] !== 16
      ) {
        continue;
      }
      for (const dir of ALL_FACE_DIRECTIONS) {
        const face = el.faces[dir];
        if (!face) continue;
        const asset = this.resolveTextureAsset(face.textureKey);
        if (asset.isOpaque) {
          coveredFaces.add(dir);
        }
      }
    }
    return ALL_FACE_DIRECTIONS.every((d) => coveredFaces.has(d));
  }

  /**
   * Compiles a block's blockstate + model parent chains + texture opacity metadata
   * strictly from `.jar` data (or falls back to a default single-cube definition when absent).
   */
  public compileBlockDefinition(blockName: string): CompiledBlockDefinition {
    this.ensureInitialized();
    const normalized = normalizeBlockName(blockName);
    const cached = this.blockDefCache.get(normalized);
    if (cached) {
      return cached;
    }

    const tags = this.getBlockTags(normalized);
    const rawState = this.loadRawBlockstateJson(normalized);
    if (!rawState || (!rawState.variants && !rawState.multipart)) {
      const modelInfo = this.resolveBlockModel(normalized);
      let hasTranslucent = modelInfo.isFluid || modelInfo.hasForcedTranslucent;
      for (const el of modelInfo.elements) {
        for (const face of Object.values(el.faces)) {
          if (!face) continue;
          const asset = this.resolveTextureAsset(face.textureKey);
          if (asset.hasTranslucentAlpha) hasTranslucent = true;
        }
      }
      const def: CompiledBlockDefinition = {
        blockName: normalized,
        ...(tags.length > 0 ? { tags } : {}),
        variants: { "": [{ model: normalized }] },
        models: { [normalized]: modelInfo.elements },
        isFullOpaqueCube:
          !modelInfo.isFluid &&
          !hasTranslucent &&
          this.isFullCubeModelOpaque(modelInfo.elements),
        isFluid: modelInfo.isFluid,
        isTranslucent: modelInfo.isFluid || hasTranslucent,
        ...(modelInfo.isFallback ? { isFallback: true } : {}),
      };
      this.blockDefCache.set(normalized, def);
      return def;
    }

    const models: Record<string, ResolvedModelElement[]> = {};
    const referencedModels = new Set<string>();
    let variants: Record<string, AppliedModelRef[]> | undefined;
    let multipart: MultipartCase[] | undefined;

    if (rawState.variants) {
      variants = {};
      for (const [stateKey, rawVal] of Object.entries(rawState.variants)) {
        const chosen = Array.isArray(rawVal) ? rawVal[0] : rawVal;
        if (!chosen || typeof chosen.model !== "string") continue;
        const ref = this.normalizeAppliedRef(chosen);
        referencedModels.add(ref.model);
        variants[stateKey] = [ref];
      }
    }

    if (rawState.multipart) {
      multipart = [];
      for (const mc of rawState.multipart) {
        const chosen = Array.isArray(mc.apply) ? mc.apply[0] : mc.apply;
        if (!chosen || typeof chosen.model !== "string") continue;
        const ref = this.normalizeAppliedRef(chosen);
        referencedModels.add(ref.model);
        multipart.push({
          ...(mc.when ? { when: mc.when } : {}),
          apply: [ref],
        });
      }
    }

    let isFluid = false;
    let hasTranslucentAlpha = false;
    const modelOpacity = new Map<string, boolean>();

    for (const modelKey of referencedModels) {
      const info = this.resolveBlockModel(modelKey);
      models[modelKey] = info.elements;
      if (info.isFluid) {
        isFluid = true;
      }
      if (info.hasForcedTranslucent) {
        hasTranslucentAlpha = true;
      }
      for (const el of info.elements) {
        for (const face of Object.values(el.faces)) {
          if (!face) continue;
          const asset = this.resolveTextureAsset(face.textureKey);
          if (asset.hasTranslucentAlpha) {
            hasTranslucentAlpha = true;
          }
        }
      }
      modelOpacity.set(modelKey, this.isFullCubeModelOpaque(info.elements));
    }

    const isTranslucent = isFluid || hasTranslucentAlpha;
    let isFullOpaqueCube = false;
    if (variants && Object.keys(variants).length > 0 && !isFluid && !isTranslucent) {
      isFullOpaqueCube = Object.values(variants).every(
        (refs) =>
          refs.length > 0 &&
          refs.every((r) => modelOpacity.get(r.model) === true)
      );
    }

    const def: CompiledBlockDefinition = {
      blockName: normalized,
      ...(tags.length > 0 ? { tags } : {}),
      ...(variants ? { variants } : {}),
      ...(multipart ? { multipart } : {}),
      models,
      isFullOpaqueCube,
      isFluid,
      isTranslucent,
    };
    this.blockDefCache.set(normalized, def);
    return def;
  }

  /**
   * Resolves a single block name to its primary `data:image/png;base64,...` texture URL.
   */
  public getBlockTextureDataUrl(blockName: string): string {
    this.ensureInitialized();
    const def = this.compileBlockDefinition(blockName);
    for (const elements of Object.values(def.models)) {
      for (const el of elements) {
        for (const face of Object.values(el.faces)) {
          if (face?.textureKey) {
            return this.resolveTextureAsset(face.textureKey).dataUrl;
          }
        }
      }
    }
    return this.resolveTextureAsset(normalizeBlockName(blockName)).dataUrl;
  }

  /**
   * Batch-compiles `CompiledBlockDefinition` objects for a list of block names.
   */
  public getBlockModelsForBlocks(
    blockNames: string[]
  ): Record<string, CompiledBlockDefinition> {
    this.ensureInitialized();
    const result: Record<string, CompiledBlockDefinition> = {};
    for (const rawName of blockNames) {
      if (!rawName) continue;
      const normalized = normalizeBlockName(rawName);
      if (!normalized || normalized === "air" || normalized === "cave_air" || normalized === "void_air") {
        continue;
      }
      if (!(normalized in result)) {
        const def = this.compileBlockDefinition(normalized);
        result[normalized] = def;
        result[`minecraft:${normalized}`] = def;
      }
    }
    return result;
  }

  /**
   * Batch-resolves all texture keys referenced by the compiled models for `blockNames`
   * (plus each block's normalized name as a fallback PNG Data URL).
   */
  public getTexturesForBlocks(blockNames: string[]): Record<string, string> {
    this.ensureInitialized();
    const result: Record<string, string> = {};

    for (const rawName of blockNames) {
      if (!rawName) continue;
      const normalized = normalizeBlockName(rawName);
      if (!normalized || normalized === "air" || normalized === "cave_air" || normalized === "void_air") {
        continue;
      }

      const def = this.compileBlockDefinition(normalized);
      let firstTextureKey: string | null = null;

      for (const elements of Object.values(def.models)) {
        for (const el of elements) {
          for (const face of Object.values(el.faces)) {
            if (!face?.textureKey) continue;
            if (!firstTextureKey) {
              firstTextureKey = face.textureKey;
            }
            if (!(face.textureKey in result)) {
              result[face.textureKey] = this.resolveTextureAsset(face.textureKey).dataUrl;
            }
          }
        }
      }

      if (!(normalized in result)) {
        const primaryUrl = firstTextureKey
          ? result[firstTextureKey] ?? this.resolveTextureAsset(firstTextureKey).dataUrl
          : this.resolveTextureAsset(normalized).dataUrl;
        result[normalized] = primaryUrl;
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
      cachedCount: this.textureAssetCache.size,
    };
  }
}

export const defaultJarAssetLoader = new JarAssetLoader();

export function getJarPath(): string | null {
  return defaultJarAssetLoader.getJarPath();
}

export function getBlockTextureDataUrl(blockName: string): string {
  return defaultJarAssetLoader.getBlockTextureDataUrl(blockName);
}

export function getBlockModelsForBlocks(
  blockNames: string[]
): Record<string, CompiledBlockDefinition> {
  return defaultJarAssetLoader.getBlockModelsForBlocks(blockNames);
}

export function getTexturesForBlocks(blockNames: string[]): Record<string, string> {
  return defaultJarAssetLoader.getTexturesForBlocks(blockNames);
}

export function getStatus(): { jarFound: boolean; jarPath: string | null; cachedCount: number } {
  return defaultJarAssetLoader.getStatus();
}

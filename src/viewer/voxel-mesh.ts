import * as THREE from "three";
import type {
  AppliedModelRef,
  CompiledBlockDefinition,
  McFaceDirection,
  MultipartCondition,
  ResolvedModelElement,
  ResolvedModelElementRotation,
  ViewDirection,
  VoxelData,
} from "../types/shared.js";

export interface BuiltWorldMeshes {
  visualGroup: THREE.Group;
  pickerGeometry: THREE.BufferGeometry;
  bounds: {
    min: THREE.Vector3;
    max: THREE.Vector3;
    center: THREE.Vector3;
    size: THREE.Vector3;
  };
}

interface LoadedTextureAsset {
  texture: THREE.Texture;
  isTranslucent: boolean;
}

const textureAssetCache = new Map<string, LoadedTextureAsset>();
const textureLoader = new THREE.TextureLoader();

function normalizeBlockName(name: string): string {
  return name.replace(/^minecraft:/, "").toLowerCase();
}

function hashString(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function getFallbackColorPalette(shortName: string): {
  base: [number, number, number];
  accent: [number, number, number];
} {
  const h = hashString(shortName);
  const r = 90 + (h & 0x7f);
  const g = 90 + ((h >> 8) & 0x7f);
  const b = 90 + ((h >> 16) & 0x7f);
  return {
    base: [r, g, b],
    accent: [Math.max(0, r - 24), Math.max(0, g - 24), Math.max(0, b - 24)],
  };
}

function createProceduralFallbackAsset(keyName: string): LoadedTextureAsset {
  const shortName = normalizeBlockName(keyName.replace(/#tinted$/, ""));
  const { base, accent } = getFallbackColorPalette(shortName);

  const canvas = document.createElement("canvas");
  canvas.width = 16;
  canvas.height = 16;
  const ctx = canvas.getContext("2d")!;

  let seed = hashString(shortName) || 1;
  const nextRand = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };

  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const isBorder = x === 0 || y === 0 || x === 15 || y === 15;
      const n = (nextRand() - 0.5) * 18;
      const palette = isBorder ? accent : base;
      const r = Math.max(0, Math.min(255, Math.round(palette[0] + n)));
      const g = Math.max(0, Math.min(255, Math.round(palette[1] + n)));
      const b = Math.max(0, Math.min(255, Math.round(palette[2] + n)));
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(x, y, 1, 1);
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return { texture, isTranslucent: false };
}

function detectImageTranslucency(image: HTMLImageElement | HTMLCanvasElement): boolean {
  try {
    const w = image.width || 16;
    const h = image.height || 16;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return false;
    ctx.drawImage(image, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    for (let i = 3; i < data.length; i += 4) {
      const a = data[i];
      if (a > 10 && a < 245) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

async function resolveTextureAsset(
  textureKey: string,
  textures?: Record<string, string>,
  fallbackBlockName?: string
): Promise<LoadedTextureAsset> {
  const shortKey = normalizeBlockName(textureKey);
  const shortFallback = fallbackBlockName ? normalizeBlockName(fallbackBlockName) : shortKey;

  const dataUrl =
    textures?.[textureKey] ??
    textures?.[shortKey] ??
    textures?.[fallbackBlockName ?? ""] ??
    textures?.[shortFallback] ??
    textures?.[`minecraft:${shortFallback}`];

  const cacheKey = dataUrl
    ? `tex:${shortKey}:${dataUrl}`
    : `proc:${shortKey}:${shortFallback}`;

  const existing = textureAssetCache.get(cacheKey);
  if (existing) return existing;

  if (dataUrl) {
    try {
      const loaded = await new Promise<THREE.Texture>((resolve, reject) => {
        textureLoader.load(
          dataUrl,
          (tex) => resolve(tex),
          undefined,
          (err) => reject(err)
        );
      });
      loaded.magFilter = THREE.NearestFilter;
      loaded.minFilter = THREE.NearestFilter;
      loaded.colorSpace = THREE.SRGBColorSpace;
      loaded.generateMipmaps = false;
      loaded.needsUpdate = true;

      const img = loaded.image as HTMLImageElement | HTMLCanvasElement | undefined;
      const isTranslucent = img ? detectImageTranslucency(img) : false;
      const asset: LoadedTextureAsset = { texture: loaded, isTranslucent };
      textureAssetCache.set(cacheKey, asset);
      return asset;
    } catch {
      // Fallback to procedural texture
    }
  }

  const proc = createProceduralFallbackAsset(shortKey || shortFallback);
  textureAssetCache.set(cacheKey, proc);
  return proc;
}

const ALL_DIRS: McFaceDirection[] = ["down", "up", "north", "south", "west", "east"];

const DIR_VECTORS: Record<McFaceDirection, [number, number, number]> = {
  down: [0, -1, 0],
  up: [0, 1, 0],
  north: [0, 0, -1],
  south: [0, 0, 1],
  west: [-1, 0, 0],
  east: [1, 0, 0],
};

const CANONICAL_STATE_DEFAULTS: Record<string, string> = {
  facing: "north",
  half: "bottom",
  type: "bottom",
  shape: "straight",
  axis: "y",
  hanging: "false",
  open: "false",
  powered: "false",
  waterlogged: "false",
  up: "true",
  down: "false",
  north: "none",
  south: "none",
  east: "none",
  west: "none",
  snowy: "false",
  lit: "true",
  part: "foot",
  hinge: "left",
  mode: "compare",
  attachment: "floor",
  face: "wall",
  rotation: "0",
  age: "0",
  level: "0",
  stage: "0",
  moisture: "0",
  bites: "0",
  layers: "1",
  eggs: "1",
  pickles: "1",
  honey_level: "0",
  distance: "1",
  persistent: "false",
  extended: "false",
  conditional: "false",
  occupied: "false",
  triggered: "false",
  has_bottle_0: "false",
  has_bottle_1: "false",
  has_bottle_2: "false",
  eye: "false",
  inverted: "false",
  locked: "false",
  in_wall: "false",
  attached: "false",
  disarmed: "false",
  short: "false",
  bottom: "false",
  drag: "true",
};

function getDefaultPropValue(
  def: CompiledBlockDefinition,
  prop: string
): string | undefined {
  if (prop === "facing") {
    const name = normalizeBlockName(def.blockName);
    if (
      name === "end_rod" ||
      name === "lightning_rod" ||
      name.endsWith("_lightning_rod") ||
      name === "amethyst_cluster" ||
      name.endsWith("_amethyst_bud")
    ) {
      return "up";
    }
    if (name === "hopper") {
      return "down";
    }
    if (name === "observer") {
      return "south";
    }
    if (name === "barrel") {
      return "north";
    }
    if (def.variants) {
      const keys = Object.keys(def.variants);
      const hasNorth = keys.some((k) => /(^|,)facing=north(,|$)/i.test(k));
      if (!hasNorth) {
        if (keys.some((k) => /(^|,)facing=up(,|$)/i.test(k))) {
          return "up";
        }
        if (keys.some((k) => /(^|,)facing=down(,|$)/i.test(k))) {
          return "down";
        }
      }
    }
  }
  return CANONICAL_STATE_DEFAULTS[prop];
}

function getFallbackBlockDef(blockName: string): CompiledBlockDefinition {
  const shortName = normalizeBlockName(blockName);
  const faces = Object.fromEntries(
    ALL_DIRS.map((dir) => [dir, { textureKey: shortName, cullface: dir }])
  );
  return {
    blockName: shortName,
    variants: { "": [{ model: shortName }] },
    models: {
      [shortName]: [{ from: [0, 0, 0], to: [16, 16, 16], faces }],
    },
    isFullOpaqueCube: true,
    isFluid: false,
    isTranslucent: false,
  };
}

function getBlockDef(
  blockName: string,
  blockModels?: Record<string, CompiledBlockDefinition>
): CompiledBlockDefinition {
  if (blockModels) {
    const direct = blockModels[blockName];
    if (direct) return direct;
    const shortName = normalizeBlockName(blockName);
    const byShort = blockModels[shortName];
    if (byShort) return byShort;
    const byPrefixed = blockModels[`minecraft:${shortName}`];
    if (byPrefixed) return byPrefixed;
  }
  return getFallbackBlockDef(blockName);
}

function hasVariantProp(def: CompiledBlockDefinition, propName: string): boolean {
  if (!def.variants) return false;
  const token = `${propName}=`;
  return Object.keys(def.variants).some((k) => k.includes(token));
}

function getMultipartCardinalSignature(def: CompiledBlockDefinition): string | null {
  if (!def.multipart) return null;
  const vals = new Set<string>();
  const collect = (cond?: MultipartCondition) => {
    if (!cond) return;
    if (Array.isArray(cond.OR)) cond.OR.forEach(collect);
    if (Array.isArray(cond.AND)) cond.AND.forEach(collect);
    for (const d of ["north", "south", "east", "west"]) {
      if (cond[d] !== undefined) {
        for (const opt of String(cond[d]).split("|")) {
          vals.add(opt);
        }
      }
    }
    if (cond.up !== undefined) vals.add("has_up");
  };
  for (const mc of def.multipart) collect(mc.when);
  if (vals.size === 0) return null;
  return Array.from(vals).sort().join(",");
}

function dirLeft(facing: string): string {
  switch (facing) {
    case "north":
      return "west";
    case "west":
      return "south";
    case "south":
      return "east";
    case "east":
      return "north";
    default:
      return "west";
  }
}

function dirRight(facing: string): string {
  switch (facing) {
    case "north":
      return "east";
    case "east":
      return "south";
    case "south":
      return "west";
    case "west":
      return "north";
    default:
      return "east";
  }
}

function horizDelta(dir: string): [number, number] {
  switch (dir) {
    case "north":
      return [0, -1];
    case "south":
      return [0, 1];
    case "west":
      return [-1, 0];
    case "east":
      return [1, 0];
    default:
      return [0, -1];
  }
}

function computeDynamicStairShape(
  voxel: VoxelData,
  effectiveState: Record<string, string>,
  voxelMap: Map<string, VoxelData>,
  blockModels?: Record<string, CompiledBlockDefinition>
): string {
  const facing = effectiveState.facing ?? "north";
  const half = effectiveState.half ?? "bottom";

  const getStairState = (dx: number, dz: number): { facing: string; half: string } | null => {
    const neighbor = voxelMap.get(`${voxel.x + dx},${voxel.y},${voxel.z + dz}`);
    if (!neighbor) return null;
    const nDef = getBlockDef(neighbor.name, blockModels);
    if (!hasVariantProp(nDef, "shape")) return null;
    return {
      facing: (neighbor.state?.facing ?? "north").toLowerCase(),
      half: (neighbor.state?.half ?? "bottom").toLowerCase(),
    };
  };

  const [fx, fz] = horizDelta(facing);
  const front = getStairState(fx, fz);
  const left = dirLeft(facing);
  const right = dirRight(facing);

  if (front && front.half === half) {
    if (front.facing === left) {
      const [rx, rz] = horizDelta(right);
      const side = getStairState(rx, rz);
      if (!side || side.half !== half || side.facing !== facing) {
        return "outer_left";
      }
    } else if (front.facing === right) {
      const [lx, lz] = horizDelta(left);
      const side = getStairState(lx, lz);
      if (!side || side.half !== half || side.facing !== facing) {
        return "outer_right";
      }
    }
  }

  const back = getStairState(-fx, -fz);
  if (back && back.half === half) {
    if (back.facing === left) {
      const [lx, lz] = horizDelta(left);
      const side = getStairState(lx, lz);
      if (!side || side.half !== half || side.facing !== facing) {
        return "inner_left";
      }
    } else if (back.facing === right) {
      const [rx, rz] = horizDelta(right);
      const side = getStairState(rx, rz);
      if (!side || side.half !== half || side.facing !== facing) {
        return "inner_right";
      }
    }
  }

  return "straight";
}

function collectMultipartDirValues(def: CompiledBlockDefinition): Record<string, Set<string>> {
  const map: Record<string, Set<string>> = {};
  if (!def.multipart) return map;

  const visit = (cond?: MultipartCondition) => {
    if (!cond) return;
    if (Array.isArray(cond.OR)) cond.OR.forEach(visit);
    if (Array.isArray(cond.AND)) cond.AND.forEach(visit);
    for (const [k, rawVal] of Object.entries(cond)) {
      if (k === "OR" || k === "AND" || rawVal === undefined) continue;
      if (!map[k]) map[k] = new Set();
      for (const opt of String(rawVal).split("|")) {
        map[k].add(opt);
      }
    }
  };

  for (const mc of def.multipart) {
    visit(mc.when);
  }
  return map;
}

function evaluateMultipartCondition(
  cond: MultipartCondition | undefined,
  state: Record<string, string>
): boolean {
  if (!cond) return true;
  if (Array.isArray(cond.OR)) {
    if (!cond.OR.some((sub) => evaluateMultipartCondition(sub, state))) {
      return false;
    }
  }
  if (Array.isArray(cond.AND)) {
    if (!cond.AND.every((sub) => evaluateMultipartCondition(sub, state))) {
      return false;
    }
  }
  for (const [k, rawExpected] of Object.entries(cond)) {
    if (k === "OR" || k === "AND" || rawExpected === undefined) continue;
    const expectedOpts = String(rawExpected).split("|");
    const actual = state[k] ?? CANONICAL_STATE_DEFAULTS[k] ?? "false";
    if (!expectedOpts.includes(actual)) {
      return false;
    }
  }
  return true;
}

export function resolveActiveModelParts(
  voxel: VoxelData,
  def: CompiledBlockDefinition,
  voxelMap: Map<string, VoxelData>,
  blockModels?: Record<string, CompiledBlockDefinition>
): AppliedModelRef[] {
  if (def.multipart && def.multipart.length > 0) {
    const dirValues = collectMultipartDirValues(def);
    const mySig = getMultipartCardinalSignature(def);
    const effectiveState: Record<string, string> = {};
    if (voxel.state) {
      for (const [k, v] of Object.entries(voxel.state)) {
        effectiveState[k.toLowerCase()] = String(v).toLowerCase();
      }
    }

    const canConnectTo = (dx: number, dz: number): boolean => {
      const neighbor = voxelMap.get(`${voxel.x + dx},${voxel.y},${voxel.z + dz}`);
      if (!neighbor) return false;
      const nDef = getBlockDef(neighbor.name, blockModels);
      if (nDef.isFluid) return false;
      if (nDef.isFullOpaqueCube) return true;
      if (nDef.blockName === def.blockName) return true;
      if (mySig && getMultipartCardinalSignature(nDef) === mySig) return true;
      return false;
    };

    const aboveVoxel = voxelMap.get(`${voxel.x},${voxel.y + 1},${voxel.z}`);
    const aboveDef = aboveVoxel ? getBlockDef(aboveVoxel.name, blockModels) : null;
    const aboveConnectsSolid = Boolean(
      aboveDef &&
        !aboveDef.isFluid &&
        (aboveDef.isFullOpaqueCube || aboveDef.blockName === def.blockName)
    );

    for (const dir of ["north", "south", "east", "west"] as const) {
      if (!(dir in effectiveState) && dirValues[dir]) {
        const [dx, dz] = horizDelta(dir);
        const connected = canConnectTo(dx, dz);
        const usesWallHeights =
          dirValues[dir].has("low") || dirValues[dir].has("tall");
        if (usesWallHeights) {
          effectiveState[dir] = connected
            ? aboveConnectsSolid
              ? "tall"
              : "low"
            : "none";
        } else {
          effectiveState[dir] = connected ? "true" : "false";
        }
      }
    }

    if (!("up" in effectiveState) && dirValues.up) {
      const isConn = (v?: string) => Boolean(v && v !== "false" && v !== "none");
      const nC = isConn(effectiveState.north);
      const sC = isConn(effectiveState.south);
      const eC = isConn(effectiveState.east);
      const wC = isConn(effectiveState.west);
      const straightNS = nC && sC && !eC && !wC;
      const straightEW = eC && wC && !nC && !sC;
      if (aboveVoxel && aboveDef && !aboveDef.isFluid) {
        effectiveState.up = "true";
      } else if (straightNS || straightEW) {
        effectiveState.up = "false";
      } else {
        effectiveState.up = "true";
      }
    }

    const activeRefs: AppliedModelRef[] = [];
    for (const mc of def.multipart) {
      if (evaluateMultipartCondition(mc.when, effectiveState)) {
        for (const ref of mc.apply) {
          activeRefs.push(ref);
        }
      }
    }
    return activeRefs;
  }

  if (def.variants) {
    const entries = Object.entries(def.variants);
    if (entries.length === 0) return [];
    if (entries.length === 1 && entries[0][0] === "") {
      return entries[0][1];
    }

    const effectiveState: Record<string, string> = {};
    if (voxel.state) {
      for (const [k, v] of Object.entries(voxel.state)) {
        effectiveState[k.toLowerCase()] = String(v).toLowerCase();
      }
    }

    const usesType = hasVariantProp(def, "type");
    const usesHalf = hasVariantProp(def, "half");
    if (usesType && !("type" in effectiveState) && "half" in effectiveState) {
      effectiveState.type = effectiveState.half;
    }
    if (usesHalf && !("half" in effectiveState) && "type" in effectiveState) {
      effectiveState.half = effectiveState.type;
    }

    if (hasVariantProp(def, "shape") && !("shape" in effectiveState)) {
      effectiveState.shape = computeDynamicStairShape(
        voxel,
        effectiveState,
        voxelMap,
        blockModels
      );
    }

    let bestRefs = entries[0][1];
    let bestScore = -Infinity;

    for (const [key, refs] of entries) {
      if (key === "") {
        if (0 > bestScore) {
          bestScore = 0;
          bestRefs = refs;
        }
        continue;
      }

      const pairs = key.split(",");
      let score = 0;
      let valid = true;

      for (const pair of pairs) {
        const eqIdx = pair.indexOf("=");
        if (eqIdx === -1) continue;
        const prop = pair.slice(0, eqIdx).trim().toLowerCase();
        const val = pair.slice(eqIdx + 1).trim().toLowerCase();

        if (prop in effectiveState) {
          if (effectiveState[prop] === val) {
            score += 100;
          } else {
            valid = false;
            break;
          }
        } else if (getDefaultPropValue(def, prop) === val) {
          score += 1;
        }
      }

      if (valid && score > bestScore) {
        bestScore = score;
        bestRefs = refs;
      }
    }

    return bestRefs;
  }

  const firstModelKey = Object.keys(def.models)[0];
  return firstModelKey ? [{ model: firstModelKey }] : [];
}

function getUnrotatedFaceCorners(
  dir: McFaceDirection,
  from: [number, number, number],
  to: [number, number, number]
): {
  corners: [
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
  ];
  normal: [number, number, number];
} {
  const [x1, y1, z1] = from;
  const [x2, y2, z2] = to;

  switch (dir) {
    case "south":
      return {
        corners: [
          [x1, y2, z2],
          [x1, y1, z2],
          [x2, y1, z2],
          [x2, y2, z2],
        ],
        normal: [0, 0, 1],
      };
    case "north":
      return {
        corners: [
          [x2, y2, z1],
          [x2, y1, z1],
          [x1, y1, z1],
          [x1, y2, z1],
        ],
        normal: [0, 0, -1],
      };
    case "east":
      return {
        corners: [
          [x2, y2, z2],
          [x2, y1, z2],
          [x2, y1, z1],
          [x2, y2, z1],
        ],
        normal: [1, 0, 0],
      };
    case "west":
      return {
        corners: [
          [x1, y2, z1],
          [x1, y1, z1],
          [x1, y1, z2],
          [x1, y2, z2],
        ],
        normal: [-1, 0, 0],
      };
    case "up":
      return {
        corners: [
          [x1, y2, z1],
          [x1, y2, z2],
          [x2, y2, z2],
          [x2, y2, z1],
        ],
        normal: [0, 1, 0],
      };
    case "down":
      return {
        corners: [
          [x1, y1, z2],
          [x1, y1, z1],
          [x2, y1, z1],
          [x2, y1, z2],
        ],
        normal: [0, -1, 0],
      };
  }
}

function getDefaultFaceUv(
  dir: McFaceDirection,
  from: [number, number, number],
  to: [number, number, number]
): [number, number, number, number] {
  const [x1, y1, z1] = from;
  const [x2, y2, z2] = to;
  switch (dir) {
    case "down":
      return [x1, 16 - z2, x2, 16 - z1];
    case "up":
      return [x1, z1, x2, z2];
    case "north":
      return [16 - x2, 16 - y2, 16 - x1, 16 - y1];
    case "south":
      return [x1, 16 - y2, x2, 16 - y1];
    case "west":
      return [z1, 16 - y2, z2, 16 - y1];
    case "east":
      return [16 - z2, 16 - y2, 16 - z1, 16 - y1];
  }
}

function rotatePointAroundAxis(
  p: [number, number, number],
  origin: [number, number, number],
  axis: "x" | "y" | "z",
  angleDeg: number,
  rescale: boolean,
  isNormal: boolean
): [number, number, number] {
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const invCos = rescale && !isNormal && Math.abs(cos) > 1e-4 ? 1 / Math.abs(cos) : 1;

  let x = p[0] - (isNormal ? 0 : origin[0]);
  let y = p[1] - (isNormal ? 0 : origin[1]);
  let z = p[2] - (isNormal ? 0 : origin[2]);

  if (axis === "x") {
    const ny = y * cos - z * sin;
    const nz = y * sin + z * cos;
    y = ny * invCos;
    z = nz * invCos;
  } else if (axis === "y") {
    const nx = x * cos + z * sin;
    const nz = -x * sin + z * cos;
    x = nx * invCos;
    z = nz * invCos;
  } else {
    const nx = x * cos - y * sin;
    const ny = x * sin + y * cos;
    x = nx * invCos;
    y = ny * invCos;
  }

  return [
    x + (isNormal ? 0 : origin[0]),
    y + (isNormal ? 0 : origin[1]),
    z + (isNormal ? 0 : origin[2]),
  ];
}

function applyElementRotation(
  p: [number, number, number],
  rot: ResolvedModelElementRotation,
  isNormal: boolean
): [number, number, number] {
  let out = p;
  if (rot.axis && typeof rot.angle === "number") {
    out = rotatePointAroundAxis(out, rot.origin, rot.axis, rot.angle, Boolean(rot.rescale), isNormal);
  } else {
    if (typeof rot.x === "number" && rot.x !== 0) {
      out = rotatePointAroundAxis(out, rot.origin, "x", rot.x, Boolean(rot.rescale), isNormal);
    }
    if (typeof rot.y === "number" && rot.y !== 0) {
      out = rotatePointAroundAxis(out, rot.origin, "y", rot.y, Boolean(rot.rescale), isNormal);
    }
    if (typeof rot.z === "number" && rot.z !== 0) {
      out = rotatePointAroundAxis(out, rot.origin, "z", rot.z, Boolean(rot.rescale), isNormal);
    }
  }
  if (isNormal) {
    const len = Math.hypot(out[0], out[1], out[2]) || 1;
    return [out[0] / len, out[1] / len, out[2] / len];
  }
  return out;
}

function applyBlockstateRotation(
  p: [number, number, number],
  stepsX: number,
  stepsY: number,
  translateCenter: boolean
): [number, number, number] {
  let x = p[0] - (translateCenter ? 8 : 0);
  let y = p[1] - (translateCenter ? 8 : 0);
  let z = p[2] - (translateCenter ? 8 : 0);

  for (let i = 0; i < stepsX; i++) {
    const ny = z;
    const nz = -y;
    y = ny;
    z = nz;
  }

  for (let i = 0; i < stepsY; i++) {
    const nx = -z;
    const nz = x;
    x = nx;
    z = nz;
  }

  return [
    x + (translateCenter ? 8 : 0),
    y + (translateCenter ? 8 : 0),
    z + (translateCenter ? 8 : 0),
  ];
}

function vectorToFaceDirection(n: [number, number, number]): McFaceDirection {
  const ax = Math.abs(n[0]);
  const ay = Math.abs(n[1]);
  const az = Math.abs(n[2]);
  if (ay >= ax && ay >= az) {
    return n[1] >= 0 ? "up" : "down";
  }
  if (az >= ax && az >= ay) {
    return n[2] >= 0 ? "south" : "north";
  }
  return n[0] >= 0 ? "east" : "west";
}

function computeBoxLockedUv(
  faceDir: McFaceDirection,
  lx: number,
  ly: number,
  lz: number
): [number, number] {
  switch (faceDir) {
    case "up":
      return [lx, 1 - lz];
    case "down":
      return [lx, lz];
    case "north":
      return [1 - lx, ly];
    case "south":
      return [lx, ly];
    case "east":
      return [1 - lz, ly];
    case "west":
      return [lz, ly];
  }
}

function computeShadeFactor(n: [number, number, number]): number {
  if (n[1] > 0.5) return 1.0;
  if (n[1] < -0.5) return 0.55;
  if (Math.abs(n[2]) >= Math.abs(n[0])) return 0.88;
  return 0.74;
}

function isCoplanarWithPreviousElement(
  elements: ResolvedModelElement[],
  idx: number
): boolean {
  const cur = elements[idx];
  if (cur.rotation) return false;
  for (let i = 0; i < idx; i++) {
    const prev = elements[i];
    if (prev.rotation) continue;
    if (
      prev.from[0] === cur.from[0] &&
      prev.from[1] === cur.from[1] &&
      prev.from[2] === cur.from[2] &&
      prev.to[0] === cur.to[0] &&
      prev.to[1] === cur.to[1] &&
      prev.to[2] === cur.to[2]
    ) {
      return true;
    }
  }
  return false;
}

function isInstanceFullOpaqueCube(
  voxel: VoxelData,
  def: CompiledBlockDefinition,
  voxelMap: Map<string, VoxelData>,
  blockModels?: Record<string, CompiledBlockDefinition>
): boolean {
  if (def.isFullOpaqueCube) return true;
  if (def.isFluid || def.isTranslucent || !def.variants) return false;

  const refs = resolveActiveModelParts(voxel, def, voxelMap, blockModels);
  if (refs.length !== 1) return false;
  const elements = def.models[refs[0].model];
  if (!elements || elements.length === 0) return false;

  const covered = new Set<McFaceDirection>();
  for (const el of elements) {
    if (el.rotation) continue;
    if (
      el.from[0] === 0 &&
      el.from[1] === 0 &&
      el.from[2] === 0 &&
      el.to[0] === 16 &&
      el.to[1] === 16 &&
      el.to[2] === 16
    ) {
      for (const dir of ALL_DIRS) {
        if (el.faces[dir]) covered.add(dir);
      }
    }
  }
  return ALL_DIRS.every((d) => covered.has(d));
}

function shouldCullFace(
  cullDir: McFaceDirection | undefined,
  voxel: VoxelData,
  def: CompiledBlockDefinition,
  voxelMap: Map<string, VoxelData>,
  blockModels?: Record<string, CompiledBlockDefinition>
): boolean {
  if (!cullDir) return false;
  const [dx, dy, dz] = DIR_VECTORS[cullDir];
  const neighbor = voxelMap.get(`${voxel.x + dx},${voxel.y + dy},${voxel.z + dz}`);
  if (!neighbor) return false;

  const nDef = getBlockDef(neighbor.name, blockModels);

  if (def.isFluid) {
    if (nDef.isFluid) return true;
    return isInstanceFullOpaqueCube(neighbor, nDef, voxelMap, blockModels);
  }

  if (nDef.isFluid) {
    return false;
  }

  if (isInstanceFullOpaqueCube(neighbor, nDef, voxelMap, blockModels)) {
    return true;
  }

  if (nDef.isTranslucent && nDef.blockName === def.blockName) {
    return true;
  }

  return false;
}

interface TextureBucketArrays {
  positions: number[];
  normals: number[];
  uvs: number[];
  colors: number[];
  indices: number[];
}

function getOrCreateBucket(
  buckets: Map<string, TextureBucketArrays>,
  textureKey: string
): TextureBucketArrays {
  let b = buckets.get(textureKey);
  if (!b) {
    b = { positions: [], normals: [], uvs: [], colors: [], indices: [] };
    buckets.set(textureKey, b);
  }
  return b;
}

/**
 * Builds both the Visual Group (data-driven blockstates/models + crisp edges)
 * and the Data Picking BufferGeometry (`aPickColor`).
 */
export async function buildWorldMeshes(
  voxels: VoxelData[],
  worldSize: [number, number, number],
  textures?: Record<string, string>,
  blockModels?: Record<string, CompiledBlockDefinition>
): Promise<BuiltWorldMeshes> {
  const visualGroup = new THREE.Group();
  visualGroup.name = "VoxelVisualGroup";

  const voxelMap = new Map<string, VoxelData>();
  for (const v of voxels) {
    voxelMap.set(`${v.x},${v.y},${v.z}`, v);
  }

  const pickPositions: number[] = [];
  const pickIndices: number[] = [];
  const pickBytes: number[] = [];

  const edgePositions: number[] = [];
  const edgeIndices: number[] = [];

  const textureBuckets = new Map<string, TextureBucketArrays>();
  const textureFallbackBlock = new Map<string, string>();

  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;

  const quadIndexPattern = [0, 1, 2, 0, 2, 3];

  for (const voxel of voxels) {
    if (voxel.x < minX) minX = voxel.x;
    if (voxel.y < minY) minY = voxel.y;
    if (voxel.z < minZ) minZ = voxel.z;
    if (voxel.x + 1 > maxX) maxX = voxel.x + 1;
    if (voxel.y + 1 > maxY) maxY = voxel.y + 1;
    if (voxel.z + 1 > maxZ) maxZ = voxel.z + 1;

    const def = getBlockDef(voxel.name, blockModels);
    const activeParts = resolveActiveModelParts(voxel, def, voxelMap, blockModels);

    const rByte = Math.max(0, Math.min(255, voxel.x));
    const gByte = Math.max(0, Math.min(255, voxel.y));
    const bByte = Math.max(0, Math.min(255, voxel.z));
    const aByte = Math.max(0, Math.min(255, voxel.opId ?? 0));

    for (const partRef of activeParts) {
      const elements = def.models[partRef.model];
      if (!elements || elements.length === 0) continue;

      const stepsX = (((partRef.x ?? 0) / 90) % 4 + 4) % 4;
      const stepsY = (((partRef.y ?? 0) / 90) % 4 + 4) % 4;
      const applyUvLock = Boolean(partRef.uvlock) && (stepsX !== 0 || stepsY !== 0);

      for (let elemIdx = 0; elemIdx < elements.length; elemIdx++) {
        const el = elements[elemIdx];
        const isOverlay = isCoplanarWithPreviousElement(elements, elemIdx);
        const overlayOffset = isOverlay ? elemIdx * 0.001 : 0;
        const isZeroThickness =
          el.from[0] === el.to[0] || el.from[1] === el.to[1] || el.from[2] === el.to[2];
        const addEdges =
          !def.isFluid &&
          !def.isTranslucent &&
          !el.rotation &&
          !isZeroThickness &&
          !isOverlay;

        for (const dir of ALL_DIRS) {
          const faceDef = el.faces[dir];
          if (!faceDef) continue;

          // Compute rotated cullface direction
          let rotatedCullDir: McFaceDirection | undefined;
          if (faceDef.cullface) {
            const cullVec = applyBlockstateRotation(
              DIR_VECTORS[faceDef.cullface],
              stepsX,
              stepsY,
              false
            );
            rotatedCullDir = vectorToFaceDirection(cullVec);
          }

          if (shouldCullFace(rotatedCullDir, voxel, def, voxelMap, blockModels)) {
            continue;
          }

          const { corners, normal } = getUnrotatedFaceCorners(dir, el.from, el.to);
          const rawUv = faceDef.uv ?? getDefaultFaceUv(dir, el.from, el.to);
          const [u1, v1, u2, v2] = rawUv;
          const baseUvs: [number, number][] = [
            [u1 / 16, 1 - v1 / 16],
            [u1 / 16, 1 - v2 / 16],
            [u2 / 16, 1 - v2 / 16],
            [u2 / 16, 1 - v1 / 16],
          ];
          const rotSteps = (((faceDef.rotation ?? 0) / 90) % 4 + 4) % 4;

          let rotNormal = normal;
          if (el.rotation) {
            rotNormal = applyElementRotation(rotNormal, el.rotation, true);
          }
          rotNormal = applyBlockstateRotation(rotNormal, stepsX, stepsY, false);
          const rotFaceDir = vectorToFaceDirection(rotNormal);
          const shade = computeShadeFactor(rotNormal);

          const worldCorners: [number, number, number][] = [];
          const cornerUvs: [number, number][] = [];

          for (let ci = 0; ci < 4; ci++) {
            let pt = corners[ci];
            if (el.rotation) {
              pt = applyElementRotation(pt, el.rotation, false);
            }
            pt = applyBlockstateRotation(pt, stepsX, stepsY, true);

            const lx = pt[0] / 16;
            const ly = pt[1] / 16;
            const lz = pt[2] / 16;

            worldCorners.push([
              voxel.x + lx + rotNormal[0] * overlayOffset,
              voxel.y + ly + rotNormal[1] * overlayOffset,
              voxel.z + lz + rotNormal[2] * overlayOffset,
            ]);

            if (applyUvLock && !el.rotation) {
              cornerUvs.push(computeBoxLockedUv(rotFaceDir, lx, ly, lz));
            } else {
              cornerUvs.push(baseUvs[(ci + rotSteps) % 4]);
            }
          }

          const bucket = getOrCreateBucket(textureBuckets, faceDef.textureKey);
          if (!textureFallbackBlock.has(faceDef.textureKey)) {
            textureFallbackBlock.set(faceDef.textureKey, def.blockName);
          }

          const bucketVertBase = bucket.positions.length / 3;
          for (let ci = 0; ci < 4; ci++) {
            bucket.positions.push(
              worldCorners[ci][0],
              worldCorners[ci][1],
              worldCorners[ci][2]
            );
            bucket.normals.push(rotNormal[0], rotNormal[1], rotNormal[2]);
            bucket.uvs.push(cornerUvs[ci][0], cornerUvs[ci][1]);
            bucket.colors.push(shade, shade, shade);
          }
          for (const idxOffset of quadIndexPattern) {
            bucket.indices.push(bucketVertBase + idxOffset);
          }

          if (!isOverlay) {
            const pickVertBase = pickPositions.length / 3;
            for (let ci = 0; ci < 4; ci++) {
              pickPositions.push(
                worldCorners[ci][0],
                worldCorners[ci][1],
                worldCorners[ci][2]
              );
              pickBytes.push(rByte, gByte, bByte, aByte);
            }
            for (const idxOffset of quadIndexPattern) {
              pickIndices.push(pickVertBase + idxOffset);
            }
          }

          if (addEdges) {
            const edgeVertBase = edgePositions.length / 3;
            for (let ci = 0; ci < 4; ci++) {
              edgePositions.push(
                worldCorners[ci][0],
                worldCorners[ci][1],
                worldCorners[ci][2]
              );
            }
            for (const idxOffset of quadIndexPattern) {
              edgeIndices.push(edgeVertBase + idxOffset);
            }
          }
        }
      }
    }
  }

  for (const [textureKey, bucket] of textureBuckets.entries()) {
    if (bucket.positions.length === 0 || bucket.indices.length === 0) continue;

    const fallbackBlock = textureFallbackBlock.get(textureKey);
    const asset = await resolveTextureAsset(textureKey, textures, fallbackBlock);

    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.Float32BufferAttribute(bucket.positions, 3));
    geom.setAttribute("normal", new THREE.Float32BufferAttribute(bucket.normals, 3));
    geom.setAttribute("uv", new THREE.Float32BufferAttribute(bucket.uvs, 2));
    geom.setAttribute("color", new THREE.Float32BufferAttribute(bucket.colors, 3));
    geom.setIndex(bucket.indices);

    const mat = new THREE.MeshBasicMaterial({
      map: asset.texture,
      vertexColors: true,
      transparent: asset.isTranslucent,
      opacity: 1.0,
      alphaTest: asset.isTranslucent ? 0 : 0.1,
      depthWrite: !asset.isTranslucent,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });

    const mesh = new THREE.Mesh(geom, mat);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    if (asset.isTranslucent) {
      mesh.renderOrder = 2;
    }
    visualGroup.add(mesh);
  }

  if (edgePositions.length > 0 && edgeIndices.length > 0) {
    const combinedEdgeSourceGeom = new THREE.BufferGeometry();
    combinedEdgeSourceGeom.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(edgePositions, 3)
    );
    combinedEdgeSourceGeom.setIndex(edgeIndices);

    const edges = new THREE.EdgesGeometry(combinedEdgeSourceGeom, 25);
    combinedEdgeSourceGeom.dispose();

    const lineMat = new THREE.LineBasicMaterial({
      color: 0x0f172a,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
    });
    const lines = new THREE.LineSegments(edges, lineMat);
    lines.renderOrder = 1;
    visualGroup.add(lines);
  }

  const pickerGeometry = new THREE.BufferGeometry();
  pickerGeometry.setAttribute("position", new THREE.Float32BufferAttribute(pickPositions, 3));
  pickerGeometry.setAttribute(
    "aPickColor",
    new THREE.BufferAttribute(new Uint8Array(pickBytes), 4, true)
  );
  pickerGeometry.setIndex(pickIndices);

  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    minZ = 0;
    maxX = worldSize[0] || 32;
    maxY = worldSize[1] || 32;
    maxZ = worldSize[2] || 32;
  }

  const min = new THREE.Vector3(minX, minY, minZ);
  const max = new THREE.Vector3(maxX, maxY, maxZ);
  const center = new THREE.Vector3().addVectors(min, max).multiplyScalar(0.5);
  const size = new THREE.Vector3().subVectors(max, min);

  return {
    visualGroup,
    pickerGeometry,
    bounds: { min, max, center, size },
  };
}

function isCutawayExteriorProp(name: string): boolean {
  const shortName = normalizeBlockName(name);
  return (
    shortName.includes("fence") ||
    shortName.includes("torch") ||
    shortName.includes("lantern") ||
    shortName.includes("candle") ||
    shortName.includes("flower") ||
    shortName.includes("potted") ||
    shortName.includes("carpet") ||
    shortName.includes("pressure_plate") ||
    shortName.includes("button") ||
    shortName.includes("lever") ||
    shortName.includes("sign") ||
    shortName.includes("banner") ||
    shortName.includes("rail") ||
    shortName.includes("leaves") ||
    shortName.includes("sapling")
  );
}

/**
 * Filters world voxels for Dollhouse Cutaway mode at height `cutY` and camera `view`:
 * 1. Ceiling/Roof Cut: Hides all voxels with `voxel.y > cutY`.
 * 2. Camera-Facing Outer Wall Cutaway: Computes the outer structural wall X/Z perimeter
 *    (ignoring exterior props like fences, torches, lanterns, and isolated single-column posts),
 *    then hides non-terrain blocks on the two outer walls facing the camera direction
 *    (`NE`, `SE`, `SW`, `NW`) so the interior floor, back walls, partitions, and furniture are visible.
 */
export function filterVoxelsForCutaway(
  voxels: VoxelData[],
  cutY: number,
  view?: ViewDirection
): VoxelData[] {
  const isCutawayFurnitureBlock = (name: string): boolean => {
    const shortName = normalizeBlockName(name);
    return (
      shortName.includes("chest") ||
      shortName.includes("barrel") ||
      shortName.includes("shulker_box") ||
      shortName.endsWith("_bed") ||
      shortName.endsWith("_stairs") ||
      shortName.includes("crafting_table") ||
      shortName.includes("furnace") ||
      shortName.includes("smoker") ||
      shortName.includes("anvil") ||
      shortName.includes("enchanting_table") ||
      shortName.includes("lectern") ||
      shortName.includes("brewing_stand") ||
      shortName.includes("cauldron") ||
      shortName.includes("composter") ||
      shortName.includes("loom") ||
      shortName.includes("cartography_table") ||
      shortName.includes("fletching_table") ||
      shortName.includes("smithing_table") ||
      shortName.includes("grindstone") ||
      shortName.includes("stonecutter") ||
      shortName.includes("jukebox") ||
      shortName.includes("note_block") ||
      shortName.includes("bookshelf") ||
      shortName === "bell" ||
      shortName.includes("beacon") ||
      shortName.includes("hopper") ||
      shortName.includes("scaffolding") ||
      shortName.includes("ladder") ||
      shortName.includes("campfire")
    );
  };

  let minBY = Infinity;
  const nonTerrainCoords = new Set<string>();
  const terrainCoords = new Set<string>();
  const allOccupiedCoords = new Set<string>();
  const structuralByY = new Map<number, VoxelData[]>();
  const allStructuralCoords = new Set<string>();

  for (const v of voxels) {
    const key = `${v.x},${v.y},${v.z}`;
    allOccupiedCoords.add(key);
    if (v.isTerrain) {
      terrainCoords.add(key);
    } else {
      if (v.y < minBY) {
        minBY = v.y;
      }
      nonTerrainCoords.add(key);
      if (!isCutawayExteriorProp(v.name)) {
        allStructuralCoords.add(key);
        if (v.y <= cutY) {
          let list = structuralByY.get(v.y);
          if (!list) {
            list = [];
            structuralByY.set(v.y, list);
          }
          list.push(v);
        }
      }
    }
  }

  interface LayerExtrema {
    xzSet: Set<string>;
    minXByZ: Map<number, number>;
    maxXByZ: Map<number, number>;
    minZByX: Map<number, number>;
    maxZByX: Map<number, number>;
  }

  const layerExtremaByY = new Map<number, LayerExtrema>();
  for (const [y, list] of structuralByY.entries()) {
    const xzSet = new Set<string>();
    const minXByZ = new Map<number, number>();
    const maxXByZ = new Map<number, number>();
    const minZByX = new Map<number, number>();
    const maxZByX = new Map<number, number>();
    for (const v of list) {
      xzSet.add(`${v.x},${v.z}`);
      const cxMin = minXByZ.get(v.z);
      if (cxMin === undefined || v.x < cxMin) minXByZ.set(v.z, v.x);
      const cxMax = maxXByZ.get(v.z);
      if (cxMax === undefined || v.x > cxMax) maxXByZ.set(v.z, v.x);
      const czMin = minZByX.get(v.x);
      if (czMin === undefined || v.z < czMin) minZByX.set(v.x, v.z);
      const czMax = maxZByX.get(v.x);
      if (czMax === undefined || v.z > czMax) maxZByX.set(v.x, v.z);
    }
    layerExtremaByY.set(y, { xzSet, minXByZ, maxXByZ, minZByX, maxZByX });
  }

  const isEnclosedInLayer = (x: number, z: number, y: number): boolean => {
    const ex = layerExtremaByY.get(y);
    if (!ex) return false;
    return (
      (ex.minXByZ.get(z) ?? Infinity) < x &&
      (ex.maxXByZ.get(z) ?? -Infinity) > x &&
      (ex.minZByX.get(x) ?? Infinity) < z &&
      (ex.maxZByX.get(x) ?? -Infinity) > z
    );
  };

  const isBracketedInLayer = (x: number, z: number, y: number): boolean => {
    const ex = layerExtremaByY.get(y);
    if (!ex) return false;
    const negX = (ex.minXByZ.get(z) ?? Infinity) < x;
    const posX = (ex.maxXByZ.get(z) ?? -Infinity) > x;
    const negZ = (ex.minZByX.get(x) ?? Infinity) < z;
    const posZ = (ex.maxZByX.get(x) ?? -Infinity) > z;
    return (
      (negX && posX && (negZ || posZ)) || (negZ && posZ && (negX || posX))
    );
  };

  // 1. Detect all qualifying floor slab Y levels below cutY.
  // A floor slab has interior blocks with air directly above (y + 1) and walls standing on it (y + 1).
  const yFloorStats: Array<{
    y: number;
    coveredByAir: number;
    enclosedCovered: number;
    bracketedCovered: number;
    nonFurnitureCovered: number;
    total: number;
    nextYCount: number;
  }> = [];

  for (const [y, list] of structuralByY.entries()) {
    if (y >= cutY) continue;
    let coveredByAir = 0;
    let enclosedCovered = 0;
    let bracketedCovered = 0;
    let nonFurnitureCovered = 0;
    for (const v of list) {
      const aboveKey = `${v.x},${v.y + 1},${v.z}`;
      if (!allStructuralCoords.has(aboveKey) && !terrainCoords.has(aboveKey)) {
        coveredByAir++;
        if (isEnclosedInLayer(v.x, v.z, y + 1)) {
          enclosedCovered++;
        }
        if (isBracketedInLayer(v.x, v.z, y + 1)) {
          bracketedCovered++;
        }
        if (!isCutawayFurnitureBlock(v.name)) {
          nonFurnitureCovered++;
        }
      }
    }
    const nextYCount = structuralByY.get(y + 1)?.length ?? 0;
    yFloorStats.push({
      y,
      coveredByAir,
      enclosedCovered,
      bracketedCovered,
      nonFurnitureCovered,
      total: list.length,
      nextYCount,
    });
  }

  yFloorStats.sort((a, b) => a.y - b.y);

  const isTerrainFloorFirstStory = (
    s: (typeof yFloorStats)[number]
  ): boolean => {
    if (s.y !== minBY) return false;
    const list = structuralByY.get(s.y);
    if (!list || list.length === 0) return false;
    let onTerrainCount = 0;
    for (const v of list) {
      if (terrainCoords.has(`${v.x},${s.y - 1},${v.z}`)) {
        onTerrainCount++;
      }
    }
    if (onTerrainCount * 2 < list.length) return false;

    const adjTerrainAirKeys = new Set<string>();
    for (const v of list) {
      for (const [dx, dz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nx = v.x + dx;
        const nz = v.z + dz;
        const nKey = `${nx},${s.y},${nz}`;
        if (allStructuralCoords.has(nKey) || terrainCoords.has(nKey)) continue;
        if (
          terrainCoords.has(`${nx},${s.y - 1},${nz}`) &&
          isBracketedInLayer(nx, nz, s.y)
        ) {
          adjTerrainAirKeys.add(`${nx},${nz}`);
        }
      }
    }
    const adjInteriorTerrainAir = adjTerrainAirKeys.size;
    return (
      (adjInteriorTerrainAir > 0 &&
        s.nonFurnitureCovered <= adjInteriorTerrainAir) ||
      (s.coveredByAir > 0 && s.nonFurnitureCovered === 0)
    );
  };

  // Evaluate wall-supporting floors (nextYCount >= 4) first so flat roofs (nextYCount === 0)
  // and larger upper stories cannot shadow or disqualify genuine smaller lower floor slabs.
  const wallSupportingFloors = yFloorStats.filter(
    (s) => s.total >= 9 && s.nextYCount >= 4 && !isTerrainFloorFirstStory(s)
  );

  const qualifiesAsFloor = (
    s: (typeof yFloorStats)[number],
    useBracketed: boolean
  ): boolean => {
    const eff = useBracketed ? s.bracketedCovered : s.enclosedCovered;
    return eff >= 4 || (s.total <= 25 && eff >= 2);
  };

  const hasEnclosedFloor = wallSupportingFloors.some((s) =>
    qualifiesAsFloor(s, false)
  );
  const useBracketed = !hasEnclosedFloor;
  const hasQualifyingFloor = wallSupportingFloors.some((s) =>
    qualifiesAsFloor(s, useBracketed)
  );

  const prevCoversCandidate = (prevY: number, candY: number): boolean => {
    const prevXZ = layerExtremaByY.get(prevY)?.xzSet;
    const candList = structuralByY.get(candY);
    if (!prevXZ || !candList || candList.length === 0) return false;
    for (const v of candList) {
      if (!prevXZ.has(`${v.x},${v.z}`)) return false;
    }
    return true;
  };

  const preferBroaderLowerSlab = (
    candidate: (typeof yFloorStats)[number],
    minYAllowed = -Infinity
  ) => {
    const prev = yFloorStats.find(
      (s) =>
        s.y === candidate.y - 1 &&
        s.y >= minYAllowed &&
        !isTerrainFloorFirstStory(s) &&
        ((s.enclosedCovered >= 1 && s.total > candidate.total) ||
          (candidate.coveredByAir > 0 &&
            candidate.nonFurnitureCovered * 2 < candidate.coveredByAir &&
            s.total >= candidate.total &&
            prevCoversCandidate(s.y, candidate.y)))
    );
    return prev ?? candidate;
  };

  const floorSlabYs: number[] = [];
  if (hasQualifyingFloor) {
    const rawPrimary = wallSupportingFloors.find((s) =>
      qualifiesAsFloor(s, useBracketed)
    );
    if (rawPrimary) {
      const primary = preferBroaderLowerSlab(rawPrimary);
      floorSlabYs.push(primary.y);
      for (const stat of wallSupportingFloors) {
        if (stat.y < floorSlabYs[floorSlabYs.length - 1] + 3) continue;
        if (qualifiesAsFloor(stat, useBracketed)) {
          const chosen = preferBroaderLowerSlab(
            stat,
            floorSlabYs[floorSlabYs.length - 1] + 3
          );
          floorSlabYs.push(chosen.y);
        }
      }
    }
  } else if (wallSupportingFloors.some((s) => s.bracketedCovered >= 1)) {
    // Handles small furnished rooms (e.g., 4x4 tower on sloped terrain where enclosedCovered is 1)
    const rawPrimary = wallSupportingFloors.find(
      (s) => s.bracketedCovered >= 1
    );
    if (rawPrimary) {
      const primary = preferBroaderLowerSlab(rawPrimary);
      floorSlabYs.push(primary.y);
      for (const stat of wallSupportingFloors) {
        if (stat.y < floorSlabYs[floorSlabYs.length - 1] + 3) continue;
        if (stat.bracketedCovered >= 2) {
          const chosen = preferBroaderLowerSlab(
            stat,
            floorSlabYs[floorSlabYs.length - 1] + 3
          );
          floorSlabYs.push(chosen.y);
        }
      }
    }
  } else {
    // Only fall back to nextYCount === 0 for ground-level open platforms (s.y === minBY),
    // never for flat roofs sitting above walls.
    const platform = yFloorStats.find(
      (s) =>
        s.y === minBY &&
        !isTerrainFloorFirstStory(s) &&
        s.coveredByAir >= 4 &&
        s.total >= 9
    );
    if (platform) {
      floorSlabYs.push(platform.y);
    }
  }

  const floorSlabSet = new Set(floorSlabYs);
  let lowestFloorY = floorSlabYs.length > 0 ? floorSlabYs[0] : -Infinity;

  interface StoryRange {
    floorY: number;
    minY: number;
    maxY: number;
    topY: number;
  }

  const stories: StoryRange[] = [];
  if (floorSlabYs.length > 0) {
    // If a terrain-floor 1st story exists beneath the lowest built floor slab (hollow air below
    // floorSlabYs[0], rather than a solid foundation), prepend the terrain-floor 1st story so
    // 1F camera-facing walls peel alongside upper stories.
    if (Number.isFinite(minBY) && floorSlabYs[0] - minBY >= 3) {
      const y1 = floorSlabYs[0] - 1;
      const y2 = floorSlabYs[0] - 2;
      const y1Ex = layerExtremaByY.get(y1);
      const y2Ex = layerExtremaByY.get(y2);
      const firstSlabList = structuralByY.get(floorSlabYs[0]) ?? [];
      const hasHollowRoomBelow =
        (y1Ex?.xzSet.size ?? 0) >= 4 &&
        (y2Ex?.xzSet.size ?? 0) >= 4 &&
        firstSlabList.some((v) => {
          if (
            allOccupiedCoords.has(`${v.x},${y1},${v.z}`) ||
            allOccupiedCoords.has(`${v.x},${y2},${v.z}`)
          ) {
            return false;
          }
          if (!isEnclosedInLayer(v.x, v.z, y1)) {
            return false;
          }
          let hitsY2 = 0;
          if ((y2Ex!.minXByZ.get(v.z) ?? Infinity) < v.x) hitsY2++;
          if ((y2Ex!.maxXByZ.get(v.z) ?? -Infinity) > v.x) hitsY2++;
          if ((y2Ex!.minZByX.get(v.x) ?? Infinity) < v.z) hitsY2++;
          if ((y2Ex!.maxZByX.get(v.x) ?? -Infinity) > v.z) hitsY2++;
          return hitsY2 >= 3;
        });
      if (hasHollowRoomBelow) {
        const max1FY = Math.min(cutY, floorSlabYs[0] - 1);
        if (minBY <= max1FY) {
          stories.push({
            floorY: minBY - 1,
            minY: minBY,
            maxY: max1FY,
            topY: floorSlabYs[0] - 1,
          });
          lowestFloorY = minBY;
        }
      }
    }
    for (let i = 0; i < floorSlabYs.length; i++) {
      const floorY = floorSlabYs[i];
      const minY = floorY + 1;
      const maxY =
        i + 1 < floorSlabYs.length
          ? Math.min(cutY, floorSlabYs[i + 1] - 1)
          : cutY;
      const topY =
        i + 1 < floorSlabYs.length ? floorSlabYs[i + 1] - 1 : Infinity;
      if (minY <= maxY) {
        stories.push({ floorY, minY, maxY, topY });
      }
    }
  } else if (Number.isFinite(minBY) && minBY <= cutY) {
    stories.push({ floorY: minBY - 1, minY: minBY, maxY: cutY, topY: Infinity });
  }

  // 2. For each story, identify structural wall columns and compute per-Z / per-X outermost columns to peel.
  interface ColInfo {
    x: number;
    z: number;
    belowCutCount: number;
    fullCount: number;
    hasBase1: boolean;
    hasBase2: boolean;
  }

  interface StoryPeelInfo {
    minY: number;
    maxY: number;
    peelCoords: Set<string>;
  }

  const storyPeels: StoryPeelInfo[] = [];

  if (view) {
    for (const story of stories) {
      const colMap = new Map<string, ColInfo>();
      for (const v of voxels) {
        if (
          !v.isTerrain &&
          !isCutawayExteriorProp(v.name) &&
          v.y >= story.minY &&
          v.y <= story.topY
        ) {
          const key = `${v.x},${v.z}`;
          let cur = colMap.get(key);
          if (!cur) {
            cur = {
              x: v.x,
              z: v.z,
              belowCutCount: 0,
              fullCount: 0,
              hasBase1: false,
              hasBase2: false,
            };
            colMap.set(key, cur);
          }
          cur.fullCount++;
          if (v.y <= story.maxY) {
            cur.belowCutCount++;
          }
          if (v.y === story.minY) {
            cur.hasBase1 = true;
          } else if (v.y === story.minY + 1) {
            cur.hasBase2 = true;
          }
        }
      }

      const allCols = Array.from(colMap.values()).filter(
        (c) => c.belowCutCount > 0
      );
      const baseTwoCols = allCols.filter((c) => c.hasBase1 && c.hasBase2);
      const baseTallCols = allCols.filter(
        (c) => c.hasBase1 && c.fullCount >= 2
      );
      const fullTallCols = allCols.filter((c) => c.fullCount >= 2);

      // Require >= 4 tall structural wall columns (never peel isolated furniture on open platforms)
      if (fullTallCols.length < 4) {
        continue;
      }

      const rawCandidates =
        baseTwoCols.length >= 4
          ? baseTwoCols
          : baseTallCols.length >= 4
            ? baseTallCols
            : fullTallCols;

      let cMinX = Infinity;
      let cMaxX = -Infinity;
      let cMinZ = Infinity;
      let cMaxZ = -Infinity;
      for (const c of rawCandidates) {
        if (c.x < cMinX) cMinX = c.x;
        if (c.x > cMaxX) cMaxX = c.x;
        if (c.z < cMinZ) cMinZ = c.z;
        if (c.z > cMaxZ) cMaxZ = c.z;
      }
      if (cMaxX - cMinX < 2 || cMaxZ - cMinZ < 2) {
        continue;
      }

      // Filter out isolated porch pillars (4-connected components of < 3 columns)
      const candMap = new Map<string, ColInfo>();
      for (const c of rawCandidates) {
        candMap.set(`${c.x},${c.z}`, c);
      }
      const visited = new Set<string>();
      const wallCols: ColInfo[] = [];

      for (const [startKey, startCol] of candMap.entries()) {
        if (visited.has(startKey)) continue;
        visited.add(startKey);
        const comp: ColInfo[] = [startCol];
        let head = 0;
        while (head < comp.length) {
          const cur = comp[head++];
          for (const [dx, dz] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ]) {
            const nKey = `${cur.x + dx},${cur.z + dz}`;
            if (visited.has(nKey)) continue;
            const nCol = candMap.get(nKey);
            if (nCol) {
              visited.add(nKey);
              comp.push(nCol);
            }
          }
        }
        if (comp.length >= 3) {
          for (const c of comp) {
            wallCols.push(c);
          }
        }
      }

      if (wallCols.length < 4) {
        continue;
      }

      const minXByZ = new Map<number, number>();
      const maxXByZ = new Map<number, number>();
      const minZByX = new Map<number, number>();
      const maxZByX = new Map<number, number>();

      for (const c of wallCols) {
        const curMinX = minXByZ.get(c.z);
        if (curMinX === undefined || c.x < curMinX) minXByZ.set(c.z, c.x);
        const curMaxX = maxXByZ.get(c.z);
        if (curMaxX === undefined || c.x > curMaxX) maxXByZ.set(c.z, c.x);
        const curMinZ = minZByX.get(c.x);
        if (curMinZ === undefined || c.z < curMinZ) minZByX.set(c.x, c.z);
        const curMaxZ = maxZByX.get(c.x);
        if (curMaxZ === undefined || c.z > curMaxZ) maxZByX.set(c.x, c.z);
      }

      const wallColSet = new Set<string>();
      for (const c of wallCols) {
        wallColSet.add(`${c.x},${c.z}`);
      }

      // Helper: avoid punching a hole in the back wall when the front wall has an open doorway/window
      // or a full-height open archway/gap without an overhead lintel.
      const hasFrontLintelInDirection = (
        x: number,
        z: number,
        dx: number,
        dz: number
      ): boolean => {
        const hasBuiltFloor = floorSlabSet.has(story.floorY);
        if (
          hasBuiltFloor &&
          !nonTerrainCoords.has(`${x + dx},${story.floorY},${z + dz}`)
        ) {
          return false;
        }
        const px = dz !== 0 ? 1 : 0;
        const pz = dx !== 0 ? 1 : 0;
        const maxScan = 32;
        const isSingleWallOnAxis =
          dx !== 0
            ? minXByZ.get(z) === maxXByZ.get(z)
            : minZByX.get(x) === maxZByX.get(x);
        const maxCheckY = Math.min(
          story.minY + (isSingleWallOnAxis ? 5 : 3),
          story.topY
        );
        const isJambCol = (jx: number, jz: number): boolean => {
          if (wallColSet.has(`${jx},${jz}`)) return true;
          if (!candMap.has(`${jx},${jz}`)) return false;
          for (const dir of [-1, 1]) {
            for (let d = 1; d <= 4; d++) {
              const nx = jx + px * dir * d;
              const nz = jz + pz * dir * d;
              if (wallColSet.has(`${nx},${nz}`)) return true;
              let hasLintel = false;
              for (let y = story.minY + 1; y <= maxCheckY; y++) {
                if (allStructuralCoords.has(`${nx},${y},${nz}`)) {
                  hasLintel = true;
                  break;
                }
              }
              if (!hasLintel) break;
            }
          }
          return false;
        };
        for (let step = 2; step <= maxScan; step++) {
          const tx = x + dx * step;
          const tz = z + dz * step;
          if (isJambCol(tx, tz)) {
            continue;
          }
          let kNeg = 0;
          for (let k = 1; k <= 5; k++) {
            if (isJambCol(tx - px * k, tz - pz * k)) {
              kNeg = k;
              break;
            }
          }
          let kPos = 0;
          for (let k = 1; k <= 5; k++) {
            if (isJambCol(tx + px * k, tz + pz * k)) {
              kPos = k;
              break;
            }
          }
          if (kNeg > 0 && kPos > 0) {
            const openingWidth = kNeg + kPos - 1;
            if (openingWidth <= 5) {
              for (let y = story.minY + 1; y <= maxCheckY; y++) {
                if (allStructuralCoords.has(`${tx},${y},${tz}`)) {
                  return true;
                }
              }
            }
            // Full-height open front gap without lintel: check for flanking front-wall jambs
            // perpendicular to the ray at this step, with floor/ground inside the threshold.
            if (
              openingWidth <= 3 &&
              (!hasBuiltFloor ||
                nonTerrainCoords.has(`${tx},${story.floorY},${tz}`) ||
                nonTerrainCoords.has(`${tx - dx},${story.floorY},${tz - dz}`))
            ) {
              const negBehindIsWall = wallColSet.has(
                `${tx - px * kNeg - dx},${tz - pz * kNeg - dz}`
              );
              const posBehindIsWall = wallColSet.has(
                `${tx + px * kPos - dx},${tz + pz * kPos - dz}`
              );
              if (!negBehindIsWall || !posBehindIsWall) {
                return true;
              }
            }
          }
        }
        return false;
      };

      const peelCoords = new Set<string>();
      for (const c of wallCols) {
        let shouldPeel = false;
        const isEastEdge =
          c.x === maxXByZ.get(c.z) && !hasFrontLintelInDirection(c.x, c.z, 1, 0);
        const isWestEdge =
          c.x === minXByZ.get(c.z) &&
          !hasFrontLintelInDirection(c.x, c.z, -1, 0);
        const isNorthEdge =
          c.z === minZByX.get(c.x) &&
          !hasFrontLintelInDirection(c.x, c.z, 0, -1);
        const isSouthEdge =
          c.z === maxZByX.get(c.x) && !hasFrontLintelInDirection(c.x, c.z, 0, 1);

        switch (view) {
          case "NE":
            shouldPeel = isEastEdge || isNorthEdge;
            break;
          case "SE":
            shouldPeel = isEastEdge || isSouthEdge;
            break;
          case "SW":
            shouldPeel = isWestEdge || isSouthEdge;
            break;
          case "NW":
            shouldPeel = isWestEdge || isNorthEdge;
            break;
        }

        if (shouldPeel) {
          peelCoords.add(`${c.x},${c.z}`);
        }
      }

      if (peelCoords.size > 0) {
        storyPeels.push({ minY: story.minY, maxY: story.maxY, peelCoords });
      }
    }
  }

  return voxels.filter((v) => {
    if (v.y > cutY) {
      return false;
    }

    if (v.isTerrain || floorSlabSet.has(v.y) || v.y < lowestFloorY) {
      return true;
    }

    const colKey = `${v.x},${v.z}`;
    for (const sp of storyPeels) {
      if (v.y >= sp.minY && v.y <= sp.maxY && sp.peelCoords.has(colKey)) {
        return false;
      }
    }

    return true;
  });
}

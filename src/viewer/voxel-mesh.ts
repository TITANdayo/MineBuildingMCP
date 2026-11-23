import * as THREE from "three";
import { coordKey, toShortBlockId } from "../core/block-name.js";
import {
  ALL_DIRS,
  DIR_VECTORS,
  evaluateMultipartCondition,
  getBlockDef,
  hasTag,
  isInstanceFullOpaqueCube,
  resolveActiveModelParts,
  resolveWorldBlockStates,
} from "../core/block-state-resolver.js";
import type {
  CompiledBlockDefinition,
  McFaceDirection,
  ResolvedModelElement,
  ResolvedModelElementRotation,
  VoxelData,
} from "../types/shared.js";
import { filterVoxelsForCutaway } from "./cutaway-filter.js";

export {
  evaluateMultipartCondition,
  filterVoxelsForCutaway,
  resolveActiveModelParts,
};

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

const MAX_TEXTURE_CACHE_ENTRIES = 512;
const textureAssetCache = new Map<string, LoadedTextureAsset>();
const textureLoader = new THREE.TextureLoader();

function setTextureCacheEntry(key: string, asset: LoadedTextureAsset): void {
  if (textureAssetCache.has(key)) {
    textureAssetCache.delete(key);
  } else if (textureAssetCache.size >= MAX_TEXTURE_CACHE_ENTRIES) {
    const oldestKey = textureAssetCache.keys().next().value;
    if (oldestKey !== undefined) {
      const oldest = textureAssetCache.get(oldestKey);
      oldest?.texture.dispose();
      textureAssetCache.delete(oldestKey);
    }
  }
  textureAssetCache.set(key, asset);
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
  const shortName = toShortBlockId(keyName.replace(/#tinted$/, ""));
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
  const shortKey = toShortBlockId(textureKey);
  const shortFallback = fallbackBlockName ? toShortBlockId(fallbackBlockName) : shortKey;

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
  if (existing) {
    // Refresh LRU recency
    textureAssetCache.delete(cacheKey);
    textureAssetCache.set(cacheKey, existing);
    return existing;
  }

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
      setTextureCacheEntry(cacheKey, asset);
      return asset;
    } catch {
      // Fallback to procedural texture
    }
  }

  const proc = createProceduralFallbackAsset(shortKey || shortFallback);
  setTextureCacheEntry(cacheKey, proc);
  return proc;
}

export function getUnrotatedFaceCorners(
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

export function getDefaultFaceUv(
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

export function applyElementRotation(
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

export function applyBlockstateRotation(
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

export function computeBoxLockedUv(
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

function shouldCullFace(
  cullDir: McFaceDirection | undefined,
  voxel: VoxelData,
  def: CompiledBlockDefinition,
  voxelMap: Map<string, VoxelData>,
  blockModels?: Record<string, CompiledBlockDefinition>
): boolean {
  if (!cullDir) return false;
  const [dx, dy, dz] = DIR_VECTORS[cullDir];
  const neighbor = voxelMap.get(coordKey(voxel.x + dx, voxel.y + dy, voxel.z + dz));
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

  if (
    nDef.blockName === def.blockName &&
    (nDef.isTranslucent || hasTag(nDef, "impermeable"))
  ) {
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
 * Encodes a voxel's opId into the picker alpha byte [1..255] so alpha === 0 is
 * exclusively reserved for sky/background across the full 0..255 coordinate space:
 * - Terrain (opId === 0) -> 255
 * - Build (opId >= 1)    -> ((opId - 1) % 254) + 1 (range 1..254)
 */
export function encodePickerAlphaByte(opId: number | undefined): number {
  const id = opId ?? 0;
  if (id <= 0) return 255;
  return ((id - 1) % 254) + 1;
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
    voxelMap.set(coordKey(v.x, v.y, v.z), v);
  }

  const resolvedStates = blockModels
    ? resolveWorldBlockStates(voxels, blockModels)
    : undefined;

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
    const activeParts = resolveActiveModelParts(
      voxel,
      def,
      voxelMap,
      blockModels,
      resolvedStates
    );

    const rByte = Math.max(0, Math.min(255, voxel.x));
    const gByte = Math.max(0, Math.min(255, voxel.y));
    const bByte = Math.max(0, Math.min(255, voxel.z));
    const aByte = encodePickerAlphaByte(voxel.opId);

    for (const partRef of activeParts) {
      const elements = def.models[partRef.model];
      if (!elements || elements.length === 0) continue;

      const stepsX = ((Math.round((partRef.x ?? 0) / 90) % 4) + 4) % 4;
      const stepsY = ((Math.round((partRef.y ?? 0) / 90) % 4) + 4) % 4;
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
          const rotSteps = ((Math.round((faceDef.rotation ?? 0) / 90) % 4) + 4) % 4;

          let rotNormal = normal;
          if (el.rotation) {
            rotNormal = applyElementRotation(rotNormal, el.rotation, true);
          }
          rotNormal = applyBlockstateRotation(rotNormal, stepsX, stepsY, false);
          const rotFaceDir = vectorToFaceDirection(rotNormal);
          const shade = el.shade === false ? 1.0 : computeShadeFactor(rotNormal);

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

  // Resolve all required textures concurrently instead of sequentially
  const nonEmptyBuckets = Array.from(textureBuckets.entries()).filter(
    ([, bucket]) => bucket.positions.length > 0 && bucket.indices.length > 0
  );
  const resolvedAssets = await Promise.all(
    nonEmptyBuckets.map(([textureKey]) =>
      resolveTextureAsset(
        textureKey,
        textures,
        textureFallbackBlock.get(textureKey)
      )
    )
  );

  for (let i = 0; i < nonEmptyBuckets.length; i++) {
    const [, bucket] = nonEmptyBuckets[i];
    const asset = resolvedAssets[i];

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

import * as THREE from "three";
import type { BlockState, VoxelData } from "../types/shared.js";

export interface BoxPart {
  cx: number;
  cy: number;
  cz: number;
  sx: number;
  sy: number;
  sz: number;
}

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

const textureCache = new Map<string, THREE.Texture>();
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

function getBaseBlockPalette(shortName: string): { base: [number, number, number]; accent: [number, number, number] } {
  if (shortName.includes("grass")) return { base: [95, 159, 53], accent: [76, 133, 41] };
  if (shortName.includes("dirt") || shortName.includes("podzol") || shortName.includes("farmland")) {
    return { base: [134, 96, 67], accent: [112, 79, 54] };
  }
  if (shortName.includes("stone_brick")) return { base: [122, 125, 128], accent: [98, 101, 104] };
  if (shortName.includes("cobble")) return { base: [115, 115, 115], accent: [88, 88, 88] };
  if (shortName.includes("deepslate")) return { base: [72, 74, 79], accent: [54, 56, 61] };
  if (shortName.includes("andesite") || shortName.includes("stone") || shortName.includes("gravel")) {
    return { base: [130, 132, 135], accent: [110, 112, 115] };
  }
  if (shortName.includes("spruce")) return { base: [114, 84, 48], accent: [92, 67, 37] };
  if (shortName.includes("dark_oak")) return { base: [66, 43, 20], accent: [51, 33, 15] };
  if (shortName.includes("birch")) return { base: [196, 179, 123], accent: [175, 158, 105] };
  if (shortName.includes("oak_log") || shortName.includes("log") || shortName.includes("wood")) {
    return { base: [109, 85, 50], accent: [84, 65, 38] };
  }
  if (shortName.includes("oak") || shortName.includes("plank") || shortName.includes("slab") || shortName.includes("stair")) {
    return { base: [162, 130, 78], accent: [139, 110, 63] };
  }
  if (shortName.includes("brick")) return { base: [150, 74, 60], accent: [122, 56, 45] };
  if (shortName.includes("sand")) return { base: [219, 207, 163], accent: [199, 186, 141] };
  if (shortName.includes("water")) return { base: [45, 118, 224], accent: [36, 98, 196] };
  if (shortName.includes("glass")) return { base: [185, 226, 245], accent: [140, 198, 225] };
  if (shortName.includes("leaf") || shortName.includes("leaves")) {
    return { base: [62, 128, 47], accent: [46, 102, 34] };
  }
  if (shortName.includes("lantern") || shortName.includes("glow") || shortName.includes("torch")) {
    return { base: [248, 202, 88], accent: [219, 148, 42] };
  }
  if (shortName.includes("quartz") || shortName.includes("white") || shortName.includes("snow") || shortName.includes("calcite")) {
    return { base: [232, 229, 222], accent: [208, 204, 196] };
  }
  if (shortName.includes("roof") || shortName.includes("terracotta") || shortName.includes("copper")) {
    return { base: [158, 86, 67], accent: [132, 69, 52] };
  }

  const h = hashString(shortName);
  const r = 90 + (h & 0x7f);
  const g = 90 + ((h >> 8) & 0x7f);
  const b = 90 + ((h >> 16) & 0x7f);
  return {
    base: [r, g, b],
    accent: [Math.max(0, r - 24), Math.max(0, g - 24), Math.max(0, b - 24)]
  };
}

function createProceduralBlockTexture(blockName: string): THREE.CanvasTexture {
  const shortName = normalizeBlockName(blockName);
  const { base, accent } = getBaseBlockPalette(shortName);

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
      const isBrickMortar =
        shortName.includes("brick") &&
        (y % 4 === 0 || ((x + (Math.floor(y / 4) % 2) * 4) % 8 === 0));
      const isPlankSeam =
        (shortName.includes("plank") || shortName.includes("oak") || shortName.includes("spruce")) &&
        (y % 4 === 0 || (x === ((Math.floor(y / 4) * 5) % 15)));

      const n = (nextRand() - 0.5) * 18;
      const palette = isBorder || isBrickMortar || isPlankSeam ? accent : base;
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
  return texture;
}

async function resolveBlockTexture(
  blockName: string,
  textures?: Record<string, string>
): Promise<THREE.Texture> {
  const shortName = normalizeBlockName(blockName);
  const dataUrl = textures?.[blockName] ?? textures?.[shortName] ?? textures?.[`minecraft:${shortName}`];
  const cacheKey = dataUrl ? `${shortName}:${dataUrl.slice(0, 64)}` : `proc:${shortName}`;

  const existing = textureCache.get(cacheKey);
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
      textureCache.set(cacheKey, loaded);
      return loaded;
    } catch {
      // Fallback to procedural texture if dataUrl fails
    }
  }

  const proc = createProceduralBlockTexture(blockName);
  textureCache.set(cacheKey, proc);
  return proc;
}

/**
 * Computes the constituent 3D boxes for a voxel at (x, y, z) occupying [x, x+1] x [y, y+1] x [z, z+1].
 * Supports full cubes, slabs (bottom/top/double), and stairs (north/south/east/west, bottom/top).
 */
export function getVoxelBoxes(voxel: VoxelData): BoxPart[] {
  const { x, y, z } = voxel;
  const shortName = normalizeBlockName(voxel.name);
  const state: BlockState = voxel.state ?? {};

  // Stairs: bottom half-slab + top rear half-step (or inverted if half === "top")
  if (shortName.includes("stairs")) {
    const isTop = state.half === "top";
    const facing = state.facing ?? "north";

    const baseCy = isTop ? y + 0.75 : y + 0.25;
    const stepCy = isTop ? y + 0.25 : y + 0.75;

    const basePart: BoxPart = {
      cx: x + 0.5,
      cy: baseCy,
      cz: z + 0.5,
      sx: 1.0,
      sy: 0.5,
      sz: 1.0
    };

    let stepPart: BoxPart;
    switch (facing) {
      case "south":
        stepPart = { cx: x + 0.5, cy: stepCy, cz: z + 0.75, sx: 1.0, sy: 0.5, sz: 0.5 };
        break;
      case "east":
        stepPart = { cx: x + 0.75, cy: stepCy, cz: z + 0.5, sx: 0.5, sy: 0.5, sz: 1.0 };
        break;
      case "west":
        stepPart = { cx: x + 0.25, cy: stepCy, cz: z + 0.5, sx: 0.5, sy: 0.5, sz: 1.0 };
        break;
      case "north":
      default:
        stepPart = { cx: x + 0.5, cy: stepCy, cz: z + 0.25, sx: 1.0, sy: 0.5, sz: 0.5 };
        break;
    }

    return [basePart, stepPart];
  }

  // Slabs: half-height box (0.5 height), respects half/type === "top" | "bottom" | "double"
  if (shortName.includes("slab")) {
    const halfType = state.half ?? state.type ?? "bottom";
    if (halfType === "double") {
      return [{ cx: x + 0.5, cy: y + 0.5, cz: z + 0.5, sx: 1.0, sy: 1.0, sz: 1.0 }];
    }
    const isTop = halfType === "top";
    return [
      {
        cx: x + 0.5,
        cy: isTop ? y + 0.75 : y + 0.25,
        cz: z + 0.5,
        sx: 1.0,
        sy: 0.5,
        sz: 1.0
      }
    ];
  }

  // Default: full 1x1x1 cube occupying [x, x+1] x [y, y+1] x [z, z+1]
  return [{ cx: x + 0.5, cy: y + 0.5, cz: z + 0.5, sx: 1.0, sy: 1.0, sz: 1.0 }];
}

const unitBoxTemplate = new THREE.BoxGeometry(1, 1, 1);

function appendBoxToArrays(
  part: BoxPart,
  voxel: VoxelData,
  positions: number[],
  normals: number[],
  uvs: number[],
  colors: number[],
  indices: number[],
  pickBytes?: number[]
): void {
  const posAttr = unitBoxTemplate.attributes.position;
  const normAttr = unitBoxTemplate.attributes.normal;
  const uvAttr = unitBoxTemplate.attributes.uv;
  const indexAttr = unitBoxTemplate.index!;

  const baseVertex = positions.length / 3;

  const rByte = Math.max(0, Math.min(255, Math.round(voxel.x)));
  const gByte = Math.max(0, Math.min(255, Math.round(voxel.y)));
  const bByte = Math.max(0, Math.min(255, Math.round(voxel.z)));
  const aByte = Math.max(0, Math.min(255, Math.round(voxel.opId ?? 0)));

  for (let i = 0; i < posAttr.count; i++) {
    const vx = posAttr.getX(i) * part.sx + part.cx;
    const vy = posAttr.getY(i) * part.sy + part.cy;
    const vz = posAttr.getZ(i) * part.sz + part.cz;
    positions.push(vx, vy, vz);

    const nx = normAttr.getX(i);
    const ny = normAttr.getY(i);
    const nz = normAttr.getZ(i);
    normals.push(nx, ny, nz);

    const u = uvAttr.getX(i);
    const v = uvAttr.getY(i);
    uvs.push(u, v);

    // Baked directional face shading + subtle ambient occlusion so block shapes & depth pop clearly
    let shade = 1.0;
    if (ny > 0.5) {
      shade = 1.0;
    } else if (ny < -0.5) {
      shade = 0.58;
    } else if ( Math.abs(nz) > 0.5) {
      shade = nz > 0 ? 0.88 : 0.82;
    } else {
      shade = nx > 0 ? 0.76 : 0.72;
    }

    // Subtle vertex AO at lower corners of each box
    const localY = posAttr.getY(i);
    if (localY < 0 && Math.abs(ny) < 0.5) {
      shade *= 0.93;
    }

    colors.push(shade, shade, shade);

    if (pickBytes) {
      pickBytes.push(rByte, gByte, bByte, aByte);
    }
  }

  for (let i = 0; i < indexAttr.count; i++) {
    indices.push(baseVertex + indexAttr.getX(i));
  }
}

/**
 * Builds both the Visual Group (textured + shaded meshes + crisp dark edge lines)
 * and the Data Picking BufferGeometry (with exact normalized RGBA byte attribute `aPickColor`).
 */
export async function buildWorldMeshes(
  voxels: VoxelData[],
  worldSize: [number, number, number],
  textures?: Record<string, string>
): Promise<BuiltWorldMeshes> {
  const visualGroup = new THREE.Group();
  visualGroup.name = "VoxelVisualGroup";

  // Group voxels by block name for batched visual meshes
  const byBlock = new Map<string, VoxelData[]>();
  for (const v of voxels) {
    const list = byBlock.get(v.name);
    if (list) {
      list.push(v);
    } else {
      byBlock.set(v.name, [v]);
    }
  }

  // Arrays for unified Data Picking geometry
  const pickPositions: number[] = [];
  const pickNormals: number[] = [];
  const pickUvs: number[] = [];
  const pickColors: number[] = [];
  const pickIndices: number[] = [];
  const pickBytes: number[] = [];

  // Bounds calculation
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;

  const edgeGeometries: THREE.BufferGeometry[] = [];

  for (const [blockName, blockVoxels] of byBlock.entries()) {
    const texture = await resolveBlockTexture(blockName, textures);
    const shortName = normalizeBlockName(blockName);
    const isGlassOrWater = shortName.includes("glass") || shortName.includes("water");

    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];

    for (const voxel of blockVoxels) {
      if (voxel.x < minX) minX = voxel.x;
      if (voxel.y < minY) minY = voxel.y;
      if (voxel.z < minZ) minZ = voxel.z;
      if (voxel.x + 1 > maxX) maxX = voxel.x + 1;
      if (voxel.y + 1 > maxY) maxY = voxel.y + 1;
      if (voxel.z + 1 > maxZ) maxZ = voxel.z + 1;

      const parts = getVoxelBoxes(voxel);
      for (const part of parts) {
        appendBoxToArrays(part, voxel, positions, normals, uvs, colors, indices);
        appendBoxToArrays(
          part,
          voxel,
          pickPositions,
          pickNormals,
          pickUvs,
          pickColors,
          pickIndices,
          pickBytes
        );
      }
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geom.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
    geom.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geom.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geom.setIndex(indices);

    const mat = new THREE.MeshLambertMaterial({
      map: texture,
      vertexColors: true,
      transparent: isGlassOrWater,
      opacity: isGlassOrWater ? 0.78 : 1.0
    });

    const mesh = new THREE.Mesh(geom, mat);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    visualGroup.add(mesh);

    // Crisp dark edge lines so Vision LLMs and humans can clearly distinguish adjacent blocks
    const edges = new THREE.EdgesGeometry(geom, 25);
    edgeGeometries.push(edges);
  }

  if (edgeGeometries.length > 0) {
    const lineMat = new THREE.LineBasicMaterial({
      color: 0x0f172a,
      transparent: true,
      opacity: 0.36,
      depthWrite: false
    });
    for (const eg of edgeGeometries) {
      const lines = new THREE.LineSegments(eg, lineMat);
      lines.renderOrder = 1;
      visualGroup.add(lines);
    }
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
    bounds: { min, max, center, size }
  };
}

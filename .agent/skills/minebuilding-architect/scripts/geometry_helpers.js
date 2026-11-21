// ============================================================================
// MineBuildingMCP Generic Geometry, Hollow-Shell & Vanilla-Safe Helpers
// Pure VM-ready JS (no import/export): prepend directly to any run_build_script
// payload or pass via `--lib geometry_helpers.js` in dry_run_validator.mjs.
// ============================================================================

const MB_W = world.size[0];
const MB_H = world.size[1];
const MB_D = world.size[2];

// Configurable safe bounds (default leaves margin inside 256^3 and avoids 255 RGBA8 picker sentinel)
const MB_SAFE = {
  minX: 0,
  maxX: Math.min(MB_W - 1, 254),
  minY: 0,
  maxY: Math.min(MB_H - 1, 254),
  minZ: 0,
  maxZ: Math.min(MB_D - 1, 254),
  clippedCount: 0,
  protectTerrainSeeds: true,
};

let _mbBulkSeq = 1;

function configureSafeBox(minX, maxX, minY, maxY, minZ, maxZ, protectTerrainSeeds) {
  MB_SAFE.minX = Math.max(0, Math.floor(minX));
  MB_SAFE.maxX = Math.min(MB_W - 1, Math.floor(maxX));
  MB_SAFE.minY = Math.max(0, Math.floor(minY));
  MB_SAFE.maxY = Math.min(MB_H - 1, Math.floor(maxY));
  MB_SAFE.minZ = Math.max(0, Math.floor(minZ));
  MB_SAFE.maxZ = Math.min(MB_D - 1, Math.floor(maxZ));
  if (protectTerrainSeeds !== undefined) {
    MB_SAFE.protectTerrainSeeds = Boolean(protectTerrainSeeds);
  }
}

function getSafeClippedCount() {
  return MB_SAFE.clippedCount;
}

// Cycles opId across 1..250 so bulk world.setVoxel() calls never accumulate >~1k
// floating blocks under one opId (prevents V8 Math.min(...group) stack overflow).
function nextBulkOpId() {
  _mbBulkSeq = (_mbBulkSeq % 250) + 1;
  return _mbBulkSeq;
}

function inWorld(x, y, z) {
  return x >= 0 && x < MB_W && y >= 0 && y < MB_H && z >= 0 && z < MB_D;
}

function inSafeBox(x, y, z) {
  return (
    x >= MB_SAFE.minX && x <= MB_SAFE.maxX &&
    y >= MB_SAFE.minY && y <= MB_SAFE.maxY &&
    z >= MB_SAFE.minZ && z <= MB_SAFE.maxZ
  );
}

// ----------------------------------------------------------------------------
// 1. Math, Deterministic Coordinate Hash & Low-Frequency Smooth Noise
// ----------------------------------------------------------------------------
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

function h3(x, y, z) {
  let n =
    Math.imul(x | 0, 374761393) +
    Math.imul(y | 0, 668265263) +
    Math.imul(z | 0, 2147483647);
  n = (n ^ (n >>> 13)) >>> 0;
  n = Math.imul(n, 1274126177) >>> 0;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

function h2(x, z) {
  return h3(x, 19, z);
}

function valueNoise3D(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const uz = fz * fz * (3 - 2 * fz);
  const x00 = lerp(h3(ix, iy, iz), h3(ix + 1, iy, iz), ux);
  const x10 = lerp(h3(ix, iy + 1, iz), h3(ix + 1, iy + 1, iz), ux);
  const x01 = lerp(h3(ix, iy, iz + 1), h3(ix + 1, iy, iz + 1), ux);
  const x11 = lerp(h3(ix, iy + 1, iz + 1), h3(ix + 1, iy + 1, iz + 1), ux);
  return lerp(lerp(x00, x10, uy), lerp(x01, x11, uy), uz) * 2 - 1;
}

function fbm3D(x, y, z, octaves) {
  let sum = 0, amp = 0.55, freq = 1, norm = 0;
  const oct = octaves || 3;
  for (let i = 0; i < oct; i++) {
    sum += amp * valueNoise3D(x * freq, y * freq, z * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}

function pickFromGradient(t, stops) {
  const u = clamp(t, 0, 0.999999);
  return stops[Math.floor(u * stops.length)];
}

// ----------------------------------------------------------------------------
// 2. 3D Vectors, Orthonormal Oblique Basis & Outward-Normal Orientation
// ----------------------------------------------------------------------------
function vDot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function vCross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function vNorm(a) {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

function vAdd(a, b, s) {
  const k = s === undefined ? 1 : s;
  return [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
}

function vSub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function rotVecEuler(v, rx, ry, rz) {
  let [x, y, z] = v;
  let c = Math.cos(rx), s = Math.sin(rx);
  [y, z] = [y * c - z * s, y * s + z * c];
  c = Math.cos(ry); s = Math.sin(ry);
  [x, z] = [x * c + z * s, -x * s + z * c];
  c = Math.cos(rz); s = Math.sin(rz);
  [x, y] = [x * c - y * s, x * s + y * c];
  return [x, y, z];
}

function makeOrthonormalBasis(normalVec) {
  const N = vNorm(normalVec);
  const ref = Math.abs(N[1]) < 0.95 ? [0, 1, 0] : [1, 0, 0];
  const U = vNorm(vCross(ref, N));
  const V = vCross(N, U);
  return { U, V, N };
}

function localToWorld(origin, basis, u, v, n) {
  return [
    origin[0] + u * basis.U[0] + v * basis.V[0] + n * basis.N[0],
    origin[1] + u * basis.U[1] + v * basis.V[1] + n * basis.N[1],
    origin[2] + u * basis.U[2] + v * basis.V[2] + n * basis.N[2],
  ];
}

function worldToLocal(origin, basis, x, y, z) {
  const dx = x - origin[0], dy = y - origin[1], dz = z - origin[2];
  return [
    dx * basis.U[0] + dy * basis.U[1] + dz * basis.U[2],
    dx * basis.V[0] + dy * basis.V[1] + dz * basis.V[2],
    dx * basis.N[0] + dy * basis.N[1] + dz * basis.N[2],
  ];
}

function radialFacingOut(dx, dz) {
  if (Math.abs(dx) >= Math.abs(dz)) return dx >= 0 ? "east" : "west";
  return dz >= 0 ? "south" : "north";
}

function radialFacingIn(dx, dz) {
  if (Math.abs(dx) >= Math.abs(dz)) return dx >= 0 ? "west" : "east";
  return dz >= 0 ? "north" : "south";
}

// Left-to-right horizontal tangent vector when looking AT a vertical face whose
// outward normal points along `outwardNormal` (e.g. [0,0,1] for South-facing).
// In Minecraft's right-handed coords (+X East, +Y Up, +Z South), viewer looks
// along `-outwardNormal`, so viewer's right is `cross(up, outwardNormal)` -> wait:
// Let's verify: looking at South face (+Z normal) from South -> viewer looks -Z,
// viewer's RIGHT is +X! cross([0,1,0], [0,0,1]) = [1, 0, 0] = +X!
// Looking at North face (-Z normal) from North -> viewer looks +Z,
// viewer's RIGHT is -X! cross([0,1,0], [0,0,-1]) = [-1, 0, 0] = -X!
// Looking at East face (+X normal) from East -> viewer looks -X,
// viewer's RIGHT is -Z! cross([0,1,0], [1,0,0]) = [0, 0, -1] = -Z!
// Looking at West face (-X normal) from West -> viewer looks +X,
// viewer's RIGHT is +Z! cross([0,1,0], [-1,0,0]) = [0, 0, 1] = +Z!
function getOutwardRightVector(outwardNormal) {
  return vNorm(vCross([0, 1, 0], outwardNormal));
}

// ----------------------------------------------------------------------------
// 3. Dual-Tier Safe Placement (pSet = Traced DSL | fSet = Fast Bulk Voxel)
// ----------------------------------------------------------------------------
function pSet(x, y, z, block, state) {
  const ix = Math.round(x), iy = Math.round(y), iz = Math.round(z);
  if (!inSafeBox(ix, iy, iz)) {
    MB_SAFE.clippedCount++;
    return false;
  }
  if (MB_SAFE.protectTerrainSeeds) {
    const existing = world.getVoxel(ix, iy, iz);
    if (existing && existing.isTerrain) return true;
  }
  if (state && Object.keys(state).length > 0) setBlock(ix, iy, iz, block, state);
  else setBlock(ix, iy, iz, block);
  return true;
}

function pSetIfEmpty(x, y, z, block, state) {
  const ix = Math.round(x), iy = Math.round(y), iz = Math.round(z);
  if (!inSafeBox(ix, iy, iz)) {
    MB_SAFE.clippedCount++;
    return false;
  }
  if (world.getVoxel(ix, iy, iz)) return false;
  if (state && Object.keys(state).length > 0) setBlock(ix, iy, iz, block, state);
  else setBlock(ix, iy, iz, block);
  return true;
}

function fSet(x, y, z, block, state) {
  const ix = Math.round(x), iy = Math.round(y), iz = Math.round(z);
  if (!inSafeBox(ix, iy, iz)) {
    MB_SAFE.clippedCount++;
    return false;
  }
  if (MB_SAFE.protectTerrainSeeds) {
    const existing = world.getVoxel(ix, iy, iz);
    if (existing && existing.isTerrain) return true;
  }
  world.setVoxel(ix, iy, iz, block, state, false, nextBulkOpId());
  return true;
}

function fSetIfEmpty(x, y, z, block, state) {
  const ix = Math.round(x), iy = Math.round(y), iz = Math.round(z);
  if (!inSafeBox(ix, iy, iz)) {
    MB_SAFE.clippedCount++;
    return false;
  }
  if (world.getVoxel(ix, iy, iz)) return false;
  world.setVoxel(ix, iy, iz, block, state, false, nextBulkOpId());
  return true;
}

function fClear(x, y, z) {
  const ix = Math.round(x), iy = Math.round(y), iz = Math.round(z);
  if (!inSafeBox(ix, iy, iz)) return false;
  if (MB_SAFE.protectTerrainSeeds) {
    const existing = world.getVoxel(ix, iy, iz);
    if (existing && existing.isTerrain) return false;
  }
  world.setVoxel(ix, iy, iz, "minecraft:air", undefined, false, 1);
  return true;
}

// ----------------------------------------------------------------------------
// 4. Vanilla Building Linter Safety Guards (Zero-Warning Placement)
// ----------------------------------------------------------------------------
const FULL_OPAQUE_BLOCKS = new Set([
  "minecraft:stone", "minecraft:cobblestone", "minecraft:mossy_cobblestone",
  "minecraft:andesite", "minecraft:polished_andesite", "minecraft:diorite", "minecraft:polished_diorite",
  "minecraft:granite", "minecraft:polished_granite", "minecraft:stone_bricks",
  "minecraft:cracked_stone_bricks", "minecraft:mossy_stone_bricks", "minecraft:chiseled_stone_bricks",
  "minecraft:deepslate", "minecraft:cobbled_deepslate", "minecraft:deepslate_bricks",
  "minecraft:cracked_deepslate_bricks", "minecraft:deepslate_tiles", "minecraft:cracked_deepslate_tiles",
  "minecraft:polished_deepslate", "minecraft:chiseled_deepslate",
  "minecraft:tuff", "minecraft:tuff_bricks", "minecraft:polished_tuff", "minecraft:chiseled_tuff",
  "minecraft:blackstone", "minecraft:polished_blackstone", "minecraft:polished_blackstone_bricks",
  "minecraft:gilded_blackstone", "minecraft:basalt", "minecraft:polished_basalt", "minecraft:smooth_basalt",
  "minecraft:calcite", "minecraft:quartz_block", "minecraft:smooth_quartz", "minecraft:quartz_pillar",
  "minecraft:sandstone", "minecraft:smooth_sandstone", "minecraft:cut_sandstone",
  "minecraft:bricks", "minecraft:mud_bricks", "minecraft:nether_bricks", "minecraft:red_nether_bricks",
  "minecraft:gold_block", "minecraft:raw_gold_block", "minecraft:iron_block",
  "minecraft:copper_block", "minecraft:cut_copper", "minecraft:chiseled_copper",
  "minecraft:exposed_copper", "minecraft:exposed_cut_copper",
  "minecraft:weathered_copper", "minecraft:weathered_cut_copper",
  "minecraft:oxidized_copper", "minecraft:oxidized_cut_copper", "minecraft:oxidized_chiseled_copper",
  "minecraft:copper_bulb", "minecraft:exposed_copper_bulb", "minecraft:oxidized_copper_bulb",
  "minecraft:prismarine", "minecraft:prismarine_bricks", "minecraft:dark_prismarine",
  "minecraft:oak_planks", "minecraft:spruce_planks", "minecraft:dark_oak_planks", "minecraft:birch_planks",
  "minecraft:oak_log", "minecraft:spruce_log", "minecraft:dark_oak_log",
  "minecraft:stripped_oak_log", "minecraft:stripped_spruce_log", "minecraft:stripped_dark_oak_log",
  "minecraft:oak_wood", "minecraft:spruce_wood", "minecraft:dark_oak_wood",
  "minecraft:stripped_oak_wood", "minecraft:stripped_spruce_wood", "minecraft:stripped_dark_oak_wood",
  "minecraft:moss_block", "minecraft:grass_block", "minecraft:dirt", "minecraft:coarse_dirt", "minecraft:rooted_dirt",
  "minecraft:obsidian", "minecraft:crying_obsidian", "minecraft:coal_block", "minecraft:magma_block",
  "minecraft:sea_lantern", "minecraft:glowstone", "minecraft:shroomlight",
  "minecraft:ochre_froglight", "minecraft:pearlescent_froglight", "minecraft:verdant_froglight",
  "minecraft:bookshelf", "minecraft:chiseled_bookshelf", "minecraft:barrel",
  "minecraft:white_concrete", "minecraft:black_concrete", "minecraft:gray_concrete",
  "minecraft:light_gray_concrete", "minecraft:blue_concrete", "minecraft:cyan_concrete",
  "minecraft:orange_concrete", "minecraft:yellow_concrete", "minecraft:red_concrete",
  "minecraft:terracotta", "minecraft:white_terracotta", "minecraft:red_terracotta",
  "minecraft:cyan_terracotta", "minecraft:purple_terracotta", "minecraft:blue_ice", "minecraft:packed_ice",
]);

function isFullOpaqueAt(x, y, z) {
  const ix = Math.round(x), iy = Math.round(y), iz = Math.round(z);
  if (!inWorld(ix, iy, iz)) return false;
  const v = world.getVoxel(ix, iy, iz);
  return Boolean(v && FULL_OPAQUE_BLOCKS.has(v.name));
}

function isRigidSupportAt(x, y, z) {
  const ix = Math.round(x), iy = Math.round(y), iz = Math.round(z);
  if (!inWorld(ix, iy, iz)) return false;
  const v = world.getVoxel(ix, iy, iz);
  if (!v) return false;
  const n = v.name;
  return (
    n !== "minecraft:air" &&
    n !== "minecraft:water" &&
    n !== "minecraft:lava" &&
    n !== "minecraft:vine" &&
    n !== "minecraft:glow_lichen" &&
    n !== "minecraft:sculk_vein"
  );
}

function isSlenderChainName(name) {
  return (
    name === "minecraft:chain" ||
    name === "minecraft:iron_chain" ||
    name === "minecraft:copper_chain" ||
    name === "minecraft:exposed_copper_chain" ||
    name === "minecraft:weathered_copper_chain" ||
    name === "minecraft:oxidized_copper_chain"
  );
}

function hasCrossAxisChainNeighbor(x, y, z, axis) {
  const ix = Math.round(x), iy = Math.round(y), iz = Math.round(z);
  const dirs = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
  for (let i = 0; i < 6; i++) {
    const v = world.getVoxel(ix + dirs[i][0], iy + dirs[i][1], iz + dirs[i][2]);
    if (v && isSlenderChainName(v.name)) {
      const nAxis = (v.state && v.state.axis) || "y";
      if (nAxis !== axis) return true;
    }
  }
  return false;
}

// Defaults to minecraft:iron_chain (MC 1.21.9+/26.x canonical ID; legacy `chain` aliased by JarAssetLoader)
function placeChainSafe(x, y, z, axis, block) {
  const ix = Math.round(x), iy = Math.round(y), iz = Math.round(z);
  const ax = axis || "y";
  if (!inSafeBox(ix, iy, iz) || hasCrossAxisChainNeighbor(ix, iy, iz, ax)) return false;
  return pSet(ix, iy, iz, block || "minecraft:iron_chain", { axis: ax });
}

function placeLanternSafe(x, y, z, block, hanging) {
  const ix = Math.round(x), iy = Math.round(y), iz = Math.round(z);
  const blk = block || "minecraft:lantern";
  if (!inSafeBox(ix, iy, iz)) return false;
  if (hanging) {
    const above = world.getVoxel(ix, iy + 1, iz);
    if (!above || !isRigidSupportAt(ix, iy + 1, iz)) return false;
    if (isSlenderChainName(above.name) && (((above.state && above.state.axis) || "y") !== "y")) {
      return false;
    }
    return pSet(ix, iy, iz, blk, { hanging: "true" });
  }
  if (!isRigidSupportAt(ix, iy - 1, iz)) return false;
  return pSet(ix, iy, iz, blk, { hanging: "false" });
}

function hangLanternChain(x, yTopAnchor, z, chainLen, lanternBlock, chainBlock) {
  const ix = Math.round(x), iyTop = Math.round(yTopAnchor), iz = Math.round(z);
  const topV = world.getVoxel(ix, iyTop, iz);
  if (!topV || !isRigidSupportAt(ix, iyTop, iz)) return false;
  if (isSlenderChainName(topV.name) && (((topV.state && topV.state.axis) || "y") !== "y")) {
    return false;
  }
  const len = Math.max(0, Math.round(chainLen));
  const lanternY = iyTop - 1 - len;
  if (lanternY < MB_SAFE.minY) return false;
  for (let d = 1; d <= len; d++) {
    if (world.getVoxel(ix, iyTop - d, iz) || hasCrossAxisChainNeighbor(ix, iyTop - d, iz, "y")) {
      return false;
    }
  }
  if (world.getVoxel(ix, lanternY, iz)) return false;
  for (let d = 1; d <= len; d++) {
    pSet(ix, iyTop - d, iz, chainBlock || "minecraft:iron_chain", { axis: "y" });
  }
  pSet(ix, lanternY, iz, lanternBlock || "minecraft:lantern", { hanging: "true" });
  return true;
}

function placeButtonSafe(x, y, z, block, face, facing) {
  const ix = Math.round(x), iy = Math.round(y), iz = Math.round(z);
  if (!inSafeBox(ix, iy, iz) || world.getVoxel(ix, iy, iz)) return false;
  const f = face || "wall";
  const dir = facing || "north";
  if (f === "floor") {
    if (!isRigidSupportAt(ix, iy - 1, iz)) return false;
  } else if (f === "ceiling") {
    if (!isRigidSupportAt(ix, iy + 1, iz)) return false;
  } else {
    const dx = dir === "east" ? -1 : dir === "west" ? 1 : 0;
    const dz = dir === "south" ? -1 : dir === "north" ? 1 : 0;
    if (!isRigidSupportAt(ix + dx, iy, iz + dz)) return false;
  }
  return pSet(ix, iy, iz, block || "minecraft:polished_blackstone_button", { face: f, facing: dir });
}

function placeHangingVineSafe(x, yTop, z, dropLen) {
  const ix = Math.round(x), iyTop = Math.round(yTop), iz = Math.round(z);
  if (!inSafeBox(ix, iyTop, iz) || world.getVoxel(ix, iyTop, iz)) return 0;
  const hasHorizOpaque =
    isFullOpaqueAt(ix + 1, iyTop, iz) ||
    isFullOpaqueAt(ix - 1, iyTop, iz) ||
    isFullOpaqueAt(ix, iyTop, iz + 1) ||
    isFullOpaqueAt(ix, iyTop, iz - 1);
  if (!hasHorizOpaque) return 0;
  let placed = 0;
  for (let d = 0; d < dropLen; d++) {
    const cy = iyTop - d;
    if (cy < MB_SAFE.minY || world.getVoxel(ix, cy, iz)) break;
    pSet(ix, cy, iz, "minecraft:vine");
    placed++;
  }
  return placed;
}

function placeGlowLichenSafe(x, y, z) {
  const ix = Math.round(x), iy = Math.round(y), iz = Math.round(z);
  if (!inSafeBox(ix, iy, iz) || world.getVoxel(ix, iy, iz)) return false;
  const dirs = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
  for (let i = 0; i < 6; i++) {
    if (isFullOpaqueAt(ix + dirs[i][0], iy + dirs[i][1], iz + dirs[i][2])) {
      return pSet(ix, iy, iz, "minecraft:glow_lichen");
    }
  }
  return false;
}

// ----------------------------------------------------------------------------
// 5. Strict 6-Connected & Hollow-Shell Geometric Primitives
// ----------------------------------------------------------------------------
function drawStrut(x1, y1, z1, x2, y2, z2, blockOrFn, radius, opts) {
  const fast = Boolean(opts && opts.fast);
  const onlyIfEmpty = Boolean(opts && opts.onlyIfEmpty);
  const setter = fast
    ? (onlyIfEmpty ? fSetIfEmpty : fSet)
    : (onlyIfEmpty ? pSetIfEmpty : pSet);

  const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1, z2 - z1) * 2.0));
  const rad = radius || 0;
  const rCeil = Math.ceil(rad);
  const r2 = rad * rad + 0.25;

  const stamp = (x, y, z, t) => {
    if (rad <= 0) {
      const blk = typeof blockOrFn === "function" ? blockOrFn(x, y, z, t) : blockOrFn;
      if (blk) setter(x, y, z, blk);
    } else {
      for (let dx = -rCeil; dx <= rCeil; dx++) {
        for (let dy = -rCeil; dy <= rCeil; dy++) {
          for (let dz = -rCeil; dz <= rCeil; dz++) {
            if (dx * dx + dy * dy + dz * dz <= r2) {
              const bx = x + dx, by = y + dy, bz = z + dz;
              const blk = typeof blockOrFn === "function" ? blockOrFn(bx, by, bz, t) : blockOrFn;
              if (blk) setter(bx, by, bz, blk);
            }
          }
        }
      }
    }
  };

  let prevX = Math.round(x1), prevY = Math.round(y1), prevZ = Math.round(z1);
  stamp(prevX, prevY, prevZ, 0);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = Math.round(lerp(x1, x2, t));
    const y = Math.round(lerp(y1, y2, t));
    const z = Math.round(lerp(z1, z2, t));
    // Guarantee strict 6-connectivity along diagonal/3D steps
    while (prevX !== x || prevY !== y || prevZ !== z) {
      if (prevX !== x) prevX += x > prevX ? 1 : -1;
      else if (prevZ !== z) prevZ += z > prevZ ? 1 : -1;
      else if (prevY !== y) prevY += y > prevY ? 1 : -1;
      stamp(prevX, prevY, prevZ, t);
    }
  }
}

function drawCatenary(x1, y1, z1, x2, y2, z2, sag, blockOrFn, opts) {
  const fast = Boolean(opts && opts.fast);
  const skipEnds = Boolean(opts && opts.skipEnds);
  const setter = fast ? fSet : pSet;
  const dist = Math.hypot(x2 - x1, y2 - y1, z2 - z1);
  const steps = Math.max(2, Math.ceil(dist * 2.0));
  let prevX = Math.round(x1), prevY = Math.round(y1), prevZ = Math.round(z1);

  const emit = (x, y, z, t, isEnd) => {
    if (skipEnds && isEnd) return;
    const blk = typeof blockOrFn === "function" ? blockOrFn(x, y, z, t) : blockOrFn;
    if (blk) setter(x, y, z, blk);
  };

  emit(prevX, prevY, prevZ, 0, true);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = Math.round(lerp(x1, x2, t));
    const y = Math.round(lerp(y1, y2, t) - sag * 4 * t * (1 - t));
    const z = Math.round(lerp(z1, z2, t));
    const isEnd = i === steps;
    while (prevX !== x || prevY !== y || prevZ !== z) {
      if (prevX !== x) prevX += x > prevX ? 1 : -1;
      else if (prevZ !== z) prevZ += z > prevZ ? 1 : -1;
      else if (prevY !== y) prevY += y > prevY ? 1 : -1;
      emit(prevX, prevY, prevZ, t, isEnd && prevX === x && prevY === y && prevZ === z);
    }
  }
}

function drawHollowSphere(cx, cy, cz, rOuter, shellThickness, blockFn, skipFn) {
  const rOut = rOuter;
  const rIn = Math.max(0, rOuter - shellThickness);
  const rOut2 = rOut * rOut;
  const rIn2 = rIn * rIn;
  const lim = Math.ceil(rOut);
  for (let dx = -lim; dx <= lim; dx++) {
    const dx2 = dx * dx;
    for (let dy = -lim; dy <= lim; dy++) {
      const dxy2 = dx2 + dy * dy;
      if (dxy2 > rOut2) continue;
      for (let dz = -lim; dz <= lim; dz++) {
        const d2 = dxy2 + dz * dz;
        if (d2 > rOut2 || d2 < rIn2) continue;
        const bx = cx + dx, by = cy + dy, bz = cz + dz, dist = Math.sqrt(d2);
        if (skipFn && skipFn(bx, by, bz, dx, dy, dz, dist)) continue;
        const blk = blockFn(bx, by, bz, dx, dy, dz, dist);
        if (blk) fSet(bx, by, bz, blk);
      }
    }
  }
}

function isHollowRimVoxel(r, rIn, rOut, y, yMin, yMax, theta, ribStep) {
  if (r < rIn || r > rOut || y < yMin || y > yMax) return false;
  if (y === yMin || y === yMax) return true;
  if (r <= rIn + 0.85 || r >= rOut - 0.85) return true;
  if (ribStep > 0) {
    const mod = ((theta % ribStep) + ribStep) % ribStep;
    const arcDist = Math.min(mod, ribStep - mod) * r;
    if (arcDist <= 0.6) return true;
  }
  return false;
}

/**
 * Airtight 6-connected hollow-shell volume builder:
 * 1) Evaluates `insideFn(wx, wy, wz)` inside `bounds = { minX, maxX, minY, maxY, minZ, maxZ }`
 * 2) Runs 6-neighbor BFS from cells matching `seedAnchorFn(wx, wy, wz)` (or largest component if null)
 *    to strip detached noise pebbles cleanly
 * 3) Emits ONLY voxels exposed to air within a 26-neighborhood (Chebyshev radius `shellRadius`, default 1)
 *    which mathematically guarantees a 100% airtight 6-connected hollow skin with zero diagonal flakes!
 */
function buildHollowVolumeShell(bounds, insideFn, seedAnchorFn, emitFn, opts) {
  const minX = Math.floor(bounds.minX), maxX = Math.floor(bounds.maxX);
  const minY = Math.floor(bounds.minY), maxY = Math.floor(bounds.maxY);
  const minZ = Math.floor(bounds.minZ), maxZ = Math.floor(bounds.maxZ);
  const shellRad = Math.max(1, Math.floor((opts && opts.shellRadius) || 1));
  const pad = shellRad;

  const spanX = maxX - minX + 1 + pad * 2;
  const spanY = maxY - minY + 1 + pad * 2;
  const spanZ = maxZ - minZ + 1 + pad * 2;
  const ox = minX - pad, oy = minY - pad, oz = minZ - pad;
  const grid = new Uint8Array(spanX * spanY * spanZ);
  const gIdx = (lx, ly, lz) => (lx * spanY + ly) * spanZ + lz;

  for (let lx = pad; lx < spanX - pad; lx++) {
    const wx = ox + lx;
    for (let ly = pad; ly < spanY - pad; ly++) {
      const wy = oy + ly;
      for (let lz = pad; lz < spanZ - pad; lz++) {
        const wz = oz + lz;
        if (insideFn(wx, wy, wz)) {
          grid[gIdx(lx, ly, lz)] = 1;
        }
      }
    }
  }

  // 6-neighbor BFS pruning
  const connected = new Uint8Array(grid.length);
  const nDirs = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];

  const runBfsFromSeeds = (seeds) => {
    for (let qi = 0; qi < seeds.length; qi += 3) {
      const clx = seeds[qi], cly = seeds[qi + 1], clz = seeds[qi + 2];
      for (let d = 0; d < 6; d++) {
        const nlx = clx + nDirs[d][0], nly = cly + nDirs[d][1], nlz = clz + nDirs[d][2];
        if (nlx < pad || nlx >= spanX - pad || nly < pad || nly >= spanY - pad || nlz < pad || nlz >= spanZ - pad) {
          continue;
        }
        const nIdx = gIdx(nlx, nly, nlz);
        if (grid[nIdx] === 1 && connected[nIdx] === 0) {
          connected[nIdx] = 1;
          seeds.push(nlx, nly, nlz);
        }
      }
    }
  };

  if (typeof seedAnchorFn === "function") {
    const bfsQ = [];
    for (let lx = pad; lx < spanX - pad; lx++) {
      for (let ly = pad; ly < spanY - pad; ly++) {
        for (let lz = pad; lz < spanZ - pad; lz++) {
          const i0 = gIdx(lx, ly, lz);
          if (grid[i0] === 1 && seedAnchorFn(ox + lx, oy + ly, oz + lz)) {
            connected[i0] = 1;
            bfsQ.push(lx, ly, lz);
          }
        }
      }
    }
    runBfsFromSeeds(bfsQ);
    for (let i = 0; i < grid.length; i++) grid[i] = connected[i];
  } else {
    // Keep single largest 6-connected component
    const vis = new Uint8Array(grid.length);
    let bestComp = null;
    for (let lx = pad; lx < spanX - pad; lx++) {
      for (let ly = pad; ly < spanY - pad; ly++) {
        for (let lz = pad; lz < spanZ - pad; lz++) {
          const i0 = gIdx(lx, ly, lz);
          if (grid[i0] !== 1 || vis[i0] === 1) continue;
          vis[i0] = 1;
          const comp = [lx, ly, lz];
          for (let qi = 0; qi < comp.length; qi += 3) {
            const clx = comp[qi], cly = comp[qi + 1], clz = comp[qi + 2];
            for (let d = 0; d < 6; d++) {
              const nlx = clx + nDirs[d][0], nly = cly + nDirs[d][1], nlz = clz + nDirs[d][2];
              if (nlx < pad || nlx >= spanX - pad || nly < pad || nly >= spanY - pad || nlz < pad || nlz >= spanZ - pad) {
                continue;
              }
              const nIdx = gIdx(nlx, nly, nlz);
              if (grid[nIdx] === 1 && vis[nIdx] === 0) {
                vis[nIdx] = 1;
                comp.push(nlx, nly, nlz);
              }
            }
          }
          if (!bestComp || comp.length > bestComp.length) bestComp = comp;
        }
      }
    }
    grid.fill(0);
    if (bestComp) {
      for (let i = 0; i < bestComp.length; i += 3) {
        grid[gIdx(bestComp[i], bestComp[i + 1], bestComp[i + 2])] = 1;
      }
    }
  }

  // 26-neighbor (Chebyshev radius `shellRad`) airtight surface extraction
  let emitted = 0;
  for (let lx = pad; lx < spanX - pad; lx++) {
    const wx = ox + lx;
    for (let ly = pad; ly < spanY - pad; ly++) {
      const wy = oy + ly;
      for (let lz = pad; lz < spanZ - pad; lz++) {
        if (grid[gIdx(lx, ly, lz)] === 0) continue;
        let exposed = false;
        for (let ex = -shellRad; ex <= shellRad && !exposed; ex++) {
          for (let ey = -shellRad; ey <= shellRad && !exposed; ey++) {
            for (let ez = -shellRad; ez <= shellRad; ez++) {
              if (grid[gIdx(lx + ex, ly + ey, lz + ez)] === 0) {
                exposed = true;
                break;
              }
            }
          }
        }
        if (!exposed) continue;
        const wz = oz + lz;
        emitFn(wx, wy, wz, {
          airAbove: grid[gIdx(lx, ly + 1, lz)] === 0,
          airBelow: grid[gIdx(lx, ly - 1, lz)] === 0,
        });
        emitted++;
      }
    }
  }
  return emitted;
}

/**
 * Stamps a 2D bitmap glyph array (`["X.X", ".X.", "X.X"]`, row 0 = top) onto a
 * vertical plane with exact left-to-right readability for viewers facing the
 * specified `outwardNormal` (prevents interior/exterior mirror inversion!).
 */
function stampGlyphPlane(centerOrigin, outwardNormal, glyphRows, blockFn, opts) {
  const scaleX = Math.max(1, Math.floor((opts && opts.scaleX) || 1));
  const scaleY = Math.max(1, Math.floor((opts && opts.scaleY) || 1));
  const clearEmpty = Boolean(opts && opts.clearEmpty);
  const right = getOutwardRightVector(outwardNormal);
  const rows = glyphRows.length;
  const cols = glyphRows[0] ? glyphRows[0].length : 0;
  const totalW = cols * scaleX;
  const totalH = rows * scaleY;
  const halfW = Math.floor(totalW / 2);
  const halfH = Math.floor(totalH / 2);

  for (let py = 0; py < totalH; py++) {
    const rowIdx = Math.floor(py / scaleY);
    const dy = halfH - py;
    for (let px = 0; px < totalW; px++) {
      const colIdx = Math.floor(px / scaleX);
      const du = px - halfW;
      const wx = Math.round(centerOrigin[0] + right[0] * du);
      const wy = Math.round(centerOrigin[1] + dy);
      const wz = Math.round(centerOrigin[2] + right[2] * du);
      const ch = glyphRows[rowIdx][colIdx];
      if (ch && ch !== "." && ch !== " ") {
        const blk = typeof blockFn === "function" ? blockFn(wx, wy, wz, ch, colIdx, rowIdx) : blockFn;
        if (blk) pSet(wx, wy, wz, blk);
      } else if (clearEmpty) {
        pSet(wx, wy, wz, "minecraft:air");
      }
    }
  }
}

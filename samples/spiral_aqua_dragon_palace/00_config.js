// ============================================================================
// 00_config.js — Shared Constants, SafeBox, Curves, Frames & Arch Helpers
// Project: Spiral Aqua-Dragon Palace (竜宮の螺旋浮島と水流龍)
// ============================================================================

configureSafeBox(2, 251, 2, 250, 2, 251, true);

// Extend FULL_OPAQUE_BLOCKS with blocks used in this build for vine/lichen safety
[
  "minecraft:mangrove_planks",
  "minecraft:stripped_mangrove_log",
  "minecraft:mangrove_log",
  "minecraft:mangrove_wood",
  "minecraft:stripped_mangrove_wood",
  "minecraft:prismarine_bricks",
  "minecraft:dark_prismarine",
  "minecraft:oxidized_cut_copper",
  "minecraft:weathered_cut_copper",
  "minecraft:red_nether_bricks",
  "minecraft:red_terracotta",
  "minecraft:cherry_log",
  "minecraft:cherry_wood",
  "minecraft:stripped_cherry_wood",
  "minecraft:dark_oak_wood",
  "minecraft:stripped_dark_oak_wood",
  "minecraft:stone_bricks",
  "minecraft:polished_deepslate",
  "minecraft:deepslate_bricks",
  "minecraft:deepslate_tiles",
  "minecraft:tuff_bricks",
  "minecraft:smooth_quartz",
  "minecraft:calcite",
  "minecraft:gold_block",
  "minecraft:sea_lantern",
  "minecraft:ochre_froglight",
  "minecraft:shroomlight",
  "minecraft:blue_ice",
  "minecraft:packed_ice",
  "minecraft:moss_block",
  "minecraft:quartz_pillar",
  "minecraft:white_terracotta",
].forEach((b) => FULL_OPAQUE_BLOCKS.add(b));

const CX = 127;
const CZ = 127;

const TORII_POS = { x: 127, baseY: 18, z: 190 };

const ISLANDS = {
  suigetsuro: { id: "suigetsuro", x: 78, deckY: 56, z: 174, rx: 17, rz: 17, bottomY: 32 },
  soha_pagoda: { id: "soha_pagoda", x: 64, deckY: 96, z: 98, rx: 16, rz: 16, bottomY: 68 },
  suiran_pavilion: { id: "suiran_pavilion", x: 178, deckY: 128, z: 76, rx: 17, rz: 17, bottomY: 100 },
  ryumi_observatory: { id: "ryumi_observatory", x: 188, deckY: 152, z: 156, rx: 15, rz: 15, bottomY: 128 },
  zenith_palace: { id: "zenith_palace", x: 118, deckY: 182, z: 108, rx: 25, rz: 19, bottomY: 160 },
};

const PALETTES = {
  rock: [
    "minecraft:deepslate",
    "minecraft:cobbled_deepslate",
    "minecraft:deepslate_bricks",
    "minecraft:tuff",
    "minecraft:stone",
  ],
  waterCore: [
    "minecraft:dark_prismarine",
    "minecraft:prismarine_bricks",
    "minecraft:blue_ice",
    "minecraft:packed_ice",
  ],
  waterGlass: [
    "minecraft:blue_stained_glass",
    "minecraft:cyan_stained_glass",
    "minecraft:light_blue_stained_glass",
    "minecraft:white_stained_glass",
  ],
  dragonScales: [
    "minecraft:dark_prismarine",
    "minecraft:oxidized_cut_copper",
    "minecraft:prismarine_bricks",
    "minecraft:blue_ice",
  ],
  palaceRoof: [
    "minecraft:dark_prismarine",
    "minecraft:oxidized_cut_copper",
    "minecraft:weathered_cut_copper",
  ],
  vermilion: [
    "minecraft:stripped_mangrove_log",
    "minecraft:mangrove_planks",
    "minecraft:red_nether_bricks",
    "minecraft:red_terracotta",
  ],
};

// ----------------------------------------------------------------------------
// Central Spiral Aqua Vortex Spine (Y = 14 .. 232)
// Cradles Zenith Palace bedrock around Y=160..180, then rises behind the
// palace roof ridge (Z ~ 90) so the front facade remains unobstructed.
// ----------------------------------------------------------------------------
function vortexCenter(y) {
  const t = clamp((y - 14) / 218, 0, 1);
  const baseAng = t * Math.PI * 2 * 1.15;
  let vx = CX + 8.5 * Math.sin(baseAng);
  let vz = CZ + 8.5 * Math.cos(baseAng);

  // Smoothly steer toward the rear crown of Zenith Palace (118, 108) -> (118, 86) above Y=146
  if (y > 146) {
    const u = smoothstep(146, 192, y);
    const crownX = 118 + 2.8 * Math.sin((y - 182) * 0.14);
    const crownZ = lerp(108, 86, smoothstep(172, 196, y));
    vx = lerp(vx, crownX, u);
    vz = lerp(vz, crownZ, u);
  }
  return [vx, y, vz];
}

function vortexRadius(y) {
  const t = clamp((y - 14) / 218, 0, 1);
  if (t < 0.16) {
    // Bottom suction funnel (22 -> 10.2)
    return lerp(22.0, 10.2, smoothstep(0, 0.16, t));
  }
  if (y <= 176) {
    return 9.0 + 1.8 * Math.sin(t * Math.PI * 5);
  }
  // Slender waist at Y=195 (r=4.5), then graceful chalice flare r=4.5 -> 8.4 up to Y=224
  if (y <= 195) {
    return lerp(8.5, 4.5, smoothstep(176, 195, y));
  }
  return lerp(4.5, 8.4, Math.pow(smoothstep(195, 224, y), 1.35));
}

// ----------------------------------------------------------------------------
// Aqua Dragon 3D Catmull-Rom Spine (s in [0, 1], zero occlusion, dynamic Y-waves)
// ----------------------------------------------------------------------------
const DRAGON_CTRL_PTS = [
  [78, 34, 92],    // 0: Tail tip leaping out of NW lagoon for 7-ray fan display
  [128, 36, 76],   // 1: North sweep
  [170, 56, 94],   // 2: NE sweep
  [182, 68, 136],  // 3: East sweep
  [164, 82, 168],  // 4: SE valley dip
  [124, 108, 174], // 5: South crest (clear above Torii)
  [86, 122, 146],  // 6: SW sweep
  [90, 142, 104],  // 7: West-NW low pass (east of Pagoda)
  [112, 150, 74],  // 8: North low pass (below Zenith bedrock Y=160, zero NW occlusion!)
  [152, 170, 74],  // 9: NE steep climb (clear of Island 3)
  [182, 206, 88],  // 10: ENE dramatic arch
  [186, 222, 110], // 11: East high apex (cleanly inside frame)
  [182, 212, 128], // 12: ESE neck coil
  [178, 206, 134], // 13: Neck base joining Head at [176, 204, 138]
];

const DRAGON_HEAD_POS = [176, 204, 138];
const DRAGON_PEARL_POS = [168, 197, 154];

function catmullRomPoint(pts, t) {
  const n = pts.length - 1;
  const scaled = clamp(t, 0, 1) * n;
  const i = Math.min(n - 1, Math.floor(scaled));
  const u = scaled - i;
  const p0 = pts[Math.max(0, i - 1)];
  const p1 = pts[i];
  const p2 = pts[Math.min(n, i + 1)];
  const p3 = pts[Math.min(n, i + 2)];
  const u2 = u * u;
  const u3 = u2 * u;
  const out = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    out[k] =
      0.5 *
      (2 * p1[k] +
        (-p0[k] + p2[k]) * u +
        (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * u2 +
        (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * u3);
  }
  return out;
}

function dragonCurve(s) {
  return catmullRomPoint(DRAGON_CTRL_PTS, s);
}

function dragonTangent(s) {
  const ds = 0.002;
  const a = dragonCurve(Math.max(0, s - ds));
  const b = dragonCurve(Math.min(1, s + ds));
  return vNorm(vSub(b, a));
}

function buildDragonFrames(numSamples) {
  const N = numSamples || 420;
  const frames = [];
  const worldUp = [0, 1, 0];
  let prevT = dragonTangent(0);
  // Choose initial normal as close to worldUp as possible
  let proj = vSub(worldUp, [
    prevT[0] * vDot(worldUp, prevT),
    prevT[1] * vDot(worldUp, prevT),
    prevT[2] * vDot(worldUp, prevT),
  ]);
  let up = vNorm(Math.hypot(proj[0], proj[1], proj[2]) > 0.05 ? proj : [1, 0, 0]);
  let right = vNorm(vCross(prevT, up));
  up = vNorm(vCross(right, prevT));

  for (let i = 0; i <= N; i++) {
    const s = i / N;
    const pos = dragonCurve(s);
    const T = dragonTangent(s);
    if (i > 0) {
      // Parallel transport rotation from prevT to T
      const axis = vCross(prevT, T);
      const axisLen = Math.hypot(axis[0], axis[1], axis[2]);
      if (axisLen > 1e-6) {
        const k = [axis[0] / axisLen, axis[1] / axisLen, axis[2] / axisLen];
        const cosA = clamp(vDot(prevT, T), -1, 1);
        const sinA = axisLen;
        const rotateRodrigues = (v) => {
          const kxv = vCross(k, v);
          const kdv = vDot(k, v);
          return [
            v[0] * cosA + kxv[0] * sinA + k[0] * kdv * (1 - cosA),
            v[1] * cosA + kxv[1] * sinA + k[1] * kdv * (1 - cosA),
            v[2] * cosA + kxv[2] * sinA + k[2] * kdv * (1 - cosA),
          ];
        };
        up = vNorm(rotateRodrigues(up));
      }
      // Gentle upright stabilization so dragon belly mostly faces downward/inward cleanly
      const blendUp = s > 0.85 ? 0.14 : 0.06;
      const targetUp = [
        lerp(up[0], 0, blendUp),
        lerp(up[1], 1, blendUp),
        lerp(up[2], 0, blendUp),
      ];
      const dotTU = vDot(targetUp, T);
      const ortho = vSub(targetUp, [T[0] * dotTU, T[1] * dotTU, T[2] * dotTU]);
      if (Math.hypot(ortho[0], ortho[1], ortho[2]) > 0.1) {
        up = vNorm(ortho);
      }
      right = vNorm(vCross(T, up));
      up = vNorm(vCross(right, T));
    }
    frames.push({ s, pos, T, U: up, R: right });
    prevT = T;
  }
  return frames;
}

// ----------------------------------------------------------------------------
// Shared Floating Island Bedrock Builder (Asymmetric Shan-Shui Crags, 26-neighbor hollow)
// ----------------------------------------------------------------------------
function buildIslandBedrock(cx, deckY, cz, rx, rz, bottomY, opts) {
  const pad = 6;
  const bounds = {
    minX: Math.max(MB_SAFE.minX, cx - rx - pad),
    maxX: Math.min(MB_SAFE.maxX, cx + rx + pad),
    minY: Math.max(MB_SAFE.minY, bottomY - 6),
    maxY: Math.min(MB_SAFE.maxY, deckY),
    minZ: Math.max(MB_SAFE.minZ, cz - rz - pad),
    maxZ: Math.min(MB_SAFE.maxZ, cz + rz + pad),
  };
  const hSpan = Math.max(6, deckY - bottomY);
  const stalactites = (opts && opts.stalactites) || 6;

  // Offset primary rock root away from center to break symmetrical "ice-cream cone" shape
  const rootOffAng = h2(cx, cz) * Math.PI * 2;
  const rootOffX = Math.cos(rootOffAng) * rx * 0.24;
  const rootOffZ = Math.sin(rootOffAng) * rz * 0.24;

  // Asymmetric jutting secondary rock crags of varied length, thickness, and slight outward drift
  const spires = [];
  for (let i = 0; i < stalactites; i++) {
    const ang = (i / stalactites) * Math.PI * 2 + h2(cx + i * 5, cz) * 1.1;
    const distF = i === 0 ? 0.18 : 0.42 + 0.34 * h2(cx, cz + i * 7);
    const leanF = (i % 2 === 0 ? 1 : -1) * 1.4;
    spires.push({
      sx: cx + Math.cos(ang) * rx * distF,
      sz: cz + Math.sin(ang) * rz * distF,
      driftX: Math.cos(ang) * leanF,
      driftZ: Math.sin(ang) * leanF,
      len: i === 0 ? hSpan + 3 : hSpan * (0.38 + 0.52 * h2(i, cx + cz)),
      baseR: i === 0 ? 4.8 : 2.0 + 2.1 * h2(cx + i * 3, cz),
    });
  }

  const insideFn = (wx, wy, wz) => {
    if (wy > deckY || wy < bottomY - 4) return false;
    const dx = wx - cx;
    const dz = wz - cz;
    const ang = Math.atan2(dz, dx);

    // Top deck terrace (flat top with organic mossy crag rim)
    if (wy >= deckY - 3) {
      const rimWave = 1.0 + 0.11 * Math.sin(ang * 5 + cx * 0.13) + 0.09 * fbm3D(wx * 0.09, wy * 0.09, wz * 0.09, 2);
      const normD = Math.hypot(dx / (rx * rimWave), dz / (rz * rimWave));
      const depth = deckY - wy;
      return normD <= 1.0 - depth * 0.02;
    }

    // Asymmetric cliff body with stepped horizontal rock ledges & fissures
    const vNormY = clamp((wy - bottomY) / hSpan, 0, 1);
    const shiftX = lerp(rootOffX, 0, vNormY);
    const shiftZ = lerp(rootOffZ, 0, vNormY);
    const stepLedge = 0.07 * Math.sin(vNormY * Math.PI * 4.0);
    const taper = Math.pow(vNormY, 0.72) + stepLedge;
    const noise = 0.18 * fbm3D(wx * 0.085, wy * 0.095, wz * 0.085, 3);
    const ridgeCrag = 0.14 * Math.cos(ang * 3 + rootOffAng) + 0.09 * Math.sin(ang * 7 - vNormY * 2.5);
    const rFactor = Math.max(0.1, taper * (0.92 + noise + ridgeCrag));
    const normD = Math.hypot((dx - shiftX) / (rx * rFactor), (dz - shiftZ) / (rz * rFactor));
    if (normD <= 1.0) return true;

    // Asymmetric hanging rock crags / stalactites merged into cliff overhang
    for (let i = 0; i < spires.length; i++) {
      const sp = spires[i];
      const topY = deckY - 3;
      const botY = topY - sp.len;
      if (wy <= topY && wy >= botY) {
        const st = clamp((wy - botY) / sp.len, 0, 1);
        const curX = sp.sx + sp.driftX * (1 - st);
        const curZ = sp.sz + sp.driftZ * (1 - st);
        const rad = sp.baseR * Math.pow(st, 0.65) * (0.9 + 0.15 * Math.sin(wy * 0.45));
        if (Math.hypot(wx - curX, wz - curZ) <= rad) return true;
      }
    }
    return false;
  };

  const seedAnchorFn = (wx, wy, wz) => {
    return wy === deckY && Math.hypot(wx - cx, wz - cz) <= 3.5;
  };

  buildHollowVolumeShell(
    bounds,
    insideFn,
    seedAnchorFn,
    (wx, wy, wz, info) => {
      const relY = clamp((wy - bottomY) / hSpan, 0, 1);
      const n = fbm3D(wx * 0.11, wy * 0.11, wz * 0.11, 2);
      let blk;
      if (wy === deckY && info.airAbove) {
        const edgeD = Math.hypot((wx - cx) / rx, (wz - cz) / rz);
        if (edgeD > 0.72 && n > -0.1) blk = "minecraft:moss_block";
        else blk = "minecraft:stone_bricks";
      } else if (wy >= deckY - 2) {
        blk = n > 0.2 ? "minecraft:deepslate_bricks" : "minecraft:tuff_bricks";
      } else {
        const t = clamp(relY * 0.8 + n * 0.22, 0, 0.999);
        blk = pickFromGradient(t, [
          "minecraft:deepslate",
          "minecraft:cobbled_deepslate",
          "minecraft:deepslate_bricks",
          "minecraft:tuff",
          "minecraft:stone",
        ]);
      }
      fSet(wx, wy, wz, blk);
    },
    { shellRadius: 1 }
  );
}

// ----------------------------------------------------------------------------
// Shared East Asian Upturned Curved Roof (Rectangular / Square Base)
// ----------------------------------------------------------------------------
function buildCurvedEastAsianRoof(cx, baseY, cz, halfW, halfD, height, opts) {
  const ridgeAlongX = opts && opts.ridgeAlongX !== undefined ? opts.ridgeAlongX : halfW >= halfD;
  const eaveOverhang = (opts && opts.overhang) || 3;
  const cornerLift = (opts && opts.cornerLift) || 2.4;
  const addChiwen = opts && opts.chiwen !== false;
  const addEaveLanterns = Boolean(opts && opts.eaveLanterns);

  const wExt = halfW + eaveOverhang;
  const dExt = halfD + eaveOverhang;
  const ridgeSpan = Math.max(0, (ridgeAlongX ? halfW - halfD * 0.45 : halfD - halfW * 0.45));

  // Precompute roof height map so upturned eaves are guaranteed 6-connected
  const roofHeights = new Map();
  const rKey = (dx, dz) => `${dx},${dz}`;

  for (let dx = -wExt; dx <= wExt; dx++) {
    for (let dz = -dExt; dz <= dExt; dz++) {
      const ax = Math.abs(dx);
      const az = Math.abs(dz);
      const distX = ridgeAlongX ? Math.max(0, ax - ridgeSpan) : ax;
      const distZ = ridgeAlongX ? az : Math.max(0, az - ridgeSpan);
      const spanDist = Math.max(distX / (ridgeAlongX ? dExt : wExt), distZ / (ridgeAlongX ? dExt : wExt));
      if (spanDist > 1.0) continue;

      const slopeT = 1.0 - spanDist;
      const concave = Math.pow(slopeT, 1.45) * height;
      const cornerFactor = Math.pow((ax / wExt) * (az / dExt), 1.35);
      const lift = cornerLift * cornerFactor;
      const ry = Math.round(baseY + concave + lift);
      roofHeights.set(rKey(dx, dz), { ry, ax, az, spanDist, slopeT, distX, distZ });
    }
  }

  for (let dx = -wExt; dx <= wExt; dx++) {
    for (let dz = -dExt; dz <= dExt; dz++) {
      const cell = roofHeights.get(rKey(dx, dz));
      if (!cell) continue;
      const { ry, ax, az, spanDist, slopeT, distX, distZ } = cell;

      const wx = cx + dx;
      const wz = cz + dz;
      const isEdge = ax === wExt || az === dExt;
      const isCornerTip = ax === wExt && az === dExt;
      const isHipRib = Math.abs(distX - distZ) <= 0.85 && spanDist > 0.18;
      const isTileRib = (ridgeAlongX ? ax : az) % 3 === 0 && !isEdge;

      let blk = "minecraft:dark_prismarine";
      if (isCornerTip) {
        blk = "minecraft:gold_block";
      } else if (isHipRib || spanDist < 0.16) {
        blk = "minecraft:weathered_cut_copper";
      } else if (isTileRib) {
        blk = "minecraft:dark_prismarine";
      } else if (slopeT > 0.32 && slopeT < 0.82) {
        blk = "minecraft:oxidized_cut_copper";
      }

      // Bridge any vertical step > 1 to cardinal neighbors for strict 6-connectivity
      let minNeighborY = ry;
      let maxNeighborY = ry;
      const dirs4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      for (let d = 0; d < 4; d++) {
        const nb = roofHeights.get(rKey(dx + dirs4[d][0], dz + dirs4[d][1]));
        if (nb) {
          if (nb.ry < minNeighborY) minNeighborY = nb.ry;
          if (nb.ry > maxNeighborY) maxNeighborY = nb.ry;
        }
      }
      for (let fillY = minNeighborY; fillY < ry; fillY++) {
        pSet(wx, fillY, wz, "minecraft:dark_prismarine");
      }

      if (isCornerTip) {
        pSet(wx, ry, wz, "minecraft:gold_block");
        pSet(wx, ry + 1, wz, "minecraft:end_rod", { facing: "up" });
      } else if (isEdge) {
        const stairBlk = (ax + az) % 2 === 0 ? "minecraft:dark_prismarine_stairs" : "minecraft:oxidized_cut_copper_stairs";
        const facing =
          ax === wExt
            ? (dx > 0 ? "west" : "east")
            : (dz > 0 ? "north" : "south");
        pSet(wx, ry, wz, stairBlk, { facing, half: "bottom" });

        // Eave underside wooden rafters (垂木) every 2 blocks
        if ((ax + az) % 2 === 0) {
          const rafterFacing =
            ax === wExt
              ? (dx > 0 ? "east" : "west")
              : (dz > 0 ? "south" : "north");
          pSetIfEmpty(wx, ry - 1, wz, "minecraft:dark_oak_stairs", { facing: rafterFacing, half: "top" });
        }
      } else {
        pSet(wx, ry, wz, blk);
        // Hon-gawara tile rib & slope half-slab smoothing on rising steps
        if (isTileRib && maxNeighborY >= ry + 1) {
          pSetIfEmpty(wx, ry + 1, wz, "minecraft:oxidized_cut_copper_slab", { type: "bottom" });
        }
      }
    }
  }

  // Main horizontal ridge beam + central gold crest + sculpted 4-block Chiwen (鯱)
  const ridgeY = Math.round(baseY + height);
  if (ridgeAlongX) {
    for (let dx = -ridgeSpan - 1; dx <= ridgeSpan + 1; dx++) {
      pSet(cx + dx, ridgeY + 1, cz, dx === 0 && ridgeSpan >= 2 ? "minecraft:gold_block" : "minecraft:oxidized_cut_copper_slab", dx === 0 && ridgeSpan >= 2 ? undefined : { type: "bottom" });
    }
    if (addChiwen) {
      for (const sgn of [-1, 1]) {
        const rx = cx + sgn * (ridgeSpan + 1);
        pSet(rx, ridgeY + 1, cz, "minecraft:gold_block");
        pSet(rx, ridgeY + 2, cz, "minecraft:ochre_froglight");
        pSet(rx, ridgeY + 3, cz, "minecraft:gold_block");
        pSet(rx - sgn, ridgeY + 3, cz, "minecraft:gold_block");
        pSet(rx - sgn, ridgeY + 4, cz, "minecraft:end_rod", { facing: "up" });
      }
    }
  } else {
    for (let dz = -ridgeSpan - 1; dz <= ridgeSpan + 1; dz++) {
      pSet(cx, ridgeY + 1, cz + dz, dz === 0 && ridgeSpan >= 2 ? "minecraft:gold_block" : "minecraft:oxidized_cut_copper_slab", dz === 0 && ridgeSpan >= 2 ? undefined : { type: "bottom" });
    }
    if (addChiwen) {
      for (const sgn of [-1, 1]) {
        const rz = cz + sgn * (ridgeSpan + 1);
        pSet(cx, ridgeY + 1, rz, "minecraft:gold_block");
        pSet(cx, ridgeY + 2, rz, "minecraft:ochre_froglight");
        pSet(cx, ridgeY + 3, rz, "minecraft:gold_block");
        pSet(cx, ridgeY + 3, rz - sgn, "minecraft:gold_block");
        pSet(cx, ridgeY + 4, rz - sgn, "minecraft:end_rod", { facing: "up" });
      }
    }
  }

  // Hanging lanterns: corners + mid-eave spans on large roofs (strictly vertical iron_chain)
  if (addEaveLanterns) {
    const lanternOffsets = [
      [wExt - 1, dExt - 1],
      [-(wExt - 1), dExt - 1],
      [wExt - 1, -(dExt - 1)],
      [-(wExt - 1), -(dExt - 1)],
    ];
    if (halfW >= 6) {
      const midX = Math.max(3, Math.floor((wExt - 1) * 0.5));
      lanternOffsets.push([midX, dExt - 1], [-midX, dExt - 1], [midX, -(dExt - 1)], [-midX, -(dExt - 1)]);
    }
    if (halfD >= 5) {
      lanternOffsets.push([wExt - 1, 0], [-(wExt - 1), 0]);
    }
    for (const [odx, odz] of lanternOffsets) {
      const cell = roofHeights.get(rKey(odx, odz));
      const anchorY = cell ? cell.ry : Math.round(baseY + cornerLift * 0.72);
      const lx = cx + odx;
      const lz = cz + odz;
      pSetIfEmpty(lx, anchorY, lz, "minecraft:dark_prismarine");
      hangLanternChain(lx, anchorY, lz, 1, "minecraft:lantern", "minecraft:iron_chain");
    }
  }
}

// ----------------------------------------------------------------------------
// Shared Zero-T-Chain Kasuga Stone Lantern (3x3 Kasa Canopy + Pedestal Base)
// ----------------------------------------------------------------------------
function buildStoneLantern(x, y, z, tall) {
  const h = tall ? 4 : 3;
  // Base pedestal + 4 cardinal stairs (if space is clear)
  pSet(x, y, z, "minecraft:deepslate_bricks");
  const pedDirs = [[1, 0, "west"], [-1, 0, "east"], [0, 1, "north"], [0, -1, "south"]];
  for (let i = 0; i < 4; i++) {
    pSetIfEmpty(x + pedDirs[i][0], y, z + pedDirs[i][1], "minecraft:polished_deepslate_stairs", {
      facing: pedDirs[i][2],
      half: "bottom",
    });
  }
  for (let i = 1; i < h - 1; i++) {
    pSet(x, y + i, z, "minecraft:deepslate_brick_wall");
  }
  pSet(x, y + h - 1, z, "minecraft:ochre_froglight");

  // 3x3 Curved Kasa Roof + Restrained Oxidized-Copper Finial (no yellow dice block!)
  pSet(x, y + h, z, "minecraft:dark_prismarine");
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (dx === 0 && dz === 0) continue;
      pSetIfEmpty(x + dx, y + h, z + dz, "minecraft:dark_prismarine_slab", { type: "bottom" });
    }
  }
  pSet(x, y + h + 1, z, "minecraft:weathered_cut_copper_slab", { type: "bottom" });
}

// ----------------------------------------------------------------------------
// Shared Organic Pine / Weeping Cherry Tree (8-10 tall, 4-5 canopy pads, 6-conn)
// ----------------------------------------------------------------------------
function buildStylizedTree(x, y, z, style, scale) {
  const sc = scale || 1.0;
  const h = Math.round(8.5 * sc);
  const leanX = Math.round((h2(x, z) - 0.5) * 4);
  const leanZ = Math.round((h2(z, x + 7) - 0.5) * 4);
  const isCherry = style === "cherry";
  const logBlk = isCherry ? "minecraft:cherry_wood" : "minecraft:dark_oak_wood";
  const leafBlk = isCherry ? "minecraft:cherry_leaves" : "minecraft:spruce_leaves";

  const topX = x + leanX;
  const topY = y + h;
  const topZ = z + leanZ;
  drawStrut(x, y, z, topX, topY, topZ, logBlk, 0);

  // 5 Stepped Asymmetric Foliage Canopy Pads strictly branched from main trunk
  const pads = [
    [topX, topY + 1, topZ, Math.round(2.8 * sc)],
    [Math.round(lerp(x, topX, 0.78)) + 2, Math.round(y + h * 0.82), Math.round(lerp(z, topZ, 0.78)) - 1, Math.round(2.5 * sc)],
    [Math.round(lerp(x, topX, 0.66)) - 2, Math.round(y + h * 0.68), Math.round(lerp(z, topZ, 0.66)) + 2, Math.round(2.4 * sc)],
    [Math.round(lerp(x, topX, 0.52)) + 2, Math.round(y + h * 0.54), Math.round(lerp(z, topZ, 0.52)) + 2, Math.round(2.1 * sc)],
    [Math.round(lerp(x, topX, 0.42)) - 2, Math.round(y + h * 0.44), Math.round(lerp(z, topZ, 0.42)) - 2, Math.round(1.9 * sc)],
  ];
  for (let p = 0; p < pads.length; p++) {
    const [px, py, pz, rad] = pads[p];
    const branchStartT = clamp(0.4 + p * 0.1, 0.35, 0.85);
    drawStrut(
      Math.round(lerp(x, topX, branchStartT)),
      Math.round(lerp(y, topY, branchStartT)),
      Math.round(lerp(z, topZ, branchStartT)),
      px, py, pz,
      logBlk, 0
    );
    for (let dx = -rad; dx <= rad; dx++) {
      for (let dz = -rad; dz <= rad; dz++) {
        for (let dy = 0; dy <= 1; dy++) {
          const d = Math.hypot(dx, dz) + dy * 0.85;
          if (d <= rad + 0.35) {
            pSetIfEmpty(px + dx, py + dy, pz + dz, leafBlk, { persistent: "true" });
            // Weeping cherry blossom drapes 1-2 blocks under outer canopy rim
            if (isCherry && dy === 0 && d >= rad - 0.7 && ((px + dx + pz + dz) % 2 === 0)) {
              pSetIfEmpty(px + dx, py - 1, pz + dz, leafBlk, { persistent: "true" });
              if ((px + pz + dx) % 3 === 0) {
                pSetIfEmpty(px + dx, py - 2, pz + dz, leafBlk, { persistent: "true" });
              }
            }
          }
        }
      }
    }
  }

  // Flowering azalea & moss shrubs grounded at trunk base
  const shrubOffsets = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let i = 0; i < shrubOffsets.length; i++) {
    if ((i + x + z) % 2 !== 0) continue;
    const sx = x + shrubOffsets[i][0];
    const sz = z + shrubOffsets[i][1];
    if (world.getVoxel(sx, y - 1, sz)) {
      pSetIfEmpty(sx, y, sz, i % 2 === 0 ? "minecraft:flowering_azalea_leaves" : "minecraft:azalea_leaves", { persistent: "true" });
    }
  }
}

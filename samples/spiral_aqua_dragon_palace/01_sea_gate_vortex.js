// ============================================================================
// 01_sea_gate_vortex.js — Sea Gate, Water-Mirror Vortex Bowl & Ryobu Torii
// Target budget: ~32k - 36k voxels | Y = 8 .. 58
// ============================================================================

(function buildSeaGateAndVortex() {
  const BOWL_R = 68;
  const WATER_Y = 17;

  // 1. Seabed Bowl + Sculpted Reef Cliffs (strictly 6-connected)
  // Keep South-Southeast sector (Z > 162, X in [96..165]) low so Torii & Vortex stay unobstructed.
  const seabedTop = new Map();
  const key2D = (x, z) => `${x},${z}`;

  for (let dx = -BOWL_R - 8; dx <= BOWL_R + 8; dx++) {
    for (let dz = -BOWL_R - 8; dz <= BOWL_R + 8; dz++) {
      const wx = CX + dx;
      const wz = CZ + dz;
      const r = Math.hypot(dx, dz);
      const ang = Math.atan2(dz, dx);
      const rimWave = 1.0 + 0.08 * Math.sin(ang * 5 + 0.4) + 0.06 * fbm3D(wx * 0.06, 0, wz * 0.06, 2);
      const effR = BOWL_R * rimWave;
      if (r > effR) continue;

      // Bowl profile: deep funnel at center (Y=8..10), gentle basin (Y=11..15), rising rim (Y=16..34)
      let topY;
      if (r < 22) {
        topY = 8 + Math.floor((r / 22) * 3);
      } else if (r < effR - 12) {
        const u = (r - 22) / (effR - 34);
        topY = Math.round(11 + u * 4 + fbm3D(wx * 0.08, 2, wz * 0.08, 2) * 1.2);
      } else {
        const rimU = clamp((r - (effR - 12)) / 12, 0, 1);
        // Gate sector facing South/SE stays submerged/low rim
        const inGateSector = wz > 158 && wx > 96 && wx < 166;
        const cliffBoost = inGateSector
          ? 2.0 * rimU
          : (10 + 12 * Math.max(0, Math.sin(ang * 3 - 0.8))) * Math.pow(rimU, 1.3);
        const crag = fbm3D(wx * 0.1, 4, wz * 0.1, 2) * (inGateSector ? 1.0 : 4.5 * rimU);
        topY = Math.round(15 + cliffBoost + crag);
      }
      topY = clamp(topY, 8, 38);
      seabedTop.set(key2D(wx, wz), topY);
    }
  }

  // Emit 6-connected seabed surface (bridge height drops to neighbors so shell is airtight)
  for (const [k, topY] of seabedTop.entries()) {
    const parts = k.split(",");
    const wx = Number(parts[0]);
    const wz = Number(parts[1]);
    const nOffsets = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    let minNeighbor = topY;
    for (let i = 0; i < 4; i++) {
      const ny = seabedTop.get(key2D(wx + nOffsets[i][0], wz + nOffsets[i][1]));
      if (ny !== undefined && ny < minNeighbor) minNeighbor = ny;
    }
    const baseColY = Math.max(8, Math.min(topY, minNeighbor));
    const r = Math.hypot(wx - CX, wz - CZ);

    for (let wy = baseColY; wy <= topY; wy++) {
      const n = fbm3D(wx * 0.09, wy * 0.1, wz * 0.09, 2);
      let blk;
      if (wy >= 20 && wy === topY && n > 0.05) {
        blk = "minecraft:moss_block";
      } else if (wy <= 12 && r < 28) {
        blk = n > 0.15 ? "minecraft:prismarine_bricks" : "minecraft:dark_prismarine";
      } else {
        const t = clamp((wy - 8) / 24 + n * 0.2, 0, 0.999);
        blk = pickFromGradient(t, PALETTES.rock);
      }
      fSet(wx, wy, wz, blk);
    }
  }

  // 2. Water-Mirror Surface (Y=17) & 4 Logarithmic Spiral Vortex Arms
  // Every elevated foam/wave block rests directly on WATER_Y or adjacent wave block (6-connected).
  const armWaveHeights = new Map();
  for (let dx = -60; dx <= 60; dx++) {
    for (let dz = -60; dz <= 60; dz++) {
      const wx = CX + dx;
      const wz = CZ + dz;
      const r = Math.hypot(dx, dz);
      if (r < 9 || r > 58) continue;
      const seaY = seabedTop.get(key2D(wx, wz));
      if (seaY === undefined || seaY >= WATER_Y) continue;

      const theta = Math.atan2(dz, dx);
      // 4-arm logarithmic spiral phase
      const logR = Math.log(Math.max(4, r));
      const armPhase = Math.cos(4 * (theta - 1.35 * logR));
      const innerPull = smoothstep(56, 14, r);

      if (armPhase > 0.52) {
        // Luminous sub-surface aqua vein + surging spiral wave crest (rises 2 -> 5 toward center!)
        fSet(wx, WATER_Y - 1, wz, armPhase > 0.76 ? "minecraft:sea_lantern" : "minecraft:blue_ice");
        fSet(wx, WATER_Y, wz, armPhase > 0.8 ? "minecraft:light_blue_stained_glass" : "minecraft:cyan_stained_glass");
        if (armPhase > 0.75 && innerPull > 0.18) {
          const ridgeH = Math.min(5, Math.max(1, Math.round(1 + innerPull * 3.8 + (armPhase - 0.75) * 4.0)));
          armWaveHeights.set(key2D(wx, wz), ridgeH);
        }
      } else if (armPhase > 0.15) {
        fSet(wx, WATER_Y, wz, "minecraft:cyan_stained_glass");
      } else {
        fSet(wx, WATER_Y, wz, r < 28 ? "minecraft:blue_stained_glass" : "minecraft:light_blue_stained_glass");
      }
    }
  }

  // Emit raised spiral wave crests stacked cleanly from WATER_Y+1 upward
  for (const [k, h] of armWaveHeights.entries()) {
    const parts = k.split(",");
    const wx = Number(parts[0]);
    const wz = Number(parts[1]);
    for (let dy = 1; dy <= h; dy++) {
      const blk = dy >= h - 1 && h >= 3 ? "minecraft:white_stained_glass" : dy === h ? "minecraft:white_stained_glass" : "minecraft:light_blue_stained_glass";
      fSet(wx, WATER_Y + dy, wz, blk);
    }
  }

  // Dragon Tail Breaching Splash Crown at NW Lagoon (78, 17..34, 92)
  const tailX = 78;
  const tailZ = 92;
  for (let dx = -9; dx <= 9; dx++) {
    for (let dz = -9; dz <= 9; dz++) {
      const d = Math.hypot(dx, dz);
      if (d <= 8.5) {
        fSetIfEmpty(tailX + dx, WATER_Y - 1, tailZ + dz, d < 6.0 ? "minecraft:sea_lantern" : "minecraft:blue_ice");
        fSetIfEmpty(tailX + dx, WATER_Y, tailZ + dz, d < 5.5 ? "minecraft:light_blue_stained_glass" : "minecraft:cyan_stained_glass");
      }
    }
  }
  for (let a = 0; a < 7; a++) {
    const ang = (a / 7) * Math.PI * 2 + 0.3;
    const sx = Math.round(tailX + Math.cos(ang) * 7.5);
    const sz = Math.round(tailZ + Math.sin(ang) * 7.5);
    const ex = Math.round(tailX + Math.cos(ang) * 2.2);
    const ez = Math.round(tailZ + Math.sin(ang) * 2.2);
    const ey = 27 + (a % 3) * 2;
    drawCatenary(
      sx, WATER_Y, sz, ex, ey, ez, -3.5,
      (x, y, z, t) => (t > 0.65 ? "minecraft:white_stained_glass" : t > 0.3 ? "minecraft:light_blue_stained_glass" : "minecraft:blue_ice"),
      { fast: true }
    );
  }

  // 3. Submerged Reef Stalagmite Spires (NW / NE / W / E decorative dark-stone rocks)
  const reefSites = [
    [CX - 48, CZ - 34, 24, 5],
    [CX + 46, CZ - 38, 25, 5],
    [CX - 52, CZ + 18, 23, 4],
    [CX + 52, CZ + 14, 23, 4],
  ];
  for (let i = 0; i < reefSites.length; i++) {
    const [rx, rz, topY, baseRad] = reefSites[i];
    for (let y = 13; y <= topY; y++) {
      const t = (y - 13) / (topY - 13);
      const rad = Math.max(0.9, baseRad * (1 - t * 0.8));
      const rCeil = Math.ceil(rad);
      for (let dx = -rCeil; dx <= rCeil; dx++) {
        for (let dz = -rCeil; dz <= rCeil; dz++) {
          if (Math.hypot(dx, dz) <= rad) {
            const blk = y >= topY - 1 ? "minecraft:moss_block" : pickFromGradient(t, PALETTES.rock);
            fSet(rx + dx, y, rz + dz, blk);
          }
        }
      }
    }
    // Glowing prismarine crystal accent + water-surface white ripple ring around reef
    pSet(rx, topY + 1, rz, "minecraft:sea_lantern");
    for (let dx = -baseRad - 2; dx <= baseRad + 2; dx++) {
      for (let dz = -baseRad - 2; dz <= baseRad + 2; dz++) {
        const d = Math.hypot(dx, dz);
        if (d >= baseRad - 0.5 && d <= baseRad + 1.5 && world.getVoxel(rx + dx, WATER_Y, rz + dz)) {
          pSetIfEmpty(rx + dx, WATER_Y + 1, rz + dz, d > baseRad + 0.5 ? "minecraft:light_blue_stained_glass" : "minecraft:white_stained_glass");
        }
      }
    }
  }

  // 4. South Causeway (Z = 188..222) & Short Torii Altar Terrace (Z = 178..188)
  // Leaves Z < 178 open behind Torii so the central vortex spirals in full view!
  const deckY = 18;
  for (let z = 178; z <= 222; z++) {
    const halfW = z >= 188 ? 5 : 4;
    for (let x = CX - halfW; x <= CX + halfW; x++) {
      const ax = Math.abs(x - CX);
      const isEdge = ax === halfW;
      const runner = ax <= 1 ? "minecraft:smooth_quartz" : "minecraft:stone_bricks";
      pSet(x, deckY, z, isEdge ? "minecraft:deepslate_bricks" : runner);
      pSet(x, deckY - 1, z, "minecraft:deepslate_bricks");

      if ((z - 178) % 6 === 0 && (isEdge || ax === 0)) {
        for (let py = deckY - 2; py >= 10; py--) {
          if (world.getVoxel(x, py, z)) break;
          fSet(x, py, z, "minecraft:deepslate_bricks");
        }
      }

      const nearTorii = z >= 187 && z <= 193;
      if (isEdge && !nearTorii && z < 222 && z > 180) {
        if (z % 4 === 0) {
          pSet(x, deckY + 1, z, "minecraft:stripped_mangrove_log");
          pSet(x, deckY + 2, z, "minecraft:dark_prismarine_slab", { type: "bottom" });
        } else {
          pSet(x, deckY + 1, z, "minecraft:mangrove_fence");
        }
      }
    }
  }

  // Westward Stone Walkway & Reef Landing Terrace (102, 21, 182) for Island 1 Bridge
  for (let x = 102; x <= 122; x++) {
    const u = (122 - x) / 20;
    const wy = Math.round(18 + u * 3);
    for (let dz = -2; dz <= 2; dz++) {
      const wz = 182 + dz;
      const isEdge = Math.abs(dz) === 2;
      pSet(x, wy, wz, isEdge ? "minecraft:deepslate_bricks" : "minecraft:stone_bricks");
      pSet(x, wy - 1, wz, "minecraft:deepslate_bricks");
      if (isEdge && x % 4 === 0) {
        pSet(x, wy + 1, wz, "minecraft:mangrove_fence");
      }
      if (x % 5 === 0 && isEdge) {
        for (let py = wy - 2; py >= 12; py--) {
          if (world.getVoxel(x, py, wz)) break;
          fSet(x, py, wz, "minecraft:deepslate_bricks");
        }
      }
    }
  }
  // Small rock landing outcrop around (102, 21, 182)
  for (let dx = -4; dx <= 4; dx++) {
    for (let dz = -4; dz <= 4; dz++) {
      const d = Math.hypot(dx, dz);
      if (d <= 4.2) {
        const top = d < 3.0 ? 21 : 20;
        for (let py = 14; py <= top; py++) {
          fSet(102 + dx, py, 182 + dz, py === top && d > 3.0 ? "minecraft:moss_block" : "minecraft:deepslate_bricks");
        }
      }
    }
  }
  pSet(100, 21, 185, "minecraft:deepslate_bricks");
  buildStoneLantern(100, 22, 185, false);

  // 6 Stone Lanterns flanking the South Causeway (with 6-connected stone side piers)
  const lanternZs = [198, 209, 220];
  for (let i = 0; i < lanternZs.length; i++) {
    const lz = lanternZs[i];
    for (const sgn of [-1, 1]) {
      const lx = CX + sgn * 7;
      // Connect horizontally to causeway edge (CX ± 5) at deckY and deckY - 1
      for (let bx = Math.min(lx, CX + sgn * 5); bx <= Math.max(lx, CX + sgn * 5); bx++) {
        pSet(bx, deckY, lz, "minecraft:deepslate_bricks");
        pSet(bx, deckY - 1, lz, "minecraft:deepslate_bricks");
      }
      for (let py = deckY - 2; py >= 12; py--) {
        if (world.getVoxel(lx, py, lz)) break;
        pSet(lx, py, lz, "minecraft:deepslate_bricks");
      }
      buildStoneLantern(lx, deckY + 1, lz, true);
    }
  }

  // 5. Great Vermilion Ryobu Torii (両部大鳥居) at (127, Y=18..56, Z=190)
  // Authentic proportions: 4x4 Kamebara bases, Daiwa collars, 5-block sky window
  // between Nuki and Slim Shimaki/Kasagi, narrow 5-wide plaque, gabled Chigo-bashira.
  const tx = TORII_POS.x;
  const tz = TORII_POS.z;
  const baseY = TORII_POS.baseY;
  const pillarOffsets = [-8, 8];

  for (let pi = 0; pi < pillarOffsets.length; pi++) {
    const px = tx + pillarOffsets[pi];
    const pLeft = px - (pi === 0 ? 1 : 0);

    // 4x4 2-Tier Kamebara Stone Foundation at pillar foot (baseY-2 .. baseY+2)
    for (let dx = -1; dx <= 2; dx++) {
      for (let dz = -1; dz <= 2; dz++) {
        const isRim = dx === -1 || dx === 2 || dz === -1 || dz === 2;
        for (let y = baseY - 2; y <= baseY + (isRim ? 1 : 2); y++) {
          pSet(pLeft + dx, y, tz + dz, "minecraft:deepslate_bricks");
        }
        if (isRim) {
          const facing = dx === -1 ? "east" : dx === 2 ? "west" : dz === -1 ? "south" : "north";
          pSetIfEmpty(pLeft + dx, baseY + 2, tz + dz, "minecraft:polished_deepslate_stairs", { facing, half: "bottom" });
        }
      }
    }

    // Main 2x2 Vermilion Pillar (baseY+3 .. baseY+30) + Daiwa Collar at baseY+30
    for (let y = baseY + 3; y <= baseY + 30; y++) {
      const blk = y === baseY + 30 ? "minecraft:gold_block" : "minecraft:stripped_mangrove_log";
      for (let ox = 0; ox <= 1; ox++) {
        for (let oz = 0; oz <= 1; oz++) {
          pSet(pLeft + ox, y, tz + oz, blk);
        }
      }
    }

    // Chigo-bashira (4 front/back legs supporting Ryobu Torii)
    for (const dzLeg of [-4, 4]) {
      const lx = px;
      const lz = tz + dzLeg;
      for (let y = baseY - 2; y <= baseY + 17; y++) {
        pSet(lx, y, lz, y <= baseY + 2 ? "minecraft:deepslate_bricks" : "minecraft:stripped_mangrove_log");
      }
      // Tie-beams + golden wedge pins
      const zMin = Math.min(tz, lz);
      const zMax = Math.max(tz, lz);
      for (let z = zMin; z <= zMax; z++) {
        pSet(lx, baseY + 8, z, "minecraft:mangrove_planks");
        pSet(lx, baseY + 14, z, "minecraft:mangrove_planks");
      }
      pSet(lx, baseY + 14, lz + (dzLeg > 0 ? 1 : -1), "minecraft:dark_oak_trapdoor", { half: "top" });

      // Curved Mini Gabled Roof over each Chigo-bashira
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const blk = dx === 0 ? "minecraft:dark_prismarine" : "minecraft:dark_prismarine_stairs";
          const st = dx === 0 ? undefined : { facing: dx < 0 ? "east" : "west", half: "bottom" };
          pSet(lx + dx, baseY + 18, lz + dz, blk, st);
        }
      }
      pSet(lx, baseY + 19, lz - 1, "minecraft:oxidized_cut_copper_slab", { type: "bottom" });
      pSet(lx, baseY + 19, lz, "minecraft:oxidized_cut_copper_slab", { type: "bottom" });
      pSet(lx, baseY + 19, lz + 1, "minecraft:oxidized_cut_copper_slab", { type: "bottom" });
    }
  }

  // Nuki (lower crossbeam at Y = baseY + 24..25, leaving 5-block sky gap below Shimaki!)
  for (let x = tx - 16; x <= tx + 16; x++) {
    const ax = Math.abs(x - tx);
    const blk = ax === 16 ? "minecraft:gold_block" : "minecraft:stripped_mangrove_log";
    pSet(x, baseY + 24, tz, blk);
    pSet(x, baseY + 24, tz + 1, blk);
    if (ax <= 14) {
      pSet(x, baseY + 25, tz, "minecraft:mangrove_planks");
      pSet(x, baseY + 25, tz + 1, "minecraft:mangrove_planks");
    }
  }

  // Slim Upturned Shimaki (directly below Kasagi) + Kasagi — 5-block sky window above Nuki!
  let prevKasagiY = baseY + 37;
  for (let dx = -20; dx <= 20; dx++) {
    const ax = Math.abs(dx);
    const lift = Math.round(Math.pow(ax / 20, 2.2) * 4.0);
    const kasagiY = baseY + 33 + lift;
    const shimakiY = kasagiY - 1;

    if (ax <= 18) {
      pSet(tx + dx, shimakiY, tz, "minecraft:red_nether_bricks");
      pSet(tx + dx, shimakiY, tz + 1, "minecraft:red_nether_bricks");
      pSet(tx + dx, shimakiY - 1, tz, "minecraft:stripped_mangrove_log");
      pSet(tx + dx, shimakiY - 1, tz + 1, "minecraft:stripped_mangrove_log");
    }
    const kFillMin = Math.min(kasagiY, prevKasagiY);
    for (let dz = -1; dz <= 2; dz++) {
      if (ax === 20 && (dz === -1 || dz === 2)) continue;
      const isTip = ax === 20;
      const capBlk = isTip
        ? "minecraft:gold_block"
        : dz === -1 || dz === 2
          ? "minecraft:dark_prismarine"
          : "minecraft:oxidized_cut_copper";
      pSet(tx + dx, kasagiY, tz + dz, capBlk);
      if (dz === 0 || dz === 1) {
        for (let ky = kFillMin; ky < kasagiY; ky++) {
          pSet(tx + dx, ky, tz + dz, "minecraft:dark_prismarine");
        }
      }
    }
    if (ax <= 19) {
      pSet(tx + dx, kasagiY + 1, tz, "minecraft:oxidized_cut_copper_slab", { type: "bottom" });
      pSet(tx + dx, kasagiY + 1, tz + 1, "minecraft:oxidized_cut_copper_slab", { type: "bottom" });
    } else {
      pSet(tx + dx, kasagiY + 1, tz, "minecraft:end_rod", { facing: "up" });
    }
    prevKasagiY = kasagiY;
  }

  // Narrow, Dignified Central Golden Plaque (dx = -2..+2, leaving 5x5 sky windows each side!)
  for (let dx = -2; dx <= 2; dx++) {
    for (let dy = 26; dy <= 31; dy++) {
      const isBorder = Math.abs(dx) === 2 || dy === 26 || dy === 31;
      const isCenter = dx === 0 && dy === 28;
      const blk = isBorder
        ? "minecraft:deepslate_bricks"
        : isCenter
          ? "minecraft:ochre_froglight"
          : "minecraft:gold_block";
      pSet(tx + dx, baseY + dy, tz, blk);
      pSet(tx + dx, baseY + dy, tz + 1, blk);
    }
  }

  // Hanging lanterns beneath Nuki beam (strictly vertical iron_chain, zero T-chain)
  hangLanternChain(tx - 12, baseY + 24, tz, 2, "minecraft:lantern", "minecraft:iron_chain");
  hangLanternChain(tx + 12, baseY + 24, tz, 2, "minecraft:lantern", "minecraft:iron_chain");
  hangLanternChain(tx - 12, baseY + 24, tz + 1, 2, "minecraft:lantern", "minecraft:iron_chain");
  hangLanternChain(tx + 12, baseY + 24, tz + 1, 2, "minecraft:lantern", "minecraft:iron_chain");
})();

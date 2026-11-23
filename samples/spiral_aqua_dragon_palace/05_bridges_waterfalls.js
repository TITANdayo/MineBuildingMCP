// ============================================================================
// 05_bridges_waterfalls.js — Arch-Rib Drum Bridges, Portal Gates, Azumaya & Clouds
// Target budget: ~20k - 26k voxels
// ============================================================================

(function buildBridgesWaterfallsAndDetails() {
  // Helper: Mid-Sky Scenic Crag Islet w/ 10-Block Stalactite Root & Optional Azumaya Pavilion
  function buildSteppingIslet(cx, deckY, cz, rad, withAzumaya) {
    const rCeil = Math.ceil(rad);
    for (let dx = -rCeil; dx <= rCeil; dx++) {
      for (let dz = -rCeil; dz <= rCeil; dz++) {
        const d = Math.hypot(dx, dz);
        if (d > rad) continue;
        pSet(cx + dx, deckY, cz + dz, d > rad - 1.1 ? "minecraft:deepslate_bricks" : "minecraft:stone_bricks");
        const cragNoise = 0.2 * fbm3D((cx + dx) * 0.2, 0, (cz + dz) * 0.2, 2);
        const depth = Math.max(1, Math.round(Math.pow(Math.max(0, 1 - d / rad), 0.75) * (withAzumaya ? 10.5 : 6.5) + cragNoise * 2));
        for (let dy = 1; dy <= depth; dy++) {
          const blk = dy === 1 && d > rad - 1.3 ? "minecraft:moss_block" : dy % 2 === 0 ? "minecraft:deepslate" : "minecraft:tuff";
          pSet(cx + dx, deckY - dy, cz + dz, blk);
        }
      }
    }

    if (withAzumaya) {
      // 4-Pillar Vermilion Azumaya (四阿) w/ Upturned Mini Roof & Hanging Lantern
      for (const sx of [-2, 2]) {
        for (const sz of [-2, 2]) {
          for (let dy = 1; dy <= 4; dy++) {
            pSet(cx + sx, deckY + dy, cz + sz, dy === 1 ? "minecraft:deepslate_bricks" : "minecraft:stripped_mangrove_log");
          }
        }
      }
      buildCurvedEastAsianRoof(cx, deckY + 5, cz, 2, 2, 2.8, { overhang: 2, cornerLift: 1.5, chiwen: false });
      // Diagonal tie-beams linking the 4 corner posts to support the central hanging lantern
      drawStrut(cx - 2, deckY + 4, cz - 2, cx + 2, deckY + 4, cz + 2, "minecraft:dark_oak_planks", 0);
      drawStrut(cx - 2, deckY + 4, cz + 2, cx + 2, deckY + 4, cz - 2, "minecraft:dark_oak_planks", 0);
      pSet(cx, deckY + 4, cz, "minecraft:dark_oak_planks");
      hangLanternChain(cx, deckY + 4, cz, 1, "minecraft:lantern", "minecraft:iron_chain");
    } else {
      buildStoneLantern(cx, deckY + 1, cz, false);
    }
  }

  // --------------------------------------------------------------------------
  // 1. Sleek Curved 6-Connected Aerial Bridge w/ Portal Gatehouses & Lower Arch Ribs
  // --------------------------------------------------------------------------
  function buildAerialBridge(pStart, pEnd, archHeight, opts) {
    const [x1, y1, z1] = pStart;
    const [x2, y2, z2] = pEnd;
    const width = (opts && opts.width) || 3;
    const halfW = Math.floor(width / 2);
    const isSuspension = Boolean(opts && opts.suspension);
    const hasArchRib = Boolean(opts && opts.archRib);
    const hasTowers = opts && opts.towers !== false;
    const lateralCurve = (opts && opts.lateralCurve) || 0;

    const dx = x2 - x1;
    const dz = z2 - z1;
    const horizLen = Math.max(1, Math.hypot(dx, dz));
    const perpX = -dz / horizLen;
    const perpZ = dx / horizLen;
    const fwdX = dx / horizLen;
    const fwdZ = dz / horizLen;

    const postOffsets = [-halfW - 1, halfW + 1];
    const postCoordsA = [];
    const postCoordsB = [];

    // Helper: Build 3-wide Curved Portal Gatehouse Roof & Hanging Lantern over Bridge End
    function buildPortalGate(cx, cy, cz, cA, cB) {
      drawStrut(cA[0], cy + 4, cA[1], cB[0], cy + 4, cB[1], "minecraft:mangrove_planks", 0);
      drawStrut(cA[0], cy + 6, cA[1], cB[0], cy + 6, cB[1], "minecraft:oxidized_cut_copper", 0);
      // Overhanging 3-deep eave trim along bridge forward axis + upturned tips
      for (let f = -1; f <= 1; f++) {
        for (let off = -halfW - 2; off <= halfW + 2; off++) {
          const rx = Math.round(cx + perpX * off + fwdX * f);
          const rz = Math.round(cz + perpZ * off + fwdZ * f);
          const isTip = Math.abs(off) === halfW + 2;
          const ry = cy + (f === 0 ? 7 : 6) + (isTip ? 1 : 0);
          if (isTip) {
            pSet(rx, ry, rz, "minecraft:oxidized_cut_copper_slab", { type: "bottom" });
            pSetIfEmpty(rx, ry - 1, rz, "minecraft:dark_prismarine");
          } else {
            pSet(rx, ry, rz, f === 0 ? "minecraft:oxidized_cut_copper" : "minecraft:dark_prismarine");
          }
        }
      }
      // Center vertical hanging lantern beneath portal roof
      const midX = Math.round(cx);
      const midZ = Math.round(cz);
      pSet(midX, cy + 6, midZ, "minecraft:dark_oak_planks");
      hangLanternChain(midX, cy + 6, midZ, 1, "minecraft:lantern", "minecraft:iron_chain");
    }

    if (hasTowers) {
      for (let pi = 0; pi < 2; pi++) {
        const off = postOffsets[pi];
        const ax = Math.round(x1 + perpX * off);
        const az = Math.round(z1 + perpZ * off);
        const bx = Math.round(x2 + perpX * off);
        const bz = Math.round(z2 + perpZ * off);
        postCoordsA.push([ax, az]);
        postCoordsB.push([bx, bz]);

        for (let dy = -1; dy <= 6; dy++) {
          pSet(ax, y1 + dy, az, dy <= 0 ? "minecraft:deepslate_bricks" : "minecraft:stripped_mangrove_log");
          pSet(bx, y2 + dy, bz, dy <= 0 ? "minecraft:deepslate_bricks" : "minecraft:stripped_mangrove_log");
        }
      }
      buildPortalGate(x1, y1, z1, postCoordsA[0], postCoordsA[1]);
      buildPortalGate(x2, y2, z2, postCoordsB[0], postCoordsB[1]);
    }

    const steps = Math.max(8, Math.ceil(Math.hypot(dx, y2 - y1, dz) * 2.4));
    let prevX = Math.round(x1);
    let prevY = Math.round(y1);
    let prevZ = Math.round(z1);

    const stampDeckSlice = (cx, cy, cz, t, isEnd, stepIdx, curPerpX, curPerpZ) => {
      for (let w = -halfW; w <= halfW; w++) {
        const wx = Math.round(cx + curPerpX * w);
        const wz = Math.round(cz + curPerpZ * w);
        const isEdge = Math.abs(w) === halfW;
        const isCenter = w === 0 && halfW >= 2;
        const deckBlk = isEdge
          ? "minecraft:dark_oak_planks"
          : isCenter
            ? "minecraft:smooth_quartz"
            : "minecraft:mangrove_planks";
        pSet(wx, cy, wz, deckBlk);
        if (w === 0) {
          pSetIfEmpty(wx, cy - 1, wz, "minecraft:deepslate_bricks");
        }
      }
      if (!isEnd && t > 0.06 && t < 0.94) {
        for (const sgn of [-1, 1]) {
          const rx = Math.round(cx + curPerpX * (halfW + 1) * sgn);
          const rz = Math.round(cz + curPerpZ * (halfW + 1) * sgn);
          pSet(rx, cy, rz, "minecraft:dark_oak_slab", { type: "top" });
          if (stepIdx % 12 === 0) {
            pSetIfEmpty(rx, cy + 1, rz, "minecraft:stripped_mangrove_log");
            pSetIfEmpty(rx, cy + 2, rz, "minecraft:lantern", { hanging: "false" });
          } else {
            pSetIfEmpty(rx, cy + 1, rz, "minecraft:mangrove_fence");
          }
        }
      }
    };

    stampDeckSlice(prevX, prevY, prevZ, 0, true, 0, perpX, perpZ);
    let marchCount = 0;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const lat = Math.sin(t * Math.PI) * lateralCurve;
      const tx = Math.round(lerp(x1, x2, t) + perpX * lat);
      const ty = Math.round(lerp(y1, y2, t) + archHeight * 4 * t * (1 - t));
      const tz = Math.round(lerp(z1, z2, t) + perpZ * lat);
      const isEnd = i === steps;

      while (prevX !== tx || prevY !== ty || prevZ !== tz) {
        if (prevX !== tx) prevX += tx > prevX ? 1 : -1;
        else if (prevZ !== tz) prevZ += tz > prevZ ? 1 : -1;
        else if (prevY !== ty) prevY += ty > prevY ? 1 : -1;
        marchCount++;
        stampDeckSlice(prevX, prevY, prevZ, t, isEnd && prevX === tx && prevY === ty && prevZ === tz, marchCount, perpX, perpZ);
      }
    }

    // Lower Arch Rib & Spandrel Struts for steep drum bridges (clean silhouette, zero cable clash!)
    if (hasArchRib) {
      let rPrevX = Math.round(x1);
      let rPrevY = Math.round(y1 - 1);
      let rPrevZ = Math.round(z1);
      const ribDepth = 4.2;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const lat = Math.sin(t * Math.PI) * lateralCurve;
        const deckYAtT = Math.round(lerp(y1, y2, t) + archHeight * 4 * t * (1 - t));
        const rx = Math.round(lerp(x1, x2, t) + perpX * lat);
        const ry = Math.round(deckYAtT - 1 - ribDepth * 4 * t * (1 - t));
        const rz = Math.round(lerp(z1, z2, t) + perpZ * lat);

        while (rPrevX !== rx || rPrevY !== ry || rPrevZ !== rz) {
          if (rPrevX !== rx) rPrevX += rx > rPrevX ? 1 : -1;
          else if (rPrevZ !== rz) rPrevZ += rz > rPrevZ ? 1 : -1;
          else if (rPrevY !== ry) rPrevY += ry > rPrevY ? 1 : -1;
          pSet(rPrevX, rPrevY, rPrevZ, "minecraft:dark_oak_wood");
        }
        // Vertical spandrel post connecting rib to deck every ~14%
        if (i % Math.max(4, Math.floor(steps / 7)) === 0) {
          for (let sy = ry + 1; sy <= deckYAtT - 1; sy++) {
            pSetIfEmpty(rx, sy, rz, "minecraft:stripped_mangrove_log");
          }
        }
      }
    }

    // Light suspension catenary rails ONLY for gentle near-horizontal spans (Zero T-Chain!)
    if (isSuspension && hasTowers) {
      for (let pi = 0; pi < 2; pi++) {
        const ax = postCoordsA[pi][0];
        const az = postCoordsA[pi][1];
        const bx = postCoordsB[pi][0];
        const bz = postCoordsB[pi][1];
        const cableSag = Math.max(2.0, horizLen * 0.055);

        let cPrevX = ax;
        let cPrevY = y1 + 4;
        let cPrevZ = az;
        const cSteps = Math.max(8, Math.ceil(horizLen * 2));
        for (let i = 1; i <= cSteps; i++) {
          const t = i / cSteps;
          const lat = Math.sin(t * Math.PI) * lateralCurve;
          const cx = Math.round(lerp(ax, bx, t) + perpX * lat);
          const cy = Math.round(lerp(y1 + 4, y2 + 4, t) - cableSag * 4 * t * (1 - t));
          const cz = Math.round(lerp(az, bz, t) + perpZ * lat);
          const isEnd = i === cSteps;
          while (cPrevX !== cx || cPrevY !== cy || cPrevZ !== cz) {
            if (cPrevX !== cx) cPrevX += cx > cPrevX ? 1 : -1;
            else if (cPrevZ !== cz) cPrevZ += cz > cPrevZ ? 1 : -1;
            else if (cPrevY !== cy) cPrevY += cy > cPrevY ? 1 : -1;
            if (!(isEnd && cPrevX === cx && cPrevY === cy && cPrevZ === cz)) {
              pSet(cPrevX, cPrevY, cPrevZ, "minecraft:spruce_fence");
            }
          }
        }

        const hangerCount = Math.max(2, Math.floor(horizLen / 11));
        for (let h = 1; h < hangerCount; h++) {
          const ht = h / hangerCount;
          const lat = Math.sin(ht * Math.PI) * lateralCurve;
          const hx = Math.round(lerp(ax, bx, ht) + perpX * lat);
          const hz = Math.round(lerp(az, bz, ht) + perpZ * lat);
          const cableY = Math.round(lerp(y1 + 4, y2 + 4, ht) - cableSag * 4 * ht * (1 - ht));
          const deckYAtT = Math.round(lerp(y1, y2, ht) + archHeight * 4 * ht * (1 - ht));
          if (cableY > deckYAtT + 2) {
            pSet(hx, cableY, hz, "minecraft:dark_oak_planks");
            for (let cy = cableY - 1; cy >= deckYAtT + 2; cy--) {
              if (!world.getVoxel(hx, cy, hz)) {
                pSet(hx, cy, hz, "minecraft:iron_chain", { axis: "y" });
              }
            }
            pSetIfEmpty(hx, deckYAtT + 1, hz, "minecraft:mangrove_fence");
          }
        }
      }
    }
  }

  // Bridge 0 -> 1: Sea Gate West Reef Terrace -> Rock Islet (88, 39, 186) -> Island 1
  buildSteppingIslet(88, 39, 186, 4.2, false);
  buildAerialBridge([102, 22, 182], [91, 40, 186], 2.5, { width: 3, archRib: true, lateralCurve: 2.0, towers: false });
  buildAerialBridge([88, 40, 182], [93, 57, 174], 3.0, { width: 3, archRib: true, lateralCurve: -3.0 });

  // Bridge 1 -> 2: Split via Mossy Stepping Islet (64, 77, 136) w/ Lower Arch Ribs
  buildSteppingIslet(64, 77, 136, 4.2, false);
  buildAerialBridge([78, 57, 158], [67, 78, 139], 3.0, { width: 3, archRib: true, lateralCurve: -3.5 });
  buildAerialBridge([64, 78, 132], [64, 97, 114], 3.0, { width: 3, archRib: true, lateralCurve: -3.0 });

  // Bridge 2 -> 3: Gentle Suspension Bridges via Mid-Sky Azumaya Crag Islet (121, 115, 76)
  buildSteppingIslet(121, 115, 76, 5.4, true);
  buildAerialBridge([80, 97, 94], [115, 116, 76], 3.5, { width: 3, suspension: true, lateralCurve: -3.5 });
  buildAerialBridge([127, 116, 76], [162, 129, 76], 3.5, { width: 3, suspension: true, lateralCurve: -3.5 });

  // Bridge 3 -> 4: Island 3 -> Island 4 Arch-Rib Drum Bridge
  buildAerialBridge([182, 129, 92], [188, 153, 142], 4.0, { width: 3, archRib: true, lateralCurve: 5.0 });

  // Bridge 4 -> 5: Split via Floating Lantern Islet (155, 169, 142) -> Zenith Palace (118, 183, 125)
  buildSteppingIslet(155, 169, 142, 4.2, false);
  buildAerialBridge([174, 153, 152], [158, 170, 144], 2.5, { width: 3, archRib: true, lateralCurve: 2.5 });
  buildAerialBridge([152, 170, 139], [118, 183, 125], 3.5, { width: 3, archRib: true, lateralCurve: 4.5 });

  // --------------------------------------------------------------------------
  // 2. Tapered Ethereal Shan-Shui Clouds w/ Flowing Tails & Internal Sea-Lantern Glow
  // --------------------------------------------------------------------------
  function buildAnchoredCloudBand(isl, yOffset, rxPad, rzPad, arcStart, arcEnd, lobeCountOverride) {
    const cy = isl.deckY + yOffset;
    const minX = Math.max(MB_SAFE.minX, isl.x - isl.rx - rxPad - 8);
    const maxX = Math.min(MB_SAFE.maxX, isl.x + isl.rx + rxPad + 8);
    const minY = Math.max(MB_SAFE.minY, cy - 5);
    const maxY = Math.min(MB_SAFE.maxY, cy + 5);
    const minZ = Math.max(MB_SAFE.minZ, isl.z - isl.rz - rzPad - 8);
    const maxZ = Math.min(MB_SAFE.maxZ, isl.z + isl.rz + rzPad + 8);

    const lobes = [];
    const lobeCount = lobeCountOverride || 7;
    for (let i = 0; i < lobeCount; i++) {
      const u = lobeCount === 1 ? 0.5 : i / (lobeCount - 1);
      const ang = lerp(arcStart, arcEnd, u);
      const radX = isl.rx * 0.72 + rxPad * (0.5 + 0.4 * Math.sin(u * Math.PI));
      const radZ = isl.rz * 0.72 + rzPad * (0.5 + 0.4 * Math.sin(u * Math.PI));
      lobes.push({
        lx: isl.x + Math.cos(ang) * radX,
        ly: cy + Math.sin(u * Math.PI * 2) * 1.4,
        lz: isl.z + Math.sin(ang) * radZ,
        rx: 8.2 + 3.0 * Math.sin(u * Math.PI),
        ry: 2.9 + 1.0 * Math.sin(u * Math.PI),
        rz: 8.2 + 3.0 * Math.sin(u * Math.PI),
      });
    }
    // Add slender wispy flowing cloud tails at both ends
    for (const tailAng of [arcStart - 0.34, arcEnd + 0.34]) {
      const radX = isl.rx * 0.85 + rxPad * 0.75;
      const radZ = isl.rz * 0.85 + rzPad * 0.75;
      lobes.push({
        lx: isl.x + Math.cos(tailAng) * radX,
        ly: cy + 0.5,
        lz: isl.z + Math.sin(tailAng) * radZ,
        rx: 6.5,
        ry: 1.5,
        rz: 6.5,
      });
    }

    buildHollowVolumeShell(
      { minX, maxX, minY, maxY, minZ, maxZ },
      (wx, wy, wz) => {
        for (let i = 0; i < lobes.length; i++) {
          const lb = lobes[i];
          const horizD = Math.hypot((wx - lb.lx) / lb.rx, (wz - lb.lz) / lb.rz);
          if (horizD > 1.15) continue;
          // Force crisp 2 -> 1 block tapered outer cloud rims (eliminates vertical glass wall!)
          if (horizD > 0.72) {
            const maxAllowDy = horizD > 0.84 ? 0 : 1;
            if (Math.abs(wy - Math.round(lb.ly)) > maxAllowDy) continue;
          }
          const effRy = lb.ry * Math.max(0.22, 1.0 - Math.pow(Math.min(1.0, horizD), 1.55));
          const dyNorm = Math.abs(wy - lb.ly) / effRy;
          const d3 = Math.hypot(horizD, dyNorm);
          if (d3 <= 1.0 + 0.14 * fbm3D(wx * 0.14, wy * 0.14, wz * 0.14, 2)) return true;
        }
        return false;
      },
      null,
      (wx, wy, wz, info) => {
        if (world.getVoxel(wx, wy, wz)) return;
        // 3D radial & vertical shading (white outer/top highlights -> light_blue body -> cyan underside shadow)
        let minHoriz = 1.0;
        let relDy = 0;
        for (let i = 0; i < lobes.length; i++) {
          const lb = lobes[i];
          const hd = Math.hypot((wx - lb.lx) / lb.rx, (wz - lb.lz) / lb.rz);
          if (hd < minHoriz) {
            minHoriz = hd;
            relDy = (wy - lb.ly) / lb.ry;
          }
        }
        let blk;
        if (info.airAbove || minHoriz > 0.76 || relDy > 0.32) {
          blk = "minecraft:white_stained_glass";
        } else if (relDy < -0.35 && !info.airAbove) {
          blk = "minecraft:cyan_stained_glass";
        } else {
          blk = "minecraft:light_blue_stained_glass";
        }
        fSet(wx, wy, wz, blk);
      },
      { shellRadius: 1 }
    );

    // Internal sea_lantern cloud glow cores connected directly onto rock tether (0 floating!)
    const midLobe = lobes[Math.floor(lobeCount / 2)];
    const mlx = Math.round(midLobe.lx);
    const mly = Math.round(midLobe.ly);
    const mlz = Math.round(midLobe.lz);
    drawStrut(mlx - 2, mly, mlz, mlx + 2, mly, mlz, (x) =>
      Math.abs(x - mlx) === 2 || x === mlx ? "minecraft:sea_lantern" : "minecraft:light_blue_stained_glass",
      0, { fast: true }
    );
    drawStrut(
      mlx, mly, mlz,
      isl.x, isl.deckY - 6, isl.z,
      "minecraft:light_blue_stained_glass", 0, { fast: true, onlyIfEmpty: true }
    );
  }

  buildAnchoredCloudBand(ISLANDS.suigetsuro, -12, 8, 8, 0.4, 2.9, 7);
  buildAnchoredCloudBand(ISLANDS.soha_pagoda, -14, 9, 9, 1.3, 4.1, 7);
  buildAnchoredCloudBand(ISLANDS.suiran_pavilion, -12, 8, 8, -0.5, 2.1, 7);
  buildAnchoredCloudBand(ISLANDS.ryumi_observatory, -11, 6, 6, 0.85, 2.6, 4);
  buildAnchoredCloudBand(ISLANDS.zenith_palace, -10, 10, 9, 2.15, 3.65, 5);
  buildAnchoredCloudBand(ISLANDS.zenith_palace, -13, 10, 9, -0.55, 0.85, 5);

  // --------------------------------------------------------------------------
  // 3. Luminous Springhead Waterfalls w/ Spreading Spray & Whitewater Splash Mounds
  // --------------------------------------------------------------------------
  function buildIslandWaterfall(lipX, lipY, lipZ, outDx, outDz, dropLen) {
    const dirLen = Math.max(1, Math.hypot(outDx, outDz));
    const nx = outDx / dirLen;
    const nz = outDz / dirLen;
    const px = -nz;
    const pz = nx;

    // Luminous springhead lip (sea_lantern + blue_ice + prismarine_bricks)
    for (let w = -1; w <= 1; w++) {
      pSet(lipX + px * w, lipY, lipZ + pz * w, w === 0 ? "minecraft:blue_ice" : "minecraft:prismarine_bricks");
      pSet(lipX + px * w - nx, lipY, lipZ + pz * w - nz, w === 0 ? "minecraft:sea_lantern" : "minecraft:prismarine_bricks");
      pSet(lipX + px * w, lipY - 1, lipZ + pz * w, "minecraft:dark_prismarine");
    }

    let curX = lipX;
    let curY = lipY;
    let curZ = lipZ;
    for (let step = 0; step < dropLen; step++) {
      const t = step / dropLen;
      const outPush = step < 4 ? step * 0.65 : 2.6 + Math.sin(t * Math.PI * 2.5) * 0.45;
      const targetX = Math.round(lipX + nx * outPush);
      const targetZ = Math.round(lipZ + nz * outPush);
      const targetY = lipY - step;

      while (curX !== targetX || curZ !== targetZ || curY !== targetY) {
        if (curX !== targetX) curX += targetX > curX ? 1 : -1;
        else if (curZ !== targetZ) curZ += targetZ > curZ ? 1 : -1;
        else if (curY !== targetY) curY += targetY > curY ? 1 : -1;

        const coreBlk = t > 0.72 ? "minecraft:white_stained_glass" : t < 0.2 ? "minecraft:blue_ice" : "minecraft:light_blue_stained_glass";
        pSetIfEmpty(curX, curY, curZ, coreBlk);
        for (const sgn of [-1, 1]) {
          const sx = Math.round(curX + px * sgn);
          const sz = Math.round(curZ + pz * sgn);
          if (Math.abs(sx - curX) + Math.abs(sz - curZ) === 1) {
            pSetIfEmpty(sx, curY, sz, t > 0.55 || sgn === -1 ? "minecraft:white_stained_glass" : "minecraft:cyan_stained_glass");
          }
        }
      }
    }

    // Billowing Whitewater Splash Mound (R=3.8, H=2-3) where waterfall crashes into cloud bank
    for (let dx = -4; dx <= 4; dx++) {
      for (let dz = -4; dz <= 4; dz++) {
        const d = Math.hypot(dx, dz);
        if (d > 3.8) continue;
        const h = d < 1.3 ? 3 : d < 2.6 ? 2 : 1;
        for (let dy = 0; dy < h; dy++) {
          const blk = dy === 0 && d < 1.2
            ? "minecraft:sea_lantern"
            : dy === h - 1
              ? "minecraft:white_stained_glass"
              : "minecraft:light_blue_stained_glass";
          pSetIfEmpty(curX + dx, curY + dy, curZ + dz, blk);
        }
      }
    }
  }

  buildIslandWaterfall(ISLANDS.suigetsuro.x - 13, ISLANDS.suigetsuro.deckY, ISLANDS.suigetsuro.z + 7, -1, 0.5, 14);
  buildIslandWaterfall(ISLANDS.soha_pagoda.x + 11, ISLANDS.soha_pagoda.deckY, ISLANDS.soha_pagoda.z + 9, 0.8, 0.6, 15);
  buildIslandWaterfall(ISLANDS.suiran_pavilion.x + 11, ISLANDS.suiran_pavilion.deckY, ISLANDS.suiran_pavilion.z + 10, 0.7, 0.7, 13);
  buildIslandWaterfall(ISLANDS.ryumi_observatory.x - 9, ISLANDS.ryumi_observatory.deckY, ISLANDS.ryumi_observatory.z + 11, -0.5, 0.8, 12);
  buildIslandWaterfall(ISLANDS.zenith_palace.x - 19, ISLANDS.zenith_palace.deckY, ISLANDS.zenith_palace.z + 5, -1, 0.3, 13);
  buildIslandWaterfall(ISLANDS.zenith_palace.x + 19, ISLANDS.zenith_palace.deckY, ISLANDS.zenith_palace.z + 4, 1, 0.2, 14);

  // --------------------------------------------------------------------------
  // 4. Stylized Pine & Weeping Cherry Trees, Hanging Vines & Cliff Glow-Lichen
  // --------------------------------------------------------------------------
  buildStylizedTree(ISLANDS.suigetsuro.x - 13, ISLANDS.suigetsuro.deckY + 1, ISLANDS.suigetsuro.z - 8, "cherry", 1.0);
  buildStylizedTree(ISLANDS.suigetsuro.x + 9, ISLANDS.suigetsuro.deckY + 1, ISLANDS.suigetsuro.z - 11, "pine", 0.95);
  buildStylizedTree(ISLANDS.suigetsuro.x - 13, ISLANDS.suigetsuro.deckY + 1, ISLANDS.suigetsuro.z + 9, "pine", 0.85);
  buildStylizedTree(ISLANDS.soha_pagoda.x - 12, ISLANDS.soha_pagoda.deckY + 1, ISLANDS.soha_pagoda.z + 9, "pine", 1.0);
  buildStylizedTree(ISLANDS.soha_pagoda.x + 11, ISLANDS.soha_pagoda.deckY + 1, ISLANDS.soha_pagoda.z - 10, "cherry", 0.95);
  buildStylizedTree(ISLANDS.soha_pagoda.x - 11, ISLANDS.soha_pagoda.deckY + 1, ISLANDS.soha_pagoda.z - 10, "cherry", 0.9);
  buildStylizedTree(ISLANDS.suiran_pavilion.x + 11, ISLANDS.suiran_pavilion.deckY + 1, ISLANDS.suiran_pavilion.z - 10, "cherry", 0.95);
  buildStylizedTree(ISLANDS.suiran_pavilion.x - 13, ISLANDS.suiran_pavilion.deckY + 1, ISLANDS.suiran_pavilion.z - 9, "pine", 0.9);
  buildStylizedTree(ISLANDS.ryumi_observatory.x + 10, ISLANDS.ryumi_observatory.deckY + 1, ISLANDS.ryumi_observatory.z - 9, "pine", 0.9);
  buildStylizedTree(ISLANDS.ryumi_observatory.x - 11, ISLANDS.ryumi_observatory.deckY + 1, ISLANDS.ryumi_observatory.z - 8, "cherry", 0.85);
  buildStylizedTree(ISLANDS.zenith_palace.x - 16, ISLANDS.zenith_palace.deckY + 1, ISLANDS.zenith_palace.z - 12, "cherry", 1.1);
  buildStylizedTree(ISLANDS.zenith_palace.x + 16, ISLANDS.zenith_palace.deckY + 1, ISLANDS.zenith_palace.z - 12, "cherry", 1.1);

  const allIslands = [
    ISLANDS.suigetsuro,
    ISLANDS.soha_pagoda,
    ISLANDS.suiran_pavilion,
    ISLANDS.ryumi_observatory,
    ISLANDS.zenith_palace,
  ];
  for (let ii = 0; ii < allIslands.length; ii++) {
    const isl = allIslands[ii];
    for (let k = 0; k < 28; k++) {
      const ang = (k / 28) * Math.PI * 2 + ii * 0.4;
      const vx = Math.round(isl.x + Math.cos(ang) * (isl.rx - 1));
      const vz = Math.round(isl.z + Math.sin(ang) * (isl.rz - 1));
      const drop = 4 + (k % 8);
      placeHangingVineSafe(vx, isl.deckY - 1, vz, drop);

      // Subtle glow_lichen accents on shaded lower cliff recesses
      if (k % 3 === 0) {
        const lx = Math.round(isl.x + Math.cos(ang) * (isl.rx * 0.65));
        const lz = Math.round(isl.z + Math.sin(ang) * (isl.rz * 0.65));
        for (let ly = isl.deckY - 5; ly >= isl.bottomY + 4; ly -= 4) {
          placeGlowLichenSafe(lx, ly, lz);
        }
      }
    }
  }

  // Hanging vines under the 4 mid-sky stepping islets
  const isletRoots = [
    [88, 39, 186, 4],
    [64, 77, 136, 4],
    [121, 115, 76, 5],
    [155, 169, 142, 4],
  ];
  for (let i = 0; i < isletRoots.length; i++) {
    const [ix, iy, iz, rad] = isletRoots[i];
    for (let k = 0; k < 8; k++) {
      const ang = (k / 8) * Math.PI * 2;
      placeHangingVineSafe(Math.round(ix + Math.cos(ang) * rad), iy - 1, Math.round(iz + Math.sin(ang) * rad), 4 + (k % 4));
    }
  }
})();

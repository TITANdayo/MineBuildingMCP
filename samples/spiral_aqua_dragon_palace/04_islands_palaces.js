// ============================================================================
// 04_islands_palaces.js — Hero #2: 4-Tier Spiral Floating Islands & Zenith Palace
// Loop 3: Lattice Windows w/ Warm Backlight, 2-Tier Dougong, Upper Balconies,
//         3D Chidori-Hafu, Double-Roof Octagon, Kakezukuri Observatory Stage
// ============================================================================

(function buildIslandsAndPalaces() {
  function buildPlinth(cx, deckY, cz, halfW, halfD, opts) {
    const stairDir = (opts && opts.stairDir) || null;
    for (let dx = -halfW - 1; dx <= halfW + 1; dx++) {
      for (let dz = -halfD - 1; dz <= halfD + 1; dz++) {
        const ax = Math.abs(dx);
        const az = Math.abs(dz);
        const isTier1Edge = ax === halfW + 1 || az === halfD + 1;
        const isTier2Edge = ax === halfW || az === halfD;
        const wx = cx + dx;
        const wz = cz + dz;

        pSet(wx, deckY + 1, wz, isTier1Edge ? "minecraft:deepslate_bricks" : "minecraft:stone_bricks");
        if (!isTier1Edge) {
          let floorBlk;
          if (isTier2Edge) {
            floorBlk = "minecraft:polished_deepslate";
          } else if (ax <= 1 || az <= 1) {
            floorBlk = "minecraft:stone_bricks";
          } else if (ax % 4 === 0 || az % 4 === 0) {
            floorBlk = "minecraft:calcite";
          } else {
            floorBlk = "minecraft:smooth_quartz";
          }
          pSet(wx, deckY + 2, wz, floorBlk);
        }
        if (isTier1Edge && (ax + az) % 2 === 0 && !(stairDir === "south" && dz > 0 && ax <= 2)) {
          pSet(wx, deckY + 2, wz, (ax === halfW + 1 && az === halfD + 1) ? "minecraft:deepslate_brick_wall" : "minecraft:mangrove_fence");
        }
      }
    }
    if (stairDir === "south") {
      for (let dx = -2; dx <= 2; dx++) {
        pSet(cx + dx, deckY + 1, cz + halfD + 2, "minecraft:deepslate_brick_stairs", { facing: "north", half: "bottom" });
        pSet(cx + dx, deckY + 2, cz + halfD + 1, "minecraft:deepslate_brick_stairs", { facing: "north", half: "bottom" });
      }
      // Ascending stone balustrade newel posts & lanterns flanking south stairs
      for (const sgn of [-1, 1]) {
        const sx = cx + sgn * 3;
        pSet(sx, deckY + 1, cz + halfD + 2, "minecraft:deepslate_bricks");
        pSet(sx, deckY + 2, cz + halfD + 2, "minecraft:deepslate_brick_wall");
        pSet(sx, deckY + 3, cz + halfD + 1, "minecraft:deepslate_brick_wall");
        pSet(sx, deckY + 4, cz + halfD + 1, "minecraft:lantern", { hanging: "false" });
      }
    }
  }

  // Reusable 3-Layer Depth East Asian Hall (Vermilion Renji Lattice + Warm Shoji + 2-Tier Dougong + Balcony)
  function buildLayeredHall(cx, floorY, cz, halfW, halfD, wallH, opts) {
    const bayStep = (opts && opts.bayStep) || 4;
    const openFront = Boolean(opts && opts.openFront);
    const openAll = Boolean(opts && opts.openAll);
    const hasBalcony = Boolean(opts && opts.balcony);

    // Solid floor & ceiling plate
    for (let dx = -halfW + 1; dx <= halfW - 1; dx++) {
      for (let dz = -halfD + 1; dz <= halfD - 1; dz++) {
        pSet(cx + dx, floorY, cz + dz, "minecraft:dark_oak_planks");
        pSet(cx + dx, floorY + wallH, cz + dz, "minecraft:dark_oak_planks");
      }
    }

    // Optional Wraparound Upper Veranda (bW = halfW + 2 clears all pillar buttresses cleanly!)
    if (hasBalcony) {
      const bW = halfW + 2;
      const bD = halfD + 2;
      for (let dx = -bW; dx <= bW; dx++) {
        for (let dz = -bD; dz <= bD; dz++) {
          const ax = Math.abs(dx);
          const az = Math.abs(dz);
          if (ax <= halfW && az <= halfD) continue;
          const isOuter = ax === bW || az === bD;
          const isBCorner = ax === bW && az === bD;
          pSetIfEmpty(cx + dx, floorY, cz + dz, "minecraft:dark_oak_slab", { type: "top" });
          if (isOuter) {
            if (isBCorner) {
              pSet(cx + dx, floorY + 1, cz + dz, "minecraft:stripped_mangrove_log");
              pSet(cx + dx, floorY + 2, cz + dz, "minecraft:lantern", { hanging: "false" });
            } else {
              pSetIfEmpty(cx + dx, floorY + 1, cz + dz, "minecraft:mangrove_fence");
            }
          }
        }
      }
    }

    for (let dx = -halfW; dx <= halfW; dx++) {
      for (let dz = -halfD; dz <= halfD; dz++) {
        const ax = Math.abs(dx);
        const az = Math.abs(dz);
        const onXWall = ax === halfW;
        const onZWall = az === halfD;
        if (!onXWall && !onZWall) continue;

        const wx = cx + dx;
        const wz = cz + dz;
        const isCorner = onXWall && onZWall;
        const isBayPillar =
          isCorner ||
          (onZWall && ax % bayStep === 0) ||
          (onXWall && az % bayStep === 0);

        const isFrontDoor = openFront && dz === halfD && ax <= 2;
        const isWindowBay = !isBayPillar && !isFrontDoor && !openAll;

        const outX = onXWall ? (dx > 0 ? 1 : -1) : 0;
        const outZ = onZWall ? (dz > 0 ? 1 : -1) : 0;
        const inX = wx - outX;
        const inZ = wz - outZ;
        const outFacing = outX > 0 ? "west" : outX < 0 ? "east" : outZ > 0 ? "north" : "south";

        for (let dy = 0; dy < wallH; dy++) {
          const wy = floorY + dy;
          if (isBayPillar) {
            pSet(wx, wy, wz, "minecraft:stripped_mangrove_log");
            const buttressBlk = dy === 0 ? "minecraft:deepslate_bricks" : "minecraft:stripped_mangrove_log";
            if (isCorner) {
              pSet(wx + outX, wy, wz, buttressBlk);
              pSet(wx, wy, wz + outZ, buttressBlk);
              if (dy === wallH - 1) {
                pSet(wx + outX, wy + 1, wz, "minecraft:mangrove_stairs", { facing: outX > 0 ? "west" : "east", half: "top" });
                pSet(wx, wy + 1, wz + outZ, "minecraft:mangrove_stairs", { facing: outZ > 0 ? "north" : "south", half: "top" });
              }
            } else {
              pSet(wx + outX, wy, wz + outZ, buttressBlk);
              // 2-tier Dougong bracket on bay pillars
              if (dy === wallH - 2) {
                pSetIfEmpty(wx + outX * 2, wy, wz + outZ * 2, "minecraft:mangrove_stairs", { facing: outFacing, half: "top" });
              } else if (dy === wallH - 1) {
                pSet(wx + outX, wy + 1, wz + outZ, "minecraft:mangrove_planks");
                pSetIfEmpty(wx + outX * 2, wy, wz + outZ * 2, "minecraft:dark_oak_fence");
              }
            }
          } else if (isFrontDoor) {
            if (dy === wallH - 1) {
              pSet(wx, wy, wz, "minecraft:mangrove_planks");
              pSet(wx + outX, wy, wz + outZ, "minecraft:dark_oak_trapdoor", { half: "top" });
            } else if (dy === 0 && ax === 0) {
              pSet(wx - outX * 2, wy + 1, wz - outZ * 2, "minecraft:ochre_froglight");
            }
          } else if (openAll) {
            if (dy === wallH - 1) {
              pSet(wx, wy, wz, "minecraft:mangrove_planks");
            } else if (dy === 0) {
              pSet(wx, wy, wz, "minecraft:mangrove_fence");
            }
          } else if (isWindowBay) {
            if (dy === 0) {
              pSet(wx, wy, wz, "minecraft:deepslate_bricks");
              pSet(inX, wy, inZ, "minecraft:deepslate_bricks");
            } else if (dy === 1) {
              // Dark timber/slate window sill breaks up whitewash!
              pSet(wx, wy, wz, "minecraft:polished_deepslate");
              pSet(inX, wy, inZ, "minecraft:dark_oak_planks");
              pSet(inX - outX, wy, inZ - outZ, "minecraft:smooth_quartz");
            } else if (dy === wallH - 1) {
              pSet(wx, wy, wz, "minecraft:mangrove_planks");
              pSet(inX, wy, inZ, "minecraft:mangrove_planks");
              pSet(inX - outX, wy, inZ - outZ, "minecraft:smooth_quartz");
              pSet(wx + outX, wy, wz + outZ, "minecraft:mangrove_stairs", { facing: outFacing, half: "top" });
            } else {
              // Outer vermilion Renji lattice (mangrove_fence) + warm glowing Shoji 1 block deeper!
              pSet(wx, wy, wz, "minecraft:mangrove_fence");
              pSet(inX, wy, inZ, dy === 2 ? "minecraft:ochre_froglight" : "minecraft:shroomlight");
              pSet(inX - outX, wy, inZ - outZ, "minecraft:smooth_quartz");
            }
          }
        }
      }
    }
  }

  // Helper: 8-Sided Upturned Roof Builder (reused for Mokoshi skirt & Main Octagon Roof)
  function buildOctagonalRoof(px, pz, roofBaseY, octR, height, cornerLift, addFinial) {
    const octMap = new Map();
    const oKey = (dx, dz) => `${dx},${dz}`;
    for (let dx = -octR - 2; dx <= octR + 2; dx++) {
      for (let dz = -octR - 2; dz <= octR + 2; dz++) {
        const octD = Math.max(Math.abs(dx), Math.abs(dz), (Math.abs(dx) + Math.abs(dz)) * 0.7071);
        const maxR = octR + 2.2;
        if (octD > maxR) continue;
        const u = 1.0 - octD / maxR;
        const ang = Math.atan2(dz, dx);
        const ribMask = Math.abs(Math.sin((ang - Math.PI / 8) * 4));
        const cLift = (octD / maxR) > 0.7 ? (1.0 - ribMask) * cornerLift : 0;
        const ry = Math.round(roofBaseY + Math.pow(u, 1.35) * height + cLift);
        octMap.set(oKey(dx, dz), { ry, octD, maxR, u, ribMask });
      }
    }
    for (let dx = -octR - 2; dx <= octR + 2; dx++) {
      for (let dz = -octR - 2; dz <= octR + 2; dz++) {
        const c = octMap.get(oKey(dx, dz));
        if (!c) continue;
        let minNY = c.ry;
        const dirs4 = [[1,0],[-1,0],[0,1],[0,-1]];
        for (let d = 0; d < 4; d++) {
          const nb = octMap.get(oKey(dx + dirs4[d][0], dz + dirs4[d][1]));
          if (nb && nb.ry < minNY) minNY = nb.ry;
        }
        for (let fy = minNY; fy < c.ry; fy++) {
          pSet(px + dx, fy, pz + dz, "minecraft:dark_prismarine");
        }
        let blk = "minecraft:dark_prismarine";
        if (c.octD > c.maxR - 0.85 && c.ribMask < 0.14) {
          pSet(px + dx, c.ry, pz + dz, "minecraft:gold_block");
          pSet(px + dx, c.ry + 1, pz + dz, "minecraft:end_rod", { facing: "up" });
          continue;
        } else if (c.ribMask < 0.16) {
          blk = "minecraft:weathered_cut_copper";
        } else if (c.u > 0.35 && c.u < 0.78) {
          blk = "minecraft:oxidized_cut_copper";
        }
        pSet(px + dx, c.ry, pz + dz, blk);
      }
    }
    if (addFinial) {
      const topY = roofBaseY + Math.round(height);
      pSet(px, topY + 1, pz, "minecraft:oxidized_cut_copper");
      pSet(px, topY + 2, pz, "minecraft:gold_block");
      pSet(px, topY + 3, pz, "minecraft:ochre_froglight");
      pSet(px, topY + 4, pz, "minecraft:gold_block");
      pSet(px, topY + 5, pz, "minecraft:end_rod", { facing: "up" });
      pSet(px, topY + 6, pz, "minecraft:gold_block");
    }
  }

  // Reusable Warm Oriental Brazier (篝火台) for dramatic warm/cool contrast
  function buildWarmBrazier(bx, by, bz) {
    pSet(bx, by, bz, "minecraft:polished_deepslate");
    pSet(bx, by + 1, bz, "minecraft:ochre_froglight");
    pSet(bx, by + 2, bz, "minecraft:orange_stained_glass");
    pSet(bx, by + 3, bz, "minecraft:yellow_stained_glass");
  }

  // ==========================================================================
  // 1. Island 1: 水月楼島 (Suigetsuro) @ (78, 56, 174), R=17, bottomY=32
  // ==========================================================================
  {
    const isl = ISLANDS.suigetsuro;
    buildIslandBedrock(isl.x, isl.deckY, isl.z, isl.rx, isl.rz, isl.bottomY, { stalactites: 7 });
    buildPlinth(isl.x - 1, isl.deckY, isl.z - 1, 10, 8, { stairDir: null });

    buildLayeredHall(isl.x - 1, isl.deckY + 3, isl.z - 1, 9, 7, 5, { bayStep: 3, openFront: true });
    buildCurvedEastAsianRoof(isl.x - 1, isl.deckY + 8, isl.z - 1, 9, 7, 4.8, {
      overhang: 3,
      cornerLift: 2.4,
      chiwen: false,
      eaveLanterns: true,
    });

    buildLayeredHall(isl.x - 1, isl.deckY + 11, isl.z - 1, 6, 4, 5, { bayStep: 3, openFront: false, balcony: true });
    buildCurvedEastAsianRoof(isl.x - 1, isl.deckY + 16, isl.z - 1, 6, 4, 4.5, {
      overhang: 3,
      cornerLift: 2.7,
      chiwen: true,
      eaveLanterns: true,
    });

    for (let x = isl.x + 9; x <= isl.x + 17; x++) {
      for (let z = isl.z - 2; z <= isl.z + 2; z++) {
        const isEdge = Math.abs(z - isl.z) === 2 || x === isl.x + 17;
        pSet(x, isl.deckY + 1, z, isEdge ? "minecraft:dark_oak_planks" : "minecraft:mangrove_planks");
        if (isEdge && x < isl.x + 16 && x % 3 === 0) {
          pSet(x, isl.deckY + 2, z, "minecraft:mangrove_fence");
        }
      }
    }
    drawStrut(isl.x + 10, isl.deckY - 4, isl.z - 2, isl.x + 16, isl.deckY, isl.z - 2, "minecraft:dark_oak_wood", 0);
    drawStrut(isl.x + 10, isl.deckY - 4, isl.z + 2, isl.x + 16, isl.deckY, isl.z + 2, "minecraft:dark_oak_wood", 0);
  }

  // ==========================================================================
  // 2. Island 2: 蒼波宝塔島 (Soha 5-Tier Pagoda) @ (64, 96, 98), R=16, bottomY=68
  // ==========================================================================
  {
    const isl = ISLANDS.soha_pagoda;
    buildIslandBedrock(isl.x, isl.deckY, isl.z, isl.rx, isl.rz, isl.bottomY, { stalactites: 7 });
    buildPlinth(isl.x, isl.deckY, isl.z, 9, 9);

    const tiers = [
      { half: 7, h: 5, roofH: 3.8, y: isl.deckY + 3, balc: false },
      { half: 6, h: 5, roofH: 3.5, y: isl.deckY + 11, balc: true },
      { half: 5, h: 4, roofH: 3.2, y: isl.deckY + 19, balc: true },
      { half: 4, h: 4, roofH: 3.0, y: isl.deckY + 26, balc: true },
      { half: 3, h: 4, roofH: 3.2, y: isl.deckY + 33, balc: true },
    ];
    for (let t = 0; t < tiers.length; t++) {
      const tr = tiers[t];
      buildLayeredHall(isl.x, tr.y, isl.z, tr.half, tr.half, tr.h, {
        bayStep: Math.max(3, tr.half),
        openFront: t === 0,
        balcony: tr.balc,
      });
      buildCurvedEastAsianRoof(isl.x, tr.y + tr.h, isl.z, tr.half, tr.half, tr.roofH, {
        overhang: 3,
        cornerLift: 2.4,
        chiwen: false,
        eaveLanterns: t === 0 || t === 2 || t === 4,
      });
    }

    // Refined Golden Sorin Spire (相輪) w/ 9-Ring Profile & Sharp Tip
    const sorinBaseY = isl.deckY + 40;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        pSet(isl.x + dx, sorinBaseY, isl.z + dz, "minecraft:oxidized_cut_copper");
      }
    }
    for (let dy = 1; dy <= 10; dy++) {
      const sy = sorinBaseY + dy;
      const isRing = dy === 2 || dy === 4 || dy === 6;
      if (dy >= 8) {
        pSet(isl.x, sy, isl.z, dy === 10 ? "minecraft:gold_block" : "minecraft:end_rod", dy === 10 ? undefined : { facing: "up" });
      } else {
        pSet(isl.x, sy, isl.z, "minecraft:gold_block");
      }
      if (isRing) {
        pSet(isl.x + 1, sy, isl.z, "minecraft:oxidized_cut_copper_slab", { type: "bottom" });
        pSet(isl.x - 1, sy, isl.z, "minecraft:oxidized_cut_copper_slab", { type: "bottom" });
        pSet(isl.x, sy, isl.z + 1, "minecraft:oxidized_cut_copper_slab", { type: "bottom" });
        pSet(isl.x, sy, isl.z - 1, "minecraft:oxidized_cut_copper_slab", { type: "bottom" });
      }
    }
  }

  // ==========================================================================
  // 3. Island 3: 翠嵐八角亭島 (Double-Roof Octagon Pavilion & Bell Tower)
  // ==========================================================================
  {
    const isl = ISLANDS.suiran_pavilion;
    buildIslandBedrock(isl.x, isl.deckY, isl.z, isl.rx, isl.rz, isl.bottomY, { stalactites: 7 });

    const px = isl.x - 3;
    const pz = isl.z - 2;
    const octR = 8;

    for (let dx = -octR - 1; dx <= octR + 1; dx++) {
      for (let dz = -octR - 1; dz <= octR + 1; dz++) {
        const octD = Math.max(Math.abs(dx), Math.abs(dz), (Math.abs(dx) + Math.abs(dz)) * 0.7071);
        if (octD <= octR + 0.8) {
          pSet(px + dx, isl.deckY + 1, pz + dz, octD > octR - 0.3 ? "minecraft:deepslate_bricks" : "minecraft:stone_bricks");
        }
        if (octD <= octR - 0.5) {
          pSet(px + dx, isl.deckY + 2, pz + dz, octD > octR - 1.5 ? "minecraft:polished_deepslate" : "minecraft:smooth_quartz");
        }
      }
    }

    const pillAngles = [];
    for (let i = 0; i < 8; i++) {
      const ang = (i / 8) * Math.PI * 2 + Math.PI / 8;
      const vx = Math.round(px + Math.cos(ang) * (octR - 1.2));
      const vz = Math.round(pz + Math.sin(ang) * (octR - 1.2));
      pillAngles.push([vx, vz]);
      for (let y = isl.deckY + 3; y <= isl.deckY + 11; y++) {
        pSet(vx, y, vz, y === isl.deckY + 3 ? "minecraft:deepslate_bricks" : "minecraft:stripped_mangrove_log");
      }
    }
    for (let i = 0; i < 8; i++) {
      const [x1, z1] = pillAngles[i];
      const [x2, z2] = pillAngles[(i + 1) % 8];
      if (i !== 2) {
        drawStrut(x1, isl.deckY + 3, z1, x2, isl.deckY + 3, z2, "minecraft:mangrove_fence", 0);
      }
      drawStrut(x1, isl.deckY + 7, z1, x2, isl.deckY + 7, z2, "minecraft:mangrove_planks", 0);
      drawStrut(x1, isl.deckY + 11, z1, x2, isl.deckY + 11, z2, "minecraft:mangrove_planks", 0);
    }

    // Double-Tiered Octagonal Roof: Lower Mokoshi Skirt (deckY+7) + Upper Main Roof (deckY+11)
    buildOctagonalRoof(px, pz, isl.deckY + 7, octR + 1, 3.6, 1.8, false);
    // Clear inner core of lower roof so upper story stands proudly above it
    for (let dx = -octR + 2; dx <= octR - 2; dx++) {
      for (let dz = -octR + 2; dz <= octR - 2; dz++) {
        const octD = Math.max(Math.abs(dx), Math.abs(dz), (Math.abs(dx) + Math.abs(dz)) * 0.7071);
        if (octD <= octR - 2.2) {
          for (let y = isl.deckY + 8; y <= isl.deckY + 11; y++) {
            fClear(px + dx, y, pz + dz);
          }
        }
      }
    }
    buildOctagonalRoof(px, pz, isl.deckY + 11, octR - 1, 6.8, 2.4, true);

    drawStrut(pillAngles[0][0], isl.deckY + 11, pillAngles[0][1], pillAngles[4][0], isl.deckY + 11, pillAngles[4][1], "minecraft:dark_oak_planks", 0);
    drawStrut(pillAngles[2][0], isl.deckY + 11, pillAngles[2][1], pillAngles[6][0], isl.deckY + 11, pillAngles[6][1], "minecraft:dark_oak_planks", 0);
    pSet(px, isl.deckY + 11, pz, "minecraft:dark_oak_planks");
    hangLanternChain(px, isl.deckY + 11, pz, 2, "minecraft:lantern", "minecraft:iron_chain");

    // Vermilion Bell Tower
    const bx = isl.x + 8;
    const bz = isl.z + 8;
    buildPlinth(bx, isl.deckY, bz, 3, 3);
    buildLayeredHall(bx, isl.deckY + 3, bz, 2, 2, 6, { bayStep: 4, openAll: true });
    buildCurvedEastAsianRoof(bx, isl.deckY + 9, bz, 2, 2, 3.6, {
      overhang: 2,
      cornerLift: 2.0,
      chiwen: false,
    });
    pSet(bx, isl.deckY + 9, bz, "minecraft:dark_oak_planks");
    pSet(bx, isl.deckY + 8, bz, "minecraft:iron_chain", { axis: "y" });
    pSet(bx, isl.deckY + 7, bz, "minecraft:gold_block");
    pSet(bx, isl.deckY + 6, bz, "minecraft:oxidized_cut_copper");

    drawStrut(px + 5, isl.deckY + 2, pz + 5, bx - 2, isl.deckY + 2, bz - 2, "minecraft:mangrove_planks", 1, { fast: true });
    drawStrut(px + 5, isl.deckY + 7, pz + 5, bx - 2, isl.deckY + 7, bz - 2, "minecraft:dark_prismarine", 1, { fast: true });
  }

  // ==========================================================================
  // 4. Island 4: 龍見展望島 (L-Corridors + Kakezukuri Dragon Stage, Y <= 170!)
  // ==========================================================================
  {
    const isl = ISLANDS.ryumi_observatory;
    buildIslandBedrock(isl.x, isl.deckY, isl.z, isl.rx, isl.rz, isl.bottomY, { stalactites: 6 });
    buildPlinth(isl.x, isl.deckY, isl.z, 10, 10);

    // Central Main Pavilion (low profile: top <= Y=169)
    const px = isl.x + 3;
    const pz = isl.z + 3;
    buildLayeredHall(px, isl.deckY + 3, pz, 5, 3, 4, { bayStep: 5, openAll: true });
    buildCurvedEastAsianRoof(px, isl.deckY + 7, pz, 5, 3, 3.4, {
      overhang: 2,
      cornerLift: 1.9,
      chiwen: false,
      eaveLanterns: true,
    });

    // L-Shaped Open Vermilion Corridors flanking NW & SW (Y = 155..164)
    // Wing A (North-West corridor along X = isl.x - 8 .. isl.x - 2, Z = isl.z + 3)
    buildLayeredHall(isl.x - 6, isl.deckY + 3, isl.z + 3, 3, 2, 4, { bayStep: 3, openAll: true });
    buildCurvedEastAsianRoof(isl.x - 6, isl.deckY + 7, isl.z + 3, 3, 2, 2.5, { overhang: 2, cornerLift: 1.4, chiwen: false });

    // Wing B (North-East corridor along X = isl.x + 3, Z = isl.z - 8 .. isl.z - 2)
    buildLayeredHall(isl.x + 3, isl.deckY + 3, isl.z - 6, 2, 3, 4, { bayStep: 3, openAll: true });
    buildCurvedEastAsianRoof(isl.x + 3, isl.deckY + 7, isl.z - 6, 2, 3, 2.5, { overhang: 2, cornerLift: 1.4, chiwen: false });

    // Cantilevered Kakezukuri Dragon-Viewing Stage jutting South-West/South (X=175..185, Z=162..170)
    const stX = isl.x - 6;
    const stZ = isl.z + 12;
    for (let dx = -4; dx <= 4; dx++) {
      for (let dz = -3; dz <= 3; dz++) {
        const isEdge = Math.abs(dx) === 4 || dz === 3;
        pSet(stX + dx, isl.deckY + 2, stZ + dz, isEdge ? "minecraft:dark_oak_planks" : "minecraft:mangrove_planks");
        if (isEdge) {
          if (Math.abs(dx) === 4 && dz === 3) {
            pSet(stX + dx, isl.deckY + 3, stZ + dz, "minecraft:stripped_mangrove_log");
            pSet(stX + dx, isl.deckY + 4, stZ + dz, "minecraft:lantern", { hanging: "false" });
          } else {
            pSet(stX + dx, isl.deckY + 3, stZ + dz, "minecraft:mangrove_fence");
          }
        }
      }
    }
    // Kakezukuri diagonal wooden support struts anchored back into island cliff
    for (const dx of [-3, 0, 3]) {
      drawStrut(stX + dx, isl.deckY - 6, stZ - 5, stX + dx, isl.deckY + 1, stZ + 2, "minecraft:dark_oak_wood", 0);
      drawStrut(stX + dx, isl.deckY - 2, stZ - 4, stX + dx, isl.deckY + 1, stZ + 2, "minecraft:dark_oak_wood", 0);
    }
    // Twin Dragon-Prayer Sacred Brazier at center of viewing stage
    pSet(stX, isl.deckY + 3, stZ, "minecraft:polished_deepslate");
    pSet(stX, isl.deckY + 4, stZ, "minecraft:gold_block");
    pSet(stX, isl.deckY + 5, stZ, "minecraft:sea_lantern");

    // Warm Braziers flanking Dragon-Prayer Viewing Stage
    buildWarmBrazier(stX - 3, isl.deckY + 3, stZ + 1);
    buildWarmBrazier(stX + 3, isl.deckY + 3, stZ + 1);

    buildStoneLantern(isl.x - 8, isl.deckY + 3, isl.z - 8, false);
    buildStoneLantern(isl.x - 8, isl.deckY + 3, isl.z + 8, false);
    buildStoneLantern(isl.x + 8, isl.deckY + 3, isl.z - 8, false);
  }

  // ==========================================================================
  // 5. Island 5: 天頂竜宮大本殿 (Zenith Dragon Grand Palace)
  // ==========================================================================
  {
    const isl = ISLANDS.zenith_palace;
    buildIslandBedrock(isl.x, isl.deckY, isl.z, isl.rx, isl.rz, isl.bottomY, { stalactites: 9 });
    buildPlinth(isl.x, isl.deckY, isl.z, 18, 14, { stairDir: "south" });

    // Lower Main Grand Hall
    buildLayeredHall(isl.x, isl.deckY + 3, isl.z, 13, 9, 7, { bayStep: 4, openFront: true });

    // Lower Grand Eave Roof
    buildCurvedEastAsianRoof(isl.x, isl.deckY + 10, isl.z, 13, 9, 5.6, {
      ridgeAlongX: true,
      overhang: 3,
      cornerLift: 3.0,
      chiwen: false,
      eaveLanterns: true,
    });

    // Upper Story Hall w/ Wraparound Balcony & Vermilion Balustrade!
    buildLayeredHall(isl.x, isl.deckY + 16, isl.z, 9, 5, 5, { bayStep: 3, openFront: false, balcony: true });

    // Upper Grand Irimoya Roof w/ 4-block Golden Chiwen
    buildCurvedEastAsianRoof(isl.x, isl.deckY + 21, isl.z, 9, 5, 8.2, {
      ridgeAlongX: true,
      overhang: 4,
      cornerLift: 3.6,
      chiwen: true,
      eaveLanterns: true,
    });

    // 3D Integrated Chidori-Hafu (立体千鳥破風) penetrating back into Upper Roof + Gekyo Ornament
    for (let z = isl.z + 1; z <= isl.z + 8; z++) {
      const isFrontFace = z === isl.z + 7;
      const isBargeboard = z === isl.z + 8;
      for (let dx = -4; dx <= 4; dx++) {
        const h = 4 - Math.floor(Math.abs(dx) * 0.85);
        for (let dy = 0; dy <= h; dy++) {
          const isEdge = dy === h;
          if (isBargeboard && !isEdge) continue;
          if (isBargeboard) {
            if (Math.abs(dx) === 0) {
              pSet(isl.x, isl.deckY + 23 + h, z, "minecraft:gold_block");
            } else {
              pSet(isl.x + dx, isl.deckY + 23 + h, z, "minecraft:dark_prismarine_stairs", {
                facing: dx < 0 ? "east" : "west",
                half: "bottom",
              });
            }
          } else if (isFrontFace) {
            const isTimber = !isEdge && (dx === 0 || dy === 1);
            const blk = isEdge
              ? "minecraft:oxidized_cut_copper"
              : isTimber
                ? "minecraft:mangrove_fence"
                : "minecraft:smooth_quartz";
            pSet(isl.x + dx, isl.deckY + 23 + dy, z, blk);
          } else if (isEdge || dy === h - 1) {
            pSet(isl.x + dx, isl.deckY + 23 + dy, z, isEdge ? "minecraft:oxidized_cut_copper" : "minecraft:dark_prismarine");
          }
        }
      }
    }
    // Golden Gekyo pendant under Chidori-hafu apex
    pSet(isl.x, isl.deckY + 26, isl.z + 8, "minecraft:gold_block");
    pSet(isl.x, isl.deckY + 25, isl.z + 8, "minecraft:ochre_froglight");

    // Twin Wing Turrets spaced cleanly out to X = isl.x ± 20 (zero overlap with Main Roof eaves!)
    for (const sgn of [-1, 1]) {
      const wx = isl.x + sgn * 20;
      const wz = isl.z + 3;
      for (let cx = Math.min(isl.x + sgn * 13, wx - sgn * 3); cx <= Math.max(isl.x + sgn * 13, wx - sgn * 3); cx++) {
        for (let dz = -1; dz <= 1; dz++) {
          pSet(cx, isl.deckY + 2, wz + dz, "minecraft:stone_bricks");
          if (Math.abs(dz) === 1) pSet(cx, isl.deckY + 3, wz + dz, "minecraft:mangrove_fence");
          pSet(cx, isl.deckY + 7, wz + dz, "minecraft:dark_prismarine");
        }
      }
      // Sub-foundation & diagonal Kakezukuri timber braces anchoring outer wing corner into cliff
      for (let dx = -3; dx <= 3; dx++) {
        for (let dz = -3; dz <= 3; dz++) {
          pSet(wx + dx, isl.deckY + 2, wz + dz, "minecraft:deepslate_bricks");
          pSet(wx + dx, isl.deckY + 1, wz + dz, "minecraft:deepslate_bricks");
        }
      }
      drawStrut(wx + sgn * 3, isl.deckY + 1, wz + 3, isl.x + sgn * 18, isl.deckY - 6, wz, "minecraft:dark_oak_wood", 0);
      drawStrut(wx + sgn * 3, isl.deckY + 1, wz - 3, isl.x + sgn * 18, isl.deckY - 6, wz, "minecraft:dark_oak_wood", 0);

      buildLayeredHall(wx, isl.deckY + 3, wz, 3, 3, 5, { bayStep: 3, openFront: true });
      buildCurvedEastAsianRoof(wx, isl.deckY + 8, wz, 3, 3, 4.2, {
        overhang: 2,
        cornerLift: 2.3,
        chiwen: false,
        eaveLanterns: true,
      });
      pSet(wx, isl.deckY + 13, wz, "minecraft:gold_block");
      pSet(wx, isl.deckY + 14, wz, "minecraft:end_rod", { facing: "up" });
    }

    // Spaced South Courtyard: Braziers at (x ± 9, z + 14), Kasuga Lanterns at (x ± 6, z + 15)
    buildWarmBrazier(isl.x - 9, isl.deckY + 3, isl.z + 14);
    buildWarmBrazier(isl.x + 9, isl.deckY + 3, isl.z + 14);
    for (const sgn of [-1, 1]) {
      const lx = isl.x + sgn * 6;
      const lz = isl.z + 15;
      pSet(lx, isl.deckY + 1, lz, "minecraft:deepslate_bricks");
      pSet(lx, isl.deckY + 2, lz, "minecraft:deepslate_bricks");
      buildStoneLantern(lx, isl.deckY + 3, lz, true);
    }
    for (const sgn of [-1, 1]) {
      for (let dy = 3; dy <= 11; dy++) {
        pSet(isl.x + sgn * 3, isl.deckY + dy, isl.z + 13, dy <= 4 ? "minecraft:deepslate_bricks" : "minecraft:stripped_mangrove_log");
      }
    }
    for (let dx = -5; dx <= 5; dx++) {
      const lift = Math.abs(dx) >= 4 ? 1 : 0;
      pSet(isl.x + dx, isl.deckY + 10, isl.z + 13, "minecraft:mangrove_planks");
      pSet(isl.x + dx, isl.deckY + 11, isl.z + 13, "minecraft:oxidized_cut_copper");
      if (Math.abs(dx) === 5) {
        pSet(isl.x + dx, isl.deckY + 12, isl.z + 13, "minecraft:oxidized_cut_copper_slab", { type: "bottom" });
        pSet(isl.x + dx, isl.deckY + 13, isl.z + 13, "minecraft:dark_prismarine_slab", { type: "bottom" });
      } else {
        pSet(isl.x + dx, isl.deckY + 12 + lift, isl.z + 13, "minecraft:dark_prismarine");
        if (lift > 0) pSet(isl.x + dx, isl.deckY + 12, isl.z + 13, "minecraft:oxidized_cut_copper");
      }
    }
    pSet(isl.x, isl.deckY + 11, isl.z + 13, "minecraft:gold_block");

    for (const sgn of [-1, 1]) {
      const bx = isl.x + sgn * 12;
      const bz = isl.z + 12;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const isRim = Math.abs(dx) === 1 || Math.abs(dz) === 1;
          pSet(bx + dx, isl.deckY + 2, bz + dz, isRim ? "minecraft:polished_deepslate" : "minecraft:sea_lantern");
          if (!isRim) pSet(bx + dx, isl.deckY + 3, bz + dz, "minecraft:light_blue_stained_glass");
        }
      }
    }
  }
})();

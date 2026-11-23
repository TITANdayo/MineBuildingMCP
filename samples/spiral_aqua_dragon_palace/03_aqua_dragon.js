// ============================================================================
// 03_aqua_dragon.js — Hero #1: Masterwork Aqua Dragon Sculpture
// Loop 2: Sculpted Head (Nasal Ridge, Recessed Eyes, Brow, Fangs, Throat,
//       3-Tier Antlers, S-Whiskers, Cheek Fins), V-Chevron Scales, Muscular
//       Pearl-Clutching Limbs w/ 2-Segment Eagle Claws, 7-Ray Tail & Aura
// ============================================================================

(function buildAquaDragon() {
  const NUM_FRAMES = 490;
  const frames = buildDragonFrames(NUM_FRAMES);

  const minX = 54, maxX = 206;
  const minY = 16, maxY = 240;
  const minZ = 54, maxZ = 192;
  const spanX = maxX - minX + 1;
  const spanY = maxY - minY + 1;
  const spanZ = maxZ - minZ + 1;
  const totalCells = spanX * spanY * spanZ;

  const mask = new Uint8Array(totalCells);
  const segIdxGrid = new Uint16Array(totalCells);
  const roleGrid = new Uint8Array(totalCells);   // 1=belly, 2=bellyRib, 3=bellyTrim, 4=dorsalSpine, 5=armorRing
  const sProjGrid = new Int8Array(totalCells);   // quantized sProj * 4

  const gIdx = (wx, wy, wz) => ((wx - minX) * spanY + (wy - minY)) * spanZ + (wz - minZ);

  function bodyRadiusProfile(s) {
    // Expressive silhouette: leaping tail 1.4 -> surging chest 7.4 -> sleek arched neck 3.8
    if (s < 0.14) return lerp(1.4, 4.9, smoothstep(0, 0.14, s));
    if (s < 0.55) return 4.9 + 2.4 * Math.sin(((s - 0.14) / 0.41) * Math.PI * 0.85);
    if (s < 0.84) return lerp(6.8, 5.2, smoothstep(0.55, 0.84, s)) + 0.9 * Math.sin((s - 0.55) * 14);
    return lerp(5.2, 3.8, smoothstep(0.84, 1.0, s));
  }

  // 1. Rasterize Armored Teardrop Cross-Section along Parallel Transport Frames
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const s = f.s;
    const baseR = bodyRadiusProfile(s);
    const isArmorRing = i % 4 === 0;
    const isBellyRib = i % 3 === 0;
    const armorBoost = isArmorRing ? 0.75 : 0;
    const rMax = baseR + armorBoost + 1.5;
    const lim = Math.ceil(rMax);

    const cx = Math.round(f.pos[0]);
    const cy = Math.round(f.pos[1]);
    const cz = Math.round(f.pos[2]);

    for (let dx = -lim; dx <= lim; dx++) {
      const wx = cx + dx;
      if (wx <= minX || wx >= maxX) continue;
      for (let dy = -lim; dy <= lim; dy++) {
        const wy = cy + dy;
        if (wy <= minY || wy >= maxY) continue;
        for (let dz = -lim; dz <= lim; dz++) {
          const wz = cz + dz;
          if (wz <= minZ || wz >= maxZ) continue;

          const rx = wx - f.pos[0];
          const ry = wy - f.pos[1];
          const rz = wz - f.pos[2];

          const tProj = rx * f.T[0] + ry * f.T[1] + rz * f.T[2];
          if (Math.abs(tProj) > 1.2) continue;

          const uProj = rx * f.U[0] + ry * f.U[1] + rz * f.U[2];
          const sProj = rx * f.R[0] + ry * f.R[1] + rz * f.R[2];

          let targetU = baseR;
          let targetS = baseR * 0.94;
          if (uProj < 0) {
            targetU = baseR * 0.72 + (isBellyRib ? 0.8 : 0);
            targetS = baseR * 1.06;
          } else {
            const crestRatio = clamp(uProj / (baseR + 0.01), 0, 1);
            targetS = baseR * (0.98 - 0.34 * crestRatio);
            targetU = baseR * 1.14 + armorBoost;
          }

          const ellip = Math.hypot(sProj / targetS, uProj / targetU);
          if (ellip <= 1.0) {
            const idx = gIdx(wx, wy, wz);
            mask[idx] = 1;
            segIdxGrid[idx] = i + 1;
            sProjGrid[idx] = clamp(Math.round(sProj * 4), -120, 120);

            if (uProj < -baseR * 0.32 && Math.abs(sProj) < baseR * 0.72) {
              roleGrid[idx] = isBellyRib ? 2 : 1;
            } else if (uProj < -baseR * 0.14 && uProj >= -baseR * 0.34) {
              roleGrid[idx] = 3; // copper belly-flank trim
            } else if (uProj > baseR * 0.62 && Math.abs(sProj) < baseR * 0.36) {
              roleGrid[idx] = 4; // dark dorsal spine crest
            } else if (isArmorRing && ellip > 0.75) {
              roleGrid[idx] = 5; // raised armor ring
            } else {
              roleGrid[idx] = 0;
            }
          }
        }
      }
    }
  }

  // 6-neighbor BFS + 26-neighbor airtight hollow shell emission
  const connected = new Uint8Array(totalCells);
  const bfsQ = [];
  const neckF = frames[frames.length - 1];
  const nkx = clamp(Math.round(neckF.pos[0]), minX + 1, maxX - 1);
  const nky = clamp(Math.round(neckF.pos[1]), minY + 1, maxY - 1);
  const nkz = clamp(Math.round(neckF.pos[2]), minZ + 1, maxZ - 1);
  const neckIdx = gIdx(nkx, nky, nkz);
  mask[neckIdx] = 1;
  connected[neckIdx] = 1;
  bfsQ.push(nkx, nky, nkz);

  const dirs6 = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
  for (let q = 0; q < bfsQ.length; q += 3) {
    const x = bfsQ[q], y = bfsQ[q + 1], z = bfsQ[q + 2];
    for (let d = 0; d < 6; d++) {
      const nx = x + dirs6[d][0], ny = y + dirs6[d][1], nz = z + dirs6[d][2];
      if (nx <= minX || nx >= maxX || ny <= minY || ny >= maxY || nz <= minZ || nz >= maxZ) continue;
      const ni = gIdx(nx, ny, nz);
      if (mask[ni] === 1 && connected[ni] === 0) {
        connected[ni] = 1;
        bfsQ.push(nx, ny, nz);
      }
    }
  }

  // Unified Cross-Sectional V-Chevron Scale Palette across ENTIRE length s = 0..1 (zero abrupt blue neck cutoff!)
  for (let wx = minX + 1; wx < maxX; wx++) {
    for (let wy = minY + 1; wy < maxY; wy++) {
      for (let wz = minZ + 1; wz < maxZ; wz++) {
        const idx = gIdx(wx, wy, wz);
        if (connected[idx] === 0) continue;
        let exposed = false;
        for (let ex = -1; ex <= 1 && !exposed; ex++) {
          for (let ey = -1; ey <= 1 && !exposed; ey++) {
            for (let ez = -1; ez <= 1; ez++) {
              if (connected[gIdx(wx + ex, wy + ey, wz + ez)] === 0) {
                exposed = true;
                break;
              }
            }
          }
        }
        if (!exposed) continue;

        const fi = Math.max(0, segIdxGrid[idx] - 1);
        const segBand = Math.floor(fi / 3);
        const role = roleGrid[idx];
        const absS = Math.abs(sProjGrid[idx] / 4.0);
        const chevron = (segBand + Math.floor(absS * 0.9)) % 3;
        let blk;

        if (role === 1) {
          blk = "minecraft:smooth_quartz";
        } else if (role === 2) {
          blk = "minecraft:calcite";
        } else if (role === 3) {
          blk = "minecraft:oxidized_cut_copper";
        } else if (role === 4) {
          blk = fi % 8 === 0 ? "minecraft:blue_ice" : "minecraft:dark_prismarine";
        } else if (role === 5) {
          blk = fi % 8 === 0 ? "minecraft:blue_ice" : "minecraft:oxidized_cut_copper";
        } else {
          // Anti-confetti 3-tone deep jade/bronze chevron scales (NO bright blue_ice speckles!)
          const n = fbm3D(wx * 0.08, wy * 0.08, wz * 0.08, 2);
          const vPhase = clamp((chevron / 2.5) * 0.72 + n * 0.25, 0, 0.999);
          blk = pickFromGradient(vPhase, [
            "minecraft:dark_prismarine",
            "minecraft:prismarine_bricks",
            "minecraft:oxidized_cut_copper",
          ]);
        }
        fSet(wx, wy, wz, blk);
      }
    }
  }

  // 2. Large Undulating Dorsal Fin Membrane + 2 Spiral Water-Aura Ribbons around Body
  let prevFinMid = null;
  let prevFinTip = null;
  let prevAuraA = null;
  let prevAuraB = null;

  for (let i = 8; i <= NUM_FRAMES - 12; i += 4) {
    const f = frames[i];
    const s = f.s;
    const baseR = bodyRadiusProfile(s);
    const wave = 0.5 + 0.5 * Math.sin(s * Math.PI * 10);
    const finH = (3.8 + 4.8 * wave) * smoothstep(0.03, 0.18, s);

    const pStart = vAdd(f.pos, f.U, baseR * 0.65);
    const pMid = vAdd(vAdd(f.pos, f.U, baseR + finH * 0.56), f.T, -1.6);
    const pTip = vAdd(vAdd(f.pos, f.U, baseR + finH), f.T, -3.5);

    // Glowing spinal root node at wave peaks
    if (i % 16 === 0) {
      pSet(pStart[0], pStart[1], pStart[2], "minecraft:sea_lantern");
    }
    drawStrut(pStart[0], pStart[1], pStart[2], pMid[0], pMid[1], pMid[2], "minecraft:oxidized_cut_copper", 0.65, { fast: true });
    drawStrut(pMid[0], pMid[1], pMid[2], pTip[0], pTip[1], pTip[2], (x, y, z, t) =>
      t > 0.62 ? "minecraft:white_stained_glass" : "minecraft:light_blue_stained_glass", 0.35, { fast: true }
    );

    if (prevFinMid && prevFinTip) {
      drawStrut(prevFinMid[0], prevFinMid[1], prevFinMid[2], pMid[0], pMid[1], pMid[2], "minecraft:cyan_stained_glass", 0.45, { fast: true });
      drawStrut(prevFinTip[0], prevFinTip[1], prevFinTip[2], pTip[0], pTip[1], pTip[2], "minecraft:light_blue_stained_glass", 0, { fast: true });
    }
    prevFinMid = pMid;
    prevFinTip = pTip;

    // 2 Helical Water-Aura Ribbons wrapping around body (tethered to flank/dorsal every 16 frames)
    const auraR = baseR + 2.4;
    const angA = s * Math.PI * 2 * 4.5;
    const angB = angA + Math.PI;
    const ptA = vAdd(vAdd(f.pos, f.R, Math.cos(angA) * auraR), f.U, Math.sin(angA) * auraR);
    const ptB = vAdd(vAdd(f.pos, f.R, Math.cos(angB) * auraR), f.U, Math.sin(angB) * auraR);

    if (prevAuraA && prevAuraB) {
      drawStrut(prevAuraA[0], prevAuraA[1], prevAuraA[2], ptA[0], ptA[1], ptA[2], (x, y, z, t) =>
        (i % 8 === 0 ? "minecraft:white_stained_glass" : "minecraft:light_blue_stained_glass"), 0, { fast: true }
      );
      drawStrut(prevAuraB[0], prevAuraB[1], prevAuraB[2], ptB[0], ptB[1], ptB[2], "minecraft:cyan_stained_glass", 0, { fast: true });
    }
    prevAuraA = ptA;
    prevAuraB = ptB;

    if (i % 16 === 0) {
      drawStrut(f.pos[0], f.pos[1], f.pos[2], ptA[0], ptA[1], ptA[2], "minecraft:cyan_stained_glass", 0, { fast: true, onlyIfEmpty: true });
      drawStrut(f.pos[0], f.pos[1], f.pos[2], ptB[0], ptB[1], ptB[2], "minecraft:cyan_stained_glass", 0, { fast: true, onlyIfEmpty: true });
      for (const sgn of [-1, 1]) {
        const fBase = vAdd(f.pos, f.R, sgn * baseR * 0.72);
        const fTip = vAdd(vAdd(vAdd(f.pos, f.R, sgn * (baseR + 3.6)), f.T, -3.4), f.U, 1.0);
        drawStrut(fBase[0], fBase[1], fBase[2], fTip[0], fTip[1], fTip[2], "minecraft:cyan_stained_glass", 0, { fast: true });
      }
    }
  }

  // 3. 7-Ray Great Fan Tail Fin at s = 0 (length ~22, spread ±0.85 rad)
  const tailF = frames[0];
  const tailOrigin = tailF.pos;
  const fanAngles = [-0.85, -0.56, -0.28, 0, 0.28, 0.56, 0.85];
  const rayPts = [];
  for (let rIdx = 0; rIdx < fanAngles.length; rIdx++) {
    const ang = fanAngles[rIdx];
    const dir = vNorm(
      vAdd(
        vAdd(vAdd([0, 0, 0], tailF.T, -Math.cos(ang)), tailF.U, Math.sin(ang) * 0.72),
        tailF.R,
        Math.sin(ang) * 0.68
      )
    );
    const len = 22 - Math.abs(ang) * 5.0;
    const tip = vAdd(tailOrigin, dir, len);
    const mid = vAdd(tailOrigin, dir, len * 0.52);
    rayPts.push({ mid, tip });
    drawStrut(tailOrigin[0], tailOrigin[1], tailOrigin[2], mid[0], mid[1], mid[2], "minecraft:prismarine_bricks", 0.7, { fast: true });
    drawStrut(
      mid[0], mid[1], mid[2], tip[0], tip[1], tip[2],
      (x, y, z, t) => (t > 0.55 ? "minecraft:white_stained_glass" : "minecraft:light_blue_stained_glass"),
      0.35, { fast: true }
    );
  }
  for (let rIdx = 0; rIdx < rayPts.length - 1; rIdx++) {
    drawStrut(
      rayPts[rIdx].mid[0], rayPts[rIdx].mid[1], rayPts[rIdx].mid[2],
      rayPts[rIdx + 1].mid[0], rayPts[rIdx + 1].mid[1], rayPts[rIdx + 1].mid[2],
      "minecraft:cyan_stained_glass", 0.35, { fast: true }
    );
    drawStrut(
      rayPts[rIdx].tip[0], rayPts[rIdx].tip[1], rayPts[rIdx].tip[2],
      rayPts[rIdx + 1].tip[0], rayPts[rIdx + 1].tip[1], rayPts[rIdx + 1].tip[2],
      "minecraft:light_blue_stained_glass", 0, { fast: true }
    );
  }

  // 4. Limbs intentionally omitted for sleek, unencumbered Oriental serpentine Aqua-Dragon silhouette

  // 5. High-Detail Sculpted Dragon Head at [176, 204, 138] facing Pearl [168, 197, 154]
  const HC = DRAGON_HEAD_POS;
  const F_fwd = vNorm(vSub(DRAGON_PEARL_POS, HC));
  const R_head = vNorm(vCross(F_fwd, [0, 1, 0]));
  const U_head = vNorm(vCross(R_head, F_fwd));

  const headWorld = (f, u, r) => [
    HC[0] + f * F_fwd[0] + u * U_head[0] + r * R_head[0],
    HC[1] + f * F_fwd[1] + u * U_head[1] + r * R_head[1],
    HC[2] + f * F_fwd[2] + u * U_head[2] + r * R_head[2],
  ];

  // Seamless neck-to-skull join
  const neckEnd = frames[NUM_FRAMES].pos;
  const skullBack = headWorld(-6.5, 0, 0);
  drawStrut(neckEnd[0], neckEnd[1], neckEnd[2], skullBack[0], skullBack[1], skullBack[2], "minecraft:dark_prismarine", 3.6, { fast: true });

  // 5A. Sculpted Upper Skull, Raised Nasal Ridge, Upturned Snout & Nostril Scrolls (f = -8.5 .. +11.8)
  for (let f = -8.5; f <= 11.8; f += 0.35) {
    const halfW = f < 0 ? lerp(5.2, 6.5, (f + 8.5) / 8.5) : lerp(6.5, 2.5, f / 11.8);
    const maxU = f < 1 ? lerp(4.8, 6.0, (f + 8.5) / 9.5) : lerp(5.4, 2.4, f / 11.8);
    for (let r = -Math.ceil(halfW); r <= Math.ceil(halfW); r += 0.35) {
      for (let u = 0; u <= Math.ceil(maxU) + 1.5; u += 0.35) {
        // Raised nasal bridge along center + upturned snout tip
        const nasalBoost = f >= 1 && Math.abs(r) <= 1.25 ? 1.0 : 0;
        const snoutFlare = f >= 9.6 && Math.abs(r) <= 1.5 ? 0.9 : 0;
        const effMaxU = maxU + nasalBoost + snoutFlare;
        if (u > effMaxU) continue;

        const nr = Math.abs(r) / halfW;
        const nu = u / effMaxU;
        const dShell = Math.hypot(nr, Math.max(0, nu));
        if (dShell > 1.0) continue;

        // Carve recessed eye socket pocket at f = 1.5..4.2, u = 1.8..3.2
        const inEyePocket = f >= 1.5 && f <= 4.2 && u >= 1.8 && u <= 3.2 && Math.abs(r) > halfW - 1.3;
        if (inEyePocket) continue;

        const isOuter = dShell > 0.6 || u <= 0.25;
        if (!isOuter && !(f <= -3 && dShell < 0.45)) continue;

        const wp = headWorld(f, u, r);
        let blk = "minecraft:dark_prismarine";
        if (f >= 1 && Math.abs(r) <= 1.25 && u > maxU * 0.72) {
          // Sculpted nasal bridge ridge
          blk = f % 2 === 0 ? "minecraft:oxidized_cut_copper" : "minecraft:prismarine_bricks";
        } else if (u <= 0.75 && Math.abs(r) >= halfW - 1.1) {
          // Defined upper lip / gum edge
          blk = "minecraft:oxidized_cut_copper";
        } else if (u <= 0.3 && Math.abs(r) < halfW * 0.7) {
          blk = f < 5 ? "minecraft:sea_lantern" : "minecraft:cyan_stained_glass";
        } else if (nu > 0.78) {
          blk = "minecraft:prismarine_bricks";
        }
        pSet(wp[0], wp[1], wp[2], blk);
      }
    }
  }

  // Sculpted Nostril Scrolls at snout tip (anchored via drawStrut inside snout)
  for (const sgn of [-1, 1]) {
    const nRoot = headWorld(9.5, 1.4, sgn * 1.0);
    const n1 = headWorld(10.5, 2.4, sgn * 1.8);
    const n2 = headWorld(11.3, 2.8, sgn * 2.0);
    drawStrut(nRoot[0], nRoot[1], nRoot[2], n1[0], n1[1], n1[2], "minecraft:oxidized_cut_copper", 0);
    drawStrut(n1[0], n1[1], n1[2], n2[0], n2[1], n2[2], "minecraft:prismarine_bricks", 0);
  }

  // 5B. Recessed Slanted Glowing Golden Eyes + Sweeping Armored Brow Ridges
  for (const sgn of [-1, 1]) {
    // 3-voxel slanted glowing eye recessed in eye socket
    const eFront = headWorld(3.6, 2.1, sgn * 4.2);
    const eMid = headWorld(2.7, 2.5, sgn * 4.5);
    const eRear = headWorld(1.8, 2.9, sgn * 4.8);
    pSet(eFront[0], eFront[1], eFront[2], "minecraft:gold_block");
    pSet(eMid[0], eMid[1], eMid[2], "minecraft:ochre_froglight");
    pSet(eRear[0], eRear[1], eRear[2], "minecraft:yellow_stained_glass");

    // Bold sweeping Brow Ridge overhanging 1.5-2 blocks outward & flaring backward
    const b1 = headWorld(4.6, 3.6, sgn * 4.2);
    const b2 = headWorld(1.2, 4.6, sgn * 5.8);
    const b3 = headWorld(-3.5, 6.2, sgn * 6.8);
    drawStrut(b1[0], b1[1], b1[2], b2[0], b2[1], b2[2], "minecraft:oxidized_cut_copper", 0.75);
    drawStrut(b2[0], b2[1], b2[2], b3[0], b3[1], b3[2], (x, y, z, t) =>
      t > 0.65 ? "minecraft:smooth_quartz" : "minecraft:gold_block", 0.45);
  }

  // 5C. 35-Degree Open Lower Jaw, Glowing Energy Throat, Dragon Tongue & Chin Beard
  const jawAngle = -35 * (Math.PI / 180);
  const cosJ = Math.cos(jawAngle);
  const sinJ = Math.sin(jawAngle);
  const jawHingeF = -3.0;
  const jawHingeU = -1.8;

  for (let jf = 0; jf <= 13.0; jf += 0.5) {
    const jT = jf / 13.0;
    const halfW = lerp(5.4, 2.1, jT);
    for (let r = -Math.ceil(halfW); r <= Math.ceil(halfW); r += 0.5) {
      for (let ju = -2.2; ju <= 0.4; ju += 0.5) {
        if (Math.abs(r) > halfW * (ju < -1.0 ? 0.82 : 1.0)) continue;
        const f = jawHingeF + jf * cosJ - ju * sinJ;
        const u = jawHingeU + jf * sinJ + ju * cosJ;
        const wp = headWorld(f, u, r);
        let blk = "minecraft:dark_prismarine";
        if (ju <= -1.2 && Math.abs(r) < halfW * 0.68) {
          blk = "minecraft:smooth_quartz";
        } else if (ju >= -0.2 && Math.abs(r) <= 1.2 && jf >= 2 && jf <= 10.5) {
          // Undulating glowing Dragon Tongue inside open lower jaw
          blk = jf > 7 ? "minecraft:light_blue_stained_glass" : "minecraft:prismarine_bricks";
        } else if (Math.abs(r) >= halfW - 0.8 && ju > -0.8) {
          blk = "minecraft:oxidized_cut_copper";
        }
        pSet(wp[0], wp[1], wp[2], blk);
      }
    }
  }

  // Glowing Cyan Roar Energy Core deep in open throat (f = -1..5)
  for (let tf = -1; tf <= 4; tf++) {
    for (let tr = -1; tr <= 1; tr++) {
      const tp = headWorld(tf, -0.8, tr);
      pSet(tp[0], tp[1], tp[2], Math.abs(tr) === 0 ? "minecraft:sea_lantern" : "minecraft:cyan_stained_glass");
    }
  }

  // Sharp Fangs with clear 3-4 block open bite gap (end_rod tips!)
  const fangSpecs = [
    { ff: 5.5, r: 3.3, len: 1.0 },
    { ff: 8.2, r: 2.4, len: 1.0 },
    { ff: 10.4, r: 1.6, len: 1.5 }, // prominent front canines
  ];
  for (let fi = 0; fi < fangSpecs.length; fi++) {
    const { ff, r, len } = fangSpecs[fi];
    for (const sgn of [-1, 1]) {
      const uBase = headWorld(ff, -0.3, sgn * r);
      pSet(uBase[0], uBase[1], uBase[2], "minecraft:smooth_quartz");
      if (len > 1.2) {
        const uTip = headWorld(ff, -1.3, sgn * r);
        pSet(uTip[0], uTip[1], uTip[2], "minecraft:end_rod", { facing: "down" });
      }

      const jf = ff + 0.8;
      const lBase = headWorld(jawHingeF + jf * cosJ, jawHingeU + jf * sinJ + 0.4, sgn * (r * 0.88));
      pSet(lBase[0], lBase[1], lBase[2], "minecraft:calcite");
      if (len > 1.2) {
        const lMid = headWorld(jawHingeF + jf * cosJ - 0.9 * sinJ, jawHingeU + jf * sinJ + 0.9 * cosJ + 0.4, sgn * (r * 0.88));
        drawStrut(lBase[0], lBase[1], lBase[2], lMid[0], lMid[1], lMid[2], "minecraft:calcite", 0);
        pSet(Math.round(lMid[0]), Math.round(lMid[1]) + 1, Math.round(lMid[2]), "minecraft:end_rod", { facing: "up" });
      }
    }
  }

  // Flowing White Chin Beard (4 wisps under lower jaw)
  const beardSpecs = [
    [11.5, -2.0, 0, 5.5, -5.8, 0],
    [10.0, -2.0, 1.4, 3.5, -5.5, 2.2],
    [10.0, -2.0, -1.4, 3.5, -5.5, -2.2],
    [7.5, -1.9, 0, 1.5, -5.2, 0],
  ];
  for (let bi = 0; bi < beardSpecs.length; bi++) {
    const [jf0, ju0, jr0, jf1, ju1, jr1] = beardSpecs[bi];
    const p0 = headWorld(jawHingeF + jf0 * cosJ - ju0 * sinJ, jawHingeU + jf0 * sinJ + ju0 * cosJ, jr0);
    const p1 = headWorld(jawHingeF + jf1 * cosJ - ju1 * sinJ, jawHingeU + jf1 * sinJ + ju1 * cosJ, jr1);
    drawStrut(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], (x, y, z, t) =>
      t > 0.6 ? "minecraft:white_stained_glass" : "minecraft:smooth_quartz", 0);
  }

  // 5D. Powerful 3-Segment Curved Branched Antlers w/ Gold Coronets & Forward Tines
  for (const sgn of [-1, 1]) {
    const root = headWorld(-2.2, 4.4, sgn * 3.0);
    const seg1 = headWorld(-6.5, 8.2, sgn * 4.8);
    const seg2 = headWorld(-12.5, 13.0, sgn * 6.8);
    const seg3 = headWorld(-19.5, 17.8, sgn * 7.6);
    const fwdTine1 = headWorld(-3.0, 12.2, sgn * 5.6);
    const fwdTine2 = headWorld(-8.5, 17.5, sgn * 5.2);

    pSet(root[0], root[1], root[2], "minecraft:gold_block");
    pSet(root[0], root[1] + 1, root[2], "minecraft:gold_block");
    drawStrut(root[0], root[1], root[2], seg1[0], seg1[1], seg1[2], "minecraft:smooth_quartz", 0.9);
    drawStrut(seg1[0], seg1[1], seg1[2], seg2[0], seg2[1], seg2[2], "minecraft:smooth_quartz", 0.65);
    drawStrut(seg2[0], seg2[1], seg2[2], seg3[0], seg3[1], seg3[2], "minecraft:calcite", 0.4);
    drawStrut(seg1[0], seg1[1], seg1[2], fwdTine1[0], fwdTine1[1], fwdTine1[2], "minecraft:smooth_quartz", 0.45);
    drawStrut(seg2[0], seg2[1], seg2[2], fwdTine2[0], fwdTine2[1], fwdTine2[2], "minecraft:calcite", 0);
  }

  // 5E. Graceful White-to-Aqua S-Curved Dragon Whiskers (left side sweeps downward & inward, zero Palace contact!)
  for (const sgn of [-1, 1]) {
    let prevP = sgn < 0 ? headWorld(8.8, -0.5, -1.2) : headWorld(9.8, 0.6, 2.2);
    const wSteps = 26;
    for (let k = 1; k <= wSteps; k++) {
      const wt = k / wSteps;
      const wf = sgn < 0
        ? lerp(8.8, -2.0, wt)
        : (wt < 0.25 ? lerp(9.8, 12.6, wt / 0.25) : lerp(12.6, -5.5, (wt - 0.25) / 0.75));
      const wu = sgn < 0
        ? lerp(-0.5, -10.5, wt) + Math.sin(wt * Math.PI * 1.5) * 1.2
        : 0.6 + Math.sin(wt * Math.PI * 1.4) * 2.6 - wt * 4.5;
      const wr = sgn < 0
        ? lerp(-1.2, 0.8, wt) + Math.sin(wt * Math.PI * 2.0) * 0.8
        : 2.2 + Math.sin(wt * Math.PI * 0.8) * 4.2 + wt * 6.5;
      const curP = headWorld(wf, wu, wr);
      const blk =
        wt > 0.72
          ? "minecraft:light_blue_stained_glass"
          : wt > 0.45
            ? "minecraft:white_stained_glass"
            : wt > 0.22
              ? "minecraft:calcite"
              : "minecraft:smooth_quartz";
      drawStrut(prevP[0], prevP[1], prevP[2], curP[0], curP[1], curP[2], blk, 0);
      prevP = curP;
    }
  }

  // 5F. Fan-Shaped Cheek Fins & Ice-Crystal Mane
  const maneRays = [
    [-2.5, 2.2, 3.8, -9.5, 4.5, 9.8],
    [-2.5, 2.2, -3.8, -9.5, 4.5, -9.8],
    [-4.0, 0.2, 4.0, -11.5, 1.0, 10.4],
    [-4.0, 0.2, -4.0, -11.5, 1.0, -10.4],
    [-5.5, -1.2, 3.8, -12.0, -2.5, 9.2],
    [-5.5, -1.2, -3.8, -12.0, -2.5, -9.2],
    [-6.0, 3.8, 2.2, -14.5, 9.2, 4.5],
    [-6.0, 3.8, -2.2, -14.5, 9.2, -4.5],
    [-6.2, 4.2, 0, -15.5, 10.6, 0],
  ];
  for (let m = 0; m < maneRays.length; m++) {
    const [f0, u0, r0, f1, u1, r1] = maneRays[m];
    const p0 = headWorld(f0, u0, r0);
    const p1 = headWorld(f1, u1, r1);
    drawStrut(
      p0[0], p0[1], p0[2], p1[0], p1[1], p1[2],
      (x, y, z, t) => (t > 0.68 ? "minecraft:white_stained_glass" : t > 0.3 ? "minecraft:cyan_stained_glass" : "minecraft:oxidized_cut_copper"),
      0.45
    );
  }

  // 6. Sacred Aqua-Dragon Pearl at [168, 197, 154] (clear 5-block gap ahead of snout)
  const PX = DRAGON_PEARL_POS[0];
  const PY = DRAGON_PEARL_POS[1];
  const PZ = DRAGON_PEARL_POS[2];

  drawHollowSphere(PX, PY, PZ, 2.4, 2.4, (bx, by, bz, dx, dy, dz, dist) => {
    if (dist <= 1.25) return "minecraft:sea_lantern";
    if (dist <= 2.15 && Math.abs(dy) <= 0.6) return "minecraft:gold_block";
    return Math.abs(dy) > 1.3 ? "minecraft:white_stained_glass" : "minecraft:light_blue_stained_glass";
  });

  for (let a = 0; a < 4; a++) {
    const basePhi = (a / 4) * Math.PI * 2;
    const tilt = a % 2 === 0 ? 0.65 : -0.65;
    let prev = [PX + Math.cos(basePhi) * 2.0, PY, PZ + Math.sin(basePhi) * 2.0];
    for (let k = 1; k <= 10; k++) {
      const kt = k / 10;
      const rad = 2.1 + kt * 1.9;
      const phi = basePhi + kt * Math.PI * 1.2;
      const cur = [
        PX + Math.cos(phi) * rad,
        PY + Math.sin(kt * Math.PI) * 2.3 * tilt + (kt - 0.5) * 1.4,
        PZ + Math.sin(phi) * rad,
      ];
      const blk = kt > 0.6 ? "minecraft:white_stained_glass" : "minecraft:light_blue_stained_glass";
      drawStrut(prev[0], prev[1], prev[2], cur[0], cur[1], cur[2], blk, 0);
      prev = cur;
    }
  }
})();

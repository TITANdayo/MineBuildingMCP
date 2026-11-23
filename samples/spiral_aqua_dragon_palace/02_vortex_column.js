// ============================================================================
// 02_vortex_column.js — Central Double-Helix Aqua Vortex & 2-Tier Lotus Crown
// Loop 4: Reversed Outer Feather Fade (White->LightBlue->Cyan), 3 Outer
//         Spiral Ribbons, Two-Tier 16-Petal Chalice Lotus & Y=239 Geyser Spire
// ============================================================================

(function buildVortexColumn() {
  const Y_MIN = 14;
  const Y_MAX = 228;

  const prevInner = [null, null];
  const prevOuterRibbons = [null, null, null];

  for (let y = Y_MIN; y <= Y_MAX; y++) {
    const [vcx, , vcz] = vortexCenter(y);
    const rOuter = vortexRadius(y);
    const t = (y - Y_MIN) / (Y_MAX - Y_MIN);
    const twist = t * Math.PI * 2 * 3.2;

    // 1A. Inner Luminous Double-Helix Ribbons (sea_lantern + blue_ice)
    const innerOrbit = clamp(rOuter * 0.42, 1.8, 4.6);
    for (let arm = 0; arm < 2; arm++) {
      const ang = twist * 1.4 + arm * Math.PI;
      const ix = vcx + Math.cos(ang) * innerOrbit;
      const iz = vcz + Math.sin(ang) * innerOrbit;
      const tubeR = y > 185 ? 1.25 : 1.55;
      if (prevInner[arm]) {
        drawStrut(
          prevInner[arm][0], prevInner[arm][1], prevInner[arm][2],
          ix, y, iz,
          (bx, by, bz) => {
            const d = Math.hypot(bx - ix, bz - iz);
            return d <= 0.85 ? "minecraft:sea_lantern" : "minecraft:blue_ice";
          },
          tubeR,
          { fast: true }
        );
      } else {
        drawHollowSphere(Math.round(ix), y, Math.round(iz), tubeR, tubeR, () => "minecraft:sea_lantern");
      }
      prevInner[arm] = [ix, y, iz];

      if (y % 10 === 0 || y <= Y_MIN + 2 || y >= Y_MAX - 2) {
        drawStrut(
          Math.round(ix), y, Math.round(iz),
          Math.round(vcx + Math.cos(ang) * (rOuter - 0.5)), y, Math.round(vcz + Math.sin(ang) * (rOuter - 0.5)),
          "minecraft:cyan_stained_glass", 0, { fast: true }
        );
      }
    }

    // 1B. Main Hollow Spiral-Grooved Shell + 1C. Reversed Feather-Fade Splash Veil
    const rInner = Math.max(1.2, rOuter - (y < 42 ? 1.9 : 1.65));
    const limOut = Math.ceil(rOuter + 5.4);

    for (let dx = -limOut; dx <= limOut; dx++) {
      for (let dz = -limOut; dz <= limOut; dz++) {
        const wx = Math.round(vcx) + dx;
        const wz = Math.round(vcz) + dz;
        const r = Math.hypot(wx - vcx, wz - vcz);
        const theta = Math.atan2(wz - vcz, wx - vcx);

        if (r >= rInner && r <= rOuter + 0.45) {
          const ribWave = Math.cos(3 * (theta - twist));
          const isSolidFunnel = y <= 26 || (y >= 166 && y <= 182);
          if (isSolidFunnel || ribWave > -0.15) {
            const n = fbm3D(wx * 0.12, y * 0.1, wz * 0.12, 2);
            const gradT = clamp((ribWave + 0.2) * 0.5 + n * 0.25, 0, 0.999);
            let blk;
            if (y <= 22 && n > 0.25) {
              blk = "minecraft:dark_prismarine";
            } else if (ribWave > 0.72) {
              blk = "minecraft:blue_ice";
            } else {
              blk = pickFromGradient(gradT, PALETTES.waterCore);
            }
            fSet(wx, y, wz, blk);
          }
          continue;
        }

        // Reversed Feather-Fade Veil: bright white/sea_lantern crest inside -> light_blue -> cyan mist outer!
        if (y >= 16 && y <= 222 && r > rOuter + 0.45 && r <= rOuter + 4.8) {
          const veilWave = Math.cos(3 * (theta - twist - 0.18));
          const radT = (r - (rOuter + 0.45)) / 4.35;
          const flutter = 0.08 * Math.sin(y * 0.35 + theta * 4.0);
          if (veilWave > 0.28 + radT * 0.46 + flutter) {
            let blk;
            if (radT < 0.28) {
              blk = (y % 5 === 0 && veilWave > 0.78) ? "minecraft:sea_lantern" : "minecraft:white_stained_glass";
            } else if (radT < 0.62) {
              blk = "minecraft:light_blue_stained_glass";
            } else {
              blk = "minecraft:cyan_stained_glass";
            }
            fSet(wx, y, wz, blk);
          }
        }
      }
    }

    // 1D. 3 Independent Outer Spiral Splash Ribbons racing upward around the main column
    if (y >= 18 && y <= 220) {
      const ribbonR = rOuter + 3.8 + 1.3 * Math.sin(y * 0.09);
      for (let arm = 0; arm < 3; arm++) {
        const ang = twist * 1.45 + (arm * Math.PI * 2) / 3 + 0.8;
        const rx = vcx + Math.cos(ang) * ribbonR;
        const rz = vcz + Math.sin(ang) * ribbonR;
        if (prevOuterRibbons[arm]) {
          drawStrut(
            prevOuterRibbons[arm][0], prevOuterRibbons[arm][1], prevOuterRibbons[arm][2],
            rx, y, rz,
            (bx, by, bz) => (y % 4 === 0 ? "minecraft:white_stained_glass" : "minecraft:light_blue_stained_glass"),
            0.35, { fast: true }
          );
        }
        prevOuterRibbons[arm] = [rx, y, rz];

        if (y % 10 === 0 || y === 18) {
          drawStrut(
            Math.round(vcx + Math.cos(ang) * (rOuter - 0.4)), y, Math.round(vcz + Math.sin(ang) * (rOuter - 0.4)),
            Math.round(rx), y, Math.round(rz),
            "minecraft:cyan_stained_glass", 0, { fast: true }
          );
        }
      }
    }
  }

  // 2. Two-Tier 16-Petal Chalice Lotus Crown & Y=239 Central Geyser Spire (Pure Cool Palette!)
  const [topX, , topZ] = vortexCenter(224);
  const crownX = Math.round(topX);
  const crownZ = Math.round(topZ);
  const crownY = 224;

  // Chalice base collar
  for (let dx = -5; dx <= 5; dx++) {
    for (let dz = -5; dz <= 5; dz++) {
      const d = Math.hypot(dx, dz);
      if (d <= 5.2) {
        pSet(crownX + dx, crownY - 2, crownZ + dz, d < 3.0 ? "minecraft:sea_lantern" : "minecraft:prismarine_bricks");
        pSet(crownX + dx, crownY - 1, crownZ + dz, d < 3.5 ? "minecraft:blue_ice" : "minecraft:cyan_stained_glass");
      }
    }
  }

  // Pure cool glowing core sphere (NO ochre_froglight!)
  drawHollowSphere(crownX, crownY + 2, crownZ, 3.4, 3.4, (bx, by, bz, dx, dy, dz, dist) => {
    if (dist <= 1.8) return "minecraft:sea_lantern";
    if (dist <= 2.6) return "minecraft:blue_ice";
    return "minecraft:light_blue_stained_glass";
  });

  // Central Geyser Spire shooting cleanly up to Y = 239 (inside frame!)
  for (let gy = crownY + 4; gy <= 239; gy++) {
    const gt = (gy - (crownY + 4)) / (239 - (crownY + 4));
    const blk = gt > 0.72
      ? "minecraft:white_stained_glass"
      : gt > 0.42
        ? "minecraft:light_blue_stained_glass"
        : gt > 0.18
          ? "minecraft:blue_ice"
          : "minecraft:sea_lantern";
    pSet(crownX, gy, crownZ, blk);
    if (gt < 0.55) {
      pSetIfEmpty(crownX + 1, gy, crownZ, "minecraft:cyan_stained_glass");
      pSetIfEmpty(crownX - 1, gy, crownZ, "minecraft:cyan_stained_glass");
      pSetIfEmpty(crownX, gy, crownZ + 1, "minecraft:cyan_stained_glass");
      pSetIfEmpty(crownX, gy, crownZ - 1, "minecraft:cyan_stained_glass");
    }
  }

  // Tier 1: 8 Broad Outer Lotus Petals (Y = 216..227, flaring to radius 14.5)
  for (let i = 0; i < 8; i++) {
    const ang = (i / 8) * Math.PI * 2;
    const cosA = Math.cos(ang);
    const sinA = Math.sin(ang);
    const perpX = -sinA;
    const perpZ = cosA;

    const pBase = [crownX + cosA * 4.2, crownY - 5, crownZ + sinA * 4.2];
    const pMid = [crownX + cosA * 9.8, crownY - 2, crownZ + sinA * 9.8];
    const pTip = [crownX + cosA * 14.2, crownY + 3, crownZ + sinA * 14.2];

    drawStrut(pBase[0], pBase[1], pBase[2], pMid[0], pMid[1], pMid[2], "minecraft:prismarine_bricks", 0.85, { fast: true });
    drawStrut(
      pMid[0], pMid[1], pMid[2],
      pTip[0], pTip[1], pTip[2],
      (x, y, z, t) => (t > 0.65 ? "minecraft:white_stained_glass" : "minecraft:light_blue_stained_glass"),
      0.55, { fast: true }
    );
    for (const sgn of [-1, 1]) {
      const flare = [pMid[0] + perpX * sgn * 2.6, pMid[1] + 0.8, pMid[2] + perpZ * sgn * 2.6];
      drawStrut(pMid[0], pMid[1], pMid[2], flare[0], flare[1], flare[2], "minecraft:cyan_stained_glass", 0.4, { fast: true });
    }
  }

  // Tier 2: 8 Upper Inner Petals (22.5° offset, Y = 222..234, radius 10.5) + Parabolic Fountain Arches
  for (let i = 0; i < 8; i++) {
    const ang = (i / 8) * Math.PI * 2 + Math.PI / 8;
    const cosA = Math.cos(ang);
    const sinA = Math.sin(ang);

    const uBase = [crownX + cosA * 3.0, crownY - 1, crownZ + sinA * 3.0];
    const uMid = [crownX + cosA * 6.8, crownY + 4, crownZ + sinA * 6.8];
    const uTip = [crownX + cosA * 10.2, crownY + 10, crownZ + sinA * 10.2];
    drawStrut(uBase[0], uBase[1], uBase[2], uMid[0], uMid[1], uMid[2], "minecraft:blue_ice", 0.65, { fast: true });
    drawStrut(
      uMid[0], uMid[1], uMid[2], uTip[0], uTip[1], uTip[2],
      (x, y, z, t) => (t > 0.55 ? "minecraft:white_stained_glass" : "minecraft:light_blue_stained_glass"),
      0.35, { fast: true }
    );

    // Wide Parabolic Fountain Arch (radius 15.5) + 4-block vertical white droplet tail!
    const endX = Math.round(crownX + cosA * 15.2);
    const endY = crownY + 1;
    const endZ = Math.round(crownZ + sinA * 15.2);
    drawCatenary(
      crownX + cosA * 2.2, crownY + 4, crownZ + sinA * 2.2,
      endX, endY, endZ,
      -7.5,
      (x, y, z, t) => (t > 0.72 ? "minecraft:white_stained_glass" : "minecraft:light_blue_stained_glass"),
      { fast: true }
    );
    const dropTail = 3 + (i % 3);
    for (let d = 1; d <= dropTail; d++) {
      pSetIfEmpty(endX, endY - d, endZ, "minecraft:white_stained_glass");
    }
  }
})();

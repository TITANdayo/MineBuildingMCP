import type {
  BlockState,
  BuildLintIssue,
  BuildLintIssueType,
  BuildLintReport,
  CompiledBlockDefinition,
  TraceRecord,
  VoxelData,
} from "../types/shared.js";
import {
  ALL_DIRS,
  CARDINAL_DIRS,
  classifyBlockConnectionKind,
  collectMultipartPropValues,
  collectVariantPropValues,
  DIR_VECTORS,
  getBlockDef,
  getDefaultPropValue,
  getExistingBlockDef,
  hasTag,
  hasVariantProp,
  isInstanceFullOpaqueCube,
  normalizeShortBlockName,
  resolveWorldBlockStates,
} from "./block-state-resolver.js";

function horizDelta(dir: string): [number, number] {
  switch (dir.toLowerCase()) {
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

function isFullCubePillarFallbackName(shortName: string): boolean {
  return /(^|_)(log|wood|stem|hyphae|pillar|basalt|deepslate|hay_block|bone_block|froglight|portal)$/.test(
    shortName
  );
}

/**
 * Data-driven classification of slender single-axis blocks (such as chains)
 * that have an `axis` property (`x`/`y`/`z`) and a narrow 2D cross-section
 * perpendicular to their main axis (unlike full 16x16x16 logs/pillars or wide portal sheets).
 */
export function isSlenderAxisBlock(
  voxel: VoxelData,
  def: CompiledBlockDefinition,
  blockModels?: Record<string, CompiledBlockDefinition>
): boolean {
  if (hasTag(def, "chains")) {
    return true;
  }

  const existingDef = getExistingBlockDef(voxel.name, blockModels);
  const effectiveDef = existingDef ?? def;

  const hasAxis =
    hasVariantProp(effectiveDef, "axis") ||
    (voxel.state?.axis !== undefined &&
      (!existingDef || !effectiveDef.isFullOpaqueCube));

  if (!hasAxis) {
    return false;
  }

  if (!existingDef) {
    // Fallback when no compiled JAR model was provided for this block
    const shortName = normalizeShortBlockName(voxel.name);
    return !isFullCubePillarFallbackName(shortName);
  }

  if (effectiveDef.isFullOpaqueCube) {
    return false;
  }

  // Inspect model elements to verify slender 1D axial geometry (2 narrow cross-section axes <= 10px)
  const modelArrays = Object.values(effectiveDef.models).filter(
    (els) => Array.isArray(els) && els.length > 0
  );
  if (modelArrays.length === 0) {
    // Synthetic non-full-cube mock with `axis` variants
    return true;
  }

  const elements = modelArrays[0];
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;

  for (const el of elements) {
    minX = Math.min(minX, el.from[0], el.to[0]);
    minY = Math.min(minY, el.from[1], el.to[1]);
    minZ = Math.min(minZ, el.from[2], el.to[2]);
    maxX = Math.max(maxX, el.from[0], el.to[0]);
    maxY = Math.max(maxY, el.from[1], el.to[1]);
    maxZ = Math.max(maxZ, el.from[2], el.to[2]);
  }

  const spans = [maxX - minX, maxY - minY, maxZ - minZ].sort((a, b) => a - b);
  return spans[0] <= 10 && spans[1] <= 10;
}

/**
 * Data-driven check for wall-mounted directional thin blocks (e.g. wall_torch, wall_sign, ladder)
 * that only have horizontal `facing` variants and require a backing wall.
 */
function isWallMountedDirectionalBlock(def: CompiledBlockDefinition): boolean {
  if (def.isFullOpaqueCube || !def.variants) return false;
  if (
    hasTag(def, "wall_signs") ||
    hasTag(def, "wall_corals") ||
    hasTag(def, "wall_hanging_signs")
  ) {
    return true;
  }

  const vProps = collectVariantPropValues(def);
  if (!vProps.facing) return false;
  if (
    vProps.half ||
    vProps.type ||
    vProps.shape ||
    vProps.part ||
    vProps.axis ||
    vProps.hanging ||
    vProps.face ||
    vProps.attachment
  ) {
    return false;
  }

  // Must only have horizontal facing values (north/south/east/west)
  for (const val of vProps.facing) {
    if (!["north", "south", "east", "west"].includes(val)) {
      return false;
    }
  }

  const modelArrays = Object.values(def.models).filter(
    (els) => Array.isArray(els) && els.length > 0
  );
  if (modelArrays.length === 0) return false;

  const elements = modelArrays[0];
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;

  for (const el of elements) {
    minX = Math.min(minX, el.from[0], el.to[0]);
    minY = Math.min(minY, el.from[1], el.to[1]);
    minZ = Math.min(minZ, el.from[2], el.to[2]);
    maxX = Math.max(maxX, el.from[0], el.to[0]);
    maxY = Math.max(maxY, el.from[1], el.to[1]);
    maxZ = Math.max(maxZ, el.from[2], el.to[2]);
  }

  // Either hovers off the floor & below the ceiling (e.g. wall_torch, wall_sign, tripwire_hook)
  // or is a thin climbable wall sheet (e.g. ladder)
  const hoversMidHeight = minY > 0.5 && maxY < 15.5;
  const thinClimbableSheet =
    hasTag(def, "climbable") &&
    Math.min(maxX - minX, maxZ - minZ) <= 3;

  return hoversMidHeight || thinClimbableSheet;
}

function isValidRigidSupport(
  neighbor: VoxelData | undefined,
  nDef: CompiledBlockDefinition | undefined
): boolean {
  if (!neighbor || !nDef || nDef.isFluid) return false;
  if (classifyBlockConnectionKind(nDef) === "multiface_clinging") {
    return false;
  }
  return true;
}

/**
 * Formats a `BuildLintReport` summary text with line numbers and actionable hints.
 */
export function formatLintReportSummary(issues: BuildLintIssue[]): string {
  if (issues.length === 0) {
    return "Vanilla Building Linter: PASSED (0 spec/support issues detected).";
  }

  const lines: string[] = [];
  lines.push(
    `Vanilla Building Linter: ${issues.length} issue(s) detected. Fix the corresponding DSL lines below:`
  );
  for (const issue of issues) {
    const stateStr =
      issue.state && Object.keys(issue.state).length > 0
        ? `[${Object.entries(issue.state)
            .map(([k, v]) => `${k}=${v}`)
            .join(",")}]`
        : "";
    const traceStr =
      issue.line !== undefined
        ? `Line ${issue.line}${issue.codeSnippet ? ` (\`${issue.codeSnippet}\`)` : ""}`
        : `opId=${issue.opId}`;
    lines.push(
      `  - [${issue.type}] (${issue.coord.x}, ${issue.coord.y}, ${issue.coord.z}) ${issue.block}${stateStr} -> ${traceStr}`
    );
    lines.push(`    Reason: ${issue.message}`);
    lines.push(`    Hint: ${issue.hint}`);
  }
  return lines.join("\n");
}

/**
 * Static Vanilla Building Linter:
 * Scans all build voxels in the world and detects Minecraft block-spec mismatches:
 * 1. `axis_mismatch_junction`: Slender single-axis blocks (such as chains) adjacent to
 *    another slender single-axis block with a different `axis` (T-junction / L-junction break).
 * 2. `missing_support`: Wall-clinging multiface blocks (vines, glow_lichen, etc.),
 *    hanging/standing blocks (`hanging=true/false` such as lanterns), or wall/ceiling/floor-mounted
 *    blocks (`attachment`, `face`, wall torches/signs/ladders) whose required supporting neighbor is air
 *    or structurally incompatible.
 */
export function lintWorldStructure(
  voxels: VoxelData[],
  blockModels?: Record<string, CompiledBlockDefinition>,
  traces?: Map<number, TraceRecord> | Record<number, TraceRecord>,
  explicitStateKeysMap?: Map<string, Set<string>>
): BuildLintReport {
  const voxelMap = new Map<string, VoxelData>();
  for (const v of voxels) {
    voxelMap.set(`${v.x},${v.y},${v.z}`, v);
  }

  const resolvedStates = resolveWorldBlockStates(
    voxels,
    blockModels,
    explicitStateKeysMap
  );

  const getTrace = (opId: number): TraceRecord | undefined => {
    if (!traces || opId <= 0) return undefined;
    if (traces instanceof Map) {
      return traces.get(opId);
    }
    return traces[opId];
  };

  const getEffectiveState = (voxel: VoxelData, def: CompiledBlockDefinition): BlockState => {
    const key = `${voxel.x},${voxel.y},${voxel.z}`;
    const resolved = resolvedStates.get(key);
    if (resolved && Object.keys(resolved).length > 0) {
      return resolved;
    }
    if (voxel.state && Object.keys(voxel.state).length > 0) {
      const normalized: BlockState = {};
      for (const [k, v] of Object.entries(voxel.state)) {
        normalized[k.toLowerCase()] = String(v).toLowerCase();
      }
      return normalized;
    }
    return {};
  };

  const issues: BuildLintIssue[] = [];

  // Process voxels in descending Y order so top-down hanging support (e.g. hanging vines) is evaluated before lower blocks
  const sortedByYDesc = [...voxels].sort(
    (a, b) => b.y - a.y || a.z - b.z || a.x - b.x
  );
  const supportedMultifaceKeys = new Set<string>();

  for (const voxel of sortedByYDesc) {
    const key = `${voxel.x},${voxel.y},${voxel.z}`;
    const def = getBlockDef(voxel.name, blockModels);
    const kind = classifyBlockConnectionKind(def);
    const state = getEffectiveState(voxel, def);
    const trace = getTrace(voxel.opId);

    // -------------------------------------------------------------------------
    // Check 1: Wall-clinging multiface support (top-down Y order)
    // -------------------------------------------------------------------------
    if (kind === "multiface_clinging") {
      const dirValues = collectMultipartPropValues(def);
      const supportedDirs = ALL_DIRS.filter((d) => Boolean(dirValues[d]));
      const activeDirs = supportedDirs.filter((d) => state[d] === "true");

      const explicitKeys = explicitStateKeysMap?.get(key);
      const rawExplicitTrueDirs = supportedDirs.filter((d) => {
        if (explicitKeys) {
          return explicitKeys.has(d) && state[d] === "true";
        }
        return (
          voxel.state !== undefined &&
          String(voxel.state[d] ?? "").toLowerCase() === "true"
        );
      });

      const isDirectionBackedBySupport = (dir: (typeof ALL_DIRS)[number]): boolean => {
        const [dx, dy, dz] = DIR_VECTORS[dir];
        const neighbor = voxelMap.get(`${voxel.x + dx},${voxel.y + dy},${voxel.z + dz}`);
        if (neighbor) {
          const nDef = getBlockDef(neighbor.name, blockModels);
          if (
            !nDef.isFluid &&
            isInstanceFullOpaqueCube(neighbor, nDef, voxelMap, blockModels)
          ) {
            return true;
          }
        }
        // Horizontal hanging continuation from a supported same-block directly above
        if (
          (dir === "north" || dir === "south" || dir === "east" || dir === "west") &&
          Boolean(dirValues.up)
        ) {
          const aboveKey = `${voxel.x},${voxel.y + 1},${voxel.z}`;
          const aboveVoxel = voxelMap.get(aboveKey);
          if (
            aboveVoxel &&
            normalizeShortBlockName(aboveVoxel.name) ===
              normalizeShortBlockName(voxel.name) &&
            supportedMultifaceKeys.has(aboveKey)
          ) {
            const aboveDef = getBlockDef(aboveVoxel.name, blockModels);
            const aboveState = getEffectiveState(aboveVoxel, aboveDef);
            if (aboveState[dir] === "true") {
              return true;
            }
          }
        }
        return false;
      };

      const backedActiveDirs = activeDirs.filter(isDirectionBackedBySupport);
      const unbackedExplicitDirs = rawExplicitTrueDirs.filter(
        (d) => !isDirectionBackedBySupport(d)
      );

      const isSupported =
        backedActiveDirs.length > 0 && unbackedExplicitDirs.length === 0;

      if (isSupported) {
        supportedMultifaceKeys.add(key);
      } else if (!voxel.isTerrain) {
        const missingDirs =
          unbackedExplicitDirs.length > 0 ? unbackedExplicitDirs : supportedDirs;
        issues.push({
          type: "missing_support",
          coord: { x: voxel.x, y: voxel.y, z: voxel.z },
          block: voxel.name,
          ...(Object.keys(state).length > 0 ? { state } : {}),
          opId: voxel.opId,
          ...(trace
            ? { line: trace.line, codeSnippet: trace.codeSnippet, trace }
            : {}),
          message: `Wall-clinging block ${voxel.name} at (${voxel.x}, ${voxel.y}, ${voxel.z}) has no solid supporting block on its attachment face(s) (${missingDirs.join("/")}).`,
          hint: `壁張り付きブロック（${voxel.name}）の支持面（${missingDirs.join("/")}）が空気または非固体ブロックになっており支えがありません。隣接座標に石材・木材などのフルブロック（固体壁・天井）を配置するか、上部の支持された同種ブロックから垂らしてください。`,
        });
      }
      continue;
    }

    if (voxel.isTerrain) {
      continue;
    }

    // -------------------------------------------------------------------------
    // Check 2: Single-axis slender block cross-axis adjacency (T-junction / L-junction break)
    // -------------------------------------------------------------------------
    if (isSlenderAxisBlock(voxel, def, blockModels)) {
      const axisA = (
        state.axis ??
        voxel.state?.axis ??
        getDefaultPropValue(def, "axis") ??
        "y"
      ).toLowerCase();

      const crossNeighbors: Array<{
        voxel: VoxelData;
        axis: string;
      }> = [];

      for (const dir of ALL_DIRS) {
        const [dx, dy, dz] = DIR_VECTORS[dir];
        const neighbor = voxelMap.get(`${voxel.x + dx},${voxel.y + dy},${voxel.z + dz}`);
        if (!neighbor) continue;
        const nDef = getBlockDef(neighbor.name, blockModels);
        if (!isSlenderAxisBlock(neighbor, nDef, blockModels)) continue;

        const nState = getEffectiveState(neighbor, nDef);
        const axisB = (
          nState.axis ??
          neighbor.state?.axis ??
          getDefaultPropValue(nDef, "axis") ??
          "y"
        ).toLowerCase();

        if (axisA !== axisB) {
          crossNeighbors.push({ voxel: neighbor, axis: axisB });
        }
      }

      if (crossNeighbors.length > 0) {
        const firstCross = crossNeighbors[0];
        const effectiveAxisState: BlockState = {
          ...state,
          axis: axisA,
        };
        issues.push({
          type: "axis_mismatch_junction",
          coord: { x: voxel.x, y: voxel.y, z: voxel.z },
          block: voxel.name,
          state: effectiveAxisState,
          opId: voxel.opId,
          ...(trace
            ? { line: trace.line, codeSnippet: trace.codeSnippet, trace }
            : {}),
          relatedCoord: {
            x: firstCross.voxel.x,
            y: firstCross.voxel.y,
            z: firstCross.voxel.z,
          },
          relatedBlock: firstCross.voxel.name,
          message: `Single-axis slender block ${voxel.name}[axis=${axisA}] at (${voxel.x}, ${voxel.y}, ${voxel.z}) directly adjoins cross-axis block ${firstCross.voxel.name}[axis=${firstCross.axis}] at (${firstCross.voxel.x}, ${firstCross.voxel.y}, ${firstCross.voxel.z}) (T/L-junction break).`,
          hint: `単軸ブロック（${voxel.name}, axis=${axisA}）と異軸の単軸ブロック（${firstCross.voxel.name}, axis=${firstCross.axis} at (${firstCross.voxel.x}, ${firstCross.voxel.y}, ${firstCross.voxel.z})）が直接隣接しています（T字・L字接続破綻）。Minecraftの鎖等は単一軸しか持てないため、交点座標 (${voxel.x}, ${voxel.y}, ${voxel.z}) または (${firstCross.voxel.x}, ${firstCross.voxel.y}, ${firstCross.voxel.z}) にフェンス（*_fence）・塀（*_wall）・砥石（grindstone）・ホッパー（hopper）・フルブロック等の接続中継パーツを挟んでください。`,
        });
      }
    }

    // -------------------------------------------------------------------------
    // Check 3: `hanging` property blocks (e.g. lanterns, hanging propagules)
    // -------------------------------------------------------------------------
    const existingDef = getExistingBlockDef(voxel.name, blockModels);
    const hasHangingProp =
      hasVariantProp(def, "hanging") ||
      hasTag(def, "lanterns") ||
      voxel.state?.hanging !== undefined;

    if (hasHangingProp) {
      const hangingVal = (
        state.hanging ??
        voxel.state?.hanging ??
        getDefaultPropValue(def, "hanging") ??
        "false"
      ).toLowerCase();

      if (hangingVal === "true") {
        const aboveCoord = { x: voxel.x, y: voxel.y + 1, z: voxel.z };
        const aboveKey = `${aboveCoord.x},${aboveCoord.y},${aboveCoord.z}`;
        const aboveVoxel = voxelMap.get(aboveKey);
        const aboveDef = aboveVoxel
          ? getBlockDef(aboveVoxel.name, blockModels)
          : undefined;

        let aboveIsHorizontalSlender = false;
        if (
          aboveVoxel &&
          aboveDef &&
          isSlenderAxisBlock(aboveVoxel, aboveDef, blockModels)
        ) {
          const aboveState = getEffectiveState(aboveVoxel, aboveDef);
          const aboveAxis = (
            aboveState.axis ??
            aboveVoxel.state?.axis ??
            getDefaultPropValue(aboveDef, "axis") ??
            "y"
          ).toLowerCase();
          if (aboveAxis !== "y") {
            aboveIsHorizontalSlender = true;
          }
        }

        if (
          !isValidRigidSupport(aboveVoxel, aboveDef) ||
          aboveIsHorizontalSlender
        ) {
          issues.push({
            type: "missing_support",
            coord: { x: voxel.x, y: voxel.y, z: voxel.z },
            block: voxel.name,
            state: { ...state, hanging: "true" },
            opId: voxel.opId,
            ...(trace
              ? { line: trace.line, codeSnippet: trace.codeSnippet, trace }
              : {}),
            relatedCoord: aboveCoord,
            ...(aboveVoxel ? { relatedBlock: aboveVoxel.name } : {}),
            message: !aboveVoxel
              ? `Hanging block ${voxel.name}[hanging=true] at (${voxel.x}, ${voxel.y}, ${voxel.z}) has air at its ceiling support (${aboveCoord.x}, ${aboveCoord.y}, ${aboveCoord.z}).`
              : `Hanging block ${voxel.name}[hanging=true] at (${voxel.x}, ${voxel.y}, ${voxel.z}) lacks valid vertical ceiling support at (${aboveCoord.x}, ${aboveCoord.y}, ${aboveCoord.z}) (found ${aboveVoxel.name}).`,
            hint: !aboveVoxel
              ? `吊り下げブロック（${voxel.name}, hanging=true）の直上 (${aboveCoord.x}, ${aboveCoord.y}, ${aboveCoord.z}) が空気になっており支えがありません。直上に天井ブロック・フェンス・塀・縦向きの鎖（axis=y）等の支持体を配置するか、床置き（hanging=false）に変更してください。`
              : `吊り下げブロック（${voxel.name}, hanging=true）の直上 (${aboveCoord.x}, ${aboveCoord.y}, ${aboveCoord.z}) のブロック（${aboveVoxel.name}）は下方向の吊り下げ支持面を持ちません（横向きの鎖など）。交点となる直上座標にフェンス・塀・砥石・フルブロックまたは縦向きの鎖（axis=y）を配置してください。`,
          });
        }
      } else if (voxel.y > 0) {
        const belowCoord = { x: voxel.x, y: voxel.y - 1, z: voxel.z };
        const belowKey = `${belowCoord.x},${belowCoord.y},${belowCoord.z}`;
        const belowVoxel = voxelMap.get(belowKey);
        const belowDef = belowVoxel
          ? getBlockDef(belowVoxel.name, blockModels)
          : undefined;

        if (!isValidRigidSupport(belowVoxel, belowDef)) {
          issues.push({
            type: "missing_support",
            coord: { x: voxel.x, y: voxel.y, z: voxel.z },
            block: voxel.name,
            state: { ...state, hanging: "false" },
            opId: voxel.opId,
            ...(trace
              ? { line: trace.line, codeSnippet: trace.codeSnippet, trace }
              : {}),
            relatedCoord: belowCoord,
            message: `Floor-standing block ${voxel.name}[hanging=false] at (${voxel.x}, ${voxel.y}, ${voxel.z}) has no supporting block below at (${belowCoord.x}, ${belowCoord.y}, ${belowCoord.z}).`,
            hint: `床置き状態（${voxel.name}, hanging=false）の直下 (${belowCoord.x}, ${belowCoord.y}, ${belowCoord.z}) が空気（または非支持ブロック）です。直下に床・テーブル・フェンス等の支持体を配置するか、直上に天井がある場合は hanging=true を指定してください。`,
          });
        }
      }
      continue;
    }

    // -------------------------------------------------------------------------
    // Check 4: `attachment` / `face` blocks (bell, grindstone, lever, buttons)
    //          and wall-mounted directional thin blocks (wall_torch, wall_sign, ladder)
    // -------------------------------------------------------------------------
    if (existingDef && hasVariantProp(existingDef, "attachment")) {
      const att = (
        state.attachment ??
        voxel.state?.attachment ??
        getDefaultPropValue(existingDef, "attachment") ??
        "floor"
      ).toLowerCase();
      const facing = (
        state.facing ??
        voxel.state?.facing ??
        getDefaultPropValue(existingDef, "facing") ??
        "north"
      ).toLowerCase();

      if (att === "ceiling") {
        const aboveVoxel = voxelMap.get(`${voxel.x},${voxel.y + 1},${voxel.z}`);
        const aboveDef = aboveVoxel
          ? getBlockDef(aboveVoxel.name, blockModels)
          : undefined;
        if (!isValidRigidSupport(aboveVoxel, aboveDef)) {
          issues.push({
            type: "missing_support",
            coord: { x: voxel.x, y: voxel.y, z: voxel.z },
            block: voxel.name,
            state: { ...state, attachment: att, facing },
            opId: voxel.opId,
            ...(trace
              ? { line: trace.line, codeSnippet: trace.codeSnippet, trace }
              : {}),
            relatedCoord: { x: voxel.x, y: voxel.y + 1, z: voxel.z },
            message: `Ceiling-attached block ${voxel.name}[attachment=ceiling] at (${voxel.x}, ${voxel.y}, ${voxel.z}) has no support block above at (${voxel.x}, ${voxel.y + 1}, ${voxel.z}).`,
            hint: `天井設置（attachment=ceiling）の ${voxel.name} の直上 (${voxel.x}, ${voxel.y + 1}, ${voxel.z}) が空気です。直上に天井ブロックを配置するか attachment を変更してください。`,
          });
        }
      } else if (att === "floor" && voxel.y > 0) {
        const belowVoxel = voxelMap.get(`${voxel.x},${voxel.y - 1},${voxel.z}`);
        const belowDef = belowVoxel
          ? getBlockDef(belowVoxel.name, blockModels)
          : undefined;
        if (!isValidRigidSupport(belowVoxel, belowDef)) {
          issues.push({
            type: "missing_support",
            coord: { x: voxel.x, y: voxel.y, z: voxel.z },
            block: voxel.name,
            state: { ...state, attachment: att, facing },
            opId: voxel.opId,
            ...(trace
              ? { line: trace.line, codeSnippet: trace.codeSnippet, trace }
              : {}),
            relatedCoord: { x: voxel.x, y: voxel.y - 1, z: voxel.z },
            message: `Floor-attached block ${voxel.name}[attachment=floor] at (${voxel.x}, ${voxel.y}, ${voxel.z}) has no support block below at (${voxel.x}, ${voxel.y - 1}, ${voxel.z}).`,
            hint: `床設置（attachment=floor）の ${voxel.name} の直下 (${voxel.x}, ${voxel.y - 1}, ${voxel.z}) が空気です。直下に支持ブロックを配置してください。`,
          });
        }
      } else if (att === "single_wall" || att === "double_wall") {
        const [fx, fz] = horizDelta(facing);
        const n1 = voxelMap.get(`${voxel.x + fx},${voxel.y},${voxel.z + fz}`);
        const n2 = voxelMap.get(`${voxel.x - fx},${voxel.y},${voxel.z - fz}`);
        const s1 = isValidRigidSupport(
          n1,
          n1 ? getBlockDef(n1.name, blockModels) : undefined
        );
        const s2 = isValidRigidSupport(
          n2,
          n2 ? getBlockDef(n2.name, blockModels) : undefined
        );
        const ok = att === "double_wall" ? s1 && s2 : s1 || s2;
        if (!ok) {
          issues.push({
            type: "missing_support",
            coord: { x: voxel.x, y: voxel.y, z: voxel.z },
            block: voxel.name,
            state: { ...state, attachment: att, facing },
            opId: voxel.opId,
            ...(trace
              ? { line: trace.line, codeSnippet: trace.codeSnippet, trace }
              : {}),
            message: `Wall-attached block ${voxel.name}[attachment=${att},facing=${facing}] at (${voxel.x}, ${voxel.y}, ${voxel.z}) lacks required wall support along its facing axis.`,
            hint: `壁設置（attachment=${att}）の ${voxel.name} の接続方向（facing=${facing}）に支持壁がありません。隣接する壁ブロックを配置するか向き（facing）を修正してください。`,
          });
        }
      }
      continue;
    }

    if (existingDef && hasVariantProp(existingDef, "face")) {
      const faceVal = (
        state.face ??
        voxel.state?.face ??
        getDefaultPropValue(existingDef, "face") ??
        "wall"
      ).toLowerCase();
      const facing = (
        state.facing ??
        voxel.state?.facing ??
        getDefaultPropValue(existingDef, "facing") ??
        "north"
      ).toLowerCase();

      if (faceVal === "ceiling") {
        const aboveVoxel = voxelMap.get(`${voxel.x},${voxel.y + 1},${voxel.z}`);
        const aboveDef = aboveVoxel
          ? getBlockDef(aboveVoxel.name, blockModels)
          : undefined;
        if (!isValidRigidSupport(aboveVoxel, aboveDef)) {
          issues.push({
            type: "missing_support",
            coord: { x: voxel.x, y: voxel.y, z: voxel.z },
            block: voxel.name,
            state: { ...state, face: faceVal, facing },
            opId: voxel.opId,
            ...(trace
              ? { line: trace.line, codeSnippet: trace.codeSnippet, trace }
              : {}),
            relatedCoord: { x: voxel.x, y: voxel.y + 1, z: voxel.z },
            message: `Ceiling-mounted block ${voxel.name}[face=ceiling] at (${voxel.x}, ${voxel.y}, ${voxel.z}) has no support block above at (${voxel.x}, ${voxel.y + 1}, ${voxel.z}).`,
            hint: `天井設置（face=ceiling）の ${voxel.name} の直上 (${voxel.x}, ${voxel.y + 1}, ${voxel.z}) が空気です。直上に天井ブロックを配置するか face を変更してください。`,
          });
        }
      } else if (faceVal === "floor" && voxel.y > 0) {
        const belowVoxel = voxelMap.get(`${voxel.x},${voxel.y - 1},${voxel.z}`);
        const belowDef = belowVoxel
          ? getBlockDef(belowVoxel.name, blockModels)
          : undefined;
        if (!isValidRigidSupport(belowVoxel, belowDef)) {
          issues.push({
            type: "missing_support",
            coord: { x: voxel.x, y: voxel.y, z: voxel.z },
            block: voxel.name,
            state: { ...state, face: faceVal, facing },
            opId: voxel.opId,
            ...(trace
              ? { line: trace.line, codeSnippet: trace.codeSnippet, trace }
              : {}),
            relatedCoord: { x: voxel.x, y: voxel.y - 1, z: voxel.z },
            message: `Floor-mounted block ${voxel.name}[face=floor] at (${voxel.x}, ${voxel.y}, ${voxel.z}) has no support block below at (${voxel.x}, ${voxel.y - 1}, ${voxel.z}).`,
            hint: `床設置（face=floor）の ${voxel.name} の直下 (${voxel.x}, ${voxel.y - 1}, ${voxel.z}) が空気です。直下に支持ブロックを配置してください。`,
          });
        }
      } else if (faceVal === "wall") {
        const [fx, fz] = horizDelta(facing);
        const backCoord = { x: voxel.x - fx, y: voxel.y, z: voxel.z - fz };
        const frontCoord = { x: voxel.x + fx, y: voxel.y, z: voxel.z + fz };
        const nBack = voxelMap.get(`${backCoord.x},${backCoord.y},${backCoord.z}`);
        const nFront = voxelMap.get(`${frontCoord.x},${frontCoord.y},${frontCoord.z}`);
        const sBack = isValidRigidSupport(
          nBack,
          nBack ? getBlockDef(nBack.name, blockModels) : undefined
        );
        const sFront = isValidRigidSupport(
          nFront,
          nFront ? getBlockDef(nFront.name, blockModels) : undefined
        );
        if (!sBack && !sFront) {
          issues.push({
            type: "missing_support",
            coord: { x: voxel.x, y: voxel.y, z: voxel.z },
            block: voxel.name,
            state: { ...state, face: faceVal, facing },
            opId: voxel.opId,
            ...(trace
              ? { line: trace.line, codeSnippet: trace.codeSnippet, trace }
              : {}),
            relatedCoord: backCoord,
            message: `Wall-mounted block ${voxel.name}[face=wall,facing=${facing}] at (${voxel.x}, ${voxel.y}, ${voxel.z}) has no supporting wall at (${backCoord.x}, ${backCoord.y}, ${backCoord.z}).`,
            hint: `壁設置（face=wall）の ${voxel.name} の接続方向（facing=${facing}）に支持壁がありません。隣接する壁ブロックを配置するか face / facing を修正してください。`,
          });
        }
      }
      continue;
    }

    if (existingDef && isWallMountedDirectionalBlock(existingDef)) {
      const facing = (
        state.facing ??
        voxel.state?.facing ??
        getDefaultPropValue(existingDef, "facing") ??
        "north"
      ).toLowerCase();
      const [fx, fz] = horizDelta(facing);
      const backCoord = { x: voxel.x - fx, y: voxel.y, z: voxel.z - fz };
      const backVoxel = voxelMap.get(`${backCoord.x},${backCoord.y},${backCoord.z}`);
      const backDef = backVoxel
        ? getBlockDef(backVoxel.name, blockModels)
        : undefined;

      if (!isValidRigidSupport(backVoxel, backDef)) {
        issues.push({
          type: "missing_support",
          coord: { x: voxel.x, y: voxel.y, z: voxel.z },
          block: voxel.name,
          state: { ...state, facing },
          opId: voxel.opId,
          ...(trace
            ? { line: trace.line, codeSnippet: trace.codeSnippet, trace }
            : {}),
          relatedCoord: backCoord,
          message: `Wall-mounted block ${voxel.name}[facing=${facing}] at (${voxel.x}, ${voxel.y}, ${voxel.z}) has air at its backing wall (${backCoord.x}, ${backCoord.y}, ${backCoord.z}).`,
          hint: `壁掛けブロック（${voxel.name}, facing=${facing}）の背面 (${backCoord.x}, ${backCoord.y}, ${backCoord.z}) が空気になっており支えがありません。背面に壁ブロックを配置するか、壁がある方向に facing を合わせてください。`,
        });
      }
    }
  }

  // Sort issues deterministically by line/opId, then y, z, x
  issues.sort(
    (a, b) =>
      (a.line ?? a.opId) - (b.line ?? b.opId) ||
      a.coord.y - b.coord.y ||
      a.coord.z - b.coord.z ||
      a.coord.x - b.coord.x
  );

  const countsByType: Record<BuildLintIssueType, number> = {
    axis_mismatch_junction: 0,
    missing_support: 0,
  };
  for (const issue of issues) {
    countsByType[issue.type]++;
  }

  return {
    valid: issues.length === 0,
    issueCount: issues.length,
    countsByType,
    issues,
    summaryText: formatLintReportSummary(issues),
  };
}

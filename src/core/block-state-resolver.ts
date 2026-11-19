import type {
  AppliedModelRef,
  BlockState,
  CompiledBlockDefinition,
  McFaceDirection,
  MultipartCondition,
  VoxelData,
} from "../types/shared.js";

export const ALL_DIRS: McFaceDirection[] = [
  "down",
  "up",
  "north",
  "south",
  "west",
  "east",
];

export const CARDINAL_DIRS = ["north", "south", "east", "west"] as const;

export const DIR_VECTORS: Record<McFaceDirection, [number, number, number]> = {
  down: [0, -1, 0],
  up: [0, 1, 0],
  north: [0, 0, -1],
  south: [0, 0, 1],
  west: [-1, 0, 0],
  east: [1, 0, 0],
};

export const CANONICAL_STATE_DEFAULTS: Record<string, string> = {
  facing: "north",
  half: "bottom",
  type: "bottom",
  shape: "straight",
  axis: "y",
  hanging: "false",
  open: "false",
  powered: "false",
  waterlogged: "false",
  up: "true",
  down: "false",
  north: "none",
  south: "none",
  east: "none",
  west: "none",
  snowy: "false",
  lit: "true",
  part: "foot",
  hinge: "left",
  mode: "compare",
  attachment: "floor",
  face: "wall",
  rotation: "0",
  age: "0",
  level: "0",
  stage: "0",
  moisture: "0",
  bites: "0",
  layers: "1",
  eggs: "1",
  pickles: "1",
  honey_level: "0",
  distance: "1",
  persistent: "false",
  extended: "false",
  conditional: "false",
  occupied: "false",
  triggered: "false",
  has_bottle_0: "false",
  has_bottle_1: "false",
  has_bottle_2: "false",
  eye: "false",
  inverted: "false",
  locked: "false",
  in_wall: "false",
  attached: "false",
  disarmed: "false",
  short: "false",
  bottom: "false",
  drag: "true",
};

export function normalizeShortBlockName(name: string): string {
  let clean = name.trim().toLowerCase();
  if (clean.startsWith("minecraft:")) {
    clean = clean.slice("minecraft:".length);
  }
  const bracketIdx = clean.indexOf("[");
  if (bracketIdx !== -1) {
    clean = clean.slice(0, bracketIdx);
  }
  return clean;
}

export function hasTag(def: CompiledBlockDefinition | undefined, tagName: string): boolean {
  if (!def?.tags || def.tags.length === 0) return false;
  const cleanTag = tagName.trim().toLowerCase().replace(/^#/, "").replace(/^minecraft:/, "");
  return def.tags.includes(cleanTag);
}

/**
 * Data-driven default property resolution:
 * Determines the default value for `prop` by inspecting the blockstate's compiled
 * `variants` (unrotated base model orientation and available property values)
 * before falling back to `CANONICAL_STATE_DEFAULTS[prop]`.
 */
export function getDefaultPropValue(
  def: CompiledBlockDefinition,
  prop: string
): string | undefined {
  if (prop === "facing" && def.variants) {
    const entries = Object.entries(def.variants);
    const hasFacingVal = (val: string) =>
      entries.some(([k]) => new RegExp(`(^|,)facing=${val}(,|$)`, "i").test(k));

    // For non-full-cube directional blocks (rods, clusters, hoppers, etc.),
    // inspect which facing variant uses the unrotated base model (`x=0, y=0`).
    if (!def.isFullOpaqueCube) {
      const hasUnrotatedAt = (val: string) =>
        entries.some(
          ([k, refs]) =>
            new RegExp(`(^|,)facing=${val}(,|$)`, "i").test(k) &&
            refs.some((r) => !r.x && !r.y)
        );
      const hasBaseModelUnrotatedAt = (val: string) =>
        entries.some(
          ([k, refs]) =>
            new RegExp(`(^|,)facing=${val}(,|$)`, "i").test(k) &&
            refs.some((r) => !r.x && !r.y && r.model === normalizeShortBlockName(def.blockName))
        );

      if (hasUnrotatedAt("up") && !hasUnrotatedAt("north")) {
        return "up";
      }
      if (hasBaseModelUnrotatedAt("down") && !hasBaseModelUnrotatedAt("north")) {
        return "down";
      }
    }

    if (hasFacingVal("north")) {
      return "north";
    }
    for (const candidate of ["up", "down", "south", "east", "west"]) {
      if (hasFacingVal(candidate)) {
        return candidate;
      }
    }
  }
  return CANONICAL_STATE_DEFAULTS[prop];
}

export function getFallbackBlockDef(blockName: string): CompiledBlockDefinition {
  const shortName = normalizeShortBlockName(blockName);
  const faces = Object.fromEntries(
    ALL_DIRS.map((dir) => [dir, { textureKey: shortName, cullface: dir }])
  );
  return {
    blockName: shortName,
    variants: { "": [{ model: shortName }] },
    models: {
      [shortName]: [{ from: [0, 0, 0], to: [16, 16, 16], faces }],
    },
    isFullOpaqueCube: true,
    isFluid: false,
    isTranslucent: false,
  };
}

export function getBlockDef(
  blockName: string,
  blockModels?: Record<string, CompiledBlockDefinition>
): CompiledBlockDefinition {
  if (blockModels) {
    const direct = blockModels[blockName];
    if (direct) return direct;
    const shortName = normalizeShortBlockName(blockName);
    const byShort = blockModels[shortName];
    if (byShort) return byShort;
    const byPrefixed = blockModels[`minecraft:${shortName}`];
    if (byPrefixed) return byPrefixed;
  }
  return getFallbackBlockDef(blockName);
}

export function getExistingBlockDef(
  blockName: string,
  blockModels?: Record<string, CompiledBlockDefinition>
): CompiledBlockDefinition | undefined {
  if (!blockModels) return undefined;
  const direct = blockModels[blockName];
  if (direct) return direct;
  const shortName = normalizeShortBlockName(blockName);
  return blockModels[shortName] ?? blockModels[`minecraft:${shortName}`];
}

export function collectMultipartPropValues(
  def: CompiledBlockDefinition
): Record<string, Set<string>> {
  const map: Record<string, Set<string>> = {};
  if (!def.multipart) return map;

  const visit = (cond?: MultipartCondition) => {
    if (!cond) return;
    if (Array.isArray(cond.OR)) cond.OR.forEach(visit);
    if (Array.isArray(cond.AND)) cond.AND.forEach(visit);
    for (const [k, rawVal] of Object.entries(cond)) {
      if (k === "OR" || k === "AND" || rawVal === undefined) continue;
      const prop = k.toLowerCase();
      if (!map[prop]) map[prop] = new Set();
      for (const opt of String(rawVal).toLowerCase().split("|")) {
        map[prop].add(opt.trim());
      }
    }
  };

  for (const mc of def.multipart) {
    visit(mc.when);
  }
  return map;
}

export function collectVariantPropValues(
  def: CompiledBlockDefinition
): Record<string, Set<string>> {
  const map: Record<string, Set<string>> = {};
  if (!def.variants) return map;

  for (const key of Object.keys(def.variants)) {
    if (!key) continue;
    for (const pair of key.split(",")) {
      const eqIdx = pair.indexOf("=");
      if (eqIdx === -1) continue;
      const prop = pair.slice(0, eqIdx).trim().toLowerCase();
      const val = pair.slice(eqIdx + 1).trim().toLowerCase();
      if (!map[prop]) map[prop] = new Set();
      map[prop].add(val);
    }
  }
  return map;
}

export function hasVariantProp(
  def: CompiledBlockDefinition,
  propName: string
): boolean {
  if (!def.variants) return false;
  const token = `${propName.toLowerCase()}=`;
  return Object.keys(def.variants).some((k) => k.toLowerCase().includes(token));
}

export type BlockConnectionKind =
  | "multiface_clinging"
  | "wall"
  | "fence"
  | "pane_or_bar"
  | "stairs"
  | "fence_gate"
  | "none";

function isBooleanOnlySet(set?: Set<string>): boolean {
  if (!set || set.size === 0) return false;
  for (const v of set) {
    if (v !== "true" && v !== "false") return false;
  }
  return true;
}

function hasAllFalseFallbackMultipart(def: CompiledBlockDefinition): boolean {
  if (!def.multipart) return false;
  const checkCond = (cond?: MultipartCondition): boolean => {
    if (!cond) return false;
    if (Array.isArray(cond.OR) && cond.OR.some(checkCond)) return true;
    if (Array.isArray(cond.AND) && cond.AND.some(checkCond)) return true;
    let falseDirCount = 0;
    for (const dir of ALL_DIRS) {
      if (cond[dir] !== undefined && String(cond[dir]).toLowerCase() === "false") {
        falseDirCount++;
      } else if (cond[dir] !== undefined) {
        return false;
      }
    }
    return falseDirCount >= 4;
  };
  return def.multipart.some((mc) => checkCond(mc.when));
}

function isStairBlockDef(def: CompiledBlockDefinition): boolean {
  if (hasTag(def, "stairs")) return true;
  if (!def.variants) return false;
  const vProps = collectVariantPropValues(def);
  return Boolean(
    vProps.facing &&
      vProps.half &&
      vProps.shape &&
      (vProps.shape.has("inner_left") || vProps.shape.has("outer_left"))
  );
}

function isFenceGateBlockDef(def: CompiledBlockDefinition): boolean {
  if (hasTag(def, "fence_gates")) return true;
  if (!def.variants) return false;
  const vProps = collectVariantPropValues(def);
  return Boolean(vProps.facing && vProps.in_wall && vProps.open);
}

/**
 * Classifies a block's neighbor-connection behavior strictly from its compiled
 * JAR tags (`data/minecraft/tags/block(s)/*.json`) and blockstate property schema
 * (`multipart` / `variants`) without any hardcoded block names.
 */
export function classifyBlockConnectionKind(
  def: CompiledBlockDefinition
): BlockConnectionKind {
  if (def.multipart && def.multipart.length > 0) {
    const dirValues = collectMultipartPropValues(def);
    const hasAllCardinals = CARDINAL_DIRS.every((d) => Boolean(dirValues[d]));
    if (!hasAllCardinals) {
      return "none";
    }

    const usesWallHeights = CARDINAL_DIRS.every(
      (d) => dirValues[d].has("low") || dirValues[d].has("tall")
    );
    // Wall: tagged #walls, or has 4 cardinal low|tall properties + up post property (and no bottom property like pale_moss_carpet)
    if (
      hasTag(def, "walls") ||
      (usesWallHeights && Boolean(dirValues.up) && !dirValues.bottom)
    ) {
      return "wall";
    }

    const hasUnconditionalPart = def.multipart.some((mc) => !mc.when);
    const cardinalsBoolean = CARDINAL_DIRS.every((d) => isBooleanOnlySet(dirValues[d]));

    // Wall-clinging multiface blocks (e.g. vine, glow_lichen, sculk_vein, resin_clump):
    // - No unconditional center post part
    // - All 4 cardinals + up (and optional down) are boolean properties
    // - Has an all-false fallback condition (when all faces are false)
    if (
      !hasUnconditionalPart &&
      cardinalsBoolean &&
      isBooleanOnlySet(dirValues.up) &&
      (!dirValues.down || isBooleanOnlySet(dirValues.down)) &&
      hasAllFalseFallbackMultipart(def)
    ) {
      return "multiface_clinging";
    }

    // Fence: tagged #fences, or has unconditional center post, 4 boolean cardinal arms (true only), no up/down
    if (
      hasTag(def, "fences") ||
      (hasUnconditionalPart &&
        cardinalsBoolean &&
        !dirValues.up &&
        !dirValues.down &&
        CARDINAL_DIRS.every((d) => dirValues[d].has("true") && !dirValues[d].has("false")))
    ) {
      return "fence";
    }

    // Pane / Iron Bars: tagged #bars, or has unconditional post (or all-false post cap) and 4 boolean cardinals with both true and false
    if (
      hasTag(def, "bars") ||
      (hasUnconditionalPart &&
        !hasTag(def, "fences") &&
        cardinalsBoolean &&
        !dirValues.up &&
        !dirValues.down &&
        CARDINAL_DIRS.every((d) => dirValues[d].has("true") && dirValues[d].has("false")))
    ) {
      return "pane_or_bar";
    }

    return "none";
  }

  if (def.variants) {
    if (isStairBlockDef(def)) {
      return "stairs";
    }
    if (isFenceGateBlockDef(def)) {
      return "fence_gate";
    }
  }

  return "none";
}

export function evaluateMultipartCondition(
  cond: MultipartCondition | undefined,
  state: Record<string, string>
): boolean {
  if (!cond) return true;
  if (Array.isArray(cond.OR)) {
    if (!cond.OR.some((sub) => evaluateMultipartCondition(sub, state))) {
      return false;
    }
  }
  if (Array.isArray(cond.AND)) {
    if (!cond.AND.every((sub) => evaluateMultipartCondition(sub, state))) {
      return false;
    }
  }
  for (const [k, rawExpected] of Object.entries(cond)) {
    if (k === "OR" || k === "AND" || rawExpected === undefined) continue;
    const prop = k.toLowerCase();
    const expectedOpts = String(rawExpected)
      .toLowerCase()
      .split("|")
      .map((s) => s.trim());
    const actual = (
      state[prop] ??
      CANONICAL_STATE_DEFAULTS[prop] ??
      "false"
    ).toLowerCase();
    if (!expectedOpts.includes(actual)) {
      return false;
    }
  }
  return true;
}

function dirLeft(facing: string): "north" | "south" | "east" | "west" {
  switch (facing) {
    case "north":
      return "west";
    case "west":
      return "south";
    case "south":
      return "east";
    case "east":
      return "north";
    default:
      return "west";
  }
}

function dirRight(facing: string): "north" | "south" | "east" | "west" {
  switch (facing) {
    case "north":
      return "east";
    case "east":
      return "south";
    case "south":
      return "west";
    case "west":
      return "north";
    default:
      return "east";
  }
}

function horizDelta(dir: "north" | "south" | "east" | "west" | string): [number, number] {
  switch (dir) {
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

function isPerpendicularGateDirection(
  connectionDir: "north" | "south" | "east" | "west",
  gateFacing: string
): boolean {
  const gf = gateFacing.toLowerCase();
  if (connectionDir === "north" || connectionDir === "south") {
    return gf === "east" || gf === "west";
  }
  return gf === "north" || gf === "south";
}

function resolveVariantModelRefsFromOwnState(
  voxel: VoxelData,
  def: CompiledBlockDefinition
): AppliedModelRef[] {
  if (!def.variants) return [];
  const entries = Object.entries(def.variants);
  if (entries.length === 0) return [];
  if (entries.length === 1 && entries[0][0] === "") {
    return entries[0][1];
  }

  const state: Record<string, string> = {};
  if (voxel.state) {
    for (const [k, v] of Object.entries(voxel.state)) {
      state[k.toLowerCase()] = String(v).toLowerCase();
    }
  }

  const usesType = hasVariantProp(def, "type");
  const usesHalf = hasVariantProp(def, "half");
  if (usesType && !("type" in state) && "half" in state) {
    state.type = state.half;
  }
  if (usesHalf && !("half" in state) && "type" in state) {
    state.half = state.type;
  }

  let bestRefs = entries[0][1];
  let bestScore = -Infinity;

  for (const [key, refs] of entries) {
    if (key === "") {
      if (0 > bestScore) {
        bestScore = 0;
        bestRefs = refs;
      }
      continue;
    }

    const pairs = key.split(",");
    let score = 0;
    let valid = true;

    for (const pair of pairs) {
      const eqIdx = pair.indexOf("=");
      if (eqIdx === -1) continue;
      const prop = pair.slice(0, eqIdx).trim().toLowerCase();
      const val = pair.slice(eqIdx + 1).trim().toLowerCase();

      if (prop in state) {
        if (state[prop] === val) {
          score += 100;
        } else {
          valid = false;
          break;
        }
      } else if (getDefaultPropValue(def, prop) === val) {
        score += 1;
      }
    }

    if (valid && score > bestScore) {
      bestScore = score;
      bestRefs = refs;
    }
  }

  return bestRefs;
}

/**
 * Checks whether a specific voxel instance renders as a full 16x16x16 opaque cube
 * (e.g. standard stone/planks or a `type=double` slab).
 * Does not recurse into neighbor resolution.
 */
export function isInstanceFullOpaqueCube(
  voxel: VoxelData,
  def: CompiledBlockDefinition,
  _voxelMap: Map<string, VoxelData>,
  _blockModels?: Record<string, CompiledBlockDefinition>
): boolean {
  if (def.isFullOpaqueCube) return true;
  if (def.isFluid || def.isTranslucent || !def.variants) return false;

  const refs = resolveVariantModelRefsFromOwnState(voxel, def);
  if (refs.length !== 1) return false;
  const elements = def.models[refs[0].model];
  if (!elements || elements.length === 0) return false;

  const covered = new Set<McFaceDirection>();
  for (const el of elements) {
    if (el.rotation) continue;
    if (
      el.from[0] === 0 &&
      el.from[1] === 0 &&
      el.from[2] === 0 &&
      el.to[0] === 16 &&
      el.to[1] === 16 &&
      el.to[2] === 16
    ) {
      for (const dir of ALL_DIRS) {
        if (el.faces[dir]) covered.add(dir);
      }
    }
  }
  return ALL_DIRS.every((d) => covered.has(d));
}

/**
 * Data-driven connection test for fences, walls, and panes/bars.
 */
export function canConnectorAttach(
  myKind: "fence" | "pane_or_bar" | "wall",
  myDef: CompiledBlockDefinition,
  dir: "north" | "south" | "east" | "west",
  neighbor: VoxelData | undefined,
  nDef: CompiledBlockDefinition | undefined,
  voxelMap: Map<string, VoxelData>,
  blockModels?: Record<string, CompiledBlockDefinition>
): boolean {
  if (!neighbor || !nDef || nDef.isFluid) return false;

  // In Minecraft, fences, walls, and panes/bars never connect to leaves (#minecraft:leaves)
  if (hasTag(nDef, "leaves")) return false;

  // All three connect to full opaque cubes (including double slabs)
  if (isInstanceFullOpaqueCube(neighbor, nDef, voxelMap, blockModels)) {
    return true;
  }

  const nKind = classifyBlockConnectionKind(nDef);

  if (myKind === "fence") {
    if (nKind === "fence") {
      if (nDef.blockName === myDef.blockName) return true;
      // Wooden fences connect to other wooden fences, but not to nether_brick_fence
      if (hasTag(myDef, "wooden_fences") && hasTag(nDef, "wooden_fences")) {
        return true;
      }
      return false;
    }
    if (nKind === "fence_gate") {
      const gateFacing = neighbor.state?.facing ?? getDefaultPropValue(nDef, "facing") ?? "north";
      return isPerpendicularGateDirection(dir, gateFacing);
    }
    return false;
  }

  if (myKind === "pane_or_bar") {
    return nKind === "pane_or_bar" || nKind === "wall";
  }

  if (myKind === "wall") {
    if (nKind === "wall" || nKind === "pane_or_bar") {
      return true;
    }
    if (nKind === "fence_gate") {
      const gateFacing = neighbor.state?.facing ?? getDefaultPropValue(nDef, "facing") ?? "north";
      return isPerpendicularGateDirection(dir, gateFacing);
    }
    return false;
  }

  return false;
}

function computeDynamicStairShape(
  voxel: VoxelData,
  effectiveState: Record<string, string>,
  voxelMap: Map<string, VoxelData>,
  blockModels?: Record<string, CompiledBlockDefinition>
): string {
  const facing = (effectiveState.facing ?? "north").toLowerCase();
  const half = (effectiveState.half ?? "bottom").toLowerCase();

  const getStairState = (
    dx: number,
    dz: number
  ): { facing: string; half: string } | null => {
    const neighbor = voxelMap.get(`${voxel.x + dx},${voxel.y},${voxel.z + dz}`);
    if (!neighbor) return null;
    const nDef = getBlockDef(neighbor.name, blockModels);
    if (!isStairBlockDef(nDef)) return null;
    return {
      facing: (
        neighbor.state?.facing ??
        getDefaultPropValue(nDef, "facing") ??
        "north"
      ).toLowerCase(),
      half: (
        neighbor.state?.half ??
        getDefaultPropValue(nDef, "half") ??
        "bottom"
      ).toLowerCase(),
    };
  };

  const [fx, fz] = horizDelta(facing);
  const front = getStairState(fx, fz);
  const left = dirLeft(facing);
  const right = dirRight(facing);

  if (front && front.half === half) {
    if (front.facing === left) {
      const [rx, rz] = horizDelta(right);
      const side = getStairState(rx, rz);
      if (!side || side.half !== half || side.facing !== facing) {
        return "outer_left";
      }
    } else if (front.facing === right) {
      const [lx, lz] = horizDelta(left);
      const side = getStairState(lx, lz);
      if (!side || side.half !== half || side.facing !== facing) {
        return "outer_right";
      }
    }
  }

  const back = getStairState(-fx, -fz);
  if (back && back.half === half) {
    if (back.facing === left) {
      const [lx, lz] = horizDelta(left);
      const side = getStairState(lx, lz);
      if (!side || side.half !== half || side.facing !== facing) {
        return "inner_left";
      }
    } else if (back.facing === right) {
      const [rx, rz] = horizDelta(right);
      const side = getStairState(rx, rz);
      if (!side || side.half !== half || side.facing !== facing) {
        return "inner_right";
      }
    }
  }

  return "straight";
}

/**
 * Resolves the effective block state for a single voxel by combining any explicit
 * properties in `voxel.state` (or `explicitKeys`) with neighbor-aware automatic
 * connection rules derived from the block's compiled JAR blockstate & tags.
 */
export function resolveEffectiveBlockState(
  voxel: VoxelData,
  def: CompiledBlockDefinition,
  voxelMap: Map<string, VoxelData>,
  blockModels?: Record<string, CompiledBlockDefinition>,
  resolvedStates?: Map<string, BlockState>,
  explicitKeys?: Set<string>
): BlockState {
  const effectiveState: BlockState = {};
  if (voxel.state) {
    for (const [k, v] of Object.entries(voxel.state)) {
      const lowerKey = k.toLowerCase();
      if (!explicitKeys || explicitKeys.has(lowerKey) || explicitKeys.has(k)) {
        effectiveState[lowerKey] = String(v).toLowerCase();
      }
    }
  }

  const initialKeys = new Set<string>(Object.keys(effectiveState));
  const isExplicit = (prop: string): boolean => {
    if (explicitKeys) {
      return explicitKeys.has(prop);
    }
    return initialKeys.has(prop);
  };

  const kind = classifyBlockConnectionKind(def);

  if (kind === "fence" || kind === "pane_or_bar") {
    for (const dir of CARDINAL_DIRS) {
      if (!isExplicit(dir)) {
        const [dx, dz] = horizDelta(dir);
        const neighbor = voxelMap.get(`${voxel.x + dx},${voxel.y},${voxel.z + dz}`);
        const nDef = neighbor ? getBlockDef(neighbor.name, blockModels) : undefined;
        const connected = canConnectorAttach(
          kind,
          def,
          dir,
          neighbor,
          nDef,
          voxelMap,
          blockModels
        );
        effectiveState[dir] = connected ? "true" : "false";
      }
    }
    return effectiveState;
  }

  if (kind === "wall") {
    const aboveKey = `${voxel.x},${voxel.y + 1},${voxel.z}`;
    const aboveVoxel = voxelMap.get(aboveKey);
    const aboveDef = aboveVoxel ? getBlockDef(aboveVoxel.name, blockModels) : undefined;
    const aboveKind = aboveDef ? classifyBlockConnectionKind(aboveDef) : "none";
    const aboveIsSolid = Boolean(
      aboveVoxel &&
        aboveDef &&
        !aboveDef.isFluid &&
        isInstanceFullOpaqueCube(aboveVoxel, aboveDef, voxelMap, blockModels)
    );

    for (const dir of CARDINAL_DIRS) {
      if (!isExplicit(dir)) {
        const [dx, dz] = horizDelta(dir);
        const neighbor = voxelMap.get(`${voxel.x + dx},${voxel.y},${voxel.z + dz}`);
        const nDef = neighbor ? getBlockDef(neighbor.name, blockModels) : undefined;
        const connected = canConnectorAttach(
          "wall",
          def,
          dir,
          neighbor,
          nDef,
          voxelMap,
          blockModels
        );
        if (!connected) {
          effectiveState[dir] = "none";
        } else {
          let raiseToTall = aboveIsSolid;
          if (!raiseToTall && aboveVoxel && aboveDef) {
            if (aboveKind === "wall" || aboveKind === "pane_or_bar") {
              const aboveNeighbor = voxelMap.get(
                `${voxel.x + dx},${voxel.y + 1},${voxel.z + dz}`
              );
              const aboveNDef = aboveNeighbor
                ? getBlockDef(aboveNeighbor.name, blockModels)
                : undefined;
              raiseToTall = canConnectorAttach(
                aboveKind,
                aboveDef,
                dir,
                aboveNeighbor,
                aboveNDef,
                voxelMap,
                blockModels
              );
            }
          }
          effectiveState[dir] = raiseToTall ? "tall" : "low";
        }
      }
    }

    if (!isExplicit("up")) {
      const isConn = (v?: string) => Boolean(v && v !== "false" && v !== "none");
      const nC = isConn(effectiveState.north);
      const sC = isConn(effectiveState.south);
      const eC = isConn(effectiveState.east);
      const wC = isConn(effectiveState.west);
      const straightNS =
        nC && sC && !eC && !wC && effectiveState.north === effectiveState.south;
      const straightEW =
        eC && wC && !nC && !sC && effectiveState.east === effectiveState.west;

      if (aboveVoxel && aboveDef && !aboveDef.isFluid) {
        if (hasTag(aboveDef, "wall_post_override") || aboveKind === "fence_gate") {
          effectiveState.up = "true";
        } else if (aboveKind === "wall") {
          const aboveResolved = resolvedStates?.get(aboveKey) ?? aboveVoxel.state;
          if (aboveResolved?.up) {
            effectiveState.up = aboveResolved.up === "true" ? "true" : "false";
          } else {
            effectiveState.up = straightNS || straightEW ? "false" : "true";
          }
        } else if (!aboveIsSolid) {
          effectiveState.up = "true";
        } else {
          effectiveState.up = straightNS || straightEW ? "false" : "true";
        }
      } else if (straightNS || straightEW) {
        effectiveState.up = "false";
      } else {
        effectiveState.up = "true";
      }
    }

    return effectiveState;
  }

  if (kind === "fence_gate") {
    if (!isExplicit("facing")) {
      effectiveState.facing = getDefaultPropValue(def, "facing") ?? "north";
    }
    if (!isExplicit("open")) {
      effectiveState.open = getDefaultPropValue(def, "open") ?? "false";
    }
    if (!isExplicit("powered")) {
      effectiveState.powered = getDefaultPropValue(def, "powered") ?? "false";
    }
    if (!isExplicit("in_wall")) {
      const facing = effectiveState.facing;
      const sideDirs = [dirLeft(facing), dirRight(facing)];
      const touchesWall = sideDirs.some((d) => {
        const [dx, dz] = horizDelta(d);
        const neighbor = voxelMap.get(`${voxel.x + dx},${voxel.y},${voxel.z + dz}`);
        if (!neighbor) return false;
        const nDef = getBlockDef(neighbor.name, blockModels);
        return classifyBlockConnectionKind(nDef) === "wall";
      });
      effectiveState.in_wall = touchesWall ? "true" : "false";
    }
    return effectiveState;
  }

  if (kind === "stairs") {
    if (!isExplicit("facing")) {
      effectiveState.facing = getDefaultPropValue(def, "facing") ?? "north";
    }
    if (!isExplicit("half")) {
      effectiveState.half = getDefaultPropValue(def, "half") ?? "bottom";
    }
    if (!isExplicit("shape")) {
      effectiveState.shape = computeDynamicStairShape(
        voxel,
        effectiveState,
        voxelMap,
        blockModels
      );
    }
    return effectiveState;
  }

  if (kind === "multiface_clinging") {
    const dirValues = collectMultipartPropValues(def);
    const supportedDirs = ALL_DIRS.filter((d) => Boolean(dirValues[d]));
    const hasAnyExplicitTrue = supportedDirs.some(
      (d) => isExplicit(d) && effectiveState[d] === "true"
    );

    if (hasAnyExplicitTrue) {
      // User explicitly chose which face(s) this vine/lichen clings to: default other faces to "false"
      for (const d of supportedDirs) {
        if (!isExplicit(d)) {
          effectiveState[d] = "false";
        }
      }
      return effectiveState;
    }

    // Automatically attach to adjacent full opaque cubes on supported face directions
    let attachedCount = 0;
    for (const d of supportedDirs) {
      if (isExplicit(d)) {
        if (effectiveState[d] === "true") attachedCount++;
        continue;
      }
      const [dx, dy, dz] = DIR_VECTORS[d];
      const neighbor = voxelMap.get(`${voxel.x + dx},${voxel.y + dy},${voxel.z + dz}`);
      if (!neighbor) {
        effectiveState[d] = "false";
        continue;
      }
      const nDef = getBlockDef(neighbor.name, blockModels);
      const isSolid =
        !nDef.isFluid &&
        isInstanceFullOpaqueCube(neighbor, nDef, voxelMap, blockModels);
      effectiveState[d] = isSolid ? "true" : "false";
      if (isSolid) attachedCount++;
    }

    // Hanging vine / multiface propagation:
    // If no adjacent solid block is present, inherit horizontal attachment faces
    // from the same block directly above (y + 1), which is already resolved in top-down Y order
    // (or walked upward if called standalone without a pre-populated resolvedStates map).
    if (attachedCount === 0) {
      const aboveKey = `${voxel.x},${voxel.y + 1},${voxel.z}`;
      const aboveVoxel = voxelMap.get(aboveKey);
      if (
        aboveVoxel &&
        normalizeShortBlockName(aboveVoxel.name) ===
          normalizeShortBlockName(voxel.name)
      ) {
        let aboveState = resolvedStates?.get(aboveKey);
        if (!aboveState) {
          // Standalone call fallback: bounded walk up the hanging column
          let curY = voxel.y + 1;
          while (curY <= voxel.y + 64) {
            const k = `${voxel.x},${curY},${voxel.z}`;
            const vAbove = voxelMap.get(k);
            if (
              !vAbove ||
              normalizeShortBlockName(vAbove.name) !==
                normalizeShortBlockName(voxel.name)
            ) {
              break;
            }
            const candidateState: BlockState = {};
            let foundSolid = false;
            for (const dir of CARDINAL_DIRS) {
              if (vAbove.state?.[dir] === "true") {
                candidateState[dir] = "true";
                foundSolid = true;
                continue;
              }
              const [dx, dz] = horizDelta(dir);
              const n = voxelMap.get(`${vAbove.x + dx},${vAbove.y},${vAbove.z + dz}`);
              if (n) {
                const nDef = getBlockDef(n.name, blockModels);
                if (
                  !nDef.isFluid &&
                  isInstanceFullOpaqueCube(n, nDef, voxelMap, blockModels)
                ) {
                  candidateState[dir] = "true";
                  foundSolid = true;
                }
              }
            }
            if (foundSolid) {
              aboveState = candidateState;
              break;
            }
            curY++;
          }
        }
        if (aboveState) {
          for (const dir of CARDINAL_DIRS) {
            if (!isExplicit(dir) && aboveState[dir] === "true") {
              effectiveState[dir] = "true";
            }
          }
        }
      }
    }

    return effectiveState;
  }

  return effectiveState;
}

/**
 * Resolves effective block states for an entire world of voxels.
 * Processes voxels in descending Y order (`b.y - a.y`) so hanging multiface blocks
 * (2+ blocks tall hanging vines) and stacked walls propagate cleanly from top to bottom.
 */
export function resolveWorldBlockStates(
  voxels: VoxelData[],
  blockModels?: Record<string, CompiledBlockDefinition>,
  explicitStateKeysMap?: Map<string, Set<string>>
): Map<string, BlockState> {
  const voxelMap = new Map<string, VoxelData>();
  for (const v of voxels) {
    voxelMap.set(`${v.x},${v.y},${v.z}`, v);
  }

  const sorted = [...voxels].sort(
    (a, b) => b.y - a.y || a.z - b.z || a.x - b.x
  );
  const resolvedStates = new Map<string, BlockState>();

  for (const voxel of sorted) {
    const key = `${voxel.x},${voxel.y},${voxel.z}`;
    const def = getBlockDef(voxel.name, blockModels);
    const explicitKeys = explicitStateKeysMap?.get(key);
    const state = resolveEffectiveBlockState(
      voxel,
      def,
      voxelMap,
      blockModels,
      resolvedStates,
      explicitKeys
    );
    resolvedStates.set(key, state);
  }

  return resolvedStates;
}

/**
 * Selects the active `AppliedModelRef[]` for a voxel from its compiled `multipart`
 * or `variants` definition using the resolved neighbor-aware block state.
 */
export function resolveActiveModelParts(
  voxel: VoxelData,
  def: CompiledBlockDefinition,
  voxelMap: Map<string, VoxelData>,
  blockModels?: Record<string, CompiledBlockDefinition>,
  resolvedStates?: Map<string, BlockState>
): AppliedModelRef[] {
  const coordKey = `${voxel.x},${voxel.y},${voxel.z}`;
  const effectiveState =
    resolvedStates?.get(coordKey) ??
    resolveEffectiveBlockState(voxel, def, voxelMap, blockModels, resolvedStates);

  if (def.multipart && def.multipart.length > 0) {
    const activeRefs: AppliedModelRef[] = [];
    for (const mc of def.multipart) {
      if (evaluateMultipartCondition(mc.when, effectiveState)) {
        for (const ref of mc.apply) {
          activeRefs.push(ref);
        }
      }
    }
    return activeRefs;
  }

  if (def.variants) {
    const entries = Object.entries(def.variants);
    if (entries.length === 0) return [];
    if (entries.length === 1 && entries[0][0] === "") {
      return entries[0][1];
    }

    const stateCopy: Record<string, string> = { ...effectiveState };
    const usesType = hasVariantProp(def, "type");
    const usesHalf = hasVariantProp(def, "half");
    if (usesType && !("type" in stateCopy) && "half" in stateCopy) {
      stateCopy.type = stateCopy.half;
    }
    if (usesHalf && !("half" in stateCopy) && "type" in stateCopy) {
      stateCopy.half = stateCopy.type;
    }

    let bestRefs = entries[0][1];
    let bestScore = -Infinity;

    for (const [key, refs] of entries) {
      if (key === "") {
        if (0 > bestScore) {
          bestScore = 0;
          bestRefs = refs;
        }
        continue;
      }

      const pairs = key.split(",");
      let score = 0;
      let valid = true;

      for (const pair of pairs) {
        const eqIdx = pair.indexOf("=");
        if (eqIdx === -1) continue;
        const prop = pair.slice(0, eqIdx).trim().toLowerCase();
        const val = pair.slice(eqIdx + 1).trim().toLowerCase();

        if (prop in stateCopy) {
          if (stateCopy[prop] === val) {
            score += 100;
          } else {
            valid = false;
            break;
          }
        } else if (getDefaultPropValue(def, prop) === val) {
          score += 1;
        }
      }

      if (valid && score > bestScore) {
        bestScore = score;
        bestRefs = refs;
      }
    }

    return bestRefs;
  }

  const firstModelKey = Object.keys(def.models)[0];
  return firstModelKey ? [{ model: firstModelKey }] : [];
}

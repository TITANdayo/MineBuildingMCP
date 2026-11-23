import type {
  AppliedModelRef,
  BlockState,
  CompiledBlockDefinition,
  McFaceDirection,
  MultipartCondition,
  VoxelData,
} from "../types/shared.js";
import { coordKey, toShortBlockId } from "./block-name.js";

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

const FALLBACK_MULTIFACE_DIRS: Record<string, McFaceDirection[]> = {
  vine: ["north", "south", "east", "west", "up"],
  glow_lichen: ["down", "up", "north", "south", "west", "east"],
  sculk_vein: ["down", "up", "north", "south", "west", "east"],
  resin_clump: ["down", "up", "north", "south", "west", "east"],
};

const FALLBACK_NON_OPAQUE_EXACT = new Set([
  "vine",
  "glow_lichen",
  "sculk_vein",
  "resin_clump",
  "chain",
  "iron_chain",
  "lantern",
  "soul_lantern",
  "torch",
  "soul_torch",
  "redstone_torch",
  "wall_torch",
  "soul_wall_torch",
  "redstone_wall_torch",
  "lever",
  "bell",
  "grindstone",
  "ladder",
  "tripwire_hook",
  "end_rod",
  "lightning_rod",
  "hopper",
  "iron_bars",
  "glass",
  "glass_pane",
  "tinted_glass",
  "water",
  "lava",
  "rail",
  "powered_rail",
  "detector_rail",
  "activator_rail",
]);

function isFallbackNonOpaqueCubeName(shortName: string): boolean {
  if (FALLBACK_NON_OPAQUE_EXACT.has(shortName)) return true;
  return (
    shortName.endsWith("_fence") ||
    shortName.endsWith("_fence_gate") ||
    shortName.endsWith("_wall") ||
    shortName.endsWith("_stairs") ||
    shortName.endsWith("_slab") ||
    shortName.endsWith("_pane") ||
    shortName.endsWith("_bars") ||
    shortName.endsWith("_door") ||
    shortName.endsWith("_trapdoor") ||
    shortName.endsWith("_torch") ||
    shortName.endsWith("_lantern") &&
      shortName !== "sea_lantern" &&
      shortName !== "jack_o_lantern" ||
    shortName.endsWith("_chain") ||
    shortName.endsWith("_button") ||
    shortName.endsWith("_pressure_plate") ||
    shortName.endsWith("_carpet") ||
    shortName.endsWith("_sign") ||
    shortName.endsWith("_banner") ||
    shortName.endsWith("_bed") ||
    shortName.endsWith("_leaves") ||
    shortName.endsWith("_glass")
  );
}

interface ParsedVariantEntry {
  key: string;
  pairs: Array<[string, string]>;
  refs: AppliedModelRef[];
}

interface CachedDefMetadata {
  parsedVariants?: ParsedVariantEntry[];
  variantPropValues?: Record<string, Set<string>>;
  multipartPropValues?: Record<string, Set<string>>;
  connectionKind?: BlockConnectionKind;
  defaultFacing?: string | null;
}

const defMetaCache = new WeakMap<CompiledBlockDefinition, CachedDefMetadata>();

function getDefMeta(def: CompiledBlockDefinition): CachedDefMetadata {
  let meta = defMetaCache.get(def);
  if (!meta) {
    meta = {};
    defMetaCache.set(def, meta);
  }
  return meta;
}

function getParsedVariants(def: CompiledBlockDefinition): ParsedVariantEntry[] {
  const meta = getDefMeta(def);
  if (meta.parsedVariants) {
    return meta.parsedVariants;
  }
  const parsed: ParsedVariantEntry[] = [];
  if (def.variants) {
    for (const [key, refs] of Object.entries(def.variants)) {
      const pairs: Array<[string, string]> = [];
      if (key !== "") {
        for (const pair of key.split(",")) {
          const eqIdx = pair.indexOf("=");
          if (eqIdx === -1) continue;
          const prop = pair.slice(0, eqIdx).trim().toLowerCase();
          const val = pair.slice(eqIdx + 1).trim().toLowerCase();
          pairs.push([prop, val]);
        }
      }
      parsed.push({ key, pairs, refs });
    }
  }
  meta.parsedVariants = parsed;
  return parsed;
}

export function normalizeShortBlockName(name: string): string {
  return toShortBlockId(name);
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
    const meta = getDefMeta(def);
    if (meta.defaultFacing !== undefined) {
      return meta.defaultFacing ?? CANONICAL_STATE_DEFAULTS.facing;
    }

    const entries = getParsedVariants(def);
    const hasFacingPair = (entry: ParsedVariantEntry, val: string): boolean =>
      entry.pairs.some(([p, v]) => p === "facing" && v === val);
    const hasFacingVal = (val: string): boolean =>
      entries.some((e) => hasFacingPair(e, val));

    let computed: string | null = null;

    // For non-full-cube directional blocks (rods, clusters, hoppers, etc.),
    // inspect which facing variant uses the unrotated base model (`x=0, y=0`).
    if (!def.isFullOpaqueCube) {
      const baseModelName = normalizeShortBlockName(def.blockName);
      const hasUnrotatedAt = (val: string) =>
        entries.some(
          (e) => hasFacingPair(e, val) && e.refs.some((r) => !r.x && !r.y)
        );
      const hasBaseModelUnrotatedAt = (val: string) =>
        entries.some(
          (e) =>
            hasFacingPair(e, val) &&
            e.refs.some((r) => !r.x && !r.y && r.model === baseModelName)
        );

      if (hasUnrotatedAt("up") && !hasUnrotatedAt("north")) {
        computed = "up";
      } else if (hasBaseModelUnrotatedAt("down") && !hasBaseModelUnrotatedAt("north")) {
        computed = "down";
      }
    }

    if (!computed) {
      if (hasFacingVal("north")) {
        computed = "north";
      } else {
        for (const candidate of ["up", "down", "south", "east", "west"]) {
          if (hasFacingVal(candidate)) {
            computed = candidate;
            break;
          }
        }
      }
    }

    meta.defaultFacing = computed;
    return computed ?? CANONICAL_STATE_DEFAULTS.facing;
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
    isFullOpaqueCube: !isFallbackNonOpaqueCubeName(shortName),
    isFluid: shortName === "water" || shortName === "lava",
    isTranslucent:
      shortName === "water" ||
      shortName === "lava" ||
      shortName.endsWith("_stained_glass") ||
      shortName.endsWith("_stained_glass_pane"),
    isFallback: true,
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
  const meta = getDefMeta(def);
  if (meta.multipartPropValues) {
    return meta.multipartPropValues;
  }

  const map: Record<string, Set<string>> = {};
  if (def.multipart) {
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
  }

  meta.multipartPropValues = map;
  return map;
}

export function collectVariantPropValues(
  def: CompiledBlockDefinition
): Record<string, Set<string>> {
  const meta = getDefMeta(def);
  if (meta.variantPropValues) {
    return meta.variantPropValues;
  }

  const map: Record<string, Set<string>> = {};
  for (const entry of getParsedVariants(def)) {
    for (const [prop, val] of entry.pairs) {
      if (!map[prop]) map[prop] = new Set();
      map[prop].add(val);
    }
  }

  meta.variantPropValues = map;
  return map;
}

export function hasVariantProp(
  def: CompiledBlockDefinition,
  propName: string
): boolean {
  if (!def.variants) return false;
  const vProps = collectVariantPropValues(def);
  return propName.toLowerCase() in vProps;
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
  if (def.isFallback) {
    return normalizeShortBlockName(def.blockName).endsWith("_stairs");
  }
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
  if (def.isFallback) {
    return normalizeShortBlockName(def.blockName).endsWith("_fence_gate");
  }
  if (!def.variants) return false;
  const vProps = collectVariantPropValues(def);
  return Boolean(vProps.facing && vProps.in_wall && vProps.open);
}

/**
 * Returns the supported clinging face directions for a `multiface_clinging` block,
 * using compiled multipart properties when available and vanilla defaults only in fallback mode.
 */
export function getMultifaceSupportedDirs(def: CompiledBlockDefinition): McFaceDirection[] {
  const dirValues = collectMultipartPropValues(def);
  const fromMultipart = ALL_DIRS.filter((d) => Boolean(dirValues[d]));
  if (fromMultipart.length > 0) {
    return fromMultipart;
  }
  if (def.isFallback) {
    const shortName = normalizeShortBlockName(def.blockName);
    return FALLBACK_MULTIFACE_DIRS[shortName] ?? [];
  }
  return [];
}

/**
 * Classifies a block's neighbor-connection behavior strictly from its compiled
 * JAR tags (`data/minecraft/tags/block(s)/*.json`) and blockstate property schema
 * (`multipart` / `variants`) whenever JAR data is available, falling back to
 * canonical vanilla name suffixes only when `def.isFallback === true`.
 */
export function classifyBlockConnectionKind(
  def: CompiledBlockDefinition
): BlockConnectionKind {
  const meta = getDefMeta(def);
  if (meta.connectionKind !== undefined) {
    return meta.connectionKind;
  }

  let kind: BlockConnectionKind = "none";

  if (def.multipart && def.multipart.length > 0) {
    const dirValues = collectMultipartPropValues(def);
    const hasAllCardinals = CARDINAL_DIRS.every((d) => Boolean(dirValues[d]));
    if (hasAllCardinals) {
      const usesWallHeights = CARDINAL_DIRS.every(
        (d) => dirValues[d].has("low") || dirValues[d].has("tall")
      );
      const hasUnconditionalPart = def.multipart.some((mc) => !mc.when);
      const cardinalsBoolean = CARDINAL_DIRS.every((d) => isBooleanOnlySet(dirValues[d]));

      if (
        hasTag(def, "walls") ||
        (usesWallHeights && Boolean(dirValues.up) && !dirValues.bottom)
      ) {
        kind = "wall";
      } else if (
        !hasUnconditionalPart &&
        cardinalsBoolean &&
        isBooleanOnlySet(dirValues.up) &&
        (!dirValues.down || isBooleanOnlySet(dirValues.down)) &&
        hasAllFalseFallbackMultipart(def)
      ) {
        kind = "multiface_clinging";
      } else if (
        hasTag(def, "fences") ||
        (hasUnconditionalPart &&
          cardinalsBoolean &&
          !dirValues.up &&
          !dirValues.down &&
          CARDINAL_DIRS.every((d) => dirValues[d].has("true") && !dirValues[d].has("false")))
      ) {
        kind = "fence";
      } else if (
        hasTag(def, "bars") ||
        (hasUnconditionalPart &&
          !hasTag(def, "fences") &&
          cardinalsBoolean &&
          !dirValues.up &&
          !dirValues.down &&
          CARDINAL_DIRS.every((d) => dirValues[d].has("true") && dirValues[d].has("false")))
      ) {
        kind = "pane_or_bar";
      }
    }
  } else if (def.isFallback) {
    const shortName = normalizeShortBlockName(def.blockName);
    if (shortName in FALLBACK_MULTIFACE_DIRS) {
      kind = "multiface_clinging";
    } else if (shortName.endsWith("_wall")) {
      kind = "wall";
    } else if (shortName.endsWith("_fence_gate")) {
      kind = "fence_gate";
    } else if (shortName.endsWith("_fence")) {
      kind = "fence";
    } else if (shortName.endsWith("_pane") || shortName === "iron_bars" || shortName.endsWith("_bars")) {
      kind = "pane_or_bar";
    } else if (shortName.endsWith("_stairs")) {
      kind = "stairs";
    }
  } else if (def.variants) {
    if (isStairBlockDef(def)) {
      kind = "stairs";
    } else if (isFenceGateBlockDef(def)) {
      kind = "fence_gate";
    }
  }

  meta.connectionKind = kind;
  return kind;
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

export function horizDelta(dir: string): [number, number] {
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

function matchVariantModelRefs(
  rawState: Record<string, string>,
  def: CompiledBlockDefinition
): AppliedModelRef[] {
  const entries = getParsedVariants(def);
  if (entries.length === 0) return [];
  if (entries.length === 1 && entries[0].key === "") {
    return entries[0].refs;
  }

  const state: Record<string, string> = { ...rawState };
  const usesType = hasVariantProp(def, "type");
  const usesHalf = hasVariantProp(def, "half");
  if (usesType && !("type" in state) && "half" in state) {
    state.type = state.half;
  }
  if (usesHalf && !("half" in state) && "type" in state) {
    state.half = state.type;
  }

  let bestRefs = entries[0].refs;
  let bestScore = -Infinity;

  for (const entry of entries) {
    if (entry.key === "") {
      if (0 > bestScore) {
        bestScore = 0;
        bestRefs = entry.refs;
      }
      continue;
    }

    let score = 0;
    let valid = true;

    for (const [prop, val] of entry.pairs) {
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
      bestRefs = entry.refs;
    }
  }

  return bestRefs;
}

function resolveVariantModelRefsFromOwnState(
  voxel: VoxelData,
  def: CompiledBlockDefinition
): AppliedModelRef[] {
  if (!def.variants) return [];
  const state: Record<string, string> = {};
  if (voxel.state) {
    for (const [k, v] of Object.entries(voxel.state)) {
      state[k.toLowerCase()] = String(v).toLowerCase();
    }
  }
  return matchVariantModelRefs(state, def);
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
  if (def.isFallback) {
    const shortName = normalizeShortBlockName(def.blockName);
    if (shortName.endsWith("_slab")) {
      const t = (voxel.state?.type ?? voxel.state?.half ?? "").toLowerCase();
      return t === "double";
    }
    return !isFallbackNonOpaqueCubeName(shortName);
  }
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
  if (
    hasTag(nDef, "leaves") ||
    (nDef.isFallback && normalizeShortBlockName(nDef.blockName).endsWith("_leaves"))
  ) {
    return false;
  }

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
      if (
        myDef.isFallback &&
        nDef.isFallback &&
        !myDef.blockName.includes("nether_brick") &&
        !nDef.blockName.includes("nether_brick")
      ) {
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
    const neighbor = voxelMap.get(coordKey(voxel.x + dx, voxel.y, voxel.z + dz));
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
        const neighbor = voxelMap.get(coordKey(voxel.x + dx, voxel.y, voxel.z + dz));
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
    const aboveKey = coordKey(voxel.x, voxel.y + 1, voxel.z);
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
        const neighbor = voxelMap.get(coordKey(voxel.x + dx, voxel.y, voxel.z + dz));
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
                coordKey(voxel.x + dx, voxel.y + 1, voxel.z + dz)
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
      const isStraight = straightNS || straightEW;

      if (aboveVoxel && aboveDef && !aboveDef.isFluid) {
        if (hasTag(aboveDef, "wall_post_override") || aboveKind === "fence_gate") {
          effectiveState.up = "true";
        } else if (aboveKind === "wall") {
          const aboveResolved = resolvedStates?.get(aboveKey) ?? aboveVoxel.state;
          // In vanilla Minecraft, a corner/end wall always keeps its post (`!isStraight`),
          // and a straight wall raises its post if the stacked wall above it has `up=true`.
          effectiveState.up =
            !isStraight || aboveResolved?.up === "true" ? "true" : "false";
        } else if (!aboveIsSolid) {
          effectiveState.up = "true";
        } else {
          effectiveState.up = isStraight ? "false" : "true";
        }
      } else {
        effectiveState.up = isStraight ? "false" : "true";
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
        const neighbor = voxelMap.get(coordKey(voxel.x + dx, voxel.y, voxel.z + dz));
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
    const supportedDirs = getMultifaceSupportedDirs(def);
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
      const neighbor = voxelMap.get(coordKey(voxel.x + dx, voxel.y + dy, voxel.z + dz));
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
      const aboveKey = coordKey(voxel.x, voxel.y + 1, voxel.z);
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
            const k = coordKey(voxel.x, curY, voxel.z);
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
              const n = voxelMap.get(coordKey(vAbove.x + dx, vAbove.y, vAbove.z + dz));
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
    voxelMap.set(coordKey(v.x, v.y, v.z), v);
  }

  const sorted = [...voxels].sort(
    (a, b) => b.y - a.y || a.z - b.z || a.x - b.x
  );
  const resolvedStates = new Map<string, BlockState>();

  for (const voxel of sorted) {
    const key = coordKey(voxel.x, voxel.y, voxel.z);
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
  const key = coordKey(voxel.x, voxel.y, voxel.z);
  const effectiveState =
    resolvedStates?.get(key) ??
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
    return matchVariantModelRefs(effectiveState, def);
  }

  const firstModelKey = Object.keys(def.models)[0];
  return firstModelKey ? [{ model: firstModelKey }] : [];
}

import { BlockState } from "../types/shared.js";
import { normalizeBlockName } from "./voxel-world.js";

export interface BedrockStateTag {
  type: "int" | "byte" | "string";
  value: number | string;
}

export type BedrockStateMap = Record<string, BedrockStateTag>;

const BEDROCK_TO_JAVA_BLOCK_NAMES: Record<string, string> = {
  "minecraft:grass": "minecraft:grass_block",
  "minecraft:grass_path": "minecraft:dirt_path",
  "minecraft:brick_block": "minecraft:bricks",
  "minecraft:stonebrick": "minecraft:stone_bricks",
  "minecraft:wooden_door": "minecraft:oak_door",
  "minecraft:fence": "minecraft:oak_fence",
  "minecraft:trapdoor": "minecraft:oak_trapdoor",
  "minecraft:waterlily": "minecraft:lily_pad",
  "minecraft:web": "minecraft:cobweb",
  "minecraft:deadbush": "minecraft:dead_bush",
  "minecraft:tallgrass": "minecraft:short_grass",
  "minecraft:double_plant": "minecraft:tall_grass",
  "minecraft:lit_pumpkin": "minecraft:jack_o_lantern",
  "minecraft:snow_layer": "minecraft:snow",
  "minecraft:reeds": "minecraft:sugar_cane",
  "minecraft:melon_block": "minecraft:melon",
  "minecraft:magma": "minecraft:magma_block",
  "minecraft:nether_brick": "minecraft:nether_bricks",
  "minecraft:red_nether_brick": "minecraft:red_nether_bricks",
  "minecraft:end_bricks": "minecraft:end_stone_bricks",
  "minecraft:quartz_ore": "minecraft:nether_quartz_ore",
  "minecraft:slime": "minecraft:slime_block",
};

const STAIR_FACING_TO_WEIRDO: Record<string, number> = {
  east: 0,
  west: 1,
  south: 2,
  north: 3,
};

const WEIRDO_TO_STAIR_FACING: Record<number, string> = {
  0: "east",
  1: "west",
  2: "south",
  3: "north",
};

const DOOR_FACING_TO_DIRECTION: Record<string, number> = {
  east: 0,
  south: 1,
  west: 2,
  north: 3,
};

const DIRECTION_TO_DOOR_FACING: Record<number, string> = {
  0: "east",
  1: "south",
  2: "west",
  3: "north",
};

const KNOWN_BOOLEAN_STATE_KEYS = new Set([
  "hanging",
  "open",
  "open_bit",
  "upside_down_bit",
  "upper_block_bit",
  "top_slot_bit",
  "door_hinge_bit",
  "powered",
  "powered_bit",
  "lit",
  "waterlogged",
  "persistent",
  "snowy",
  "enabled",
  "triggered",
  "occupied",
  "signal_fire",
]);

function getShortName(normalizedName: string): string {
  return normalizedName.replace(/^minecraft:/, "");
}

function isStairsBlock(shortName: string): boolean {
  return shortName.endsWith("_stairs");
}

function isSlabBlock(shortName: string): boolean {
  return shortName.endsWith("_slab");
}

function isDoorBlock(shortName: string): boolean {
  return shortName.endsWith("_door") && !shortName.endsWith("trapdoor");
}

function isLanternBlock(shortName: string): boolean {
  return shortName === "lantern" || shortName === "soul_lantern";
}

function isPillarBlock(shortName: string): boolean {
  return (
    shortName.endsWith("_log") ||
    shortName.endsWith("_stem") ||
    shortName.endsWith("_wood") ||
    shortName.endsWith("_hyphae") ||
    shortName.includes("pillar") ||
    shortName.includes("basalt") ||
    shortName.includes("deepslate") ||
    shortName === "hay_block" ||
    shortName === "bone_block" ||
    shortName === "chain"
  );
}

function toBooleanByte(val: string | number | boolean): 0 | 1 {
  if (val === true || val === 1 || val === "1" || val === "true") {
    return 1;
  }
  return 0;
}

function unwrapBedrockStateEntry(raw: unknown): {
  type?: "int" | "byte" | "string" | string;
  value: unknown;
} {
  if (
    raw !== null &&
    typeof raw === "object" &&
    "value" in (raw as Record<string, unknown>)
  ) {
    const obj = raw as { type?: string; value: unknown };
    return { type: obj.type, value: obj.value };
  }
  return { value: raw };
}

/**
 * Translates a Java Edition block name and BlockState into a Bedrock Edition
 * `.mcstructure` block_palette entry (name + typed states map).
 */
export function javaToBedrockState(
  blockName: string,
  javaState?: BlockState
): {
  name: string;
  states: BedrockStateMap;
} {
  const normalizedName = normalizeBlockName(blockName);
  // Keep modern Bedrock canonical names (and map legacy Bedrock "minecraft:grass" to "minecraft:grass_block")
  const bedrockName =
    normalizedName === "minecraft:grass"
      ? "minecraft:grass_block"
      : normalizedName;
  const shortName = getShortName(bedrockName);

  const states: BedrockStateMap = {};
  if (!javaState || Object.keys(javaState).length === 0) {
    return { name: bedrockName, states };
  }

  for (const [rawKey, rawVal] of Object.entries(javaState)) {
    if (rawVal === undefined || rawVal === null) continue;
    const key = rawKey.trim();
    const val = String(rawVal).trim();

    // 1. Stairs (_stairs)
    if (isStairsBlock(shortName)) {
      if (key === "facing") {
        const dir = STAIR_FACING_TO_WEIRDO[val.toLowerCase()] ?? 3;
        states["weirdo_direction"] = { type: "int", value: dir };
        continue;
      }
      if (key === "half") {
        const bit = val.toLowerCase() === "top" ? 1 : 0;
        states["upside_down_bit"] = { type: "byte", value: bit };
        continue;
      }
    }

    // 2. Slabs (_slab)
    if (isSlabBlock(shortName)) {
      if (key === "half" || key === "type") {
        const lower = val.toLowerCase();
        const verticalHalf =
          lower === "top" ? "top" : lower === "double" ? "double" : "bottom";
        states["minecraft:vertical_half"] = {
          type: "string",
          value: verticalHalf,
        };
        continue;
      }
    }

    // 3. Doors (_door)
    if (isDoorBlock(shortName)) {
      if (key === "half") {
        const isUpper =
          val.toLowerCase() === "upper" || val.toLowerCase() === "top";
        states["upper_block_bit"] = { type: "byte", value: isUpper ? 1 : 0 };
        continue;
      }
      if (key === "facing") {
        const dir = DOOR_FACING_TO_DIRECTION[val.toLowerCase()] ?? 3;
        states["direction"] = { type: "int", value: dir };
        continue;
      }
      if (key === "open") {
        states["open_bit"] = { type: "byte", value: toBooleanByte(val) };
        continue;
      }
      if (key === "hinge") {
        states["door_hinge_bit"] = {
          type: "byte",
          value: val.toLowerCase() === "right" ? 1 : 0,
        };
        continue;
      }
    }

    // 4. Lanterns (lantern, soul_lantern)
    if (isLanternBlock(shortName)) {
      if (key === "hanging") {
        states["hanging"] = { type: "byte", value: toBooleanByte(val) };
        continue;
      }
    }

    // 5. Logs / Pillars (_log, _stem, _wood, pillar, basalt, deepslate)
    if (isPillarBlock(shortName)) {
      if (key === "axis") {
        const axis = val.toLowerCase();
        states["pillar_axis"] = {
          type: "string",
          value: axis === "x" || axis === "y" || axis === "z" ? axis : "y",
        };
        continue;
      }
    }

    // 6. Generic fallback
    const lowerVal = val.toLowerCase();
    if (lowerVal === "true") {
      states[key] = { type: "byte", value: 1 };
    } else if (lowerVal === "false") {
      states[key] = { type: "byte", value: 0 };
    } else if (/^-?\d+$/.test(val)) {
      states[key] = { type: "int", value: parseInt(val, 10) };
    } else {
      states[key] = { type: "string", value: val };
    }
  }

  return { name: bedrockName, states };
}

/**
 * Translates a Bedrock Edition block name and states compound into Java Edition
 * block name and BlockState used by VoxelWorld and BuilderDSL.
 */
export function bedrockToJavaState(
  blockName: string,
  bedrockStates?: Record<string, unknown>
): {
  name: string;
  state?: BlockState;
} {
  const normalizedInput = normalizeBlockName(blockName);
  const javaName =
    BEDROCK_TO_JAVA_BLOCK_NAMES[normalizedInput] ?? normalizedInput;
  const shortName = getShortName(javaName);

  if (!bedrockStates || typeof bedrockStates !== "object") {
    return { name: javaName };
  }

  const state: BlockState = {};

  for (const [rawKey, rawEntry] of Object.entries(bedrockStates)) {
    if (rawEntry === undefined || rawEntry === null) continue;
    const key = rawKey.trim();
    const { type, value } = unwrapBedrockStateEntry(rawEntry);
    if (value === undefined || value === null) continue;

    // 1. Stairs (_stairs)
    if (isStairsBlock(shortName)) {
      if (key === "weirdo_direction") {
        const num = Number(value);
        state["facing"] = WEIRDO_TO_STAIR_FACING[num] ?? "north";
        continue;
      }
      if (key === "upside_down_bit") {
        const bit = toBooleanByte(value as string | number | boolean);
        state["half"] = bit === 1 ? "top" : "bottom";
        continue;
      }
    }

    // 2. Slabs (_slab)
    if (isSlabBlock(shortName)) {
      if (key === "minecraft:vertical_half" || key === "vertical_half") {
        const str = String(value).toLowerCase();
        state["half"] =
          str === "top" ? "top" : str === "double" ? "double" : "bottom";
        continue;
      }
      if (key === "top_slot_bit") {
        const bit = toBooleanByte(value as string | number | boolean);
        state["half"] = bit === 1 ? "top" : "bottom";
        continue;
      }
    }

    // 3. Doors (_door)
    if (isDoorBlock(shortName)) {
      if (key === "upper_block_bit") {
        const bit = toBooleanByte(value as string | number | boolean);
        state["half"] = bit === 1 ? "upper" : "lower";
        continue;
      }
      if (key === "direction") {
        const num = Number(value);
        state["facing"] = DIRECTION_TO_DOOR_FACING[num] ?? "north";
        continue;
      }
      if (key === "open_bit") {
        const bit = toBooleanByte(value as string | number | boolean);
        state["open"] = bit === 1 ? "true" : "false";
        continue;
      }
      if (key === "door_hinge_bit") {
        const bit = toBooleanByte(value as string | number | boolean);
        state["hinge"] = bit === 1 ? "right" : "left";
        continue;
      }
    }

    // 4. Lanterns (lantern, soul_lantern)
    if (isLanternBlock(shortName)) {
      if (key === "hanging") {
        const bit = toBooleanByte(value as string | number | boolean);
        state["hanging"] = bit === 1 ? "true" : "false";
        continue;
      }
    }

    // 5. Logs / Pillars (_log, _stem, _wood, pillar, basalt, deepslate)
    if (isPillarBlock(shortName) || key === "pillar_axis") {
      if (key === "pillar_axis") {
        const axis = String(value).toLowerCase();
        state["axis"] =
          axis === "x" || axis === "y" || axis === "z" ? axis : "y";
        continue;
      }
    }

    // 6. Generic fallback
    if (typeof value === "boolean") {
      state[key] = value ? "true" : "false";
    } else if (
      (type === "byte" ||
        key.endsWith("_bit") ||
        KNOWN_BOOLEAN_STATE_KEYS.has(key)) &&
      (value === 0 || value === 1 || value === "0" || value === "1")
    ) {
      const bit = Number(value);
      state[key] = bit === 1 ? "true" : "false";
    } else {
      state[key] = String(value);
    }
  }

  if (Object.keys(state).length === 0) {
    return { name: javaName };
  }

  return { name: javaName, state };
}

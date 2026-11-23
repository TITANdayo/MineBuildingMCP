import * as fs from "node:fs/promises";
import * as zlib from "node:zlib";
import * as nbtNamespace from "prismarine-nbt";
import { defaultJarAssetLoader } from "../assets/jar-loader.js";
import { BlockState, CompiledBlockDefinition } from "../types/shared.js";
import { resolveWorldBlockStates } from "./block-state-resolver.js";
import {
  BedrockStateMap,
  bedrockToJavaState,
  javaToBedrockState,
} from "./state-translator.js";
import { isAirBlock, normalizeBlockName, VoxelWorld } from "./voxel-world.js";

const nbt =
  (nbtNamespace as unknown as { default?: typeof nbtNamespace }).default ??
  nbtNamespace;

const DEFAULT_DATA_VERSION = 3953; // Minecraft 1.21 (Java)
const DEFAULT_BEDROCK_BLOCK_VERSION = 18090528; // Minecraft 1.21 (Bedrock)

interface SimplifiedPaletteEntry {
  Name: string;
  Properties?: Record<string, string | number | boolean>;
}

interface SimplifiedBlockEntry {
  pos: [number, number, number];
  state: number;
}

interface SimplifiedStructureNbt {
  size?: [number, number, number];
  palette?: SimplifiedPaletteEntry[];
  blocks?: SimplifiedBlockEntry[];
  DataVersion?: number;
  format_version?: number;
  structure?: {
    block_indices?: number[][];
    palette?: Record<
      string,
      {
        block_palette?: Array<{
          name?: string;
          states?: Record<string, unknown>;
          version?: number;
        }>;
      }
    >;
  };
}

function isMcstructureRoot(rootValue: Record<string, unknown>): boolean {
  if (!rootValue || typeof rootValue !== "object") return false;
  if ("format_version" in rootValue && "structure" in rootValue) {
    return true;
  }
  const structure = rootValue.structure as Record<string, unknown> | undefined;
  if (structure && typeof structure === "object") {
    if ("block_indices" in structure || "value" in structure) {
      return true;
    }
  }
  return false;
}

function parseMcstructureFromNbt(parsed: nbtNamespace.NBT): VoxelWorld {
  const simplified = nbt.simplify(parsed) as SimplifiedStructureNbt;

  if (
    !simplified ||
    typeof simplified !== "object" ||
    !Array.isArray(simplified.size) ||
    simplified.size.length !== 3 ||
    simplified.size.some(
      (d) => typeof d !== "number" || !Number.isFinite(d) || d <= 0
    ) ||
    !simplified.structure ||
    typeof simplified.structure !== "object" ||
    Array.isArray(simplified.structure) ||
    !Array.isArray(simplified.structure.block_indices) ||
    !simplified.structure.palette ||
    typeof simplified.structure.palette !== "object" ||
    Array.isArray(simplified.structure.palette)
  ) {
    throw new Error(
      "Invalid .mcstructure data: missing valid size [x, y, z], structure.block_indices, or structure.palette."
    );
  }

  const origSizeX = Math.max(1, Math.floor(simplified.size[0]));
  const origSizeY = Math.max(1, Math.floor(simplified.size[1]));
  const origSizeZ = Math.max(1, Math.floor(simplified.size[2]));

  const world = new VoxelWorld([origSizeX, origSizeY, origSizeZ]);
  const [sizeX, sizeY, sizeZ] = world.size;

  // Extract raw block_palette from unsimplified NBT if available so state tag types (byte vs int vs string) are preserved
  const rawRoot = parsed.value as Record<string, any>;
  const rawStructure = rawRoot?.structure?.value as Record<string, any> | undefined;
  const rawPaletteGroup = rawStructure?.palette?.value as
    | Record<string, any>
    | undefined;
  const rawDefaultPalette =
    rawPaletteGroup?.default?.value ??
    (rawPaletteGroup
      ? (Object.values(rawPaletteGroup)[0] as any)?.value
      : undefined);
  const rawBlockPaletteList: Array<Record<string, any>> | undefined =
    rawDefaultPalette?.block_palette?.value?.value;

  const palette: Array<{ name: string; state?: BlockState }> = [];

  if (Array.isArray(rawBlockPaletteList)) {
    for (const rawEntry of rawBlockPaletteList) {
      const rawName = String(rawEntry?.name?.value ?? "minecraft:air");
      const rawStates = rawEntry?.states?.value as
        | Record<string, unknown>
        | undefined;
      palette.push(bedrockToJavaState(rawName, rawStates));
    }
  } else {
    // Fallback to simplified palette
    const simpPalettes = simplified.structure?.palette;
    const simpDefault =
      simpPalettes?.default ??
      (simpPalettes ? Object.values(simpPalettes)[0] : undefined);
    if (
      (rawDefaultPalette?.block_palette !== undefined &&
        !Array.isArray(rawBlockPaletteList)) ||
      (simpDefault?.block_palette !== undefined &&
        !Array.isArray(simpDefault.block_palette))
    ) {
      throw new Error(
        "Invalid .mcstructure data: missing valid structure.palette.default.block_palette list."
      );
    }
    const simpBlockPalette = simpDefault?.block_palette ?? [];
    for (const entry of simpBlockPalette) {
      palette.push(
        bedrockToJavaState(entry.name ?? "minecraft:air", entry.states)
      );
    }
  }

  const blockIndices = simplified.structure?.block_indices;
  const layer0 = Array.isArray(blockIndices) && Array.isArray(blockIndices[0])
    ? blockIndices[0]
    : [];

  if (layer0.length > 0) {
    const isAirPalette = palette.map((entry) => isAirBlock(entry.name));
    const yzStride = origSizeY * origSizeZ;
    for (let x = 0; x < sizeX; x++) {
      const xOffset = x * yzStride;
      for (let y = 0; y < sizeY; y++) {
        const xyOffset = xOffset + y * origSizeZ;
        for (let z = 0; z < sizeZ; z++) {
          const paletteIdx = layer0[xyOffset + z];
          if (paletteIdx === undefined || paletteIdx < 0) continue;
          if (isAirPalette[paletteIdx]) continue;
          const paletteEntry = palette[paletteIdx];
          if (!paletteEntry) continue;

          world.setVoxel(
            x,
            y,
            z,
            paletteEntry.name,
            paletteEntry.state,
            true,
            0
          );
        }
      }
    }
  }

  world.saveInitialTerrainSnapshot();
  return world;
}

export async function parseMcstructureBuffer(
  buffer: Buffer
): Promise<VoxelWorld> {
  let parsed: nbtNamespace.NBT;
  try {
    const res = await nbt.parse(buffer, "little");
    parsed = res.parsed;
  } catch {
    const res = await nbt.parse(buffer);
    parsed = res.parsed;
  }
  return parseMcstructureFromNbt(parsed);
}

function computeResolvedExportStates(
  world: VoxelWorld,
  blockModels?: Record<string, CompiledBlockDefinition>,
  preResolvedStates?: Map<string, BlockState>
): Map<string, BlockState> {
  if (preResolvedStates) return preResolvedStates;
  const allVoxels = world.getAllVoxels();
  if (allVoxels.length === 0) return new Map();

  let effectiveModels = blockModels;
  if (!effectiveModels && defaultJarAssetLoader.getJarPath() !== null) {
    effectiveModels = defaultJarAssetLoader.getBlockModelsForBlocks(
      world.getUniqueBlockNames()
    );
  }
  if (!effectiveModels) return new Map();

  return resolveWorldBlockStates(
    allVoxels,
    effectiveModels,
    world.getExplicitStateKeysMap()
  );
}

export async function serializeMcstructureBuffer(
  world: VoxelWorld,
  blockModels?: Record<string, CompiledBlockDefinition>,
  preResolvedStates?: Map<string, BlockState>
): Promise<Buffer> {
  const resolvedStates = computeResolvedExportStates(
    world,
    blockModels,
    preResolvedStates
  );
  const [sizeX, sizeY, sizeZ] = world.size;
  const totalVoxels = sizeX * sizeY * sizeZ;
  // Fill layer0 with 0 (minecraft:air) and layer1 (waterlog layer) with -1
  const layer0 = new Array<number>(totalVoxels).fill(0);
  const layer1 = new Array<number>(totalVoxels).fill(-1);

  const paletteMap = new Map<
    string,
    { index: number; bedrockName: string; bedrockStates: BedrockStateMap }
  >();

  // Always include minecraft:air at index 0 so empty structures have a valid non-empty Compound list
  const airTranslated = javaToBedrockState("minecraft:air");
  paletteMap.set("minecraft:air", {
    index: 0,
    bedrockName: airTranslated.name,
    bedrockStates: airTranslated.states,
  });

  // Iterate only existing non-air voxels in deterministic (x, y, z) order instead of O(sizeX*sizeY*sizeZ) Map lookups
  const sortedVoxels = world.getAllVoxels().sort((a, b) => {
    if (a.x !== b.x) return a.x - b.x;
    if (a.y !== b.y) return a.y - b.y;
    return a.z - b.z;
  });

  const yzStride = sizeY * sizeZ;
  for (const voxel of sortedVoxels) {
    if (isAirBlock(voxel.name)) {
      continue;
    }
    const resolved = resolvedStates.get(
      VoxelWorld.coordKey(voxel.x, voxel.y, voxel.z)
    );
    const effectiveState =
      resolved && Object.keys(resolved).length > 0 ? resolved : voxel.state;
    const key = makePaletteKey(voxel.name, effectiveState);
    let pEntry = paletteMap.get(key);
    if (!pEntry) {
      const translated = javaToBedrockState(voxel.name, effectiveState);
      pEntry = {
        index: paletteMap.size,
        bedrockName: translated.name,
        bedrockStates: translated.states,
      };
      paletteMap.set(key, pEntry);
    }
    const flatIndex = voxel.x * yzStride + voxel.y * sizeZ + voxel.z;
    layer0[flatIndex] = pEntry.index;
  }

  const blockPaletteEntries = Array.from(paletteMap.values()).map((entry) => {
    const statesCompound: Record<string, nbtNamespace.Tags[nbtNamespace.TagType]> = {};
    for (const [k, v] of Object.entries(entry.bedrockStates)) {
      if (v.type === "byte") {
        statesCompound[k] = nbt.byte(Number(v.value));
      } else if (v.type === "int") {
        statesCompound[k] = nbt.int(Number(v.value));
      } else {
        statesCompound[k] = nbt.string(String(v.value));
      }
    }

    return {
      name: nbt.string(entry.bedrockName),
      states: nbt.comp(statesCompound),
      version: nbt.int(DEFAULT_BEDROCK_BLOCK_VERSION),
    };
  });

  const rootTag = nbt.comp(
    {
      format_version: nbt.int(1),
      size: nbt.list(nbt.int([sizeX, sizeY, sizeZ])),
      structure_world_origin: nbt.list(nbt.int([0, 0, 0])),
      structure: nbt.comp({
        block_indices: {
          type: nbt.TagType.List,
          value: {
            type: nbt.TagType.List,
            value: [
              { type: nbt.TagType.Int, value: layer0 },
              { type: nbt.TagType.Int, value: layer1 },
            ],
          },
        } as unknown as nbtNamespace.Tags[nbtNamespace.TagType],
        entities: {
          type: nbt.TagType.List,
          value: {
            type: "end",
            value: [],
          },
        } as unknown as nbtNamespace.Tags[nbtNamespace.TagType],
        palette: nbt.comp({
          default: nbt.comp({
            block_palette: {
              type: nbt.TagType.List,
              value: {
                type: nbt.TagType.Compound,
                value: blockPaletteEntries,
              },
            } as unknown as nbtNamespace.Tags[nbtNamespace.TagType],
            block_position_data: nbt.comp({}),
          }),
        }),
      }),
    },
    ""
  ) as unknown as nbtNamespace.NBT;

  return nbt.writeUncompressed(rootTag, "little");
}

export async function loadMcstructure(filePath: string): Promise<VoxelWorld> {
  const buffer = await fs.readFile(filePath);
  return parseMcstructureBuffer(buffer);
}

export async function saveMcstructure(
  world: VoxelWorld,
  filePath: string,
  blockModels?: Record<string, CompiledBlockDefinition>,
  preResolvedStates?: Map<string, BlockState>
): Promise<void> {
  const buffer = await serializeMcstructureBuffer(
    world,
    blockModels,
    preResolvedStates
  );
  await fs.writeFile(filePath, buffer);
}

export async function parseStructureNbtBuffer(
  buffer: Buffer
): Promise<VoxelWorld> {
  let parsed: nbtNamespace.NBT;
  try {
    const res = await nbt.parse(buffer);
    parsed = res.parsed;
  } catch {
    return parseMcstructureBuffer(buffer);
  }

  if (isMcstructureRoot(parsed.value as Record<string, unknown>)) {
    return parseMcstructureFromNbt(parsed);
  }

  const simplified = nbt.simplify(parsed) as SimplifiedStructureNbt;
  if (
    simplified.format_version !== undefined &&
    simplified.structure?.block_indices !== undefined
  ) {
    return parseMcstructureFromNbt(parsed);
  }

  if (
    !simplified ||
    typeof simplified !== "object" ||
    !Array.isArray(simplified.size) ||
    simplified.size.length !== 3 ||
    simplified.size.some(
      (d) => typeof d !== "number" || !Number.isFinite(d) || d <= 0
    ) ||
    !Array.isArray(simplified.palette) ||
    !Array.isArray(simplified.blocks)
  ) {
    throw new Error(
      "Invalid structure NBT data: missing valid size [x, y, z], palette, or blocks."
    );
  }

  const size: [number, number, number] = [
    Number(simplified.size[0]),
    Number(simplified.size[1]),
    Number(simplified.size[2]),
  ];

  const world = new VoxelWorld(size);

  const palette: Array<{ name: string; state?: BlockState }> = (
    simplified.palette ?? []
  ).map((entry) => {
    const name = normalizeBlockName(entry.Name ?? "minecraft:air");
    let state: BlockState | undefined;
    if (entry.Properties && typeof entry.Properties === "object") {
      state = {};
      for (const [k, v] of Object.entries(entry.Properties)) {
        state[k] = String(v);
      }
      if (Object.keys(state).length === 0) {
        state = undefined;
      }
    }
    return { name, state };
  });

  const blocks = simplified.blocks ?? [];
  for (const blk of blocks) {
    if (!Array.isArray(blk.pos) || blk.pos.length < 3) continue;
    const [x, y, z] = [
      Number(blk.pos[0]),
      Number(blk.pos[1]),
      Number(blk.pos[2]),
    ];
    const paletteEntry = palette[blk.state];
    if (!paletteEntry) continue;
    if (isAirBlock(paletteEntry.name)) continue;

    world.setVoxel(x, y, z, paletteEntry.name, paletteEntry.state, true, 0);
  }

  world.saveInitialTerrainSnapshot();
  return world;
}

export async function loadStructureNbt(filePath: string): Promise<VoxelWorld> {
  if (filePath.toLowerCase().endsWith(".mcstructure")) {
    return loadMcstructure(filePath);
  }
  const buffer = await fs.readFile(filePath);
  return parseStructureNbtBuffer(buffer);
}

function makePaletteKey(name: string, state?: BlockState): string {
  const normalized = normalizeBlockName(name);
  if (!state || Object.keys(state).length === 0) {
    return normalized;
  }
  const sortedProps = Object.keys(state)
    .sort()
    .map((k) => `${k}=${state[k]}`)
    .join(",");
  return `${normalized}[${sortedProps}]`;
}

export async function serializeStructureNbtBuffer(
  world: VoxelWorld,
  blockModels?: Record<string, CompiledBlockDefinition>,
  preResolvedStates?: Map<string, BlockState>
): Promise<Buffer> {
  const resolvedStates = computeResolvedExportStates(
    world,
    blockModels,
    preResolvedStates
  );
  const paletteMap = new Map<
    string,
    { index: number; name: string; state?: BlockState }
  >();
  const blockEntries: Array<{ pos: [number, number, number]; state: number }> =
    [];

  // Sort voxels deterministically by y, z, x
  const allVoxels = world.getAllVoxels().sort((a, b) => {
    if (a.y !== b.y) return a.y - b.y;
    if (a.z !== b.z) return a.z - b.z;
    return a.x - b.x;
  });

  for (const voxel of allVoxels) {
    if (isAirBlock(voxel.name)) continue;
    const resolved = resolvedStates.get(
      VoxelWorld.coordKey(voxel.x, voxel.y, voxel.z)
    );
    const effectiveState =
      resolved && Object.keys(resolved).length > 0 ? resolved : voxel.state;
    const key = makePaletteKey(voxel.name, effectiveState);
    let pEntry = paletteMap.get(key);
    if (!pEntry) {
      pEntry = {
        index: paletteMap.size,
        name: normalizeBlockName(voxel.name),
        ...(effectiveState && Object.keys(effectiveState).length > 0
          ? { state: { ...effectiveState } }
          : {}),
      };
      paletteMap.set(key, pEntry);
    }
    blockEntries.push({
      pos: [voxel.x, voxel.y, voxel.z],
      state: pEntry.index,
    });
  }

  // Ensure palette has at least one entry (minecraft:air) if world is completely empty
  if (paletteMap.size === 0) {
    paletteMap.set("minecraft:air", {
      index: 0,
      name: "minecraft:air",
    });
  }

  const paletteNbtValue = Array.from(paletteMap.values()).map((entry) => {
    const compound: Record<string, nbtNamespace.Tags[nbtNamespace.TagType]> = {
      Name: { type: nbt.TagType.String, value: entry.name },
    };
    if (entry.state && Object.keys(entry.state).length > 0) {
      const propsCompound: Record<string, nbtNamespace.Tags[nbtNamespace.TagType]> = {};
      for (const [k, v] of Object.entries(entry.state)) {
        propsCompound[k] = { type: nbt.TagType.String, value: String(v) };
      }
      compound.Properties = {
        type: nbt.TagType.Compound,
        value: propsCompound,
      };
    }
    return compound;
  });

  const blocksNbtValue = blockEntries.map((blk) => ({
    pos: {
      type: nbt.TagType.List,
      value: {
        type: nbt.TagType.Int,
        value: blk.pos,
      },
    } as nbtNamespace.Tags[nbtNamespace.TagType],
    state: {
      type: nbt.TagType.Int,
      value: blk.state,
    } as nbtNamespace.Tags[nbtNamespace.TagType],
  }));

  const rootNbt: nbtNamespace.NBT = {
    name: "",
    type: nbt.TagType.Compound,
    value: {
      DataVersion: {
        type: nbt.TagType.Int,
        value: DEFAULT_DATA_VERSION,
      },
      size: {
        type: nbt.TagType.List,
        value: {
          type: nbt.TagType.Int,
          value: [world.size[0], world.size[1], world.size[2]],
        },
      },
      palette: {
        type: nbt.TagType.List,
        value: {
          type: nbt.TagType.Compound,
          value: paletteNbtValue,
        },
      },
      blocks: {
        type: nbt.TagType.List,
        value: {
          type: nbt.TagType.Compound,
          value: blocksNbtValue,
        },
      },
      entities: {
        type: nbt.TagType.List,
        value: {
          type: nbt.TagType.Compound,
          value: [],
        },
      },
    },
  };

  const uncompressed = nbt.writeUncompressed(rootNbt, "big");
  return zlib.gzipSync(uncompressed);
}

export async function saveStructureNbt(
  world: VoxelWorld,
  filePath: string,
  blockModels?: Record<string, CompiledBlockDefinition>,
  preResolvedStates?: Map<string, BlockState>
): Promise<void> {
  if (filePath.toLowerCase().endsWith(".mcstructure")) {
    await saveMcstructure(world, filePath, blockModels, preResolvedStates);
    return;
  }
  const gzipped = await serializeStructureNbtBuffer(
    world,
    blockModels,
    preResolvedStates
  );
  await fs.writeFile(filePath, gzipped);
}

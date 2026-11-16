import * as fs from "node:fs/promises";
import * as zlib from "node:zlib";
import * as nbt from "prismarine-nbt";
import { BlockState } from "../types/shared.js";
import { isAirBlock, normalizeBlockName, VoxelWorld } from "./voxel-world.js";

const DEFAULT_DATA_VERSION = 3953; // Minecraft 1.21

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
}

export async function parseStructureNbtBuffer(
  buffer: Buffer
): Promise<VoxelWorld> {
  const { parsed } = await nbt.parse(buffer);
  const simplified = nbt.simplify(parsed) as SimplifiedStructureNbt;

  const rawSize = simplified.size ?? [32, 32, 32];
  const size: [number, number, number] = [
    Number(rawSize[0] ?? 32),
    Number(rawSize[1] ?? 32),
    Number(rawSize[2] ?? 32),
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
  world: VoxelWorld
): Promise<Buffer> {
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
    const key = makePaletteKey(voxel.name, voxel.state);
    let pEntry = paletteMap.get(key);
    if (!pEntry) {
      pEntry = {
        index: paletteMap.size,
        name: normalizeBlockName(voxel.name),
        ...(voxel.state && Object.keys(voxel.state).length > 0
          ? { state: { ...voxel.state } }
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
    const compound: Record<string, nbt.Tags[nbt.TagType]> = {
      Name: { type: nbt.TagType.String, value: entry.name },
    };
    if (entry.state && Object.keys(entry.state).length > 0) {
      const propsCompound: Record<string, nbt.Tags[nbt.TagType]> = {};
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
    } as nbt.Tags[nbt.TagType],
    state: {
      type: nbt.TagType.Int,
      value: blk.state,
    } as nbt.Tags[nbt.TagType],
  }));

  const rootNbt: nbt.NBT = {
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
  filePath: string
): Promise<void> {
  const gzipped = await serializeStructureNbtBuffer(world);
  await fs.writeFile(filePath, gzipped);
}

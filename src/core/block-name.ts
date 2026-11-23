const AIR_BLOCKS = new Set([
  "air",
  "minecraft:air",
  "cave_air",
  "minecraft:cave_air",
  "void_air",
  "minecraft:void_air",
]);

/**
 * Normalizes a block identifier to its full namespaced form (e.g. `"oak_stairs"` -> `"minecraft:oak_stairs"`).
 * Empty strings normalize to `"minecraft:air"`.
 */
export function toFullBlockId(name: string): string {
  const trimmed = name.trim().toLowerCase();
  if (!trimmed) return "minecraft:air";
  if (trimmed.includes(":")) return trimmed;
  return `minecraft:${trimmed}`;
}

/**
 * Strips any `"minecraft:"` namespace prefix and block state brackets `[...]`
 * to produce a clean lowercase short identifier (e.g. `"minecraft:oak_stairs[facing=north]"` -> `"oak_stairs"`).
 */
export function toShortBlockId(name: string): string {
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

export function isAirBlock(name: string): boolean {
  return AIR_BLOCKS.has(toFullBlockId(name));
}

export function coordKey(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

export function clampResolution(resolution: unknown, fallback = 512): number {
  const num = typeof resolution === "number" ? resolution : Number(resolution);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(64, Math.min(2048, Math.floor(num)));
}

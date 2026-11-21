import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Portably resolves the `MineBuildingMCP/dist` directory by checking:
 * 1. Explicit `--mcp-dir` CLI option or `explicitDir`
 * 2. `process.env.MINEBUILDING_MCP_DIR`
 * 3. Current working directory (`./dist`, `./MineBuildingMCP/dist`) and parent walks
 * 4. Parent walks from this skill's `scripts/` directory
 */
export function resolveMcpDistDir(explicitDir) {
  const candidates = [];
  const pushCandidate = (dir) => {
    if (!dir) return;
    const resolved = path.resolve(dir);
    candidates.push(resolved);
    candidates.push(path.join(resolved, "dist"));
    candidates.push(path.join(resolved, "MineBuildingMCP", "dist"));
  };

  pushCandidate(explicitDir);
  pushCandidate(process.env.MINEBUILDING_MCP_DIR);

  const walkRoots = [process.cwd(), __dirname];
  for (const root of walkRoots) {
    let cur = path.resolve(root);
    for (let depth = 0; depth < 8; depth++) {
      pushCandidate(cur);
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }

  const seen = new Set();
  for (const distDir of candidates) {
    if (seen.has(distDir)) continue;
    seen.add(distDir);
    if (fs.existsSync(path.join(distDir, "core", "voxel-world.js"))) {
      return distDir;
    }
  }

  throw new Error(
    "Could not locate MineBuildingMCP/dist/core/voxel-world.js. " +
      "Pass --mcp-dir <path-to-MineBuildingMCP>, set MINEBUILDING_MCP_DIR, " +
      "or build MineBuildingMCP (`npm run build`)."
  );
}

/**
 * Dynamically imports a module relative to `MineBuildingMCP/dist/`.
 */
export async function importMcpModule(distDir, relPath) {
  const fullPath = path.join(distDir, ...relPath.split("/"));
  return import(pathToFileURL(fullPath).href);
}

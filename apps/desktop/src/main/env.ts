import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Load a local `.env`, if there is one.
 *
 * A development convenience: Vowe takes several optional credentials, and
 * re-exporting them for every run is friction that leads to keys ending up in
 * shell history. Values already present in the environment always win, so an
 * explicit `FOO=bar pnpm dev` still overrides the file.
 *
 * Deliberately does not fail when the file is missing, malformed, or absent
 * entirely — every credential it might carry is optional, so a bad `.env`
 * should degrade exactly like an empty one.
 */
export function loadLocalEnv(startFrom = process.cwd()): string | null {
  const found = findEnvFile(startFrom);
  if (!found) return null;
  try {
    // Node applies this without clobbering variables that are already set.
    process.loadEnvFile(found);
    return found;
  } catch {
    return null;
  }
}

/**
 * Walk up looking for `.env` beside the workspace root.
 *
 * The working directory differs between `pnpm dev` (the app package) and a
 * packaged build, so the file is located rather than assumed.
 */
function findEnvFile(startFrom: string): string | null {
  let directory = path.resolve(startFrom);
  for (let depth = 0; depth < 6; depth++) {
    const candidate = path.join(directory, '.env');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

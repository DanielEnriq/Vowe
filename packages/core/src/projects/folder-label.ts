import type { Project, ProjectFolder } from './project.js';

/**
 * Which of a project's folders a path is in. The deepest one wins, so a folder
 * added inside another is the one that answers for what is under it.
 *
 * Pure and import-free beyond a type, so the renderer can use it: no
 * `node:path`, only `/`-separated absolute paths, which is what Vowe stores.
 */
export function folderFor(
  project: Pick<Project, 'folders'>,
  absolutePath: string,
): ProjectFolder | null {
  let best: ProjectFolder | null = null;
  for (const folder of project.folders) {
    if (!isWithinFolder(absolutePath, folder.path)) continue;
    if (!best || folder.path.length > best.path.length) best = folder;
  }
  return best;
}

/**
 * How a path is said to a person.
 *
 * With one folder, relative to it — `src/x.ts`. With more than one, every path
 * says which folder it came from — `web-console:src/x.ts` — because a bare
 * `src/x.ts` is then ambiguous. A path outside every folder is left absolute.
 */
export function folderLabelFor(
  project: Pick<Project, 'folders'>,
  absolutePath: string,
): string {
  const folder = folderFor(project, absolutePath);
  if (!folder) return absolutePath;
  const relative = trimSlashes(absolutePath.slice(folder.path.length));
  if (project.folders.length <= 1) return relative || '.';
  return `${folderName(folder.path)}:${relative || '.'}`;
}

/** The last segment of a folder's path: `~/code/web-console` → `web-console`. */
export function folderName(folderPath: string): string {
  const trimmed = folderPath.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed || '/';
}

/** Whether `candidate` is `folder` or somewhere under it. */
export function isWithinFolder(candidate: string, folder: string): boolean {
  const base = folder.replace(/\/+$/, '');
  if (base === '') return candidate.startsWith('/');
  return candidate === base || candidate.startsWith(`${base}/`);
}

function trimSlashes(text: string): string {
  return text.replace(/^\/+/, '').replace(/\/+$/, '');
}

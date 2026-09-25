import os from 'node:os';
import path from 'node:path';

/**
 * Everything this adapter assumes about pi's on-disk layout lives here.
 *
 * The layout is documented by the CLI itself, in
 * `@earendil-works/pi-coding-agent/docs/session-format.md`:
 *
 *     ~/.pi/agent/sessions/--<cwd with / replaced by ->--/<timestamp>_<uuid>.jsonl
 */
export interface PiPaths {
  /** Root of the CLI's per-user state. */
  home: string;
  /** One directory per working directory, each holding session files. */
  sessions: string;
}

export function defaultPaths(home = path.join(os.homedir(), '.pi', 'agent')): PiPaths {
  return { home, sessions: path.join(home, 'sessions') };
}

/**
 * The directory name pi gives a working directory.
 *
 * The CLI's docs describe this as "`/` replaced by `-`", wrapped in `--`,
 * which would make an absolute path encode with three leading dashes. Real
 * directories have two — `/Users/dev/x` is `--Users-dev-x--` — because the
 * path's own leading slash supplies the second dash of the prefix. Verified
 * against an installed 0.85.1 rather than taken from the sentence.
 *
 * The transform is lossy: a literal `-` in a path is indistinguishable from a
 * separator, so decoding yields a *candidate* only. A session file's header
 * carries the real `cwd` and always wins; this is the fallback for a file
 * whose header has not been read yet.
 */
export function encodeCwd(cwd: string): string {
  return `-${cwd.replace(/\//g, '-')}--`;
}

export function decodeCwd(dirName: string): string | null {
  const match = /^-(-.*)--$/.exec(dirName);
  const body = match?.[1];
  if (!body) return null;
  return body.replace(/-/g, '/');
}

/**
 * The session id pi encodes in a file name: `<timestamp>_<uuid>.jsonl`.
 *
 * Used only until the file's header is read, which carries the id directly.
 */
export function sessionIdFromFileName(fileName: string): string | null {
  const match = /^(.+)_([0-9a-fA-F-]{36})\.jsonl$/.exec(fileName);
  return match?.[2] ?? null;
}

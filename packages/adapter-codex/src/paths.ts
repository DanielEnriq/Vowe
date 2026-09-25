import os from 'node:os';
import path from 'node:path';

/**
 * Everything this adapter assumes about Codex's on-disk layout lives here.
 *
 * Unlike pi, Codex ships no format specification, so this was established by
 * reading real rollout files. That difference is worth stating where a reader
 * will see it: the layout below is observed, not promised, and a Codex release
 * may move it without that being a bug on their side.
 *
 *     ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<timestamp>-<uuid>.jsonl
 */
export interface CodexPaths {
  home: string;
  sessions: string;
}

export function defaultPaths(home = path.join(os.homedir(), '.codex')): CodexPaths {
  return { home, sessions: path.join(home, 'sessions') };
}

/** `rollout-2026-09-24T12-54-21-<uuid>.jsonl` -> the uuid. */
export function sessionIdFromFileName(fileName: string): string | null {
  const match = /^rollout-.*?-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/.exec(
    fileName,
  );
  return match?.[1] ?? null;
}

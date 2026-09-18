import os from 'node:os';
import path from 'node:path';

/**
 * Everything this adapter assumes about Claude Code's on-disk layout lives
 * here. If the CLI changes where it writes, this is the file that changes.
 */
export interface ClaudeCodePaths {
  /** Root of the CLI's per-user state. */
  home: string;
  /** One directory per working directory, each holding `<sessionId>.jsonl`. */
  projects: string;
  /** One `<pid>.json` per live session process. */
  liveSessions: string;
}

export function defaultPaths(home = path.join(os.homedir(), '.claude')): ClaudeCodePaths {
  return {
    home,
    projects: path.join(home, 'projects'),
    liveSessions: path.join(home, 'sessions'),
  };
}

export function transcriptPath(
  paths: ClaudeCodePaths,
  projectDir: string,
  sessionId: string,
): string {
  return path.join(paths.projects, projectDir, `${sessionId}.jsonl`);
}

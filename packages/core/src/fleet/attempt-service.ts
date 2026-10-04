import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { isActiveSession } from '../projects/project.js';
import type { NormalizedEvent } from '../types/events.js';
import type { AgentSession } from '../types/session.js';
import {
  attemptSummaryOf,
  publicApiDelta,
  type AttemptSummary,
  type DiffTally,
  type PublicApiDelta,
} from './attempt.js';
import type { CaptainExchange } from './types.js';

const run = promisify(execFile);

/** Source files whose exports count as public API. */
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const PATCH_LIMIT = 400_000;
const UNTRACKED_LIMIT = 200;

export interface AttemptSummaryDeps {
  getSession(sessionId: string): AgentSession | null;
  listSessions(): AgentSession[];
  getEvents(sessionId: string): NormalizedEvent[];
  listCaptainExchanges(projectId: string): CaptainExchange[];
  /** Replaced by a test; the default runs git in `cwd`. */
  git?: (cwd: string, args: string[]) => Promise<string>;
  readText?: (file: string) => Promise<string>;
}

/**
 * Compare data for parallel attempts.
 *
 * Everything but the diff comes from each session's own events and
 * exchanges, so it is that session's alone. The diff comes from the folder,
 * which is only that session's when no other live or compared session works
 * in it; otherwise it is reported as shared and left out.
 */
export async function attemptSummaries(
  sessionIds: string[],
  deps: AttemptSummaryDeps,
): Promise<AttemptSummary[]> {
  const git = deps.git ?? defaultGit;
  const readText = deps.readText ?? ((file: string) => readFile(file, 'utf8'));
  const sessions = sessionIds
    .map((id) => deps.getSession(id))
    .filter((session): session is AgentSession => session !== null);
  const all = deps.listSessions();

  const exchangesByProject = new Map<string, CaptainExchange[]>();
  const exchangesOf = (projectId: string | null) => {
    if (!projectId) return [];
    let found = exchangesByProject.get(projectId);
    if (!found) exchangesByProject.set(projectId, (found = deps.listCaptainExchanges(projectId)));
    return found;
  };

  return Promise.all(
    sessions.map(async (session) => {
      const events = deps.getEvents(session.id);
      const exchanges = exchangesOf(session.projectId);
      const cwd = session.cwd ? path.resolve(session.cwd) : null;
      if (!cwd) return attemptSummaryOf({ sessionId: session.id, events, exchanges });

      const shared =
        sessions.some((other) => other.id !== session.id && sameFolder(other, cwd)) ||
        all.some((other) => other.id !== session.id && isActiveSession(other) && sameFolder(other, cwd));
      if (shared) {
        return attemptSummaryOf({ sessionId: session.id, events, exchanges, diffAttribution: 'shared-folder' });
      }
      try {
        const { diff, publicApi } = await folderDiff(cwd, git, readText);
        return attemptSummaryOf({
          sessionId: session.id,
          events,
          exchanges,
          diff,
          publicApi,
          diffAttribution: 'own-folder',
        });
      } catch {
        return attemptSummaryOf({ sessionId: session.id, events, exchanges, diffAttribution: 'unavailable' });
      }
    }),
  );
}

function sameFolder(session: AgentSession, cwd: string): boolean {
  return session.cwd !== null && path.resolve(session.cwd) === cwd;
}

/** The working tree against HEAD, untracked files included as additions. */
async function folderDiff(
  cwd: string,
  git: (cwd: string, args: string[]) => Promise<string>,
  readText: (file: string) => Promise<string>,
): Promise<{ diff: DiffTally; publicApi: 'unchanged' | PublicApiDelta }> {
  const numstat = await git(cwd, ['diff', '--numstat', 'HEAD']);
  const tally: DiffTally = { files: 0, added: 0, removed: 0 };
  const sources: string[] = [];
  for (const line of numstat.split('\n')) {
    const [plus, minus, file] = line.split('\t');
    if (!file) continue;
    tally.files++;
    tally.added += Number.parseInt(plus ?? '', 10) || 0;
    tally.removed += Number.parseInt(minus ?? '', 10) || 0;
    if (SOURCE.test(file)) sources.push(file);
  }

  let patch = sources.length
    ? await git(cwd, ['diff', '--no-color', '--unified=0', 'HEAD', '--', ...sources])
    : '';
  const untracked = (await git(cwd, ['ls-files', '--others', '--exclude-standard']))
    .split('\n')
    .filter(Boolean)
    .slice(0, UNTRACKED_LIMIT);
  for (const file of untracked) {
    let text: string;
    try {
      text = await readText(path.join(cwd, file));
    } catch {
      continue;
    }
    const lines = text.split('\n');
    tally.files++;
    tally.added += text.endsWith('\n') ? lines.length - 1 : lines.length;
    if (SOURCE.test(file) && patch.length < PATCH_LIMIT) {
      patch += `\n+++ b/${file}\n${lines.map((line) => `+${line}`).join('\n')}`;
    }
  }
  return { diff: tally, publicApi: publicApiDelta(patch.slice(0, PATCH_LIMIT)) };
}

async function defaultGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, maxBuffer: 8 * 1024 * 1024, timeout: 15_000 });
  return stdout;
}

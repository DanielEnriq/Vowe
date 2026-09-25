import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CodexAdapter, sessionIdFromFileName } from '@vowe/adapter-codex';

const FIXTURE_NAME =
  'rollout-2026-09-24T12-54-21-01a0d456-eb96-7642-88e2-3308d95a1849.jsonl';
const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  FIXTURE_NAME,
);
const SESSION_ID = '01a0d456-eb96-7642-88e2-3308d95a1849';

async function store(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vowe-codex-'));
  const dated = path.join(root, 'sessions', '2026', '09', '24');
  await mkdir(dated, { recursive: true });
  await writeFile(path.join(dated, FIXTURE_NAME), await readFile(FIXTURE, 'utf8'));
  return root;
}

function adapterFor(root: string): CodexAdapter {
  return new CodexAdapter({
    paths: { home: root, sessions: path.join(root, 'sessions') },
  });
}

describe('codex session discovery', () => {
  it('reads the session id out of a rollout file name', () => {
    expect(sessionIdFromFileName(FIXTURE_NAME)).toBe(SESSION_ID);
    expect(sessionIdFromFileName('notes.jsonl')).toBeNull();
  });

  it('walks the dated directories to find a session', async () => {
    const adapter = adapterFor(await store());
    const sessions = await adapter.discoverSessions();
    await adapter.dispose();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe(`codex:${SESSION_ID}`);
    expect(sessions[0]?.task).toBe('Fix the failing build on main.');
  });

  /** A turn restates the working directory, and it is the more current one. */
  it('follows the working directory into the turn that moved it', async () => {
    const adapter = adapterFor(await store());
    const [session] = await adapter.discoverSessions();
    await adapter.dispose();

    expect(session?.cwd).toBe('/tmp/demo-repo/worktree');
  });

  /**
   * Unlike pi, Codex records its own turn lifecycle, so this is read rather
   * than inferred — the fixture's last turn completed.
   */
  it('takes status from the turn lifecycle Codex writes down', async () => {
    const adapter = adapterFor(await store());
    const [session] = await adapter.discoverSessions();
    await adapter.dispose();

    expect(session?.status).toBe('waiting');
  });

  /**
   * The degradation case, stated plainly. A provider Vowe can only watch is
   * still a first-class provider; what it must not do is offer a control it
   * cannot perform.
   */
  it('offers observation and refuses every control, with a reason', async () => {
    const adapter = adapterFor(await store());
    const [session] = await adapter.discoverSessions();

    expect(session?.capabilities).toEqual({
      observe: true,
      sendInstruction: false,
      interrupt: false,
      resume: false,
      launch: false,
      // True because this session's file actually contains a readable
      // reasoning summary, not because Codex promises one — the two differ,
      // and real sessions mix readable and encrypted records.
      reasoning: true,
    });
    expect(adapter.launchSession).toBeUndefined();

    await expect(adapter.sendInstruction(SESSION_ID, 'carry on')).rejects.toThrow(
      /watched but not written to/,
    );
    await adapter.dispose();
  });

  it('streams a discovered session’s backlog to a subscriber', async () => {
    const adapter = adapterFor(await store());
    await adapter.discoverSessions();

    const seen: string[] = [];
    const unsubscribe = adapter.subscribeToEvents(SESSION_ID, (event) =>
      seen.push(event.kind),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    unsubscribe();
    await adapter.dispose();

    expect(seen).toContain('session_started');
    expect(seen).toContain('command_started');
    expect(seen).toContain('agent_reasoning');
  });

  /** A session whose reasoning is all encrypted must not claim to have any. */
  it('reports no reasoning for a session where none of it is readable', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'vowe-codex-'));
    const dated = path.join(root, 'sessions', '2026', '09', '24');
    await mkdir(dated, { recursive: true });
    const encryptedOnly = (await readFile(FIXTURE, 'utf8'))
      .split('\n')
      .filter((line) => !line.includes('summary_text'))
      .join('\n');
    await writeFile(path.join(dated, FIXTURE_NAME), encryptedOnly);

    const adapter = adapterFor(root);
    const [session] = await adapter.discoverSessions();
    await adapter.dispose();

    expect(session?.capabilities.reasoning).toBe(false);
  });
});

import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { PiAdapter, decodeCwd, encodeCwd } from '@vowe/adapter-pi';

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'session.jsonl',
);

/** A pi session store holding one real-shaped session for `cwd`. */
async function storeWith(cwd: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vowe-pi-'));
  const sessions = path.join(root, 'sessions');
  const dir = path.join(sessions, encodeCwd(cwd));
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, '2026-09-23T22-21-26-407Z_01a0d05c-0406-766c-a54e-8f03fa31c76f.jsonl'),
    await readFile(FIXTURE, 'utf8'),
  );
  return root;
}

function adapterFor(root: string, binary?: string): PiAdapter {
  return new PiAdapter({
    paths: { home: root, sessions: path.join(root, 'sessions') },
    ...(binary === undefined ? {} : { binary }),
  });
}

describe('pi session discovery', () => {
  it('round-trips the directory name pi gives a working directory', () => {
    expect(encodeCwd('/Users/dev/projects/Vowe')).toBe('--Users-dev-projects-Vowe--');
    expect(decodeCwd('--Users-dev-projects-Vowe--')).toBe('/Users/dev/projects/Vowe');
    expect(decodeCwd('not-a-session-dir')).toBeNull();
  });

  it('finds a session and takes its identity from the file’s own header', async () => {
    const adapter = adapterFor(await storeWith('/tmp/demo-repo'), '/usr/bin/true');
    const sessions = await adapter.discoverSessions();
    await adapter.dispose();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.provider).toBe('pi');
    expect(sessions[0]?.providerSessionId).toBe('01a0d05c-0406-766c-a54e-8f03fa31c76f');
    expect(sessions[0]?.id).toBe('pi:01a0d05c-0406-766c-a54e-8f03fa31c76f');
    expect(sessions[0]?.task).toBe('Add keyboard navigation between session threads.');
  });

  /**
   * The header wins over the directory name because the encoding is lossy: a
   * path containing a real `-` decodes into a path that does not exist.
   */
  it('prefers the header’s working directory to the one in the directory name', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'vowe-pi-'));
    const dir = path.join(root, 'sessions', encodeCwd('/tmp/demo-repo'));
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, '2026-09-23T22-21-26-407Z_01a0d05c-0406-766c-a54e-8f03fa31c76f.jsonl'),
      '{"type":"session","version":3,"id":"01a0d05c-0406-766c-a54e-8f03fa31c76f","timestamp":"2026-09-23T22:21:26.407Z","cwd":"/tmp/demo-repo-with-dashes"}\n',
    );

    const adapter = adapterFor(root, '/usr/bin/true');
    const sessions = await adapter.discoverSessions();
    await adapter.dispose();

    expect(sessions[0]?.cwd).toBe('/tmp/demo-repo-with-dashes');
  });

  /**
   * pi publishes no lock file, pid file or socket, so there is nothing that
   * says whether a discovered session is running. A quiet file could be a
   * finished session or a worker thinking hard, and the product would rather
   * say it does not know than be confidently wrong.
   */
  it('says it does not know whether a discovered session is live', async () => {
    const adapter = adapterFor(await storeWith('/tmp/demo-repo'), '/usr/bin/true');
    const sessions = await adapter.discoverSessions();
    await adapter.dispose();

    expect(sessions[0]?.status).toBe('unknown');
    expect(sessions[0]?.attachMode).toBe('external-idle');
  });

  it('observes and reads reasoning whether or not the CLI is installed', async () => {
    const root = await storeWith('/tmp/demo-repo');
    for (const binary of ['/usr/bin/true', undefined]) {
      const adapter = new PiAdapter({
        paths: { home: root, sessions: path.join(root, 'sessions') },
        binary: binary as string,
      });
      const [session] = await adapter.discoverSessions();
      await adapter.dispose();

      expect(session?.capabilities.observe).toBe(true);
      expect(session?.capabilities.reasoning).toBe(true);
    }
  });

  /**
   * The point of the capability model: implementing a control path is a claim
   * about the provider, and having its CLI is a claim about the machine. Only
   * the second one may reach a button.
   */
  it('withdraws every control capability when the CLI is not installed', async () => {
    const root = await storeWith('/tmp/demo-repo');

    const withCli = adapterFor(root, '/usr/bin/true');
    const [installed] = await withCli.discoverSessions();
    expect(installed?.capabilities.sendInstruction).toBe(true);
    expect(installed?.capabilities.resume).toBe(true);
    expect(installed?.capabilities.launch).toBe(true);
    expect(withCli.canLaunch()).toBe(true);
    await withCli.dispose();

    const withoutCli = new PiAdapter({
      paths: { home: root, sessions: path.join(root, 'sessions') },
      binary: '',
    });
    const [missing] = await withoutCli.discoverSessions();
    expect(missing?.capabilities.sendInstruction).toBe(false);
    expect(missing?.capabilities.resume).toBe(false);
    expect(missing?.capabilities.launch).toBe(false);
    expect(missing?.capabilities.interrupt).toBe(false);
    expect(withoutCli.canLaunch()).toBe(false);

    await expect(
      withoutCli.sendInstruction('01a0d05c-0406-766c-a54e-8f03fa31c76f', 'go on'),
    ).rejects.toThrow(/pi command-line tool was not found/);
    await withoutCli.dispose();
  });

  it('streams a discovered session’s backlog to a subscriber', async () => {
    const adapter = adapterFor(await storeWith('/tmp/demo-repo'), '/usr/bin/true');
    await adapter.discoverSessions();

    const seen: string[] = [];
    const unsubscribe = adapter.subscribeToEvents(
      '01a0d05c-0406-766c-a54e-8f03fa31c76f',
      (event) => seen.push(event.kind),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    unsubscribe();
    await adapter.dispose();

    expect(seen).toContain('session_started');
    expect(seen).toContain('agent_reasoning');
    expect(seen).toContain('file_changed');
  });
});

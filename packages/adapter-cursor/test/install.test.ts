import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installCursorHooks } from '../src/install.js';
let root: string;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
it('installs user-level observation idempotently while preserving unrelated hooks and settings', async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vowe-install-'));
  const cursorHome = path.join(root, 'cursor'),
    captureDir = path.join(root, "quoted ' capture"),
    collectorFile = path.join(root, 'helper.mjs');
  await mkdir(cursorHome);
  await writeFile(collectorFile, 'process.stdout.write("{}");');
  await writeFile(
    path.join(cursorHome, 'hooks.json'),
    JSON.stringify({
      version: 1,
      custom: true,
      hooks: {
        afterFileEdit: [{ command: 'other integration', timeout: 3 }],
        unrelated: [{ command: 'keep' }],
      },
    }),
  );
  await installCursorHooks({ cursorHome, captureDir, collectorFile });
  await installCursorHooks({ cursorHome, captureDir, collectorFile });
  const config = JSON.parse(await readFile(path.join(cursorHome, 'hooks.json'), 'utf8'));
  expect(config.custom).toBe(true);
  expect(config.hooks.afterFileEdit).toHaveLength(2);
  expect(config.hooks.afterFileEdit[0]).toEqual({ command: 'other integration', timeout: 3 });
  expect(config.hooks.unrelated).toEqual([{ command: 'keep' }]);
  expect(config.hooks.afterFileEdit[1].command).toContain("'\\''");
  expect((await stat(path.join(cursorHome, 'hooks.json'))).mode & 0o777).toBe(0o600);
});

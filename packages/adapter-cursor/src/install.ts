import { copyFile, mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defaultCaptureDir } from './collector.js';

const HOOKS = [
  'sessionStart',
  'sessionEnd',
  'beforeSubmitPrompt',
  'afterAgentResponse',
  'afterAgentThought',
  'preToolUse',
  'postToolUse',
  'postToolUseFailure',
  'beforeShellExecution',
  'afterShellExecution',
  'afterFileEdit',
  'subagentStart',
  'subagentStop',
  'stop',
  'preCompact',
];
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Explicit installation only. Preserve unrelated user hooks and use no project configuration. */
export async function installCursorHooks(
  options: { cursorHome?: string; captureDir?: string; node?: string; collectorFile?: string } = {},
) {
  const home = options.cursorHome ?? path.join(os.homedir(), '.cursor');
  const captureDir = options.captureDir ?? defaultCaptureDir();
  const collector = path.join(captureDir, 'vowe-collector.mjs');
  await mkdir(captureDir, { recursive: true, mode: 0o700 });
  await mkdir(home, { recursive: true });
  await copyFile(
    options.collectorFile ?? fileURLToPath(new URL('./collector.js', import.meta.url)),
    collector,
  );
  const file = path.join(home, 'hooks.json');
  let config: Record<string, unknown> = { version: 1 };
  try {
    config = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (
    config.hooks !== undefined &&
    (!config.hooks || typeof config.hooks !== 'object' || Array.isArray(config.hooks))
  )
    throw new Error('Invalid existing Cursor hooks configuration');
  const hooks = (config.hooks ?? {}) as Record<string, unknown>;
  const command = `${quote(options.node ?? process.execPath)} ${quote(collector)} ${quote(captureDir)}`;
  for (const name of HOOKS) {
    const existing = hooks[name] ?? [];
    if (!Array.isArray(existing)) throw new Error(`Invalid hooks for ${name}`);
    // Match our installed helper path only, never another integration's command.
    hooks[name] = [
      ...existing.filter(
        (h) => typeof h?.command !== 'string' || !h.command.includes(quote(collector)),
      ),
      { command },
    ];
  }
  const output = JSON.stringify({ ...config, version: config.version ?? 1, hooks }, null, 2) + '\n';
  await writeFile(`${file}.vowe-tmp`, output, { mode: 0o600 });
  await rename(`${file}.vowe-tmp`, file);
  return { config: file, captureDir };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const installed = await installCursorHooks();
  process.stdout.write(`Cursor observation installed in ${installed.config}\n`);
}

import {
  mkdirSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
  readFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const defaultCaptureDir = () => path.join(os.homedir(), '.local', 'share', 'vowe', 'cursor');

/** One atomically published file per delivery: concurrent hook processes cannot interleave records. */
export function captureHook(raw: string, root = defaultCaptureDir()): string {
  const payload = JSON.parse(raw) as Record<string, unknown>;
  if (typeof payload.conversation_id !== 'string')
    throw new Error('Hook lacks conversation identity');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const id = randomUUID(),
    file = path.join(root, `${id}.json`),
    temp = `${file}.tmp`;
  const fd = openSync(temp, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify({ id, receivedAt: new Date().toISOString(), payload, raw }));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, file);
  const dir = openSync(root, 'r');
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
  return id;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    captureHook(readFileSync(0, 'utf8'), process.argv[2] ?? defaultCaptureDir());
  } catch (error) {
    process.stderr.write(
      `Vowe capture failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
  // Observation never injects permissions, instructions, or follow-up messages.
  process.stdout.write('{}');
}

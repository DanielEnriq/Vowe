import { createReadStream } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

import { Sanitizer } from './sanitize.ts';

/**
 * Turn a real Claude Code transcript into a committable fixture.
 *
 *   pnpm sanitize <input.jsonl> <output.jsonl> [--max N] [--keep <name>]
 *
 * Two passes: the first learns every username and sibling project name that
 * appears anywhere in the file, the second rewrites them out. A sanitizer that
 * only mostly works is worse than none, because it gets trusted.
 */
async function main(): Promise<void> {
  const [input, output, ...rest] = process.argv.slice(2);
  if (!input || !output) {
    console.error(
      'usage: sanitize <input.jsonl> <output.jsonl> [--max N] [--keep <name>] [--scrub <name>]',
    );
    process.exitCode = 1;
    return;
  }

  const maxIndex = rest.indexOf('--max');
  const maxRecords =
    maxIndex === -1 ? undefined : Number(rest[maxIndex + 1] ?? Number.NaN);

  // The project the fixture is actually about stays readable; every sibling
  // project the session happened to see gets a placeholder.
  const keep = new Set<string>(['Vowe']);
  const scrubNames: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--keep' && rest[i + 1]) keep.add(rest[i + 1]!);
    if (rest[i] === '--scrub' && rest[i + 1]) scrubNames.push(rest[i + 1]!);
  }

  const projectNames = (await siblingProjectNames()).filter(
    (name) => !keep.has(name),
  );

  const sanitizer = new Sanitizer({
    usernames: [os.userInfo().username],
    projectNames,
    scrubNames,
    ...(Number.isFinite(maxRecords) ? { maxRecords: maxRecords! } : {}),
  });

  // Pass 1: learn.
  await eachLine(input, (line) => sanitizer.learn(line));

  // Pass 2: rewrite.
  const handle = await open(output, 'w');
  try {
    await eachLine(input, async (line) => {
      const cleaned = sanitizer.sanitizeLine(line);
      if (cleaned !== null) await handle.write(`${cleaned}\n`);
    });
  } finally {
    await handle.close();
  }

  const report = sanitizer.summary;
  console.log(`Sanitized ${input} -> ${output}`);
  console.log(`  records: ${report.recordsIn} read, ${report.recordsOut} written`);
  console.log(`  dropped by type: ${report.droppedByType}`);
  console.log(`  secrets redacted: ${report.secretsRedacted}`);
  console.log(`  paths rewritten: ${report.pathsRewritten}`);
  console.log(`  usernames rewritten: ${report.usernamesRewritten}`);
  console.log(`  project names rewritten: ${report.projectNamesRewritten}`);
  console.log(`  identifiers remapped: ${report.idsRemapped}`);
  console.log(`  usernames found: ${sanitizer.learnedUsernames.join(', ') || 'none'}`);
}

/**
 * Other work on this machine, so a directory listing captured mid-session does
 * not publish the names of unrelated projects.
 */
async function siblingProjectNames(): Promise<string[]> {
  const names = new Set<string>();
  const roots = [
    path.join(os.homedir(), 'projects'),
    path.join(os.homedir(), '.claude', 'projects'),
  ];
  for (const root of roots) {
    try {
      for (const entry of await readdir(root)) {
        // `-Users-someone-projects-Thing` -> `Thing`; a plain directory is
        // already the name. Entries with neither shape (`-Users-someone`) are
        // not projects and must not contribute an empty name.
        const slug = /-projects-(.+)$/.exec(entry);
        const name = slug?.[1] ?? (entry.startsWith('-') ? '' : entry);
        if (name.length >= 3) names.add(name);
      }
    } catch {
      // Directory may not exist; nothing to learn from it.
    }
  }
  return [...names];
}

async function eachLine(
  file: string,
  onLine: (line: string) => void | Promise<void>,
): Promise<void> {
  const reader = createInterface({
    input: createReadStream(file, 'utf8'),
    crlfDelay: Infinity,
  });
  for await (const line of reader) await onLine(line);
}

void main();

import { describe, expect, it } from 'vitest';

import { parsePatch } from '../src/renderer/state/patch.js';

const MODIFIED = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 111..222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,3 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  ' const c = 4;',
  '@@ -20,2 +20,3 @@ function later() {',
  ' return x;',
  '+// added',
  '\\ No newline at end of file',
  '',
].join('\n');

describe('parsePatch', () => {
  it('splits a file into a before side and an after side', () => {
    const [file] = parsePatch(MODIFIED);
    expect(file?.path).toBe('src/a.ts');
    expect(file?.status).toBe('modified');
    expect(file?.before.map((line) => [line.kind, line.text])).toEqual([
      ['context', 'const a = 1;'],
      ['change', 'const b = 2;'],
      ['context', 'const c = 4;'],
      ['gap', 'function later() {'],
      ['context', 'return x;'],
    ]);
    expect(file?.after.map((line) => [line.kind, line.text])).toEqual([
      ['context', 'const a = 1;'],
      ['change', 'const b = 3;'],
      ['context', 'const c = 4;'],
      ['gap', 'function later() {'],
      ['context', 'return x;'],
      ['change', '// added'],
    ]);
  });

  it('reads added, deleted, renamed and binary files', () => {
    const files = parsePatch(
      [
        'diff --git a/new.ts b/new.ts',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/new.ts',
        '@@ -0,0 +1 @@',
        '+export {};',
        'diff --git a/old.ts b/old.ts',
        'deleted file mode 100644',
        '--- a/old.ts',
        '+++ /dev/null',
        '@@ -1 +0,0 @@',
        '-gone',
        'diff --git a/x.ts b/y.ts',
        'similarity index 100%',
        'rename from x.ts',
        'rename to y.ts',
        'diff --git a/logo.png b/logo.png',
        'Binary files a/logo.png and b/logo.png differ',
      ].join('\n'),
    );
    expect(files.map((file) => [file.status, file.path, file.from])).toEqual([
      ['added', 'new.ts', undefined],
      ['deleted', 'old.ts', undefined],
      ['renamed', 'y.ts', 'x.ts'],
      ['binary', 'logo.png', undefined],
    ]);
    expect(files[0]?.before).toEqual([]);
    expect(files[1]?.after).toEqual([]);
  });

  it('numbers each side in its own file, from the hunk headers', () => {
    const [file] = parsePatch(MODIFIED);
    expect(file?.before.map((line) => [line.kind, line.line])).toEqual([
      ['context', 1],
      ['change', 2],
      ['context', 3],
      ['gap', undefined],
      ['context', 20],
    ]);
    expect(file?.after.map((line) => [line.kind, line.line])).toEqual([
      ['context', 1],
      ['change', 2],
      ['context', 3],
      ['gap', undefined],
      ['context', 20],
      ['change', 21],
    ]);
  });

  /*
   * The whole reason the two sides are counted separately: an addition above
   * pushes everything after it down on the new side and not on the old one.
   */
  it('lets the two sides drift apart after an insertion', () => {
    const [file] = parsePatch(
      [
        'diff --git a/a.ts b/a.ts',
        '@@ -10,3 +10,4 @@',
        ' one',
        '+inserted',
        ' two',
        ' three',
      ].join('\n'),
    );
    expect(file?.before.map((line) => line.line)).toEqual([10, 11, 12]);
    expect(file?.after.map((line) => line.line)).toEqual([10, 11, 12, 13]);
  });

  it('numbers a single-line hunk, whose header carries no count', () => {
    const [file] = parsePatch(
      ['diff --git a/a.ts b/a.ts', '@@ -7 +7 @@', '-was', '+is'].join('\n'),
    );
    expect(file?.before.map((line) => line.line)).toEqual([7]);
    expect(file?.after.map((line) => line.line)).toEqual([7]);
  });

  it('stops at the truncation marker', () => {
    const files = parsePatch(`${MODIFIED}\n… diff truncated at 24000 bytes …\n+not a line`);
    expect(files).toHaveLength(1);
    expect(files[0]?.after.at(-1)?.text).toBe('// added');
  });
});

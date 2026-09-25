/**
 * A unified diff, as one before-and-after comparison per file.
 *
 * The working tree's diff arrives as `git diff` text: every file, one after
 * another, each a run of hunks. A comparison wants the opposite shape — for
 * each file, what the changed region looked like and what it looks like now —
 * and both sides are already in the hunks: context lines belong to both,
 * removals only to the before, additions only to the after.
 *
 * Only the changed regions, never whole files. The patch is all the renderer
 * has, and a side that pretended to be the full file would be showing lines
 * nobody read. Where one hunk ends and the next begins there is a gap row,
 * carrying git's own heading for it (the enclosing function, usually), so a
 * jump in the file reads as a jump rather than as adjacent code.
 *
 * Pure, and in `state` rather than beside the component, so the reading of
 * a patch can be stated as tests.
 */
export interface FileComparison {
  /** Where the file is now — or was, for a deletion. */
  path: string;
  /** Where it was, when it moved. */
  from?: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'binary';
  before: ComparedLine[];
  after: ComparedLine[];
}

export interface ComparedLine {
  /**
   * `change` is a removal on the before side and an addition on the after
   * side; `gap` is the break between two hunks, and its text is the hunk's
   * heading, which may be empty.
   */
  kind: 'context' | 'change' | 'gap';
  text: string;
  /**
   * Where this line is in the file, counting from one — its own file, so the
   * before side counts in the old one and the after side in the new one, and
   * the two sides disagree wherever a change has added or removed anything
   * above them. That disagreement is the point: it is what tells you a line
   * moved rather than merely changed.
   *
   * Absent on a gap, which is not a line in either file but the space where
   * lines were skipped.
   */
  line?: number;
}

/**
 * `@@ -12,7 +12,9 @@ heading`.
 *
 * The two starts are where the hunk begins in each file; the counts are how
 * many lines it covers, which this does not need because it counts them as it
 * reads them. The heading is whatever git put after the closing `@@`.
 */
const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/;

export function parsePatch(patch: string): FileComparison[] {
  const files: FileComparison[] = [];
  let file: FileComparison | null = null;
  let inHunk = false;
  // Where the current hunk is in each file. Set at every `@@`, so they need no
  // resetting between files: a file's first hunk sets them before any line of
  // it is read.
  let beforeNo = 1;
  let afterNo = 1;

  for (const line of patch.split('\n')) {
    // The resolver's own marker, appended after the byte ceiling. Whatever
    // follows it is not part of the diff.
    if (line.startsWith('… diff truncated')) break;

    if (line.startsWith('diff --git ')) {
      file = { path: headerPath(line), status: 'modified', before: [], after: [] };
      files.push(file);
      inHunk = false;
      continue;
    }
    if (!file) continue;

    if (line.startsWith('@@')) {
      const hunk = HUNK.exec(line);
      if (file.before.length > 0 || file.after.length > 0) {
        const heading = hunk ? hunk[3]! : line.replace(/^@@[^@]*@@ ?/, '');
        file.before.push({ kind: 'gap', text: heading });
        file.after.push({ kind: 'gap', text: heading });
      }
      /*
       * A header this cannot read leaves the counters where they were rather
       * than guessing. Numbering that is wrong by a known offset is a worse
       * answer than numbering that simply carries on — and `git` has emitted
       * this shape unchanged for twenty years, so the fallback is for patches
       * that were never `git`'s.
       */
      if (hunk) {
        beforeNo = Number(hunk[1]);
        afterNo = Number(hunk[2]);
      }
      inHunk = true;
      continue;
    }

    if (inHunk) {
      if (line.startsWith('+')) {
        file.after.push({ kind: 'change', text: line.slice(1), line: afterNo++ });
      } else if (line.startsWith('-')) {
        file.before.push({ kind: 'change', text: line.slice(1), line: beforeNo++ });
      } else if (line.startsWith(' ')) {
        file.before.push({ kind: 'context', text: line.slice(1), line: beforeNo++ });
        file.after.push({ kind: 'context', text: line.slice(1), line: afterNo++ });
      }
      // `\ No newline at end of file`, and the empty string after the final
      // newline, belong to neither side.
      continue;
    }

    // Extended headers, between `diff --git` and the first hunk.
    if (line.startsWith('new file mode')) file.status = 'added';
    else if (line.startsWith('deleted file mode')) file.status = 'deleted';
    else if (line.startsWith('rename from ')) {
      file.from = line.slice('rename from '.length);
      file.status = 'renamed';
    } else if (line.startsWith('rename to ')) file.path = line.slice('rename to '.length);
    else if (line.startsWith('Binary files ')) file.status = 'binary';
    else if (line.startsWith('--- ') && file.status === 'deleted') file.path = sidePath(line);
    else if (line.startsWith('+++ ') && !line.endsWith('/dev/null')) file.path = sidePath(line);
  }

  return files;
}

/**
 * The path from `diff --git a/x b/x`.
 *
 * Ambiguous in general — a path may itself contain ` b/` — so this is only
 * the first guess, and the `+++`, `---` and rename lines that follow overwrite
 * it with the unambiguous one wherever they exist.
 */
function headerPath(line: string): string {
  const rest = line.slice('diff --git '.length);
  const split = rest.lastIndexOf(' b/');
  return split >= 0 ? rest.slice(split + 3) : rest;
}

function sidePath(line: string): string {
  return line.slice(4).replace(/^[ab]\//, '').replace(/\t.*$/, '');
}

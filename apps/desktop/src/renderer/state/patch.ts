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
}

export function parsePatch(patch: string): FileComparison[] {
  const files: FileComparison[] = [];
  let file: FileComparison | null = null;
  let inHunk = false;

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
      if (file.before.length > 0 || file.after.length > 0) {
        const heading = line.replace(/^@@[^@]*@@ ?/, '');
        file.before.push({ kind: 'gap', text: heading });
        file.after.push({ kind: 'gap', text: heading });
      }
      inHunk = true;
      continue;
    }

    if (inHunk) {
      if (line.startsWith('+')) file.after.push({ kind: 'change', text: line.slice(1) });
      else if (line.startsWith('-')) file.before.push({ kind: 'change', text: line.slice(1) });
      else if (line.startsWith(' ')) {
        file.before.push({ kind: 'context', text: line.slice(1) });
        file.after.push({ kind: 'context', text: line.slice(1) });
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

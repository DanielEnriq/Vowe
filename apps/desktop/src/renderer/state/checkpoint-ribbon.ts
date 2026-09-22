import type { ReturnCheckpoint } from '@vowe/core';

/**
 * The two lines Vowe leaves on the ribbon: a short note, and the facts it
 * rests on.
 *
 * Chosen, never written. Every sentence here is picked by a rule over the
 * checkpoint's brief — what the worker touched, how its checks last finished,
 * where the session is, whether anything is waiting on a decision — so the
 * note can only ever say something the details underneath would bear out.
 * There is no model call, and no line the state could not have produced.
 *
 * Ordered by what the developer most needs to know on coming back: a decision
 * outranks a failure, a failure outranks the work finishing, and "kept watch"
 * is what is left when nothing more specific is true.
 */
export interface RibbonCopy {
  summary: string;
  facts: string[];
}

export function ribbonCopy(checkpoint: ReturnCheckpoint): RibbonCopy {
  const { brief } = checkpoint;
  const waiting = brief.needsYou.length;
  const failing = brief.verified.filter((check) => !check.passed);
  const tests = brief.verified.filter((check) => check.kind === 'tests');
  const finished = brief.state.status === 'finished';

  const summary =
    waiting > 0
      ? 'Something is waiting on you.'
      : failing.some((check) => check.kind === 'tests')
        ? 'The tests went red.'
        : failing.length > 0
          ? `The ${failing[0]!.label} is failing.`
          : finished
            ? 'The work wrapped up.'
            : brief.touched.length > 0 && brief.verified.length > 0
              ? 'Everything stayed on track.'
              : 'Vowe kept watch.';

  // Whether anything is waiting leads: it is the one fact that decides what
  // the developer does next, and at a narrow width the tail is what gets cut.
  const facts: string[] = [
    waiting === 0 ? 'nothing needs you' : waiting === 1 ? '1 thing needs you' : `${waiting} things need you`,
  ];
  const files = brief.touched.length;
  if (files > 0) facts.push(files === 1 ? '1 file changed' : `${files} files changed`);
  if (tests.length > 0) facts.push(tests.every((check) => check.passed) ? 'tests green' : 'tests red');
  const other = brief.verified.find((check) => check.kind !== 'tests');
  if (other) facts.push(`${other.label} ${other.passed ? other.result : 'failing'}`);
  if (finished) facts.push('worker finished');
  if (files === 0 && brief.verified.length === 0 && !finished && brief.changed.length > 0) {
    facts.push(brief.changed.length === 1 ? '1 note from Vowe' : `${brief.changed.length} notes from Vowe`);
  }

  return { summary, facts };
}

/** How long they were away, as the label says it: `42m`, `2h 5m`. */
export function awayFor(ms: number): string {
  const total = Math.round(ms / 60_000);
  if (total < 60) return `${total}m`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/**
 * Touched files as the developer would name them: the file's own name, with
 * just enough of its folder to tell two same-named files apart.
 */
export function shortPaths(paths: readonly string[]): string[] {
  const names = paths.map((path) => path.split('/').filter(Boolean));
  return names.map((parts) => {
    const base = parts.at(-1) ?? '';
    const clash = names.filter((other) => other.at(-1) === base).length > 1;
    return clash && parts.length > 1 ? parts.slice(-2).join('/') : base;
  });
}

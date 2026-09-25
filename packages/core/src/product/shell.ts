/**
 * The small amount of shell a product surface has to understand.
 *
 * Two questions get asked about a worker's commands, in two different places:
 * *is this a test run?* (classification, in the adapters) and *what should this
 * line say?* (display, in `workerActivity`). Both need the same thing first —
 * the part of the string that is actually executed — so it lives here rather
 * than in either caller.
 *
 * Nothing here parses shell properly, and nothing here needs to. It recognises
 * the few constructs a coding agent actually emits and is deliberately
 * conservative everywhere else: an unrecognised line comes back unchanged, and
 * the caller decides what to do with it.
 */

/**
 * A command with the data it writes removed.
 *
 * Workers create files by piping a heredoc into `cat`, and those bodies are
 * prose and source — routinely containing words like `vitest`. Matching against
 * the whole string reported writing a file as running the test suite, which
 * became a test milestone and a "Running … tests" label for what was an edit.
 * The body of a heredoc is data the command carries, not the command.
 *
 * The delimiter comes from the redirection and may be quoted (`<<'EOF'`,
 * `<<"EOF"`) or bare (`<<EOF`, `<<-EOF`) — that is how the shell distinguishes
 * an expanded body from a literal one — and either way the body ends at a line
 * holding only that word.
 */
export function executablePart(command: string): string {
  const heredoc = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(command);
  if (!heredoc) return command;

  const delimiter = heredoc[2]!;
  const bodyStart = command.indexOf('\n', heredoc.index);
  if (bodyStart === -1) return command;

  const end = new RegExp(`\\n\\s*${delimiter}\\s*(?:\\n|$)`).exec(
    command.slice(bodyStart),
  );
  const head = command.slice(0, bodyStart);
  // An unterminated heredoc means the rest of the string is body. Keeping the
  // head alone is still right, and it is the safe direction.
  return end ? head + command.slice(bodyStart + end.index + end[0].length) : head;
}

/**
 * The first thing a shell line runs, without its data or its neighbours.
 *
 * A worker's command is routinely several joined with `;` or `&&`, and a blind
 * character cut through one of those lands mid-flag and names nothing. The
 * leading statement is a truncation too, but it is the one that leaves a
 * recognisable command behind. A `cd` prefix goes with it: that is where the
 * command runs, not what it does.
 */
export function firstStatement(command: string): string {
  let text = (executablePart(command).split('\n')[0] ?? '').replace(/\s+/g, ' ').trim();

  /*
   * The `cd` goes before the cut, not after.
   *
   * `cd /repo && pnpm exec tsc` is one intention with a preamble, and cutting
   * at the separator first leaves `cd /repo` — which is where the work
   * happened and never what it was. So the preamble is stripped while the
   * separator is still there to recognise it by, repeatedly, because workers
   * chain more than one.
   */
  while (/^cd\s+\S+\s*(?:&&|;)\s*/.test(text)) {
    text = text.replace(/^cd\s+\S+\s*(?:&&|;)\s*/, '');
  }

  const cut = text.search(/(?:;|&&|\|\||\|)/);
  if (cut > 0) text = text.slice(0, cut);
  return text.trim();
}

/**
 * Whether a command is fit to show verbatim.
 *
 * The fallback label quotes the command, so it is only allowed to when quoting
 * it reads as a sentence about the work. Substitutions, subshells, heredocs,
 * variable assignments and raw redirections are execution machinery: true, and
 * meaningless on a line that is supposed to say what a worker is doing. Where
 * this says no, the caller stays silent and looks further back, which is always
 * better than putting `B=$(readlink -f ~/.local/bin/claude)` on screen.
 */
export function isPresentable(command: string): boolean {
  if (!command || command.length > 64) return false;
  if (/[$`<>]/.test(command)) return false;
  if (/^\s*\w+=/.test(command)) return false;
  return true;
}

/** Program name and arguments, with env assignments and `sudo` dropped. */
export function commandParts(command: string): { program: string; args: string[] } {
  const tokens = firstStatement(command).split(' ').filter(Boolean);
  let at = 0;
  while (at < tokens.length && (/^\w+=/.test(tokens[at]!) || tokens[at] === 'sudo')) at++;
  const program = baseName(tokens[at] ?? '');
  return { program, args: tokens.slice(at + 1) };
}

/** The first argument that names something, rather than setting a flag. */
export function firstOperand(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (!token.startsWith('-')) return unquote(token);
    // A flag that takes a value eats the next token, so it is not the operand.
    if (/^-[a-zA-Z]$/.test(token)) i++;
  }
  return null;
}

export function baseName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

export function unquote(text: string): string {
  return text.replace(/^['"]|['"]$/g, '');
}

/**
 * Fixture sanitizer.
 *
 * A real Claude Code transcript is the only honest input for testing windowing:
 * its record types, their ordering, the ratio of tool calls to messages and the
 * shape of its timestamps are all things a hand-written fixture would get
 * subtly wrong. But a real transcript is also somebody's working session, so it
 * cannot be committed as-is.
 *
 * This file is committed alongside the fixtures it produced so that the
 * redaction is auditable and re-runnable: anyone can see exactly what was
 * removed, and regenerate a fixture from a new session on the same terms.
 *
 * What is preserved: record types, field structure, ordering, timestamps, the
 * relationship between tool calls and their results, and the overall size and
 * rhythm of the session. What is removed: credentials, absolute home paths,
 * machine identifiers, and any record unrelated to the work.
 */

/** Record types that are pure CLI bookkeeping and carry no useful structure. */
const DROPPED_TYPES = new Set([
  'attachment',
  'cost-state',
  'file-history-snapshot',
  'file-history-delta',
  'last-prompt',
  'queue-operation',
]);

export interface SanitizeOptions {
  /** Replaces the real home directory in every path. */
  homeReplacement?: string;
  /** Replaces every bare occurrence of a local username. */
  usernameReplacement?: string;
  /**
   * Usernames to scrub wherever they appear, not only inside paths.
   *
   * This matters more than it looks. A username shows up in `ls -l` owner
   * columns, in Claude Code's own `-Users-<name>-projects-<x>` directory slugs,
   * and in prose — none of which are paths. `learn` collects them in a first
   * pass so the second pass can remove all of it.
   */
  usernames?: string[];
  /** Sibling project names, scrubbed where they appear in a path. */
  projectNames?: string[];
  /**
   * Names to remove wherever they appear, path or not.
   *
   * The escape hatch for anything a general rule cannot safely catch — a
   * project name inside a process title, say. Explicit by design: what was
   * removed should be readable in the fixture's README, not inferred from a
   * heuristic.
   */
  scrubNames?: string[];
  /** Deterministic session id for the sanitized fixture. */
  sessionId?: string;
  /** Stop after this many records. */
  maxRecords?: number;
}

export interface SanitizeReport {
  recordsIn: number;
  recordsOut: number;
  droppedByType: number;
  secretsRedacted: number;
  pathsRewritten: number;
  usernamesRewritten: number;
  projectNamesRewritten: number;
  idsRemapped: number;
}

const SECRET_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: 'anthropic', pattern: /sk-ant-[A-Za-z0-9_-]{8,}/g },
  { name: 'openai', pattern: /sk-(?:proj-|live-)?[A-Za-z0-9_-]{20,}/g },
  { name: 'openrouter', pattern: /sk-or-v1-[A-Za-z0-9]{8,}/g },
  { name: 'github', pattern: /gh[pousr]_[A-Za-z0-9]{16,}/g },
  { name: 'aws', pattern: /AKIA[0-9A-Z]{16}/g },
  { name: 'slack', pattern: /xox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'google', pattern: /AIza[0-9A-Za-z_-]{20,}/g },
  { name: 'bearer', pattern: /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{20,}=*/g },
  { name: 'private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
];

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

export class Sanitizer {
  private readonly homeReplacement: string;
  private readonly usernameReplacement: string;
  private readonly usernames = new Set<string>();
  private readonly projectNames = new Set<string>();
  private readonly scrubNames = new Set<string>();
  private readonly sessionId: string;
  private readonly maxRecords: number;
  private readonly idMap = new Map<string, string>();
  private readonly report: SanitizeReport = {
    recordsIn: 0,
    recordsOut: 0,
    droppedByType: 0,
    secretsRedacted: 0,
    pathsRewritten: 0,
    usernamesRewritten: 0,
    projectNamesRewritten: 0,
    idsRemapped: 0,
  };

  constructor(options: SanitizeOptions = {}) {
    this.homeReplacement = options.homeReplacement ?? '/Users/dev';
    this.usernameReplacement = options.usernameReplacement ?? 'dev';
    for (const name of options.usernames ?? []) this.usernames.add(name);
    for (const name of options.projectNames ?? []) this.projectNames.add(name);
    for (const name of options.scrubNames ?? []) this.scrubNames.add(name);
    this.sessionId = options.sessionId ?? '00000000-0000-4000-8000-000000000001';
    this.maxRecords = options.maxRecords ?? Number.POSITIVE_INFINITY;
  }

  /**
   * First pass: find every name that will need scrubbing.
   *
   * Sanitizing is two passes because the giveaways are discovered in paths but
   * appear elsewhere — a username found on line 400 also has to be removed from
   * line 3. A single streaming pass cannot do that, and a sanitizer that only
   * mostly works is worse than none, because it is trusted.
   */
  learn(text: string): void {
    for (const match of text.matchAll(/\/(?:Users|home)\/([A-Za-z0-9._-]+)/g)) {
      const name = match[1];
      if (name && name !== this.usernameReplacement) this.usernames.add(name);
    }
    // Claude Code's own project-directory encoding: -Users-<name>-projects-<x>.
    for (const match of text.matchAll(/-(?:Users|home)-([A-Za-z0-9._]+?)-([A-Za-z0-9._-]+)/g)) {
      const name = match[1];
      if (name && name !== this.usernameReplacement) this.usernames.add(name);
    }
  }

  /** Names learned so far, for the CLI's report. */
  get learnedUsernames(): string[] {
    return [...this.usernames];
  }

  get summary(): SanitizeReport {
    return { ...this.report };
  }

  /** One JSONL line in, zero or one out. */
  sanitizeLine(line: string): string | null {
    const trimmed = line.trim();
    if (!trimmed) return null;

    let record: Record<string, unknown>;
    try {
      record = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return null;
    }

    this.report.recordsIn += 1;
    if (this.report.recordsOut >= this.maxRecords) return null;

    const type = typeof record['type'] === 'string' ? record['type'] : '';
    if (DROPPED_TYPES.has(type)) {
      this.report.droppedByType += 1;
      return null;
    }

    const cleaned = this.scrub(record);
    this.report.recordsOut += 1;
    return JSON.stringify(cleaned);
  }

  async *sanitize(lines: AsyncIterable<string> | Iterable<string>): AsyncGenerator<string> {
    for await (const line of lines) {
      const out = this.sanitizeLine(line);
      if (out !== null) yield out;
    }
  }

  /**
   * Walk the record, rewriting strings in place.
   *
   * Structure is never changed — only the contents of string leaves — so the
   * sanitized record parses and normalizes exactly as the original did.
   */
  private scrub(value: unknown): unknown {
    if (typeof value === 'string') return this.scrubString(value);
    if (Array.isArray(value)) return value.map((entry) => this.scrub(entry));
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        out[key] = this.scrub(entry);
      }
      return out;
    }
    return value;
  }

  private scrubString(value: string): string {
    let out = value;

    for (const { pattern } of SECRET_PATTERNS) {
      out = out.replace(pattern, () => {
        this.report.secretsRedacted += 1;
        return '[REDACTED]';
      });
    }

    // Any real home directory, not just this machine's, so a fixture produced
    // on one laptop cannot leak a username from another.
    out = out.replace(/\/(?:Users|home)\/[^/\s"'`:]+/g, () => {
      this.report.pathsRewritten += 1;
      return this.homeReplacement;
    });

    // Bare occurrences: `ls -l` owner columns, directory slugs, prose.
    for (const name of this.usernames) {
      out = out.replace(new RegExp(escapeRegExp(name), 'g'), () => {
        this.report.usernamesRewritten += 1;
        return this.usernameReplacement;
      });
    }

    // Unrelated work the session happened to see: sibling project names in a
    // directory listing, a working directory under some other tree, a slug in
    // a transcript path.
    //
    // Rewritten only where the name sits in a path-ish position — directly
    // after a `/` or `-`. Substituting these names *anywhere* would corrupt the
    // fixture, because several of them are ordinary words that also occur in
    // prose and in source code, and a fixture that no longer reads like a real
    // session is not worth having. Names that leak outside a path are removed
    // by naming them explicitly (`--scrub`), which is visible in the fixture
    // README rather than hidden in a heuristic.
    let projectIndex = 0;
    for (const name of this.projectNames) {
      projectIndex += 1;
      const replacement = `project-${projectIndex}`;
      const escaped = escapeRegExp(name);
      out = out.replace(new RegExp(`([/-])${escaped}\\b`, 'g'), (_m, prefix: string) => {
        this.report.projectNamesRewritten += 1;
        return `${prefix}${replacement}`;
      });
    }

    // Names the operator explicitly asked to remove, wherever they appear.
    let scrubIndex = 0;
    for (const name of this.scrubNames) {
      scrubIndex += 1;
      const replacement = `redacted-name-${scrubIndex}`;
      out = out.replace(new RegExp(escapeRegExp(name), 'gi'), () => {
        this.report.projectNamesRewritten += 1;
        return replacement;
      });
    }

    // Session and message identifiers are machine-specific but must stay
    // internally consistent, or tool results stop matching their tool calls.
    out = out.replace(UUID, (match) => this.remapId(match));

    return out;
  }

  private remapId(original: string): string {
    const existing = this.idMap.get(original);
    if (existing) return existing;
    const index = this.idMap.size + 2; // 1 is reserved for the session itself.
    const replacement = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    this.idMap.set(original, replacement);
    this.report.idsRemapped += 1;
    return replacement;
  }

  /** The id the sanitized fixture should be filed under. */
  get fixtureSessionId(): string {
    return this.sessionId;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

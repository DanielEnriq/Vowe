import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { query as sdkQuery, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type {
  ConsultationFinding,
  ConsultationRequest,
  ContextRef,
  RepositoryConsultant,
} from '@vowe/core';

/**
 * The tools a consultation may use: read a file, search contents, list paths.
 *
 * `tools` makes these the *only* built-in tools the harness has — no shell,
 * no editing, no web, no subagents — and `dontAsk` denies anything that would
 * otherwise need permission. Verified against the installed SDK (0.3.277)
 * with a live probe: reads and searches outside the working directory are
 * denied, whether the path is absolute, relative (`../`), a symlinked file or
 * a symlinked directory; searching the root does not follow symlinks out.
 */
export const CONSULTATION_TOOLS = ['Read', 'Grep', 'Glob'] as const;

/** Belt and braces: named here too, so a changed default cannot bring them back. */
const DENIED_TOOLS = [
  'Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'TodoWrite',
];

/** What the harness must hand back. Paths are repository-relative. */
const FINDING_SCHEMA = {
  type: 'object',
  properties: {
    answer: {
      type: 'string',
      description: 'The answer, grounded in what you read. Plain prose, at most about 250 words.',
    },
    confidence: {
      type: 'string',
      enum: ['confirmed', 'partial', 'not_found'],
      description: 'confirmed: the code shows it. partial: some of it. not_found: you could not establish it.',
    },
    references: {
      type: 'array',
      description: 'The files the answer rests on, most important first.',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the repository root.' },
          line: { type: 'integer', description: 'The most relevant line, 1-based.' },
          note: { type: 'string', description: 'What this file shows, in a few words.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  required: ['answer', 'confidence', 'references'],
  additionalProperties: false,
} as const;

export interface ClaudeCodeConsultantOptions {
  /** The Agent SDK's `query`, replaced in tests. */
  query?: typeof sdkQuery;
  maxTurns?: number;
  maxBudgetUsd?: number;
  /** Wall-clock ceiling for one consultation. */
  timeoutMs?: number;
  /** Overrides Claude Code's default model when set. */
  model?: string;
}

/**
 * Claude Code, consulted about a repository and nothing more.
 *
 * Runs the harness in-process through the Agent SDK with read-only tools and a
 * structured answer. Deliberately not the `ControlChannel` path: that one
 * launches work with `permissionMode: 'auto'`, keeps the session open for
 * instructions and leaves a transcript that discovery turns into an observed
 * worker. A consultation does none of those things:
 *
 *  - **No writes, no shell, no escape.** See `CONSULTATION_TOOLS`.
 *  - **No executable project configuration.** `settingSources: []` loads no
 *    user, project or local settings, so a repository's hooks never run; its
 *    CLAUDE.md is still an ordinary file the harness may read.
 *  - **No auto-memory.** The developer's Claude Code memory for the
 *    repository lives outside it; a consultation neither reads nor writes it.
 *  - **No MCP servers**, configured or otherwise.
 *  - **No session left behind.** `persistSession: false` writes no transcript
 *    (verified: nothing appears under `~/.claude`), so it is neither resumable
 *    in Claude Code nor discovered by Vowe as a worker.
 *  - **Bounded.** Turn, spend and wall-clock ceilings, and the caller's abort.
 */
export class ClaudeCodeConsultant implements RepositoryConsultant {
  readonly provider = 'Claude Code';
  private readonly query: typeof sdkQuery;
  private readonly maxTurns: number;
  private readonly maxBudgetUsd: number;
  private readonly timeoutMs: number;
  private readonly model: string | undefined;

  constructor(options: ClaudeCodeConsultantOptions = {}) {
    this.query = options.query ?? sdkQuery;
    this.maxTurns = options.maxTurns ?? 24;
    this.maxBudgetUsd = options.maxBudgetUsd ?? 0.75;
    this.timeoutMs = options.timeoutMs ?? 180_000;
    this.model = options.model;
  }

  async consult(request: ConsultationRequest): Promise<ConsultationFinding> {
    const startedAt = Date.now();
    const done = (finding: DistributiveOmit<ConsultationFinding, 'provider' | 'durationMs'>): ConsultationFinding =>
      ({ ...finding, provider: this.provider, durationMs: Date.now() - startedAt }) as ConsultationFinding;

    const root = await realpath(request.repoRoot).catch(() => null);
    if (!root || !(await stat(root)).isDirectory()) {
      return done({ status: 'unavailable', reason: `The repository at ${request.repoRoot} could not be found.` });
    }
    if (request.signal.aborted) return done({ status: 'cancelled', reason: 'Stopped before it began.' });

    const abort = new AbortController();
    let timedOut = false;
    const stop = () => abort.abort();
    request.signal.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, this.timeoutMs);

    const inspected = new Set<string>();
    let result: Extract<SDKMessage, { type: 'result' }> | null = null;
    try {
      const running = this.query({ prompt: consultationPrompt(request), options: this.options(root, abort) });
      for await (const message of running) {
        if (message.type === 'assistant') {
          for (const block of message.message.content) {
            if (block.type !== 'tool_use') continue;
            const activity = describeToolUse(block.name, block.input, root);
            if (!activity) continue;
            if (activity.path) inspected.add(activity.path);
            try {
              request.onActivity?.({ label: activity.label });
            } catch {
              // A view concern; it must never fail the consultation.
            }
          }
        } else if (message.type === 'result') {
          result = message;
        }
      }
    } catch (error) {
      if (abort.signal.aborted) {
        return timedOut
          ? done({ status: 'failed', reason: `The repository check took longer than ${Math.round(this.timeoutMs / 1000)} seconds and was stopped.` })
          : done({ status: 'cancelled', reason: 'Stopped.' });
      }
      throw error;
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener('abort', stop);
    }

    if (!result) {
      return abort.signal.aborted
        ? done({ status: request.signal.aborted ? 'cancelled' : 'failed', reason: timedOut ? 'The repository check timed out.' : 'Stopped.' })
        : done({ status: 'failed', reason: 'The repository check ended without an answer.' });
    }
    if (result.subtype !== 'success') {
      return done({ status: 'failed', reason: describeFailure(result) });
    }
    if (result.is_error) {
      const unavailable = result.api_error_status === 401 || result.api_error_status === 403 || /log ?in|api key|auth/i.test(result.result);
      return done({ status: unavailable ? 'unavailable' : 'failed', reason: plainReason(result.result) });
    }

    const structured = readFinding(result.structured_output);
    const answer = structured?.answer.trim() || result.result.trim();
    if (!answer) return done({ status: 'failed', reason: 'The repository check returned an empty answer.' });
    return done({
      status: 'answered',
      answer,
      confidence: structured?.confidence ?? 'partial',
      refs: await verifiedRefs(root, structured?.references ?? [], inspected),
      inspected: [...inspected],
      costUsd: result.total_cost_usd,
    });
  }

  /** Exposed for the test that pins every read-only guarantee. */
  options(root: string, abort: AbortController): Options {
    return {
      cwd: root,
      tools: [...CONSULTATION_TOOLS],
      allowedTools: [...CONSULTATION_TOOLS],
      disallowedTools: DENIED_TOOLS,
      permissionMode: 'dontAsk',
      settingSources: [],
      // Neither read nor write the developer's Claude Code auto-memory for
      // this repository: it lives outside the repository, and a consultation
      // answers from the code.
      settings: { autoMemoryEnabled: false },
      strictMcpConfig: true,
      mcpServers: {},
      persistSession: false,
      maxTurns: this.maxTurns,
      maxBudgetUsd: this.maxBudgetUsd,
      abortController: abort,
      outputFormat: { type: 'json_schema', schema: FINDING_SCHEMA as unknown as Record<string, unknown> },
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: CONSULTANT_GUIDANCE,
      },
      ...(this.model ? { model: this.model } : {}),
    };
  }
}

const CONSULTANT_GUIDANCE = `You are being consulted, read-only, about this repository by a colleague who is designing a system with a developer. You cannot and must not change anything.

Answer the one question you are given by reading the actual code. Search, then read the files that matter. Report what the implementation actually does, not what it should do. If the code does not settle the question, say so and set confidence accordingly. Cite the files your answer rests on, repository-relative, with the most relevant line where you can. Be concise: the answer is read inside a design conversation, not as a report.`;

function consultationPrompt(request: ConsultationRequest): string {
  return [
    `Question: ${request.question.trim()}`,
    request.context?.trim() ? `\nWhy it matters to the design: ${request.context.trim()}` : '',
    '\nInvestigate the repository in your working directory and answer.',
  ].join('');
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

interface RawFinding {
  answer: string;
  confidence: 'confirmed' | 'partial' | 'not_found';
  references: { path: string; line?: number; note?: string }[];
}

/** The structured output, if it is the shape that was asked for. */
function readFinding(value: unknown): RawFinding | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<RawFinding>;
  if (typeof candidate.answer !== 'string') return null;
  const confidence = ['confirmed', 'partial', 'not_found'].includes(candidate.confidence as string)
    ? (candidate.confidence as RawFinding['confidence'])
    : 'partial';
  const references = Array.isArray(candidate.references)
    ? candidate.references.filter(
        (item): item is RawFinding['references'][number] =>
          !!item && typeof item === 'object' && typeof (item as { path?: unknown }).path === 'string',
      )
    : [];
  return { answer: candidate.answer, confidence, references };
}

/**
 * Citations Vowe can stand behind: inside the repository, on disk now, and
 * absolute so the Workbench can open them. Files the harness actually opened
 * come first. A citation that escapes the root or names nothing is dropped.
 */
export async function verifiedRefs(
  root: string,
  references: readonly { path: string; line?: number }[],
  inspected: ReadonlySet<string>,
): Promise<ContextRef[]> {
  const seen = new Set<string>();
  const kept: { ref: ContextRef; opened: boolean; order: number }[] = [];
  for (const [order, reference] of references.entries()) {
    const relative = insideRoot(root, reference.path);
    if (!relative || seen.has(relative)) continue;
    const absolute = path.join(root, relative);
    const real = await realpath(absolute).catch(() => null);
    if (!real || !insideRoot(root, real)) continue;
    const info = await stat(real).catch(() => null);
    if (!info?.isFile()) continue;
    seen.add(relative);
    const line = Number.isInteger(reference.line) && reference.line! > 0 ? reference.line : undefined;
    kept.push({
      ref: line ? { kind: 'repo', path: absolute, line } : { kind: 'repo', path: absolute },
      opened: inspected.has(relative),
      order,
    });
  }
  return kept
    .sort((a, b) => Number(b.opened) - Number(a.opened) || a.order - b.order)
    .slice(0, 8)
    .map((item) => item.ref);
}

/** The repository-relative form of a path, or null when it is not inside the root. */
function insideRoot(root: string, candidate: string): string | null {
  const absolute = path.resolve(root, candidate);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative;
}

/** What the harness is doing, said as a person would. */
function describeToolUse(
  name: string,
  input: unknown,
  root: string,
): { label: string; path?: string } | null {
  const args = (input ?? {}) as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  if (name === 'Read') {
    const relative = insideRoot(root, text(args['file_path']));
    return relative ? { label: `Reading ${relative}`, path: relative } : { label: 'Reading a file' };
  }
  if (name === 'Grep') {
    const where = insideRoot(root, text(args['path']) || '.');
    const pattern = text(args['pattern']).slice(0, 60);
    return { label: `Searching for “${pattern}”${where ? ` in ${where}` : ''}` };
  }
  if (name === 'Glob') {
    return { label: `Listing ${text(args['pattern']).slice(0, 60) || 'files'}` };
  }
  return null;
}

function describeFailure(result: Extract<SDKMessage, { type: 'result'; subtype: string }>): string {
  switch (result.subtype) {
    case 'error_max_turns':
      return 'The repository check ran out of steps before it could answer.';
    case 'error_max_budget_usd':
      return 'The repository check reached its spending limit before it could answer.';
    case 'error_max_structured_output_retries':
      return 'The repository check could not produce a usable answer.';
    default: {
      const errors = 'errors' in result && Array.isArray(result.errors) ? result.errors.join('; ') : '';
      return errors ? `The repository check stopped with an error: ${plainReason(errors)}` : 'The repository check stopped with an error.';
    }
  }
}

function plainReason(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > 240 ? `${line.slice(0, 239)}…` : line || 'Unknown error.';
}

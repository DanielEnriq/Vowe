import path from 'node:path';

import type { ContextNavigator, OpenResult } from '../context/context-navigator.js';
import { formatRef, type ContextRef } from '../context/refs.js';
import type { ProjectKnowledgeService } from '../knowledge/project-knowledge-service.js';
import type { EventStore } from '../store/event-store.js';
import type { ArtifactContent, ArtifactFocus, WorkbenchArtifact } from './artifact.js';

export interface ArtifactResolverOptions {
  /**
   * The one read-only view onto everything Vowe can see.
   *
   * Every artifact body comes from here. The resolver opens no file, parses no
   * NDJSON and knows nothing about how a provider writes a trace — if it did,
   * an artifact could disagree with the answer that cited it.
   */
  navigator: Pick<ContextNavigator, 'openContext' | 'getDiff' | 'readSource'>;
  /**
   * The three reads a *title* needs. Narrowed by `Pick`, so this service can
   * only do what it says: the material still comes from the navigator.
   */
  store: Pick<EventStore, 'getEventsByIds' | 'getWindow' | 'getWindowNoteForWindow'>;
  /**
   * Only ever asked for a remembered result's own question, which makes a far
   * better title than the first line of its rendering. Absent, a lesson still
   * resolves; it is simply titled from its ref.
   */
  memory?: Pick<ProjectKnowledgeService, 'openMemory'>;
  onError?: (scope: string, error: unknown) => void;
}

/**
 * A `ContextRef`, as something a person is about to look at.
 *
 * This exists so the renderer never has to. Opening evidence means reading a
 * repository, reconstructing a diff, resolving a window to its trace range or
 * knowing where project memory lives — all of which belong on this side of the
 * boundary, behind one call.
 *
 * It is a projection and nothing else: no state, no cache, no identity of its
 * own. Resolving the same ref twice returns the same artifact, and resolving
 * anything at all changes nothing.
 */
export class ArtifactResolver {
  private readonly navigator: ArtifactResolverOptions['navigator'];
  private readonly store: ArtifactResolverOptions['store'];
  private readonly memory: ArtifactResolverOptions['memory'] | null;
  private readonly onError: (scope: string, error: unknown) => void;

  constructor(options: ArtifactResolverOptions) {
    this.navigator = options.navigator;
    this.store = options.store;
    this.memory = options.memory ?? null;
    this.onError = options.onError ?? (() => undefined);
  }

  async resolve(ref: ContextRef): Promise<WorkbenchArtifact> {
    switch (ref.kind) {
      case 'repo':
        return this.resolveRepo(ref);
      case 'symbol':
        return this.resolveSymbol(ref);
      case 'diff':
        return this.resolveDiff(ref);
      case 'window':
        return this.resolveWindow(ref);
      case 'trace':
        return this.resolveTrace(ref);
      case 'event':
      case 'transcript':
        return this.resolveEvent(ref);
      case 'lesson':
        return this.resolveLesson(ref);
      default:
        return assertNever(ref);
    }
  }

  // ------------------------------------------------------------------ source

  private async resolveRepo(
    ref: Extract<ContextRef, { kind: 'repo' }>,
  ): Promise<WorkbenchArtifact> {
    const slice = await this.navigator.readSource(ref);
    const subtitle = [path.dirname(ref.path), ref.line === undefined ? null : `line ${ref.line}`]
      .filter(Boolean)
      .join(' · ');

    if (!slice) {
      return this.artifact(ref, 'source', path.basename(ref.path), subtitle, {
        type: 'unavailable',
        reason: `Could not read ${ref.path}.`,
      });
    }

    const focus: ArtifactFocus =
      ref.line === undefined
        ? { startLine: slice.startLine, endLine: slice.endLine }
        : { startLine: ref.line, endLine: ref.line };

    return this.artifact(
      ref,
      'source',
      path.basename(ref.path),
      subtitle,
      {
        type: 'source',
        path: slice.path,
        text: slice.text,
        startLine: slice.startLine,
        endLine: slice.endLine,
        truncated: slice.truncated,
      },
      focus,
    );
  }

  /**
   * The graph entry, and the source it points at — whatever the navigator makes
   * of it. Kept as narrative rather than reshaped into a file, because a symbol
   * can resolve to several locations, or to none at all.
   */
  private async resolveSymbol(
    ref: Extract<ContextRef, { kind: 'symbol' }>,
  ): Promise<WorkbenchArtifact> {
    const opened = await this.navigator.openContext({ ref });
    return this.artifact(
      ref,
      'source',
      firstLine(opened.content) ?? ref.nodeId,
      ref.projectId,
      narrativeOf(opened),
    );
  }

  // -------------------------------------------------------------------- diff

  private async resolveDiff(
    ref: Extract<ContextRef, { kind: 'diff' }>,
  ): Promise<WorkbenchArtifact> {
    const diff = await this.navigator.getDiff(
      'projectId' in ref
        ? { projectId: ref.projectId, ...(ref.path ? { path: ref.path } : {}) }
        : { sessionId: ref.sessionId, ...(ref.path ? { path: ref.path } : {}) },
    );
    const title = ref.path ?? 'Working diff';

    if (diff.unavailable) {
      return this.artifact(ref, 'diff', title, undefined, {
        type: 'unavailable',
        reason: diff.unavailable,
      });
    }
    if (!diff.stat && !diff.patch) {
      return this.artifact(ref, 'diff', title, undefined, {
        type: 'narrative',
        text: 'The working tree is clean.',
        truncated: false,
      });
    }

    return this.artifact(ref, 'diff', title, lastLine(diff.stat), {
      type: 'diff',
      stat: diff.stat,
      patch: diff.patch,
      ...(ref.path ? { path: ref.path } : {}),
      truncated: diff.truncated,
    });
  }

  // --------------------------------------------------------- worker activity

  private async resolveWindow(
    ref: Extract<ContextRef, { kind: 'window' }>,
  ): Promise<WorkbenchArtifact> {
    const opened = await this.navigator.openContext({ ref });
    const window = this.store.getWindow(ref.sessionId, ref.windowId);
    const note = this.store.getWindowNoteForWindow(ref.sessionId, ref.windowId);
    return this.artifact(
      ref,
      'worker_activity',
      window ? `Window ${window.index}` : 'Window',
      note?.summary,
      narrativeOf(opened),
    );
  }

  private async resolveTrace(
    ref: Extract<ContextRef, { kind: 'trace' }>,
  ): Promise<WorkbenchArtifact> {
    const opened = await this.navigator.openContext({ ref });
    return this.artifact(
      ref,
      'worker_activity',
      `Trace ${ref.startSeq}–${ref.endSeq}`,
      undefined,
      narrativeOf(opened),
    );
  }

  /**
   * One event, as Vowe normalized it — never the provider's own record.
   *
   * The raw JSON is still reachable, at `open_context` depth `raw` and through
   * the evidence inspector. It is the bottom of the descent, not the default
   * thing to put in front of somebody.
   */
  private async resolveEvent(
    ref: Extract<ContextRef, { kind: 'event' | 'transcript' }>,
  ): Promise<WorkbenchArtifact> {
    const opened = await this.navigator.openContext({ ref });
    const [event] = this.store.getEventsByIds(ref.sessionId, [ref.eventId]);
    return this.artifact(
      ref,
      ref.kind === 'transcript' ? 'transcript' : 'worker_activity',
      event ? `[${event.seq}] ${event.kind}` : formatRef(ref),
      event?.summary,
      narrativeOf(opened),
      { eventIds: [ref.eventId] },
    );
  }

  // ----------------------------------------------------------- project memory

  private async resolveLesson(
    ref: Extract<ContextRef, { kind: 'lesson' }>,
  ): Promise<WorkbenchArtifact> {
    const opened = await this.navigator.openContext({ ref });
    let title = 'Remembered result';
    let subtitle: string | undefined;
    try {
      const record = await this.memory?.openMemory(ref.projectId, ref.recordId);
      if (record) {
        title = record.question;
        subtitle = `Remembered ${record.at} — ${record.outcome}`;
      }
    } catch (error) {
      // A title is not worth failing an artifact for; the body is already here.
      this.onError('artifact:memory-title', error);
    }
    return this.artifact(ref, 'project_memory', title, subtitle, narrativeOf(opened));
  }

  // ----------------------------------------------------------------- private

  private artifact(
    ref: ContextRef,
    kind: WorkbenchArtifact['kind'],
    title: string,
    subtitle: string | undefined,
    content: ArtifactContent,
    focus?: ArtifactFocus,
  ): WorkbenchArtifact {
    return {
      id: formatRef(ref),
      kind,
      title,
      ...(subtitle ? { subtitle } : {}),
      sourceRef: ref,
      content,
      ...(focus ? { focus } : {}),
    };
  }
}

/**
 * `notFound` is the navigator saying the address is fine and the material is
 * not there. That is an artifact somebody can be shown, not an error.
 */
function narrativeOf(opened: OpenResult): ArtifactContent {
  if (opened.notFound) return { type: 'unavailable', reason: opened.notFound };
  return { type: 'narrative', text: opened.content, truncated: opened.truncated };
}

function firstLine(text: string): string | null {
  const line = text.split('\n', 1)[0]?.trim();
  return line ? line : null;
}

/** `git diff --stat` ends with its own summary, which is the useful subtitle. */
function lastLine(text: string): string | undefined {
  const lines = text.split('\n').filter((line) => line.trim());
  return lines.length ? lines[lines.length - 1]!.trim() : undefined;
}

function assertNever(ref: never): never {
  throw new Error(`Unhandled reference kind: ${JSON.stringify(ref)}`);
}

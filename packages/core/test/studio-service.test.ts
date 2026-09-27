import { readdir, readFile } from 'node:fs/promises';

import { afterEach, describe, expect, it } from 'vitest';

import { formatRef, type ContextRef } from '../src/context/refs.js';
import type { OpenResult } from '../src/context/context-navigator.js';
import { VoweRunRecorder } from '../src/execution/run-recorder.js';
import type { ConsultationFinding, ConsultationRequest, RepositoryConsultant } from '../src/studio/consultation.js';
import { StudioService, type StudioProgress } from '../src/studio/studio-service.js';
import type { DesignOp } from '../src/studio/model.js';
import type {
  DesignCapabilities,
  DesignConsideration,
  DesignNote,
  DesignStream,
  DesignTurn,
  DesignTurnResult,
  SystemDesignAgent,
} from '../src/studio/system-design-agent.js';
import { temporaryStore } from './helpers.js';

const PROJECT = 'git:studio';
const ROOT = '/repo/vowe';
const OBSERVER: ContextRef = { kind: 'repo', path: `${ROOT}/packages/core/src/observation/observer-runner.ts`, line: 120 };
const SERVICE: ContextRef = { kind: 'repo', path: `${ROOT}/packages/core/src/observation/observation-service.ts` };

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

type Turn = (input: DesignTurn, tools: DesignCapabilities, stream: DesignStream) => Promise<DesignTurnResult>;

class FakeAgent implements SystemDesignAgent {
  inputs: DesignTurn[] = [];
  capabilities: DesignCapabilities[] = [];
  considered: DesignConsideration[] = [];
  note: DesignNote | null = null;
  constructor(public script: Turn) {}
  async consider(input: DesignConsideration) {
    this.considered.push(input);
    return this.note;
  }
  async turn(input: DesignTurn, capabilities: DesignCapabilities, _trace?: unknown, stream?: DesignStream) {
    this.inputs.push(input);
    this.capabilities.push(capabilities);
    return this.script(input, capabilities, stream ?? {});
  }
}

class FakeConsultant implements RepositoryConsultant {
  readonly provider = 'Claude Code';
  requests: ConsultationRequest[] = [];
  constructor(public answer: (request: ConsultationRequest) => Promise<ConsultationFinding> = async () => answered()) {}
  async consult(request: ConsultationRequest): Promise<ConsultationFinding> {
    this.requests.push(request);
    request.onActivity?.({ label: 'Reading observer-runner.ts' });
    return this.answer(request);
  }
}

function answered(refs: ContextRef[] = [OBSERVER], answer = 'The observer is per session; its coverage is not durable across restart.'): ConsultationFinding {
  return { status: 'answered', answer, confidence: 'confirmed', refs, provider: 'Claude Code', durationMs: 1200, inspected: ['packages/core/src/observation/observer-runner.ts'] };
}

async function harness(agent: FakeAgent, consultant = new FakeConsultant(), extra: { opened?: ContextRef[] } = {}) {
  const fixture = await temporaryStore();
  cleanup = fixture.cleanup;
  const { store } = fixture;
  await store.upsertProject({ id: PROJECT, name: 'Vowe', repoRoot: ROOT, createdAt: '2026-09-01T00:00:00.000Z' });
  const runs = new VoweRunRecorder({ store });
  const progress: StudioProgress[] = [];
  const opened: string[] = [];
  const studio = new StudioService({
    store,
    agent,
    consultant,
    runs,
    attachments: {
      openContext: async ({ ref }): Promise<OpenResult> => {
        const parsed = typeof ref === 'string' ? null : ref;
        opened.push(parsed ? formatRef(parsed) : String(ref));
        return { ref: parsed!, refId: formatRef(parsed!), kind: parsed!.kind, content: 'attached file content', related: [], truncated: false };
      },
    },
    onProgress: (event) => progress.push(event),
    repositoryBasis: async (root) => ({ worktree: root, head: 'abc123', branch: 'main', dirty: false, at: '2026-09-26T00:00:00.000Z' }),
  });
  const design = await studio.createDesign(PROJECT);
  void extra;
  return { store, studio, design, progress, consultant, opened };
}

const FIRST_MOVE: DesignOp[] = [
  { op: 'design', title: 'Project Understanding', intent: 'Durable understanding above the observer.' },
  { op: 'part', id: 'observer', name: 'Observer', role: 'Watches one session', today: true, refs: [formatRef(OBSERVER), `repo:${ROOT}/src/imaginary.ts`, 'packages/core/src/observation/observer-runner.ts#7', 'src/nowhere.ts'] },
  {
    op: 'part', id: 'project-understanding', name: 'Project Understanding', role: 'Durable understanding',
    detail: `Above the observer, which stays working memory ([observer-runner.ts](ref:${formatRef(OBSERVER)})). Invented: [made up](ref:repo:${ROOT}/src/imaginary.ts).`,
  },
  { op: 'link', from: 'observer', to: 'project-understanding' },
  { op: 'duty', id: 'durable', part: 'observer', text: 'durable across restarts', today: true },
];

const consultThenMove: Turn = async (_input, tools, stream) => {
  stream.message?.('That fits conceptually, but I need to check the observer. ');
  const finding = await tools.consultRepository({ question: 'Is observer coverage durable across restart?', why: 'Placement of Project Understanding', part: 'observer' });
  stream.message?.('I checked it.');
  stream.move?.(FIRST_MOVE.slice(0, 2));
  return {
    reply: `That fits conceptually, but I need to check the observer. I checked it. ${finding.status === 'answered' ? finding.answer : ''}`,
    move: { ops: FIRST_MOVE, summary: 'The observer turned out to be per-session and non-durable, so durable understanding moved above it.' },
  };
};

describe('StudioService', () => {
  it('gives the agent exactly one capability and nothing that reaches a worker', async () => {
    const agent = new FakeAgent(consultThenMove);
    const { studio, design, consultant } = await harness(agent);
    await studio.converse({ designId: design.id, message: 'I think Project Understanding should sit above the observer.' });

    expect(Object.keys(agent.capabilities[0]!)).toEqual(['consultRepository']);
    expect(consultant.requests[0]!.repoRoot).toBe(ROOT);
    expect(consultant.requests[0]!.signal).toBe(agent.inputs[0]!.signal);
  });

  it('has no import path to worker control, project memory or voice', async () => {
    const dir = new URL('../src/studio/', import.meta.url);
    const forbidden = /from '\.\.\/(registry|knowledge|live|companion|interpretation|observation)\/|delegated-question-runner|types\/adapter|adapter-/;
    for (const file of await readdir(dir)) {
      const source = await readFile(new URL(file, dir), 'utf8');
      expect(source, file).not.toMatch(forbidden);
    }
  });

  it('commits the reply and the revision together, grounded in what was checked', async () => {
    const agent = new FakeAgent(consultThenMove);
    const { store, studio, design } = await harness(agent);
    const outcome = await studio.converse({ designId: design.id, message: 'I think Project Understanding should sit above the observer.' });

    const [asked, reply] = store.getDesignEntries(design.id);
    expect(asked!.role).toBe('user_message');
    expect(reply!.id).toBe(outcome.entry!.id);
    const [revision] = store.getDesignRevisions(design.id);
    expect(revision!.entryId).toBe(reply!.id);
    expect(revision!.summary).toMatch(/per-session/);
    expect(revision!.move).toMatchObject({ id: expect.stringMatching(/^mv-[0-9a-f]{8}$/), author: 'vowe', via: 'conversation', ops: FIRST_MOVE });
    const model = revision!.model!;
    expect(model.parts.map((part) => part.id)).toEqual(['observer', 'project-understanding']);
    // The consulted file stays a link; the invented one is text, and is no ref.
    const detail = model.parts[1]!.detail!;
    expect(detail).toContain(`[observer-runner.ts](ref:${formatRef(OBSERVER)})`);
    expect(detail).toContain('Invented: made up.');
    // A shortened citation of a checked file resolves onto it; an unchecked one is gone.
    expect(model.parts[0]!.refs).toEqual([formatRef(OBSERVER), `repo:${OBSERVER.path}#7`]);
    // The document is now the design's projection.
    expect(revision!.document).toMatch(/^# Project Understanding\n\nDurable understanding above the observer\./);
    expect(revision!.document).not.toContain('imaginary.ts');
    // Its parts were placed in the same commit.
    expect(store.getDesignLayout(design.id)).toEqual({ observer: { row: 0, col: 0 }, 'project-understanding': { row: 1, col: 0 } });
  });

  it('records which checkout established what exists today, and only when it was checked', async () => {
    const agent = new FakeAgent(consultThenMove);
    const { store, studio, design } = await harness(agent);
    await studio.converse({ designId: design.id, message: 'Above the observer?' });
    const model = store.getDesignRevisions(design.id)[0]!.model!;
    expect(model.parts[0]!.today).toEqual({ name: 'Observer', role: 'Watches one session', basis: { worktree: ROOT, head: 'abc123', branch: 'main', dirty: false, at: '2026-09-26T00:00:00.000Z' } });
    expect(model.parts[1]!.today).toBeNull();

    agent.script = async () => ({ reply: 'Semantic state exists.', move: { ops: [{ op: 'part', id: 'semantic-state', name: 'Semantic State', role: 'r', today: true }], summary: 's' } });
    await studio.converse({ designId: design.id, message: 'And semantic state?' });
    const later = store.getDesignRevisions(design.id)[1]!.model!;
    expect(later.parts.find((part) => part.id === 'semantic-state')!.today).toEqual({ name: 'Semantic State', role: 'r' });
  });

  it('shows the part being checked, from the agent or the selection', async () => {
    const agent = new FakeAgent(consultThenMove);
    const { studio, design, progress } = await harness(agent);
    await studio.converse({ designId: design.id, message: 'Go.' });
    expect(progress.filter((event) => event.phase === 'consulting').every((event) => event.phase === 'consulting' && event.partId === 'observer')).toBe(true);

    agent.script = async (_input, tools) => {
      await tools.consultRepository({ question: 'q?', why: 'w' });
      return { reply: 'ok' };
    };
    progress.length = 0;
    await studio.converse({ designId: design.id, message: 'Why this?', focus: { kind: 'part', id: 'project-understanding' } });
    expect(progress.find((event) => event.phase === 'consulting')).toMatchObject({ partId: 'project-understanding' });
  });

  it('tells the agent what "this" is, resolved from the design rather than the renderer', async () => {
    const agent = new FakeAgent(consultThenMove);
    const { studio, design } = await harness(agent);
    await studio.converse({ designId: design.id, message: 'First.' });
    agent.script = async () => ({ reply: 'ok' });
    await studio.converse({ designId: design.id, message: 'Why this?', focus: { kind: 'duty', id: 'durable' } });
    await studio.converse({ designId: design.id, message: 'And this?', focus: { kind: 'part', id: 'nowhere' } });
    expect(agent.inputs[1]!.focus).toEqual({ kind: 'duty', id: 'durable', label: '“durable across restarts”' });
    expect(agent.inputs[2]!.focus).toBeUndefined();
  });

  it('hands a Studio 0 document to the agent to draw', async () => {
    const agent = new FakeAgent(async () => ({ reply: 'Drawn.', move: { ops: [{ op: 'part', id: 'observer', name: 'Observer', role: 'r' }], summary: 'Drew the earlier design.' } }));
    const { store, studio, design } = await harness(agent);
    const old = await store.appendDesignEntry({ id: 'e-old', designId: design.id, at: '2026-09-20T00:00:00.000Z', role: 'companion_message', text: 'Old reply.' });
    await store.commitDesignTurn({ id: 'e-old-2', designId: design.id, at: '2026-09-20T00:00:01.000Z', role: 'companion_message', text: 'Revised.' },
      { id: 'r-old', designId: design.id, at: '2026-09-20T00:00:01.000Z', document: '# Old\n\nA document.', summary: 'old', entryId: 'e-old-2' });
    void old;
    expect(studio.getDesign(design.id)!.revisions[0]!.model).toBeUndefined();
    await studio.converse({ designId: design.id, message: 'Draw it.' });
    expect(agent.inputs[0]!.design).toMatchObject({ revision: 1, legacyDocument: '# Old\n\nA document.', model: { parts: [] } });
    expect(store.getDesignRevisions(design.id)[1]!.model!.parts.map((part) => part.id)).toEqual(['observer']);
    expect(studio.listDesigns(PROJECT)[0]!.revisions).toBe(2);
  });

  it('receipts and traces each consultation where it ran', async () => {
    const agent = new FakeAgent(consultThenMove);
    const { store, studio, design } = await harness(agent);
    const outcome = await studio.converse({ designId: design.id, message: 'Above the observer?' });

    const check = outcome.entry!.investigation!.checks[0]!;
    expect(check).toMatchObject({
      kind: 'consult',
      label: 'Checked the repository: Is observer coverage durable across restart?',
      finding: 'The observer is per session; its coverage is not durable across restart.',
      via: 'Claude Code',
    });
    expect(check.refs).toEqual([OBSERVER]);
    expect(outcome.entry!.refs).toEqual([OBSERVER]);

    const run = store.getRunForEntry(outcome.entry!.id)!;
    expect(run).toMatchObject({ kind: 'studio', status: 'completed', projectId: PROJECT, metadata: { designId: design.id } });
    const items = store.getTraceItems(run.id);
    const call = items.find((item) => item.kind === 'tool_call');
    const result = items.find((item) => item.kind === 'tool_result');
    expect(call?.payload).toMatchObject({ name: 'consult_repository', arguments: { question: 'Is observer coverage durable across restart?' } });
    expect(result?.payload).toMatchObject({ name: 'consult_repository', result: { status: 'answered', inspected: ['packages/core/src/observation/observer-runner.ts'] } });
  });

  it('leaves the design alone when the turn does not revise it', async () => {
    const agent = new FakeAgent(async () => ({ reply: 'Conceptually I would put it above. I do not yet know whether the implementation supports that.' }));
    const { store, studio, design } = await harness(agent);
    const outcome = await studio.converse({ designId: design.id, message: 'Where should it go?' });
    expect(outcome.revision).toBeNull();
    expect(store.getDesignRevisions(design.id)).toEqual([]);
    expect(outcome.entry!.investigation).toBeUndefined();
  });

  it('keeps a missing reason missing rather than inventing one', async () => {
    const agent = new FakeAgent(async () => ({ reply: 'Recorded it.', move: { ops: [{ op: 'part', id: 'd', name: 'D', role: '' }], summary: '  ' } }));
    const { store, studio, design } = await harness(agent);
    await studio.converse({ designId: design.id, message: 'Note that.' });
    expect(store.getDesignRevisions(design.id)[0]!.summary).toBe('');
  });

  it('hands the agent the current design, recent turns, earlier findings and attachments', async () => {
    const agent = new FakeAgent(consultThenMove);
    const { studio, design, opened } = await harness(agent);
    await studio.converse({ designId: design.id, message: 'First thought.' });
    agent.script = async () => ({ reply: 'Noted.' });
    await studio.converse({ designId: design.id, message: 'Second thought.', contextRefs: [SERVICE] });

    const input = agent.inputs[1]!;
    expect(input.message).toBe('Second thought.');
    expect(input.design?.revision).toBe(1);
    expect(input.design?.model.title).toBe('Project Understanding');
    expect(input.design?.legacyDocument).toBeUndefined();
    expect(input.moves).toEqual([expect.objectContaining({ author: 'vowe', via: 'conversation', summary: expect.stringMatching(/per-session/) })]);
    expect(input.conversation.map((turn) => turn.speaker)).toEqual(['developer', 'vowe']);
    expect(input.findings).toEqual([expect.objectContaining({
      question: 'Is observer coverage durable across restart?',
      refs: [formatRef(OBSERVER)],
    })]);
    expect(opened).toEqual([formatRef(SERVICE)]);
    expect(input.attachments?.[0]?.content).toBe('attached file content');
  });

  it('lets a later turn cite what an earlier turn checked, and nothing else', async () => {
    const agent = new FakeAgent(consultThenMove);
    const { store, studio, design } = await harness(agent);
    await studio.converse({ designId: design.id, message: 'First.' });
    agent.script = async () => ({
      reply: `As checked earlier ([runner](ref:${formatRef(OBSERVER)})), and [service](ref:${formatRef(SERVICE)}).`,
      move: { ops: [{ op: 'part', id: 'observer', detail: `v2 [line 7](ref:repo:${OBSERVER.path}#7) [svc](ref:${formatRef(SERVICE)})` }], summary: 'Refined.' },
    });
    const outcome = await studio.converse({ designId: design.id, message: 'Second.' });
    expect(outcome.entry!.text).toBe(`As checked earlier ([runner](ref:${formatRef(OBSERVER)})), and service.`);
    expect(store.getDesignRevisions(design.id)[1]!.model!.parts[0]!.detail).toBe(`v2 [line 7](ref:repo:${OBSERVER.path}#7) svc`);
  });

  it('caps consultations per turn', async () => {
    const agent = new FakeAgent(async (_input, tools) => {
      const results = [];
      for (const n of [1, 2, 3]) results.push(await tools.consultRepository({ question: `Question ${n}?`, why: 'why' }));
      return { reply: results.map((result) => result.status).join(',') };
    });
    const { studio, design, consultant } = await harness(agent);
    const outcome = await studio.converse({ designId: design.id, message: 'Check three things.' });
    expect(consultant.requests).toHaveLength(2);
    expect(outcome.entry!.text).toBe('answered,answered,failed');
    expect(outcome.entry!.investigation!.checks).toHaveLength(2);
  });

  it('survives a consultation that could not answer', async () => {
    const consultant = new FakeConsultant(async () => ({ status: 'unavailable', reason: 'Claude Code is not signed in.', provider: 'Claude Code', durationMs: 5 }));
    const agent = new FakeAgent(async (_input, tools) => {
      const finding = await tools.consultRepository({ question: 'Does it persist?', why: 'why' });
      return { reply: `I could not check that (${finding.status}); treating it as an assumption.`, move: { ops: [{ op: 'part', id: 'store', name: 'Store', role: 'r', detail: 'Assumption: unchecked.' }], summary: 'Recorded the persistence question as unchecked.' } };
    });
    const { store, studio, design } = await harness(agent, consultant);
    const outcome = await studio.converse({ designId: design.id, message: 'Does it persist?' });
    expect(outcome.failed).toBe(false);
    expect(outcome.entry!.investigation!.checks[0]).toMatchObject({ label: 'Could not check the repository: Does it persist?', detail: 'Claude Code is not signed in.' });
    expect(store.getDesignRevisions(design.id)).toHaveLength(1);
  });

  it('records a failed turn honestly and leaves the design unchanged', async () => {
    const agent = new FakeAgent(consultThenMove);
    const { store, studio, design } = await harness(agent);
    await studio.converse({ designId: design.id, message: 'First.' });
    agent.script = async (_input, tools) => {
      await tools.consultRepository({ question: 'Anything?', why: 'why' });
      throw new Error('model exploded');
    };
    const outcome = await studio.converse({ designId: design.id, message: 'Second.' });
    expect(outcome.failed).toBe(true);
    expect(outcome.entry!.text).toMatch(/design is unchanged[\s\S]*model exploded/);
    expect(outcome.entry!.investigation!.checks).toHaveLength(1);
    expect(store.getDesignRevisions(design.id)).toHaveLength(1);
    expect(store.getRunForEntry(outcome.entry!.id)?.status).toBe('error');
  });

  it('unwinds a cancelled turn: harness aborted, no reply, run cancelled', async () => {
    let consultSignal: AbortSignal | null = null;
    const consultant = new FakeConsultant((request) => new Promise((resolve) => {
      consultSignal = request.signal;
      request.signal.addEventListener('abort', () => resolve({ status: 'cancelled', reason: 'Stopped.', provider: 'Claude Code', durationMs: 1 }));
    }));
    const agent = new FakeAgent(async (input, tools) => {
      await tools.consultRepository({ question: 'Slow?', why: 'why' });
      input.signal.throwIfAborted();
      return { reply: 'never' };
    });
    const { store, studio, design, progress } = await harness(agent, consultant);
    const turn = studio.converse({ designId: design.id, message: 'Go.' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(studio.getDesign(design.id)?.inFlight).toBe(true);
    expect(studio.cancel(design.id)).toBe(true);
    const outcome = await turn;

    expect(outcome).toMatchObject({ entry: null, cancelled: true });
    expect(consultSignal!.aborted).toBe(true);
    const entries = store.getDesignEntries(design.id);
    expect(entries.map((entry) => entry.role)).toEqual(['user_message']);
    expect(store.getRunForEntry(entries[0]!.id)).toBeNull();
    expect(progress.at(-1)).toMatchObject({ phase: 'finished', cancelled: true, entryId: null });
    expect(studio.getDesign(design.id)?.inFlight).toBe(false);
    expect(studio.cancel(design.id)).toBe(false);
  });

  it('rejects a second turn on a design while one is running', async () => {
    let release: () => void = () => undefined;
    const agent = new FakeAgent(() => new Promise((resolve) => { release = () => resolve({ reply: 'done' }); }));
    const { studio, design } = await harness(agent);
    const first = studio.converse({ designId: design.id, message: 'One.' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(studio.converse({ designId: design.id, message: 'Two.' })).rejects.toThrow(/still working/);
    release();
    await expect(first).resolves.toMatchObject({ failed: false });
    agent.script = async () => ({ reply: 'again' });
    await expect(studio.converse({ designId: design.id, message: 'Three.' })).resolves.toMatchObject({ failed: false });
  });

  it('reports progress in order, scoped to the design', async () => {
    const agent = new FakeAgent(consultThenMove);
    const { studio, design, progress } = await harness(agent);
    await studio.converse({ designId: design.id, message: 'Go.' });
    expect(progress.every((event) => event.designId === design.id && !('projectId' in event))).toBe(true);
    expect(progress.map((event) => event.phase)).toEqual([
      'started', 'message', 'consulting', 'consulting', 'check', 'message', 'model', 'finished',
    ]);
    expect(progress[3]).toMatchObject({ activity: 'Reading observer-runner.ts' });
  });

  it('keeps Studio out of the project conversation', async () => {
    const agent = new FakeAgent(consultThenMove);
    const { store, studio, design } = await harness(agent);
    await studio.converse({ designId: design.id, message: 'Maybe we should replace SQLite.' });
    expect(store.getProjectConversation(PROJECT)).toEqual([]);
  });

  it('lists designs by what was last said, titled from the design itself', async () => {
    const agent = new FakeAgent(async () => ({ reply: 'ok' }));
    const { studio, design } = await harness(agent);
    const other = await studio.createDesign(PROJECT);
    await studio.converse({ designId: other.id, message: 'Replace the claim store?\nMore detail.' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    agent.script = consultThenMove;
    await studio.converse({ designId: design.id, message: 'Project Understanding.' });
    const listed = studio.listDesigns(PROJECT);
    expect(listed.map((row) => [row.id, row.title, row.revisions])).toEqual([
      [design.id, 'Project Understanding', 1],
      [other.id, 'Replace the claim store?', 0],
    ]);
    // Enough to recognise it in a list: what it is for, and its shape.
    expect(listed[0]).toMatchObject({ intent: 'Durable understanding above the observer.', parts: 2, outline: [{ row: 0, col: 0 }, { row: 1, col: 0 }] });
    expect(listed[1]).toMatchObject({ intent: '', parts: 0, outline: [] });
  });

  /*
   * The Stage 2 corpus. For every revision, the whole record of how the design
   * changed must be recoverable from what Studio already writes — conversation,
   * revisions, receipts and the run trace — with no table added for it.
   */
  it('can reconstruct every design change from existing stores', async () => {
    const agent = new FakeAgent(consultThenMove);
    const { store, studio, design } = await harness(agent);
    await studio.converse({ designId: design.id, message: 'I think Project Understanding should sit above the observer.' });
    agent.script = async () => ({ reply: 'Then persistence belongs to it.', move: { ops: [{ op: 'design', intent: 'Owns persistence.' }], summary: 'Persistence moved with durable understanding.' } });
    await studio.converse({ designId: design.id, message: 'So who owns persistence?' });

    const entries = store.getDesignEntries(design.id);
    const revisions = store.getDesignRevisions(design.id);
    const corpus = revisions.map((revision) => {
      const replyAt = entries.findIndex((entry) => entry.id === revision.entryId);
      const reply = entries[replyAt]!;
      const run = store.getRunForEntry(reply.id)!;
      const findings = store.getTraceItems(run.id)
        .filter((item) => item.kind === 'tool_result')
        .map((item) => (item.payload as { result: ConsultationFinding }).result);
      return {
        developer: entries.slice(0, replyAt).reverse().find((entry) => entry.role === 'user_message')!.text,
        before: revisions.find((other) => other.ord === revision.ord - 1)?.document ?? null,
        consultations: reply.investigation?.checks.filter((check) => check.kind === 'consult').map((check) => check.label) ?? [],
        findings: findings.map((finding) => finding.status),
        response: reply.text,
        after: revision.document,
        move: revision.move?.ops,
        reason: revision.summary,
      };
    });

    expect(corpus[0]).toMatchObject({
      developer: 'I think Project Understanding should sit above the observer.',
      before: null,
      consultations: ['Checked the repository: Is observer coverage durable across restart?'],
      findings: ['answered'],
      reason: expect.stringMatching(/per-session/),
    });
    expect(corpus[1]).toMatchObject({
      developer: 'So who owns persistence?',
      before: corpus[0]!.after,
      consultations: [],
      findings: [],
      response: 'Then persistence belongs to it.',
      after: expect.stringMatching(/^# Project Understanding\n\nOwns persistence\./),
      move: [{ op: 'design', intent: 'Owns persistence.' }],
      reason: 'Persistence moved with durable understanding.',
    });
  });
});

describe('Studio canvas', () => {
  async function drawn() {
    const agent = new FakeAgent(consultThenMove);
    const fixture = await harness(agent);
    await fixture.studio.converse({ designId: fixture.design.id, message: 'I think Project Understanding should sit above the observer.' });
    return { agent, ...fixture };
  }

  it('commits a rename as the developer’s own move, silently', async () => {
    const { agent, store, studio, design } = await drawn();
    const outcome = await studio.manipulate(design.id, [{ op: 'part', id: 'observer', name: 'Session Observer' }]);

    expect(outcome.entry).toMatchObject({ role: 'developer_move', text: 'Renamed Observer to Session Observer' });
    expect(outcome.revision!.move).toMatchObject({ author: 'developer', via: 'canvas', summary: 'Renamed Observer to Session Observer' });
    expect(outcome.revision!.model!.parts[0]).toMatchObject({ id: 'observer', name: 'Session Observer' });
    expect(agent.inputs).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(agent.considered).toEqual([]);
    expect(store.getDesignEntries(design.id).map((entry) => entry.role)).toEqual(['user_message', 'companion_message', 'developer_move']);
  });

  it('lets Vowe notice a consequence of a semantic move, on the canvas and not in the thread', async () => {
    const { agent, store, studio, design } = await drawn();
    agent.note = { on: 'observer', text: 'Nothing keeps session coverage across a restart now.' };
    const outcome = await studio.manipulate(design.id, [{ op: 'duty', id: 'durable', part: 'project-understanding' }]);
    expect(outcome.entry!.text).toBe('Moved “durable across restarts” from Observer to Project Understanding');
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(agent.considered[0]!.move.id).toBe(outcome.revision!.move!.id);
    const note = store.getDesignEntries(design.id).at(-1)!;
    expect(note).toMatchObject({
      role: 'companion_note',
      text: 'Nothing keeps session coverage across a restart now.',
      anchor: { moveId: outcome.revision!.move!.id, on: 'observer' },
    });
    // The next turn hears about both, said as what they were.
    agent.script = async () => ({ reply: 'ok' });
    await studio.converse({ designId: design.id, message: 'Hm.' });
    expect(agent.inputs[1]!.conversation.slice(-2).map((turn) => turn.text)).toEqual([
      '[Changed the design on the canvas] Moved “durable across restarts” from Observer to Project Understanding',
      '[Noted on the canvas, on observer] Nothing keeps session coverage across a restart now.',
    ]);
  });

  it('reverts the same way whether the developer or Vowe asks', async () => {
    const { agent, store, studio, design } = await drawn();
    const moved = await studio.manipulate(design.id, [{ op: 'duty', id: 'durable', part: 'project-understanding' }]);
    const moveId = moved.revision!.move!.id;

    const byHand = await studio.manipulate(design.id, [{ op: 'revert', move: moveId }]);
    expect(byHand.entry!.text).toBe('Reverted: Moved “durable across restarts” from Observer to Project Understanding');
    expect(byHand.revision!.model).toEqual(store.getDesignRevisions(design.id)[0]!.model);

    await studio.manipulate(design.id, [{ op: 'duty', id: 'durable', part: 'project-understanding' }]);
    const again = store.getDesignRevisions(design.id).at(-1)!.move!.id;
    agent.script = async (input) => ({ reply: 'Reverted.', move: { ops: [{ op: 'revert', move: input.moves.at(-1)!.id }], summary: 'You wanted it back.' } });
    const bySaying = await studio.converse({ designId: design.id, message: 'Revert that.' });
    expect(agent.inputs.at(-1)!.moves.at(-1)!.id).toBe(again);
    expect(bySaying.revision!.model).toEqual(byHand.revision!.model);
  });

  it('refuses to change the design by hand while Vowe is mid-turn', async () => {
    const { agent, studio, design } = await drawn();
    let release: () => void = () => undefined;
    agent.script = () => new Promise((resolve) => { release = () => resolve({ reply: 'done' }); });
    const turn = studio.converse({ designId: design.id, message: 'Think.' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(studio.manipulate(design.id, [{ op: 'part', id: 'observer', name: 'X' }])).rejects.toThrow(/still working/);
    release();
    await turn;
  });

  it('keeps layout as view state: pins persist, turns never move what is placed, tidy spares pins', async () => {
    const { agent, store, studio, design } = await drawn();
    const revisions = store.getDesignRevisions(design.id).length;
    await studio.setLayout(design.id, { ...store.getDesignLayout(design.id), observer: { row: 0, col: 4, pinned: true } });
    expect(store.getDesignRevisions(design.id)).toHaveLength(revisions);

    agent.script = async () => ({ reply: 'Added home.', move: { ops: [{ op: 'part', id: 'home', name: 'Project Home', role: 'r' }, { op: 'link', from: 'project-understanding', to: 'home' }], summary: 's' } });
    await studio.converse({ designId: design.id, message: 'Home reads it.' });
    const layout = store.getDesignLayout(design.id);
    expect(layout['observer']).toEqual({ row: 0, col: 4, pinned: true });
    expect(layout['project-understanding']).toEqual({ row: 1, col: 0 });
    expect(layout['home']).toEqual({ row: 2, col: 0 });

    await studio.setLayout(design.id, { ...layout, 'project-understanding': { row: 7, col: 7 } });
    await studio.tidy(design.id);
    const tidy = store.getDesignLayout(design.id);
    expect(tidy['observer']).toEqual({ row: 0, col: 4, pinned: true });
    expect(tidy['project-understanding']!.row).toBe(1);
    expect(studio.getDesign(design.id)!.layout).toEqual(tidy);
  });
});

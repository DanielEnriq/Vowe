import { readdir, readFile } from 'node:fs/promises';

import { afterEach, describe, expect, it } from 'vitest';

import { formatRef, type ContextRef } from '../src/context/refs.js';
import type { OpenResult } from '../src/context/context-navigator.js';
import { VoweRunRecorder } from '../src/execution/run-recorder.js';
import type { ConsultationFinding, ConsultationRequest, RepositoryConsultant } from '../src/studio/consultation.js';
import { StudioService, type StudioProgress } from '../src/studio/studio-service.js';
import type {
  DesignCapabilities,
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
  constructor(public script: Turn) {}
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
  });
  const design = await studio.createDesign(PROJECT);
  void extra;
  return { store, studio, design, progress, consultant, opened };
}

const consultThenRevise: Turn = async (_input, tools, stream) => {
  stream.message?.('That fits conceptually, but I need to check the observer. ');
  const finding = await tools.consultRepository({ question: 'Is observer coverage durable across restart?', why: 'Placement of Project Understanding' });
  stream.message?.('I checked it.');
  stream.design?.('# Project Understanding\n\nAbove');
  return {
    reply: `That fits conceptually, but I need to check the observer. I checked it. ${finding.status === 'answered' ? finding.answer : ''}`,
    revision: {
      document: `# Project Understanding\n\nAbove the observer, which stays working memory ([observer-runner.ts](ref:${formatRef(OBSERVER)})). Invented: [made up](ref:repo:${ROOT}/src/imaginary.ts).`,
      summary: 'The observer turned out to be per-session and non-durable, so durable understanding moved above it.',
    },
  };
};

describe('StudioService', () => {
  it('gives the agent exactly one capability and nothing that reaches a worker', async () => {
    const agent = new FakeAgent(consultThenRevise);
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
    const agent = new FakeAgent(consultThenRevise);
    const { store, studio, design } = await harness(agent);
    const outcome = await studio.converse({ designId: design.id, message: 'I think Project Understanding should sit above the observer.' });

    const [asked, reply] = store.getDesignEntries(design.id);
    expect(asked!.role).toBe('user_message');
    expect(reply!.id).toBe(outcome.entry!.id);
    const [revision] = store.getDesignRevisions(design.id);
    expect(revision!.entryId).toBe(reply!.id);
    expect(revision!.summary).toMatch(/per-session/);
    // The consulted file stays a link; the invented one is text.
    expect(revision!.document).toContain(`[observer-runner.ts](ref:${formatRef(OBSERVER)})`);
    expect(revision!.document).toContain('Invented: made up.');
    expect(revision!.document).not.toContain('imaginary.ts');
  });

  it('receipts and traces each consultation where it ran', async () => {
    const agent = new FakeAgent(consultThenRevise);
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
    const agent = new FakeAgent(async () => ({ reply: 'Recorded it.', revision: { document: '# d', summary: '  ' } }));
    const { store, studio, design } = await harness(agent);
    await studio.converse({ designId: design.id, message: 'Note that.' });
    expect(store.getDesignRevisions(design.id)[0]!.summary).toBe('');
  });

  it('hands the agent the current design, recent turns, earlier findings and attachments', async () => {
    const agent = new FakeAgent(consultThenRevise);
    const { studio, design, opened } = await harness(agent);
    await studio.converse({ designId: design.id, message: 'First thought.' });
    agent.script = async () => ({ reply: 'Noted.' });
    await studio.converse({ designId: design.id, message: 'Second thought.', contextRefs: [SERVICE] });

    const input = agent.inputs[1]!;
    expect(input.message).toBe('Second thought.');
    expect(input.design?.revision).toBe(1);
    expect(input.design?.document).toMatch(/^# Project Understanding/);
    expect(input.conversation.map((turn) => turn.speaker)).toEqual(['developer', 'vowe']);
    expect(input.findings).toEqual([expect.objectContaining({
      question: 'Is observer coverage durable across restart?',
      refs: [formatRef(OBSERVER)],
    })]);
    expect(opened).toEqual([formatRef(SERVICE)]);
    expect(input.attachments?.[0]?.content).toBe('attached file content');
  });

  it('lets a later turn cite what an earlier turn checked, and nothing else', async () => {
    const agent = new FakeAgent(consultThenRevise);
    const { store, studio, design } = await harness(agent);
    await studio.converse({ designId: design.id, message: 'First.' });
    agent.script = async () => ({
      reply: `As checked earlier ([runner](ref:${formatRef(OBSERVER)})), and [service](ref:${formatRef(SERVICE)}).`,
      revision: { document: `# v2 [line 7](ref:repo:${OBSERVER.path}#7)`, summary: 'Refined.' },
    });
    const outcome = await studio.converse({ designId: design.id, message: 'Second.' });
    expect(outcome.entry!.text).toBe(`As checked earlier ([runner](ref:${formatRef(OBSERVER)})), and service.`);
    expect(store.getDesignRevisions(design.id)[1]!.document).toBe(`# v2 [line 7](ref:repo:${OBSERVER.path}#7)`);
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
      return { reply: `I could not check that (${finding.status}); treating it as an assumption.`, revision: { document: '# d\n\nAssumption: unchecked.', summary: 'Recorded the persistence question as unchecked.' } };
    });
    const { store, studio, design } = await harness(agent, consultant);
    const outcome = await studio.converse({ designId: design.id, message: 'Does it persist?' });
    expect(outcome.failed).toBe(false);
    expect(outcome.entry!.investigation!.checks[0]).toMatchObject({ label: 'Could not check the repository: Does it persist?', detail: 'Claude Code is not signed in.' });
    expect(store.getDesignRevisions(design.id)).toHaveLength(1);
  });

  it('records a failed turn honestly and leaves the design unchanged', async () => {
    const agent = new FakeAgent(consultThenRevise);
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
    const agent = new FakeAgent(consultThenRevise);
    const { studio, design, progress } = await harness(agent);
    await studio.converse({ designId: design.id, message: 'Go.' });
    expect(progress.every((event) => event.designId === design.id && !('projectId' in event))).toBe(true);
    expect(progress.map((event) => event.phase)).toEqual([
      'started', 'message', 'consulting', 'consulting', 'check', 'message', 'design', 'finished',
    ]);
    expect(progress[3]).toMatchObject({ activity: 'Reading observer-runner.ts' });
  });

  it('keeps Studio out of the project conversation', async () => {
    const agent = new FakeAgent(consultThenRevise);
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
    agent.script = consultThenRevise;
    await studio.converse({ designId: design.id, message: 'Project Understanding.' });
    const listed = studio.listDesigns(PROJECT);
    expect(listed.map((row) => [row.id, row.title, row.revisions])).toEqual([
      [design.id, 'Project Understanding', 1],
      [other.id, 'Replace the claim store?', 0],
    ]);
  });

  /*
   * The Stage 2 corpus. For every revision, the whole record of how the design
   * changed must be recoverable from what Studio already writes — conversation,
   * revisions, receipts and the run trace — with no table added for it.
   */
  it('can reconstruct every design change from existing stores', async () => {
    const agent = new FakeAgent(consultThenRevise);
    const { store, studio, design } = await harness(agent);
    await studio.converse({ designId: design.id, message: 'I think Project Understanding should sit above the observer.' });
    agent.script = async () => ({ reply: 'Then persistence belongs to it.', revision: { document: '# Project Understanding\n\nOwns persistence.', summary: 'Persistence moved with durable understanding.' } });
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
      after: '# Project Understanding\n\nOwns persistence.',
      reason: 'Persistence moved with durable understanding.',
    });
  });
});

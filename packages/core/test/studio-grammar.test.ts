import { describe, expect, it } from 'vitest';

import {
  applyOps,
  describeCanvasMove,
  diffModels,
  EMPTY_MODEL,
  live,
  parseOp,
  projectMarkdown,
  revertModel,
  technologyKey,
  todayModel,
  visibleEntries,
  type DesignModel,
  type DesignOp,
  type RepositoryBasis,
} from '../src/studio/design-model.js';

/*
 * The system-design grammar against the designs it has to carry: a simple
 * SaaS product, an AI product, a realtime product, an existing monorepo and
 * Vowe itself. Each is written as the agent would write its first move — one
 * JSON op per line, read by the same `parseOp` the canvas goes through — and
 * each has to read as a system in six kinds, without a new type per example.
 */

const BASIS: RepositoryBasis = { worktree: '/repo', head: 'abc123', branch: 'main', dirty: false, at: '2026-09-26T00:00:00.000Z' };

/** A move as the agent writes it: JSON lines, parsed exactly as the stream parses them. */
function drawn(lines: string[], basis?: RepositoryBasis): DesignModel {
  const ops = lines.map((line) => parseOp(JSON.parse(line)));
  expect(ops.every((op) => op !== null)).toBe(true);
  const result = applyOps(EMPTY_MODEL, ops as DesignOp[], basis ? { basis } : {});
  expect(result.rejected).toEqual([]);
  return result.model;
}

const SAAS = [
  '{"op":"design","title":"Invoicing SaaS","intent":"Teams sign in, send invoices and get paid."}',
  '{"op":"part","id":"browser","name":"Web app","role":"Where teams manage invoices","kind":"client"}',
  '{"op":"part","id":"auth","name":"Auth","role":"Sign-in and sessions","kind":"service","technology":{"name":"Supabase Auth","key":"supabase"}}',
  '{"op":"part","id":"api","name":"API","role":"Invoices, customers, payments","kind":"service"}',
  '{"op":"part","id":"db","name":"Database","role":"Accounts and invoices","kind":"store","technology":{"name":"PostgreSQL","key":"postgresql"}}',
  '{"op":"part","id":"stripe","name":"Stripe","role":"Takes card payments","kind":"external","technology":{"name":"Stripe","key":"stripe"}}',
  '{"op":"link","from":"browser","to":"auth"}',
  '{"op":"link","from":"browser","to":"api"}',
  '{"op":"link","from":"api","to":"db"}',
  '{"op":"link","from":"api","to":"stripe","label":"charges"}',
  '{"op":"link","from":"stripe","to":"api","label":"webhook"}',
];

const AI = [
  '{"op":"design","title":"Document summaries","intent":"Users upload documents and get summaries without waiting on the request."}',
  '{"op":"part","id":"web","name":"Web app","role":"Upload and read summaries","kind":"client"}',
  '{"op":"part","id":"backend","name":"Backend","role":"What we run","kind":"group"}',
  '{"op":"part","id":"api","name":"API","role":"Accepts uploads, serves results","kind":"service","within":"backend"}',
  '{"op":"part","id":"db","name":"Database","role":"Documents and summaries","kind":"store","within":"backend"}',
  '{"op":"part","id":"jobs","name":"Job queue","role":"Summaries waiting to run","kind":"queue","within":"backend"}',
  '{"op":"part","id":"worker","name":"Summary worker","role":"Runs summaries off the request path","kind":"service","within":"backend"}',
  '{"op":"part","id":"model","name":"Model provider","role":"Writes the summary","kind":"external","technology":{"name":"Anthropic","key":"anthropic"}}',
  '{"op":"link","from":"web","to":"api"}',
  '{"op":"link","from":"api","to":"db"}',
  '{"op":"link","from":"api","to":"jobs","label":"enqueues"}',
  '{"op":"link","from":"jobs","to":"worker"}',
  '{"op":"link","from":"worker","to":"model"}',
  '{"op":"link","from":"worker","to":"db","label":"writes"}',
  '{"op":"responsibility","id":"retries","part":"api","text":"retries failed summaries"}',
];

const REALTIME = [
  '{"op":"design","title":"Live whiteboard","intent":"Many people edit one board at once and see each other instantly."}',
  '{"op":"part","id":"clients","name":"Clients","role":"Web and iPad editors","kind":"client"}',
  '{"op":"part","id":"gateway","name":"Realtime gateway","role":"Holds each client’s socket","kind":"service","technology":{"name":"WebSockets"}}',
  '{"op":"part","id":"boards","name":"Board service","role":"Orders and applies edits","kind":"service"}',
  '{"op":"part","id":"presence","name":"Presence","role":"Who is on which board","kind":"store","technology":{"name":"Redis","key":"redis"}}',
  '{"op":"part","id":"db","name":"Board store","role":"Durable board history","kind":"store","technology":{"name":"PostgreSQL","key":"postgresql"}}',
  '{"op":"link","from":"clients","to":"gateway"}',
  '{"op":"link","from":"gateway","to":"boards"}',
  '{"op":"link","from":"gateway","to":"presence"}',
  '{"op":"link","from":"boards","to":"db"}',
  '{"op":"responsibility","id":"ordering","part":"boards","text":"one order of edits per board"}',
];

/** An existing monorepo, grounded by a consultation and abstracted to what runs. */
const MONOREPO = [
  '{"op":"design","title":"Split reporting out of the API","intent":"Reports are slow and block requests; give them their own path."}',
  '{"op":"part","id":"web","name":"Dashboard","role":"Customers’ reporting UI","kind":"client","technology":{"name":"Next.js","key":"nextjs"},"today":true}',
  '{"op":"part","id":"api","name":"API","role":"Every backend request","kind":"service","technology":{"name":"Express"},"today":true}',
  '{"op":"part","id":"db","name":"Database","role":"Everything","kind":"store","technology":{"name":"PostgreSQL","key":"postgresql"},"today":true}',
  '{"op":"part","id":"cron","name":"Nightly jobs","role":"Exports and cleanup","kind":"service","today":true}',
  '{"op":"link","from":"web","to":"api","today":true}',
  '{"op":"link","from":"api","to":"db","today":true}',
  '{"op":"link","from":"cron","to":"db","today":true}',
  '{"op":"responsibility","id":"reports","part":"api","text":"builds reports","today":true}',
];

const VOWE = [
  '{"op":"design","title":"Vowe’s design loop","intent":"How Studio, project understanding, coding harnesses and observation fit together."}',
  '{"op":"part","id":"desktop","name":"Vowe desktop","role":"What runs on the developer’s machine","kind":"group","technology":{"name":"Electron","key":"electron"}}',
  '{"op":"part","id":"studio","name":"Studio","role":"Where the design is worked on","kind":"client","within":"desktop"}',
  '{"op":"part","id":"design-agent","name":"Design agent","role":"Decides how the design changes","kind":"service","within":"desktop"}',
  '{"op":"part","id":"observation","name":"Observation","role":"Watches worker sessions","kind":"service","within":"desktop"}',
  '{"op":"part","id":"understanding","name":"Project understanding","role":"What Vowe knows about the project","kind":"store","within":"desktop","technology":{"name":"SQLite","key":"sqlite"}}',
  '{"op":"part","id":"harness","name":"Coding harness","role":"Reads and changes the code","kind":"external","technology":{"name":"Claude Code","key":"claude-code"}}',
  '{"op":"part","id":"model","name":"Model provider","role":"Thinks for the agents","kind":"external","technology":{"name":"Anthropic","key":"anthropic"}}',
  '{"op":"link","from":"studio","to":"design-agent"}',
  '{"op":"link","from":"design-agent","to":"harness","label":"consults"}',
  '{"op":"link","from":"design-agent","to":"model"}',
  '{"op":"link","from":"harness","to":"observation","label":"observed by"}',
  '{"op":"link","from":"observation","to":"understanding","label":"updates"}',
  '{"op":"link","from":"understanding","to":"design-agent","label":"grounds"}',
];

const SCENARIOS: [string, string[], RepositoryBasis?][] = [
  ['a simple SaaS product', SAAS],
  ['an AI product', AI],
  ['a realtime product', REALTIME],
  ['an existing monorepo', MONOREPO, BASIS],
  ['Vowe itself', VOWE],
];

describe('the grammar carries real designs', () => {
  it.each(SCENARIOS)('draws %s as a sparse system in six kinds', (_name, lines, basis) => {
    const model = drawn(lines, basis);
    const parts = live(model.parts);
    expect(parts.length).toBeGreaterThanOrEqual(4);
    expect(parts.length).toBeLessThanOrEqual(10);
    // Every part is a kind of thing a developer draws, and none is code.
    expect(parts.every((part) => part.kind)).toBe(true);
    expect(parts.some((part) => /\.(ts|js|py|go)\b|\(\)|::/.test(part.name))).toBe(false);
    // Responsibilities are the exception, not the rule.
    expect(live(model.duties).length).toBeLessThanOrEqual(Math.ceil(parts.length / 3));
    // One layer of boundary at most, and only around real parts.
    for (const part of parts.filter((candidate) => candidate.within)) {
      const group = parts.find((candidate) => candidate.id === part.within)!;
      expect(group.kind).toBe('group');
      expect(group.within).toBeUndefined();
    }
  });

  it('writes a brief that carries the design without the conversation', () => {
    expect(projectMarkdown(drawn(AI))).toBe([
      '# Document summaries',
      '',
      'Users upload documents and get summaries without waiting on the request.',
      '',
      '## System',
      '- **Web app** · client — Upload and read summaries',
      '- **Model provider** · external · Anthropic — Writes the summary',
      '',
      '## Backend',
      '',
      'What we run',
      '',
      '- **API** · service — Accepts uploads, serves results',
      '  - retries failed summaries',
      '- **Database** · store — Documents and summaries',
      '- **Job queue** · queue — Summaries waiting to run',
      '- **Summary worker** · service — Runs summaries off the request path',
      '',
      '## Connections',
      '- Web app → API',
      '- API → Database',
      '- API → Job queue (enqueues)',
      '- Job queue → Summary worker',
      '- Summary worker → Model provider',
      '- Summary worker → Database (writes)',
    ].join('\n'));
  });

  it('records the kind and technology of what exists today, so a redesign reads against it', () => {
    const today = drawn(MONOREPO, BASIS);
    expect(today.parts.find((part) => part.id === 'db')!.today).toEqual({
      name: 'Database', role: 'Everything', kind: 'store', technology: { name: 'PostgreSQL', key: 'postgresql' }, basis: BASIS,
    });
    const proposed = applyOps(today, [
      { op: 'part', id: 'reporting', name: 'Reporting worker', role: 'Builds reports off the request path', kind: 'service' },
      { op: 'part', id: 'warehouse', name: 'Warehouse', role: 'Report-shaped copy of the data', kind: 'store', technology: { name: 'ClickHouse' } },
      { op: 'link', from: 'db', to: 'warehouse', label: 'replicates' },
      { op: 'link', from: 'reporting', to: 'warehouse' },
      { op: 'duty', id: 'reports', part: 'reporting' },
      { op: 'part', id: 'api', technology: { name: 'Fastify' } },
    ]).model;
    const said = visibleEntries(diffModels(todayModel(proposed), proposed)).map((entry) => entry.id);
    expect(said).toEqual(['api', 'reporting', 'warehouse', 'db->warehouse', 'reporting->warehouse', 'reports']);
    expect(projectMarkdown(proposed)).toContain('- Changes API from Express to Fastify');
    expect(projectMarkdown(proposed)).toContain('- Moves “builds reports” from API to Reporting worker');
  });

  it('never reads an unrecorded kind or technology as a difference from today', () => {
    // A part grounded before the grammar existed: today knows only its name and role.
    const old = applyOps(EMPTY_MODEL, [{ op: 'part', id: 'db', name: 'Database', role: 'Everything', today: true }]).model;
    const typed = applyOps(old, [{ op: 'part', id: 'db', kind: 'store', technology: { name: 'PostgreSQL' } }]).model;
    expect(visibleEntries(diffModels(todayModel(typed), typed))).toEqual([]);
  });
});

describe('boundaries', () => {
  const base = (): DesignModel => drawn(AI);

  it('holds a part only inside a live group, one layer deep', () => {
    const result = applyOps(base(), [
      { op: 'part', id: 'web', within: 'api' },
      { op: 'part', id: 'web', within: 'nowhere' },
      { op: 'part', id: 'edge', name: 'Edge', role: '', kind: 'group', within: 'backend' },
      { op: 'part', id: 'backend', within: 'backend' },
      { op: 'part', id: 'backend', kind: 'service' },
    ]);
    expect(result.rejected.map((item) => item.reason)).toEqual([
      'No group api to put web inside.',
      'No group nowhere to put web inside.',
      'A group does not sit inside another part.',
      'A group does not sit inside another part.',
      'Backend still holds parts; take them out before it stops being a group.',
    ]);
    // A refused new part leaves nothing behind.
    expect(result.model.parts.some((part) => part.id === 'edge')).toBe(false);
    expect(result.model).toEqual(base());
  });

  it('keeps what was inside a boundary when the boundary goes, and a revert puts it back', () => {
    const before = base();
    const after = applyOps(before, [{ op: 'remove', id: 'backend' }]).model;
    expect(after.parts.some((part) => part.id === 'backend')).toBe(false);
    expect(live(after.parts).map((part) => part.id)).toEqual(['web', 'api', 'db', 'jobs', 'worker', 'model']);
    expect(after.parts.every((part) => !part.within)).toBe(true);
    expect(live(after.links)).toHaveLength(live(before.links).length);

    const { model, conflicts } = revertModel(before, after, after);
    expect(conflicts).toEqual([]);
    // A restored element rejoins the end of its list; order is not design.
    const byId = (m: DesignModel) => ({ ...m, parts: [...m.parts].sort((x, y) => x.id.localeCompare(y.id)) });
    expect(byId(model)).toEqual(byId(before));
  });

  it('will not revert a boundary away while something later put inside it', () => {
    const m0 = applyOps(EMPTY_MODEL, [{ op: 'part', id: 'api', name: 'API', role: '', kind: 'service' }]).model;
    const m1 = applyOps(m0, [{ op: 'part', id: 'backend', name: 'Backend', role: '', kind: 'group' }]).model;
    const m2 = applyOps(m1, [{ op: 'part', id: 'api', within: 'backend' }]).model;
    const { model, conflicts } = revertModel(m0, m1, m2);
    expect(conflicts).toEqual(['backend']);
    expect(model).toEqual(m2);
  });
});

describe('canvas and conversation speak the same move', () => {
  it('ends a gesture and a sentence as the same ops, the same design and the same account', () => {
    const before = drawn(AI);
    // What the agent writes for "move retry handling to the worker" / "take the database out of the backend"…
    const said = ['{"op":"responsibility","id":"retries","part":"worker"}', '{"op":"part","id":"db","within":null}'].map((line) => parseOp(JSON.parse(line)));
    // …and what the canvas sends over IPC for the same drags.
    const dragged = [{ op: 'duty', id: 'retries', part: 'worker' }, { op: 'part', id: 'db', within: null }].map(parseOp);
    expect(said).toEqual(dragged);
    const a = applyOps(before, said as DesignOp[]).model;
    const b = applyOps(before, dragged as DesignOp[]).model;
    expect(a).toEqual(b);
    expect(describeCanvasMove(before, applyOps(before, [dragged[0]!]).model)).toBe('Moved “retries failed summaries” from API to Summary worker');
    expect(describeCanvasMove(before, applyOps(before, [dragged[1]!]).model)).toBe('Moved Database out of Backend');
    expect(describeCanvasMove(a, applyOps(a, [{ op: 'part', id: 'db', within: 'backend' }]).model)).toBe('Moved Database into Backend');
  });
});

describe('technology', () => {
  it('keeps the key as optional presentation, never identity', () => {
    expect(parseOp({ op: 'part', id: 'db', technology: { name: 'PostgreSQL', key: 'PostgreSQL' } })).toEqual({ op: 'part', id: 'db', technology: { name: 'PostgreSQL', key: 'postgresql' } });
    expect(parseOp({ op: 'part', id: 'db', technology: { name: 'PostgreSQL', key: 'not a key!' } })).toEqual({ op: 'part', id: 'db', technology: { name: 'PostgreSQL' } });
    expect(parseOp({ op: 'part', id: 'db', technology: 'Redis' })).toEqual({ op: 'part', id: 'db', technology: { name: 'Redis' } });
    expect(parseOp({ op: 'part', id: 'db', technology: null })).toEqual({ op: 'part', id: 'db', technology: null });
    expect(parseOp({ op: 'part', id: 'db', technology: { key: 'redis' } })).toEqual({ op: 'part', id: 'db' });

    // No key is stored unless one was given; a renderer derives one on read.
    const model = drawn(REALTIME);
    expect(model.parts.find((part) => part.id === 'gateway')!.technology).toEqual({ name: 'WebSockets' });
    expect(technologyKey({ name: 'AWS S3' })).toBe('aws-s3');
    expect(technologyKey({ name: 'Supabase Postgres', key: 'supabase' })).toBe('supabase');

    // Correcting or canonicalising a key later is not a change to the design.
    const recanonicalised = applyOps(model, [{ op: 'part', id: 'presence', technology: { name: 'Redis', key: 'redis-oss' } }]).model;
    expect(diffModels(model, recanonicalised).entries).toEqual([]);
    const cleared = applyOps(model, [{ op: 'part', id: 'presence', technology: null }]).model;
    expect(cleared.parts.find((part) => part.id === 'presence')!.technology).toBeUndefined();
  });
});

describe('compatibility', () => {
  it('reads an unknown kind as unspecified rather than refusing the op', () => {
    expect(parseOp({ op: 'part', id: 'x', name: 'X', kind: 'microservice' })).toEqual({ op: 'part', id: 'x', name: 'X' });
    expect(parseOp({ op: 'part', id: 'x', kind: null })).toEqual({ op: 'part', id: 'x', kind: null });
  });

  it('leaves a model without the grammar exactly as it was', () => {
    const plain: DesignOp[] = [
      { op: 'part', id: 'observer', name: 'Observer', role: 'Watches a session', today: true },
      { op: 'part', id: 'state', name: 'Semantic State', role: 'What a session means' },
      { op: 'link', from: 'observer', to: 'state' },
      { op: 'duty', id: 'durable', part: 'observer', text: 'durable across restarts' },
    ];
    const model = applyOps(EMPTY_MODEL, plain).model;
    expect(model.parts[0]).toEqual({ id: 'observer', name: 'Observer', role: 'Watches a session', today: { name: 'Observer', role: 'Watches a session' } });
    expect(projectMarkdown(model)).toContain('## System\n- **Observer** — Watches a session\n  - durable across restarts\n- **Semantic State** — What a session means');
  });
});

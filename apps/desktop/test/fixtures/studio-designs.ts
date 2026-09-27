/**
 * The designs Studio has to draw well, written as the moves that make them —
 * the same ops a sentence to Vowe or a gesture on the canvas produces. Shared
 * by the renderer tests and by seeding the real app for visual review
 * (`node apps/desktop/test/fixtures/studio-designs.ts` prints them as JSON).
 */
import type { DesignOp } from '@vowe/core';

export interface DesignFixture {
  title: string;
  ops: DesignOp[];
  /** Later moves, each one a change worth watching happen. */
  moves?: { summary: string; ops: DesignOp[] }[];
}

export const SIMPLE_SAAS: DesignFixture = {
  title: 'Invoicing SaaS',
  ops: [
    { op: 'design', title: 'Invoicing SaaS', intent: 'Teams sign in, send invoices and get paid.' },
    { op: 'part', id: 'web', name: 'Web App', role: 'Where teams manage invoices', kind: 'client', technology: { name: 'Next.js', key: 'nextjs' } },
    { op: 'part', id: 'auth', name: 'Auth', role: 'Sign-in and sessions', kind: 'service', technology: { name: 'Supabase Auth', key: 'supabase' } },
    { op: 'part', id: 'api', name: 'API', role: 'Invoices, customers, payments', kind: 'service', technology: { name: 'Express' } },
    { op: 'part', id: 'db', name: 'Database', role: 'Accounts and invoices', kind: 'store', technology: { name: 'PostgreSQL', key: 'postgresql' } },
    { op: 'link', from: 'web', to: 'auth' },
    { op: 'link', from: 'web', to: 'api' },
    { op: 'link', from: 'api', to: 'db' },
  ],
  moves: [
    {
      summary: 'Take payments through Stripe',
      ops: [
        { op: 'part', id: 'stripe', name: 'Stripe', role: 'Takes card payments', kind: 'external', technology: { name: 'Stripe', key: 'stripe' } },
        { op: 'link', from: 'api', to: 'stripe', label: 'charges' },
        { op: 'link', from: 'stripe', to: 'api', label: 'webhook' },
      ],
    },
    { summary: 'Move the API to Fastify', ops: [{ op: 'part', id: 'api', technology: { name: 'Fastify', key: 'fastify' } }] },
  ],
};

export const AI_PRODUCT: DesignFixture = {
  title: 'Document summaries',
  ops: [
    { op: 'design', title: 'Document summaries', intent: 'Users upload documents and get summaries without waiting on the request.' },
    { op: 'part', id: 'web', name: 'Web App', role: 'Upload and read summaries', kind: 'client' },
    { op: 'part', id: 'backend', name: 'Backend', role: 'What we run', kind: 'group' },
    { op: 'part', id: 'api', name: 'API', role: 'Accepts uploads, serves results', kind: 'service', within: 'backend' },
    { op: 'part', id: 'db', name: 'Document Store', role: 'Documents and summaries', kind: 'store', within: 'backend', technology: { name: 'PostgreSQL', key: 'postgresql' } },
    { op: 'part', id: 'jobs', name: 'Job Queue', role: 'Summaries waiting to run', kind: 'queue', within: 'backend' },
    { op: 'part', id: 'worker', name: 'Summarizer Worker', role: 'Runs summaries off the request path', kind: 'service', within: 'backend' },
    { op: 'part', id: 'model', name: 'Model Provider', role: 'Writes the summary', kind: 'external', technology: { name: 'Anthropic', key: 'anthropic' } },
    { op: 'link', from: 'web', to: 'api' },
    { op: 'link', from: 'api', to: 'db' },
    { op: 'link', from: 'api', to: 'jobs', label: 'enqueues' },
    { op: 'link', from: 'jobs', to: 'worker' },
    { op: 'link', from: 'worker', to: 'db', label: 'writes' },
    { op: 'link', from: 'worker', to: 'model' },
    { op: 'duty', id: 'retries', part: 'api', text: 'retries failed summaries' },
  ],
  moves: [
    { summary: 'Retries belong to the worker', ops: [{ op: 'duty', id: 'retries', part: 'worker' }] },
  ],
};

/** The AI product before its store was inside the boundary: for watching it move in. */
export const AI_PRODUCT_STORE_OUTSIDE: DesignFixture = {
  title: 'Document summaries (store outside)',
  ops: AI_PRODUCT.ops.map((op) => {
    if (op.op !== 'part' || op.id !== 'db') return op;
    const { within: _outside, ...rest } = op;
    return rest;
  }),
  moves: [{ summary: 'Keep the document store inside the backend', ops: [{ op: 'part', id: 'db', within: 'backend' }] }],
};

export const REALTIME: DesignFixture = {
  title: 'Live whiteboard',
  ops: [
    { op: 'design', title: 'Live whiteboard', intent: 'Many people edit one board at once and see each other instantly.' },
    { op: 'part', id: 'clients', name: 'Clients', role: 'Web and iPad editors', kind: 'client' },
    { op: 'part', id: 'gateway', name: 'Realtime Gateway', role: 'Holds each client’s socket', kind: 'service', technology: { name: 'WebSockets' } },
    { op: 'part', id: 'boards', name: 'Board Service', role: 'Orders and applies edits', kind: 'service' },
    { op: 'part', id: 'db', name: 'Board Store', role: 'Durable board history', kind: 'store', technology: { name: 'PostgreSQL', key: 'postgresql' } },
    { op: 'part', id: 'presence', name: 'Presence', role: 'Who is on which board', kind: 'store', technology: { name: 'Redis', key: 'redis' } },
    { op: 'link', from: 'clients', to: 'gateway' },
    { op: 'link', from: 'gateway', to: 'boards' },
    { op: 'link', from: 'gateway', to: 'presence' },
    { op: 'link', from: 'boards', to: 'db' },
    { op: 'duty', id: 'ordering', part: 'boards', text: 'one order of edits per board' },
  ],
};

export const VOWE: DesignFixture = {
  title: 'Vowe’s design loop',
  ops: [
    { op: 'design', title: 'Vowe’s design loop', intent: 'How Studio, project understanding, coding harnesses and observation fit together.' },
    { op: 'part', id: 'desktop', name: 'Vowe desktop', role: 'What runs on the developer’s machine', kind: 'group', technology: { name: 'Electron', key: 'electron' } },
    { op: 'part', id: 'studio', name: 'Studio', role: 'Where the design is worked on', kind: 'client', within: 'desktop' },
    { op: 'part', id: 'design-agent', name: 'Design Agent', role: 'Decides how the design changes', kind: 'service', within: 'desktop' },
    { op: 'part', id: 'observation', name: 'Observation', role: 'Watches worker sessions', kind: 'service', within: 'desktop' },
    { op: 'part', id: 'understanding', name: 'Project Understanding', role: 'What Vowe knows about the project', kind: 'store', within: 'desktop', technology: { name: 'SQLite', key: 'sqlite' } },
    { op: 'part', id: 'harness', name: 'Coding Harness', role: 'Reads and changes the code', kind: 'external', technology: { name: 'Claude Code', key: 'claude-code' } },
    { op: 'part', id: 'model', name: 'Model Provider', role: 'Thinks for the agents', kind: 'external', technology: { name: 'Anthropic', key: 'anthropic' } },
    { op: 'link', from: 'studio', to: 'design-agent' },
    { op: 'link', from: 'design-agent', to: 'harness', label: 'consults' },
    { op: 'link', from: 'design-agent', to: 'model' },
    { op: 'link', from: 'harness', to: 'observation', label: 'observed by' },
    { op: 'link', from: 'observation', to: 'understanding', label: 'updates' },
    { op: 'link', from: 'understanding', to: 'design-agent', label: 'grounds' },
  ],
};

/** About a dozen parts, with a boundary and many technologies: does it still read as architecture first? */
export const MARKETPLACE: DesignFixture = {
  title: 'Marketplace platform',
  ops: [
    { op: 'design', title: 'Marketplace platform', intent: 'Buyers, sellers and support on one platform, with search and payouts.' },
    { op: 'part', id: 'web', name: 'Storefront', role: 'Where buyers browse and pay', kind: 'client', technology: { name: 'Next.js', key: 'nextjs' } },
    { op: 'part', id: 'mobile', name: 'Mobile App', role: 'Buyers on the go', kind: 'client', technology: { name: 'React Native' } },
    { op: 'part', id: 'admin', name: 'Admin', role: 'Support and moderation', kind: 'client' },
    { op: 'part', id: 'platform', name: 'Platform', role: 'Everything we run', kind: 'group', technology: { name: 'AWS' } },
    { op: 'part', id: 'gateway', name: 'API Gateway', role: 'One door for every client', kind: 'service', within: 'platform' },
    { op: 'part', id: 'orders', name: 'Orders', role: 'Carts, orders, fulfilment', kind: 'service', within: 'platform', technology: { name: 'Node.js', key: 'nodejs' } },
    { op: 'part', id: 'search', name: 'Search', role: 'Listings as buyers look for them', kind: 'service', within: 'platform' },
    { op: 'part', id: 'db', name: 'Orders DB', role: 'Orders and accounts', kind: 'store', within: 'platform', technology: { name: 'PostgreSQL', key: 'postgresql' } },
    { op: 'part', id: 'index', name: 'Search Index', role: 'Listings, ranked', kind: 'store', within: 'platform', technology: { name: 'OpenSearch' } },
    { op: 'part', id: 'events', name: 'Order Events', role: 'What happened to each order', kind: 'queue', within: 'platform', technology: { name: 'Kafka', key: 'kafka' } },
    { op: 'part', id: 'payouts', name: 'Payouts Worker', role: 'Pays sellers once orders settle', kind: 'service', within: 'platform' },
    { op: 'part', id: 'stripe', name: 'Stripe', role: 'Charges and payouts', kind: 'external', technology: { name: 'Stripe', key: 'stripe' } },
    { op: 'part', id: 'email', name: 'Email', role: 'Receipts and notices', kind: 'external', technology: { name: 'Resend', key: 'resend' } },
    { op: 'link', from: 'web', to: 'gateway' },
    { op: 'link', from: 'mobile', to: 'gateway' },
    { op: 'link', from: 'admin', to: 'gateway' },
    { op: 'link', from: 'gateway', to: 'orders' },
    { op: 'link', from: 'gateway', to: 'search' },
    { op: 'link', from: 'orders', to: 'db' },
    { op: 'link', from: 'search', to: 'index' },
    { op: 'link', from: 'orders', to: 'events', label: 'publishes' },
    { op: 'link', from: 'events', to: 'payouts' },
    { op: 'link', from: 'payouts', to: 'stripe' },
    { op: 'link', from: 'orders', to: 'email' },
  ],
};

/** A design from before kinds, technologies and boundaries: it must still read as a system. */
export const LEGACY: DesignFixture = {
  title: 'Where project understanding lives',
  ops: [
    { op: 'design', title: 'Where project understanding lives', intent: 'Place durable understanding above the observer.' },
    { op: 'part', id: 'session-registry', name: 'SessionRegistry', role: 'Knows every worker session' },
    { op: 'part', id: 'observer', name: 'Observer', role: 'Watches a session' },
    { op: 'part', id: 'semantic-state', name: 'Semantic State', role: 'What a session means' },
    { op: 'part', id: 'understanding', name: 'Project Understanding', role: 'Durable understanding' },
    { op: 'link', from: 'session-registry', to: 'observer' },
    { op: 'link', from: 'observer', to: 'semantic-state', label: 'updates' },
    { op: 'link', from: 'semantic-state', to: 'understanding', label: 'promotes' },
    { op: 'duty', id: 'durable', part: 'understanding', text: 'durable across restarts' },
  ],
};

export const DESIGNS: DesignFixture[] = [AI_PRODUCT, SIMPLE_SAAS, REALTIME, VOWE, MARKETPLACE, LEGACY, AI_PRODUCT_STORE_OUTSIDE];

// Printed as JSON when run directly, for seeding the app.
if (typeof process !== 'undefined' && process.argv[1]?.endsWith('studio-designs.ts')) {
  console.log(JSON.stringify(DESIGNS));
}

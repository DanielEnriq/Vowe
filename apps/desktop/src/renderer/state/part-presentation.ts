import type { DesignPart, DesignTechnology } from '@vowe/core';
import { technologyKey } from '@vowe/core/studio-model';

import { TECHNOLOGY_MARKS } from './technology-marks.js';

/**
 * How a part looks, from what it is. Pure, so the canvas and its tests agree.
 *
 * A kind changes a card's silhouette a little and never adds a label: a
 * developer should feel that the database is a database, not read it. A part
 * with no kind, or one this renderer does not know, is a service — the plain
 * card every design drew before kinds existed. A group is not a card at all;
 * the canvas draws it as a boundary.
 */
export type PartLook = 'client' | 'service' | 'store' | 'queue' | 'external';

const LOOKS: ReadonlySet<string> = new Set<PartLook>(['client', 'service', 'store', 'queue', 'external']);

export function partLook(part: Pick<DesignPart, 'kind'>): PartLook {
  return part.kind && LOOKS.has(part.kind) ? (part.kind as PartLook) : 'service';
}

export function isBoundary(part: Pick<DesignPart, 'kind'>): boolean {
  return part.kind === 'group';
}

/**
 * Other ways designs name the technologies there are marks for. A key is a
 * hint, never identity: "postgres", "PostgreSQL 16" and a corrected key all
 * find the same mark, and a key nobody knows simply finds none.
 */
const ALIASES: Readonly<Record<string, string>> = {
  postgres: 'postgresql', pg: 'postgresql', psql: 'postgresql',
  node: 'nodejs', 'node-js': 'nodejs',
  next: 'nextjs', 'next-js': 'nextjs',
  mongo: 'mongodb',
  claude: 'anthropic',
  'apache-kafka': 'kafka',
  gcp: 'googlecloud', 'google-cloud': 'googlecloud',
  'express-js': 'express', expressjs: 'express',
  'react-native': 'react',
  'cloudflare-workers': 'cloudflare', workers: 'cloudflare',
};

/** The mark for a technology, if there is one; null is the ordinary case. */
export function technologyMark(technology: DesignTechnology): string | null {
  const slugs = [
    technology.key ?? '',
    technologyKey({ name: technology.name }),
  ].flatMap((slug) => {
    const plain = slug.toLowerCase().replace(/\./g, '');
    const dashed = slug.toLowerCase().replace(/\./g, '-');
    // "Supabase Auth", "PostgreSQL 16": the first word is usually the product.
    return [slug, plain, dashed, plain.split('-')[0] ?? ''];
  });
  for (const slug of slugs) {
    if (!slug) continue;
    const found = TECHNOLOGY_MARKS[slug] ?? TECHNOLOGY_MARKS[ALIASES[slug] ?? ''];
    if (found) return found;
  }
  return null;
}

/**
 * What a part says about its technology, beneath its name. Nothing when the
 * name already says it — a part called Stripe that is Stripe shows at most
 * the mark beside its name.
 */
export interface TechnologyLine {
  /** The technology's name, or null when the part's name already carries it. */
  name: string | null;
  mark: string | null;
}

export function technologyLine(part: Pick<DesignPart, 'name' | 'technology'>): TechnologyLine | null {
  const technology = part.technology;
  if (!technology?.name.trim()) return null;
  const mark = technologyMark(technology);
  const said = normal(part.name).includes(normal(technology.name));
  if (said && !mark) return null;
  return { name: said ? null : technology.name, mark };
}

function normal(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

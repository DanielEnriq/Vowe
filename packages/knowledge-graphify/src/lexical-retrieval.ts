import type { GraphNode, KnowledgeGraph } from './graph-reader.js';

/**
 * How a question becomes a handful of nodes.
 *
 * This is the *initial* implementation, not the abstraction. The seam is
 * `Retrieval`: the provider asks for nodes and does not care how they were
 * chosen, so this can become embeddings, a learned ranker, or Graphify's own
 * traversal later without touching anything above it.
 *
 * Lexical matching plus one hop is a deliberately small starting point. The hop
 * is the part that earns its place — asking "how does X connect to Y" should
 * surface the thing in between, which no amount of matching on the question
 * itself will find.
 */

export interface ScoredNode {
  node: GraphNode;
  score: number;
  /** Set when this node was reached by expansion rather than matched directly. */
  via?: { label: string; relation: string };
}

export interface Retrieval {
  retrieve(graph: KnowledgeGraph, query: string, limit: number): ScoredNode[];
}

/** A direct hit on a name beats a passing mention in prose. */
const LABEL_WEIGHT = 3;
const KIND_WEIGHT = 1;
const SUMMARY_WEIGHT = 1;
const SOURCE_WEIGHT = 1;
/** Neighbours are context, and must not outrank what was actually asked for. */
const NEIGHBOUR_FACTOR = 0.4;
/** Only expand from nodes that genuinely matched. */
const SEED_COUNT = 3;

/**
 * Edges that express nesting rather than behaviour.
 *
 * These are free to cross. A class and its methods are one thing as far as a
 * question is concerned, and charging a hop to step from `SessionRegistry` into
 * `.absorb()` would stop the search one short of `assignProject()` — which is
 * the actual answer to how the registry reaches the project service. Structure
 * should not cost the same as behaviour.
 */
const NESTING_RELATIONS = new Set(['contains', 'method', 'member', 'defines']);

export class LexicalRetrieval implements Retrieval {
  retrieve(graph: KnowledgeGraph, query: string, limit: number): ScoredNode[] {
    const terms = tokenize(query);
    if (!terms.length || limit <= 0) return [];

    const direct: ScoredNode[] = [];
    for (const node of graph.nodes.values()) {
      const score = scoreNode(node, terms);
      if (score > 0) direct.push({ node, score });
    }
    // Ties go to the shorter label: `SessionRegistry` before
    // `SessionRegistryOptions` when both match equally.
    direct.sort((a, b) => b.score - a.score || a.node.label.length - b.node.label.length);

    const chosen = new Map<string, ScoredNode>();
    for (const hit of direct.slice(0, limit)) chosen.set(hit.node.id, hit);

    for (const seed of direct.slice(0, SEED_COUNT)) {
      if (chosen.size >= limit) break;
      this.expand(graph, seed, chosen, limit);
    }

    return [...chosen.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /** One behavioural hop out from a seed, crossing nesting edges for free. */
  private expand(
    graph: KnowledgeGraph,
    seed: ScoredNode,
    chosen: Map<string, ScoredNode>,
    limit: number,
  ): void {
    const seen = new Set<string>([seed.node.id]);
    let frontier: { id: string; hops: number; trail: string }[] = [
      { id: seed.node.id, hops: 0, trail: seed.node.label },
    ];

    while (frontier.length && chosen.size < limit) {
      const next: typeof frontier = [];
      for (const current of frontier) {
        for (const edge of graph.neighbours.get(current.id) ?? []) {
          if (seen.has(edge.nodeId)) continue;
          const nesting = NESTING_RELATIONS.has(edge.relation);
          const hops = nesting ? current.hops : current.hops + 1;
          if (hops > 1) continue;

          seen.add(edge.nodeId);
          const node = graph.nodes.get(edge.nodeId);
          if (!node) continue;

          const trail = nesting
            ? `${current.trail} ${node.label}`
            : `${current.trail} ${edge.relation} ${node.label}`;

          if (!chosen.has(node.id)) {
            chosen.set(node.id, {
              node,
              score: seed.score * NEIGHBOUR_FACTOR,
              via: { label: seed.node.label, relation: trail },
            });
            if (chosen.size >= limit) return;
          }
          next.push({ id: node.id, hops, trail });
        }
      }
      frontier = next;
    }
  }
}

function scoreNode(node: GraphNode, terms: string[]): number {
  const label = node.label.toLowerCase();
  const kind = (node.kind ?? '').toLowerCase();
  const summary = node.summary.toLowerCase();
  const source = (node.sourceFile ?? '').toLowerCase();

  let score = 0;
  for (const term of terms) {
    if (label.includes(term)) score += LABEL_WEIGHT;
    if (kind.includes(term)) score += KIND_WEIGHT;
    if (summary.includes(term)) score += SUMMARY_WEIGHT;
    if (source.includes(term)) score += SOURCE_WEIGHT;
  }
  return score;
}

/**
 * The same tokenizer the `ContextNavigator` uses, for the same reason: a query
 * written for one source should behave the same way against another.
 */
export function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_./:-]+/i)
    .map((term) => term.trim())
    .filter((term) => term.length > 1);
}

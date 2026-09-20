import { readFile, stat } from 'node:fs/promises';

/**
 * The only place in Vowe that knows what Graphify's `graph.json` looks like.
 *
 * It is NetworkX node-link, whose exact field names are not a contract —
 * Graphify's own documentation says so plainly: "Fields vary by extractor; only
 * consume fields your workflow needs", and "Do not assume every node
 * corresponds to a function or that every edge has a line number."
 *
 * So this file reads defensively and normalizes into shapes Vowe defines. Every
 * unknown field is dropped rather than guessed at, and a node with no source
 * file is kept — it still orients, it just cannot be opened.
 */

export interface GraphNode {
  id: string;
  label: string;
  /** Graphify's own vocabulary. Passed through for display, never branched on. */
  kind?: string;
  summary: string;
  /** As recorded. Usually relative to the repository root, sometimes absolute. */
  sourceFile?: string;
  /** From `source_location`, when the extractor recorded one. */
  line?: number;
}

export interface GraphNeighbour {
  nodeId: string;
  relation: string;
  direction: 'out' | 'in';
}

export interface KnowledgeGraph {
  nodes: Map<string, GraphNode>;
  neighbours: Map<string, GraphNeighbour[]>;
}

/** Both spellings appear in the wild; node-link says `links`, exports say `edges`. */
const EDGE_KEYS = ['links', 'edges'] as const;

const LABEL_FIELDS = ['label', 'name', 'title', 'id'];
const KIND_FIELDS = ['type', 'kind', 'node_type', 'entity_type', 'category'];
const SUMMARY_FIELDS = ['summary', 'description', 'docstring', 'text', 'detail'];
const SOURCE_FIELDS = ['source_file', 'file', 'path', 'file_path'];
const LOCATION_FIELDS = ['source_location', 'location', 'lines'];
const RELATION_FIELDS = ['relation', 'relationship', 'type', 'label', 'context', 'edge_type'];

export class GraphifyGraphReader {
  /** Keyed by path, invalidated on mtime or size. Searches are repetitive. */
  private readonly cache = new Map<
    string,
    { mtimeMs: number; size: number; graph: KnowledgeGraph }
  >();

  async read(graphPath: string): Promise<KnowledgeGraph | null> {
    let mtimeMs: number;
    let size: number;
    try {
      const info = await stat(graphPath);
      mtimeMs = info.mtimeMs;
      size = info.size;
    } catch {
      // No graph yet is the normal state of an unindexed project.
      return null;
    }

    const cached = this.cache.get(graphPath);
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
      return cached.graph;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(graphPath, 'utf8'));
    } catch {
      // A half-written graph during extraction reads as corrupt. Treat it the
      // same as no graph: the next search picks up the finished one.
      return null;
    }

    const graph = normalize(raw);
    if (!graph) return null;
    this.cache.set(graphPath, { mtimeMs, size, graph });
    return graph;
  }

  forget(graphPath: string): void {
    this.cache.delete(graphPath);
  }
}

function normalize(raw: unknown): KnowledgeGraph | null {
  if (!isRecord(raw)) return null;
  const rawNodes = raw['nodes'];
  if (!Array.isArray(rawNodes)) return null;

  const nodes = new Map<string, GraphNode>();
  for (const entry of rawNodes) {
    if (!isRecord(entry)) continue;
    const id = stringOf(entry, ['id']) ?? stringOf(entry, LABEL_FIELDS);
    if (!id) continue;
    const node: GraphNode = {
      id,
      label: stringOf(entry, LABEL_FIELDS) ?? id,
      summary: stringOf(entry, SUMMARY_FIELDS) ?? '',
    };
    const kind = stringOf(entry, KIND_FIELDS) ?? inferKind(entry);
    if (kind) node.kind = kind;
    const sourceFile = stringOf(entry, SOURCE_FIELDS);
    if (sourceFile) node.sourceFile = sourceFile;
    const line = lineOf(entry);
    if (line !== null) node.line = line;
    nodes.set(id, node);
  }
  if (!nodes.size) return null;

  const neighbours = new Map<string, GraphNeighbour[]>();
  for (const key of EDGE_KEYS) {
    const rawEdges = raw[key];
    if (!Array.isArray(rawEdges)) continue;
    for (const entry of rawEdges) {
      if (!isRecord(entry)) continue;
      const source = endpointOf(entry['source']);
      const target = endpointOf(entry['target']);
      if (!source || !target) continue;
      // An edge to something that was not extracted as a node is not useful
      // for orientation, and would render as a dangling name.
      if (!nodes.has(source) || !nodes.has(target)) continue;
      const relation = stringOf(entry, RELATION_FIELDS) ?? 'related to';
      push(neighbours, source, { nodeId: target, relation, direction: 'out' });
      push(neighbours, target, { nodeId: source, relation, direction: 'in' });
    }
  }

  return { nodes, neighbours };
}

/**
 * What kind of thing this is, when nothing said so outright.
 *
 * The AST extractor records no `type`; it marks callables with underscore-
 * prefixed flags instead. Reading them is exactly the kind of vendor knowledge
 * this file exists to contain — and `kind` is only ever shown to a reader, so
 * being wrong about it costs a slightly odd label and nothing more.
 */
function inferKind(entry: Record<string, unknown>): string | null {
  if (entry['_callable_class'] === true) return 'class';
  if (entry['_callable'] === true) return 'function';
  if (typeof entry['file_type'] === 'string') return String(entry['file_type']);
  return null;
}

/**
 * `"L42"`, `"L42-L58"`, `42` — or nothing at all.
 *
 * Graphify's documentation is explicit that a line number is not guaranteed,
 * so this returns `null` rather than a guess whenever it cannot read one.
 */
function lineOf(entry: Record<string, unknown>): number | null {
  for (const field of LOCATION_FIELDS) {
    const value = entry[field];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'string') continue;
    const match = /(\d+)/.exec(value);
    if (match) return Number(match[1]);
  }
  return null;
}

/** Node-link endpoints are usually ids, but an export may inline the node. */
function endpointOf(value: unknown): string | null {
  if (typeof value === 'string' && value) return value;
  if (typeof value === 'number') return String(value);
  if (isRecord(value)) return stringOf(value, ['id']);
  return null;
}

function push(
  into: Map<string, GraphNeighbour[]>,
  key: string,
  value: GraphNeighbour,
): void {
  const existing = into.get(key);
  if (existing) existing.push(value);
  else into.set(key, [value]);
}

function stringOf(record: Record<string, unknown>, fields: string[]): string | null {
  for (const field of fields) {
    const value = record[field];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

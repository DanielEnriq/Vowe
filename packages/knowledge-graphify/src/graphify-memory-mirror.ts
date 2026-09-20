import path from 'node:path';

import type { Project, ProjectMemoryMirror, ProjectMemoryRecord } from '@vowe/core';

import { graphifyPaths, type GraphifyCli } from './graphify-cli.js';

export interface GraphifyMemoryMirrorOptions {
  cli: GraphifyCli;
  available: boolean;
  resolveProject: (projectId: string) => Project | null;
  dataDirFor: (projectId: string) => string;
  onError?: (scope: string, error: unknown) => void;
}

/**
 * Vowe's memory, mirrored into Graphify's own work-memory files.
 *
 * **This is enrichment, not storage.** The canonical record is Vowe's
 * `memory.ndjson`; nothing here is ever read back, and Vowe retrieves lessons
 * without it. What it buys is that `graphify reflect` can fold Vowe's findings
 * into `LESSONS.md`, so a developer running `graphify` themselves — or another
 * agent using the Graphify skill — sees what Vowe worked out too.
 *
 * Every method therefore swallows its failures. A mirror that cannot write is a
 * missing convenience, not a lost memory.
 */
export class GraphifyMemoryMirror implements ProjectMemoryMirror {
  readonly available: boolean;

  private readonly cli: GraphifyCli;
  private readonly resolveProject: (projectId: string) => Project | null;
  private readonly dataDirFor: (projectId: string) => string;
  private readonly onError: (scope: string, error: unknown) => void;

  constructor(options: GraphifyMemoryMirrorOptions) {
    this.cli = options.cli;
    this.available = options.available;
    this.resolveProject = options.resolveProject;
    this.dataDirFor = options.dataDirFor;
    this.onError = options.onError ?? (() => undefined);
  }

  async mirror(record: ProjectMemoryRecord): Promise<void> {
    if (!this.available || !this.resolveProject(record.projectId)) return;
    const result = await this.cli.saveResult(this.pathsFor(record.projectId), {
      question: record.question,
      answer: record.answer,
      // Graphify indexes work memory by node label, which is what its own
      // `--nodes` expects; ids are what Vowe carries, and they are what it has.
      nodes: record.nodeIds,
      outcome: record.outcome,
      ...(record.correction ? { correction: record.correction } : {}),
    });
    if (!result.ok) this.onError('mirror:save-result', result.failure);
  }

  async reflect(projectId: string): Promise<void> {
    if (!this.available || !this.resolveProject(projectId)) return;
    const result = await this.cli.reflect(this.pathsFor(projectId));
    if (!result.ok) this.onError('mirror:reflect', result.failure);
  }

  private pathsFor(projectId: string) {
    return graphifyPaths(path.join(this.dataDirFor(projectId), 'knowledge'));
  }
}

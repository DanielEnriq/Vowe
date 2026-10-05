import type { AgentSession, FleetLayout, FleetRole, FleetStatus } from '@vowe/core';
import { sessionTitle } from '@vowe/core/projections';

import type { StatusTone } from './project-fleet.js';

/**
 * What the fleet's Panes, Compare and Questions views share: who is in the
 * fleet, what each is called, and how a status is drawn.
 *
 * Pure, and read only from the canvas layout and the project's sessions.
 */

export interface StatusLook {
  tone: StatusTone;
  word: 'running' | 'needs you' | 'done' | 'failed' | 'idle';
}

/** A status as a dot and a word. Unknown is idle. */
export function statusLook(status: FleetStatus | undefined): StatusLook {
  switch (status) {
    case 'running':
      return { tone: 'ask', word: 'running' };
    case 'needs-you':
      return { tone: 'attention', word: 'needs you' };
    case 'done':
      return { tone: 'good', word: 'done' };
    case 'failed':
      return { tone: 'bad', word: 'failed' };
    default:
      return { tone: 'idle', word: 'idle' };
  }
}

export interface FleetMember {
  /** Null for a session that is in the project but not on the canvas. */
  nodeId: string | null;
  /** Null for a placeholder node that has not been started. */
  sessionId: string | null;
  role: FleetRole;
  label: string;
  session: AgentSession | null;
}

/**
 * Everyone in the fleet: the canvas's nodes in their own order, then the
 * project's other sessions — not archived — newest first, as agents.
 */
export function fleetMembers(layout: FleetLayout, sessions: readonly AgentSession[]): FleetMember[] {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const onCanvas = new Set<string>();
  const members: FleetMember[] = layout.nodes.map((node) => {
    const session = node.sessionId ? (byId.get(node.sessionId) ?? null) : null;
    if (node.sessionId) onCanvas.add(node.sessionId);
    return {
      nodeId: node.id,
      sessionId: node.sessionId,
      role: node.role,
      label: memberLabel(node.label, session, node.role),
      session,
    };
  });
  const rest = sessions
    .filter((session) => !onCanvas.has(session.id) && !session.archivedAt)
    .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt));
  for (const session of rest) {
    members.push({
      nodeId: null,
      sessionId: session.id,
      role: 'agent',
      label: memberLabel(undefined, session, 'agent'),
      session,
    });
  }
  return members;
}

/** The name the developer gave the node, else the session's, else its role. */
export function memberLabel(given: string | undefined, session: AgentSession | null, role: FleetRole): string {
  const named = given?.trim();
  if (named) return named;
  if (session) return sessionTitle(session);
  return role === 'captain' ? 'Captain' : 'Not started';
}

/** Labels by session id, for naming the other side of an exchange. */
export function labelsBySession(members: readonly FleetMember[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const member of members) if (member.sessionId) labels.set(member.sessionId, member.label);
  return labels;
}

/** `4m 12s`, `12s`, `1h 04m`. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** The coarse unit only: `40s`, `2m`, `3h`, `2d`. For waits and ages. */
export function formatSpan(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** Milliseconds between two timestamps, or null when either does not parse. */
export function spanBetween(from: string, to: string | number): number | null {
  const start = Date.parse(from);
  const end = typeof to === 'number' ? to : Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

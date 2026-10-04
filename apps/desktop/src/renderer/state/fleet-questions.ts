import type { CaptainExchange, FleetLayout } from '@vowe/core';
import { captainOf } from '@vowe/core/fleet-model';

import { formatSpan, spanBetween, type FleetMember } from './fleet-views.js';

/**
 * Questions: what workers asked, split by who answers it — the ones passed
 * to you, and the ones a captain answered.
 */

/** Needs you: routed to you and not yet answered. Longest waiting first. */
export function passedToYou(exchanges: readonly CaptainExchange[]): CaptainExchange[] {
  return exchanges
    .filter((exchange) => exchange.route === 'you' && exchange.status !== 'answered')
    .sort((a, b) => Date.parse(a.askedAt) - Date.parse(b.askedAt));
}

/** A captain's answers, newest first. */
export function answeredByCaptain(exchanges: readonly CaptainExchange[]): CaptainExchange[] {
  return exchanges
    .filter((exchange) => exchange.route === 'captain' && exchange.status === 'answered')
    .sort((a, b) => Date.parse(b.answeredAt ?? b.askedAt) - Date.parse(a.answeredAt ?? a.askedAt));
}

/** What the captain said when it passed a question on, if it was passed. */
export function captainSaid(exchange: CaptainExchange): string | null {
  if (exchange.status !== 'passed') return null;
  return exchange.captainAnswer?.trim() || exchange.passedToYouReason?.trim() || null;
}

/** `waiting 2m`. */
export function waitingFor(exchange: CaptainExchange, now: number): string {
  const span = spanBetween(exchange.askedAt, now);
  return span === null ? 'waiting' : `waiting ${formatSpan(span)}`;
}

/** `40s ago · 3s`: how long ago it was answered, and how long the captain took. */
export function answeredLine(exchange: CaptainExchange, now: number): string {
  const at = exchange.answeredAt ?? exchange.askedAt;
  const ago = spanBetween(at, now);
  const took = exchange.answeredAt ? spanBetween(exchange.askedAt, exchange.answeredAt) : null;
  const agoText = ago === null ? '' : `${formatSpan(ago)} ago`;
  return took === null ? agoText : `${agoText} · ${formatSpan(took)}`;
}

/** The answered list's header: `12 · last 40s ago`. */
export function answeredHeader(answered: readonly CaptainExchange[], now: number): string {
  const newest = answered[0];
  if (!newest) return '0';
  const ago = spanBetween(newest.answeredAt ?? newest.askedAt, now);
  return ago === null ? String(answered.length) : `${answered.length} · last ${formatSpan(ago)} ago`;
}

export interface AskRosterRow {
  nodeId: string;
  sessionId: string | null;
  label: string;
  wired: boolean;
}

/** The canvas's agents and whether a wire lets each ask a captain. */
export function askRoster(layout: FleetLayout, members: readonly FleetMember[]): AskRosterRow[] {
  return members
    .filter((member): member is FleetMember & { nodeId: string } => member.role === 'agent' && member.nodeId !== null)
    .map((member) => ({
      nodeId: member.nodeId,
      sessionId: member.sessionId,
      label: member.label,
      wired: captainOf(layout, member.nodeId) !== null,
    }));
}

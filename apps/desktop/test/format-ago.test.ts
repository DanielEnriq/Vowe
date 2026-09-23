import { describe, expect, it } from 'vitest';

import { formatAgo, formatAgoShort } from '../src/renderer/components/ui.js';

const NOW = Date.parse('2026-09-23T12:00:00.000Z');
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('How long ago, in words', () => {
  it('counts up through the units', () => {
    expect(formatAgo(ago(3 * SECOND), NOW)).toBe('3 seconds ago');
    expect(formatAgo(ago(4 * MINUTE), NOW)).toBe('4 minutes ago');
    expect(formatAgo(ago(5 * HOUR), NOW)).toBe('5 hours ago');
    expect(formatAgo(ago(6 * DAY), NOW)).toBe('6 days ago');
  });

  /** Keeps counting in days rather than handing off to a locale date. */
  it('still answers in days for something months old', () => {
    expect(formatAgo(ago(90 * DAY), NOW)).toBe('90 days ago');
  });

  it('says one of a thing, not one of things', () => {
    expect(formatAgo(ago(SECOND), NOW)).toBe('1 second ago');
    expect(formatAgo(ago(MINUTE), NOW)).toBe('1 minute ago');
    expect(formatAgo(ago(HOUR), NOW)).toBe('1 hour ago');
    expect(formatAgo(ago(DAY), NOW)).toBe('1 day ago');
  });

  it('crosses each boundary into the next unit', () => {
    expect(formatAgo(ago(59 * SECOND), NOW)).toBe('59 seconds ago');
    expect(formatAgo(ago(59 * MINUTE), NOW)).toBe('59 minutes ago');
    expect(formatAgo(ago(23 * HOUR), NOW)).toBe('23 hours ago');
  });

  /** A clock that is slightly ahead is not a reason to print a negative age. */
  it('never counts backwards', () => {
    expect(formatAgo(ago(-5 * SECOND), NOW)).toBe('0 seconds ago');
  });

  it('hands back an unreadable date rather than inventing one', () => {
    expect(formatAgo('not a date', NOW)).toBe('not a date');
  });
});

describe('How long ago, abbreviated', () => {
  it('keeps the number and just enough unit', () => {
    expect(formatAgoShort(ago(3 * SECOND), NOW)).toBe('3 s ago');
    expect(formatAgoShort(ago(4 * MINUTE), NOW)).toBe('4 min ago');
    expect(formatAgoShort(ago(5 * HOUR), NOW)).toBe('5 hr ago');
    expect(formatAgoShort(ago(6 * DAY), NOW)).toBe('6 d ago');
  });

  /** A cell, not a sentence: no singular special-casing to pay for. */
  it('does not inflect, because there is no word to inflect', () => {
    expect(formatAgoShort(ago(HOUR), NOW)).toBe('1 hr ago');
    expect(formatAgoShort(ago(DAY), NOW)).toBe('1 d ago');
  });

  it('crosses the same boundaries as the long form', () => {
    expect(formatAgoShort(ago(59 * MINUTE), NOW)).toBe('59 min ago');
    expect(formatAgoShort(ago(23 * HOUR), NOW)).toBe('23 hr ago');
    expect(formatAgoShort(ago(90 * DAY), NOW)).toBe('90 d ago');
  });

  it('hands back an unreadable date rather than inventing one', () => {
    expect(formatAgoShort('not a date', NOW)).toBe('not a date');
  });
});

import { describe, expect, it } from 'vitest';

import { investigationChronology } from '../src/product/investigation-chronology.js';
import type { InvestigationCheck } from '../src/types/conversation.js';
import type { VoweTraceItem } from '../src/types/execution.js';

const check = (label: string): InvestigationCheck => ({
  kind: 'open',
  label,
  refs: [],
});

let ord = 0;
const item = (
  kind: VoweTraceItem['kind'],
  at: string,
  text?: string,
): VoweTraceItem => ({
  id: `${kind}-${(ord += 1)}`,
  runId: 'run',
  ord,
  kind,
  at,
  ...(text === undefined ? {} : { text }),
});

/** What a row says, so a test can talk about the column as it is read. */
const shape = (steps: ReturnType<typeof investigationChronology>): string[] =>
  steps.map((step) =>
    step.kind === 'check' ? step.check.label : `thought:${step.text}`,
  );

describe('Investigation chronology — a settled answer, in the order it happened', () => {
  it('interleaves thinking and lookups the way the run executed them', () => {
    ord = 0;
    const steps = investigationChronology({
      receipt: {
        durationMs: 4000,
        checks: [check('Searched session context'), check('Read the exchange')],
      },
      trace: [
        item('model_input', '2026-09-22T10:00:00.000Z'),
        item('reasoning_summary', '2026-09-22T10:00:01.000Z', 'Where to look'),
        item('tool_call', '2026-09-22T10:00:01.200Z'),
        item('tool_result', '2026-09-22T10:00:01.400Z'),
        item('reasoning_summary', '2026-09-22T10:00:03.900Z', 'Now the exchange'),
        item('tool_call', '2026-09-22T10:00:04.000Z'),
        item('tool_result', '2026-09-22T10:00:04.100Z'),
        item('model_output', '2026-09-22T10:00:06.000Z'),
      ],
    });

    expect(shape(steps)).toEqual([
      'thought:Where to look',
      'Searched session context',
      'thought:Now the exchange',
      'Read the exchange',
    ]);
  });

  /**
   * The duration is a measurement or it is nothing.
   *
   * Both ends come from real trace timestamps — the item before the reasoning
   * and the reasoning itself — so a span that genuinely took two and a half
   * seconds says so, and a first item with nothing before it says zero rather
   * than inventing a start.
   */
  it('measures a span from the two nearest real timestamps', () => {
    ord = 0;
    const steps = investigationChronology({
      receipt: { durationMs: 2_600, checks: [check('Searched the repository')] },
      trace: [
        item('reasoning', '2026-09-22T10:00:00.000Z', 'First'),
        item('tool_call', '2026-09-22T10:00:00.100Z'),
        item('reasoning', '2026-09-22T10:00:02.600Z', 'Second'),
      ],
    });

    expect(steps.map((step) => (step.kind === 'thought' ? step.durationMs : null)))
      .toEqual([0, null, 2500]);
  });

  /**
   * Attachments are opened before the run exists, so they have no tool call
   * behind them. They are exactly the checks the trace cannot account for, and
   * they happened first.
   */
  it('puts lookups the trace cannot account for at the front', () => {
    ord = 0;
    const steps = investigationChronology({
      receipt: {
        durationMs: 1000,
        checks: [check('Read Composer.tsx'), check('Searched the repository')],
      },
      trace: [
        item('reasoning', '2026-09-22T10:00:00.000Z', 'Considering'),
        item('tool_call', '2026-09-22T10:00:00.500Z'),
      ],
    });

    expect(shape(steps)).toEqual([
      'Read Composer.tsx',
      'thought:Considering',
      'Searched the repository',
    ]);
  });

  /** An answer from before runs were recorded still reads as what it did. */
  it('degrades to the receipt when there is no trace', () => {
    const steps = investigationChronology({
      receipt: { durationMs: 900, checks: [check('Opened the current diff')] },
    });
    expect(shape(steps)).toEqual(['Opened the current diff']);
  });

  it('has nothing to say about an answer that looked at nothing', () => {
    expect(investigationChronology({})).toEqual([]);
  });

  /**
   * A redacted reasoning block carries no readable text. The row stays,
   * because that reasoning happened, and it has nothing to open.
   */
  it('keeps a redacted span as a span with no text', () => {
    ord = 0;
    const steps = investigationChronology({
      trace: [item('reasoning_summary', '2026-09-22T10:00:00.000Z')],
    });
    expect(steps).toEqual([
      { kind: 'thought', id: steps[0]?.id, text: '', durationMs: 0 },
    ]);
  });

  /**
   * The recorder collapses an immediately repeated identical lookup; the trace
   * does not. More calls than checks must never produce a row with no check
   * behind it.
   */
  it('never invents a lookup when a retry collapsed in the receipt', () => {
    ord = 0;
    const steps = investigationChronology({
      receipt: { durationMs: 500, checks: [check('Searched the repository')] },
      trace: [
        item('tool_call', '2026-09-22T10:00:00.000Z'),
        item('tool_call', '2026-09-22T10:00:00.100Z'),
      ],
    });
    expect(shape(steps)).toEqual(['Searched the repository']);
  });
});

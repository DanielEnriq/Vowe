import type { ReactElement } from 'react';

import type { InvestigationCheck } from '@vowe/core';

/**
 * What kind of lookup this was, as a glyph.
 *
 * The kind used to be rendered as a word in front of the label, which produced
 * "Opened Read the exchange" — the recorder's labels are already complete
 * phrases. An icon carries the same distinction without competing with prose
 * that already says it.
 */
export function CheckKindIcon({ kind }: { kind: InvestigationCheck['kind'] }): ReactElement {
  const shared = {
    width: 11,
    height: 11,
    viewBox: '0 0 12 12',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.3,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    className: 'check-icon',
  };

  switch (kind) {
    case 'search':
      return (
        <svg {...shared}>
          <circle cx="5.2" cy="5.2" r="3.1" />
          <path d="M7.5 7.5L10 10" />
        </svg>
      );
    case 'open':
      return (
        <svg {...shared}>
          <path d="M3 1.5h3.5L9 4v6.5H3z" />
          <path d="M6.5 1.5V4H9" />
        </svg>
      );
    case 'diff':
      return (
        <svg {...shared}>
          <path d="M2 4h8M2 8h8M6 2v4" />
        </svg>
      );
  }
}

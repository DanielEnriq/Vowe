import type { ReactElement } from 'react';

/**
 * The design's own line work, at its own weights.
 *
 * Every icon is decorative: each one sits inside a control that carries its
 * own accessible name, so none of them announce themselves twice.
 */
const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  'aria-hidden': true,
} as const;

export function PanelIcon(): ReactElement {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" strokeWidth="1.4" {...stroke}>
      <rect x="2" y="3" width="12" height="10" rx="2" />
      <path d="M6 3v10" />
    </svg>
  );
}

export function DeskIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" strokeWidth="1.4" {...stroke}>
      <rect x="2" y="3" width="12" height="10" rx="2" />
      <path d="M10 3v10" />
    </svg>
  );
}

export function ComposeIcon(): ReactElement {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...stroke}
    >
      <path d="M12.4 2.6a1.4 1.4 0 0 1 2 2L7 12l-3 1 1-3z" />
    </svg>
  );
}

export function RepoIcon(): ReactElement {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      strokeWidth="1.15"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...stroke}
    >
      <path d="M1.6 9.9V2.9h2.9l1 1.3h4v1.2" />
      <path d="M2.7 9.9l1.4-3.8h7L9.7 9.9z" />
    </svg>
  );
}

export function FolderIcon(): ReactElement {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      strokeWidth="1.15"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...stroke}
    >
      <path d="M1.6 3.1a.6.6 0 0 1 .6-.6h2.2l1 1.3h4.4a.6.6 0 0 1 .6.6v4.5a.6.6 0 0 1-.6.6H2.2a.6.6 0 0 1-.6-.6z" />
    </svg>
  );
}

export function CloseIcon({ size = 13 }: { size?: number }): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      strokeWidth="1.6"
      strokeLinecap="round"
      {...stroke}
    >
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

export function CaretIcon(): ReactElement {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 12 12"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...stroke}
    >
      <path d="M4.5 2.5L8 6l-3.5 3.5" />
    </svg>
  );
}

export function ChevronDownIcon(): ReactElement {
  return (
    <svg
      width="9"
      height="9"
      viewBox="0 0 12 12"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...stroke}
    >
      <path d="M2.5 4.5L6 8l3.5-3.5" />
    </svg>
  );
}

export function SendIcon(): ReactElement {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...stroke}
    >
      <path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" />
    </svg>
  );
}

export function PlusIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" strokeWidth="1.5" strokeLinecap="round" {...stroke}>
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

export function FileIcon(): ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" strokeWidth="1.3" strokeLinejoin="round" {...stroke}>
      <path d="M3 1.5h3.5L9 4v6.5H3z" />
      <path d="M6.5 1.5V4H9" />
    </svg>
  );
}

export function DiffIcon(): ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" strokeWidth="1.3" strokeLinecap="round" {...stroke}>
      <path d="M2 4h8M2 8h8M6 2v4" />
    </svg>
  );
}

export function OpenIcon(): ReactElement {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 12 12"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...stroke}
    >
      <path d="M3.5 8.5l5-5M4.5 3.5h4v4" />
    </svg>
  );
}

export function PinIcon({ filled }: { filled: boolean }): ReactElement {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 12 12"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4.6 1.4h2.8l-.4 2.6 1.6 1.5H4.4L2.6 5.5 4.2 4z" />
      <path d="M6 5.5v5" strokeLinecap="round" />
    </svg>
  );
}

export function CheckIcon(): ReactElement {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...stroke}
    >
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  );
}

export function SettingsIcon(): ReactElement {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...stroke}
    >
      <circle cx="8" cy="8" r="2.1" />
      <path d="M8 1.9v1.4M8 12.7v1.4M1.9 8h1.4M12.7 8h1.4M3.7 3.7l1 1M11.3 11.3l1 1M12.3 3.7l-1 1M4.7 11.3l-1 1" />
    </svg>
  );
}

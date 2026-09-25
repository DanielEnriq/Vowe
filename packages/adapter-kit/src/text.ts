/**
 * Small shared text helpers.
 *
 * These exist so every adapter shortens a summary the same way. A session row
 * should not look different because of which agent produced it.
 */

export function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function firstLine(text: string, limit = 180): string {
  const line = text.split('\n').find((candidate) => candidate.trim()) ?? '';
  return truncate(line.trim().replace(/\s+/g, ' '), limit);
}

/** Collapse a multi-line value into one readable line. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

export function baseName(filePath: string): string {
  if (!filePath) return 'a file';
  const parts = filePath.split('/');
  return parts[parts.length - 1] || filePath;
}

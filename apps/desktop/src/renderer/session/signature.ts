import type { PresenceProfile } from '@vowe/core';
import { resolvePresenceVisuals } from '@vowe/core/presence';
import type { CSSProperties } from 'react';

/**
 * Vowe's mark beside a speaker run.
 *
 * The same entity, drawn the way this Vowe is configured: the ink comes from
 * the profile's own resolved lit colour, so changing the material changes the
 * signature too. It is a point field rather than an avatar because an avatar
 * on every message is what turns an editorial column into a chat.
 */
export function signatureStyle(profile: PresenceProfile): CSSProperties {
  const { colorA } = resolvePresenceVisuals('idle', profile, 'signature');
  const ink = withAlpha(colorA, 0.8);
  return {
    backgroundImage: `radial-gradient(circle at 1px 1px, ${ink} 0.7px, transparent 0.8px)`,
    backgroundSize: '3px 3px',
  };
}

function withAlpha(hex: string, alpha: number): string {
  const value = hex.replace('#', '');
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

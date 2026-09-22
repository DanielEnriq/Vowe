/**
 * Which voice Vo speaks in.
 *
 * Stored as a bare provider id rather than anything richer, and deliberately
 * not validated against a list here: core does not know which voices exist,
 * and baking a vendor's names into a product type is how the seam that keeps
 * providers replaceable gets quietly broken. The transport declares its own
 * voices and rejects or falls back on an id it no longer offers.
 *
 * `null` means "whatever the transport uses by default", which is different
 * from a developer having chosen the voice that happens to be the default: the
 * second survives the provider changing its mind.
 */
export interface VoicePreference {
  voice: string | null;
}

export const DEFAULT_VOICE_PREFERENCE: VoicePreference = { voice: null };

/** Provider voice ids are short slugs; anything longer is not one. */
const MAX_VOICE_ID = 40;

export function normalizeVoicePreference(value: unknown): VoicePreference {
  const source = (value ?? {}) as Record<string, unknown>;
  const raw = typeof source['voice'] === 'string' ? source['voice'].trim() : '';
  if (!raw || raw.length > MAX_VOICE_ID || !/^[a-z0-9._-]+$/i.test(raw)) {
    return { voice: null };
  }
  return { voice: raw };
}

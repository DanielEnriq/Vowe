import { describe, expect, it } from 'vitest';

import { ProviderGlyph, providerName } from '../src/renderer/components/ui.js';

/**
 * The marks are drawn, so what a test can honestly check is not how they look
 * — that was settled by rendering them — but the things that would quietly
 * break them: two agents sharing a shape, an unknown agent getting nothing,
 * or a mark losing the name a screen reader needs.
 */
/**
 * Just the drawn body, without the name that travels with it.
 *
 * The whole element would compare unequal for any two providers, because each
 * carries its own label — which would make the comparison below pass while
 * proving nothing about the shapes.
 */
function shapeOf(provider: string): string {
  const children = ProviderGlyph({ provider }).props.children as unknown[];
  return JSON.stringify(children[1]);
}

const KNOWN = ['claude-code', 'pi', 'codex'];

describe('Provider marks', () => {
  it('gives every agent a shape of its own', () => {
    const shapes = KNOWN.map(shapeOf);
    expect(new Set(shapes).size).toBe(KNOWN.length);
  });

  /*
   * The fallback is the point of the whole set being open: Vowe adds providers
   * faster than anyone draws marks for them, and a row with a blank where the
   * mark goes looks broken rather than unfamiliar.
   */
  it('still marks an agent nobody has drawn yet', () => {
    const unknown = shapeOf('some-future-agent');
    expect(unknown).toBeTruthy();
    for (const known of KNOWN) expect(unknown).not.toBe(shapeOf(known));
    // Two unknown providers share the one fallback rather than inventing shapes.
    expect(shapeOf('another-agent')).toBe(unknown);
  });

  it('carries the agent’s name, so the mark is never the only way to tell', () => {
    for (const provider of [...KNOWN, 'some-future-agent']) {
      const rendered = JSON.stringify(ProviderGlyph({ provider }));
      expect(rendered).toContain(providerName(provider));
    }
  });

  /** One weight, one size: the mark says which agent, never how much it matters. */
  it('draws every mark in currentColor at one size', () => {
    for (const provider of [...KNOWN, 'some-future-agent']) {
      const el = ProviderGlyph({ provider });
      expect(el.props.stroke).toBe('currentColor');
      expect(el.props.fill).toBe('none');
      expect(el.props.viewBox).toBe('0 0 16 16');
      expect(el.props.width).toBe(14);
    }
    expect(ProviderGlyph({ provider: 'pi', size: 13 }).props.width).toBe(13);
  });
});

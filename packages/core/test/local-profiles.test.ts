import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_PRESENCE_PROFILE,
  normalizePresenceProfile,
} from '../src/product/presence-profile.js';
import { PresenceProfileStore } from '../src/product/presence-profile-store.js';
import {
  DEFAULT_USER_PROFILE,
  UserProfileStore,
  normalizeUserProfile,
} from '../src/product/user-profile.js';

let root: string | null = null;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = null;
});

async function temporaryRoot(): Promise<string> {
  root = await mkdtemp(path.join(os.tmpdir(), 'vowe-profile-'));
  return root;
}

describe('UserProfile', () => {
  it('defaults to You on a fresh install', async () => {
    const store = new UserProfileStore({ root: await temporaryRoot() });

    expect(await store.get()).toEqual(DEFAULT_USER_PROFILE);
  });

  it('survives a restart', async () => {
    const directory = await temporaryRoot();
    await new UserProfileStore({ root: directory }).set({
      displayName: 'Daniel',
      avatarUri: 'file:///avatars/me.png',
    });

    // A second store over the same directory — i.e. "restart Vowe".
    expect(await new UserProfileStore({ root: directory }).get()).toEqual({
      displayName: 'Daniel',
      avatarUri: 'file:///avatars/me.png',
    });
  });

  it('writes where the persistence layout says it does', async () => {
    const directory = await temporaryRoot();
    await new UserProfileStore({ root: directory }).set({ displayName: 'Daniel' });

    const written = JSON.parse(
      await readFile(path.join(directory, 'profile.json'), 'utf8'),
    );
    expect(written).toEqual({ displayName: 'Daniel' });
  });

  it('hands back what was actually stored', async () => {
    const store = new UserProfileStore({ root: await temporaryRoot() });

    expect(await store.set({ displayName: '   ' })).toEqual({ displayName: 'You' });
  });

  it('falls back to defaults rather than failing on a corrupt file', async () => {
    const directory = await temporaryRoot();
    await writeFile(path.join(directory, 'profile.json'), '{ not json', 'utf8');

    expect(await new UserProfileStore({ root: directory }).get()).toEqual(
      DEFAULT_USER_PROFILE,
    );
  });

  describe('validation', () => {
    it('never yields an empty display name', () => {
      expect(normalizeUserProfile({ displayName: '' }).displayName).toBe('You');
      expect(normalizeUserProfile({ displayName: 42 }).displayName).toBe('You');
      expect(normalizeUserProfile(null).displayName).toBe('You');
    });

    it('collapses whitespace and caps the length', () => {
      expect(normalizeUserProfile({ displayName: '  Ada   Lovelace ' }).displayName).toBe(
        'Ada Lovelace',
      );
      expect(normalizeUserProfile({ displayName: 'x'.repeat(200) }).displayName).toHaveLength(
        60,
      );
    });

    it('drops an avatar that is not a source worth rendering', () => {
      expect(
        normalizeUserProfile({
          displayName: 'Ada',
          avatarUri: 'javascript:alert(1)',
        }).avatarUri,
      ).toBeUndefined();
      expect(normalizeUserProfile({ displayName: 'Ada', avatarUri: '' }).avatarUri).toBeUndefined();
    });

    it('keeps the sources it can render', () => {
      for (const uri of [
        'data:image/png;base64,AAAA',
        'file:///avatars/me.png',
        'https://example.test/me.png',
        '/Users/dev/me.png',
      ]) {
        expect(normalizeUserProfile({ displayName: 'Ada', avatarUri: uri }).avatarUri).toBe(uri);
      }
    });
  });
});

describe('PresenceProfile', () => {
  it('defaults to the one form that is implemented', async () => {
    const store = new PresenceProfileStore({ root: await temporaryRoot() });

    expect(await store.get()).toEqual(DEFAULT_PRESENCE_PROFILE);
    expect(DEFAULT_PRESENCE_PROFILE.form).toBe('point-cloud');
  });

  it('survives a restart', async () => {
    const directory = await temporaryRoot();
    await new PresenceProfileStore({ root: directory }).set({
      form: 'point-cloud',
      material: 'obsidian',
      motion: 'reactive',
      accent: '#3AF',
    });

    expect(await new PresenceProfileStore({ root: directory }).get()).toEqual({
      form: 'point-cloud',
      material: 'obsidian',
      motion: 'reactive',
      accent: '#3af',
    });
  });

  it('lives beside the user profile, not inside a session or project', async () => {
    const directory = await temporaryRoot();
    await new PresenceProfileStore({ root: directory }).set(DEFAULT_PRESENCE_PROFILE);

    expect(
      JSON.parse(await readFile(path.join(directory, 'presence.json'), 'utf8')),
    ).toEqual(DEFAULT_PRESENCE_PROFILE);
  });

  describe('validation', () => {
    /** A profile from a future version must still open, as a point cloud. */
    it('coerces an unimplemented form rather than rejecting the profile', () => {
      const profile = normalizePresenceProfile({
        form: 'mesh',
        material: 'matrix',
        motion: 'fluid',
      });

      expect(profile).toEqual({
        form: 'point-cloud',
        material: 'matrix',
        motion: 'fluid',
      });
    });

    it('falls back on an unknown material or motion', () => {
      expect(
        normalizePresenceProfile({ material: 'velvet', motion: 'frantic' }),
      ).toEqual(DEFAULT_PRESENCE_PROFILE);
    });

    it('accepts only a hex accent', () => {
      expect(normalizePresenceProfile({ accent: '#abcdef' }).accent).toBe('#abcdef');
      expect(normalizePresenceProfile({ accent: '#abc' }).accent).toBe('#abc');
      expect(normalizePresenceProfile({ accent: 'rebeccapurple' }).accent).toBeUndefined();
      expect(normalizePresenceProfile({ accent: '#12345' }).accent).toBeUndefined();
    });

    it('produces a complete profile from nothing at all', () => {
      expect(normalizePresenceProfile(null)).toEqual(DEFAULT_PRESENCE_PROFILE);
      expect(normalizePresenceProfile('nonsense')).toEqual(DEFAULT_PRESENCE_PROFILE);
    });
  });
});

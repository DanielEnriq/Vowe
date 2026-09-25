import { describe, expect, it, vi } from 'vitest';

import {
  MAX_TITLE_CHARS,
  MAX_TITLE_WORDS,
  conciseTitle,
  normalizeGeneratedTitle,
  sanitizeTask,
  sessionTitle,
  titleSignal,
} from '../src/index.js';
import { SessionTitleService } from '../src/product/session-title-service.js';
import type { EventStore } from '../src/store/event-store.js';
import { testSession } from './helpers.js';

describe('Task sanitization — wrappers are not the work', () => {
  /** The exact shape that was being shown as a session's name. */
  it('strips an orphan paste wrapper and keeps nothing behind', () => {
    expect(sanitizeTask('<pasted_content id="aa28">')).toBe('');
  });

  it('keeps the content inside a wrapper, which is the actual signal', () => {
    expect(
      sanitizeTask('<pasted_content id="aa28">\nPort the Vowe UI to Electron\n</pasted_content>'),
    ).toBe('Port the Vowe UI to Electron');
  });

  it('strips the CLI wrappers a transcript carries', () => {
    expect(sanitizeTask('<bash-input>git push</bash-input>')).toBe('git push');
    expect(sanitizeTask('<system-reminder>be nice</system-reminder> Fix the bug')).toBe(
      'be nice Fix the bug',
    );
  });

  it('drops opaque identifiers', () => {
    expect(sanitizeTask('Fix 58cc559f-7103-4a0c-ac46-c44a20577c13 please')).toBe('Fix please');
  });

  it('collapses whitespace and bounds length', () => {
    expect(sanitizeTask('  Fix   the\n\n  bug ')).toBe('Fix the bug');
    expect(sanitizeTask('x'.repeat(5000)).length).toBeLessThanOrEqual(1200);
  });

  it('is total', () => {
    expect(sanitizeTask(null)).toBe('');
    expect(sanitizeTask(undefined)).toBe('');
  });
});

describe('Generated titles — taken at their word, not on trust', () => {
  it('accepts a plain title', () => {
    expect(normalizeGeneratedTitle('Implement SQLite persistence')).toBe(
      'Implement SQLite persistence',
    );
  });

  it('strips the quotes and periods models add', () => {
    expect(normalizeGeneratedTitle('"Fix voice interruption."')).toBe('Fix voice interruption');
    expect(normalizeGeneratedTitle('“Port the Vowe UI”')).toBe('Port the Vowe UI');
  });

  it('takes the first line when a model explains itself', () => {
    expect(normalizeGeneratedTitle('Add project Ask\n\nThis title describes…')).toBe(
      'Add project Ask',
    );
  });

  it('refuses a sentence, because the fallback is better than a paragraph', () => {
    const sentence = Array.from({ length: MAX_TITLE_WORDS + 3 }, () => 'word').join(' ');
    expect(normalizeGeneratedTitle(sentence)).toBeNull();
  });

  it('refuses nothing at all', () => {
    expect(normalizeGeneratedTitle('')).toBeNull();
    expect(normalizeGeneratedTitle('   ')).toBeNull();
    expect(normalizeGeneratedTitle(null)).toBeNull();
  });
});

describe('Session titles — precedence', () => {
  it('prefers a generated title over everything derivable', () => {
    expect(
      sessionTitle(
        testSession({ generatedTitle: 'Port the Vowe UI', task: 'something else entirely' }),
      ),
    ).toBe('Port the Vowe UI');
  });

  /** The failure this pass exists to end. */
  it('never shows a raw paste wrapper, even with no generated title', () => {
    const title = sessionTitle(
      testSession({
        task: '<pasted_content id="aa28">',
        displayLabel: '<pasted_content id="aa28">',
        cwd: '/repo/vowe',
      }),
    );
    expect(title).not.toMatch(/pasted_content/);
    expect(title).toBe('vowe');
  });

  it('falls back through the interpreter, the task, then the label', () => {
    expect(sessionTitle(testSession({ task: 'Fix the reconnect regression' }))).toBe(
      'Fix the reconnect regression',
    );
  });
});

describe('Title signal — what is worth naming', () => {
  it('prefers the interpreter’s reading over a raw pasted task', () => {
    const session = testSession({
      task: '<pasted_content id="aa28">',
      semanticState: {
        task: 'Port the Vowe UI into the Electron app',
        phase: 'editing',
        currentActivity: 'writing components',
        recentProgress: [],
        lastMeaningfulUpdate: '2026-09-22T09:00:00.000Z',
        currentUnderstanding: null,
        meaningfulUpdates: [],
        source: 'llm',
        provenance: { eventIds: [], throughSeq: 1 },
        updatedAt: '2026-09-22T09:00:00.000Z',
      },
    });
    expect(titleSignal(session)).toBe('Port the Vowe UI into the Electron app');
  });

  it('is null when a title already exists', () => {
    expect(titleSignal(testSession({ generatedTitle: 'Already named' }))).toBeNull();
  });

  it('is null when there is nothing to name from', () => {
    expect(titleSignal(testSession({ task: '<pasted_content id="aa28">' }))).toBeNull();
    expect(titleSignal(testSession({ task: 'hi' }))).toBeNull();
  });
});

describe('SessionTitleService — once, when someone asks by acting', () => {
  function fakeStore(
    sessions: Record<string, { generatedTitle?: string; task?: string }> = {},
  ): EventStore & { titles: Map<string, string>; writes: number } {
    const titles = new Map<string, string>();
    const store = {
      titles,
      writes: 0,
      getSession: (id: string) => testSession({ id, ...(sessions[id] ?? {}) }),
      /** Write-once, exactly as the real store's conditional UPDATE is. */
      setGeneratedTitle: async (id: string, title: string) => {
        store.writes += 1;
        if (titles.has(id) || sessions[id]?.generatedTitle) return false;
        titles.set(id, title);
        return true;
      },
    };
    return store as unknown as EventStore & { titles: Map<string, string>; writes: number };
  }

  const named = (task: string) => ({ task });

  it('names a session that has never been named, and persists it', async () => {
    const store = fakeStore({ s1: named('Port the Vowe UI into the Electron app') });
    const title = vi.fn(async () => 'Port the Vowe UI');
    const onTitled = vi.fn();
    const service = new SessionTitleService({
      store,
      model: { available: true, title },
      onTitled,
    });

    await service.ensure('s1');

    expect(title).toHaveBeenCalledTimes(1);
    expect(store.titles.get('s1')).toBe('Port the Vowe UI');
    expect(onTitled).toHaveBeenCalledWith('s1', 'Port the Vowe UI');
  });

  /**
   * The delimiter, and the whole point of the change.
   *
   * A stored title is final — including one that no longer meets the length
   * contract. Re-offering those for naming is how tightening a rule quietly
   * re-named a year of history.
   */
  it('asks nothing of a session the column has already named', async () => {
    const store = fakeStore({
      s1: {
        task: 'Port the Vowe UI into the Electron app',
        generatedTitle: 'Implement SQLite persistence for the event store and its migrations',
      },
    });
    const title = vi.fn(async () => 'x');
    await new SessionTitleService({ store, model: { available: true, title } }).ensure('s1');

    expect(title).not.toHaveBeenCalled();
    expect(store.writes).toBe(0);
  });

  /**
   * Re-renders and re-opens are ordinary. A model call is not.
   *
   * One attempt per session per run, recorded before the first await, so
   * nothing a room does — mounting twice, reloading, opening the same session
   * in two places — can turn into a second call.
   */
  it('attempts a session once per run, however often it is opened', async () => {
    const store = fakeStore({ s1: named('Port the Vowe UI into the Electron app') });
    const title = vi.fn(async () => 'Port the Vowe UI');
    const service = new SessionTitleService({ store, model: { available: true, title } });

    await service.ensure('s1');
    await service.ensure('s1');
    await service.ensure('s1');

    expect(title).toHaveBeenCalledTimes(1);
  });

  it('shares one call between callers that arrive together', async () => {
    const store = fakeStore({ s1: named('Port the Vowe UI into the Electron app') });
    const title = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return 'Port the Vowe UI';
    });
    const service = new SessionTitleService({ store, model: { available: true, title } });

    await Promise.all([service.ensure('s1'), service.ensure('s1'), service.ensure('s1')]);

    expect(title).toHaveBeenCalledTimes(1);
  });

  /**
   * A transient failure is a failure, not an invitation.
   *
   * A model that answers nothing — rate limited, unreachable, refused — gets
   * no stricter retry, because that is how one 429 becomes two. Nothing is
   * written either: the column stays null, the session keeps showing its
   * deterministic name, and some later run may try again.
   */
  it('neither retries nor writes when the model answers nothing', async () => {
    const store = fakeStore({ s1: named('Port the Vowe UI into the Electron app') });
    const title = vi.fn(async () => null);
    const onTitled = vi.fn();
    const service = new SessionTitleService({
      store,
      model: { available: true, title },
      onTitled,
    });

    await service.ensure('s1');
    await service.ensure('s1');

    expect(title).toHaveBeenCalledTimes(1);
    expect(store.writes).toBe(0);
    expect(store.titles.size).toBe(0);
    expect(onTitled).not.toHaveBeenCalled();
  });

  it('asks once more, more strictly, when the answer was outside the contract', async () => {
    const store = fakeStore({ s1: named('Port the Vowe UI into the Electron app') });
    const title = vi
      .fn()
      .mockResolvedValueOnce(
        'Port the entire Vowe user interface into the Electron desktop application',
      )
      .mockResolvedValueOnce('Port Vowe UI to Electron');

    await new SessionTitleService({ store, model: { available: true, title } }).ensure('s1');

    expect(title).toHaveBeenCalledTimes(2);
    expect(title.mock.calls[1]?.[1]).toEqual({ stricter: true });
    expect(store.titles.get('s1')).toBe('Port Vowe UI to Electron');
  });

  /**
   * Two answers outside the contract still leave a real signal to cut down,
   * and something inside the contract beats something outside it.
   */
  it('settles for a deterministic cut when both answers are sentences', async () => {
    const store = fakeStore({ s1: named('Port the Vowe UI into the Electron app') });
    const sentence = 'Port the entire Vowe user interface into the Electron desktop application';
    await new SessionTitleService({
      store,
      model: { available: true, title: async () => sentence },
    }).ensure('s1');

    const written = store.titles.get('s1');
    expect(written).toBeDefined();
    expect(normalizeGeneratedTitle(written!)).toBe(written);
  });

  it('does not ask twice when the first answer already holds', async () => {
    const store = fakeStore({ s1: named('Port the Vowe UI into the Electron app') });
    const title = vi.fn(async () => 'Port Vowe UI to Electron');
    await new SessionTitleService({ store, model: { available: true, title } }).ensure('s1');
    expect(title).toHaveBeenCalledTimes(1);
  });

  it('does nothing at all when no model is configured', async () => {
    const store = fakeStore({ s1: named('Port the Vowe UI into the Electron app') });
    const title = vi.fn(async () => 'x');
    await new SessionTitleService({ store, model: { available: false, title } }).ensure('s1');
    expect(title).not.toHaveBeenCalled();
  });

  /**
   * A session opened before it has been given any real instruction has only a
   * paste wrapper for a task. No model was called, so no attempt is spent:
   * opening it again once there is something to name from still works.
   */
  it('spends no attempt on a session with nothing to name from', async () => {
    const sessions: Record<string, { task?: string }> = {
      s1: { task: '<pasted_content id="aa28">' },
    };
    const store = fakeStore(sessions);
    const title = vi.fn(async () => 'Port the Vowe UI');
    const service = new SessionTitleService({ store, model: { available: true, title } });

    await service.ensure('s1');
    expect(title).not.toHaveBeenCalled();

    sessions['s1'] = { task: 'Port the Vowe UI into the Electron app' };
    await service.ensure('s1');
    expect(title).toHaveBeenCalledTimes(1);
  });

  /** Opening a session is what the caller is doing; naming is not its problem. */
  it('never throws, and never announces a write that did not happen', async () => {
    const store = fakeStore({ s1: named('Port the Vowe UI into the Electron app') });
    const onError = vi.fn();
    const onTitled = vi.fn();
    const service = new SessionTitleService({
      store,
      model: {
        available: true,
        title: async () => {
          throw new Error('rate limited');
        },
      },
      onTitled,
      onError,
    });

    await expect(service.ensure('s1')).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalled();
    expect(onTitled).not.toHaveBeenCalled();
  });
});

describe('Concise titles — the floor under the contract', () => {
  it('cuts a description down to a name, on whole words', () => {
    const title = conciseTitle(
      'Update Vowe desktop app UI (styles, VoPanel audio indicator) and verify with tests',
    );
    expect(title).toBe('Update Vowe desktop app UI');
    expect(normalizeGeneratedTitle(title)).toBe(title);
  });

  it('always produces something that satisfies the contract', () => {
    const inputs = [
      'Implement Slice 6.2 (UI polish plus answer streaming) for the Vowe desktop app, then verify',
      'Fix the reconnect regression',
      'Port the entire Vowe user interface into the Electron desktop application end to end',
      'Supercalifragilisticexpialidociously long single token that never ends anywhere at all',
    ];
    for (const input of inputs) {
      const title = conciseTitle(input);
      expect(title).not.toBeNull();
      expect(title!.length).toBeLessThanOrEqual(MAX_TITLE_CHARS);
      expect(title!.split(' ').length).toBeLessThanOrEqual(MAX_TITLE_WORDS);
    }
  });

  it('leaves a name that is already short alone', () => {
    expect(conciseTitle('Fix voice interruption')).toBe('Fix voice interruption');
  });

  it('has nothing to say about nothing', () => {
    expect(conciseTitle('')).toBeNull();
    expect(conciseTitle(null)).toBeNull();
    expect(conciseTitle('<pasted_content id="aa28">')).toBeNull();
  });

  /** The visible half of the regression: what is shown, not just what is stored. */
  it('bounds the title a session shows when no model has named it', () => {
    const shown = sessionTitle(
      testSession({
        task: 'Implement Slice 6.2 (UI polish plus answer streaming) for the Vowe desktop app, then verify everything',
      }),
    );
    expect(shown.length).toBeLessThanOrEqual(MAX_TITLE_CHARS);
  });

  /*
   * The half the bound above missed: a candidate `conciseTitle` can make
   * nothing of used to be returned whole, so the one case least able to
   * cope was the one case the contract did not cover.
   */
  it('bounds it for a candidate there is no concise title in', () => {
    const shown = sessionTitle(
      testSession({
        cwd: '/Users/dev/projects/vowe',
        displayLabel: null,
        task: '(a very long aside about the work that is entirely parenthetical and therefore names nothing at all)',
      }),
    );
    expect(shown).toBe('vowe');
  });

  it('never shows a name outside the contract, whatever it was given', () => {
    const tasks = [
      '(nothing but an aside)',
      '<pasted_content id="aa28">',
      'Refactor the desktop application layout architecture and then re-verify every pixel of it',
      'a'.repeat(300),
      '',
    ];
    for (const task of tasks) {
      const shown = sessionTitle(
        testSession({ cwd: '/Users/dev/projects/vowe', displayLabel: null, task }),
      );
      expect(shown.length).toBeLessThanOrEqual(MAX_TITLE_CHARS);
      expect(shown.split(' ').length).toBeLessThanOrEqual(MAX_TITLE_WORDS);
    }
  });
});

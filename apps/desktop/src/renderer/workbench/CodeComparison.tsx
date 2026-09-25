import { useEffect, useState, type ReactElement } from 'react';

import type { Highlighter } from 'shiki';

import { Fading } from '../shell/Fading.js';
import { FileIcon } from '../shell/icons.js';
import type { ComparedLine, FileComparison } from '../state/patch.js';

/**
 * One file's change, as the code before it and the code after it.
 *
 * Magic UI's Code Comparison, ported to this app's own styling rather than
 * brought in with Tailwind, `next-themes` and an icon library for the sake of
 * one component: the same two titled panes, the same `VS` mark between them,
 * Shiki for the code and the same green and red washes for what changed.
 * Both of Shiki's GitHub themes are emitted as variables on every token and
 * the stylesheet picks one by `data-theme`, so the code follows the appearance
 * without being highlighted again.
 *
 * Side by side when the desk is wide enough to read two columns of code, and
 * stacked when it is not — a container query rather than the viewport,
 * because the desk's width is its own and not the window's.
 *
 * Each side is highlighted as one block, so the grammar sees contiguous code,
 * and the change and gap rows are marked afterwards by line number. Until the
 * highlighter answers the same lines are drawn plain in the same boxes, so
 * the colour arriving moves nothing.
 */
export function CodeComparison({ file }: { file: FileComparison }): ReactElement {
  const name = file.from ? `${file.from} → ${file.path}` : file.path;
  const language = languageOf(file.path);

  return (
    <div className="code-comparison">
      <div className="sides">
        <Side name={name} which="before" lines={file.before} language={language} note={noteFor(file, 'before')} />
        <Side name={name} which="after" lines={file.after} language={language} note={noteFor(file, 'after')} />
      </div>
      <div className="vs" aria-hidden="true">
        VS
      </div>
    </div>
  );
}

function Side({
  name,
  which,
  lines,
  language,
  note,
}: {
  name: string;
  which: Which;
  lines: readonly ComparedLine[];
  language: string;
  note: string | null;
}): ReactElement {
  const html = useHighlighted(lines, language, which);

  return (
    <div className="side">
      <div className="side-head">
        <FileIcon />
        <Fading className="name">{name}</Fading>
        <span className="which">{which}</span>
      </div>

      {note ? (
        <p className="side-note">{note}</p>
      ) : html ? (
        <div className="side-code" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <div className="side-code">
          <pre className="plain">
            <code>
              {lines.map((line, index) => (
                <span key={index}>
                  {index > 0 && '\n'}
                  <span
                    className={`line${lineClass(line, which)}`}
                    {...(line.line === undefined ? {} : { 'data-line': line.line })}
                  >
                    {lineText(line)}
                  </span>
                </span>
              ))}
            </code>
          </pre>
        </div>
      )}
    </div>
  );
}

type Which = 'before' | 'after';

/** Why a side has no code to show, when it has none. */
function noteFor(file: FileComparison, which: Which): string | null {
  if (file.status === 'binary') return 'Binary file — no text to compare.';
  if (which === 'before' && file.status === 'added') return 'New file.';
  if (which === 'after' && file.status === 'deleted') return 'Deleted.';
  const lines = which === 'before' ? file.before : file.after;
  if (lines.length > 0) return null;
  return file.status === 'renamed' ? 'Moved; the content is unchanged.' : 'Nothing on this side.';
}

function lineClass(line: ComparedLine, which: Which): string {
  if (line.kind === 'gap') return ' gap';
  if (line.kind === 'change') return which === 'before' ? ' remove' : ' add';
  return '';
}

function lineText(line: ComparedLine): string {
  if (line.kind !== 'gap') return line.text;
  return line.text ? `⋯ ${line.text}` : '⋯';
}

/**
 * Shiki's language id for a path, or `text`.
 *
 * The extension is the id for nearly everything Shiki knows (`ts`, `tsx`,
 * `yml`, `sh`…); the two common extensionless names are named outright, and
 * whatever Shiki does not recognise is checked for later and drawn as text.
 */
function languageOf(path: string): string {
  const name = (path.split('/').pop() ?? '').toLowerCase();
  if (name === 'dockerfile' || name === 'makefile') return name;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1) : 'text';
}

function useHighlighted(
  lines: readonly ComparedLine[],
  language: string,
  which: Which,
): string | null {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setHtml(null);
    if (lines.length === 0) return;
    highlight(lines, language, which)
      .then((next) => {
        if (live) setHtml(next);
      })
      // Stays plain. Uncoloured code is still the diff; an error box is not.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [lines, language, which]);

  return html;
}

const THEMES = { light: 'github-light-default', dark: 'github-dark-default' } as const;

/**
 * One highlighter for the app, made the first time a diff is drawn.
 *
 * Loaded on demand so Shiki stays out of the startup bundle, with the
 * JavaScript regex engine rather than the WebAssembly one — nothing here needs
 * the last few grammars that only Oniguruma handles — and each language
 * fetched the first time a file needs it.
 */
let highlighter: Promise<Highlighter> | null = null;

/**
 * Languages being fetched, so the two sides fetch each one once.
 *
 * Both sides of a comparison highlight at the same moment and in the same
 * language, and `loadLanguage` is not idempotent under that: each saw the
 * language missing, both asked for it, and one of the two calls lost. Its
 * `catch` then dropped that side to `text` — so a file would come up coloured
 * on the left and plain on the right, intermittently, which looks like the
 * highlighter failing rather than like a race. One promise per language,
 * awaited by everyone who wants it.
 */
const loadingLanguages = new Map<string, Promise<void>>();

async function highlight(
  lines: readonly ComparedLine[],
  language: string,
  which: Which,
): Promise<string> {
  const shiki = await import('shiki');
  /*
   * A creation that fails is forgotten rather than kept.
   *
   * `??=` stores the promise, and a rejected promise is still a promise — so
   * one failure (a bad first load, an offline fetch of the engine) was cached
   * for the life of the window and every diff opened afterwards came up
   * plain, with nothing to suggest it was one transient error rather than a
   * highlighter that does not work. Clearing the slot lets the next diff try.
   */
  highlighter ??= shiki
    .createHighlighter({
      themes: Object.values(THEMES),
      langs: [],
      engine: shiki.createJavaScriptRegexEngine(),
    })
    .catch((error: unknown) => {
      highlighter = null;
      throw error;
    });
  const instance = await highlighter;

  let lang = language in shiki.bundledLanguages ? language : 'text';
  if (lang !== 'text' && !instance.getLoadedLanguages().includes(lang)) {
    let pending = loadingLanguages.get(lang);
    if (!pending) {
      pending = instance
        .loadLanguage(lang as keyof typeof shiki.bundledLanguages)
        .then(() => undefined);
      loadingLanguages.set(lang, pending);
    }
    try {
      await pending;
    } catch {
      // Not cached as a failure: a grammar that failed to fetch once may well
      // arrive next time, and until it does this side reads as plain text.
      loadingLanguages.delete(lang);
      lang = 'text';
    }
  }

  return instance.codeToHtml(lines.map((line) => (line.kind === 'gap' ? '' : line.text)).join('\n'), {
    lang,
    themes: THEMES,
    defaultColor: false,
    transformers: [
      {
        line(node, number) {
          const line = lines[number - 1];
          if (!line) return;
          const extra = lineClass(line, which).trim();
          if (extra) this.addClassToHast(node, extra);
          // The gutter, which the stylesheet draws from the attribute. A gap
          // has no number: it is the space where lines were skipped.
          if (line.line !== undefined) node.properties['data-line'] = String(line.line);
          if (line.kind === 'gap') node.children = [{ type: 'text', value: lineText(line) }];
        },
      },
    ],
  });
}

// Satoshi's licence (ITF FFL, src/renderer/fonts/Satoshi-LICENSE.txt) allows
// bundling it with the app but not serving it from a public repository, so the
// .woff2 files are fetched from Fontshare at dev/build time and never committed.
// The built app carries them; nothing is fetched at runtime.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FONTS = join(dirname(fileURLToPath(import.meta.url)), '../src/renderer/fonts');
const FACES = { 400: 'Satoshi-Regular.woff2', 500: 'Satoshi-Medium.woff2', 700: 'Satoshi-Bold.woff2' };
const CSS = 'https://api.fontshare.com/v2/css?f[]=satoshi@400,500,700&display=swap';

const isWoff2 = (bytes) => bytes.subarray(0, 4).toString('latin1') === 'wOF2';
const present = (path) => existsSync(path) && isWoff2(readFileSync(path));

const missing = Object.entries(FACES).filter(([, file]) => !present(join(FONTS, file)));
if (missing.length > 0) {
  try {
    const css = await (await fetch(CSS)).text();
    const urls = new Map();
    for (const block of css.split('@font-face').slice(1)) {
      const weight = /font-weight:\s*(\d+)/.exec(block)?.[1];
      const url = /url\('([^']+\.woff2)'\)/.exec(block)?.[1];
      if (weight && url) urls.set(weight, url.startsWith('//') ? `https:${url}` : url);
    }
    mkdirSync(FONTS, { recursive: true });
    for (const [weight, file] of missing) {
      const url = urls.get(weight);
      if (!url) throw new Error(`no woff2 for weight ${weight}`);
      const body = Buffer.from(await (await fetch(url)).arrayBuffer());
      if (!isWoff2(body)) throw new Error(`${file} is not woff2`);
      writeFileSync(join(FONTS, file), body);
    }
    console.log(`fetch-fonts: fetched ${missing.map(([, file]) => file).join(', ')}`);
  } catch (error) {
    // Deterministic fallback: the --font stack falls through to the system face.
    console.warn(`fetch-fonts: Satoshi unavailable (${error.message}); using the system font`);
  }
}

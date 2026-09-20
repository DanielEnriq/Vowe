import { writeFile } from 'node:fs/promises';

import { buildSyntheticTrace } from './make-synthetic.ts';
import { resolveFromInvocation } from './resolve-path.ts';

const outputArg = process.argv[2];
const output = outputArg ? resolveFromInvocation(outputArg) : undefined;
if (!output) {
  console.error('usage: make-synthetic <output.jsonl>');
  process.exitCode = 1;
} else {
  const lines = buildSyntheticTrace();
  await writeFile(output, `${lines.join('\n')}\n`, 'utf8');
  console.log(`Wrote ${lines.length} synthetic records to ${output}`);
}

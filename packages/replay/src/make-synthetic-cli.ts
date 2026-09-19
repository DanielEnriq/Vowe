import { writeFile } from 'node:fs/promises';

import { buildSyntheticTrace } from './make-synthetic.ts';

const output = process.argv[2];
if (!output) {
  console.error('usage: make-synthetic <output.jsonl>');
  process.exitCode = 1;
} else {
  const lines = buildSyntheticTrace();
  await writeFile(output, `${lines.join('\n')}\n`, 'utf8');
  console.log(`Wrote ${lines.length} synthetic records to ${output}`);
}

/**
 * Generator for the synthetic repeated-failure fixture.
 *
 * The sanitized real transcript is the right input for windowing, but it cannot
 * be relied on to contain the behaviour the surfacing path exists for: a worker
 * cycling through variations of one approach and failing the same assertion
 * every time. That has to be constructed, and constructed deterministically, or
 * the test that depends on it is not a test.
 *
 * Committed alongside the fixture so the shape is auditable and adjustable.
 */

interface Line {
  record: Record<string, unknown>;
}

const SESSION = '00000000-0000-4000-8000-0000000000aa';
const CWD = '/Users/dev/projects/demo';
const START = Date.parse('2026-02-11T09:00:00.000Z');

let clock = START;
let uuidCounter = 0;

function nextAt(seconds: number): string {
  clock += seconds * 1000;
  return new Date(clock).toISOString();
}

function uuid(): string {
  uuidCounter += 1;
  return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, '0')}`;
}

function base(type: string, at: string): Record<string, unknown> {
  return {
    type,
    uuid: uuid(),
    sessionId: SESSION,
    timestamp: at,
    cwd: CWD,
    gitBranch: 'fix/reconnect-replay',
  };
}

function userText(text: string, seconds = 1): Line {
  return {
    record: {
      ...base('user', nextAt(seconds)),
      message: { role: 'user', content: [{ type: 'text', text }] },
    },
  };
}

function assistantText(text: string, seconds = 4): Line {
  return {
    record: {
      ...base('assistant', nextAt(seconds)),
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    },
  };
}

function toolUse(
  name: string,
  input: Record<string, unknown>,
  id: string,
  seconds = 3,
): Line {
  return {
    record: {
      ...base('assistant', nextAt(seconds)),
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id, name, input }],
      },
    },
  };
}

function toolResult(
  id: string,
  content: string,
  isError: boolean,
  seconds = 6,
): Line {
  return {
    record: {
      ...base('user', nextAt(seconds)),
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: id, content, is_error: isError },
        ],
      },
      toolUseResult: { stdout: content, stderr: '', interrupted: false },
    },
  };
}

/**
 * The failing assertion, repeated verbatim across every attempt.
 *
 * Identical output each time is the point: what should be noticed is not that
 * a test failed, but that the same test is failing the same way after four
 * different attempts to fix it.
 */
const FAILURE = `FAIL  test/reconnect.test.ts > reconnect > replays each message exactly once
AssertionError: expected 2 to be 1 // Object.is equality

- Expected
+ Received

- 1
+ 2

 ❯ test/reconnect.test.ts:48:32
     46|   await socket.reconnect();
     47|   await flushHttpCatchUp();
     48|   expect(store.messages.length).toBe(1);
       |                                ^
     49| });

 Test Files  1 failed (1)
      Tests  1 failed (12 passed)`;

const ATTEMPTS: { reasoning: string; file: string; edit: string }[] = [
  {
    reasoning:
      'The reconnect path replays buffered messages, and the HTTP catch-up fetch also returns them. I will dedupe by message id inside the websocket replay handler.',
    file: 'src/transport/websocket.ts',
    edit: 'if (seen.has(message.id)) return;\nseen.add(message.id);',
  },
  {
    reasoning:
      'Still two copies. The seen-set must be getting reset on reconnect. I will hoist it out of the handler so it survives the reconnect.',
    file: 'src/transport/websocket.ts',
    edit: 'const seen = new Set<string>(); // hoisted to module scope',
  },
  {
    reasoning:
      'Same failure. Perhaps the catch-up response is what arrives second, so I will dedupe in the HTTP catch-up path instead.',
    file: 'src/transport/http-catchup.ts',
    edit: 'const fresh = response.messages.filter((m) => !store.has(m.id));',
  },
  {
    reasoning:
      'Still expected 1, received 2. Let me try clearing the buffer before the catch-up lands.',
    file: 'src/transport/websocket.ts',
    edit: 'buffer.length = 0; // clear before catch-up',
  },
];

export function buildSyntheticTrace(): string[] {
  const lines: Line[] = [];

  lines.push(
    userText(
      'The reconnect regression test is failing on CI. Please fix it — after a reconnect the store ends up with a duplicate of the replayed message.',
      0,
    ),
  );
  lines.push(
    assistantText(
      'Let me look at the failing test and the transport code before changing anything.',
    ),
  );

  const readId = uuid();
  lines.push(toolUse('Read', { file_path: `${CWD}/test/reconnect.test.ts` }, readId));
  lines.push(
    toolResult(
      readId,
      "test('replays each message exactly once', async () => {\n  await socket.reconnect();\n  await flushHttpCatchUp();\n  expect(store.messages.length).toBe(1);\n});",
      false,
      2,
    ),
  );

  for (const attempt of ATTEMPTS) {
    lines.push(assistantText(attempt.reasoning));

    const editId = uuid();
    lines.push(
      toolUse(
        'Edit',
        { file_path: `${CWD}/${attempt.file}`, new_string: attempt.edit },
        editId,
      ),
    );
    lines.push(toolResult(editId, `Applied edit to ${attempt.file}`, false, 2));

    const testId = uuid();
    lines.push(
      toolUse(
        'Bash',
        {
          command: 'pnpm vitest run test/reconnect.test.ts',
          description: 'Run the reconnect regression test',
        },
        testId,
      ),
      );
    lines.push(toolResult(testId, FAILURE, true, 25));
  }

  lines.push(
    assistantText(
      'That is the fourth variation of the same deduplication approach and the assertion is unchanged. Something about my model of the ordering must be wrong.',
    ),
  );

  return lines.map((line) => JSON.stringify(line.record));
}

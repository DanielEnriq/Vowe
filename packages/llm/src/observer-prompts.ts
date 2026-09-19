import type { InvestigationInput } from '@vowe/core';

/**
 * The investigator's standing instruction.
 *
 * Note the two-answer requirement. A voice conversation and a written record
 * want genuinely different things, and producing one and truncating it gives
 * you neither — so the model is asked for both, explicitly, every time.
 */
export const INVESTIGATE_SYSTEM = `You are Vowe's backend. A developer is talking to a voice assistant about a coding agent that is working for them, and the assistant has handed you a technical question it cannot answer on its own.

You can look at the observed session: its interpreted windows, its raw trace, the messages between the developer and the worker, the repository, and the current diff. Use the tools to find out. Do not answer from assumption — if you have not looked, look.

When you have the answer, call record_answer exactly once. It takes two forms of the same answer:

- spokenAnswer: what a colleague would actually say out loud. One or two sentences. Lead with the answer, not with how you found it. Name the specific thing — the test, the file, the error — because that is what was asked. Do not describe your search. Do not offer a menu of next steps; at most, note that you have the details if they want them.
- fullAnswer: the grounded technical account, for reading rather than hearing. Include the specifics: file paths, test names, error text, what changed. Say plainly where the evidence came from.

If you could not find out, say so in both. A wrong confident answer is far worse than "I could not find that".`;

export function renderInvestigationPrompt(input: InvestigationInput): string {
  const parts: string[] = [];

  parts.push(`Task as the developer stated it: ${input.task ?? 'not yet known'}`);
  parts.push(`Working directory: ${input.cwd ?? 'unknown'}`);
  parts.push(`Session: ${input.sessionId}`);

  if (input.recentNotes.length) {
    parts.push('', 'What the observer currently understands, oldest first:');
    for (const note of input.recentNotes) {
      parts.push(`  [window ${note.windowIndex}] ${note.summary}`);
      if (note.notableChange) parts.push(`      notable: ${note.notableChange}`);
    }
  } else {
    parts.push('', 'The observer has not interpreted any of this session yet.');
  }

  if (input.liveConversation.length) {
    parts.push('', 'What has been said out loud so far:');
    for (const turn of input.liveConversation) {
      parts.push(`  ${turn.speaker === 'user' ? 'Developer' : 'Vo'}: ${turn.text}`);
    }
  }

  parts.push('', `The question to answer: ${input.question}`);
  return parts.join('\n');
}

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

/**
 * The same job, asked about a repository instead of one run.
 *
 * A separate constant rather than a parameterised sentence: the shipped
 * session prompt talks about "the observed session" throughout, and a project
 * question has no session. Telling the model otherwise would be the first
 * inaccuracy in a chain that ends with a confident wrong answer.
 */
export const INVESTIGATE_PROJECT_SYSTEM = `You are Vowe's backend. A developer is asking about a repository they are working in, and about the coding agents currently working in it.

You can look at the repository itself, at what Vowe has learned about it, and at what Vowe has understood about each session running in it. Use the tools to find out. Do not answer from assumption — if you have not looked, look.

You are answering about the project as a whole. When the answer is really about one session, say which session, and ground it in what you found there.

When you have the answer, call record_answer exactly once. It takes two forms of the same answer:

- spokenAnswer: what a colleague would actually say out loud. One or two sentences. Lead with the answer, not with how you found it.
- fullAnswer: the grounded technical account, for reading rather than hearing. Include the specifics: file paths, session names, what changed. Say plainly where the evidence came from.

If you could not find out, say so in both. A wrong confident answer is far worse than "I could not find that".`;

export function renderInvestigationPrompt(input: InvestigationInput): string {
  const parts: string[] = [];

  if ('projectId' in input) {
    parts.push(`Project: ${input.projectName}`);
    parts.push(`Repository root: ${input.repoRoot ?? 'unknown'}`);

    if (input.sessions.length) {
      parts.push('', 'Sessions in this project, most recently active first:');
      for (const session of input.sessions) {
        const where = session.branch ? ` on ${session.branch}` : '';
        const doing = session.currentActivity ? ` — ${session.currentActivity}` : '';
        parts.push(`  [${session.status}] ${session.label}${where}${doing}`);
      }
    } else {
      parts.push('', 'No sessions have run in this project yet.');
    }

    renderAttachments(parts, input.attachments);
    parts.push('', `The question to answer: ${input.question}`);
    return parts.join('\n');
  }

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

  renderAttachments(parts, input.attachments);
  parts.push('', `The question to answer: ${input.question}`);
  return parts.join('\n');
}

/**
 * What the developer put on the table, already opened.
 *
 * Included verbatim rather than named, because an attachment the model has to
 * choose to open is one it can choose not to.
 */
function renderAttachments(
  parts: string[],
  attachments: InvestigationInput['attachments'],
): void {
  if (!attachments?.length) return;
  parts.push('', 'The developer attached this to the question:');
  for (const attachment of attachments) {
    parts.push('', `  [${attachment.refId}] ${attachment.label}`, attachment.content);
  }
}

import type {
  SessionInterpretationInput,
  SessionQuestionInput,
} from '@vowe/core';

export const SUMMARIZE_SYSTEM = `You interpret the activity of a software engineering agent that is working autonomously.

You are given a window of observed events from one agent session: tool calls, file edits, shell commands, test runs, and the agent's own messages. Produce a short, concrete description of what that session appears to be doing.

Rules:
- Operation reports, requests and worker messages are assertions, not proof of successful execution. Unknown execution must never become tests passed. Sequence is admission order, not guaranteed execution chronology.
- Describe only what the evidence supports. Never invent a file, error, decision or outcome that does not appear in the events.
- "task" is what the worker is trying to accomplish, in the user's terms. Keep the existing task unless the evidence clearly shows it changed.
- "phase" is one or two words, e.g. exploring, editing, debugging, testing, waiting, finished.
- "currentActivity" is a short present-tense phrase about what is happening right now, at most twelve words. Use human language, never raw shell commands, tool syntax, opaque IDs, or quoted worker prose.
- "recentProgress" is up to six short bullet points of what has actually been established or changed, oldest first. Findings and outcomes, not a transcript of tool calls.
- If the evidence is thin, say so plainly rather than padding.`;

export const ANSWER_SYSTEM = `You are a companion to a developer whose coding agents are working in the background. You answer the developer's questions about one session.

Everything you know comes from observing that session: its normalized event history and the interpreted state derived from it. You are not the agent doing the work, and your answer is NOT sent to it.

Rules:
- Ground every claim in the observed evidence you were given. If the evidence does not answer the question, say exactly that, and say what you would need to see.
- Never fabricate file names, errors, reasoning or results. Operation reports and worker messages do not establish successful execution; unknown outcomes must remain unknown.
- Speak plainly and briefly, the way an engineer would on a call. No preamble, no restating the question.
- The developer can see the raw events, so do not pad with detail they did not ask for.
- If asked to change what the agent is doing, explain that you observe rather than act, and that sending an instruction is a separate, explicit action.`;

export function renderInterpretationPrompt(
  input: SessionInterpretationInput,
): string {
  const parts: string[] = [];
  parts.push(`Session: ${input.sessionId}`);
  parts.push(`Working directory: ${input.cwd ?? 'unknown'}`);
  parts.push(`Task as currently understood: ${input.task ?? 'not yet known'}`);
  if (input.previousState) {
    parts.push(
      '',
      'Previous interpretation:',
      `  phase: ${input.previousState.phase}`,
      `  current activity: ${input.previousState.currentActivity}`,
      `  recent progress: ${input.previousState.recentProgress.join('; ') || '(none)'}`,
    );
  }
  parts.push('', `Observed events (${input.events.length}, in admission order):`);
  for (const event of input.events) {
    parts.push(`  [${event.seq}] ${event.at} ${event.kind}: ${event.summary}`);
    if(event.evidence) parts.push(`    evidence: ${JSON.stringify(event.evidence)}`);
  }
  return parts.join('\n');
}

export function renderQuestionPrompt(input: SessionQuestionInput): string {
  const parts: string[] = [];
  parts.push(`Task as currently understood: ${input.task ?? 'not yet known'}`);
  parts.push(`Working directory: ${input.cwd ?? 'unknown'}`);
  if (input.semanticState) {
    parts.push(
      '',
      'Interpreted state:',
      `  phase: ${input.semanticState.phase}`,
      `  current activity: ${input.semanticState.currentActivity}`,
      `  recent progress:`,
      ...input.semanticState.recentProgress.map((p) => `    - ${p}`),
      `  last meaningful update: ${input.semanticState.lastMeaningfulUpdate}`,
      `  derived by: ${input.semanticState.source}`,
    );
  } else {
    parts.push('', 'Interpreted state: none yet.');
  }

  parts.push('', `Observed events (${input.events.length}, in admission order):`);
  for (const event of input.events) {
    parts.push(`  [${event.seq}] ${event.at} ${event.kind}: ${event.summary}`);
    if(event.evidence) parts.push(`    evidence: ${JSON.stringify(event.evidence)}`);
  }

  const priorTurns = input.conversation.filter(
    (entry) => entry.role === 'user_question' || entry.role === 'companion_answer',
  );
  if (priorTurns.length) {
    parts.push('', 'Earlier in this conversation:');
    for (const entry of priorTurns) {
      const who = entry.role === 'user_question' ? 'Developer' : 'You';
      parts.push(`  ${who}: ${entry.text}`);
    }
  }

  const instructions = input.conversation.filter(
    (entry) => entry.role === 'user_instruction',
  );
  if (instructions.length) {
    parts.push('', 'Instructions the developer has sent to the agent:');
    for (const entry of instructions) parts.push(`  - ${entry.text}`);
  }

  parts.push('', `Developer's question: ${input.question}`);
  return parts.join('\n');
}

import { focusList, live, type DesignConsideration, type DesignFocus, type DesignModel, type DesignPart, type DesignTurn } from '@vowe/core';

/**
 * Vowe in Studio: a system-design partner, not a coding agent.
 *
 * The prompt is the behaviour of the `SystemDesignAgent`, so it is written as
 * the product rules rather than as persona. The two that matter most are the
 * grounding rule — say only what you know about the implementation, and go and
 * check when it matters — and the move rule — the design changes when the
 * thinking does, in small moves, not on every turn.
 */
export const STUDIO_SYSTEM = `You are Vowe, in Studio: where a developer works out what their software system should become. You are their system-design partner, not a coding agent. You do not edit code, write diffs or plan exact changes; a coding harness does that later.

How you work:
understand what they are after → form a system model → draw the shape that matters → name the one or two real uncertainties → check the repository only when implementation truth decides something → change the design.
Not: interrogate them, write an essay, or dump implementation detail.

Point of view:
- Lead with your own view and its trade-off. Be easy to redirect: when the developer disagrees, move with them unless something concrete is at stake, and then say what.
- Ask at most one question, and only one that neither the conversation nor the repository can answer. Never open with a questionnaire; draft first, and let the question ride on the draft.
- Do not add what the design does not need. "I wouldn't add Redis yet. Nothing here needs cross-instance ephemeral state." is a good answer.
- Do not quiz the developer about their own codebase. When what an existing part actually does matters to the point, check the repository instead of asking.
- Keep proposal separate from fact. "I would put auth in front of the API" is design. "The observer is per-session" is a claim about the code.

Altitude:
The design is the system at whiteboard level: clients, services, APIs, auth, stores, queues, workers, external services, runtimes and boundaries, and the flows between them. It is not a class diagram.
- A part is something a developer would draw as a box when explaining the system to a colleague. Never a class, function, file, type or package just because the code has one.
- When starting from code, abstract. Things that run together, change together and are reasoned about together are one part. Name it the way the team talks about it; the file it lives in belongs in refs, not in the name.
- Keep it to the neighbourhood this design is about: usually 4–10 parts, never more than about 12.

The grammar:
- A part: an id, a name, a role (one line under eight words: what it is for), and optionally a kind, a technology, and a group it sits within.
- kind, one of:
  client — where people use the system, on their device (web app, mobile app, desktop app, CLI, admin UI)
  service — code you run (API, backend, gateway, auth service, worker, function, agent)
  store — state you keep (database, cache, object storage, search index)
  queue — an asynchronous hand-off (queue, topic, stream, event bus)
  external — something you use but do not run (Stripe, a model provider, email, a coding harness)
  group — a boundary with no behaviour of its own (Frontend, Backend, Supabase, a VPC)
  Give every part the kind it plainly is; leave it out only when none fits. A worker is a service, a cache is a store, a model provider is external.
- technology: {"name":"PostgreSQL","key":"postgresql"}. Set it only when the developer named it, the repository grounds it, or choosing it is the point being made. Otherwise leave it out; a store does not need to be Postgres to be a store. key is an optional lowercase slug for the product (postgresql, redis, stripe, aws-s3, supabase, vercel, openai, anthropic).
- within: the id of a part you drew with "kind":"group". Only a group holds parts: a process, platform or runtime that hosts several parts is drawn as a group, not a service. Use groups only when a boundary matters: what runs where, what you run versus what you use, a platform that hosts several parts, a trust boundary. A small design usually has none. A group never sits within another. To take a part out of a group, set "within": null.
- A link: one part calls, feeds or owns another; its direction follows data or control. Label it with one or two words only when the relation is not obvious ("webhook", "publishes"). A part with no links says nothing about where it sits.
- A responsibility: something a part holds that matters to the design, like "retries failed jobs" or "durable across restarts". Keep responsibilities rare. Add one only when ownership is being discussed, when it moves, when it separates two options, or when it decides something. Most parts have none. Never give every part one because the design allows it. To move a responsibility, change its part; do not remove and recreate it.
- A part's detail is where your reasoning lives: why it is here, what is assumed, what is still open, and grounded citations. It is shown only when the developer asks why. Write it when the reasoning is worth keeping.
- Layout is not yours. There are no coordinates, and "above" or "beside" is not architecture. Say it with links, groups and responsibilities.
- Ids are stable lowercase-kebab slugs you choose once. Reuse the exact ids of the current design. A rename changes the name, never the id.

Grounding rule:
Never assert an implementation-specific fact unless it is grounded in the context you were given, an attachment, an earlier repository finding, or a repository check made this turn. Proposed architecture and hypothetical reasoning need no check just because they are technical. It is fine to say "I don't know yet whether the current code supports that", and to check only when the answer changes the decision in front of you.

Checking the repository:
- consult_repository asks a coding harness a read-only question about the actual code. The harness knows the repository better than you; you decide what level of abstraction is useful to the developer. It takes tens of seconds, so use it only when the answer would change the design. At most two per turn.
- Ask one specific, self-contained, system-level question: what runs, what it keeps, what it talks to, and what survives a restart. For example: "Which processes and stores make up session observation, and what persists across a restart?" Never ask for a survey of the whole repository, and never ask for a list of classes. When the question is about a part on the design, pass its id as "part".
- Say in a few words what you are checking, then check. "That could live in SessionRegistry, but its restart lifecycle matters. I'm checking that."
- Use what comes back. If the check could not be done or found nothing, say so plainly and treat the point as unchecked. Never fill the gap with a guess.
- Do not re-check what earlier findings already ground.

What exists today:
- "today": true records that the repository has this part, link or responsibility now, as described. Set it only when a finding, a check this turn or an attachment grounds it, usually when you first draw something that already exists. Proposed things omit it. Never set it from assumption.
- When the design changes an existing part, do not touch its today. It keeps what the code has.

How the developer began, on the first message only:
- "from an idea": greenfield. Nothing here exists in a repository. Draft a coherent first architecture straight from their intent in this first turn, and never set today. Never check the repository to find out whether one exists; how they began already tells you. Check it only if they name a specific existing thing that matters.
- "from code": start from what exists. Check the repository for the system-level shape of the area involved, draw that neighbourhood abstracted to parts, and mark only what the finding confirms as today.

Selection:
When the developer has selected a part, link or responsibility, it is the subject of their message. "Why?", "this", "it", "here", "move this into the backend" and "does this need the database?" all mean the selection. Answer about it, or change it, directly.

Moves:
- A sentence to you and a gesture on the canvas end as the same ops. Dragging "retries failed jobs" onto Worker is {"op":"responsibility","id":"retries","part":"worker"}, and so is "move retry handling to the worker". Emit exactly what the gesture would.
- Move the design when the conversation actually changes it: a direction stated or changed, a new part or relationship, a grounded finding that changes what the design rests on. A turn that only explores, explains or answers does not move it. Prefer small moves. Never redraw what did not change.
- "Revert that" or "undo that": use {"op":"revert","move":"<move id>"} with the id from the recent moves. Never hand-write the inverse.
- To move, end your turn, after everything you want to say, with exactly this block and nothing after it:
<design_move>
<why>Why the design changed, in one sentence: the idea or finding that moved it. Not a description of the ops.</why>
{"op":"design","title":"Short title","intent":"One or two sentences: what this design is for."}
{"op":"part","id":"backend","name":"Backend","role":"What we run","kind":"group"}
{"op":"part","id":"api","name":"API","role":"Serves the web app","kind":"service","within":"backend"}
{"op":"part","id":"db","name":"Database","role":"Accounts and orders","kind":"store","within":"backend","technology":{"name":"PostgreSQL","key":"postgresql"}}
{"op":"part","id":"stripe","name":"Stripe","role":"Takes payments","kind":"external","technology":{"name":"Stripe","key":"stripe"},"detail":"Why it is here…"}
{"op":"link","from":"api","to":"db"}
{"op":"link","from":"stripe","to":"api","label":"webhook"}
{"op":"responsibility","id":"retries","part":"worker","text":"retries failed jobs"}
{"op":"part","id":"api","within":null}
{"op":"remove","id":"some-part"}
{"op":"revert","move":"mv-1a2b3c4d"}
</design_move>
- One JSON object per line and nothing else on it. Groups before the parts within them, and parts before the links and responsibilities that refer to them. To change something, repeat its id with only the fields that change.
- "remove" takes a part id, a link id ("from->to") or a responsibility id. Removing a part removes its links and responsibilities. Removing a group leaves its parts, now outside it.
- A design's first move sets the title and intent with a "design" op. It draws the neighbourhood the conversation is about, with kinds and links, so that it reads as a system.
- If the design arrives as an earlier document, your next move draws it as a system: the parts and links it describes, with its reasoning in their detail.
- Without a move block, the design stays exactly as it is.
- Cite the repository only with references a finding or an attachment gave you. Write them as Markdown links whose target is "ref:" followed by the reference exactly, e.g. [observer-runner.ts](ref:repo:/path/to/observer-runner.ts#120), in a part's detail or in your reply. A part's "refs" may list such references (without "ref:") for where it lives in the code. Never invent a reference.

Your reply:
One to three sentences, the way a senior colleague talks at a whiteboard. No preamble. The developer is looking at the design, so never narrate the move or describe what the picture already shows. Say what matters: the reasoning, the trade-off, what the repository told you, what is left to decide, or the one question. For example: "Split auth from the API and put session state behind Supabase. The main decision left is whether the worker needs the same identity path."`;

/** Everything the agent is handed for one turn, as a single user message. */
export function renderDesignTurn(input: DesignTurn): string {
  const parts: string[] = [`Project: ${input.projectName}`];

  if (input.design?.legacyDocument) {
    parts.push('', `The design so far is an earlier document (revision ${input.design.revision}), not yet drawn as a system:`, '<document>', input.design.legacyDocument, '</document>');
  } else if (input.design) {
    parts.push('', `The design (revision ${input.design.revision}):`, renderModel(input.design.model));
  } else {
    parts.push('', 'Nothing is drawn yet.');
  }
  if (input.start === 'code') parts.push('', 'The developer chose to start from code: draw what exists, grounded in the repository.');
  if (input.start === 'idea') parts.push('', 'The developer chose to start from an idea: nothing here exists in a repository yet. Draft it.');

  if (input.moves.length) {
    parts.push('', 'Recent moves, oldest first:');
    for (const move of input.moves) {
      parts.push(`- ${move.id} (${move.author === 'vowe' ? 'you' : 'the developer'}${move.via === 'canvas' ? ', on the canvas' : ''}): ${move.summary || '(no reason given)'}`);
    }
  }

  if (input.findings.length) {
    parts.push('', 'Grounded repository findings from earlier in this design, oldest first:');
    for (const finding of input.findings) {
      parts.push('', `- Question: ${finding.question}`, `  Finding: ${finding.answer}`);
      if (finding.refs.length) parts.push(`  References: ${finding.refs.join(', ')}`);
    }
  }

  if (input.conversation.length) {
    parts.push('', 'The conversation so far, oldest first:');
    for (const turn of input.conversation) {
      parts.push('', `${turn.speaker === 'developer' ? 'Developer' : 'You'}: ${turn.text}`);
    }
  }

  if (input.attachments?.length) {
    parts.push('', 'The developer attached this:');
    for (const attachment of input.attachments) {
      parts.push('', `[${attachment.refId}] ${attachment.label}`, attachment.content);
    }
  }

  if (input.focus) parts.push('', renderSelection(input.focus, input.design?.model ?? null));
  parts.push('', `Developer: ${input.message}`);
  parts.push('', reminder(input));
  return parts.join('\n');
}

/**
 * The rules a turn most often breaks, restated last, where a small model
 * weighs them most: short replies, a first draft rather than questions, and no
 * repository check on an idea.
 */
function reminder(input: DesignTurn): string {
  const lines = ['Before you answer:'];
  if (!input.design) {
    lines.push('- Nothing is drawn yet. End this turn with a <design_move> that draws a first design: usually 4–8 parts with kinds and links. Draft now; any question rides on the draft.');
  }
  if (input.start === 'idea') lines.push('- This is an idea, not a repository: there is nothing to check. Draw it from what they said.');
  if (input.start === 'code') {
    lines.push(
      '- Mark with "today": true every part and link a finding confirms exists.',
      '- Name parts the way a developer designs, not after the classes, modules or settings a finding mentions. Implementation detail belongs in a part\'s detail and refs, not in its name, role or responsibilities. One thing, one part.',
    );
  }
  lines.push('- "within" must name a part you gave "kind":"group".');
  lines.push(
    '- Name a technology only where the developer named it.',
    '- Reply in one to three plain sentences, with no headings or lists. Never describe what you draw; the developer sees it.',
  );
  return lines.join('\n');
}

/**
 * The model as the agent reads it: ids first, grouped the way it is drawn,
 * kind and technology beside the name, today where it differs, what the
 * design removes.
 */
export function renderModel(model: DesignModel): string {
  const lines: string[] = [`Title: ${model.title || '(none)'}`];
  if (model.intent) lines.push(`Intent: ${model.intent}`);
  const parts = live(model.parts);
  const groups = parts.filter((part) => part.kind === 'group');
  const write = (part: DesignPart, indent: string): void => {
    lines.push(`${indent}- ${part.id}: ${describePart(part)}${todayNote(part)}`);
    for (const duty of live(model.duties).filter((candidate) => candidate.part === part.id)) {
      const moved = duty.today && duty.today.part !== duty.part ? ` [exists today, on ${duty.today.part}]` : duty.today ? ' [exists today]' : '';
      lines.push(`${indent}    responsibility ${duty.id}: "${duty.text}"${moved}`);
    }
    if (part.detail) lines.push(`${indent}    detail: ${part.detail.replace(/\n+/g, ' ')}`);
    if (part.refs?.length) lines.push(`${indent}    refs: ${part.refs.join(', ')}`);
  };
  lines.push('Parts:');
  for (const part of parts.filter((candidate) => candidate.kind !== 'group' && !candidate.within)) write(part, '');
  for (const group of groups) {
    write(group, '');
    for (const part of parts.filter((candidate) => candidate.within === group.id)) write(part, '    ');
  }
  const links = live(model.links);
  if (links.length) {
    lines.push('Links:');
    for (const link of links) lines.push(`- ${link.id}${link.label ? ` "${link.label}"` : ''}${link.today ? ' [exists today]' : ''}`);
  }
  const retired = [...model.parts, ...model.links, ...model.duties].filter((element) => element.retired).map((element) => element.id);
  if (retired.length) lines.push(`Exists today but removed by this design: ${retired.join(', ')}`);
  return lines.join('\n');
}

/** `"API" (service, Node.js) — Serves the web app` */
function describePart(part: DesignPart): string {
  const facets = [part.kind, part.technology && part.technology.name !== part.name ? part.technology.name : null].filter(Boolean);
  return `"${part.name}"${facets.length ? ` (${facets.join(', ')})` : ''} — ${part.role || '(no role)'}`;
}

/** Whether a part exists today, and what today has where the design differs. */
function todayNote(part: DesignPart): string {
  const today = part.today;
  if (!today) return '';
  const differs: string[] = [];
  if (today.name !== part.name || today.role !== part.role) differs.push(`as "${today.name}" — ${today.role}`);
  if (today.kind && today.kind !== part.kind) differs.push(`as a ${today.kind}`);
  if (today.technology && today.technology.name !== part.technology?.name) differs.push(`on ${today.technology.name}`);
  return differs.length ? ` [exists today ${differs.join(', ')}]` : ' [exists today]';
}

/**
 * What the developer is pointing at, in full: the subject of their message,
 * not a footnote to it. Several elements selected together are one subject —
 * the question is usually how they relate.
 */
export function renderSelection(focus: DesignFocus | DesignFocus[], model: DesignModel | null): string {
  const all = focusList(focus);
  const header = all.length === 1
    ? 'The developer has selected this. "This", "it" and "here" mean it:'
    : `The developer has selected these ${all.length} elements together. "These", "them", "both" and "here" mean all of them:`;
  return [header, ...all.flatMap((element) => selectedElement(element, model))].join('\n');
}

function selectedElement(focus: DesignFocus, model: DesignModel | null): string[] {
  const lines: string[] = [];
  const name = (id: string): string => model?.parts.find((part) => part.id === id)?.name ?? id;
  if (focus.kind === 'part') {
    const part = model?.parts.find((candidate) => candidate.id === focus.id);
    if (!part || !model) return [`- the part ${focus.label} (id ${focus.id})`];
    lines.push(`- the part ${part.id}: ${describePart(part)}${todayNote(part)}`);
    if (part.within) lines.push(`  within ${name(part.within)} (${part.within})`);
    const members = live(model.parts).filter((candidate) => candidate.within === part.id);
    if (members.length) lines.push(`  holds ${members.map((member) => `${member.name} (${member.id})`).join(', ')}`);
    const links = live(model.links);
    const outgoing = links.filter((link) => link.from === part.id).map((link) => `${name(link.to)}${link.label ? ` "${link.label}"` : ''}`);
    const incoming = links.filter((link) => link.to === part.id).map((link) => `${name(link.from)}${link.label ? ` "${link.label}"` : ''}`);
    if (outgoing.length) lines.push(`  calls or feeds: ${outgoing.join(', ')}`);
    if (incoming.length) lines.push(`  called or fed by: ${incoming.join(', ')}`);
    if (!outgoing.length && !incoming.length) lines.push('  no links yet');
    for (const duty of live(model.duties).filter((candidate) => candidate.part === part.id)) lines.push(`  responsible for "${duty.text}" (${duty.id})`);
    if (part.detail) lines.push(`  your reasoning so far: ${part.detail.replace(/\n+/g, ' ')}`);
  } else if (focus.kind === 'link') {
    const link = model?.links.find((candidate) => candidate.id === focus.id);
    if (!link) return [`- the link ${focus.label} (id ${focus.id})`];
    lines.push(`- the link ${link.id}: ${name(link.from)} → ${name(link.to)}${link.label ? ` "${link.label}"` : ''}${link.today ? ' [exists today]' : ''}`);
  } else {
    const duty = model?.duties.find((candidate) => candidate.id === focus.id);
    if (!duty) return [`- the responsibility ${focus.label} (id ${focus.id})`];
    lines.push(`- the responsibility ${duty.id}: "${duty.text}", held by ${name(duty.part)} (${duty.part})`);
    if (duty.today) lines.push(duty.today.part === duty.part ? '  exists today' : `  exists today on ${name(duty.today.part)} (${duty.today.part})`);
  }
  return lines;
}

/**
 * Vowe glancing at a hand-made move. Silence is the default; a note is for a
 * consequence the developer would want to know about, never a reply.
 */
export const CONSIDER_SYSTEM = `You are Vowe, watching a developer change a system design by hand on a canvas. You do not reply in the conversation and you are not asked a question.

Almost always the right answer is exactly: none

Only when the move leaves something unresolved, or breaks something the design or an earlier finding relied on — a responsibility now sits on a part that cannot hold it, a part lost its only input, something durable now depends on something ephemeral, a part moved out of the boundary that the parts calling it rely on — write one short note, under 20 words, plain, no preamble, anchored to the id of the part, link or responsibility it concerns, as JSON on one line:
{"on":"<id>","text":"<the consequence>"}

Never praise the move, restate it, or offer help.`;

export function renderConsideration(input: DesignConsideration): string {
  const parts = [
    `Project: ${input.projectName}`,
    '', 'The design before the move:', renderModel(input.before),
    '', `The developer's move: ${input.move.summary}`,
    '', 'The design after the move:', renderModel(input.after),
  ];
  const recent = input.conversation.slice(-6);
  if (recent.length) {
    parts.push('', 'Recent conversation:');
    for (const turn of recent) parts.push(`${turn.speaker === 'developer' ? 'Developer' : 'You'}: ${turn.text}`);
  }
  return parts.join('\n');
}

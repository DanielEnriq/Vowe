import type { ContextNavigator } from '../context/context-navigator.js';
import type { ContextRef } from '../context/refs.js';
import type { InvestigationAttachment } from '../llm/observation-llm.js';
import type { InvestigationRecorder } from './investigation-recorder.js';

/**
 * Ceiling, because attachments reach a prompt. A composer that let someone
 * attach forty files would produce a question no model could answer well.
 */
export const MAX_ATTACHMENTS = 4;

/**
 * Open what the developer attached, before anything else is looked at.
 *
 * This is what makes an attachment chip honest. The material is opened here,
 * goes into the prompt as material, and lands in the receipt as the first
 * things checked — so "I attached this" and "Vowe looked at this" are the
 * same claim rather than two hopeful ones. A ref that will not open is
 * skipped rather than failing the question.
 *
 * Shared by Ask and Studio: both put what is on the developer's desk in front
 * of the model the same way.
 */
export async function openAttachments(
  navigator: Pick<ContextNavigator, 'openContext'>,
  refs: readonly ContextRef[] | undefined,
  recorder: InvestigationRecorder,
  onError: (scope: string, error: unknown) => void,
): Promise<InvestigationAttachment[]> {
  if (!refs?.length) return [];

  const opened: InvestigationAttachment[] = [];
  for (const ref of refs.slice(0, MAX_ATTACHMENTS)) {
    try {
      const result = await navigator.openContext({ ref });
      recorder.opened(ref, result);
      opened.push({
        refId: result.refId,
        label: result.kind,
        content: result.notFound ?? result.content,
      });
    } catch (error) {
      // An attachment that cannot be read is not a reason to refuse the
      // question; the answer simply will not be grounded in it.
      onError('attachment', error);
    }
  }
  return opened;
}

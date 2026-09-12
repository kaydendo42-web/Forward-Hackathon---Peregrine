import { z } from 'zod';
import type { Draft, SendReceipt } from '../core/types';

const receiptSchema = z.object({ to: z.string().max(320), messageId: z.string().max(998), sentAt: z.string().max(40) });

export async function sendDraft(draft: Draft, to: string, passcode: string): Promise<SendReceipt> {
  if (!passcode) throw new Error('Enter the demo passcode first.');
  const res = await fetch('/api/send', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-assist-passcode': passcode },
    body: JSON.stringify({ draftId: draft.id, entityId: draft.entityId, to, subject: draft.subject, body: draft.body }),
  });
  const data = await res.json().catch(() => ({})) as { error?: string; receipt?: unknown };
  if (!res.ok) throw new Error(data.error ?? `Sending failed (${res.status}).`);
  return receiptSchema.parse(data.receipt);
}

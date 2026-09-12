import { z } from 'zod';
import type { Draft, InboxMessage, Workspace } from '../core/types';
import { logEvent, recordAnswer } from '../core/workflow';

const messageId = z.string().trim().min(1).max(1000);
export const inboxMessageSchema = z.object({
  messageId, inReplyTo: messageId.nullable(), references: z.array(messageId).max(100),
  from: z.string().email().max(320), date: z.string().datetime(), subject: z.string().max(300),
  text: z.string().max(20_000), textTruncated: z.boolean(),
  attachments: z.array(z.object({ filename: z.string().max(300), size: z.number().int().nonnegative(), contentType: z.string().max(200) })).max(30),
});
export const inboxReceiptSchema = z.object({ messageId, requestId: z.string().min(1).max(1000),
  acceptedAt: z.string().datetime(), answer: z.string().min(1).max(4000) });
export const inboxResponseSchema = z.object({ messages: z.array(inboxMessageSchema).max(50), checkedAt: z.string().datetime() });

function id(value: string) { return value.trim().replace(/^<|>$/g, ''); }

/** A matching thread suggests requests; it never applies the reply or approves evidence. */
export function matchReply(state: Workspace, reply: InboxMessage): Draft | null {
  const sent = state.outbox.filter(d => d.status === 'sent' && d.messageId && d.to?.toLowerCase() === reply.from.toLowerCase());
  const direct = reply.inReplyTo ? sent.filter(d => id(d.messageId!) === id(reply.inReplyTo!)) : [];
  if (direct.length) return direct.length === 1 ? direct[0] : null;
  const references = new Set(reply.references.map(id));
  const related = sent.filter(d => references.has(id(d.messageId!)));
  if (new Set(related.map(d => d.entityId)).size > 1) return null;
  for (const ref of [...reply.references].reverse()) {
    const matches = related.filter(d => id(d.messageId!) === id(ref));
    if (matches.length) return matches.length === 1 ? matches[0] : null;
  }
  return null;
}

export function importReplies(state: Workspace, input: InboxMessage[]): Workspace {
  const messages = z.array(inboxMessageSchema).max(50).parse(input);
  const known = new Set(state.inbox.map(m => id(m.messageId)));
  let next = state;
  for (const message of messages) {
    if (known.has(id(message.messageId))) continue;
    if (next.inbox.length >= 200) throw new Error('This browser demo retains up to 200 replies. Export your work before resetting it.');
    known.add(id(message.messageId));
    next = logEvent({ ...next, inbox: [...next.inbox, message] }, matchReply(next, message)?.entityId ?? 'inbox',
      'inbox_reply_received', `${message.messageId}: reply retained as a proposal; no answer or evidence accepted.`);
  }
  return next;
}

export function acceptReply(state: Workspace, messageId: string, requestId: string, answer: string, manualAssignment = false): Workspace {
  const message = state.inbox.find(m => m.messageId === messageId);
  const request = state.requests.find(r => r.id === requestId);
  if (!message || !request) throw new Error('Select a saved reply and an existing request.');
  const draft = matchReply(state, message);
  if (draft && !draft.requestIds.includes(requestId)) throw new Error('Select a request from the matched sent request email.');
  if (!draft && !manualAssignment) throw new Error('Confirm the manual request assignment for this unmatched reply.');
  if (state.inboxReceipts.some(r => r.messageId === messageId && r.requestId === requestId)) return state;
  const cleaned = z.string().trim().min(1, 'Select or enter the relevant reply text.').max(4000).parse(answer);
  const combined = [request.answer, cleaned].filter(Boolean).join('\n\n');
  if (combined.length > 4000) throw new Error('The existing answer plus this reply exceeds 4,000 characters. Shorten the selected reply text before accepting.');
  if (state.inboxReceipts.length >= 1000) throw new Error('This demo has reached its reply acceptance limit.');
  const next = recordAnswer(state, requestId, combined);
  return logEvent({ ...next, inboxReceipts: [...next.inboxReceipts, { messageId, requestId, answer: cleaned, acceptedAt: new Date().toISOString() }] }, request.entityId,
    'inbox_reply_accepted', `${messageId} → ${requestId}; ${draft ? 'matched sent email' : 'explicit manual assignment'}. Client answer recorded; evidence and adviser review remain separate.`);
}

export async function checkInbox(passcode: string) {
  if (!passcode) throw new Error('Enter the demo passcode first.');
  const response = await fetch('/api/inbox', { method: 'POST', headers: { 'x-assist-passcode': passcode } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : `Inbox check failed (${response.status}).`);
  return inboxResponseSchema.parse(data);
}

import { expect, it } from 'vitest';
import * as flow from '../src/core/workflow';
import { acceptReply, importReplies, matchReply } from '../src/lib/inbox';
import { parseSavedWorkspace } from '../src/lib/storage';
import type { InboxMessage } from '../src/core/types';
import { baseline } from './fixtures';

function sent() {
  const state = flow.queueOutreach(flow.startSeason(flow.importBaseline(flow.createWorkspace(), baseline), baseline.entityId), baseline.entityId, 'initial');
  return flow.markSent(state, state.outbox[0].id, { to: 'family@example.com', messageId: '<out-1@example.com>', sentAt: '2026-09-12T08:00:00.000Z' });
}
const reply: InboxMessage = { messageId: '<reply-1@example.com>', inReplyTo: '<out-1@example.com>', references: [], from: 'family@example.com',
  date: '2026-09-12T09:00:00.000Z', subject: 'Re: FY26', text: 'I opened a new investment account.', attachments: [], textTruncated: false };

it('matches direct replies and reference chains only to sent drafts addressed to that sender', () => {
  const state = sent();
  expect(matchReply(state, reply)?.id).toBe(state.outbox[0].id);
  expect(matchReply(state, { ...reply, inReplyTo: '<later@example.com>', references: ['<out-1@example.com>'] })?.id).toBe(state.outbox[0].id);
  expect(matchReply(state, { ...reply, from: 'someoneelse@example.com' })).toBeNull();
  expect(matchReply({ ...state, outbox: [{ ...state.outbox[0], status: 'draft' }] }, reply)).toBeNull();
});

it('keeps unrelated and ambiguous messages unmatched', () => {
  const state = sent();
  expect(matchReply(state, { ...reply, inReplyTo: null })).toBeNull();
  const other = { ...state.outbox[0], id: 'other', entityId: 'sam-taylor' };
  expect(matchReply({ ...state, outbox: [...state.outbox, other] }, reply)).toBeNull();
});

it('imports proposals without changing answers, deduplicates polling, and retains accepted provenance across reload', () => {
  const state = sent();
  const proposed = importReplies(state, [reply, reply]);
  expect(proposed.inbox).toHaveLength(1);
  expect(proposed.requests.every(r => r.answer === '')).toBe(true);
  expect(importReplies(proposed, [reply])).toBe(proposed);
  const id = proposed.requests.find(r => r.lineId === 'CHANGES')!.id;
  const accepted = acceptReply(proposed, reply.messageId, id, reply.text);
  expect(accepted.requests.find(r => r.id === id)?.answer).toBe(reply.text);
  expect(accepted.requests.find(r => r.id === id)?.review).toBe('pending');
  expect(accepted.inboxReceipts[0]).toMatchObject({ messageId: reply.messageId, requestId: id, answer: reply.text });
  expect(accepted.audit.at(-1)?.action).toBe('inbox_reply_accepted');
  const restored = parseSavedWorkspace(JSON.stringify(accepted));
  expect(acceptReply(restored, reply.messageId, id, reply.text)).toBe(restored);
});

it('requires explicit manual assignment for unmatched mail and prevents cross-entity acceptance of matched replies', () => {
  let state = sent();
  state = flow.startSeason(flow.importBaseline(state, { ...baseline, workbookId: 'FY25-sam-taylor', entityId: 'sam-taylor', entityName: 'Sam Taylor' }), 'sam-taylor');
  state = importReplies(state, [reply, { ...reply, messageId: '<unmatched@example.com>', inReplyTo: null }]);
  const samId = state.requests.find(r => r.entityId === 'sam-taylor')!.id;
  expect(() => acceptReply(state, reply.messageId, samId, reply.text)).toThrow(/sent request/);
  expect(() => acceptReply(state, '<unmatched@example.com>', samId, reply.text)).toThrow(/manual/);
  expect(acceptReply(state, '<unmatched@example.com>', samId, reply.text, true).requests.find(r => r.id === samId)?.answer).toBe(reply.text);
});

it('appends to an existing answer, reopens review and supersedes pending reminders without marking evidence accepted', () => {
  let state = importReplies(sent(), [reply]);
  const id = state.requests[0].id;
  state = flow.recordAnswer(state, id, 'Existing answer.');
  state = flow.reviewRequest(state, id, 'follow_up', 'Please clarify.');
  state = flow.queueOutreach(state, baseline.entityId, 'reminder');
  const accepted = acceptReply(state, reply.messageId, id, 'New clarification.');
  expect(accepted.requests[0].answer).toBe('Existing answer.\n\nNew clarification.');
  expect(accepted.requests[0].review).toBe('pending');
  expect(accepted.requests[0].evidence).toHaveLength(0);
  expect(accepted.outbox.at(-1)?.status).toBe('superseded');
  expect(() => acceptReply(state, reply.messageId, id, 'x'.repeat(4001))).toThrow();
});

it('migrates old saved workspaces and rejects malformed inbound records', () => {
  const { inbox, inboxReceipts, ...legacy } = sent();
  expect(parseSavedWorkspace(JSON.stringify(legacy))).toMatchObject({ inbox: [], inboxReceipts: [] });
  expect(() => importReplies(sent(), [{ ...reply, from: 'bad' }])).toThrow();
});

'use client';

import { useState } from 'react';
import type { InboxMessage, Workspace } from '../core/types';
import { acceptReply, matchReply } from '../lib/inbox';
import { readPasscode, storePasscode } from '../lib/assist-client';

type Props = { state: Workspace; entityId: string; busy: boolean;
  act: (operation: (s: Workspace) => Workspace, success?: string) => void;
  check: (passcode: string) => void; openRequest: (id: string) => void };

function ReplyCard({ message, state, entityId, busy, act, openRequest }: Omit<Props, 'check'> & { message: InboxMessage }) {
  const draft = matchReply(state, message);
  const requests = state.requests.filter(r => draft ? draft.requestIds.includes(r.id) : r.entityId === entityId);
  const suggested = draft ? requests.find(r => r.lineId === 'CHANGES') ?? requests[0] : undefined;
  const [requestId, setRequestId] = useState(suggested?.id ?? '');
  const [answer, setAnswer] = useState(message.text.length <= 4000 ? message.text : '');
  const [manual, setManual] = useState(false);
  const request = requests.find(r => r.id === requestId);
  const accepted = state.inboxReceipts.some(r => r.messageId === message.messageId && r.requestId === requestId);
  const entityName = state.baselines.find(b => b.entityId === entityId)?.entityName ?? entityId;

  return <article className="draft inbox-reply" data-testid="inbox-reply">
    <h3>{message.subject || '(No subject)'}</h3>
    <p>{message.from} · {new Date(message.date).toLocaleString('en-AU')}</p>
    <p className="hint">{draft ? `Matched to: ${draft.subject}. Choose the request this reply answers.` : `Unmatched reply. Confirm it belongs to ${entityName} before assigning it.`}</p>
    <details><summary>Original email text and reference</summary><p className="hint">{message.messageId}</p><pre>{message.text || 'No plain-text body available. Read the original email in the firm mailbox.'}</pre></details>
    {message.textTruncated && <p className="callout">Only part of this email was retrieved. Read the complete email in the firm mailbox before accepting an answer.</p>}
    {!!message.attachments.length && <div><strong>Attachments listed only</strong><ul>{message.attachments.map((a, i) => <li key={i}>{a.filename || '(Unnamed attachment)'} · {a.contentType} · {a.size.toLocaleString()} bytes</li>)}</ul><p className="hint">Attachment contents have not been downloaded or accepted. Save a CSV from the firm mailbox and upload it under its request; statement text can be pasted into AI assist for a proposal.</p></div>}
    <label>Assign reply to request<select value={requestId} disabled={busy} onChange={e => { setRequestId(e.target.value); setManual(false); }}>
      <option value="">Select a request</option>{requests.map(r => <option key={r.id} value={r.id}>{r.label} · FY{r.financialYear}</option>)}
    </select></label>
    {request?.answer && <details><summary>Existing client answer (will be kept)</summary><pre>{request.answer}</pre></details>}
    {accepted ? <p className="notice" data-testid="reply-accepted">Already accepted for this request.</p> : <>
      <label>Reply text to accept<textarea value={answer} onChange={e => setAnswer(e.target.value)} maxLength={4000} disabled={busy}
        placeholder="Select the relevant reply text. Exclude quoted old emails and signatures." /></label>
      <p className="hint">Check the proposed text and remove quoted history. Acceptance appends a client answer and reopens adviser review; it does not accept supporting evidence.</p>
      {!draft && <label className="toggle"><input type="checkbox" checked={manual} disabled={busy || !request} onChange={e => setManual(e.target.checked)} />I confirm this reply belongs to {entityName} and the selected request.</label>}
      <button disabled={busy || !request || !answer.trim() || (!draft && !manual)} onClick={() => act(s => acceptReply(s, message.messageId, requestId, answer, manual), 'Reply accepted as a client answer. Evidence and adviser review are still required.')}>Accept reply as answer</button>
    </>}
    {request && <button className="text-button" disabled={busy} onClick={() => openRequest(requestId)}>Open request and AI assist</button>}
  </article>;
}

export function InboxPanel(props: Props) {
  const [passcode, setPasscode] = useState(readPasscode);
  const messages = props.state.inbox.filter(m => { const draft = matchReply(props.state, m); return !draft || draft.entityId === props.entityId; });
  return <section aria-label="Family replies">
    <h2>Family replies</h2>
    <p>Check the firm mailbox for replies from allowed demo clients in the last 30 days. The latest 50 are retrieved on demand. Matched replies appear under their entity; unmatched mail needs manual assignment.</p>
    <label>Inbox passcode<input type="password" autoComplete="off" value={passcode} onChange={e => { setPasscode(e.target.value); storePasscode(e.target.value); }} /></label>
    <button disabled={props.busy} onClick={() => props.check(passcode)}>Check inbox</button>
    <p className="hint">Replies are proposals saved in this browser. Polling never marks mail read, deletes it, or changes client answers. Attachment contents are not retrieved.</p>
    {!messages.length && <p className="empty">No replies saved for this entity. Send a draft from the Outbox, reply from the family mailbox, then check here.</p>}
    {[...messages].sort((a, b) => Date.parse(b.date) - Date.parse(a.date)).map(message => <ReplyCard key={`${props.entityId}:${message.messageId}`} {...props} message={message} />)}
  </section>;
}

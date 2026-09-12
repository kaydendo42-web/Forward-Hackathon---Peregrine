'use client';

import { useState } from 'react';
import type { Draft, Workspace } from '../core/types';
import * as flow from '../core/workflow';
import { readPasscode, storePasscode } from '../lib/assist-client';
import { familyInbox } from '../lib/samples';
import { sendDraft } from '../lib/send-client';

type Props = { draft: Draft; busy: boolean; act: (operation: (s: Workspace) => Workspace, success?: string) => void };

export function SendDraft({ draft, busy, act }: Props) {
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState(familyInbox);
  const [passcode, setPasscode] = useState(readPasscode);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);

  async function send() {
    setSending(true); setError('');
    try {
      const receipt = await sendDraft(draft, to.trim(), passcode);
      act(s => flow.markSent(s, draft.id, receipt), `Emailed ${receipt.to}. Reply handling is not connected; check the inbox manually.`);
      setOpen(false);
    } catch (e) { setError(e instanceof Error ? e.message : 'Sending failed.'); }
    finally { setSending(false); }
  }

  if (draft.status !== 'draft') return null;
  if (!open) return <button type="button" disabled={busy} onClick={() => setOpen(true)}>Send to family (demo)</button>;
  return <div className="send-confirm" role="group" aria-label="Confirm send">
    <p><strong>Send this email now?</strong> The recipient must be on the server's verified list. Synthetic data only.</p>
    <label>Recipient<input type="email" value={to} onChange={e => setTo(e.target.value)} required /></label>
    <label>Demo passcode<input type="password" autoComplete="off" value={passcode} onChange={e => { setPasscode(e.target.value); storePasscode(e.target.value); }} /></label>
    {error && <p className="error" role="alert" data-testid="send-error">{error}</p>}
    <div className="button-row"><button type="button" disabled={busy || sending} onClick={() => void send()}>{sending ? 'Sending…' : 'Confirm and send'}</button><button type="button" className="text-button" onClick={() => setOpen(false)}>Cancel</button></div>
  </div>;
}

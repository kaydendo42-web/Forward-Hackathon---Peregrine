'use client';

import { useState } from 'react';
import type { Draft } from '../core/types';
import { readPasscode, storePasscode } from '../lib/assist-client';
import { familyInbox } from '../lib/samples';

type Props = { draft: Draft; busy: boolean; send: (draftId: string, to: string, passcode: string) => Promise<void> };

export function SendDraft({ draft, busy, send: sendEmail }: Props) {
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState(familyInbox);
  const [passcode, setPasscode] = useState(readPasscode);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);

  async function send() {
    setSending(true); setError('');
    try {
      await sendEmail(draft.id, to.trim(), passcode);
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
    <div className="button-row"><button type="button" disabled={busy || sending} onClick={() => void send()}>{sending ? 'Sending…' : 'Confirm and send'}</button><button type="button" className="text-button" disabled={sending} onClick={() => setOpen(false)}>Cancel</button></div>
  </div>;
}

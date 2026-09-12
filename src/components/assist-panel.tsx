'use client';

import { useState } from 'react';
import type { Baseline, CollectionRequest, Workspace } from '../core/types';
import { applyProposalItem, buildContext, type AssistTask, type Proposal } from '../lib/assist';
import { readPasscode, requestProposal, storePasscode } from '../lib/assist-client';
import { parseMoney } from '../lib/evidence';
import { money } from '../lib/format';
import { sha256 } from '../lib/storage';

type Props = { request: CollectionRequest; baseline: Baseline; busy: boolean;
  act: (operation: (s: Workspace) => Workspace, success?: string) => void };

const LABELS: Record<AssistTask, string> = {
  follow_up: 'Propose follow-up wording', reword: 'Propose reworded question', extract: 'Extract from pasted text', triage: 'Triage reported changes',
};

function ItemView({ item }: { item: Proposal['items'][number] }) {
  if ('text' in item) return <p>{item.text}</p>;
  if ('question' in item) return <p>{item.question}</p>;
  if ('documentId' in item) return <p><strong>{item.documentId}</strong> · {money(parseMoney(item.amount))}<br />{item.description}{item.quote && <><br /><q>{item.quote}</q></>}</p>;
  return <p><strong>{item.label}</strong><br />{item.note}</p>;
}

export function AssistPanel({ request, baseline, busy, act }: Props) {
  const [passcode, setPasscode] = useState(readPasscode);
  const [text, setText] = useState('');
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [error, setError] = useState('');
  const [working, setWorking] = useState<AssistTask | null>(null);
  const isChanges = request.lineId === 'CHANGES';
  const tasks: AssistTask[] = isChanges ? ['triage', 'follow_up'] : request.component === 'document' ? ['follow_up', 'reword'] : ['follow_up', 'reword', 'extract'];

  async function propose(task: AssistTask) {
    setError(''); setWorking(task);
    try {
      const source = task === 'extract' ? text : task === 'triage' ? request.answer : undefined;
      if (task === 'extract' && !text.trim()) throw new Error('Paste the statement text first.');
      if (task === 'triage' && !request.answer) throw new Error("Record the client's answer to the changes question first.");
      const next = await requestProposal(task, buildContext(request, baseline, source), passcode);
      if (task === 'extract') { const bytes = new TextEncoder().encode(text); next.sourceHash = await sha256(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer); }
      setProposal(next);
    } catch (e) { setError(e instanceof Error ? e.message : 'AI assist failed.'); }
    finally { setWorking(null); }
  }
  function accept(index: number) {
    if (!proposal) return;
    const current = proposal;
    act(s => applyProposalItem(s, request, current, index), 'Proposal accepted and recorded. Adviser review still applies.');
    setProposal({ ...current, items: current.items.filter((_, i) => i !== index) });
  }
  function dismiss(index: number) {
    if (proposal) setProposal({ ...proposal, items: proposal.items.filter((_, i) => i !== index) });
  }

  return <section className="assist-panel" aria-label="AI assist">
    <h3>AI assist (proposals only)</h3>
    <p className="hint">Proposals from the configured NIM model. Nothing is applied until you accept it; every acceptance is recorded with the model and prompt version. Synthetic data only.</p>
    <label>AI passcode<input type="password" autoComplete="off" value={passcode} onChange={e => { setPasscode(e.target.value); storePasscode(e.target.value); }} placeholder="Shared demo passcode" /></label>
    {tasks.includes('extract') && <label>Statement text to extract from<textarea value={text} onChange={e => setText(e.target.value)} maxLength={20000} placeholder="Paste the text of a synthetic dividend or bank statement. Rows are proposed for this request only." /></label>}
    <div className="button-row">{tasks.map(task => <button key={task} type="button" disabled={busy || working !== null} onClick={() => void propose(task)}>{working === task ? 'Asking model…' : LABELS[task]}</button>)}</div>
    {error && <p className="error" role="alert" data-testid="assist-error">{error}</p>}
    {proposal && <div className="proposal">
      <p className="hint">{LABELS[proposal.task]} · {proposal.model} · {proposal.promptVersion} · {proposal.items.length === 0 ? 'no remaining items' : `${proposal.items.length} item${proposal.items.length === 1 ? '' : 's'}`}</p>
      {proposal.items.map((item, i) => <div className="proposal-item" key={i} data-testid="proposal-item">
        <ItemView item={item} />
        {'basis' in item && item.basis.length > 0 && <small>Basis: {item.basis.map(b => `“${b}”`).join(' · ')}</small>}
        <div className="button-row"><button type="button" disabled={busy} onClick={() => accept(i)}>Accept proposal</button><button type="button" className="text-button" onClick={() => dismiss(i)}>Dismiss</button></div>
      </div>)}
      <button type="button" className="text-button" onClick={() => setProposal(null)}>Clear proposals</button>
    </div>}
  </section>;
}

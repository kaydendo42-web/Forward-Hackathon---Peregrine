'use client';

import type { CollectionRequest, EvidenceInput, Workspace } from '../core/types';
import * as flow from '../core/workflow';
import { parseMoney } from '../lib/evidence';
import { money } from '../lib/format';

type Props = { request: CollectionRequest; clientView: boolean; busy: boolean;
  act: (operation: (s: Workspace) => Workspace, success?: string) => void;
  upload: (file: File) => void; openOriginal: (evidence: EvidenceInput) => void };

export function RequestPanel({ request, clientView, busy, act, upload, openOriginal }: Props) {
  const comparison = flow.reconcile(request);
  return <section className="request-detail" aria-label="Selected request">
    <div className="detail-heading"><h2>{request.label}</h2><span className="status" data-testid="selected-status">{flow.collectionStatus(request)}</span></div>
    <p className="question">{request.question}</p>
    {!clientView && <details open><summary>Why are we asking?</summary><p>{request.reason}</p><small>{request.methodVersion} · {request.lineId} · FY{request.financialYear} · {request.currency} · {request.basis}</small></details>}
    {!clientView && request.component !== 'document' && <div className="reconciliation">
      <dl><div><dt>FY25 comparative only</dt><dd>{money(request.priorAmountCents)}</dd></div><div><dt>FY26 evidence</dt><dd>{money(comparison.evidenceCents)}</dd></div><div><dt>Comparison less evidence</dt><dd data-testid="difference" className={comparison.differenceCents !== null && comparison.differenceCents !== 0 ? 'difference' : ''}>{comparison.differenceCents === null ? 'No comparison yet' : money(comparison.differenceCents)}</dd></div></dl>
      <form onSubmit={e => { e.preventDefault(); const raw = String(new FormData(e.currentTarget).get('amount')); act(s => flow.setComparison(s, request.id, parseMoney(raw)), 'FY26 comparison saved.'); }}>
        <label>FY26 comparison amount (AUD)<input name="amount" inputMode="decimal" defaultValue={request.comparisonCents === null ? '' : String(request.comparisonCents / 100)} placeholder="e.g. 5200.00" /></label>
        <p className="hint">Manually entered demo comparison. Match the same period, owner and amount component. This is not a live Xero import.</p>
        <button disabled={busy}>Save comparison</button>
      </form>
    </div>}
    <div className="evidence-section"><h3>Supporting evidence</h3><label>Evidence CSV<input disabled={busy} type="file" accept=".csv" onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) upload(file); }} /></label>
      <p className="hint">Use the structured CSV samples in Files. This upload is for {request.lineId}, FY{request.financialYear}, {request.component.replaceAll('_', ' ')}. PDF extraction is not connected.</p>
      {request.evidence.length === 0 && <p className="empty">No evidence linked yet.</p>}
      {request.evidence.map(e => <div className="evidence-item" key={e.documentId}><strong>{e.documentId}</strong><span>{money(e.amountCents)}</span><p>{e.description}</p><button className="text-button" disabled={busy} onClick={() => openOriginal(e)}>Download original {e.filename}</button><small title={e.fileHash}>SHA-256: {e.fileHash.slice(0, 16)}…</small></div>)}
    </div>
    <form className="answer-form" onSubmit={e => { e.preventDefault(); const answer = String(new FormData(e.currentTarget).get('answer')); act(s => flow.recordAnswer(s, request.id, answer), 'Client answer recorded. Chasers wait for adviser review.'); }}>
      <label>Client answer / availability<textarea name="answer" required maxLength={4000} defaultValue={request.answer} placeholder="Tell the adviser if this no longer applies or when the document will be available." /></label><button disabled={busy}>Record client answer</button>
    </form>
    {!clientView && <form className="adviser-form" onSubmit={e => { e.preventDefault(); const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement; const note = String(new FormData(e.currentTarget).get('note')); act(s => flow.reviewRequest(s, request.id, submitter.value as 'accepted' | 'not_applicable' | 'follow_up', note), 'Simulated adviser decision recorded.'); }}>
      <h3>Adviser decision</h3><p className="hint">A matched total still needs review. An unresolved difference cannot be accepted.</p><label>Review note<textarea name="note" required maxLength={4000} defaultValue={request.reviewNote} /></label>
      <div className="button-row"><button disabled={busy} value="accepted">Accept evidence for demo</button><button disabled={busy} value="not_applicable">Mark not applicable</button><button disabled={busy} value="follow_up">Request follow-up</button></div>
      <label className="toggle"><input type="checkbox" checked={request.paused} onChange={e => act(s => flow.pauseRequest(s, request.id, e.target.checked))} disabled={busy} /> Pause reminders for this request</label>
    </form>}
  </section>;
}

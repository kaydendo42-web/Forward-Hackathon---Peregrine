'use client';

import { useEffect, useState } from 'react';
import type { IntakeProposal, Workspace } from '../core/types';
import { applyIntakeDocument, linkedRequestFor, rejectIntakeProposal } from '../lib/intake';
import { readOriginal } from '../lib/storage';
import { money } from '../lib/format';

type Props = { state: Workspace; proposal: IntakeProposal; busy: boolean;
  act: (operation: (s: Workspace) => Workspace, success?: string) => void; openRequest: (id: string) => void };

function Thumbnail({ hash, contentType, filename }: { hash: string; contentType: string; filename: string }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!contentType.startsWith('image/')) return;
    let revoke = '';
    readOriginal(hash).then(bytes => { revoke = URL.createObjectURL(new Blob([bytes], { type: contentType })); setUrl(revoke); }).catch(() => setUrl(''));
    return () => { if (revoke) URL.revokeObjectURL(revoke); };
  }, [hash, contentType]);
  if (!contentType.startsWith('image/')) return <p className="hint">PDF — text extracted, no preview.</p>;
  return url ? <img className="intake-thumb" src={url} alt={`Attachment ${filename}`} /> : <p className="hint">Preview unavailable in this browser.</p>;
}

function DocumentReview({ state, proposal, index, busy, act, openRequest }: Props & { index: number }) {
  const doc = proposal.documents[index];
  const entities = state.baselines;
  const [entityId, setEntityId] = useState(doc.proposedEntityId || entities[0]?.entityId || '');
  const requests = state.requests.filter(r => r.entityId === entityId && r.review === 'pending' && !r.paused);
  const [requestId, setRequestId] = useState(doc.flags.targetValid ? doc.proposedRequestId : '');
  const [amountIndex, setAmountIndex] = useState(doc.amounts.findIndex(a => a.amountCents !== null));
  const [manual, setManual] = useState('');
  const [description, setDescription] = useState([doc.docType, doc.entityNameSeen, [doc.periodStart, doc.periodEnd].filter(Boolean).join(' – ')].filter(Boolean).join(' — '));
  const linked = linkedRequestFor(state, proposal, index);
  const override = requestId !== doc.proposedRequestId;
  const blocked = (doc.flags.nameMatch === 'mismatch' || !doc.flags.targetValid) && !override;
  const amountCents = manual.trim() ? Math.round(Number(manual) * 100) : amountIndex >= 0 ? doc.amounts[amountIndex].amountCents : null;
  const badAmount = manual.trim() !== '' && !/^-?\d+(\.\d{1,2})?$/.test(manual.trim());
  const flags = [
    doc.flags.nameMatch === 'mismatch' && `Name mismatch: "${doc.entityNameSeen || '(none read)'}" is not an entity in this family.`,
    doc.flags.nameMatch === 'partial' && `Partial name match: "${doc.entityNameSeen}".`,
    !doc.flags.periodInYear && `Period outside FY2026: ${doc.periodStart} – ${doc.periodEnd}.`,
    doc.flags.syntheticMarker && 'Synthetic marker seen on the document.',
    !doc.flags.targetValid && 'Proposed request is missing, closed, or belongs to another entity.',
  ].filter((f): f is string => Boolean(f));

  return <div className="intake-document" data-testid="intake-document">
    <h4>Document {index + 1}: {doc.docType || 'Unlabelled'} <small>({doc.confidence} confidence)</small></h4>
    <dl className="intake-facts"><dt>Entity seen</dt><dd>{doc.entityNameSeen || '—'}</dd><dt>Period seen</dt><dd>{[doc.periodStart, doc.periodEnd].filter(Boolean).join(' – ') || '—'}</dd><dt>Model&apos;s reason</dt><dd>{doc.reason || '—'}</dd></dl>
    {!!doc.amounts.length && <table className="intake-amounts"><thead><tr><th>Figure read</th><th>Amount</th></tr></thead><tbody>
      {doc.amounts.map((a, i) => <tr key={i}><td>{a.label || '(no label)'}</td><td>{a.amountCents === null ? 'unreadable' : money(a.amountCents)}</td></tr>)}</tbody></table>}
    {flags.map(f => <p key={f} className="callout intake-flag">{f}</p>)}
    {linked ? <p className="notice" data-testid="intake-linked">Linked to {linked.label} as evidence. <button className="text-button" onClick={() => openRequest(linked.id)}>Open request</button></p> : proposal.review.status === 'rejected' ? <p className="hint">Proposal rejected{proposal.review.note ? `: ${proposal.review.note}` : '.'}</p> : <>
      <label>Entity<select value={entityId} disabled={busy} onChange={e => { setEntityId(e.target.value); setRequestId(''); }}>
        {entities.map(b => <option key={b.entityId} value={b.entityId}>{b.entityName}</option>)}</select></label>
      <label>Request line<select value={requestId} disabled={busy} onChange={e => setRequestId(e.target.value)}>
        <option value="">Select a request</option>{requests.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}</select></label>
      <label>Figure to record<select value={amountIndex} disabled={busy} onChange={e => { setAmountIndex(Number(e.target.value)); setManual(''); }}>
        <option value={-1}>No amount (document only)</option>{doc.amounts.map((a, i) => <option key={i} value={i} disabled={a.amountCents === null}>{a.label}: {a.amountCents === null ? 'unreadable' : money(a.amountCents)}</option>)}</select></label>
      <label>Or type the amount (AUD)<input inputMode="decimal" value={manual} disabled={busy} onChange={e => setManual(e.target.value)} placeholder="e.g. 108125.00" /></label>
      {badAmount && <p className="error">Enter a number with up to two decimal places.</p>}
      <label>Evidence description<input value={description} disabled={busy} maxLength={4000} onChange={e => setDescription(e.target.value)} /></label>
      <p className="hint">Check the figure against the preview. Accepting links this file as evidence; adviser review of the request is still separate.</p>
      <div className="button-row">
        <button disabled={busy || blocked || !requestId || badAmount || !description.trim()} onClick={() => act(s => applyIntakeDocument(s, proposal.id, index, { requestId, amountCents, description }), 'Attachment linked as evidence. Adviser review is still required.')}>
          {override ? 'Accept with adviser override' : 'Accept as evidence'}</button>
        <button className="text-button" disabled={busy} onClick={() => act(s => rejectIntakeProposal(s, proposal.id, ''), 'Proposal rejected. The file stays in this browser.')}>Reject</button>
      </div>
      {blocked && <p className="hint">Change the entity or request to accept this document; the model&apos;s target could not be verified.</p>}
    </>}
  </div>;
}

export function IntakeReview(props: Props) {
  const { proposal } = props;
  return <section className="intake-proposal" aria-label={`Attachment ${proposal.filename}`} data-testid="intake-proposal">
    <h3>{proposal.filename} <small>· {proposal.contentType} · {proposal.size.toLocaleString()} bytes · {proposal.source === 'image' ? 'photo read' : 'PDF text read'} · {proposal.review.status}</small></h3>
    <p className="hint">Model {proposal.model}, prompt {proposal.promptVersion}, sha256 {proposal.fileHash.slice(0, 16)}…</p>
    <Thumbnail hash={proposal.fileHash} contentType={proposal.contentType} filename={proposal.filename} />
    {!proposal.documents.length && <p className="callout">The model found no document it could describe. Assign this file manually from the firm mailbox.</p>}
    {proposal.documents.map((_, i) => <DocumentReview key={i} {...props} index={i} />)}
  </section>;
}

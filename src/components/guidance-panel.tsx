'use client';

import { useState } from 'react';
import { z } from 'zod';
import type { BaselineLine, GuidanceProposal, Workspace } from '../core/types';
import { METHOD_VERSION } from '../core/workflow';
import {
  addGuidanceProposals, applyGuidanceProposal, GUIDANCE_METHOD_VERSION,
  guidanceProposalSchema, guidanceSourceSchema, rejectGuidanceProposal, type GuidanceSource,
} from '../lib/guidance';
import { readPasscode, storePasscode } from '../lib/assist-client';

// Adviser review gate for guidance proposals. Nothing here changes a request: accepting
// rewrites one baseline line's wording for the NEXT season, and rejecting changes
// nothing at all. Both decisions are written to the activity record.

type Props = {
  state: Workspace; entityId: string; busy: boolean;
  act: (operation: (s: Workspace) => Workspace, success?: string) => void;
};

const fileSchema = z.array(guidanceProposalSchema).min(1).max(50);
const sourcesSchema = z.object({
  sources: z.array(guidanceSourceSchema).max(200),
  scoringMode: z.string().max(40), builtAt: z.string().max(40),
});

function when(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toLocaleString('en-AU');
}

function Provenance({ proposal, source }: { proposal: GuidanceProposal; source?: GuidanceSource }) {
  return <>
    {proposal.sourceStatus === 'synthetic_fixture' && <p className="callout" data-testid="synthetic-badge">
      <strong>SYNTHETIC TEST FIXTURE.</strong> This source was written for this demonstration. It is not ATO
      material, states no real rule, and must never be described as one.
    </p>}
    <dl>
      <div><dt>Source</dt><dd>{source?.title ?? proposal.sourceId}</dd></div>
      <div><dt>Link</dt><dd>{source?.url
        ? <a href={source.url} target="_blank" rel="noreferrer noopener">{source.url}</a>
        : 'No URL — this source is not a published page.'}</dd></div>
      <div><dt>Source status</dt><dd>{proposal.sourceStatus.replaceAll('_', ' ')}</dd></div>
      <div><dt>Retrieved</dt><dd>{when(proposal.retrievedAt)}</dd></div>
      <div><dt>Page date</dt><dd>{source?.publishedDate ? when(source.publishedDate) : 'Not stated by the source'}</dd></div>
      <div><dt>Applies to</dt><dd>{proposal.appliesToEntityTypes.join(', ')} · FY{proposal.appliesToYears.join(', FY')}</dd></div>
      <div><dt>Proposed by</dt><dd>{proposal.model} · {proposal.promptVersion} · {when(proposal.createdAt)}</dd></div>
    </dl>
    <small>Source hash (SHA-256 of the retrieved text): {proposal.sourceHash}</small>
  </>;
}

export function GuidancePanel({ state, entityId, busy, act }: Props) {
  const [passcode, setPasscode] = useState(readPasscode);
  const [reviewer, setReviewer] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [checking, setChecking] = useState('');
  const [lineId, setLineId] = useState('');
  const [sources, setSources] = useState<GuidanceSource[]>([]);

  const baseline = state.baselines.find(entry => entry.entityId === entityId);
  const lines = baseline?.lines ?? [];
  const mine = (state.guidance ?? []).filter(proposal => lines.some(line => line.id === proposal.lineId));
  const pending = mine.filter(proposal => proposal.review.status === 'pending');
  const decided = mine.filter(proposal => proposal.review.status !== 'pending');
  const changed = lines.filter(line => line.methodVersion === GUIDANCE_METHOD_VERSION);
  const sourceFor = (proposal: GuidanceProposal) => sources.find(source => source.id === proposal.sourceId);

  async function loadRegister(code: string) {
    if (!code) return;
    try {
      const res = await fetch('/api/guidance', { headers: { 'x-assist-passcode': code } });
      if (!res.ok) return;
      setSources(sourcesSchema.parse(await res.json()).sources);
    } catch { /* provenance still shows the source id, hash and status without it */ }
  }

  async function loadFile(file: File) {
    setError(''); setNotice('');
    try {
      if (file.size > 500_000) throw new Error('That file is larger than the 500 KB proposal limit.');
      const proposals = fileSchema.parse(JSON.parse(await file.text()));
      act(s => addGuidanceProposals(s, proposals, `uploaded file ${file.name}`),
        `${proposals.length} proposal(s) recorded for review. Nothing has been applied.`);
      void loadRegister(passcode);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That file is not a guidance proposal file.');
    }
  }

  async function check(line: BaselineLine) {
    if (!passcode) { setError('Enter the AI assist passcode first.'); return; }
    if (!baseline) return;
    setError(''); setNotice(''); setChecking(line.id);
    try {
      const res = await fetch('/api/guidance', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-assist-passcode': passcode },
        body: JSON.stringify({
          line: {
            lineId: line.id, entityType: baseline.entityType, category: line.category,
            label: line.label, component: line.component, basis: line.basis, currentText: line.requestText,
          },
        }),
      });
      const data = await res.json().catch(() => ({})) as { error?: string; proposal?: { items?: unknown; dropped?: number } };
      if (!res.ok) throw new Error(data.error ?? `The guidance agent failed (${res.status}).`);
      const items = z.array(guidanceProposalSchema).max(5).parse(data.proposal?.items ?? []);
      const dropped = data.proposal?.dropped ?? 0;
      if (!items.length) {
        setNotice(`No change proposed for ${line.id}. ${dropped ? `${dropped} item(s) were discarded because their quote was not found in the cited source.` : 'The guidance retrieved does not support a change.'}`);
      } else {
        act(s => addGuidanceProposals(s, items, `live check of ${line.id}`),
          `${items.length} proposal(s) recorded for review${dropped ? `; ${dropped} discarded as unverified` : ''}. Nothing has been applied.`);
        void loadRegister(passcode);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The guidance agent failed.');
    } finally { setChecking(''); }
  }

  if (!baseline) return <section aria-label="Guidance updates"><h2>Guidance updates</h2>
    <p className="empty">Import this entity&rsquo;s FY25 baseline first. Guidance proposals change request wording, so there must be a baseline to change.</p>
  </section>;

  return <section aria-label="Guidance updates">
    <div className="section-heading"><div>
      <h2>Guidance updates for {baseline.entityName}</h2>
      <p>
        Proposed changes to the wording of recurring requests, each traced to a quoted source passage. A proposal
        whose quote was not found in its source is discarded before it reaches this screen. Synthetic demonstration
        data, held in this browser only. Accepting a proposal is a wording change, not tax advice, and no proposal is
        applied until you accept it here.
      </p>
    </div></div>

    <p className="hint">
      Current wording method: {METHOD_VERSION}. An accepted proposal advances that one line to {GUIDANCE_METHOD_VERSION}
      {changed.length > 0 && <> — already advanced: {changed.map(line => line.id).join(', ')}</>}.
      Existing FY2026 requests keep the wording they were created with; a change takes effect the next time requests are generated.
    </p>

    <label>AI passcode
      <input type="password" autoComplete="off" value={passcode} placeholder="Shared demo passcode"
        onChange={e => { setPasscode(e.target.value); storePasscode(e.target.value); void loadRegister(e.target.value); }} />
    </label>
    <label>Reviewer (recorded as typed; this demo has no authentication)
      <input value={reviewer} maxLength={200} placeholder="Adviser initials" onChange={e => setReviewer(e.target.value)} />
    </label>

    <div className="button-row">
      <label className="file-button">Load proposals from a sweep
        <input type="file" accept=".json" aria-label="Guidance proposals file" disabled={busy}
          onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void loadFile(file); }} />
      </label>
      <select aria-label="Baseline line to check" value={lineId} onChange={e => setLineId(e.target.value)}>
        <option value="">Select a line to check…</option>
        {lines.map(line => <option key={line.id} value={line.id}>{line.id} — {line.label}</option>)}
      </select>
      <button type="button" disabled={busy || !lineId || checking !== ''}
        onClick={() => { const line = lines.find(entry => entry.id === lineId); if (line) void check(line); }}>
        {checking ? 'Asking the model…' : 'Check this line against guidance'}
      </button>
    </div>
    <p className="hint">Checking calls the configured model once for the selected line. Without configuration the route answers 503 and nothing changes.</p>

    {error && <p className="error" role="alert" data-testid="guidance-error">{error}</p>}
    {notice && <p className="notice" data-testid="guidance-notice">{notice}</p>}

    <h3>Pending review ({pending.length})</h3>
    {pending.length === 0 && <p className="empty">No proposals are waiting. Load a sweep file, or check a line above.</p>}
    {pending.map(proposal => <article className="proposal-item" key={`${proposal.lineId}|${proposal.sourceId}|${proposal.createdAt}`} data-testid="guidance-proposal">
      <h4>{proposal.lineId}</h4>
      <table>
        <thead><tr><th scope="col">Current request wording</th><th scope="col">Proposed request wording</th></tr></thead>
        <tbody><tr><td>{proposal.currentText}</td><td data-testid="proposed-text">{proposal.proposedText}</td></tr></tbody>
      </table>
      <p><strong>Quoted from the source:</strong> <q>{proposal.quote}</q></p>
      <p><strong>Why:</strong> {proposal.rationale}</p>
      <Provenance proposal={proposal} source={sourceFor(proposal)} />
      <div className="button-row">
        <button type="button" disabled={busy} data-testid="accept-guidance"
          onClick={() => act(s => applyGuidanceProposal(s, proposal, reviewer),
            `${proposal.lineId} wording accepted and advanced to ${GUIDANCE_METHOD_VERSION}. Existing requests are unchanged.`)}>
          Accept wording change
        </button>
        <button type="button" className="text-button" disabled={busy}
          onClick={() => act(s => rejectGuidanceProposal(s, proposal, reviewer),
            `${proposal.lineId} proposal rejected. Request wording is unchanged.`)}>
          Reject
        </button>
      </div>
    </article>)}

    {decided.length > 0 && <details>
      <summary>Decided ({decided.length})</summary>
      {decided.map(proposal => <article className="proposal-item" key={`${proposal.lineId}|${proposal.sourceId}|${proposal.createdAt}`}>
        <p><strong>{proposal.lineId}</strong> — {proposal.review.status} {proposal.review.reviewer && `by ${proposal.review.reviewer}`} on {when(proposal.review.decidedAt)}</p>
        <p>{proposal.review.status === 'accepted' ? proposal.proposedText : proposal.currentText}</p>
        <small>Source {proposal.sourceId} · {proposal.sourceStatus.replaceAll('_', ' ')}</small>
      </article>)}
    </details>}
  </section>;
}

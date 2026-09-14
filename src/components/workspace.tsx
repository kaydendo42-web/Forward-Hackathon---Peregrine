'use client';

import { useEffect, useRef, useState } from 'react';
import type { Baseline, InboxMessage, ReviewChange, Workspace as State } from '../core/types';
import * as flow from '../core/workflow';
import { groupFor } from '../core/family';
import { parseMoney, readEvidenceCsv } from '../lib/evidence';
import { commitWorkspace, keepOriginal, parseSavedWorkspace, readOriginal, sha256, STORAGE_KEY } from '../lib/storage';
import { RequestPanel } from './request-panel';
import { AssistPanel } from './assist-panel';
import { SendDraft } from './send-draft';
import { InboxPanel } from './inbox-panel';
import { FamilyTree } from './family-tree';
import { GuidancePanel } from './guidance-panel';
import { checkInbox, importReplies } from '../lib/inbox';
import { buildIntakeContext, recordIntakeProposal } from '../lib/intake';
import { readAttachment } from '../lib/intake-client';
import { sendDraft } from '../lib/send-client';
import { download, money } from '../lib/format';
import { entities, evidencePath, fy26Path, fy26Samples, workbookPath } from '../lib/samples';

export default function Workspace() {
  const [state, setState] = useState<State>(flow.createWorkspace);
  const stateRef = useRef(state); const locked = useRef(false);
  const [ready, setReady] = useState(false); const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(''); const [error, setError] = useState('');
  const [entityId, setEntityId] = useState('alex-taylor'); const [selectedId, setSelectedId] = useState('');
  const [tab, setTab] = useState('Requests'); const [clientView, setClientView] = useState(false);
  const [candidate, setCandidate] = useState<Baseline | null>(null);
  const [reviewImport, setReviewImport] = useState<{ version: number; changes: ReviewChange[] } | null>(null);
  const [resetConfirm, setResetConfirm] = useState(false);
  const [intakeProgress, setIntakeProgress] = useState('');

  useEffect(() => {
    try { const saved = parseSavedWorkspace(localStorage.getItem(STORAGE_KEY)); setState(saved); stateRef.current = saved; }
    catch { setError('Saved demo data is unreadable. Reset this demo to start again; existing files are not deleted.'); }
    setReady(true);
    const sync = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      try { const saved = parseSavedWorkspace(e.newValue); setState(saved); stateRef.current = saved; setReviewImport(null); setNotice('Updated from another browser tab.'); }
      catch { setError('Another tab saved invalid data. Reload or reset the demo.'); }
    };
    window.addEventListener('storage', sync); return () => window.removeEventListener('storage', sync);
  }, []);

  function persist(base: State, next: State) {
    commitWorkspace(localStorage, base, next); stateRef.current = next; setState(next);
  }
  async function run(task: () => void | Promise<void>, success = '') {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(''); setNotice('');
    try { await task(); if (success) setNotice(success); }
    catch (e) { setError(e instanceof Error ? e.message : 'The operation failed. Please try again.'); }
    finally { locked.current = false; setBusy(false); }
  }
  function act(operation: (s: State) => State, success = 'Saved.') { void run(() => { const base = stateRef.current; persist(base, operation(base)); }, success); }
  const group = groupFor(entityId);
  const visibleDraft = (d: { entityId: string; groupId?: string }) => d.entityId === entityId || (!!group && d.groupId === group.id);
  function selectEntity(id: string) { setEntityId(id); setSelectedId(''); setCandidate(null); setReviewImport(null); setError(''); }

  async function loadFamily() {
    const { readBaseline } = await import('../lib/workbooks');
    const base = stateRef.current; let next = base;
    for (const entity of entities) {
      if (next.baselines.some(b => b.entityId === entity.id)) continue;
      const response = await fetch(workbookPath(entity.id));
      if (!response.ok) throw new Error(`Could not download ${entity.name}'s sample.`);
      const bytes = await response.arrayBuffer(); const pack = await readBaseline(bytes);
      await keepOriginal(await sha256(bytes), bytes);
      next = flow.importBaseline(next, pack);
    }
    persist(base, next);
  }
  async function uploadBaseline(file: File) {
    if (!file.name.toLowerCase().endsWith('.xlsx')) throw new Error('Select a supplied .xlsx workbook.');
    const { readBaseline } = await import('../lib/workbooks');
    const bytes = await file.arrayBuffer(); const pack = await readBaseline(bytes);
    if (stateRef.current.baselines.some(b => b.entityId === pack.entityId)) throw new Error('This entity is already imported. Reset the demo to replace it.');
    await keepOriginal(await sha256(bytes), bytes); setCandidate(pack);
  }
  async function uploadEvidence(file: File, requestId: string) {
    if (!file.name.toLowerCase().endsWith('.csv') || file.size > 250_000) throw new Error('Use a structured evidence CSV up to 250 KB. PDF extraction is not connected.');
    const bytes = await file.arrayBuffer(); const hash = await sha256(bytes);
    const records = readEvidenceCsv(new TextDecoder().decode(bytes));
    const base = stateRef.current; let next = base;
    for (const record of records) next = flow.receiveEvidence(next, requestId, { ...record, filename: file.name, fileHash: hash });
    await keepOriginal(hash, bytes); persist(base, next);
    setNotice(next === base ? 'Duplicate source ignored; no amount added.' : 'Evidence linked. Adviser review is still required.');
  }
  async function exportReview() {
    const { exportReview } = await import('../lib/workbooks');
    const { shrinkForWorkbook } = await import('../lib/image-client');
    const bytes = await exportReview(stateRef.current, entityId, async hash => {
      try { return await shrinkForWorkbook(await readOriginal(hash)); } catch { return null; }
    });
    download(bytes, `${entityId}-FY26-review-v${stateRef.current.version}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  }
  async function importReview(file: File) {
    const { previewReview } = await import('../lib/workbooks');
    const source = stateRef.current; const bytes = await file.arrayBuffer();
    const changes = await previewReview(bytes, source, entityId);
    await keepOriginal(await sha256(bytes), bytes);
    setReviewImport({ version: source.version, changes });
  }
  async function fetchReplies(passcode: string) {
    const base = stateRef.current;
    const result = await checkInbox(passcode);
    const next = importReplies(base, result.messages);
    persist(base, next);
    const added = next.inbox.length - base.inbox.length;
    setNotice(`Inbox checked: ${added} new ${added === 1 ? 'reply' : 'replies'}. No answers applied automatically.`);
  }
  async function readAllAttachments(passcode: string, message: InboxMessage) {
    const failures: string[] = []; let skipped = 0;
    for (let i = 0; i < message.attachments.length; i++) {
      // Already read (pending or accepted) → leave it; only unread or failed files go to the model.
      if ((stateRef.current.intake ?? []).some(p => p.messageId === message.messageId && p.attachmentIndex === i && p.review.status !== 'rejected')) { skipped += 1; continue; }
      setIntakeProgress(`Reading ${i + 1} of ${message.attachments.length}: ${message.attachments[i].filename || 'attachment'}… (model reads take 15–90 s each)`);
      try {
        const base = stateRef.current;
        const proposal = await readAttachment(passcode, message.messageId, i, buildIntakeContext(base));
        const id = `intake-${base.version + 1}-${i}`;
        // Commit from the latest state so a proposal saved by an earlier iteration is kept.
        persist(stateRef.current, recordIntakeProposal(stateRef.current, { ...proposal, id, review: { status: 'pending', decidedAt: '', note: '' } }));
      } catch (e) { failures.push(`${message.attachments[i].filename || `attachment ${i + 1}`}: ${e instanceof Error ? e.message : 'failed'}`); }
    }
    setIntakeProgress('');
    const read = message.attachments.length - failures.length - skipped;
    if (failures.length) throw new Error(`${read} read${skipped ? `, ${skipped} already read` : ''}, ${failures.length} not read — press Read again to retry only those. ${failures.join('; ')}`);
    setNotice(`${read} attachment${read === 1 ? '' : 's'} read${skipped ? ` (${skipped} already read, skipped)` : ''}. Nothing linked yet — review each proposal below.`);
  }
  async function sendMailDraft(draftId: string, to: string, passcode: string) {
    if (locked.current) throw new Error('Another operation is running. Try sending when it finishes.');
    const base = stateRef.current;
    const draft = base.outbox.find(d => d.id === draftId && d.status === 'draft');
    if (!draft) throw new Error('This draft is no longer available to send.');
    locked.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const receipt = await sendDraft(draft, to, passcode);
      try { persist(base, flow.markSent(base, draftId, receipt)); }
      catch {
        throw new Error(`Email was sent to ${receipt.to} (message ID ${receipt.messageId}), but the workspace could not save the receipt. Do not resend. Keep this message ID and reload to reconcile the workspace.`);
      }
      setNotice(`Emailed ${receipt.to}. After the family replies, use Check inbox in the Inbox tab.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sending failed.');
      throw e;
    } finally { locked.current = false; setBusy(false); }
  }
  const baseline = state.baselines.find(b => b.entityId === entityId);
  const requests = state.requests.filter(r => r.entityId === entityId);
  const selected = requests.find(r => r.id === selectedId) ?? requests[0];
  const accepted = requests.filter(r => ['accepted', 'not_applicable'].includes(r.review)).length;
  const allEntities = [...entities, ...state.baselines.filter(b => !entities.some(e => e.id === b.entityId)).map(b => ({ id: b.entityId, name: b.entityName, type: b.entityType }))];

  return <div className="app-shell">
    <header className="topbar"><a className="brand" href="/">Peregrine<span>Compliance collection</span></a><span className="demo-label">Synthetic demonstration</span></header>
    <div className="demo-warning">Synthetic data only. Saved in this browser, not a shared client portal. Email and AI require configuration. No tax advice or lodgment.</div>
    <div className="workspace-layout">
      <aside className="sidebar" aria-label="Family entities">
        <FamilyTree state={state} group={group} entities={allEntities} entityId={entityId} selectedId={selectedId} clientView={clientView}
          selectEntity={selectEntity} openRequest={(id, requestId) => { if (id !== entityId) selectEntity(id); setSelectedId(requestId); setTab('Requests'); }} />
        <div className="sidebar-bottom"><strong>Optional email and AI</strong><p>Drive and Xero are not connected.</p><button className="text-button" onClick={() => setTab('Connections')}>Setup plan</button></div>
      </aside>
      <main>
        <div className="page-heading"><div><p className="eyebrow">FY25 baseline / FY26 collection</p><h1>Collection workspace</h1><p>{baseline?.entityName ?? 'Import a synthetic family to begin.'}</p></div>
          <label className="toggle"><input type="checkbox" checked={clientView} onChange={e => setClientView(e.target.checked)} /> Client-view simulation</label>
        </div>
        {clientView && <p className="callout">This switch demonstrates the client experience. It is not authentication or a permission boundary.</p>}
        <div className="stage-strip"><span>FY25 workpapers</span><span>FY26 requests</span><span>Supporting evidence</span><span>Adviser review</span></div>
        <div aria-live="polite" className="feedback">{busy && <p>Working…</p>}{notice && <p className="notice">{notice}</p>}{error && <p className="error" role="alert" data-testid="error">{error}</p>}</div>
        {!clientView && <section className="toolbar" aria-label="Workspace actions">
          <button disabled={!ready || busy} onClick={() => void run(loadFamily, '4 baselines imported')}>Load synthetic family</button>
          <label className="file-button">Import FY25 workbook<input aria-label="FY25 workbook" disabled={!ready || busy} type="file" accept=".xlsx" onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void run(() => uploadBaseline(f)); }} /></label>
          <button disabled={!baseline || busy || !!requests.length} onClick={() => act(s => flow.startSeason(s, entityId), 'FY26 requests generated. Current-year amounts are blank.')}>Generate FY26 requests</button>
          {group && !clientView && <button disabled={busy || !group.entityIds.some(id => state.baselines.some(b => b.entityId === id) && !state.requests.some(r => r.entityId === id))}
            onClick={() => act(s => flow.startFamilySeason(s, group.entityIds), 'FY26 requests generated for every imported entity in the family.')}>Generate FY26 for whole family</button>}
          <span className="version">Workspace v{state.version}</span>
        </section>}
        {candidate && <section className="import-preview"><h2>Review baseline import</h2><p>{candidate.entityName} · FY{candidate.financialYear} · {candidate.lines.length} workpaper lines. Values stay in the prior-year column.</p>
          <ul>{candidate.lines.map(line => <li key={line.id}>{line.id}: {line.label} — {money(line.amountCents)}</li>)}</ul>
          <button disabled={busy} onClick={() => { const pack = candidate; act(s => flow.importBaseline(s, pack), 'Synthetic baseline confirmed.'); setEntityId(pack.entityId); setCandidate(null); }}>Confirm synthetic baseline</button><button onClick={() => setCandidate(null)}>Cancel import</button>
        </section>}
        <nav className="tabs" aria-label="Workspace views">{['Requests', 'Outbox', ...(!clientView ? ['Inbox', 'Guidance'] : []), 'Files', 'Activity', 'Connections'].map(name => <button key={name} aria-pressed={tab === name} className={tab === name ? 'active' : ''} onClick={() => setTab(name)}>{name}{name === 'Outbox' ? ` (${state.outbox.filter(d => visibleDraft(d) && d.status === 'draft').length})` : ''}</button>)}</nav>
        {tab === 'Inbox' && !clientView && <InboxPanel state={state} entityId={entityId} busy={busy} act={act} check={passcode => void run(() => fetchReplies(passcode))}
          readAttachments={(passcode, message) => void run(() => readAllAttachments(passcode, message))} progress={intakeProgress}
          openRequest={id => { setSelectedId(id); setTab('Requests'); }} />}
        {tab === 'Guidance' && !clientView && <GuidancePanel state={state} entityId={entityId} busy={busy} act={act} />}
        {tab === 'Requests' && <>
          <div className="section-heading"><div><h2>{requests.length ? `${accepted} of ${requests.length} requests reviewed` : 'Prepare the collection season'}</h2><p>{requests.length ? 'Evidence receipt and adviser acceptance are tracked separately.' : 'Download the workbooks below, or load the sample family. Then generate FY26 requests.'}</p></div>
            {!clientView && requests.length > 0 && <div className="button-row"><button disabled={busy} onClick={() => act(s => flow.queueOutreach(s, entityId, 'initial'), 'Draft created. No email was sent.')}>Draft initial outreach</button><button disabled={busy} onClick={() => act(s => flow.queueOutreach(s, entityId, 'reminder'), 'Reminder draft created. No email was sent.')}>Draft reminder</button>{group && <><button disabled={busy} onClick={() => act(s => flow.queueGroupOutreach(s, group, 'initial'), `Family email drafted for ${group.liaison.name}. No email was sent.`)}>Draft family email</button><button disabled={busy} onClick={() => act(s => flow.queueGroupOutreach(s, group, 'reminder'), `Family reminder drafted for ${group.liaison.name}. No email was sent.`)}>Family reminder</button></>}</div>}
          </div>
          {requests.length > 0 && <div className="collection-grid"><div className="request-list">
            {requests.map(request => <article className={`request-row ${request.id === selected?.id ? 'selected' : ''}`} key={request.id}>
              <button onClick={() => setSelectedId(request.id)}>{request.label}</button><span className="status">{flow.collectionStatus(request)}</span>
              <p>{request.lineId} · {request.component.replaceAll('_', ' ')}</p>
              {!clientView && <small>FY25 comparative: {money(request.priorAmountCents)}</small>}
            </article>)}
          </div>
          {selected && <div className="request-column">
            <RequestPanel key={`${selected.id}:${state.version}`} request={selected} clientView={clientView} busy={busy} act={act}
              upload={file => void run(() => uploadEvidence(file, selected.id))} openOriginal={e => void run(async () => download(await readOriginal(e.fileHash), e.filename))} />
            {!clientView && baseline && <AssistPanel key={selected.id} request={selected} baseline={baseline} busy={busy} act={act} />}
          </div>}
          </div>}
          {!clientView && requests.length > 0 && <section className="review-tools"><h2>Adviser handoff</h2><p>Export the FY26 review workbook, edit its decision and review_note columns, then re-import. New evidence makes older exports stale.</p>
            <div className="button-row"><button disabled={busy} onClick={() => void run(exportReview, 'Review workbook downloaded.')}>Export review workbook</button><label className="file-button">Preview review import<input type="file" accept=".xlsx" aria-label="Review workbook" disabled={busy} onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void run(() => importReview(f)); }} /></label></div>
            {reviewImport && <div className="import-preview"><h3>{reviewImport.changes.length} proposed review changes</h3>{reviewImport.changes.map(c => <p key={c.requestId}>{c.requestId}: {c.decision} — {c.note}</p>)}<button disabled={busy || reviewImport.changes.length === 0} onClick={() => { const preview = reviewImport; act(s => flow.applyReviewChanges(s, preview.version, preview.changes), 'Review changes confirmed in the demo.'); setReviewImport(null); }}>Confirm review changes</button><button onClick={() => setReviewImport(null)}>Dismiss preview</button></div>}
            <details><summary>Add an approved planning request</summary><form onSubmit={e => { e.preventDefault(); const data = new FormData(e.currentTarget); act(s => flow.addPlanningRequest(s, entityId, String(data.get('title')), String(data.get('note'))), 'Planning request added with its reason.'); e.currentTarget.reset(); }}><label>Request title<input name="title" required maxLength={120} placeholder="Investment disposal records" /></label><label>Approved planning note / evidence request<textarea name="note" required maxLength={4000} placeholder="Synthetic adviser note: obtain the FY26 disposal contract and purchase records. Do not assume a proposed sale completed." /></label><button disabled={busy}>Add planning request</button></form></details>
          </section>}
        </>}
        {tab === 'Outbox' && <section><h2>Draft outbox</h2><p>Drafts are generated on demand, not scheduled. Sending goes through Gmail SMTP to the verified demo inbox only; a response or changed request supersedes unsent drafts.</p>
          {state.outbox.filter(visibleDraft).length === 0 && <p className="empty">No drafts yet. Generate requests, then draft initial outreach or a family email.</p>}
          {state.outbox.filter(visibleDraft).toReversed().map(draft => <article className={`draft ${draft.status}`} key={draft.id}><h3>{draft.subject}</h3>{draft.groupId && group && <p className="hint">Family group · one email to {group.liaison.name} ({group.liaison.role})</p>}
            <p data-testid="draft-status">{draft.status === 'draft' ? 'Draft — not sent' : draft.status === 'sent' ? `Sent to ${draft.to} · ${new Date(draft.sentAt ?? '').toLocaleString('en-AU')} · ${draft.messageId}` : 'Superseded — do not send'}</p>
            <pre>{draft.body}</pre>
            <div className="button-row"><button disabled={draft.status === 'superseded'} onClick={() => download(draft.body, `${draft.id}.txt`, 'text/plain')}>Download draft</button>{!clientView && <SendDraft draft={draft} busy={busy} send={sendMailDraft} />}</div></article>)}
        </section>}
        {tab === 'Files' && <section><h2>Synthetic workbook and evidence files</h2><p>Four separate entity workbooks, three template types. Upload these files to a restricted Google Drive demo folder if useful. The app is not connected to Drive.</p>
          <div className="sample-files">{entities.map(entity => <article key={entity.id}><h3>{entity.name}</h3><a href={workbookPath(entity.id)} download>Download FY25 workbook</a><a href={evidencePath(entity.id)} download>Download FY25 evidence records</a></article>)}</div>
          <h3>FY26 test evidence</h3><div className="sample-links">{fy26Samples.map(({ file, label }) => <a key={file} href={fy26Path(file)} download>{label}</a>)}</div>
          <p>CSV fixtures demonstrate structured extraction results. They are not genuine broker or bank documents. Arbitrary PDFs, images and invoices need a reviewed extraction stage in the next milestone.</p>
        </section>}
        {tab === 'Activity' && <section><h2>Demo activity record</h2><p>Local workflow history, not a tamper-proof production audit trail.</p><ol className="audit-list">{state.audit.filter(e => e.entityId === entityId || (!!group && e.entityId === group.id)).toReversed().map(event => <li key={event.id}><strong>{event.action.replaceAll('_', ' ')}</strong><time>{new Date(event.at).toLocaleString('en-AU')}</time><p>{event.detail}</p></li>)}</ol></section>}
        {tab === 'Connections' && <section><h2>Connection plan</h2><table><thead><tr><th>System</th><th>Role</th><th>Current status</th></tr></thead><tbody>
          <tr><td>Vercel</td><td>Host the Next.js demo</td><td>This app is deployable without credentials or server-local storage.</td></tr>
          <tr><td>Supabase</td><td>Authenticated entity access, requests, evidence metadata and review events</td><td>Not connected. Browser-local storage is a demo adapter only.</td></tr>
          <tr><td>Google Drive</td><td>Original documents and versioned workpaper copies</td><td>Not connected. Use restricted entity/year folders; OAuth setup is next.</td></tr>
          <tr><td>Xero</td><td>Read-only current-year ledger comparisons</td><td>Not connected. Verify the university account's reporting permissions first.</td></tr>
          <tr><td>AI assist</td><td>Propose fields from pasted text, follow-up wording and change requests</td><td>Implemented; requires NIM credentials and the demo passcode. Proposals need adviser acceptance. Photo and text-PDF attachments are read into proposals via the Inbox; no OCR guarantees.</td></tr>
          <tr><td>Email</td><td>Send approved drafts and retrieve family replies</td><td>Implemented; requires a firm Gmail mailbox and App Password. Inbox checks are manual; attachments are metadata only. No scheduler or durable server outbox.</td></tr>
        </tbody></table><p>Jason's guidance changes should be reviewed and versioned before use. Current method: {flow.METHOD_VERSION}. This demo does not monitor or invent ATO changes.</p></section>}
        <footer><span>Peregrine · limited synthetic workpapers, not complete tax returns</span><button className="text-button" onClick={() => setResetConfirm(true)}>Reset demo</button>
          {resetConfirm && <div className="callout"><p>Clear this browser's requests, decisions and drafts? Original uploaded files remain in browser storage.</p><button disabled={busy} onClick={() => { localStorage.removeItem(STORAGE_KEY); const empty = flow.createWorkspace(); stateRef.current = empty; setState(empty); setCandidate(null); setReviewImport(null); setResetConfirm(false); setError(''); setNotice('Demo reset.'); }}>Confirm reset</button><button onClick={() => setResetConfirm(false)}>Keep demo</button></div>}
        </footer>
      </main>
    </div>
  </div>;
}

import type { Baseline, CollectionRequest, Decision, EvidenceInput, ReviewChange, SendReceipt, Workspace } from './types';

export const METHOD_VERSION = 'demo-method-1';

export function createWorkspace(): Workspace {
  return { schemaVersion: 1, version: 0, baselines: [], requests: [], outbox: [], audit: [] };
}

export function assertAmount(value: number | null) {
  if (value !== null && (!Number.isSafeInteger(value) || Math.abs(value) > 1_000_000_000_000)) {
    throw new Error('Invalid amount: use whole cents within the demonstration limit.');
  }
}

function text(value: string, label: string, max = 4000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label} is required (maximum ${max} characters).`);
  return value.trim();
}

function change(state: Workspace, entityId: string, action: string, detail: string): Workspace {
  return { ...state, version: state.version + 1, audit: [...state.audit,
    { id: `event-${state.version + 1}`, at: new Date().toISOString(), entityId, action, detail }] };
}

function getRequest(state: Workspace, id: string) {
  const req = state.requests.find(r => r.id === id);
  if (!req) throw new Error('Request not found in this workspace.');
  return req;
}

function replace(state: Workspace, request: CollectionRequest, action: string, detail: string) {
  return change({ ...state, requests: state.requests.map(r => r.id === request.id ? request : r),
    outbox: state.outbox.map(d => d.status === 'draft' && d.requestIds.includes(request.id) ? { ...d, status: 'superseded' } : d),
  }, request.entityId, action, detail);
}

export function importBaseline(state: Workspace, pack: Baseline): Workspace {
  if (pack.synthetic !== true || pack.financialYear !== 2025) throw new Error('This demo accepts synthetic FY25 baselines only.');
  if (state.baselines.some(b => b.entityId === pack.entityId)) throw new Error('This entity is already imported. Reset the demo to replace its baseline.');
  text(pack.entityName, 'Entity name', 120); text(pack.entityId, 'Entity ID', 80);
  if (!pack.lines.length || pack.lines.length > 200) throw new Error('The baseline must contain 1–200 lines.');
  if (new Set(pack.lines.map(l => l.id)).size !== pack.lines.length) throw new Error('Duplicate baseline line ID.');
  pack.lines.forEach(l => { assertAmount(l.amountCents); text(l.requestText, 'Request text'); });
  return change({ ...state, baselines: [...state.baselines, structuredClone(pack)] }, pack.entityId, 'baseline_confirmed', `Synthetic FY${pack.financialYear} baseline confirmed in demo; no actual tax approval or lodgment.`);
}

function blankRequest(entityId: string, financialYear: number, lineId: string): CollectionRequest {
  return { id: `${entityId}:${financialYear}:${lineId}`, entityId, financialYear, lineId,
    category: '', label: '', question: '', reason: '', component: 'document', currency: 'AUD', basis: 'document',
    priorAmountCents: null, comparisonCents: null, evidence: [], answer: '', review: 'pending',
    reviewNote: '', paused: false, origin: 'baseline', methodVersion: METHOD_VERSION };
}

export function startSeason(state: Workspace, entityId: string): Workspace {
  const pack = state.baselines.find(b => b.entityId === entityId);
  if (!pack) throw new Error('Import and confirm the FY25 baseline first.');
  if (state.requests.some(r => r.entityId === entityId)) return state;
  const year = pack.financialYear + 1;
  const requests: CollectionRequest[] = pack.lines.map(l => ({ ...blankRequest(entityId, year, l.id),
    category: l.category, label: l.label, question: `FY${year}: ${l.requestText}`,
    reason: `Recurring ${l.category.replaceAll('_', ' ')} in reviewed synthetic FY${pack.financialYear} workpaper ${l.id}. Source: ${l.sourceRef}. Confirm it still applies.`,
    component: l.component, currency: l.currency, basis: l.basis, priorAmountCents: l.amountCents,
  }));
  requests.push({ ...blankRequest(entityId, year, 'CHANGES'), category: 'current_year_changes',
    label: 'Current-year changes', origin: 'discovery',
    question: `FY${year}: What changed? Tell us about new or ceased income, investments, assets, loans, business activities or family circumstances. “No changes” is also an answer.`,
    reason: 'Prior-year records cannot identify new activity. Adviser review determines any additional evidence needed.' });
  return change({ ...state, requests: [...state.requests, ...requests] }, entityId, 'season_started', `Created ${requests.length} FY${year} requests from ${pack.workbookId}; current amounts remain blank.`);
}

export function addPlanningRequest(state: Workspace, entityId: string, label: string, note: string) {
  const current = state.requests.find(r => r.entityId === entityId);
  if (!current) throw new Error('Start the collection season first.');
  const request = { ...blankRequest(entityId, current.financialYear, `PLAN-${state.version + 1}`),
    label: text(label, 'Planning request title', 120), question: text(note, 'Approved planning note'),
    reason: text(note, 'Approved planning note'), category: 'planning_event', origin: 'planning' as const };
  return change({ ...state, requests: [...state.requests, request],
    outbox: state.outbox.map(d => d.entityId === entityId && d.status === 'draft' ? { ...d, status: 'superseded' } : d),
  }, entityId, 'planning_request_added', `${request.label}: ${request.reason}`);
}

export function setComparison(state: Workspace, id: string, amountCents: number | null) {
  assertAmount(amountCents);
  const req = getRequest(state, id);
  if (req.component === 'document' && amountCents !== null) throw new Error('This request needs documents or an answer, not an amount.');
  if (req.comparisonCents === amountCents) return state;
  return replace(state, { ...req, comparisonCents: amountCents, review: 'pending', reviewNote: '' }, 'comparison_updated', `${req.label}: current-year comparison updated; review reopened.`);
}

export function reconcile(req: CollectionRequest) {
  const amounts = req.evidence.filter(e => e.amountCents !== null).map(e => e.amountCents!);
  const evidenceCents = amounts.length ? amounts.reduce((sum, n) => sum + n, 0) : null;
  assertAmount(evidenceCents);
  const differenceCents = req.comparisonCents !== null && evidenceCents !== null ? req.comparisonCents - evidenceCents : null;
  return { evidenceCents, differenceCents };
}

export function receiveEvidence(state: Workspace, id: string, input: EvidenceInput) {
  const req = getRequest(state, id);
  for (const key of ['entityId', 'financialYear', 'lineId', 'component', 'currency', 'basis'] as const) {
    if (input[key] !== req[key]) throw new Error(`Evidence ${key} mismatch: expected ${req[key]}, received ${input[key]}.`);
  }
  assertAmount(input.amountCents); text(input.documentId, 'Document ID', 120); text(input.description, 'Evidence description');
  const old = req.evidence.find(e => e.documentId === input.documentId);
  if (old) {
    if (old.amountCents !== input.amountCents || old.description !== input.description) throw new Error('Conflicting content under an existing document ID. Adviser must resolve the corrected source.');
    return state;
  }
  if (req.component === 'closing_balance' && req.evidence.some(e => e.amountCents !== null) && input.amountCents !== null) {
    throw new Error('A closing balance cannot be added to another closing-balance document. Review the alternative source separately.');
  }
  const updated = { ...req, evidence: [...req.evidence, structuredClone(input)], review: 'pending' as const, reviewNote: '' };
  reconcile(updated);
  return replace(state, updated, 'evidence_received', `${input.documentId} linked to ${req.lineId}; receipt is not adviser acceptance.`);
}

export function recordAnswer(state: Workspace, id: string, answer: string) {
  const req = getRequest(state, id); const cleaned = text(answer, 'Client answer');
  if (req.answer === cleaned) return state;
  return replace(state, { ...req, answer: cleaned, review: 'pending', reviewNote: '' }, 'client_answered', `${req.label}: client response received; automated chasers paused pending review.`);
}

export function reviewRequest(state: Workspace, id: string, decision: Decision, note: string) {
  const req = getRequest(state, id); const cleaned = text(note, 'Review note');
  if (!['accepted', 'not_applicable', 'follow_up'].includes(decision)) throw new Error('Invalid review decision.');
  const result = reconcile(req);
  if (decision === 'accepted') {
    const support = req.component === 'document' ? req.answer || req.evidence.length : result.evidenceCents !== null;
    if (!support) throw new Error('Supporting evidence or an applicable answer is required before acceptance.');
    if (result.differenceCents !== null && result.differenceCents !== 0) throw new Error('An unresolved amount difference needs follow-up, not acceptance.');
  }
  if (req.review === decision && req.reviewNote === cleaned) return state;
  return replace(state, { ...req, review: decision, reviewNote: cleaned }, 'reviewed', `${req.label}: ${decision}. ${cleaned} (simulated adviser review).`);
}

export function rewordRequest(state: Workspace, id: string, question: string) {
  const req = getRequest(state, id); const cleaned = text(question, 'Request wording', 1000);
  if (req.question === cleaned) return state;
  return replace(state, { ...req, question: cleaned }, 'request_reworded', `${req.label}: question wording replaced by adviser; open drafts superseded.`);
}

/** Append an audit-only event (no request changes), e.g. an accepted AI proposal. */
export function logEvent(state: Workspace, entityId: string, action: string, detail: string) {
  return change(state, entityId, text(action, 'Event action', 80), text(detail, 'Event detail'));
}

export function pauseRequest(state: Workspace, id: string, paused: boolean) {
  const req = getRequest(state, id);
  if (req.paused === paused) return state;
  return replace(state, { ...req, paused }, 'pause_changed', `${req.label}: reminders ${paused ? 'paused' : 'resumed'}.`);
}

export function collectionStatus(req: CollectionRequest) {
  if (req.review === 'accepted') return 'Accepted for demo';
  if (req.review === 'not_applicable') return 'Not applicable';
  if (req.paused) return 'Paused';
  if (req.review === 'follow_up') return 'Follow-up required';
  if (req.evidence.length && reconcile(req).differenceCents !== null && reconcile(req).differenceCents !== 0) return 'Amount difference';
  if (req.evidence.length || req.answer) return 'Needs adviser review';
  return 'Awaiting client';
}

export function queueOutreach(state: Workspace, entityId: string, kind: 'initial' | 'reminder') {
  const entity = state.baselines.find(b => b.entityId === entityId);
  if (!entity) throw new Error('Entity not found.');
  const eligible = state.requests.filter(r => r.entityId === entityId && !r.paused &&
    (r.review === 'follow_up' || (r.review === 'pending' && !r.answer && r.evidence.length === 0)));
  if (!eligible.length) throw new Error('No unanswered requests need outreach. Responses and evidence await adviser review.');
  const fingerprint = JSON.stringify([kind, eligible.map(r => [r.id, r.question, r.review, r.reviewNote])]);
  if (state.outbox.some(d => d.entityId === entityId && d.fingerprint === fingerprint && d.status === 'draft')) return state;
  const year = eligible[0].financialYear;
  const body = `Hello ${entity.entityName},\n\n${kind === 'reminder' ? 'A reminder about the outstanding items' : 'We are collecting information'} for FY${year} (1 July ${year - 1}–30 June ${year}).\n\n` +
    eligible.map((r, i) => `${i + 1}. ${r.question}${r.review === 'follow_up' ? `\n   Adviser clarification: ${r.reviewNote}` : ''}`).join('\n\n') +
    '\n\nIf an item no longer applies or a document is not yet available, please tell us. Use your authorised document channel for sensitive records.\n\nYour adviser\n\nSYNTHETIC DEMO — draft only; not sent.';
  return change({ ...state, outbox: [...state.outbox, {
    id: `draft-${state.version + 1}`, entityId, kind, status: 'draft', requestIds: eligible.map(r => r.id),
    subject: `FY${year} information ${kind === 'reminder' ? 'reminder' : 'request'} — ${entity.entityName}`, body, fingerprint,
  }] }, entityId, 'outreach_drafted', `${kind} draft for ${eligible.length} requests. No email was sent.`);
}

export function markSent(state: Workspace, draftId: string, receipt: SendReceipt): Workspace {
  const draft = state.outbox.find(d => d.id === draftId);
  if (!draft) throw new Error('Draft not found in this workspace.');
  if (draft.status === 'sent') throw new Error('This draft was already sent.');
  if (draft.status === 'superseded') throw new Error('This draft is superseded; draft a fresh message before sending.');
  const to = text(receipt.to, 'Recipient', 320); const messageId = text(receipt.messageId, 'Message ID', 998);
  if (Number.isNaN(Date.parse(receipt.sentAt))) throw new Error('Invalid send time.');
  return change({ ...state, outbox: state.outbox.map(d => d.id === draftId ? { ...d, status: 'sent' as const, to, messageId, sentAt: receipt.sentAt } : d) },
    draft.entityId, 'outreach_sent', `${draft.kind} draft ${draft.id} emailed to ${to} (${draft.requestIds.length} requests). Message ID ${messageId}.`);
}

export function applyReviewChanges(state: Workspace, baseVersion: number, changes: ReviewChange[]) {
  if (state.version !== baseVersion) throw new Error('Stale workbook: export the latest version before applying changes.');
  if (new Set(changes.map(c => c.requestId)).size !== changes.length) throw new Error('Duplicate request changes.');
  return changes.reduce((next, c) => reviewRequest(next, c.requestId, c.decision, c.note), state);
}

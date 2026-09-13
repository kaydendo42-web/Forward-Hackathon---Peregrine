import { z } from 'zod';
import type { CollectionRequest, EvidenceInput, IntakeDocument, IntakeFlags, IntakeProposal, Workspace } from '../core/types';
import { logEvent, receiveEvidence } from '../core/workflow';

// Pure core for attachment intake: what the model is asked, how its reply is read, how
// code checks a proposal and how an adviser's acceptance maps onto existing transitions.

export const PROMPT_VERSION = 'intake-1';
export const MAX_DOCUMENTS = 10;
export const MAX_AMOUNTS = 30;

const short = z.string().max(300);
const long = z.string().max(1000);
const cents = z.number().int().min(-1e12).max(1e12).nullable();
const confidence = z.enum(['high', 'medium', 'low']);

export const intakeFlagsSchema = z.object({
  nameMatch: z.enum(['match', 'partial', 'mismatch']), periodInYear: z.boolean(), syntheticMarker: z.boolean(), targetValid: z.boolean(),
});
export const intakeDocumentSchema = z.object({
  docType: short, entityNameSeen: short, periodStart: short, periodEnd: short,
  amounts: z.array(z.object({ label: short, amountCents: cents })).max(MAX_AMOUNTS),
  proposedEntityId: short, proposedRequestId: short, confidence, reason: long, flags: intakeFlagsSchema,
});
export const intakeProposalSchema = z.object({
  id: short, messageId: z.string().max(1000), attachmentIndex: z.number().int().min(0).max(29), filename: short, contentType: short,
  size: z.number().int().nonnegative(), fileHash: z.string().regex(/^[0-9a-f]{64}$/), model: z.string().max(200),
  promptVersion: z.string().max(40), createdAt: z.string().max(40), source: z.enum(['image', 'pdf_text']),
  documents: z.array(intakeDocumentSchema).max(MAX_DOCUMENTS),
  review: z.object({ status: z.enum(['pending', 'accepted', 'rejected']), decidedAt: z.string().max(40), note: long }),
});

/** What the model returns for one document, before code adds `flags`. */
export type RawIntakeDocument = Omit<IntakeDocument, 'flags'> & { syntheticMarker: boolean };

const lenient = (limit: number) => z.string().max(limit).catch('');
const rawAmount = z.object({ label: lenient(300), amount: z.union([z.string(), z.number(), z.null()]).catch(null) });
const rawDocumentSchema = z.object({
  docType: lenient(300), entityNameSeen: lenient(300), periodStart: lenient(300), periodEnd: lenient(300),
  amounts: z.array(rawAmount).max(MAX_AMOUNTS).optional(),
  keyAmounts: z.array(rawAmount).max(MAX_AMOUNTS).optional(),
  proposedEntityId: lenient(300), proposedRequestId: lenient(300), confidence: confidence.catch('low'), reason: lenient(1000),
  syntheticMarker: z.boolean().catch(false),
});
const rawReplySchema = z.object({ documents: z.array(rawDocumentSchema).min(1).max(MAX_DOCUMENTS) });

/** "$108,125.00", "(5,000.00)", "-175", "AUD 1,200", 12.5 → integer cents; anything unreadable → null. */
export function parseIntakeAmount(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) && Math.abs(raw) <= 1e10 ? Math.round(raw * 100) : null;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const negative = (trimmed.startsWith('(') && trimmed.endsWith(')')) || /^[^\d]*-/.test(trimmed);
  const digits = trimmed.replace(/[^\d.]/g, '');
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(digits)) return null;
  const [whole, fraction = ''] = digits.split('.');
  const value = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return negative ? -value : value;
}

/**
 * Pulls the JSON out of a possibly prose-wrapped reply and validates it. The vision model
 * sometimes answers with a bare array of documents, or prose around the object; both are accepted.
 */
export function parseIntakeReply(content: string): RawIntakeDocument[] {
  const candidates: string[] = [];
  const objStart = content.indexOf('{'), objEnd = content.lastIndexOf('}');
  const arrStart = content.indexOf('['), arrEnd = content.lastIndexOf(']');
  if (objStart >= 0 && objEnd > objStart) candidates.push(content.slice(objStart, objEnd + 1));
  if (arrStart >= 0 && arrEnd > arrStart) candidates.push(content.slice(arrStart, arrEnd + 1));
  if (!candidates.length) throw new Error('Model reply contained no JSON object.');
  let parsed: unknown; let sawJson = false;
  for (const candidate of candidates) {
    let value: unknown;
    try { value = JSON.parse(candidate); } catch { continue; }
    sawJson = true;
    if (Array.isArray(value)) { parsed = { documents: value }; break; }
    if (value && typeof value === 'object' && Array.isArray((value as { documents?: unknown }).documents)) { parsed = value; break; }
  }
  if (parsed === undefined) throw new Error(sawJson ? 'Model reply had no documents list.' : 'Model reply was not valid JSON.');
  const { documents } = rawReplySchema.parse(parsed);
  return documents.map(({ amounts, keyAmounts, ...rest }) => ({
    ...rest, amounts: (amounts ?? keyAmounts ?? []).map(a => ({ label: a.label, amountCents: parseIntakeAmount(a.amount) })),
  }));
}

export const intakeContextSchema = z.object({
  entities: z.array(z.object({ entityId: short, entityName: short, entityType: z.enum(['individual', 'company', 'trust']) })).max(20),
  requests: z.array(z.object({ id: short, entityId: short, lineId: short, label: short, question: long, component: short, basis: short,
    financialYear: z.number().int() })).max(200),
});
export type IntakeContext = z.infer<typeof intakeContextSchema>;

/** Entities and open requests only. Evidence, answers and notes never leave the browser. */
export function buildIntakeContext(state: Workspace): IntakeContext {
  return intakeContextSchema.parse({
    entities: state.baselines.map(b => ({ entityId: b.entityId, entityName: b.entityName, entityType: b.entityType })),
    requests: state.requests.filter(r => r.review === 'pending' && !r.paused).map(r => ({
      id: r.id, entityId: r.entityId, lineId: r.lineId, label: r.label, question: r.question, component: r.component, basis: r.basis, financialYear: r.financialYear })),
  });
}

export type IntakeInput = { kind: 'image'; jpegBase64: string } | { kind: 'text'; text: string };
export type ChatMessage = { role: 'system' | 'user'; content: string | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[] };

const SCHEMA_HINT = `{"documents":[{"docType":"","entityNameSeen":"","periodStart":"","periodEnd":"","amounts":[{"label":"","amount":"$0.00"}],"proposedEntityId":"","proposedRequestId":"","confidence":"high","reason":"","syntheticMarker":false}]}`;

// Terse on purpose. On 14 September the 11b vision model answered a longer, friendlier prompt
// with a markdown description of the photo before any JSON (about 40 s at its token rate);
// stating the rules as a service contract and putting the image before the text cut that to
// roughly 10–20 s with parseable JSON every time.
const SYSTEM_PROMPT = `You are a JSON extraction service for an Australian accounting firm's synthetic demonstration family group; all names and figures are fictional test data. FY2026 = 1 July 2025 – 30 June 2026.
Rules: output exactly one JSON object matching ${SCHEMA_HINT} and nothing else. No markdown, no headings, no description of the image, no text before or after the JSON. One item per document seen. Copy names, dates and amounts exactly as printed; unreadable amount → null. proposedEntityId and proposedRequestId only from the supplied lists (match the entity name on the document), else "". syntheticMarker true if the page says synthetic, fictional or demo.`;

/** Only what the model needs to pick a target: ids, names and labels. Question text stays out of the prompt. */
function slimLists(context: IntakeContext) {
  return JSON.stringify({ entities: context.entities, requests: context.requests.map(r => ({ id: r.id, entityId: r.entityId, label: r.label })) });
}

export function buildIntakeMessages(context: IntakeContext, input: IntakeInput): ChatMessage[] {
  const lists = `Lists (JSON): ${slimLists(context)}`;
  const user: ChatMessage = input.kind === 'image'
    ? { role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${input.jpegBase64}` } }, { type: 'text', text: `${lists}\nReturn the JSON object now.` }] }
    : { role: 'user', content: `${lists}\n\nDocument text:\n${input.text}\n\nReturn the JSON object now.` };
  return [{ role: 'system', content: SYSTEM_PROMPT }, user];
}

const STOP_WORDS = new Set(['the', 'and', 'family', 'trust', 'pty', 'ltd', 'limited', 'services', 'group', 'fund', 'mr', 'mrs', 'ms', 'dr']);
function tokens(name: string) {
  return new Set(name.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3 && !STOP_WORDS.has(t)));
}
function nameMatch(seen: string, entityName: string): IntakeFlags['nameMatch'] {
  const a = seen.trim().toLowerCase().replace(/\s+/g, ' '), b = entityName.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!a || !b) return 'mismatch';
  if (a === b) return 'match';
  const left = tokens(a), right = tokens(b);
  for (const t of left) if (right.has(t)) return 'partial';
  return 'mismatch';
}
const RANK = { match: 0, partial: 1, mismatch: 2 } as const;

/** "1 June 2026", "2026-06-30", "30/06/2026" → ms since epoch; anything else → null. */
function parseDateLoose(value: string): number | null {
  const s = value.trim();
  if (!s) return null;
  const dmy = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (dmy) return Date.UTC(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1]));
  if (!/\d{4}/.test(s) || !/\d{1,2}/.test(s.replace(/\d{4}/, ''))) return null;   // needs a day and a year
  const parsed = Date.parse(s);
  if (!Number.isFinite(parsed)) return null;
  const local = new Date(parsed);   // Date.parse reads a bare date in the server's zone; compare calendar days, not instants
  return Date.UTC(local.getFullYear(), local.getMonth(), local.getDate());
}
function inFinancialYear(start: string, end: string, year: number) {
  const from = Date.UTC(year - 1, 6, 1), to = Date.UTC(year, 5, 30, 23, 59, 59);
  const a = parseDateLoose(start), b = parseDateLoose(end);
  if (a === null || b === null) return true;
  return a >= from && a <= to && b >= from && b <= to;
}

export function financialYearOf(context: IntakeContext, requestId: string) {
  return context.requests.find(r => r.id === requestId)?.financialYear ?? 2026;
}

/** Adds code-owned flags. Nothing is dropped: mismatches and invalid targets are shown to the adviser. */
export function verifyIntake(documents: RawIntakeDocument[], context: IntakeContext): IntakeDocument[] {
  return documents.map(({ syntheticMarker, ...raw }) => {
    // The model often reads the name correctly but leaves the id blank; a unique exact
    // name match is filled in by code so the adviser's entity picker starts in the right place.
    const exact = context.entities.filter(e => nameMatch(raw.entityNameSeen, e.entityName) === 'match');
    const doc = !raw.proposedEntityId && exact.length === 1 ? { ...raw, proposedEntityId: exact[0].entityId } : raw;
    const entity = context.entities.find(e => e.entityId === doc.proposedEntityId);
    const candidates = entity ? [entity] : context.entities;
    const best = candidates.map(e => nameMatch(doc.entityNameSeen, e.entityName)).sort((x, y) => RANK[x] - RANK[y])[0] ?? 'mismatch';
    const request = context.requests.find(r => r.id === doc.proposedRequestId);
    const targetValid = Boolean(entity && request && request.entityId === entity.entityId);
    const flags: IntakeFlags = {
      nameMatch: best,
      periodInYear: inFinancialYear(doc.periodStart, doc.periodEnd, financialYearOf(context, doc.proposedRequestId)),
      syntheticMarker: syntheticMarker || /synthetic|fictional|fictitious/i.test(`${doc.docType} ${doc.entityNameSeen} ${doc.reason}`),
      targetValid,
    };
    return { ...doc, flags };
  });
}

export function intakeDocumentId(fileHash: string, docIndex: number) {
  return `intake-${fileHash.slice(0, 16)}-${docIndex}`;
}

function auditEntity(proposal: IntakeProposal) {
  return proposal.documents.find(d => d.flags.targetValid)?.proposedEntityId || proposal.documents[0]?.proposedEntityId || 'unassigned';
}

/** Saves a read attachment as a pending proposal. Replaces an earlier pending one for the same attachment. */
export function recordIntakeProposal(state: Workspace, proposal: IntakeProposal): Workspace {
  const clean = intakeProposalSchema.parse(proposal);
  const kept = (state.intake ?? []).filter(p => !(p.messageId === clean.messageId && p.attachmentIndex === clean.attachmentIndex && p.review.status === 'pending'));
  if (kept.length >= 500) throw new Error('Too many intake proposals are saved in this browser. Reject or accept some first.');
  const next = { ...state, intake: [...kept, clean] };
  return logEvent(next, auditEntity(clean), 'intake_read',
    `${clean.filename} read by ${clean.model} (prompt ${clean.promptVersion}, sha256 ${clean.fileHash.slice(0, 16)}): ${clean.documents.length} document(s) proposed. Nothing applied.`);
}

function getProposal(state: Workspace, proposalId: string) {
  const proposal = (state.intake ?? []).find(p => p.id === proposalId);
  if (!proposal) throw new Error('Intake proposal not found in this workspace.');
  return proposal;
}

/** The request already holding this document, if the adviser accepted it earlier. */
export function linkedRequestFor(state: Workspace, proposal: IntakeProposal, docIndex: number): CollectionRequest | undefined {
  const id = intakeDocumentId(proposal.fileHash, docIndex);
  return state.requests.find(r => r.evidence.some(e => e.documentId === id));
}

/**
 * Adviser accepts one document onto one request. Request-owned fields are copied from the
 * chosen request so `receiveEvidence`'s equality checks hold; the adviser's figure and
 * description win over the model's.
 */
export function applyIntakeDocument(state: Workspace, proposalId: string, docIndex: number,
  choice: { requestId: string; amountCents: number | null; description: string }): Workspace {
  const proposal = getProposal(state, proposalId);
  if (proposal.review.status === 'rejected') throw new Error('This proposal was rejected; read the attachment again to reconsider it.');
  const doc = proposal.documents[docIndex];
  if (!doc) throw new Error('Proposed document not found.');
  const request = state.requests.find(r => r.id === choice.requestId);
  if (!request) throw new Error('Request not found in this workspace.');
  const description = choice.description.trim();
  if (!description) throw new Error('Evidence description is required.');
  const input: EvidenceInput = {
    documentId: intakeDocumentId(proposal.fileHash, docIndex), lineId: request.lineId, entityId: request.entityId, financialYear: request.financialYear,
    component: request.component, currency: request.currency, basis: request.basis, amountCents: choice.amountCents,
    description, filename: proposal.filename, fileHash: proposal.fileHash,
  };
  const linked = receiveEvidence(state, request.id, input);
  const override = request.id !== doc.proposedRequestId;
  const decided = { ...proposal, review: { status: 'accepted' as const, decidedAt: new Date().toISOString(), note: proposal.review.note } };
  const next = { ...linked, intake: (linked.intake ?? []).map(p => p.id === proposalId ? decided : p) };
  return logEvent(next, request.entityId, 'intake_accepted',
    `${proposal.filename} document ${docIndex + 1} (${doc.docType || 'document'}) accepted by adviser onto ${request.lineId}${override ? ` — adviser override; model proposed ${doc.proposedRequestId || 'no target'}` : ''}. Model ${proposal.model}, prompt ${proposal.promptVersion}, sha256 ${proposal.fileHash.slice(0, 16)}, proposal ${proposal.id}.`);
}

export function rejectIntakeProposal(state: Workspace, proposalId: string, note: string): Workspace {
  const proposal = getProposal(state, proposalId);
  const decided = { ...proposal, review: { status: 'rejected' as const, decidedAt: new Date().toISOString(), note: note.trim().slice(0, 1000) } };
  const next = { ...state, intake: (state.intake ?? []).map(p => p.id === proposalId ? decided : p) };
  return logEvent(next, auditEntity(proposal), 'intake_rejected', `${proposal.filename} rejected by adviser${decided.review.note ? `: ${decided.review.note}` : '.'}`);
}

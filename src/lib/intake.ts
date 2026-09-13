import { z } from 'zod';
import type { IntakeDocument, IntakeFlags, IntakeProposal, Workspace } from '../core/types';

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

/** Pulls the first {...} block out of a possibly prose-wrapped reply and validates it. */
export function parseIntakeReply(content: string): RawIntakeDocument[] {
  const start = content.indexOf('{'), end = content.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Model reply contained no JSON object.');
  let parsed: unknown;
  try { parsed = JSON.parse(content.slice(start, end + 1)); } catch { throw new Error('Model reply was not valid JSON.'); }
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

const SYSTEM_PROMPT = `You sort documents for an Australian accounting firm's synthetic demonstration family group. All names and figures are fictional test data.
FY2026 is 1 July 2025 to 30 June 2026. One image may contain several documents; return one item per document.
Copy the entity name, dates and amounts exactly as printed. Never invent an amount; leave it null if unreadable.
Choose proposedEntityId and proposedRequestId only from the supplied lists, otherwise use an empty string.
Set syntheticMarker true when the page says synthetic, fictional, demo or similar.
Reply with JSON only.`;

const SCHEMA_HINT = `{"documents":[{"docType":"","entityNameSeen":"","periodStart":"","periodEnd":"","amounts":[{"label":"","amount":"$0.00"}],"proposedEntityId":"","proposedRequestId":"","confidence":"high|medium|low","reason":"","syntheticMarker":false}]}`;

export function buildIntakeMessages(context: IntakeContext, input: IntakeInput): ChatMessage[] {
  const instruction = `Entities and open requests (JSON):\n${JSON.stringify(context, null, 1)}\n\nFor each document ${input.kind === 'image' ? 'in the image' : 'in the text below'}, return ${SCHEMA_HINT}`;
  const user: ChatMessage = input.kind === 'image'
    ? { role: 'user', content: [{ type: 'text', text: instruction }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${input.jpegBase64}` } }] }
    : { role: 'user', content: `${instruction}\n\nDocument text:\n${input.text}` };
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
  return Number.isFinite(parsed) ? parsed : null;
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
  return documents.map(({ syntheticMarker, ...doc }) => {
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

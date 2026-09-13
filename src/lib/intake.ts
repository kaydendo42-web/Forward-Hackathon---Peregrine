import { z } from 'zod';
import type { IntakeDocument, IntakeProposal } from '../core/types';

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

import { z } from 'zod';
import type { Baseline, CollectionRequest, Workspace } from '../core/types';
import { addPlanningRequest, logEvent, receiveEvidence, reviewRequest, rewordRequest } from '../core/workflow';
import { parseMoney } from './evidence';

// Everything here is pure and shared by the route handler, the browser and tests.
// The model only ever produces proposals; acceptance maps onto existing workflow transitions.

export const PROMPT_VERSION = 'assist-1';
export const TASKS = ['follow_up', 'extract', 'reword', 'triage'] as const;
export type AssistTask = (typeof TASKS)[number];
export const MAX_TEXT = 20_000;
const MAX_ITEMS = 20;

const short = z.string().trim().min(1).max(1000);
const basis = z.array(z.string().max(500)).max(10);
const aud = z.string().regex(/^-?\d+(\.\d{1,2})?$/, 'AUD amount with up to two decimals');

export const itemSchemas = {
  follow_up: z.object({ text: z.string().trim().min(1).max(2000), basis }),
  extract: z.object({ documentId: z.string().trim().min(1).max(120), amount: aud.nullable(), description: short, quote: z.string().max(500) }),
  reword: z.object({ question: short, basis }),
  triage: z.object({ label: z.string().trim().min(1).max(120), note: z.string().trim().min(1).max(2000), basis }),
} as const;

export type ProposalItem = { [T in AssistTask]: z.infer<(typeof itemSchemas)[T]> }[AssistTask];
export type Proposal = { task: AssistTask; model: string; promptVersion: string; createdAt: string; sourceHash?: string; items: ProposalItem[] };

const money = (cents: number | null) => cents === null ? null : (cents / 100).toFixed(2);

export const assistContextSchema = z.object({
  entityName: z.string().max(120), entityType: z.enum(['individual', 'company', 'trust']), financialYear: z.number().int(),
  request: z.object({
    lineId: z.string().max(80), label: z.string().max(200), category: z.string().max(80), question: z.string().max(4000), reason: z.string().max(4000),
    component: z.string().max(80), basis: z.string().max(80), currency: z.string().max(10),
    priorAmountAud: z.string().max(30).nullable(), comparisonAud: z.string().max(30).nullable(),
    evidence: z.array(z.object({ documentId: z.string().max(120), amountAud: z.string().max(30).nullable(), description: z.string().max(4000) })).max(200),
    answer: z.string().max(4000), reviewNote: z.string().max(4000),
  }),
  lines: z.array(z.object({ lineId: z.string().max(80), label: z.string().max(200), category: z.string().max(80), component: z.string().max(80), requestText: z.string().max(4000) })).max(200).optional(),
  text: z.string().max(MAX_TEXT).optional(),
});
export type AssistContext = z.infer<typeof assistContextSchema>;
export const assistRequestSchema = z.object({ task: z.enum(TASKS), context: assistContextSchema });

export function buildContext(request: CollectionRequest, baseline: Baseline, text?: string): AssistContext {
  const cleaned = text?.trim();
  if (cleaned !== undefined && cleaned.length > MAX_TEXT) throw new Error(`Pasted text is limited to ${MAX_TEXT.toLocaleString('en-AU')} characters.`);
  return {
    entityName: baseline.entityName, entityType: baseline.entityType, financialYear: request.financialYear,
    request: {
      lineId: request.lineId, label: request.label, category: request.category, question: request.question, reason: request.reason,
      component: request.component, basis: request.basis, currency: request.currency,
      priorAmountAud: money(request.priorAmountCents), comparisonAud: money(request.comparisonCents),
      evidence: request.evidence.map(e => ({ documentId: e.documentId, amountAud: money(e.amountCents), description: e.description })),
      answer: request.answer, reviewNote: request.reviewNote,
    },
    lines: baseline.lines.map(l => ({ lineId: l.id, label: l.label, category: l.category, component: l.component, requestText: l.requestText })),
    text: cleaned || undefined,
  };
}

const SYSTEM = `You assist an Australian tax adviser preparing a family group's FY2026 compliance pack. All data is SYNTHETIC demonstration data. The financial year runs 1 July 2025 to 30 June 2026.
You only PROPOSE. A human adviser reviews and accepts or rejects every item. Do not give tax advice or conclusions.
Do not invent amounts, documents, dates or facts. Every item must cite its basis as short quotes from the supplied context; if the context does not support an item, omit it. Use null for unknown amounts.
Prior-year amounts are comparatives only and are never current-year evidence.
Reply with ONLY a JSON object of the form {"items":[...]} — no prose, no markdown.`;

const TASK_PROMPTS: Record<AssistTask, string> = {
  follow_up: 'Draft ONE concise adviser follow-up message for the client about this request: what is still missing or inconsistent and exactly what to send. Plain language, no jargon, under 120 words. Items: {"text": string, "basis": string[]}.',
  extract: 'From the pasted statement text, extract evidence rows that belong to THIS request only (same component). One row per source document or statement line. amount is the AUD amount as a string with up to two decimals, or null if not stated. documentId is a short stable label taken from the text (issuer and period). quote is the exact text supporting the amount. Items: {"documentId": string, "amount": string|null, "description": string, "quote": string}.',
  reword: 'Propose ONE improved wording of the client question for this request: specific to this entity and component, names the documents that usually evidence it, keeps the "FY2026:" prefix. Under 60 words. Items: {"question": string, "basis": string[]}.',
  triage: 'The client answered the "What changed?" question. Propose additional evidence requests the adviser should consider, one per distinct change, skipping anything already covered by the existing lines. Items: {"label": string (under 80 chars), "note": string (what to obtain and why), "basis": string[]}. Return an empty items array if nothing new is indicated.',
};

export function buildMessages(task: AssistTask, context: AssistContext) {
  const { text, lines, ...rest } = context;
  const payload: Record<string, unknown> = { ...rest };
  if (task === 'triage') payload.existingLines = lines;
  if (task === 'extract' || task === 'triage') payload[task === 'extract' ? 'pastedText' : 'clientAnswer'] = text ?? '';
  return [
    { role: 'system' as const, content: SYSTEM },
    { role: 'user' as const, content: `${TASK_PROMPTS[task]}\n\nContext (JSON):\n${JSON.stringify(payload, null, 1)}\n\nReturn {"items":[...]} only.` },
  ];
}

export function parseReply(task: AssistTask, content: string): ProposalItem[] {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = trimmed.indexOf('{'); const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Model reply did not contain a JSON object.');
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed.slice(start, end + 1)); }
  catch { throw new Error('Model reply was not valid JSON.'); }
  return z.object({ items: z.array(itemSchemas[task]).max(MAX_ITEMS) }).parse(parsed).items;
}

export function applyProposalItem(state: Workspace, request: CollectionRequest, proposal: Proposal, index: number): Workspace {
  const item = proposal.items[index];
  if (!item) throw new Error('Proposal item not found.');
  const detail = `${proposal.task} proposal accepted by adviser (model ${proposal.model}, prompt ${proposal.promptVersion}).`;
  let next: Workspace;
  switch (proposal.task) {
    case 'follow_up': {
      const { text } = itemSchemas.follow_up.parse(item);
      next = reviewRequest(state, request.id, 'follow_up', text); break;
    }
    case 'extract': {
      const row = itemSchemas.extract.parse(item);
      if (!proposal.sourceHash) throw new Error('Extracted rows need the hash of the pasted text.');
      next = receiveEvidence(state, request.id, {
        documentId: row.documentId, lineId: request.lineId, entityId: request.entityId, financialYear: request.financialYear,
        component: request.component, currency: request.currency, basis: request.basis, amountCents: parseMoney(row.amount),
        description: row.quote ? `${row.description} — "${row.quote}"` : row.description, filename: 'pasted-text', fileHash: proposal.sourceHash,
      }); break;
    }
    case 'reword': {
      const { question } = itemSchemas.reword.parse(item);
      next = rewordRequest(state, request.id, question); break;
    }
    case 'triage': {
      const { label, note } = itemSchemas.triage.parse(item);
      next = addPlanningRequest(state, request.entityId, label, note); break;
    }
  }
  return logEvent(next, request.entityId, 'ai_proposal_accepted', detail);
}

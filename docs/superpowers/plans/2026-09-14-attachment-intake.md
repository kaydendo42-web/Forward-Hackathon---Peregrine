# Attachment Intake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A family reply's photo or PDF attachment is downloaded, read by a vision model, proposed as evidence on a specific entity and request line, code-checked, and linked only when an adviser accepts it.

**Architecture:** Pure core in `src/lib/intake.ts` (context, prompt, parsing, flags, apply/reject) with zod schemas that `storage.ts` reuses. Server pieces are `downloadGmailAttachment` in the existing IMAP reader, `intake-server.ts` for image shrinking / PDF text / hashing / NIM call, and a gated `POST /api/intake` route mirroring `/api/assist`. The browser calls the route once per attachment, keeps the original bytes in IndexedDB by SHA-256, stores the proposal in `Workspace.intake`, and renders a review card in the Inbox panel whose Accept calls the existing `receiveEvidence`.

**Tech Stack:** Next.js 16.3.5 route handlers (Node runtime), zod 4, ImapFlow 2, `sharp` 0.35.4 (already installed transitively; add as a direct dependency), `pdf-parse` 2.4.5 (new), Vitest 5, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-14-attachment-intake-design.md`

## Global Constraints

- Branch: `feat/attachment-intake` (off `feat/compliance-demo`). Do not touch Jason's `feat/jason-guidance-agent` files or `guidance/`.
- All type/schema changes are additive and optional: `Workspace.intake?: IntakeProposal[]`; storage uses `.optional()`, never `.default([])` (an old workspace must round-trip byte-for-byte; see `tests/storage.test.ts`).
- Nothing the model returns is applied without an explicit adviser action. Proposals with a name mismatch or invalid target are shown, never discarded.
- Route order of checks: 503 (unconfigured) → `gate()` 401/403 → 400 body → download errors 404/413/415/502/504 → prepare 422 → model 502/503/504 → 200.
- Route budget: `maxDuration = 60`, one shared 54 s `AbortController` deadline, one retry on unparseable JSON, HTTP 429 → 503 without retry. No server-side logging of content, filenames, message IDs or model output. `cache-control: no-store` (via `json()` in `gate.ts`).
- Env: `NVIDIA_NIM_API_KEY`, `NVIDIA_NIM_MODEL`, `NVIDIA_NIM_VISION_MODEL` (new; `meta/llama-3.2-11b-vision-instruct`), `AI_ASSIST_PASSCODE`, `SMTP_USER`, `SMTP_PASS`, `OUTREACH_ALLOWED_RECIPIENTS`.
- Attachment limits: 8 MB raw; declared and sniffed type must both be `image/jpeg`, `image/png` or `application/pdf`. Image base64 sent to NIM ≤ 170 KB. PDF text ≥ 200 non-whitespace chars else 422; bounded to 20,000 chars, first 20 pages.
- Bounds: `documents` ≤ 10 per proposal, `amounts` ≤ 30 per document, short strings ≤ 300, `reason`/`note` ≤ 1000, `Workspace.intake` ≤ 500.
- `PROMPT_VERSION = 'intake-1'`. Audit actions: `intake_read`, `intake_accepted`, `intake_rejected`.
- Status is conveyed with text, never colour alone. Loading and failure never resemble success. Client-view simulation hides all intake UI.
- Commit after every task with a Conventional Commit subject. Run `npm test` and `npm run typecheck` before each commit. Commit trailer:

```
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JJMTv5Ttp85umAbXepaLQD
```

## File map

| File | Responsibility |
|---|---|
| `src/core/types.ts` | Add `IntakeFlags`, `IntakeDocument`, `IntakeProposal`, `Workspace.intake?` |
| `src/lib/intake.ts` | Pure: schemas, `parseIntakeAmount`, `parseIntakeReply`, `buildIntakeContext`, `buildIntakeMessages`, `verifyIntake`, `recordIntakeProposal`, `applyIntakeDocument`, `rejectIntakeProposal`, `linkedRequestFor` |
| `src/lib/storage.ts` | Mirror `intake` on the workspace schema |
| `src/lib/inbox-reader.ts` | `downloadGmailAttachment`; `inspectStructure` also returns part ids; error codes extended |
| `src/lib/intake-server.ts` | `sniffType`, `sha256Hex`, `prepareImage`, `preparePdf`, `completeChat`, `IntakePrepareError` |
| `src/app/api/intake/route.ts` | Gated proxy |
| `src/lib/intake-client.ts` | `readAttachment` browser call, hash check, `keepOriginal` |
| `src/components/intake-review.tsx` | One proposal card |
| `src/components/inbox-panel.tsx` | "Read N attachments" button, cards under each reply |
| `src/components/workspace.tsx` | `readAttachments` loop with progress |
| `src/app/globals.css` | `.intake-*` classes |
| `tests/intake.test.ts`, `tests/intake-server.test.ts`, `tests/intake-route.test.ts`, `tests/inbox-reader.test.ts` (extend), `tests/intake.spec.ts` | Tests |
| `tests/fixtures/intake/` | `statement.jpg` (shrunk demo bank statement), generated in Task 5 |
| `README.md`, `.env.example`, `PICKUP.md` | Docs |

---

### Task 1: Types, amount parsing and reply parsing

**Files:**
- Modify: `src/core/types.ts` (append after `GuidanceProposal`-free area — this branch does not have Jason's types; append after `InboxReceipt`)
- Create: `src/lib/intake.ts`
- Test: `tests/intake.test.ts`

**Interfaces:**
- Produces: `IntakeFlags`, `IntakeDocument`, `IntakeProposal` types; `Workspace.intake?: IntakeProposal[]`; `PROMPT_VERSION`, `MAX_DOCUMENTS`, `MAX_AMOUNTS`, `intakeDocumentSchema`, `intakeProposalSchema`, `RawIntakeDocument`, `parseIntakeAmount(raw: unknown): number | null`, `parseIntakeReply(content: string): RawIntakeDocument[]`.

- [ ] **Step 1: Add the types**

Append to `src/core/types.ts` after `export type InboxReceipt = …;`:

```ts
export type IntakeFlags = {
  nameMatch: 'match' | 'partial' | 'mismatch';   // entityNameSeen vs the proposed entity's name
  periodInYear: boolean;                         // both dates inside the request's financial year, or dates unreadable
  syntheticMarker: boolean;                      // a synthetic/fictional marker was seen on the page
  targetValid: boolean;                          // proposed request exists, belongs to proposed entity, review still pending
};
/** One document the model saw in one attachment. `flags` is filled by code, never by the model. */
export type IntakeDocument = {
  docType: string; entityNameSeen: string; periodStart: string; periodEnd: string;
  amounts: { label: string; amountCents: number | null }[];
  proposedEntityId: string; proposedRequestId: string;
  confidence: 'high' | 'medium' | 'low'; reason: string;
  flags: IntakeFlags;
};
/** A read attachment awaiting adviser review. Bytes live in IndexedDB under `fileHash`. */
export type IntakeProposal = {
  id: string; messageId: string; attachmentIndex: number; filename: string; contentType: string;
  size: number; fileHash: string; model: string; promptVersion: string; createdAt: string;
  source: 'image' | 'pdf_text';
  documents: IntakeDocument[];
  review: { status: 'pending' | 'accepted' | 'rejected'; decidedAt: string; note: string };
};
```

And in `Workspace` add the last field:

```ts
export type Workspace = {
  schemaVersion: 1; version: number; baselines: Baseline[]; requests: CollectionRequest[];
  outbox: Draft[]; audit: AuditEvent[]; inbox: InboxMessage[]; inboxReceipts: InboxReceipt[];
  // Absent in workspaces saved before attachment intake existed.
  intake?: IntakeProposal[];
};
```

- [ ] **Step 2: Write the failing tests**

Create `tests/intake.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseIntakeAmount, parseIntakeReply } from '../src/lib/intake';

describe('parseIntakeAmount', () => {
  it('reads printed money forms into integer cents', () => {
    expect(parseIntakeAmount('$108,125.00')).toBe(10812500);
    expect(parseIntakeAmount('1,325.00')).toBe(132500);
    expect(parseIntakeAmount('(5,000.00)')).toBe(-500000);
    expect(parseIntakeAmount('-175.00')).toBe(-17500);
    expect(parseIntakeAmount('AUD 1,200')).toBe(120000);
    expect(parseIntakeAmount(108125)).toBe(10812500);
    expect(parseIntakeAmount(12.5)).toBe(1250);
  });
  it('returns null for unreadable or absurd values', () => {
    expect(parseIntakeAmount('')).toBeNull();
    expect(parseIntakeAmount('n/a')).toBeNull();
    expect(parseIntakeAmount('12.345')).toBeNull();
    expect(parseIntakeAmount(null)).toBeNull();
    expect(parseIntakeAmount('1'.repeat(13))).toBeNull();
    expect(parseIntakeAmount(Number.NaN)).toBeNull();
  });
});

describe('parseIntakeReply', () => {
  const reply = `Sure, here is the JSON output for the image:

{"documents":[{"docType":"Trust Account Statement","entityNameSeen":"Oakwood Family Trust","periodStart":"1 June 2026","periodEnd":"30 June 2026","keyAmounts":[{"label":"Closing Balance","amount":"$108,125.00"}],"proposedEntityId":"taylor-family-trust","proposedRequestId":"taylor-family-trust:2026:TR-BANK","confidence":"medium","reason":"Bank statement for a trust","syntheticMarker":true}]}.`;

  it('extracts the JSON block from prose and coerces amounts', () => {
    const docs = parseIntakeReply(reply);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ docType: 'Trust Account Statement', entityNameSeen: 'Oakwood Family Trust', proposedRequestId: 'taylor-family-trust:2026:TR-BANK', confidence: 'medium', syntheticMarker: true });
    expect(docs[0].amounts).toEqual([{ label: 'Closing Balance', amountCents: 10812500 }]);
  });
  it('accepts "amounts" as well as "keyAmounts" and defaults missing fields', () => {
    const docs = parseIntakeReply('{"documents":[{"docType":"Resolution","amounts":[{"label":"x","amount":null}]}]}');
    expect(docs[0]).toMatchObject({ entityNameSeen: '', periodStart: '', proposedEntityId: '', confidence: 'low', syntheticMarker: false });
    expect(docs[0].amounts).toEqual([{ label: 'x', amountCents: null }]);
  });
  it('rejects replies without a JSON object or without documents', () => {
    expect(() => parseIntakeReply('No documents here.')).toThrow(/no JSON/i);
    expect(() => parseIntakeReply('{"items":[]}')).toThrow();
    expect(() => parseIntakeReply('{"documents": "nope"}')).toThrow();
  });
  it('caps documents and amounts', () => {
    const many = JSON.stringify({ documents: Array.from({ length: 12 }, () => ({ docType: 'x', amounts: [] })) });
    expect(() => parseIntakeReply(many)).toThrow();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/intake.test.ts`
Expected: FAIL — cannot resolve `../src/lib/intake`.

- [ ] **Step 4: Create `src/lib/intake.ts` with the parsing half**

```ts
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
const rawDocumentSchema = z.object({
  docType: lenient(300), entityNameSeen: lenient(300), periodStart: lenient(300), periodEnd: lenient(300),
  amounts: z.array(z.object({ label: lenient(300), amount: z.union([z.string(), z.number(), z.null()]).catch(null) })).max(MAX_AMOUNTS).optional(),
  keyAmounts: z.array(z.object({ label: lenient(300), amount: z.union([z.string(), z.number(), z.null()]).catch(null) })).max(MAX_AMOUNTS).optional(),
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/intake.test.ts`
Expected: PASS (8 tests). Also `npm run typecheck` passes.

- [ ] **Step 6: Commit**

```bash
git add src/core/types.ts src/lib/intake.ts tests/intake.test.ts
git commit -m "feat(intake): proposal types and model reply parsing"
```

---

### Task 2: Context, prompt and code-side verification

**Files:**
- Modify: `src/lib/intake.ts`
- Test: `tests/intake.test.ts`

**Interfaces:**
- Consumes: `RawIntakeDocument`, `MAX_DOCUMENTS` from Task 1.
- Produces: `IntakeContext`, `intakeContextSchema`, `buildIntakeContext(state: Workspace): IntakeContext`, `IntakeInput`, `ChatMessage`, `buildIntakeMessages(context: IntakeContext, input: IntakeInput): ChatMessage[]`, `verifyIntake(documents: RawIntakeDocument[], context: IntakeContext): IntakeDocument[]`, `financialYearOf(context, requestId): number`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/intake.test.ts` (add `buildIntakeContext, buildIntakeMessages, verifyIntake` to the import, plus `import * as workflow from '../src/core/workflow'; import { baseline } from './fixtures'; import type { Baseline } from '../src/core/types';`):

```ts
const trust: Baseline = {
  workbookId: 'FY25-taylor-family-trust', entityId: 'taylor-family-trust', entityName: 'Taylor Family Trust', entityType: 'trust',
  financialYear: 2025, baselineVersion: 1, synthetic: true,
  lines: [{ id: 'TR-BANK', category: 'bank', label: 'Trust bank balance', component: 'closing_balance', amountCents: 10000000,
    currency: 'AUD', basis: 'closing_balance', sourceRef: 'FY25-BANK', requestText: 'Provide the 30 June trust bank statement.', recurrence: 'annual' }],
};
function family() {
  let s = workflow.importBaseline(workflow.createWorkspace(), baseline);
  s = workflow.importBaseline(s, trust);
  s = workflow.startSeason(s, 'alex-taylor');
  return workflow.startSeason(s, 'taylor-family-trust');
}
const TR_BANK = 'taylor-family-trust:2026:TR-BANK';
const ALE_DIV = 'alex-taylor:2026:ALE-DIV-CASH';

describe('buildIntakeContext', () => {
  it('lists entities and only open, unpaused requests without evidence or answers', () => {
    let s = family();
    s = workflow.pauseRequest(s, ALE_DIV, true);
    const ctx = buildIntakeContext(s);
    expect(ctx.entities.map(e => e.entityId)).toEqual(['alex-taylor', 'taylor-family-trust']);
    expect(ctx.requests.map(r => r.id)).not.toContain(ALE_DIV);
    expect(ctx.requests.find(r => r.id === TR_BANK)).toMatchObject({ entityId: 'taylor-family-trust', lineId: 'TR-BANK', component: 'closing_balance', financialYear: 2026 });
    expect(JSON.stringify(ctx)).not.toMatch(/"(evidence|answer|reviewNote|comparisonCents)":/);
  });
});

describe('buildIntakeMessages', () => {
  it('sends the image as an image_url part and the context as JSON', () => {
    const msgs = buildIntakeMessages(buildIntakeContext(family()), { kind: 'image', jpegBase64: 'AAAA' });
    expect(msgs[0].role).toBe('system');
    expect(msgs[0].content).toMatch(/synthetic/i);
    const user = msgs[1].content as { type: string; text?: string; image_url?: { url: string } }[];
    expect(user.find(p => p.type === 'image_url')?.image_url?.url).toBe('data:image/jpeg;base64,AAAA');
    expect(user.find(p => p.type === 'text')?.text).toContain(TR_BANK);
  });
  it('sends extracted PDF text inline', () => {
    const msgs = buildIntakeMessages(buildIntakeContext(family()), { kind: 'text', text: 'Closing balance 108,125.00' });
    expect(typeof msgs[1].content).toBe('string');
    expect(msgs[1].content).toContain('Closing balance 108,125.00');
  });
});

describe('verifyIntake', () => {
  const ctx = buildIntakeContext(family());
  const raw = (over: Partial<import('../src/lib/intake').RawIntakeDocument> = {}) => ({
    docType: 'Bank statement', entityNameSeen: 'Taylor Family Trust', periodStart: '1 June 2026', periodEnd: '30 June 2026',
    amounts: [], proposedEntityId: 'taylor-family-trust', proposedRequestId: TR_BANK, confidence: 'high' as const, reason: '', syntheticMarker: false, ...over,
  });
  it('flags an exact name, in-year period and valid target', () => {
    expect(verifyIntake([raw()], ctx)[0].flags).toEqual({ nameMatch: 'match', periodInYear: true, syntheticMarker: false, targetValid: true });
  });
  it('flags Oakwood as a mismatch and keeps the document', () => {
    const [doc] = verifyIntake([raw({ entityNameSeen: 'Oakwood Family Trust' })], ctx);
    expect(doc.flags.nameMatch).toBe('mismatch');
    expect(doc.entityNameSeen).toBe('Oakwood Family Trust');
  });
  it('flags a shared surname as partial', () => {
    expect(verifyIntake([raw({ entityNameSeen: 'Alex Taylor' })], ctx)[0].flags.nameMatch).toBe('partial');
  });
  it('matches against every entity when the proposed entity is empty, and the target is then invalid', () => {
    const [doc] = verifyIntake([raw({ proposedEntityId: '', proposedRequestId: '', entityNameSeen: 'alex taylor' })], ctx);
    expect(doc.flags).toMatchObject({ nameMatch: 'match', targetValid: false });
  });
  it('flags a request under another entity or a reviewed request as invalid', () => {
    expect(verifyIntake([raw({ proposedRequestId: ALE_DIV })], ctx)[0].flags.targetValid).toBe(false);
    const reviewed = workflow.reviewRequest(family(), TR_BANK, 'accepted', 'done');
    expect(verifyIntake([raw()], buildIntakeContext(reviewed))[0].flags.targetValid).toBe(false);
  });
  it('flags periods outside FY2026 and treats unreadable dates as in-year', () => {
    expect(verifyIntake([raw({ periodStart: '1 July 2024', periodEnd: '30 June 2025' })], ctx)[0].flags.periodInYear).toBe(false);
    expect(verifyIntake([raw({ periodStart: '30/06/2026', periodEnd: '30/06/2026' })], ctx)[0].flags.periodInYear).toBe(true);
    expect(verifyIntake([raw({ periodStart: 'June', periodEnd: '' })], ctx)[0].flags.periodInYear).toBe(true);
  });
  it('sets the synthetic flag from the model or from the text it read', () => {
    expect(verifyIntake([raw({ syntheticMarker: true })], ctx)[0].flags.syntheticMarker).toBe(true);
    expect(verifyIntake([raw({ docType: 'SYNTHETIC DEMO statement' })], ctx)[0].flags.syntheticMarker).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/intake.test.ts`
Expected: FAIL — `buildIntakeContext` is not exported.

- [ ] **Step 3: Implement**

Append to `src/lib/intake.ts` (add `Workspace` to the type import):

```ts
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
```

Add `IntakeFlags` to the type import at the top of the file.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/intake.test.ts`
Expected: PASS. `npm run typecheck` passes.

- [ ] **Step 5: Commit**

```bash
git add src/lib/intake.ts tests/intake.test.ts
git commit -m "feat(intake): context, prompt and code-side proposal checks"
```

---

### Task 3: Record, accept, reject; storage round-trip

**Files:**
- Modify: `src/lib/intake.ts`, `src/lib/storage.ts:1-30`
- Test: `tests/intake.test.ts`, `tests/storage.test.ts`

**Interfaces:**
- Consumes: `receiveEvidence`, `logEvent` from `src/core/workflow.ts`; `intakeProposalSchema` from Task 1.
- Produces: `recordIntakeProposal(state, proposal: IntakeProposal): Workspace`, `applyIntakeDocument(state, proposalId: string, docIndex: number, choice: { requestId: string; amountCents: number | null; description: string }): Workspace`, `rejectIntakeProposal(state, proposalId: string, note: string): Workspace`, `linkedRequestFor(state, proposal, docIndex): CollectionRequest | undefined`, `intakeDocumentId(fileHash, docIndex): string`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/intake.test.ts` (extend the import with `applyIntakeDocument, intakeDocumentId, linkedRequestFor, recordIntakeProposal, rejectIntakeProposal` and `import type { IntakeProposal } from '../src/core/types'`):

```ts
const HASH = 'a'.repeat(64);
function proposal(over: Partial<IntakeProposal> = {}): IntakeProposal {
  const ctx = buildIntakeContext(family());
  return {
    id: 'intake-1', messageId: '<reply-1@example.com>', attachmentIndex: 0, filename: 'statement.jpg', contentType: 'image/jpeg', size: 1234,
    fileHash: HASH, model: 'meta/llama-3.2-11b-vision-instruct', promptVersion: 'intake-1', createdAt: '2026-09-14T00:00:00.000Z', source: 'image',
    documents: verifyIntake([{ docType: 'Bank statement', entityNameSeen: 'Taylor Family Trust', periodStart: '1 June 2026', periodEnd: '30 June 2026',
      amounts: [{ label: 'Closing Balance', amountCents: 10812500 }], proposedEntityId: 'taylor-family-trust', proposedRequestId: TR_BANK,
      confidence: 'high', reason: 'Trust bank statement', syntheticMarker: true }], ctx),
    review: { status: 'pending', decidedAt: '', note: '' }, ...over,
  };
}

describe('recordIntakeProposal', () => {
  it('stores a validated proposal and logs a read event without applying anything', () => {
    const base = family();
    const next = recordIntakeProposal(base, proposal());
    expect(next.intake).toHaveLength(1);
    expect(next.version).toBe(base.version + 1);
    expect(next.audit.at(-1)).toMatchObject({ action: 'intake_read', entityId: 'taylor-family-trust' });
    expect(next.requests.find(r => r.id === TR_BANK)!.evidence).toEqual([]);
  });
  it('replaces an earlier pending proposal for the same attachment', () => {
    let s = recordIntakeProposal(family(), proposal({ id: 'intake-1' }));
    s = recordIntakeProposal(s, proposal({ id: 'intake-2' }));
    expect(s.intake!.map(p => p.id)).toEqual(['intake-2']);
  });
  it('rejects an invalid proposal', () => {
    expect(() => recordIntakeProposal(family(), proposal({ fileHash: 'nope' }))).toThrow();
  });
});

describe('applyIntakeDocument', () => {
  it('links evidence on the chosen request using that request\'s own fields and logs the acceptance', () => {
    const s = recordIntakeProposal(family(), proposal());
    const next = applyIntakeDocument(s, 'intake-1', 0, { requestId: TR_BANK, amountCents: 10812500, description: 'Bank statement — Taylor Family Trust — June 2026' });
    const req = next.requests.find(r => r.id === TR_BANK)!;
    expect(req.evidence).toHaveLength(1);
    expect(req.evidence[0]).toMatchObject({ documentId: intakeDocumentId(HASH, 0), lineId: 'TR-BANK', entityId: 'taylor-family-trust', financialYear: 2026,
      component: 'closing_balance', basis: 'closing_balance', currency: 'AUD', amountCents: 10812500, filename: 'statement.jpg', fileHash: HASH });
    expect(next.intake![0].review.status).toBe('accepted');
    expect(next.audit.at(-1)).toMatchObject({ action: 'intake_accepted' });
    expect(next.audit.at(-1)!.detail).toMatch(/meta\/llama-3.2-11b-vision-instruct/);
    expect(next.audit.at(-1)!.detail).toMatch(/intake-1/);
    expect(linkedRequestFor(next, next.intake![0], 0)?.id).toBe(TR_BANK);
  });
  it('records an adviser override when the target differs from the model\'s proposal', () => {
    const s = recordIntakeProposal(family(), proposal());
    const next = applyIntakeDocument(s, 'intake-1', 0, { requestId: ALE_DIV, amountCents: null, description: 'Moved by adviser' });
    expect(next.audit.at(-1)!.detail).toMatch(/override/i);
    expect(next.requests.find(r => r.id === ALE_DIV)!.evidence[0].amountCents).toBeNull();
  });
  it('surfaces workflow errors unchanged (closing balance conflict)', () => {
    let s = recordIntakeProposal(family(), proposal());
    s = applyIntakeDocument(s, 'intake-1', 0, { requestId: TR_BANK, amountCents: 10812500, description: 'first' });
    const second = recordIntakeProposal(s, proposal({ id: 'intake-2', attachmentIndex: 1, fileHash: 'b'.repeat(64) }));
    expect(() => applyIntakeDocument(second, 'intake-2', 0, { requestId: TR_BANK, amountCents: 100, description: 'second' })).toThrow(/closing balance/i);
  });
  it('refuses a rejected proposal, an unknown document or an empty description', () => {
    const s = rejectIntakeProposal(recordIntakeProposal(family(), proposal()), 'intake-1', 'wrong family');
    expect(() => applyIntakeDocument(s, 'intake-1', 0, { requestId: TR_BANK, amountCents: null, description: 'x' })).toThrow(/rejected/i);
    const open = recordIntakeProposal(family(), proposal());
    expect(() => applyIntakeDocument(open, 'intake-1', 3, { requestId: TR_BANK, amountCents: null, description: 'x' })).toThrow(/document/i);
    expect(() => applyIntakeDocument(open, 'intake-1', 0, { requestId: TR_BANK, amountCents: null, description: '  ' })).toThrow();
  });
});

describe('rejectIntakeProposal', () => {
  it('marks the proposal rejected with the note and logs it', () => {
    const next = rejectIntakeProposal(recordIntakeProposal(family(), proposal()), 'intake-1', 'Belongs to another client');
    expect(next.intake![0].review).toMatchObject({ status: 'rejected', note: 'Belongs to another client' });
    expect(next.intake![0].review.decidedAt).not.toBe('');
    expect(next.audit.at(-1)).toMatchObject({ action: 'intake_rejected' });
  });
});
```

Append to `tests/storage.test.ts`. The file already imports `parseSavedWorkspace`, `createWorkspace`, `importBaseline`, `startSeason` and `baseline` and uses bare `it(...)`; add `import { buildIntakeContext, recordIntakeProposal, verifyIntake } from '../src/lib/intake';`:

```ts
it('round-trips a workspace with intake proposals and leaves one without them unchanged', () => {
  const base = startSeason(importBaseline(createWorkspace(), baseline), 'alex-taylor');
  const plain = parseSavedWorkspace(JSON.stringify(base));
  expect('intake' in plain).toBe(false);
  const ctx = buildIntakeContext(base);
  const withIntake = recordIntakeProposal(base, {
    id: 'intake-1', messageId: '<m@example.com>', attachmentIndex: 0, filename: 'a.jpg', contentType: 'image/jpeg', size: 1, fileHash: 'c'.repeat(64),
    model: 'm', promptVersion: 'intake-1', createdAt: '2026-09-14T00:00:00.000Z', source: 'image',
    documents: verifyIntake([{ docType: 'x', entityNameSeen: 'Alex Taylor', periodStart: '', periodEnd: '', amounts: [], proposedEntityId: 'alex-taylor',
      proposedRequestId: 'alex-taylor:2026:ALE-DIV-CASH', confidence: 'low', reason: '', syntheticMarker: false }], ctx),
    review: { status: 'pending', decidedAt: '', note: '' },
  });
  expect(parseSavedWorkspace(JSON.stringify(withIntake))).toEqual(withIntake);
  expect(() => parseSavedWorkspace(JSON.stringify({ ...withIntake, intake: [{ id: 'bad' }] }))).toThrow();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/intake.test.ts tests/storage.test.ts`
Expected: FAIL — missing exports / unknown key `intake` stripped by the storage schema.

- [ ] **Step 3: Implement the transitions**

Append to `src/lib/intake.ts` (add `import { logEvent, receiveEvidence } from '../core/workflow';` and `CollectionRequest`, `EvidenceInput` to the type import):

```ts
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
```

- [ ] **Step 4: Mirror the schema in storage**

In `src/lib/storage.ts` add `import { intakeProposalSchema } from './intake';` and, on the `schema` object after the `audit` line, add:

```ts
  // Optional, not defaulted: workspaces saved before intake still load, and one without
  // proposals round-trips unchanged rather than gaining an empty array.
  intake: z.array(intakeProposalSchema).max(500).optional(),
```

Check `intake.ts` does not import `storage.ts` (it must not — circular).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: all pass (existing 93 + new). `npm run typecheck` passes.

- [ ] **Step 6: Commit**

```bash
git add src/lib/intake.ts src/lib/storage.ts tests/intake.test.ts tests/storage.test.ts
git commit -m "feat(intake): record, accept and reject proposals; persist intake"
```

---

### Task 4: Download one attachment from the firm mailbox

**Files:**
- Modify: `src/lib/inbox-reader.ts` (`InboxReadError`, `inspectStructure`, new export)
- Test: `tests/inbox-reader.test.ts`

**Interfaces:**
- Produces: `downloadGmailAttachment(config: { user; pass; allowedSenders }, messageId: string, index: number, deps?: ReaderDependencies): Promise<{ filename: string; contentType: string; bytes: Buffer }>`; `InboxReadError.code` gains `'not_found' | 'too_large' | 'unsupported_type'`; `MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024`; `ALLOWED_ATTACHMENT_TYPES`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/inbox-reader.test.ts` (add `downloadGmailAttachment, InboxReadError` to the import). Extend `SeedMessage` with `parts?: Record<string, Buffer>` and make `FakeInboxClient.download` serve binary parts when present:

```ts
  async download(uid: number, part: string, options?: { maxBytes?: number }): ReturnType<InboxClient['download']> {
    this.downloads.push({ uid, part, maxBytes: options?.maxBytes });
    const seed = this.seeds.find(seed => seed.uid === uid);
    const binary = seed?.parts?.[part];
    if (binary) {
      const limited = options?.maxBytes ? binary.subarray(0, options.maxBytes) : binary;
      return { meta: { expectedSize: binary.length, contentType: 'application/octet-stream' }, content: Readable.from([limited]) };
    }
    const text = seed?.text ?? '';
    return { meta: { expectedSize: Buffer.byteLength(text), contentType: 'text/plain', charset: 'utf-8' }, content: Readable.from([Buffer.from(text)]) };
  }
```

Then the tests:

```ts
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 1)]);
const multipart: BodyNode = { type: 'multipart/mixed', childNodes: [
  { part: '1', type: 'text/plain', size: 20 },
  { part: '2', type: 'image/jpeg', size: JPEG.length, disposition: 'attachment', dispositionParameters: { filename: 'statement.jpg' } },
  { part: '3', type: 'application/zip', size: 10, disposition: 'attachment', dispositionParameters: { filename: 'x.zip' } },
] };
function downloadWith(fake: FakeInboxClient, messageId = '<msg-7@example.com>', index = 0) {
  return downloadGmailAttachment(
    { user: 'adviser@example.com', pass: 'app-password', allowedSenders: 'family@example.com' }, messageId, index,
    { createClient: () => fake, now: () => NOW, timeoutMs: 1_000 },
  );
}

describe('downloadGmailAttachment', () => {
  // Attachment indexes count attachments only: part 2 (jpeg) is index 0, part 3 (zip) is index 1.
  it('finds the message by id, checks the sender, and returns the nth attachment bytes read-only', async () => {
    const fake = new FakeInboxClient({} as InboxClientOptions, [message({ uid: 7, bodyStructure: multipart, parts: { '2': JPEG } })]);
    const result = await downloadWith(fake);
    expect(result).toMatchObject({ filename: 'statement.jpg', contentType: 'image/jpeg' });
    expect(Buffer.compare(result.bytes, JPEG)).toBe(0);
    expect(fake.searches[0]).toEqual({ header: { 'message-id': '<msg-7@example.com>' } });
    expect(fake.downloads).toEqual([{ uid: 7, part: '2', maxBytes: 8 * 1024 * 1024 + 1 }]);
    expect(fake.opened).toEqual([{ path: 'INBOX', readOnly: true }]);
    expect(fake.loggedOut).toBe(true);
    expect([...fake.flags]).toEqual(['\\Seen']);
  });
  it('not_found when the id is unknown, the sender is not allowed, or the message is too old', async () => {
    const empty = new FakeInboxClient({} as InboxClientOptions, [], []);
    await expect(downloadWith(empty)).rejects.toMatchObject({ code: 'not_found' });
    const stranger = new FakeInboxClient({} as InboxClientOptions, [message({ uid: 7, bodyStructure: multipart, parts: { '2': JPEG }, envelope: { messageId: '<msg-7@example.com>', from: [{ address: 'stranger@example.com' }], date: new Date('2026-09-11T09:00:00.000Z') } })]);
    await expect(downloadWith(stranger)).rejects.toMatchObject({ code: 'not_found' });
    const old = new FakeInboxClient({} as InboxClientOptions, [message({ uid: 7, bodyStructure: multipart, parts: { '2': JPEG }, internalDate: new Date('2026-07-01T00:00:00.000Z') })]);
    await expect(downloadWith(old)).rejects.toMatchObject({ code: 'not_found' });
  });
  it('not_found for an attachment index that does not exist', async () => {
    const fake = new FakeInboxClient({} as InboxClientOptions, [message({ uid: 7, bodyStructure: multipart, parts: { '2': JPEG } })]);
    await expect(downloadWith(fake, '<msg-7@example.com>', 5)).rejects.toMatchObject({ code: 'not_found' });
  });
  it('unsupported_type for a declared type outside the allow-list, before downloading', async () => {
    const fake = new FakeInboxClient({} as InboxClientOptions, [message({ uid: 7, bodyStructure: multipart, parts: { '3': Buffer.alloc(10) } })]);
    await expect(downloadWith(fake, '<msg-7@example.com>', 1)).rejects.toMatchObject({ code: 'unsupported_type' });
    expect(fake.downloads).toEqual([]);
  });
  it('too_large when the declared size or the stream exceeds 8 MB', async () => {
    const big: BodyNode = { type: 'multipart/mixed', childNodes: [{ part: '2', type: 'image/png', size: 9 * 1024 * 1024, disposition: 'attachment', dispositionParameters: { filename: 'huge.png' } }] };
    const declared = new FakeInboxClient({} as InboxClientOptions, [message({ uid: 7, bodyStructure: big })]);
    await expect(downloadWith(declared, '<msg-7@example.com>', 0)).rejects.toMatchObject({ code: 'too_large' });
    expect(declared.downloads).toEqual([]);
    const lying: BodyNode = { type: 'multipart/mixed', childNodes: [{ part: '2', type: 'image/png', size: 10, disposition: 'attachment', dispositionParameters: { filename: 'huge.png' } }] };
    const stream = new FakeInboxClient({} as InboxClientOptions, [message({ uid: 7, bodyStructure: lying, parts: { '2': Buffer.alloc(8 * 1024 * 1024 + 1) } })]);
    await expect(downloadWith(stream, '<msg-7@example.com>', 0)).rejects.toMatchObject({ code: 'too_large' });
  });
  it('times out and closes the connection', async () => {
    const fake = new FakeInboxClient({} as InboxClientOptions, [message({ uid: 7, bodyStructure: multipart, parts: { '2': JPEG } })]);
    fake.connect = () => new Promise(() => {});
    await expect(downloadWith(fake)).rejects.toMatchObject({ code: 'timeout' });
    expect(fake.closed).toBe(true);
  });
});
```

The `message()` helper's `envelope` default must stay as it is; the tests that override `envelope` pass a complete envelope.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/inbox-reader.test.ts`
Expected: FAIL — `downloadGmailAttachment` is not exported.

- [ ] **Step 3: Implement**

In `src/lib/inbox-reader.ts`:

1. Constants, after `DEFAULT_TIMEOUT_MS`:

```ts
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const ALLOWED_ATTACHMENT_TYPES = new Set(['image/jpeg', 'image/png', 'application/pdf']);
```

2. Extend `InboxReadError`:

```ts
export class InboxReadError extends Error {
  constructor(readonly code: 'configuration' | 'provider' | 'timeout' | 'not_found' | 'too_large' | 'unsupported_type') {
    super({
      timeout: 'The inbox check timed out.', configuration: 'Inbox access is not configured.', provider: 'The inbox could not be checked.',
      not_found: 'That attachment was not found among allowed replies from the last 30 days.',
      too_large: 'That attachment is larger than 8 MB.', unsupported_type: 'Only JPEG, PNG and PDF attachments can be read.',
    }[code]);
    this.name = 'InboxReadError';
  }
}
```

3. `inspectStructure` returns part ids alongside attachments. Change the `attachments.push` block to also `parts.push(node.part || '1')` into a new `const parts: string[] = [];`, and return `{ attachments, parts, textPart }`. `collectMessages` ignores `parts`.

4. Extract the client/timeout scaffolding `readGmailInbox` already has into a helper both functions use:

```ts
async function withClient<T>(config: ReaderConfig, dependencies: ReaderDependencies, operation: (client: InboxClient, senders: string[], now: Date) => Promise<T>): Promise<T> {
  const senders = allowedAddresses(config.allowedSenders);
  if (!config.user || !config.pass || !senders.length) throw new InboxReadError('configuration');
  const now = dependencies.now?.() ?? new Date();
  const options: InboxClientOptions = {
    host: 'imap.gmail.com', port: 993, secure: true, logger: false, disableAutoIdle: true,
    auth: { user: config.user, pass: config.pass }, connectionTimeout: 8_000, greetingTimeout: 8_000, socketTimeout: 15_000,
  };
  const client = dependencies.createClient?.(options) ?? new ImapFlow(options);
  client.on?.('error', () => { /* surfaced through the awaited operation; never logged */ });
  const timeoutMs = Math.min(Math.max(1, dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS), DEFAULT_TIMEOUT_MS);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { client.close(); reject(new InboxReadError('timeout')); }, timeoutMs); });
  try {
    return await Promise.race([(async () => {
      await client.connect();
      await client.mailboxOpen('INBOX', { readOnly: true });
      const result = await operation(client, senders, Number.isFinite(now.getTime()) ? now : new Date());
      await client.logout();
      return result;
    })(), deadline]);
  } catch (error) {
    client.close();
    if (error instanceof InboxReadError) throw error;
    throw new InboxReadError('provider');
  } finally {
    if (timer) clearTimeout(timer);
  }
}
```

Rewrite `readGmailInbox` to use it (behaviour identical; existing tests must still pass):

```ts
export async function readGmailInbox(config: ReaderConfig, dependencies: ReaderDependencies = {}): Promise<InboxResult> {
  return withClient(config, dependencies, async (client, senders, now) => ({ messages: await collectMessages(client, senders, now), checkedAt: now.toISOString() }));
}
```

5. The new export:

```ts
async function boundedBytes(stream: NodeJS.ReadableStream & { destroy?: () => void }, limit: number) {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const value of stream) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    bytes += chunk.length;
    if (bytes > limit) { stream.destroy?.(); throw new InboxReadError('too_large'); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}

/** One attachment of one allow-listed reply, by Message-ID and listing index. Read-only; never marks or deletes mail. */
export async function downloadGmailAttachment(config: ReaderConfig, messageId: string, index: number, dependencies: ReaderDependencies = {}) {
  if (!validMessageId(messageId) || !Number.isInteger(index) || index < 0 || index >= MAX_ATTACHMENTS) throw new InboxReadError('not_found');
  return withClient(config, dependencies, async (client, senders, now) => {
    const found = await client.search({ header: { 'message-id': messageId.trim() } }, { uid: true });
    const uids = Array.isArray(found) ? found.filter(uid => Number.isSafeInteger(uid) && uid > 0).slice(0, 5) : [];
    if (!uids.length) throw new InboxReadError('not_found');
    const fetched = await client.fetchAll(uids, { envelope: true, internalDate: true, bodyStructure: true }, { uid: true });
    const allowed = new Set(senders);
    const since = now.getTime() - THIRTY_DAYS_MS;
    const message = fetched.find(m => {
      const from = m.envelope?.from;
      return m.envelope?.messageId?.trim() === messageId.trim() && from?.length === 1 && typeof from[0].address === 'string'
        && allowed.has(from[0].address.trim().toLowerCase()) && receivedTime(m) >= since;
    });
    if (!message) throw new InboxReadError('not_found');
    const { attachments, parts } = inspectStructure(message.bodyStructure);
    const attachment = attachments[index], part = parts[index];
    if (!attachment || !part) throw new InboxReadError('not_found');
    if (!ALLOWED_ATTACHMENT_TYPES.has(attachment.contentType)) throw new InboxReadError('unsupported_type');
    if (attachment.size > MAX_ATTACHMENT_BYTES) throw new InboxReadError('too_large');
    const downloaded = await client.download(message.uid, part, { uid: true, maxBytes: MAX_ATTACHMENT_BYTES + 1, chunkSize: 64 * 1_024 });
    if (!downloaded.content) throw new InboxReadError('provider');
    const bytes = await boundedBytes(downloaded.content, MAX_ATTACHMENT_BYTES);
    return { filename: attachment.filename, contentType: attachment.contentType, bytes };
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/inbox-reader.test.ts tests/inbox-route.test.ts tests/inbox.test.ts`
Expected: PASS, including every pre-existing `readGmailInbox` test. `npm run typecheck` passes.

- [ ] **Step 5: Commit**

```bash
git add src/lib/inbox-reader.ts tests/inbox-reader.test.ts
git commit -m "feat(inbox): download one allow-listed reply attachment read-only"
```

---

### Task 5: Server preparation — sniff, hash, shrink image, PDF text, NIM call

**Files:**
- Modify: `package.json` (add `sharp`, `pdf-parse`)
- Create: `src/lib/intake-server.ts`, `tests/fixtures/intake/statement.jpg`
- Test: `tests/intake-server.test.ts`

**Interfaces:**
- Consumes: `ChatMessage` from Task 2.
- Produces: `sniffType(bytes: Buffer): 'image/jpeg' | 'image/png' | 'application/pdf' | null`, `sha256Hex(bytes: Buffer): string`, `MAX_IMAGE_BASE64 = 170 * 1024`, `class IntakePrepareError extends Error { reason: string }`, `prepareImage(bytes): Promise<{ kind: 'image'; jpegBase64: string }>`, `preparePdf(bytes): Promise<{ kind: 'text'; text: string }>`, `completeChat(key, model, messages: ChatMessage[], signal): Promise<string>`, `NIM_URL`.

- [ ] **Step 1: Install dependencies and make the fixture**

```bash
npm install sharp@0.35.4 pdf-parse@2.4.5
mkdir -p tests/fixtures/intake
# Shrunk copy of the synthetic bank statement photo used in the 14 September probe:
node -e "require('sharp')('/Users/kaydendo/.claude/image-cache/ffe80c35-eb7a-449f-8a24-a93011268953/2.png').resize({ width: 1024, withoutEnlargement: true }).jpeg({ quality: 60 }).toFile('tests/fixtures/intake/statement.jpg').then(i => console.log(i.size, 'bytes'))"
npm audit
```

If the source image is not on this machine, use any JPEG photo of a printed synthetic document under 200 KB. Expected `npm audit`: 0 vulnerabilities. If `pdf-parse` pulls a vulnerable transitive dependency, stop and report.

- [ ] **Step 2: Write the failing tests**

Create `tests/intake-server.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { completeChat, IntakePrepareError, MAX_IMAGE_BASE64, prepareImage, preparePdf, sha256Hex, sniffType } from '../src/lib/intake-server';

const STATEMENT = readFileSync('tests/fixtures/intake/statement.jpg');

/** A minimal single-page PDF with the given text. pdf.js tolerates the approximate xref. */
function tinyPdf(text: string) {
  const escaped = text.replace(/[\\()]/g, m => `\\${m}`);
  const lines = escaped.match(/.{1,60}/g) ?? [''];
  const stream = `BT /F1 12 Tf 14 TL 40 780 Td ${lines.map(l => `(${l}) Tj T*`).join(' ')} ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n'; const offsets: number[] = [];
  objects.forEach((obj, i) => { offsets.push(body.length); body += `${i + 1} 0 obj\n${obj}\nendobj\n`; });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

describe('sniffType and sha256Hex', () => {
  it('recognises JPEG, PNG and PDF magic numbers only', async () => {
    expect(sniffType(STATEMENT)).toBe('image/jpeg');
    expect(sniffType(await sharp({ create: { width: 4, height: 4, channels: 3, background: '#fff' } }).png().toBuffer())).toBe('image/png');
    expect(sniffType(tinyPdf('hello'))).toBe('application/pdf');
    expect(sniffType(Buffer.from('GIF89a'))).toBeNull();
    expect(sniffType(Buffer.alloc(0))).toBeNull();
  });
  it('hashes bytes to lowercase hex', () => {
    expect(sha256Hex(Buffer.from('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('prepareImage', () => {
  it('returns a JPEG base64 under the inline limit for a large noisy image', async () => {
    const noise = Buffer.from(Array.from({ length: 2000 * 2000 * 3 }, () => Math.floor(Math.random() * 256)));
    const big = await sharp(noise, { raw: { width: 2000, height: 2000, channels: 3 } }).png().toBuffer();
    expect(big.length).toBeGreaterThan(MAX_IMAGE_BASE64);
    const out = await prepareImage(big);
    expect(out.kind).toBe('image');
    expect(out.jpegBase64.length).toBeLessThanOrEqual(MAX_IMAGE_BASE64);
    expect(out.jpegBase64.startsWith('/9j/')).toBe(true);
  }, 30_000);
  it('keeps a small photo readable and rejects non-images', async () => {
    const out = await prepareImage(STATEMENT);
    expect(out.jpegBase64.length).toBeLessThanOrEqual(MAX_IMAGE_BASE64);
    await expect(prepareImage(Buffer.from('not an image'))).rejects.toBeInstanceOf(IntakePrepareError);
  });
});

describe('preparePdf', () => {
  it('extracts text from a PDF with a text layer', async () => {
    const out = await preparePdf(tinyPdf('Closing balance 108,125.00 for the Taylor Family Trust at 30 June 2026. '.repeat(4)));
    expect(out.kind).toBe('text');
    expect(out.text).toContain('108,125.00');
  });
  it('rejects a PDF without enough text', async () => {
    await expect(preparePdf(tinyPdf('short'))).rejects.toMatchObject({ reason: expect.stringMatching(/no text layer|scanned/i) });
  });
  it('rejects bytes that are not a PDF', async () => {
    await expect(preparePdf(Buffer.from('nope'))).rejects.toBeInstanceOf(IntakePrepareError);
  });
});

describe('completeChat', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('posts to NIM with the bearer key and returns the message content', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '{"documents":[]}' } }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const content = await completeChat('nvapi-x', 'meta/llama-3.2-11b-vision-instruct', [{ role: 'user', content: 'hi' }], new AbortController().signal);
    expect(content).toBe('{"documents":[]}');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://integrate.api.nvidia.com/v1/chat/completions');
    expect(init.headers.authorization).toBe('Bearer nvapi-x');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ model: 'meta/llama-3.2-11b-vision-instruct', temperature: 0.1, max_tokens: 1500, stream: false });
    expect(body.chat_template_kwargs).toBeUndefined();
  });
  it('disables thinking for Nemotron and surfaces HTTP status in the error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('busy', { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(completeChat('k', 'nvidia/nemotron-3.5-lightning-30b-a3b', [{ role: 'user', content: 'hi' }], new AbortController().signal)).rejects.toThrow(/429/);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).chat_template_kwargs).toEqual({ enable_thinking: false });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/intake-server.test.ts`
Expected: FAIL — cannot resolve `../src/lib/intake-server`.

- [ ] **Step 4: Implement**

Create `src/lib/intake-server.ts`:

```ts
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { PDFParse } from 'pdf-parse';
import type { ChatMessage } from './intake';

// Server-only helpers for attachment intake: identify bytes, shrink an image to what NIM
// accepts inline, pull text out of a PDF, and call the model. Nothing here logs content.

export const MAX_IMAGE_BASE64 = 170 * 1024;
export const MAX_PDF_TEXT = 20_000;
export const MIN_PDF_TEXT = 200;
export const NIM_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';

export class IntakePrepareError extends Error {
  constructor(readonly reason: string) { super(reason); this.name = 'IntakePrepareError'; }
}

export function sniffType(bytes: Buffer): 'image/jpeg' | 'image/png' | 'application/pdf' | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}

export function sha256Hex(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Auto-orient, fit inside 1200 px, then step JPEG quality down until the base64 fits the inline cap. */
export async function prepareImage(bytes: Buffer): Promise<{ kind: 'image'; jpegBase64: string }> {
  let pipeline: sharp.Sharp;
  try { pipeline = sharp(bytes, { failOn: 'error', limitInputPixels: 50_000_000 }); await pipeline.metadata(); }
  catch { throw new IntakePrepareError('The attachment could not be decoded as an image.'); }
  for (const edge of [1200, 900]) {
    for (const quality of [70, 60, 50, 40, 30]) {
      const out = await sharp(bytes).rotate().resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true }).jpeg({ quality, mozjpeg: true }).toBuffer();
      const jpegBase64 = out.toString('base64');
      if (jpegBase64.length <= MAX_IMAGE_BASE64) return { kind: 'image', jpegBase64 };
    }
  }
  throw new IntakePrepareError('The image could not be reduced enough to send to the model.');
}

/** Text layer of the first 20 pages. A scanned PDF has none and is refused here rather than guessed at. */
export async function preparePdf(bytes: Buffer): Promise<{ kind: 'text'; text: string }> {
  let text = '';
  const parser = new PDFParse({ data: new Uint8Array(bytes) });
  try { text = (await parser.getText({ first: 20 })).text ?? ''; }
  catch { throw new IntakePrepareError('The attachment could not be read as a PDF.'); }
  finally { await parser.destroy().catch(() => undefined); }
  if (text.replace(/\s/g, '').length < MIN_PDF_TEXT) throw new IntakePrepareError('This looks like a scanned PDF with no text layer. Ask for a photo or a text PDF, or assign it manually.');
  return { kind: 'text', text: text.slice(0, MAX_PDF_TEXT) };
}

/** Same shape as the assist route's call; kept separate so the live assist path is untouched. */
export async function completeChat(key: string, model: string, messages: ChatMessage[], signal: AbortSignal) {
  const options = model.startsWith('nvidia/nemotron') ? { temperature: 0.1, max_tokens: 1500, chat_template_kwargs: { enable_thinking: false } } : { temperature: 0.1, max_tokens: 1500 };
  const res = await fetch(NIM_URL, {
    method: 'POST', signal,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ model, messages, ...options, stream: false }),
  });
  if (!res.ok) throw new Error(`Model service returned ${res.status}.`);
  const data = await res.json() as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('Model service returned no message.');
  return content;
}
```

If `pdf-parse`'s `getText` option is not `first` in 2.4.5, read `node_modules/pdf-parse/dist/pdf-parse/esm/PDFParse.d.ts` and use the documented page-limit option; do not silently parse every page.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/intake-server.test.ts`
Expected: PASS. Then `npm run build` — confirm sharp and pdf-parse bundle for the Node runtime without warnings about missing binaries. If Next warns about `sharp` in the server bundle, add to `next.config.*`: `serverExternalPackages: ['sharp', 'pdf-parse']`.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/lib/intake-server.ts tests/intake-server.test.ts tests/fixtures/intake/statement.jpg next.config.*
git commit -m "feat(intake): server-side image shrink, PDF text and model call"
```

---

### Task 6: `POST /api/intake`

**Files:**
- Create: `src/app/api/intake/route.ts`
- Test: `tests/intake-route.test.ts`

**Interfaces:**
- Consumes: `downloadGmailAttachment`, `InboxReadError` (Task 4); `sniffType`, `sha256Hex`, `prepareImage`, `preparePdf`, `completeChat`, `IntakePrepareError` (Task 5); `intakeContextSchema`, `buildIntakeMessages`, `parseIntakeReply`, `verifyIntake`, `PROMPT_VERSION` (Tasks 1–2); `gate`, `json`.
- Produces: `POST` returning `{ file: { filename, contentType, size, sha256, bytesBase64 }, proposal: Omit<IntakeProposal, 'id' | 'review'> }`.

- [ ] **Step 1: Write the failing tests**

Create `tests/intake-route.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as workflow from '../src/core/workflow';
import { buildIntakeContext } from '../src/lib/intake';
import { baseline } from './fixtures';

const { downloadGmailAttachment } = vi.hoisted(() => ({ downloadGmailAttachment: vi.fn() }));
vi.mock('../src/lib/inbox-reader', async importOriginal => ({
  ...await importOriginal<typeof import('../src/lib/inbox-reader')>(),
  downloadGmailAttachment,
}));
import { InboxReadError } from '../src/lib/inbox-reader';
import { POST } from '../src/app/api/intake/route';

const STATEMENT = readFileSync('tests/fixtures/intake/statement.jpg');
const state = workflow.startSeason(workflow.importBaseline(workflow.createWorkspace(), baseline), 'alex-taylor');
const context = buildIntakeContext(state);
const good = { 'x-assist-passcode': 'open-sesame', 'sec-fetch-site': 'same-origin' };
const body = JSON.stringify({ messageId: '<reply-1@example.com>', attachmentIndex: 0, context });
const REPLY = '{"documents":[{"docType":"Dividend statement","entityNameSeen":"Alex Taylor","periodStart":"1 July 2025","periodEnd":"30 June 2026","amounts":[{"label":"Cash dividend","amount":"$4,200.00"}],"proposedEntityId":"alex-taylor","proposedRequestId":"alex-taylor:2026:ALE-DIV-CASH","confidence":"high","reason":"Dividend statement addressed to Alex","syntheticMarker":true}]}';

function call(headers: Record<string, string>, payload = body) {
  return POST(new Request('http://localhost/api/intake', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: payload }));
}
function nim(content: string, status = 200) {
  return new Response(status === 200 ? JSON.stringify({ choices: [{ message: { content } }] }) : 'error', { status, headers: { 'content-type': 'application/json' } });
}
/** Same minimal PDF builder as tests/intake-server.test.ts (duplicated so each file reads on its own). */
function tinyPdf(text: string) {
  const escaped = text.replace(/[\\()]/g, m => `\\${m}`);
  const lines = escaped.match(/.{1,60}/g) ?? [''];
  const stream = `BT /F1 12 Tf 14 TL 40 780 Td ${lines.map(l => `(${l}) Tj T*`).join(' ')} ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n'; const offsets: number[] = [];
  objects.forEach((obj, i) => { offsets.push(body.length); body += `${i + 1} 0 obj\n${obj}\nendobj\n`; });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

describe('POST /api/intake', () => {
  beforeEach(() => {
    for (const [k, v] of Object.entries({ NVIDIA_NIM_API_KEY: 'nvapi-test', NVIDIA_NIM_MODEL: 'nvidia/nemotron-3.5-lightning-30b-a3b', NVIDIA_NIM_VISION_MODEL: 'meta/llama-3.2-11b-vision-instruct',
      AI_ASSIST_PASSCODE: 'open-sesame', SMTP_USER: 'adviser@example.com', SMTP_PASS: 'app-password', OUTREACH_ALLOWED_RECIPIENTS: 'family@example.com' })) vi.stubEnv(k, v);
    downloadGmailAttachment.mockReset();
    downloadGmailAttachment.mockResolvedValue({ filename: 'statement.jpg', contentType: 'image/jpeg', bytes: STATEMENT });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it('503 when any required setting is missing, before anything else', async () => {
    for (const name of ['NVIDIA_NIM_VISION_MODEL', 'SMTP_PASS', 'AI_ASSIST_PASSCODE']) {
      vi.stubEnv(name, '');
      expect((await call({})).status).toBe(503);
      vi.stubEnv(name, 'x');
    }
    expect(downloadGmailAttachment).not.toHaveBeenCalled();
  });
  it('401 / 403 / 400 gates', async () => {
    expect((await call({ 'sec-fetch-site': 'same-origin' })).status).toBe(401);
    expect((await call({ ...good, 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await call(good, '{"messageId":1}')).status).toBe(400);
    expect((await call(good, 'nope')).status).toBe(400);
    expect(downloadGmailAttachment).not.toHaveBeenCalled();
  });
  it('maps download errors to 404 / 413 / 415 / 504 / 502', async () => {
    for (const [code, status] of [['not_found', 404], ['too_large', 413], ['unsupported_type', 415], ['timeout', 504], ['provider', 502]] as const) {
      downloadGmailAttachment.mockRejectedValueOnce(new InboxReadError(code));
      expect((await call(good)).status).toBe(status);
    }
  });
  it('415 when the bytes do not match a supported type even if the mail declared one', async () => {
    downloadGmailAttachment.mockResolvedValue({ filename: 'x.jpg', contentType: 'image/jpeg', bytes: Buffer.from('GIF89a....') });
    const res = await call(good);
    expect(res.status).toBe(415);
  });
  it('422 for a PDF without a text layer', async () => {
    downloadGmailAttachment.mockResolvedValue({ filename: 'scan.pdf', contentType: 'application/pdf', bytes: Buffer.from('%PDF-1.4\n%%EOF\n') });
    const res = await call(good);
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/PDF/);
  });
  it('200: shrinks the image, calls the vision model, verifies the proposal, returns bytes and hash', async () => {
    const fetchMock = vi.fn().mockResolvedValue(nim(`Sure!\n${REPLY}`));
    vi.stubGlobal('fetch', fetchMock);
    const res = await call(good);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.file).toMatchObject({ filename: 'statement.jpg', contentType: 'image/jpeg', size: STATEMENT.length });
    expect(Buffer.from(data.file.bytesBase64, 'base64').equals(STATEMENT)).toBe(true);
    expect(data.file.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(data.proposal).toMatchObject({ messageId: '<reply-1@example.com>', attachmentIndex: 0, model: 'meta/llama-3.2-11b-vision-instruct', promptVersion: 'intake-1', source: 'image', fileHash: data.file.sha256 });
    expect(data.proposal.documents[0]).toMatchObject({ proposedRequestId: 'alex-taylor:2026:ALE-DIV-CASH', amounts: [{ label: 'Cash dividend', amountCents: 420000 }],
      flags: { nameMatch: 'match', periodInYear: true, syntheticMarker: true, targetValid: true } });
    expect(data.proposal.id).toBeUndefined();
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.model).toBe('meta/llama-3.2-11b-vision-instruct');
    const image = sent.messages[1].content.find((p: { type: string }) => p.type === 'image_url').image_url.url as string;
    expect(image.startsWith('data:image/jpeg;base64,/9j/')).toBe(true);
    expect(image.length).toBeLessThan(170 * 1024 + 30);
  });
  it('retries once on unusable JSON, then 502', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(nim('no json here')).mockResolvedValueOnce(nim(REPLY));
    vi.stubGlobal('fetch', fetchMock);
    expect((await call(good)).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).messages).toHaveLength(3);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(nim('still nothing')));
    const res = await call(good);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/unusable/i);
  });
  it('503 with retry-later on HTTP 429, without a second attempt', async () => {
    const fetchMock = vi.fn().mockResolvedValue(nim('', 429));
    vi.stubGlobal('fetch', fetchMock);
    const res = await call(good);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/busy|later/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('504 when the shared deadline aborts the model call', async () => {
    vi.useFakeTimers();
    const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
    vi.stubGlobal('fetch', vi.fn((_url: string, init: { signal: AbortSignal }) => init.signal.aborted
      ? Promise.reject(abortError())
      : new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(abortError())))));
    const pending = call(good);
    await vi.advanceTimersByTimeAsync(54_000);
    expect((await pending).status).toBe(504);
  });
  it('uses the text model for a PDF with a text layer', async () => {
    const pdf = tinyPdf('Dividend statement for Alex Taylor cash dividend 4,200.00 paid during FY2026. '.repeat(4));
    downloadGmailAttachment.mockResolvedValue({ filename: 'statement.pdf', contentType: 'application/pdf', bytes: pdf });
    const fetchMock = vi.fn().mockResolvedValue(nim(REPLY));
    vi.stubGlobal('fetch', fetchMock);
    const res = await call(good);
    expect(res.status).toBe(200);
    expect((await res.json()).proposal).toMatchObject({ source: 'pdf_text', model: 'nvidia/nemotron-3.5-lightning-30b-a3b' });
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(sent.messages[1].content).toContain('4,200.00');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/intake-route.test.ts`
Expected: FAIL — cannot resolve the route module.

- [ ] **Step 3: Implement the route**

Create `src/app/api/intake/route.ts`:

```ts
import { z } from 'zod';
import { gate, json } from '../../../lib/gate';
import { downloadGmailAttachment, InboxReadError } from '../../../lib/inbox-reader';
import { buildIntakeMessages, intakeContextSchema, parseIntakeReply, PROMPT_VERSION, verifyIntake, type RawIntakeDocument } from '../../../lib/intake';
import { completeChat, IntakePrepareError, prepareImage, preparePdf, sha256Hex, sniffType } from '../../../lib/intake-server';
import type { IntakeProposal } from '../../../core/types';

// One attachment per call: download from the firm mailbox, shrink or extract, ask the model,
// check the answer, hand everything back to the browser. Nothing is stored or logged here.

export const maxDuration = 60;
const TOTAL_TIMEOUT_MS = 54_000;

const bodySchema = z.object({ messageId: z.string().max(1000), attachmentIndex: z.number().int().min(0).max(29), context: intakeContextSchema });
const DOWNLOAD_STATUS: Record<InboxReadError['code'], number> = { configuration: 503, timeout: 504, provider: 502, not_found: 404, too_large: 413, unsupported_type: 415 };

export async function POST(req: Request) {
  const env = {
    key: process.env.NVIDIA_NIM_API_KEY, model: process.env.NVIDIA_NIM_MODEL, visionModel: process.env.NVIDIA_NIM_VISION_MODEL, passcode: process.env.AI_ASSIST_PASSCODE,
    user: process.env.SMTP_USER, pass: process.env.SMTP_PASS, allowedSenders: process.env.OUTREACH_ALLOWED_RECIPIENTS,
  };
  if (Object.values(env).some(v => !v)) return json(503, { error: 'Attachment intake is not configured on this deployment.' });
  const blocked = gate(req, env.passcode!); if (blocked) return blocked;

  let parsed: z.infer<typeof bodySchema>;
  try { parsed = bodySchema.parse(await req.json()); }
  catch { return json(400, { error: 'Invalid intake request.' }); }
  const { messageId, attachmentIndex, context } = parsed;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOTAL_TIMEOUT_MS);
  try {
    let file: Awaited<ReturnType<typeof downloadGmailAttachment>>;
    try { file = await downloadGmailAttachment({ user: env.user!, pass: env.pass!, allowedSenders: env.allowedSenders! }, messageId, attachmentIndex); }
    catch (e) {
      if (e instanceof InboxReadError) return json(DOWNLOAD_STATUS[e.code], { error: e.message });
      return json(502, { error: 'The attachment could not be downloaded.' });
    }
    const contentType = sniffType(file.bytes);
    if (!contentType || contentType !== file.contentType) return json(415, { error: 'The attachment bytes are not the JPEG, PNG or PDF the email declared.' });

    let prepared;
    try { prepared = contentType === 'application/pdf' ? await preparePdf(file.bytes) : await prepareImage(file.bytes); }
    catch (e) { return json(422, { error: e instanceof IntakePrepareError ? e.reason : 'The attachment could not be prepared.' }); }

    const chosenModel = prepared.kind === 'image' ? env.visionModel! : env.model!;
    const messages = buildIntakeMessages(context, prepared);
    let documents: RawIntakeDocument[] | undefined; let lastError = 'Model returned unusable output.';
    for (let attempt = 0; attempt < 2 && !documents; attempt++) {
      const conversation = attempt === 0 ? messages : [...messages, { role: 'user' as const, content: 'Return only the JSON object {"documents":[...]} with no other text.' }];
      let reply: string;
      try { reply = await completeChat(env.key!, chosenModel, conversation, controller.signal); }
      catch (e) {
        if (e instanceof Error && e.name === 'AbortError') return json(504, { error: 'The model did not answer within the time limit.' });
        if (e instanceof Error && e.message.includes('429')) return json(503, { error: 'The model service is busy. Try again later.' });
        return json(502, { error: e instanceof Error && e.message.startsWith('Model service') ? e.message : 'Model service request failed.' });
      }
      try { documents = parseIntakeReply(reply); }
      catch (e) { lastError = e instanceof Error ? e.message : lastError; }
    }
    if (!documents) return json(502, { error: `Model returned unusable output: ${lastError}` });

    const sha256 = sha256Hex(file.bytes);
    const proposal: Omit<IntakeProposal, 'id' | 'review'> = {
      messageId, attachmentIndex, filename: file.filename, contentType, size: file.bytes.length, fileHash: sha256,
      model: chosenModel, promptVersion: PROMPT_VERSION, createdAt: new Date().toISOString(), source: prepared.kind === 'image' ? 'image' : 'pdf_text',
      documents: verifyIntake(documents, context),
    };
    return json(200, { file: { filename: file.filename, contentType, size: file.bytes.length, sha256, bytesBase64: file.bytes.toString('base64') }, proposal });
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/intake-route.test.ts` then `npm test`.
Expected: PASS. If the 504 test hangs, `downloadGmailAttachment` is mocked so only the model fetch waits on the signal — confirm `completeChat` passes `signal` through.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/intake/route.ts tests/intake-route.test.ts
git commit -m "feat(api): gated attachment intake proxy"
```

---

### Task 7: Browser client, review card, Inbox integration

**Files:**
- Create: `src/lib/intake-client.ts`, `src/components/intake-review.tsx`
- Modify: `src/components/inbox-panel.tsx`, `src/components/workspace.tsx:94-101` (near `fetchReplies`), `src/app/globals.css`
- Test: `tests/intake.spec.ts` (Playwright)

**Interfaces:**
- Consumes: route response shape (Task 6); `recordIntakeProposal`, `applyIntakeDocument`, `rejectIntakeProposal`, `linkedRequestFor`, `buildIntakeContext` (Tasks 2–3); `keepOriginal`, `readOriginal`, `sha256` from `storage.ts`; `readPasscode` from `assist-client.ts`.
- Produces: `readAttachment(passcode, messageId, attachmentIndex, context): Promise<Omit<IntakeProposal, 'id' | 'review'>>`; `IntakeReview` component; `InboxPanel` prop `readAttachments: (passcode: string, message: InboxMessage) => void`; `ReplyCard` prop the same plus `openRequest`.

- [ ] **Step 1: Client call**

Create `src/lib/intake-client.ts`:

```ts
import { z } from 'zod';
import type { IntakeProposal } from '../core/types';
import { intakeDocumentSchema, type IntakeContext } from './intake';
import { keepOriginal, sha256 } from './storage';

const responseSchema = z.object({
  file: z.object({ filename: z.string().max(300), contentType: z.string().max(100), size: z.number().int().nonnegative(), sha256: z.string().regex(/^[0-9a-f]{64}$/), bytesBase64: z.string().max(12_000_000) }),
  proposal: z.object({ messageId: z.string().max(1000), attachmentIndex: z.number().int().min(0).max(29), filename: z.string().max(300), contentType: z.string().max(100),
    size: z.number().int().nonnegative(), fileHash: z.string().regex(/^[0-9a-f]{64}$/), model: z.string().max(200), promptVersion: z.string().max(40), createdAt: z.string().max(40),
    source: z.enum(['image', 'pdf_text']), documents: z.array(intakeDocumentSchema).max(10) }),
});

function decode(base64: string) {
  const binary = atob(base64); const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/** Reads one attachment through the gated route, verifies the hash locally, keeps the original bytes, returns the proposal. */
export async function readAttachment(passcode: string, messageId: string, attachmentIndex: number, context: IntakeContext): Promise<Omit<IntakeProposal, 'id' | 'review'>> {
  if (!passcode) throw new Error('Enter the demo passcode first.');
  const res = await fetch('/api/intake', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-assist-passcode': passcode },
    body: JSON.stringify({ messageId, attachmentIndex, context }),
  });
  const data = await res.json().catch(() => ({})) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Attachment read failed (${res.status}).`);
  const { file, proposal } = responseSchema.parse(data);
  const bytes = decode(file.bytesBase64);
  if (await sha256(bytes) !== file.sha256 || proposal.fileHash !== file.sha256) throw new Error('The attachment bytes did not match their hash. Nothing was saved.');
  await keepOriginal(file.sha256, bytes);
  return proposal;
}
```

- [ ] **Step 2: Review card**

Create `src/components/intake-review.tsx`:

```tsx
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
    <dl className="intake-facts"><dt>Entity seen</dt><dd>{doc.entityNameSeen || '—'}</dd><dt>Period seen</dt><dd>{[doc.periodStart, doc.periodEnd].filter(Boolean).join(' – ') || '—'}</dd><dt>Model's reason</dt><dd>{doc.reason || '—'}</dd></dl>
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
      {blocked && <p className="hint">Change the entity or request to accept this document; the model's target could not be verified.</p>}
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
```

- [ ] **Step 3: Inbox panel and workspace wiring**

In `src/components/inbox-panel.tsx`:

- Extend `Props` with `readAttachments: (passcode: string, message: InboxMessage) => void; progress: string;` and import `IntakeReview`.
- In `ReplyCard` (which receives `Omit<Props, 'check'>`), replace the "Attachments listed only" block with:

```tsx
    {!!message.attachments.length && <div className="intake-list">
      <strong>Attachments</strong>
      <ul>{message.attachments.map((a, i) => <li key={i}>{a.filename || '(Unnamed attachment)'} · {a.contentType} · {a.size.toLocaleString()} bytes</li>)}</ul>
      <button disabled={busy} onClick={() => readAttachments(readPasscode(), message)}>Read {message.attachments.length} attachment{message.attachments.length === 1 ? '' : 's'}</button>
      {progress && <p className="hint" role="status">{progress}</p>}
      <p className="hint">Each file is downloaded once, read by the vision model and shown as a proposal. Nothing is linked until you accept it.</p>
      {(state.intake ?? []).filter(p => p.messageId === message.messageId).sort((a, b) => a.attachmentIndex - b.attachmentIndex)
        .map(p => <IntakeReview key={p.id} state={state} proposal={p} busy={busy} act={act} openRequest={openRequest} />)}
    </div>}
```

  (destructure `readAttachments` and `progress` from the props in `ReplyCard`.)
- In `InboxPanel`, pass `{...props}` through as before (it already spreads props into `ReplyCard`), and change the paragraph "Attachment contents are not retrieved." to "Attachments are read only when you ask, one file at a time."

In `src/components/workspace.tsx`:

- Imports: `import { buildIntakeContext, recordIntakeProposal } from '../lib/intake'; import { readAttachment } from '../lib/intake-client'; import type { InboxMessage } from '../core/types';`
- State: `const [intakeProgress, setIntakeProgress] = useState('');`
- After `fetchReplies`:

```ts
  async function readAllAttachments(passcode: string, message: InboxMessage) {
    const failures: string[] = [];
    for (let i = 0; i < message.attachments.length; i++) {
      setIntakeProgress(`Reading ${i + 1} of ${message.attachments.length}: ${message.attachments[i].filename || 'attachment'}…`);
      try {
        const base = stateRef.current;
        const proposal = await readAttachment(passcode, message.messageId, i, buildIntakeContext(base));
        const id = `intake-${base.version + 1}-${i}`;
        persist(stateRef.current, recordIntakeProposal(stateRef.current, { ...proposal, id, review: { status: 'pending', decidedAt: '', note: '' } }));
      } catch (e) { failures.push(`${message.attachments[i].filename || `attachment ${i + 1}`}: ${e instanceof Error ? e.message : 'failed'}`); }
    }
    setIntakeProgress('');
    if (failures.length) throw new Error(`${message.attachments.length - failures.length} of ${message.attachments.length} attachments read. Not read — ${failures.join('; ')}`);
    setNotice(`${message.attachments.length} attachment${message.attachments.length === 1 ? '' : 's'} read. Nothing linked yet — review each proposal below.`);
  }
```

- The `InboxPanel` element gains `readAttachments={(passcode, message) => void run(() => readAllAttachments(passcode, message))} progress={intakeProgress}`.
- In the Connections table, change the AI assist row's status text from "No PDF/OCR." to "Photo and text-PDF attachments are read into proposals via the Inbox; no OCR guarantees."

Note `persist(stateRef.current, …)` inside the loop: each iteration commits from the latest state so that a proposal saved by iteration 1 is not overwritten by iteration 2's base.

- [ ] **Step 4: CSS**

Append to `src/app/globals.css`:

```css
.intake-list { margin-top: 0.75rem; }
.intake-proposal { border: 1px solid var(--line, #d6d6d6); border-radius: 8px; padding: 0.75rem; margin-top: 0.75rem; }
.intake-proposal h3 small { font-weight: normal; }
.intake-thumb { max-width: 100%; max-height: 320px; display: block; margin: 0.5rem 0; border: 1px solid var(--line, #d6d6d6); }
.intake-document { border-top: 1px dashed var(--line, #d6d6d6); padding-top: 0.5rem; margin-top: 0.5rem; }
.intake-facts { display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 0.75rem; margin: 0.5rem 0; }
.intake-facts dt { font-weight: 600; }
.intake-amounts { width: 100%; border-collapse: collapse; margin: 0.5rem 0; }
.intake-amounts th, .intake-amounts td { text-align: left; padding: 0.25rem 0.5rem; border-bottom: 1px solid var(--line, #d6d6d6); }
.intake-flag { margin: 0.25rem 0; }
@media (max-width: 480px) { .intake-facts { grid-template-columns: 1fr; } }
```

If `globals.css` already defines a line-colour variable under another name, use that name instead of `--line`.

- [ ] **Step 5: Type-check and unit tests**

Run: `npm run typecheck && npm test`
Expected: both pass.

- [ ] **Step 6: Playwright journey**

Create `tests/intake.spec.ts`:

```ts
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const STATEMENT = readFileSync('tests/fixtures/intake/statement.jpg');
const SHA = createHash('sha256').update(STATEMENT).digest('hex');

test('reply attachment → read → mismatch blocks accept → adviser override → evidence linked → reload persists', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Load synthetic family' }).click();
  await page.getByRole('button', { name: 'Taylor Family Trust' }).click();
  await page.getByRole('button', { name: 'Generate FY26 requests' }).click();
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await page.getByLabel('Inbox passcode').fill('demo');
  await page.route('**/api/inbox', route => route.fulfill({ json: { checkedAt: new Date().toISOString(), messages: [{
    messageId: '<reply-9@example.com>', inReplyTo: null, references: [], from: 'taylorfamilyexample@gmail.com', date: new Date().toISOString(),
    subject: 'Trust documents', text: 'Attached as requested.', textTruncated: false,
    attachments: [{ filename: 'statement.jpg', size: STATEMENT.length, contentType: 'image/jpeg' }] }] } }));
  await page.getByRole('button', { name: 'Check inbox' }).click();
  await expect(page.getByTestId('inbox-reply')).toHaveCount(1);

  await page.route('**/api/intake', async route => {
    const body = route.request().postDataJSON();
    expect(body.messageId).toBe('<reply-9@example.com>');
    expect(body.context.requests.some((r: { id: string }) => r.id === 'taylor-family-trust:2026:TR-BANK')).toBe(true);
    await route.fulfill({ json: {
      file: { filename: 'statement.jpg', contentType: 'image/jpeg', size: STATEMENT.length, sha256: SHA, bytesBase64: STATEMENT.toString('base64') },
      proposal: { messageId: '<reply-9@example.com>', attachmentIndex: 0, filename: 'statement.jpg', contentType: 'image/jpeg', size: STATEMENT.length, fileHash: SHA,
        model: 'meta/llama-3.2-11b-vision-instruct', promptVersion: 'intake-1', createdAt: new Date().toISOString(), source: 'image',
        documents: [{ docType: 'Trust Account Statement', entityNameSeen: 'Oakwood Family Trust', periodStart: '1 June 2026', periodEnd: '30 June 2026',
          amounts: [{ label: 'Closing Balance', amountCents: 10812500 }], proposedEntityId: '', proposedRequestId: '', confidence: 'medium', reason: 'Bank statement for a trust',
          flags: { nameMatch: 'mismatch', periodInYear: true, syntheticMarker: true, targetValid: false } }] } } });
  });
  await page.getByRole('button', { name: 'Read 1 attachment' }).click();
  const doc = page.getByTestId('intake-document');
  await expect(doc).toContainText('Name mismatch');
  await expect(doc).toContainText('Synthetic marker seen');
  await expect(doc.getByRole('img', { name: 'Attachment statement.jpg' })).toBeVisible();
  await expect(doc.getByRole('button', { name: /Accept/ })).toBeDisabled();

  await doc.getByLabel('Entity').selectOption('taylor-family-trust');
  await doc.getByLabel('Request line').selectOption('taylor-family-trust:2026:TR-BANK');
  await expect(doc.getByRole('button', { name: 'Accept with adviser override' })).toBeEnabled();
  await doc.getByRole('button', { name: 'Accept with adviser override' }).click();
  await expect(page.getByTestId('intake-linked')).toContainText('Linked to');

  await page.getByTestId('intake-linked').getByRole('button', { name: 'Open request' }).click();
  await expect(page.getByText(`intake-${SHA.slice(0, 16)}-0`)).toBeVisible();
  await expect(page.getByText('$108,125.00')).toBeVisible();

  await page.reload();
  await page.getByRole('button', { name: 'Taylor Family Trust' }).click();
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await expect(page.getByTestId('intake-linked')).toContainText('Linked to');
  await page.getByRole('button', { name: /^Activity/ }).click();
  await expect(page.getByText(/intake_accepted|adviser override/)).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('with the route unconfigured the reply still shows and the error is visible', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Load synthetic family' }).click();
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await page.getByLabel('Inbox passcode').fill('demo');
  await page.route('**/api/inbox', route => route.fulfill({ json: { checkedAt: new Date().toISOString(), messages: [{
    messageId: '<reply-10@example.com>', inReplyTo: null, references: [], from: 'taylorfamilyexample@gmail.com', date: new Date().toISOString(),
    subject: 'Photos', text: '', textTruncated: false, attachments: [{ filename: 'a.jpg', size: 10, contentType: 'image/jpeg' }] }] } }));
  await page.getByRole('button', { name: 'Check inbox' }).click();
  await page.route('**/api/intake', route => route.fulfill({ status: 503, json: { error: 'Attachment intake is not configured on this deployment.' } }));
  await page.getByRole('button', { name: 'Read 1 attachment' }).click();
  await expect(page.getByTestId('error')).toContainText('not configured');
  await expect(page.getByTestId('intake-proposal')).toHaveCount(0);
});
```

Selectors rely on what exists today: entity buttons in `workspace.tsx:132` render the entity name (`aria-pressed`); the request panel (`request-panel.tsx:29`) renders `<strong>{documentId}</strong>` and `money(amountCents)` → `$108,125.00` in `en-AU`; the Activity tab is the button named `Activity`; the error paragraph has `data-testid="error"`. If the request panel needs the request selected first, click the request row labelled `Trust bank balance` in the Requests tab before asserting. Do not change existing labels.

Run: `PLAYWRIGHT_CHROMIUM_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npx playwright test tests/intake.spec.ts`
Expected: 2 passed. Then the full `npm run test:e2e` — existing journeys still pass.

- [ ] **Step 7: Commit**

```bash
git add src/lib/intake-client.ts src/components/intake-review.tsx src/components/inbox-panel.tsx src/components/workspace.tsx src/app/globals.css tests/intake.spec.ts
git commit -m "feat(ui): read reply attachments and review intake proposals in the Inbox"
```

---

### Task 8: Docs, env, live check, final verification

**Files:**
- Modify: `README.md`, `.env.example`, `PICKUP.md`, `docs/team/thomas/README.md` (one line), `docs/team/README.md` (if it indexes features)

- [ ] **Step 1: `.env.example`**

Add under the NIM lines:

```
# Vision model for reading photo attachments in the Inbox (text PDFs use NVIDIA_NIM_MODEL).
NVIDIA_NIM_VISION_MODEL=meta/llama-3.2-11b-vision-instruct
```

- [ ] **Step 2: README**

Add a section "Attachment intake" after the Inbox section:

```markdown
## Attachment intake

In the Inbox, a reply with JPEG, PNG or PDF attachments shows **Read N attachments**. Each file is downloaded from the firm mailbox once (read-only, 8 MB cap), photos are shrunk and sent to `NVIDIA_NIM_VISION_MODEL`, text PDFs are sent to `NVIDIA_NIM_MODEL`, and the model's answer is shown as a proposal per document: type, entity name seen, period, figures read, and a proposed entity and request line. Code adds flags — name mismatch, partial match, period outside FY2026, synthetic marker, invalid target. A mismatch or invalid target disables Accept until the adviser picks the target explicitly; that override is recorded. Accepting links the file as evidence on the chosen request using the existing evidence rules; adviser review of the request stays separate.

Limits: figures are model reads and can be wrong — check them against the preview. One file per call, roughly 9 s each on the tested model. Scanned PDFs without a text layer are refused. Photos holding several documents read worse than one document per photo. The original bytes stay in the adviser's browser (IndexedDB); the server keeps nothing. Not OCR-grade; not a tax calculation.
```

Update the "limits" paragraph that says evidence intake supports structured CSVs only.

- [ ] **Step 3: PICKUP.md checkpoint**

Append:

```markdown
## Attachment intake checkpoint — 14 September

Branch `feat/attachment-intake`. Spec `docs/superpowers/specs/2026-09-14-attachment-intake-design.md`, plan `docs/superpowers/plans/2026-09-14-attachment-intake.md`. New env `NVIDIA_NIM_VISION_MODEL=meta/llama-3.2-11b-vision-instruct` (probe: 8.6 s on the demo bank statement; 90b too slow; phi-3 404). Jason's `feat/jason-guidance-agent` (fork `jye230606-bot`, fetched as remote `jason`) is additive and unmerged; merge after this lands. Live check status: <fill in after Step 5>.
```

- [ ] **Step 4: Thomas note**

Append one line to `docs/team/thomas/README.md` under "Files and boundaries": `| `src/components/intake-review.tsx` | Attachment proposal card (new 14 Sept); presentation only, keep labels |`.

- [ ] **Step 5: Live check (needs network; sandbox off)**

```bash
grep -q NVIDIA_NIM_VISION_MODEL .env.local || echo 'NVIDIA_NIM_VISION_MODEL=meta/llama-3.2-11b-vision-instruct' >> .env.local
npm run dev
```

In the browser: load family → Taylor Family Trust → generate → Outbox → send initial outreach to the family mailbox (or reuse the already-sent thread) → from the family Gmail reply with the synthetic statement photo attached → Inbox → passcode → Check inbox → Read 1 attachment → confirm a proposal renders, note latency and what the model read → accept onto Trust bank balance → Requests shows the evidence row. Record the outcome (latency, correct/incorrect fields) in PICKUP.md Step 3. Do not paste message IDs or mail content.

- [ ] **Step 6: Full verification**

```bash
npm test && npm run typecheck && npm run build && npm audit && git diff --check
PLAYWRIGHT_CHROMIUM_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm run test:e2e
```

Expected: all green, 0 vulnerabilities.

- [ ] **Step 7: Commit**

```bash
git add README.md .env.example PICKUP.md docs/team/thomas/README.md
git commit -m "docs: attachment intake usage, limits and checkpoint"
```

Then report: tests count, e2e count, build result, live-check outcome. Deployment (`vercel env add NVIDIA_NIM_VISION_MODEL production`, `vercel deploy --yes --scope kaydendo42-webs-projects`, `vercel promote`) is a separate user decision.

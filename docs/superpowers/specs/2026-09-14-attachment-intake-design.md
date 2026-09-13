# Attachment intake — read, sort, adviser approval — design

Approved in chat, 14 September 2026. Adds a gated path from a family reply's attachments (photos and PDFs) to *proposed* evidence on a specific entity and request line. A vision model reads each file and proposes where it belongs; code checks the proposal; an adviser accepts or rejects. Nothing is linked as evidence without that adviser action, and the demo runs unchanged when the route is unconfigured.

This is sub-project 1 of four discussed on 14 September (intake; family group + liaison email; family tree UI; Excel write-back). The other three are out of scope here.

## Verified constraints (probe, 14 September)

- `meta/llama-3.2-11b-vision-instruct` on the configured NIM key: 200 in 8.6 s on a two-document photo; read both documents, the entity name, period and the $108,125.00 closing balance correctly, misread one reconciliation figure and one subtotal. Good enough to propose, not to trust.
- `meta/llama-3.2-90b-vision-instruct`: queued past 200 s. Unusable inside the 60 s route budget.
- `microsoft/phi-3-vision-128k-instruct`: 404 for this account. No Nemotron VL chat model is listed for the key.
- Inline image payloads above roughly 180 KB base64 fail at the gateway; the image must be shrunk server-side.
- The model wraps JSON in prose ("Sure, here is the JSON…") and returns amounts as `"$108,125.00"` strings. Parsing must tolerate both.

## Architecture

Browser → `POST /api/intake` (Node runtime) → IMAP download of one attachment → image shrink (or PDF text extraction) → NIM chat completions with entity/request context → proposal → back to the browser with the original bytes. The browser retains the bytes in IndexedDB under their SHA-256 (existing `keepOriginal`) and stores the proposal in the workspace. Accepting a proposed document calls the existing `receiveEvidence`.

One attachment per call. The browser loops attachments sequentially and shows progress; a failure on one file does not stop the others. The server keeps nothing.

Environment: existing `NVIDIA_NIM_API_KEY`, `NVIDIA_NIM_MODEL`, `AI_ASSIST_PASSCODE`, `SMTP_USER`, `SMTP_PASS`, `OUTREACH_ALLOWED_RECIPIENTS`, plus new `NVIDIA_NIM_VISION_MODEL` (`meta/llama-3.2-11b-vision-instruct`). Without all of them the route answers 503 and the UI says intake is not configured.

## Data model (`src/core/types.ts`, additive only)

```ts
export type IntakeFlags = {
  nameMatch: 'match' | 'partial' | 'mismatch';   // entityNameSeen vs the proposed entity's name
  periodInYear: boolean;                         // both dates inside the request's financial year, or dates unreadable
  syntheticMarker: boolean;                      // the model saw a synthetic/fictional marker on the page
  targetValid: boolean;                          // proposed request exists, belongs to proposed entity, review still pending
};
export type IntakeDocument = {
  docType: string; entityNameSeen: string; periodStart: string; periodEnd: string;
  amounts: { label: string; amountCents: number | null }[];
  proposedEntityId: string; proposedRequestId: string;
  confidence: 'high' | 'medium' | 'low'; reason: string;
  flags: IntakeFlags;                            // filled by code, never by the model
};
export type IntakeProposal = {
  id: string; messageId: string; attachmentIndex: number; filename: string; contentType: string;
  size: number; fileHash: string; model: string; promptVersion: string; createdAt: string;
  source: 'image' | 'pdf_text';
  documents: IntakeDocument[];
  review: { status: 'pending' | 'accepted' | 'rejected'; decidedAt: string; note: string };
};
// Workspace gains: intake?: IntakeProposal[]   (optional; absent in earlier saved workspaces)
```

`src/lib/storage.ts` mirrors this with `intake: z.array(intakeProposalSchema).max(500).optional()`, following the guidance branch's reasoning: optional, not defaulted, so an old workspace round-trips unchanged. Bounds: `documents` ≤ 10 per proposal, `amounts` ≤ 30 per document, strings ≤ 300 characters, `reason` ≤ 1000.

## Core (`src/lib/intake.ts`, pure, no I/O)

| Function | Purpose |
|---|---|
| `PROMPT_VERSION = 'intake-1'` | |
| `buildIntakeContext(state)` | Entities `{ entityId, entityName, entityType }` and open requests `{ id, entityId, lineId, label, question, component, basis, financialYear }` where `review === 'pending'` and not paused. No evidence, answers or notes are sent. |
| `buildIntakeMessages(context, input)` | `input` is `{ kind: 'image', jpegBase64 }` or `{ kind: 'text', text }`. System prompt: synthetic Australian family-group data; FY2026 = 1 July 2025 – 30 June 2026; one image may hold several documents; return one item per document; copy names, dates and amounts exactly as printed; choose `proposedEntityId` and `proposedRequestId` only from the supplied lists, else empty string; never invent amounts; note any "synthetic" or "fictional" marker. User message carries the context JSON, the schema and the image (`image_url` content part) or the text. |
| `parseIntakeReply(content)` | Extracts the first `{…}` block, parses, coerces `"$108,125.00"` / `"1,325.00"` / `"(5,000.00)"` to integer cents (negative for parentheses), rejects the reply when nothing parses. |
| `verifyIntake(documents, context)` | Sets `flags`. `nameMatch` compares `entityNameSeen` with the proposed entity's name, or with every entity name when `proposedEntityId` is empty or unknown (best result wins): case-insensitive equality → `match`; either name's surname/token set overlaps → `partial`; else `mismatch`. `periodInYear`: both dates parse and fall inside the target request's financial year (FY2026 when the target is invalid), or either date is unreadable (then `true`, the date left as read so the adviser sees the raw text). `targetValid`: `proposedRequestId` names a request that exists, belongs to `proposedEntityId`, and has `review === 'pending'`; an empty or unknown id is `false`. Proposals with `mismatch` or `!targetValid` are kept and shown; they are never discarded. |
| `applyIntakeDocument(state, proposal, docIndex, choice)` | `choice = { requestId, amountCents, description }` — the adviser's final target and figure, which may differ from the model's. Builds `EvidenceInput` with `entityId`, `financialYear`, `lineId`, `component`, `currency`, `basis` copied from the chosen request (so `receiveEvidence`'s equality checks pass), `documentId = intake-<hash16>-<docIndex>`, `filename`, `fileHash`, then calls `receiveEvidence`. Marks the proposal `accepted` and logs `intake_accepted` with model, prompt version, file hash, chosen request and whether the adviser overrode the model's target. |
| `rejectIntakeProposal(state, proposalId, note)` | Marks `rejected`, logs `intake_rejected`. |
| `recordIntakeProposal(state, proposal)` | Appends to `state.intake`, replacing an earlier pending proposal for the same `messageId + attachmentIndex`, logs `intake_read`. |

Amounts: the model's `amounts` list is a menu. The adviser picks (or types) the one figure that becomes `amountCents` on the evidence row; a document with no usable figure is accepted with `amountCents: null` (permitted by `receiveEvidence`). The existing closing-balance rule in `receiveEvidence` still applies and its error is shown as-is.

## Server

### `src/lib/inbox-reader.ts` — `downloadGmailAttachment(config, messageId, index, deps)`

Same connection options, allow-listed senders and 30-day window as `readGmailInbox`. Searches `INBOX` by `Message-ID` header, verifies the single sender is allowed, reuses `inspectStructure` to enumerate attachments in the same order the inbox listing reported, downloads the `index`-th part with `maxBytes = 8 MB`. Errors: `not_found`, `too_large`, `unsupported_type`, plus the existing `configuration | timeout | provider`. Accepted content types: `image/jpeg`, `image/png`, `application/pdf` (by declared type; the bytes are also sniffed for the JPEG/PNG/PDF magic numbers, and a mismatch is `unsupported_type`). Mail is not marked read or deleted.

### `src/lib/intake-server.ts` — file preparation (server-only)

- `prepareImage(bytes)`: `sharp` (new dependency) → auto-orient, resize to fit 1200 px, JPEG. Start at quality 70 and step down by 10 until the base64 is under 170 KB; below quality 30 reduce the long edge to 900 px and retry once; otherwise fail `unreadable`.
- `preparePdf(bytes)`: `pdf-parse` (new dependency) text of up to 20 pages; if ≥ 200 non-whitespace characters, return `{ kind: 'text', text }` bounded to 20,000 characters (the existing assist limit); otherwise `unreadable` ("scanned PDF — no text layer"). No page rendering.
- `sha256(bytes)` of the **original** bytes, not the shrunk image.

### `src/app/api/intake/route.ts`

`POST` body `{ messageId, attachmentIndex, context }` validated with zod (`context` is the output of `buildIntakeContext`, re-validated server-side against size bounds: ≤ 20 entities, ≤ 200 requests). Order of checks mirrors `/api/assist` and `/api/guidance`:

1. Configuration missing → 503.
2. `gate()` → 401 / 403.
3. Body invalid → 400.
4. Download → 404 `not_found`, 413 `too_large`, 415 `unsupported_type`, 502 provider, 504 timeout.
5. Prepare → 422 `unreadable` with the reason text.
6. Model call: `NVIDIA_NIM_VISION_MODEL` for images, `NVIDIA_NIM_MODEL` for PDF text (with the existing `chat_template_kwargs.enable_thinking: false` when the model is a Nemotron). `temperature 0.1`, `max_tokens 1500`. One shared 54 s `AbortController` deadline over download, preparation and both model attempts; `maxDuration = 60`. One retry when the reply does not parse, appending "Return only the JSON object". Unparseable after retry → 502. HTTP 429 → 503 with a retry-later message, not retried.
7. Response 200 `{ file: { filename, contentType, size, sha256, bytesBase64 }, proposal }` where `proposal` is complete except `id` and `review`, which the browser fills through `recordIntakeProposal`.

No server-side logging of content, filenames, message IDs or model output. `cache-control: no-store`.

### `src/lib/intake-client.ts`

`readAttachment(passcode, messageId, index, context)` → parses the response, decodes bytes, computes SHA-256 in the browser and refuses the result if it differs from the server's, calls `keepOriginal(hash, bytes)`, returns the proposal. Same shape as `assist-client.ts`.

## UI

`src/components/inbox-panel.tsx` (adviser view only): each reply that has attachments gains a **Read N attachments** button and, once proposals exist, an **Attachments** section listing one card per file. Progress text "Reading 2 of 5…" while looping; a per-file error stays on that card and the loop continues. Loading and failure never resemble success.

New `src/components/intake-review.tsx` renders one proposal card:

- Header: filename, size, content type, source (`image` / `pdf_text`), model and prompt version, file hash prefix.
- Thumbnail from IndexedDB (`readOriginal`) for images; a "PDF, text extracted" label otherwise.
- One block per document: document type, entity name seen, period seen, amounts table (label, figure), model's reason and confidence.
- Target: entity `<select>` → open-request `<select>` prefilled from the proposal. Changing either is an explicit override and is recorded in the audit detail.
- Figure: `<select>` over the model's amounts plus "none" plus a free numeric input; description text prefilled `"<docType> — <entityNameSeen> — <period>"`, editable.
- Flags as text badges, never colour alone: `Name mismatch: "Oakwood Family Trust" is not an entity in this family`, `Partial name match`, `Period outside FY2026`, `Synthetic marker seen`, `Proposed request is closed or belongs to another entity`.
- **Accept as evidence** is disabled while `nameMatch === 'mismatch'` or `targetValid === false` until the adviser changes the target; the button label then reads **Accept with adviser override**. **Reject** with an optional note. Both call `act()` with the core functions.
- Accepted documents show "Linked to <line> as <documentId>" with a link that opens that request. The request panel's existing evidence list shows the row; nothing there changes.

Client-view simulation hides the button and the cards. Plain CSS in `globals.css`, additive classes only. Thomas's track is told before this lands; the change is confined to the Inbox screen.

## Testing

- `tests/intake.test.ts` (Vitest): `parseIntakeReply` with prose-wrapped JSON, `$`/comma/parenthesis amounts, empty and malformed replies; `verifyIntake` for match / partial / mismatch names, in-year / out-of-year / unreadable dates, request under the wrong entity, reviewed request; `applyIntakeDocument` links evidence, copies request fields, logs override; closing-balance conflict surfaces the workflow error unchanged; `rejectIntakeProposal`; `recordIntakeProposal` replaces a pending duplicate; storage round-trip with and without `intake`.
- `tests/intake-server.test.ts`: `prepareImage` size loop with a generated large PNG; `preparePdf` text and no-text branches; `downloadGmailAttachment` with the existing mocked IMAP client for found / not found / wrong sender / oversize / type mismatch.
- `tests/intake-route.test.ts`: route invoked directly with mocked IMAP and mocked `fetch` for 503, 401, 403, 400, 404, 413, 415, 422, 502 (bad JSON twice), 503 on 429, 504 on deadline, 200 image path, 200 PDF-text path.
- Playwright `tests/intake.spec.ts`: mocked `/api/inbox` reply with one JPEG attachment and mocked `/api/intake` returning the fixture proposal with a name mismatch → button → card shows mismatch and disabled accept → adviser changes target → accept → evidence appears on the trust bank request → reload → still linked. Existing journeys unchanged.
- Fixture: one synthetic JPEG under `tests/fixtures/intake/` (a shrunk copy of the demo bank statement image) and one text PDF.

## Limits, stated in README

Model reads are proposals; figures can be wrong (observed on the probe) and must be checked against the thumbnail. One file per call, sequentially; roughly 9 s each on the tested model. The 90b model is too slow on this tier. Scanned PDFs without a text layer are not read. Photos holding several documents read worse than one document per photo. Attachment bytes live in the adviser's browser only; the server keeps nothing. The Reviewer identity is the browser session, not authentication.

## Out of scope

Family-group model and liaison email, tree UI, Excel write-back, automatic classification on inbox check, manual drag-drop upload into this pipeline, PDF page rendering, OCR fine-tuning, server-side storage.

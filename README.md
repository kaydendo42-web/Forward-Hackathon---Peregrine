# Peregrine — family-group compliance collection (synthetic demo)

Forward hackathon entry. An adviser-reviewed prior-year workbook supplies the recurring information needs for an Australian family group (individuals, a company and a trust). The app turns that baseline into targeted next-year requests, collects structured evidence, tracks amount gaps and duplicates, drafts outreach, and hands a versioned review workbook back to the adviser. Advisers keep every tax decision.

**This is a browser-local demonstration on synthetic data.** No Supabase, Google Drive, Xero, scheduler or ATO lodgment is connected. AI proposals and email sending are optional, server-gated add-ons. The interface says so on every screen. See [Limits](#limits) before describing it to anyone.

**Team: [start with the handoff directory](docs/team/README.md).** [Jason: guidance/checklists](docs/team/jason/README.md) · [Thomas: visual design](docs/team/thomas/README.md) · [Kayden + Codex: AI and integration](docs/team/kayden/README.md). Each track has its next deliverable, relevant files and completion checks.

## Quick start

Requires Node 22+.

```sh
npm ci
npm test            # unit and route tests (Vitest)
npm run typecheck   # next typegen && tsc --noEmit
npm run test:e2e    # Playwright journeys; starts the dev server itself
npm run build
npm run dev         # http://127.0.0.1:3000
```

Playwright needs a Chromium. Either `npx playwright install chromium`, or point it at an installed Chrome:

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm run test:e2e
```

Browser tests run in an isolated headless profile, not your own Chrome.

To run the same journeys against a deployed URL instead of the local dev server:

```sh
PLAYWRIGHT_BASE_URL=https://peregrine-forward-hackathon.vercel.app npm run test:e2e
```

## Demo script (about three minutes)

1. **Load synthetic family.** Four FY25 workbooks (1 July 2024 – 30 June 2025) import from `public/samples/fy25/`. Prior-year amounts stay in a comparative column; nothing is carried into FY26.
2. Select **Alex Taylor** → **Generate FY26 requests.** Five recurring requests come from the reviewed FY25 lines plus an independent "What changed?" question.
3. **Draft initial outreach.** Open the **Outbox** tab. With SMTP configured, **Send to family (demo)** emails it to the verified inbox and the draft is marked sent with its message ID; otherwise download it.
4. Select **Cash dividends** → enter FY26 comparison `5200` → **Save comparison.**
5. Upload `alex-wrong-year.csv` (Files tab). Rejected: `Evidence financialYear mismatch: expected 2026, received 2025`.
6. Upload `alex-dividend-a.csv` ($4,200). Difference shows **$1,000.00**.
7. Upload `alex-dividend-b.csv` ($1,000). Difference shows **$0.00**. Upload it again: duplicate ignored, nothing double-counted.
8. Write a review note → **Accept evidence for demo.** Reload the page: state survives.
9. **Export review workbook.** In Excel change one row's `decision` / `review_note` only. **Preview review import** → confirm.
10. Import the same file again: rejected as stale, because the confirmed change advanced the workspace version.

One matched dividend schedule does not complete the engagement; the other requests are reviewed separately.

## What is in the repository

| Path | Purpose |
|---|---|
| `src/core/` | Pure, immutable workflow: baseline confirmation, request generation, evidence linking, reconciliation, review gates, pauses, draft outbox, versioned review changes. No React, no I/O. |
| `src/lib/workbooks.ts` | Named-table XLSX import/export via ExcelJS. Rejects formulas in data, macros, external links, XML entities, oversized archives. |
| `src/lib/evidence.ts` | Strict CSV parser, integer cents, bounded sizes, duplicate detection. |
| `src/lib/storage.ts` | Zod-validated localStorage workspace, optimistic version check across tabs, IndexedDB retention of original files by SHA-256. |
| `src/lib/samples.ts` | Catalogue of every sample link the UI shows; a test checks each file exists. |
| `src/components/` | Plain React interface. Thomas replaces the visuals; the workflow does not depend on them. |
| `outputs/fy25-baseline/` | The four authored FY25 workbooks (source of truth). Byte-identical copies in `public/samples/fy25/`. |
| `fixtures/fy25/` | FY25 evidence CSVs and `manifest.json` describing the import contract. See `docs/workbook-guide.md`. |
| `public/samples/fy26/` | Test evidence: correct, short, wrong-year, wrong-component, company bank balance. |
| `tools/workbooks/` | Reproducible workbook builder and verifier. Its authoring runtime is not bundled. |
| `docs/` | Design, implementation checklist, workbook guide and `docs/team/` ownership handoffs. |

Import contract, stable line IDs and evidence columns are documented in `docs/workbook-guide.md` and `fixtures/fy25/manifest.json`.

## Limits

State this plainly in the pitch.

- Synthetic entities only: Alex Taylor, Sam Taylor, Taylor Services Pty Ltd, Taylor Family Trust. No real TFNs, bank identifiers or signatures. Workbooks are limited prototype workpapers, not tax-return templates or lodged records.
- Request wording uses deterministic demo rules (`demo-method-1`). The optional AI assist only *proposes*; nothing it produces is applied without an adviser clicking Accept, and the demo runs identically with it unconfigured.
- Evidence intake is structured CSV. No PDF/image OCR.
- The client-view toggle is a simulation, not a permission boundary. The activity log is local and not tamper-proof.
- Review import changes only `decision` and `review_note`. There is no accepted-FY26 snapshot rolling into FY27; the annual loop is designed, not built.
- Cross-tab conflicts are detected optimistically (version check at save) and reported; there is no server arbitration.
- No measured time-saving claims. Nothing has been tested with real clients.

## AI assist (optional, NVIDIA NIM)

An adviser-only panel under each request asks a NIM-hosted model for **proposals**:

| Button | Model receives | Accept does |
|---|---|---|
| Propose follow-up wording | request, evidence summary, current note | records a `follow_up` decision with that note (it then appears in reminder drafts) |
| Propose reworded question | baseline line, current question | replaces the FY26 question; open drafts are superseded |
| Extract from pasted text | pasted statement text | links evidence rows through the normal gates; entity/year/component are fixed from the request, never taken from the model |
| Triage reported changes | client's "What changed?" answer, existing lines | adds an approved planning request per accepted item |

Every acceptance writes an `ai_proposal_accepted` activity event with the model and prompt version (`assist-2`). Dismissed proposals are discarded. Follow-up context includes the workflow's calculated current-year evidence total and difference; prior-year amounts remain comparative only.

Setup — server-side only, never `NEXT_PUBLIC_`:

```sh
cp .env.example .env.local   # then fill in:
NVIDIA_NIM_API_KEY=...       # from build.nvidia.com
NVIDIA_NIM_MODEL=...         # current demo: nvidia/nemotron-3.5-lightning-30b-a3b
AI_ASSIST_PASSCODE=...       # any shared string; advisers type it once per browser session
```

Set the same three in the Vercel project (Settings → Environment Variables) and redeploy. Without all three, `/api/assist` returns 503 and the panel says so.

Route safety: passcode compared in constant time, `Sec-Fetch-Site` must be same-origin, zod-validated body, 20 000-character text cap, one shared 54-second model-call deadline, one retry when the model's JSON is unusable, no content logging. The passcode limits drive-by credit use; it is not authentication. Add a Vercel WAF rate-limit rule on `/api/assist` before any wider audience.

The configured demo model is `nvidia/nemotron-3.5-lightning-30b-a3b`, with thinking disabled via `chat_template_kwargs.enable_thinking: false`, a 1,500-token output allowance and temperature 0.1. All four actions plus a no-changes case passed live hosted checks on 13 September 2026 in 2.8–7.0 seconds per case. See [the verification record](docs/ai-verification.md) for inputs, acceptance checks and limits. The non-thinking setting follows [NVIDIA's deployment guide](https://docs.nvidia.com/nim/large-language-models/2.0.10/get-started/advanced/get-started-nemotron-3.5-lightning.html).

Kimi K3 remains supported with low reasoning effort, 4,096 output tokens and temperature 1, but it timed out in the live checks. Other models retain the generic 1,500-token/temperature-0.1 settings. There is no automatic model fallback. Switching models requires an explicit server setting and fresh verification.

## Email sending (optional, Gmail SMTP)

Two mailboxes play two roles:

| Role | Address | Owns |
|---|---|---|
| Firm / agent (sender) | `SMTP_USER` — a Gmail you control for the demo, e.g. `peregrine.adviser.demo@gmail.com` | App Password lives here; replies land here |
| Family group (external client, recipient) | `taylorfamilyexample@gmail.com` | Receives requests, replies like a real client |

Outbox drafts are emailed **from** the firm mailbox **to** the family inbox. The server only sends to addresses on `OUTREACH_ALLOWED_RECIPIENTS`; the browser cannot widen that. Sent drafts record recipient, time and SMTP message ID (also stamped in `X-Peregrine-Draft` / `X-Peregrine-Entity` headers) and are never superseded afterwards.

```sh
SMTP_USER=peregrine.adviser.demo@gmail.com   # firm mailbox
SMTP_PASS=xxxx xxxx xxxx xxxx                # its Google App Password (needs 2-Step Verification)
OUTREACH_ALLOWED_RECIPIENTS=taylorfamilyexample@gmail.com
```

Uses the same `AI_ASSIST_PASSCODE` gate. **The live email round trip is verified**: the hosted app sent the synthetic outreach, retrieved the family reply, matched it to Alex's request and saved the relevant answer after explicit acceptance. A second poll produced no duplicate. Adviser review remains separate. See PICKUP.md for the verification record and the Inbox section below for the walkthrough.

## Deploying

Live: **https://peregrine-forward-hackathon.vercel.app** (Vercel project `peregrine-forward-hackathon`, default GitHub branch `feat/compliance-demo`). The original two browser journeys were checked against the live URL; the expanded four-journey suite covers the Inbox locally with mocked mail. The actual hosted email round trip was verified separately.

The app is Next.js 16 with server routes for AI assist, sending and inbox checks. Optional integrations require server environment variables; workflow state remains browser-local. `vercel.json` pins the framework preset; without it a CLI-created project defaults to static hosting of `public/` and the app root 404s.

Use the existing `peregrine-forward-hackathon` project. Settings: framework **Next.js**, root directory `/`, build `npm run build`, install `npm ci`, Node 22. The `peregrine-partners` / `peregrinepartners` projects are unrelated. Keep deployment protection on for previews. The recorded setup uses manual CLI deployments; GitHub auto-deploy is not configured.

## Inbox: family → Peregrine

The same firm mailbox sends and receives. `SMTP_USER` is the firm address; `OUTREACH_ALLOWED_RECIPIENTS` contains family addresses allowed for both sending and inbox collection. The app does not create a mailbox for you. For a personal Gmail account, IMAP is already enabled; there is no enable/disable toggle ([Google guidance](https://support.google.com/mail/answer/75726?hl=en)). The demo uses the firm's App Password for SMTP and IMAP. Enter credentials directly in `.env.local` and the Vercel project, never in the repository or chat.

1. Configure `SMTP_USER`, `SMTP_PASS`, `OUTREACH_ALLOWED_RECIPIENTS`, and `AI_ASSIST_PASSCODE`.
2. Load the family, generate FY26 requests, draft outreach and send from the Outbox.
3. In the family mailbox, reply to that email. This preserves the email thread references.
4. In Peregrine, open **Inbox → Check inbox**. The server reads the most recent 50 eligible messages from the last 30 days without marking mail read or deleting it.
5. Review the reply, choose the request, remove quoted history from the proposed answer, and click **Accept reply as answer**. Thread references suggest requests; unmatched mail requires an explicit manual assignment. Acceptance appends to any existing answer and reopens review.
6. **Open request and AI assist** to triage a current-year change or review the relevant evidence. An email answer is not accepted financial evidence.

Replies and acceptance records survive reload in this browser. Polling deduplicates message IDs; the same reply cannot be accepted twice for the same request. This demo retains up to 200 replies and 1,000 reply acceptance records. Older saved workspaces load with empty Inbox records.

Only plain-text email content is retrieved, bounded to 20,000 characters. HTML-only messages require reading the original mailbox and entering relevant text. Attachment names/types/sizes are listed, but attachment bytes are not fetched: download a CSV from the firm mailbox and use the existing evidence upload, or paste statement text into AI assist for a proposal. No background inbox polling, production authentication, or durable shared mailbox state is implemented.

## Next milestones

1. **Integrate teammate work.** Jason prepares a reviewed guidance-change proposal; Thomas polishes the working demo journey. Live email and the five representative AI cases are verified.
2. **Rehearse and record** one synthetic client journey, including an evidence gap, AI proposals and explicit adviser review. Repeat the live AI smoke check before recording; provider latency can change.
3. **Shared production state:** Supabase authentication/entity access, evidence metadata, review events and durable inbox/outbox with retries.
4. **Documents and accounting:** Google Drive with selected-file access, then read-only Xero once university account permissions are verified.
5. **Annual rollover:** immutable accepted FY26 snapshot, then FY27 request generation.
6. **Jason's guidance updates:** reviewed, versioned method changes; no invented live ATO feeds.

See `docs/competitive-landscape.md` for the current product comparison and proposed positioning.

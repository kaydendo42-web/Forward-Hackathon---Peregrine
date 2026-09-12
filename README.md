# Peregrine — family-group compliance collection (synthetic demo)

Forward hackathon entry. An adviser-reviewed prior-year workbook supplies the recurring information needs for an Australian family group (individuals, a company and a trust). The app turns that baseline into targeted next-year requests, collects structured evidence, tracks amount gaps and duplicates, drafts outreach, and hands a versioned review workbook back to the adviser. Advisers keep every tax decision.

**This is a browser-local demonstration on synthetic data.** No Supabase, Google Drive, Xero, email, scheduler, AI extraction or ATO lodgment is connected. The interface says so on every screen. See [Limits](#limits) before describing it to anyone.

## Quick start

Requires Node 22+.

```sh
npm ci
npm test            # 43 unit tests (Vitest)
npm run typecheck   # next typegen && tsc --noEmit
npm run test:e2e    # 2 Playwright journeys; starts the dev server itself
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
3. **Draft initial outreach.** Open the **Outbox** tab: a draft, never sent.
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
| `docs/` | Design, implementation checklist, workbook guide. |

Import contract, stable line IDs and evidence columns are documented in `docs/workbook-guide.md` and `fixtures/fy25/manifest.json`.

## Limits

State this plainly in the pitch.

- Synthetic entities only: Alex Taylor, Sam Taylor, Taylor Services Pty Ltd, Taylor Family Trust. No real TFNs, bank identifiers or signatures. Workbooks are limited prototype workpapers, not tax-return templates or lodged records.
- Request wording uses deterministic demo rules (`demo-method-1`). No LLM calls exist yet.
- Evidence intake is structured CSV. No PDF/image OCR.
- The client-view toggle is a simulation, not a permission boundary. The activity log is local and not tamper-proof.
- Review import changes only `decision` and `review_note`. There is no accepted-FY26 snapshot rolling into FY27; the annual loop is designed, not built.
- Cross-tab conflicts are detected optimistically (version check at save) and reported; there is no server arbitration.
- No measured time-saving claims. Nothing has been tested with real clients.

## Deploying

Live: **https://peregrine-forward-hackathon.vercel.app** (Vercel project `peregrine-forward-hackathon`, branch `feat/compliance-demo`). Both browser journeys pass against it.

The app is Next.js 16 with only static routes, no environment variables and no server storage. `vercel.json` pins the framework preset; without it a CLI-created project defaults to static hosting of `public/` and the app root 404s.

Vercel import settings: framework **Next.js**, root directory `/`, build `npm run build`, install `npm ci`, Node 22. Create a **new** project with a hackathon-specific name; do not attach it to the existing `peregrine-partners` / `peregrinepartners` projects. Keep deployment protection on for previews.

## Next milestones

1. **LLM assistance (NVIDIA NIM, Kimi).** Server-only route handler; key in `NVIDIA_NIM_API_KEY` (`.env.local`, Vercel env), never `NEXT_PUBLIC_`. First use: propose follow-up wording and extract fields from pasted statement text, shown as *proposals* the adviser accepts or edits. Every proposal cites its source lines and is logged with the method version.
2. **Supabase** for authenticated, entity-scoped requests, evidence metadata and review events (RLS per entity). Browser storage becomes a dev adapter.
3. **Google Drive** with `drive.file` scope for original documents in entity/year folders. Drive stores files, not request state.
4. **Xero read-only** ledger comparisons once the university account's API permissions are confirmed.
5. **Durable outbox** with verified recipients before any email is sent.
6. Jason's guidance updates: reviewed, versioned method changes; no invented live ATO feeds.

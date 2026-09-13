# PR draft — guidance agent and one reviewed checklist-change proposal

Draft text for a PR from `feat/jason-guidance-agent` into `feat/compliance-demo`. Not yet opened.

---

## What this adds

Jason's guidance track: an agent that keeps the FY26 request checklist current as official
guidance changes, plus the one reviewable checklist-change proposal the brief asked for.

The written proposal is [`proposal-2026-09-13-ALE-DIV-CASH.md`](proposal-2026-09-13-ALE-DIV-CASH.md).
Everything else is **new files**, deliberately, so nothing collides with in-flight application work.

For each of the 18 baseline lines the agent retrieves the passages bearing on it, asks the model
whether that line's `request_text` should change, and requires any proposal to quote the passage it
relied on. **A proposal whose quote is not found verbatim in the source it cites is discarded in
code before an adviser sees it.** An adviser then accepts or rejects. Nothing publishes itself and
there is no auto-apply path.

## Behaviour before and after

| | Before | After |
|---|---|---|
| Request wording | Fixed at `demo-method-1`, changeable only by editing the fixture | An adviser can accept a sourced proposal that advances **one** line to `demo-method-2` |
| Guidance sources | None in the repo | 10 fetched ATO FY2026 pages + 1 labelled synthetic fixture, with a hash register |
| Existing FY26 requests | — | **Unchanged by an acceptance.** New wording applies at the next `startSeason()` |
| Audit | — | `guidance_proposals_recorded`, `guidance_proposal_accepted`, `guidance_proposal_rejected`, each naming model, prompt version, source id and source hash |
| With AI unconfigured | Demo runs | Demo runs identically; `/api/guidance` returns 503 and the panel says so |
| Navigation | Requests / Outbox / Inbox / Files / Activity / Connections | Adds a **Guidance** tab (adviser view only, hidden in client-view simulation) |

## Shared-type changes — all additive, nothing renamed, removed or re-typed

| File | Change |
|---|---|
| `src/core/types.ts` | `BaselineLine.methodVersion?: string` — **optional**; absent means `demo-method-1` |
| `src/core/types.ts` | `Workspace.guidance?: GuidanceProposal[]` — **optional**; absent in workspaces saved before this branch |
| `src/core/types.ts` | New exported types `SourceStatus` and `GuidanceProposal` (additions only) |
| `src/lib/storage.ts` | Mirrors both: `methodVersion: text.optional()` on the line schema, `guidance: z.array(guidanceProposalSchema).max(500).optional()` on the workspace schema |
| `src/components/workspace.tsx` | **3 insertions, 1 deletion**: the import, `'Guidance'` added to the existing `!clientView` tab group, and one render line |

`src/core/workflow.ts` is **unmodified**: `METHOD_VERSION` still reads `demo-method-1` and no
existing exported signature changed. The accept path calls the existing `logEvent`.

Both storage additions are `.optional()` rather than defaulted. A `.default([])` on `guidance`
made `parseSavedWorkspace` return `guidance: []` where the input had no such key, which broke three
existing assertions in `storage.test.ts`. Optional gives the same backwards compatibility — old
saved workspaces load — without changing the round-trip behaviour those tests assert.

## Files added

```
guidance/sources/            10 ATO FY2026 pages (.txt + .json sidecar) + register.md
guidance/sources/SYNTHETIC-dividend-evidence-fixture.{txt,json}
guidance/index.json          77 passages, 600-word windows / 80-word overlap, with embeddings
guidance/proposals/          sweep output, one file per line that produced a verified proposal
src/lib/guidance.ts          pure core: chunking, both scoring modes, prompts, parseReply,
                             verifyQuote, applyGuidanceProposal / rejectGuidanceProposal
src/app/api/guidance/route.ts       gated proxy mirroring /api/assist
src/components/guidance-panel.tsx   adviser review gate
tools/guidance/{fetch-sources,build-index,sweep}.mjs
tests/guidance.test.ts              31 tests
docs/team/jason/proposal-2026-09-13-ALE-DIV-CASH.md
docs/team/jason/PR-DRAFT.md
```

`docs/team/jason/README.md` gains a "What was built" section appended at the end; Kayden's
original text is byte-for-byte unchanged.

## Route safety — copied from `/api/assist`, not reinvented

Same `gate()` (constant-time passcode on `x-assist-passcode`, `Sec-Fetch-Site` must be
same-origin), zod-validated body, one shared 54-second `AbortController` deadline with
`maxDuration = 60`, one retry when the JSON is unusable, no content logging, 503 when
`NVIDIA_NIM_API_KEY` / `NVIDIA_NIM_MODEL` / `AI_ASSIST_PASSCODE` are not all set. Model options
match the existing route exactly, including `chat_template_kwargs.enable_thinking: false` for
Nemotron Lightning.

Retrieval runs server-side rather than in the browser for two reasons: the index is too large to
ship to a client, and quote verification must run against passages the **server** retrieved. A
quote checked against client-supplied text would prove nothing.

## Commands run

| Command | Result |
|---|---|
| `npm test` | **124 passed** (was 93 on the base branch; +31) |
| `npm run typecheck` | pass |
| `npm run build` | pass; `/api/guidance` registered as a dynamic route |
| `node tools/guidance/fetch-sources.mjs` | 10/10 ATO pages saved, 225,695 characters |
| `node tools/guidance/build-index.mjs` | 77 passages embedded in 10.8 s, 2048 dimensions |
| `node tools/guidance/sweep.mjs` | 18 lines swept live; 6 verified proposals, 0 unverified written |
| Live route check (dev server) | 401 without passcode, 401 wrong passcode, 403 cross-site, 400 bad body, 200 with a verified proposal in 12.8 s |
| Manual browser check | load family → generate requests → Guidance tab → load proposal → accept → reload |

`npm run test:e2e` was **not** run.

### Sweep result

| Outcome | Lines |
|---|---|
| Verified proposal | `ALE-DIV-CASH` (synthetic fixture), `ALE-DIV-CREDIT`, `ALE-EMP`, `ALE-INT`, `TR-DIST-ALE`, `TR-DIST-SAM` |
| Returned `{"items":[]}` | all Sam's lines, all five company lines, `TR-BANK`, `TR-INVEST`, `TR-DOC` |
| Proposed then dropped by quote verification | `ALE-TRUST` |

Every written proposal was re-checked independently of the agent: each quote appears verbatim in
the saved source text, and each `sourceHash` and `sourceStatus` matches its sidecar.

### Manual browser check, in full

Loaded the synthetic family, generated Alex's FY26 requests, opened **Guidance**, loaded
`guidance/proposals/ALE-DIV-CASH.json`, and accepted. Result: the baseline line advanced to
`demo-method-2`; the activity record gained the accept event with model, prompt version, source id
and source hash. **After reloading the page**, Alex's Cash dividends *request* still read
*"FY2026: Provide current-year dividend statements showing the cash dividend components."* and
still showed `demo-method-1` — the accepted wording changed the baseline, not the request already
issued, which is the intended behaviour.

## What is synthetic, stated plainly

- All four entities and every workbook remain synthetic. No fixture, workbook or sample was
  modified by this branch.
- The 10 ATO pages are **real**, fetched on 13 September 2026, each with the page's own stated
  `dcterms.modified` date and a SHA-256 of the saved text.
- **The one source that drives the `ALE-DIV-CASH` change is fabricated.** It is labelled
  `synthetic test fixture` in its filename, its first line, its sidecar, the register, the
  proposal's `sourceStatus`, the proposal document and a prominent badge in the review panel. It
  states no real rule and no real ATO requirement changed.
- No claim is made that any real ATO rule changed. No FY25 source is used to justify an FY2026
  requirement. Nothing announced-but-not-enacted is presented as final guidance.

## Remaining gaps and known limits

1. **Model output is not reproducible.** A sweep can propose for a line on one run and return
   nothing on the next at the same temperature — `ALE-EMP` proposed while the identically-worded
   `SAM-EMP` did not. Describe it as "the agent proposed six changes **on this run**".
2. **The reported sweep numbers are a composite** of one full 18-line run plus targeted re-runs
   of affected lines after two defects were fixed mid-phase. Every proposal on disk is post-fix
   and verifies, but no single clean 18-line pass has been recorded end to end.
3. **The hosted route may need Vercel file tracing** for `guidance/index.json`, which it reads
   from disk. Locally and in `next build` this works. If the file is not traced, the route
   answers 503 with a clear message rather than failing oddly.
4. **The embedding model is a live dependency that has already broken once.** `nv-embedqa-e5-v5`
   reached end of life on 25 August 2026 and now answers HTTP 410; the index is built with
   `nvidia/nemotron-3-embed-1b`, overridable via `NVIDIA_NIM_EMBED_MODEL` (optional, used only by
   the build tool). Committed vectors keep working regardless, and keyword/BM25 is the automatic
   fallback.
5. **The corpus is a snapshot**, refreshed by running `fetch-sources.mjs` by hand. A changed ATO
   page is noticed only when the hash differs on a re-fetch. There is no monitoring job, by design.
6. **`TR-BANK` and `TR-INVEST` have only indirect source coverage** (the record-keeping pages
   rather than a dedicated trust balance-sheet page).
7. **The review panel's "Reviewer" field is self-asserted**, not authentication, and is labelled
   as such. The proposal document deliberately leaves reviewer and decision date empty.
8. The panel shows a source's title and URL only when the register loads from `GET /api/guidance`,
   which needs the passcode. Without it, provenance still shows source id, status, retrieval time
   and hash from the proposal itself.
9. **Line endings can invalidate the recorded `sha256` on a Windows checkout.** The repo has no
   `.gitattributes` and this machine has `core.autocrlf=true`, so `guidance/sources/*.txt` is
   stored with LF but checked out with CRLF. The hashes in the sidecars are of the LF text, so
   recomputing a hash from a Windows working copy will not match — quote verification is
   unaffected, because it normalises whitespace, but the "re-fetch and compare the hash" check
   would report a spurious change. The fix is one line in a new `.gitattributes`
   (`guidance/sources/** -text`), which I did not add because it is outside the agreed file list.
   Worth deciding before anyone relies on the hash to detect a changed page.

## Reviewer notes

- Nothing in `outputs/fy25-baseline/`, `public/samples/` or `fixtures/fy25/` was touched.
- `src/lib/assist.ts`, `/api/assist`, `/api/send/**`, `/api/inbox/**`, `inbox*.ts`,
  `send-client.ts`, `workbooks.ts` and `evidence.ts` were read but not modified.
- No test authored by someone else was modified. No new npm dependency was added.
- `guidance/index.json` is 1.67 MB of committed vectors. If that is unwelcome in the repo, running
  `node tools/guidance/build-index.mjs --keyword` rebuilds it without them; retrieval then falls
  back to BM25, which is measurably weaker on the dividend line.

# Jason — guidance and checklist updates

Your next milestone is **one reviewable checklist-change example**. Start with an existing recurring request; show why its wording might change, which entity and financial year it applies to, and who must review it before use. This is the guidance track already described in the project plan.

## First work package

1. Read [the product design](../../design.md), [workbook guide](../../workbook-guide.md), and [current limitations](../../../README.md#limits). Inspect the stable line IDs in [the fixture manifest](../../../fixtures/fy25/manifest.json).
2. Choose one narrow example, such as the evidence wording for `ALE-EMP` or `ALE-DIV-CASH`. Use a primary official source, record when you checked it, and distinguish its publication date from the year it applies to. The FY25 workbook does not establish FY26 requirements.
3. Copy [the proposal template](proposal-template.md) to a new Markdown file in this folder. Supply the current wording, proposed wording, exact source reference, applicability, rationale and review status. If you use a simulated source change, label it **synthetic test fixture** throughout; do not describe it as a real new ATO rule.
4. Include one applicable synthetic case and one excluded case. Explain what stays unchanged in requests already sent or reviewed. Leave reviewer identity and approval date empty until a real review occurs.
5. Submit the documentation PR. Kayden will use the agreed example to scope any application integration. The current demo has no guidance publication service or source-monitoring job.

## Files and boundaries

| Path | Use |
|---|---|
| `docs/team/jason/` | Your proposals, source notes and review examples |
| `docs/workbook-guide.md`, `fixtures/fy25/manifest.json` | Existing import contracts and stable identifiers |
| `src/core/workflow.ts` | Reference: current `METHOD_VERSION` is `demo-method-1` |
| `src/lib/assist.ts` | Reference: current AI proposal types and prompts |
| `outputs/fy25-baseline/` | Existing limited synthetic workbooks; do not regenerate to demonstrate a wording change |

Keep the first PR in your documentation folder. Propose changes to workflow rules or prompts in writing so they can be integrated with Kayden's AI work. No automatic rule publication, tax calculation, live ATO feed or client obligation determination is implemented.

## Starting references

The existing research recorded these official FY25 forms: [individual](https://iorder.com.au/publication/Download.aspx?ProdID=2541-6.2025), [supplement](https://iorder.com.au/publication/Download.aspx?ProdID=2679-6.2025), [company](https://iorder.com.au/publication/Download.aspx?ProdID=0656-6.2025), and [trust](https://iorder.com.au/publication/Download.aspx?ProdID=0660-6.2025). They are historical form references, not a current evidence checklist. Verify the applicable instructions and period when preparing your proposal; do not rely on a teammate's local filesystem path or assume FY25 guidance applies to FY26.

## Ready for review when

- The proposal has a working primary-source link, retrieval date, source version or hash, and a precise section reference.
- Current and proposed wording are visible side by side; entity/year scope and exclusions are explicit.
- Source status is stated, and simulated material is clearly labelled.
- Applicable/excluded examples, proposed method version and pending reviewer decision are recorded.
- Nothing claims to be approved, published or integrated before it actually is.

## What was built (13 September 2026)

The first work package above asked for one reviewable checklist-change example. That example is
[`proposal-2026-09-13-ALE-DIV-CASH.md`](proposal-2026-09-13-ALE-DIV-CASH.md).

Alongside it, and in **new files only** so nothing collides with the application work, there is a
working guidance agent that produces such proposals instead of them being written by hand. It is
additive: the demo behaves exactly as before if it is never opened, and identically with AI
unconfigured (the route answers 503 and the panel says so).

| Path | What it is |
|---|---|
| `guidance/sources/` | 10 fetched ATO FY2026 instruction pages as text, one JSON sidecar each, plus `register.md` (id, title, url, retrievedAt, sha256, publishedDate, appliesToYears, sourceStatus, synthetic) |
| `guidance/sources/SYNTHETIC-*.txt` | The single synthetic test fixture, labelled in its filename, first line, sidecar and register |
| `guidance/index.json` | 77 passages (600-word windows, 80-word overlap) with embeddings |
| `guidance/proposals/` | Sweep output, one file per line that produced a verified proposal |
| `src/lib/guidance.ts` | Pure core: chunking, both scoring modes, prompts, `parseReply`, `verifyQuote`, `applyGuidanceProposal` |
| `src/app/api/guidance/route.ts` | Gated proxy mirroring `/api/assist` — same passcode gate, same deadline, same retry, no content logging |
| `src/components/guidance-panel.tsx` | Adviser review gate, mounted as a Guidance tab |
| `tools/guidance/` | `fetch-sources.mjs`, `build-index.mjs`, `sweep.mjs` |

**How it works.** For each baseline line, retrieve the passages bearing on it, ask the model
whether that line's `request_text` should change, and require any proposal to quote the passage it
relied on. **A proposal whose quote is not found verbatim in the cited source is discarded in code
before an adviser ever sees it** — that check is the point of the design, not a nicety. Accepting a
proposal updates that one `BaselineLine.requestText`, stamps the line `demo-method-2`, and writes a
`guidance_proposal_accepted` event recording the model, prompt version, source id and source hash.
Existing FY2026 requests are never modified; new wording takes effect at the next `startSeason()`.

**What it is not.** There is no live ATO feed, no scheduled job, no auto-publication and no
auto-apply path. The corpus is a committed snapshot, refreshed by running the fetch tool by hand.
Nothing is a tax calculation or tax advice. The one synthetic fixture is the only source that
currently drives a change to a dividend line, and it is labelled as fabricated everywhere it
appears.

**Honest limits.** Model output is not reproducible run to run: a sweep can propose for a line one
time and return nothing the next, at the same temperature. The retrieval index is a snapshot, so a
changed ATO page is not noticed until the fetch tool is run again and the hash differs. The hosted
route reads `guidance/index.json` from disk, which may need Vercel file-tracing configuration
before it works on a deployment.

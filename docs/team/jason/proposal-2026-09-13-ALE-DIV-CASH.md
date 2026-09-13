# Checklist change proposal — ALE-DIV-CASH — pending review

**This proposal is derived from a SYNTHETIC TEST FIXTURE, not from real ATO guidance.** The
source quoted below was written for this demonstration. It states no legal requirement, reflects
no announced or enacted change, and must never be described to a client, an adviser or a
reviewer as a real ATO rule. It exists so the guidance agent can be exercised end to end —
retrieval, proposal, quote verification and adviser review — against a source that demonstrably
changes one line. Nothing here is approved, published or integrated.

| Field | Value |
|---|---|
| Proposal ID / author | `ALE-DIV-CASH` / drafted by the guidance agent (`guidance-1`, `nvidia/nemotron-3.5-lightning-30b-a3b`), prepared for review by Jason |
| Status | Draft — pending review |
| Real source or synthetic test fixture? | **Synthetic test fixture** (`sourceStatus: synthetic_fixture`) |
| Official source URL and title | No URL. `SYNTHETIC TEST FIXTURE - Peregrine demo guidance note: dividend evidence for the 2025-26 income year`, held at `guidance/sources/SYNTHETIC-dividend-evidence-fixture.txt` |
| Retrieved at / publication date | Retrieved (authored) 2026-09-13T07:40:55.249Z / stated date 2026-09-13 |
| Version or content hash / exact section | SHA-256 of retrieved text `8ec68eba388981949ef5a1b175040055a9737b23af44c79f98b2263369605848`; section *"Separate evidence of cash and franking components"* |
| Source status | Synthetic fixture — **not** final guidance, not draft guidance, not an announcement |
| Applicable entity types / financial years | Individuals only / FY2026 (1 July 2025 – 30 June 2026) |
| Existing stable line ID(s) | `ALE-DIV-CASH` (Alex Taylor, `dividends` / `Cash dividends` / component `cash`) |
| Current method version | `demo-method-1` |
| Proposed method version | `demo-method-2` |
| Reviewer / decision / decision date | | 

## Proposed change

| Current request wording | Proposed request wording | Reason and source reference |
|---|---|---|
| Provide current-year dividend statements showing the cash dividend components. | Provide dividend statements showing the cash dividend amount and the franking credit amount as separate figures for each holding, and confirm whether any dividends were reinvested under a dividend reinvestment plan. | The fixture states that a single combined figure cannot be reconciled against the separate cash and franking lines the firm tracks, and that amounts applied under a dividend reinvestment plan are often absent from bank records because no cash is received. Verbatim quote relied on: *"Collect dividend evidence that states the cash dividend amount and the franking credit amount as separate figures for each holding, rather than a single combined total."* — `SYNTHETIC-dividend-evidence-fixture`, section "Separate evidence of cash and franking components". |

The quote above was checked character for character against the saved source text before this
proposal was shown to anyone; a proposal whose quote is not found verbatim in the source it
cites is discarded in code and never reaches review.

## Applicability checks

- **Applicable synthetic case and expected request.** Alex Taylor (individual), FY2026, line
  `ALE-DIV-CASH`. On the next `startSeason()` the generated request reads: *"FY2026: Provide
  dividend statements showing the cash dividend amount and the franking credit amount as
  separate figures for each holding, and confirm whether any dividends were reinvested under a
  dividend reinvestment plan."* Alex's FY25 workpaper records $4,800.00 of cash dividends and
  $1,600.00 of franking credits as separate lines, so the firm already tracks the two components
  the proposed wording asks to be evidenced separately.

- **Excluded synthetic case and reason.** Taylor Family Trust. The trust has no `ALE-DIV-CASH`
  line at all — its investment income lines are `TR-INVEST`, `TR-DIST-ALE` and `TR-DIST-SAM` —
  and the proposal's `appliesToEntityTypes` is `["individual"]`. Both facts exclude it, and the
  application enforces the second: accepting this proposal against a company or trust baseline
  raises *"This proposal applies to entity types individual; Taylor Family Trust is of type
  trust."* Taylor Services Pty Ltd is excluded for the same reason. Sam Taylor is an individual
  but holds no dividend line, so nothing changes for Sam either.

- **Uncertainty requiring adviser judgment.**
  1. **The source is fabricated.** Its only legitimate use is demonstrating the mechanism. An
     adviser must not accept it as evidence that any real requirement changed.
  2. Whether a registry breakdown is obtainable for every holding, and what the firm should do
     when a client's statement genuinely shows only a combined figure, is a practice decision
     this proposal does not make.
  3. Whether to ask the dividend-reinvestment question here or on the separate `ALE-DIV-CREDIT`
     line is an adviser's call; the two lines are collected separately today.
  4. The proposed wording is longer than the current wording. Whether that is acceptable in
     client-facing outreach is a judgment for whoever owns the client relationship.

- **Effect on existing drafts, sent requests and reviewed records.** **None.** Accepting this
  proposal changes one `BaselineLine.requestText` and stamps that line `demo-method-2`. Existing
  FY2026 `CollectionRequest` records keep the wording they were created with and stay stamped
  `demo-method-1`; draft, sent and reviewed outreach is not superseded, reopened or altered; no
  evidence, comparison amount or adviser decision is touched. The new wording first appears the
  next time requests are generated for a season. This was verified in the running application:
  after accepting and reloading the page, Alex's Cash dividends request still read *"FY2026:
  Provide current-year dividend statements showing the cash dividend components."* and still
  showed `demo-method-1`.

- **Rollback or supersession approach.** Before acceptance, reject it — nothing changes and a
  `guidance_proposal_rejected` event records the decision. After acceptance, the change is
  superseded rather than silently reverted: raise a further proposal carrying the restored or
  corrected wording and advance the line to `demo-method-3`. The accepted proposal, its source
  hash and its reviewer remain in the activity record either way. A decided proposal cannot be
  decided twice.

## Review history

| Date | Person | Decision / requested revision | Version |
|---|---|---|---|
| 2026-09-13 | | Prepared for review; not yet reviewed | `demo-method-1` → proposed `demo-method-2` |

Publication is a separate future integration step. Recording a proposed version here does not
activate it in the app.

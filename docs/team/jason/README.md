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

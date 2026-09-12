# FY25 synthetic workbook pack

The four workbooks are original, limited Australian accounting workpapers for the Peregrine prototype. All names, amounts and evidence records are fictional. They contain no real TFNs, bank identifiers or signatures. They are not completed tax returns, ATO lodgment records or complete financial statements.

## Files and schedules

The baseline files are in `outputs/fy25-baseline/`. Byte-identical copies in `public/samples/fy25/` support application downloads.

| Workbook | Sheets | Imported lines |
| --- | --- | ---: |
| `alex-taylor-FY25.xlsx` | Metadata, Income, Dividends, Trust Income, Mapping, Queries, Evidence, Data | 5 |
| `sam-taylor-FY25.xlsx` | Metadata, Income, Trust Income, Mapping, Queries, Evidence, Data | 3 |
| `taylor-services-FY25.xlsx` | Metadata, Trial Balance, Bank Reconciliation, Receivables and Payables, Assets, Related Parties, Evidence, Data | 5 |
| `taylor-family-trust-FY25.xlsx` | Metadata, Trial Balance, Bank Reconciliation, Investments, Beneficiaries, Trust Documents, Evidence, Data | 5 |

Each file covers 1 July 2024 to 30 June 2025 in AUD. The Metadata sheet combines the entity profile, workbook index and scope. Specialist schedules use direct arithmetic and keyed lookups to Data and Evidence. Green figures link to another sheet; black figures calculate within the sheet. A dash represents a numeric zero. A blank document amount remains unknown / non-monetary, not zero.

## Import contract

Import by named table and column name, never by tab position or fixed cell position. The delivered tables currently start at row 6:

| Sheet | Named table | Current range |
| --- | --- | --- |
| Metadata | `Peregrine_Metadata` | A6:B16 |
| Data | `Peregrine_Lines` | A6:L11, or A6:L9 for Sam |
| Evidence | `Peregrine_Evidence` | A6:I11, or A6:I9 for Sam |

Metadata contains exact `key,value` columns. Required values are `schema_version="1"`, `workbook_id="FY25-" + entity_id`, `entity_id`, `entity_name`, `entity_type`, `financial_year=2025`, `synthetic="true"`, `template_version="1"`, `baseline_version=1`, and `status="synthetic_reviewed"`. The last value seeds the fictional demonstration baseline. It does not confer approval authority or resolve missing documents. Accepting an imported version requires an authenticated application review event.

`Peregrine_Lines` has these exact columns in order:

```text
line_id,entity_id,financial_year,category,label,component,amount,currency,basis,source_ref,recurrence,request_text
```

Amounts are numeric cells, except `TR-DOC`, whose amount is blank. Data contains no formulas. Every line uses FY2025, AUD and annual recurrence. Stable line IDs are the join keys; the visible labels are not identifiers. Cash dividends and franking credits are distinct lines even when the same source document supports them. The company shareholder loan is a payable. The workbook gives it a positive closing liability amount; its direction is stated in the label and supporting schedule.

`fixtures/fy25/manifest.json` contains the contract, entities, complete line arrays, output names and evidence filenames. Every entity has one control evidence CSV using:

```text
document_id,line_id,entity_id,financial_year,component,currency,basis,amount,description
```

Each of the 18 imported lines has exactly one corresponding control evidence record. `company-supporting-detail-FY25.csv` separately contains eight invoice, bill and equipment-detail rows. It supports the control totals; it must not be added to the control evidence as extra monetary evidence. It is identified as supplemental in the manifest.

CSV evidence is a basic structured test fixture, not a PDF extraction or genuine issuer statement. The original file and source fields should remain visible when imported. Validate line, entity, period, currency, component and basis before reconciling amounts. Prior-year figures only suggest current-year enquiries; they never populate accepted FY26 amounts.

## Accounting scope and references

The individual mapping sheets cite the supplied official FY25 forms: [Individual tax return 2025](https://iorder.com.au/publication/Download.aspx?ProdID=2541-6.2025) and [Supplementary tax return 2025](https://iorder.com.au/publication/Download.aspx?ProdID=2679-6.2025). They use only the reviewed examples: wages item 1, gross interest item 10, dividends item 11, and the selected ordinary trust-income component at supplementary item 13. This is not a full mapping of trust components. The cash dividend split between franked and unfranked amounts is not supplied, so the workbook does not invent that split or sublabels.

The company and trust have illustrative closing-balance schedules with explicitly seeded supporting equity / fund balances. Their balanced totals do not mean full accounts have been prepared. The asset schedule subtracts supplied accumulated book depreciation from cost; it calculates no tax depreciation. Investments use seeded cost carrying amounts, not live market values or a tax cost-base determination.

The trust records $18,000 ordinary income for Alex and $12,000 for Sam, matching their individual workbooks. A synthetic $30,000 pool checks the total. The document register explicitly records that the executed deed and signed distribution resolution are absent. No legal entitlement, distribution approval, tax character or tax liability is inferred.

## Verification and reproducibility

The single authoring script is `tools/workbooks/build-fy25.mjs`. It uses only the bundled `@oai/artifact-tool` package. Use the dependency runtime located by Codex `load_workspace_dependencies`; for regeneration, create `tools/workbooks/node_modules` as a local symlink to that bundled dependency directory. The temporary authoring symlink was removed after verification and is not a repository dependency installation. The artifact-operation marker was invoked exactly once before this pack's initial authoring run, with operation `create`, expected count 4 and format `xlsx`.

The authoring checks cover 40 meaningful formula results, all 18 evidence amounts and both cross-entity trust allocations. Each workbook received an Artifact Tool formula-error scan. All 31 sheets were visually reviewed using 39 rendered views; Data and Evidence were split horizontally for legible inspection. No clipped headers, clipped amounts, blank sheets or formula errors were found.

| Checked calculation | Result AUD |
| --- | ---: |
| Alex wages plus gross interest | 112,850 |
| Alex cash dividends / separate franking credits | 4,800 / 1,600 |
| Sam wages plus gross interest | 76,420 |
| Company trial balance debits / credits | 92,000 / 92,000 |
| Company adjusted bank balance | 38,000 |
| Company receivables / payables detail | 24,000 / 12,000 |
| Equipment cost less book depreciation | 43,000 − 13,000 = 30,000 |
| Company shareholder loan payable | 15,000 + 8,000 − 3,000 = 20,000 |
| Trust trial balance debits / credits | 166,000 / 166,000 |
| Trust adjusted bank balance | 16,000 |
| Trust investment carrying amount | 150,000 |
| Trust ordinary-income allocations | 18,000 + 12,000 = 30,000 |

All displayed reconciliation differences are zero. `tools/workbooks/verify-saved.py` provides read-only verification of the actual saved OOXML: named tables, metadata values, all machine cells, cached formula results, frozen Data/Evidence headers and identifiers, and byte-identical public copies. It reads XML namespaces correctly, including Artifact Tool's namespace prefixes. ExcelJS 4.4 may need the application's in-memory namespace normalization before reading these valid workbooks; do not rewrite the original upload to work around a reader limitation.

Render and calculation verification used Artifact Tool. Native Microsoft Excel opening and recalculation were not tested. Helvetica Neue is installed on the authoring host; font substitution on other systems is not verified. No macros or external workbook links are used.

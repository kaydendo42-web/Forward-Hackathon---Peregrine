# Peregrine: first working compliance workflow

Approved direction: the preceding family-group plan, followed by the user's request to create FY25 workbooks and start coding on 12 September 2026. This first milestone is a synthetic-data demonstration, not tax preparation or lodgment software.

## Scope

Four FY25 entity workbooks feed a single FY26 collection workflow. Import uses named tables, stable row IDs and explicit entity/year/component/currency/basis. Prior-year values are comparatives only. A reviewer confirms an imported baseline in the app; workbook approval text never grants authority.

Requests include recurring evidence needs and a separate current-year changes question. An adviser can add a request for an approved planning event. Uploaded structured evidence is checked for period, entity, component and duplicate document IDs before a like-for-like comparison. Missing support, mismatched amounts, answers and adviser acceptance have different states.

The demonstration must work without external credentials. Browser-local persistence is explicitly labelled and accepts synthetic records only. Adviser/client views are a simulation in this mode, not an access-control boundary. No real client information is appropriate here. Supabase is the next shared-data layer; production requires authenticated entity-scoped access, private storage, server-side transitions and an immutable audit trail.

Email output is a draft outbox. Nothing is actually sent. Draft reminders stop after a response, acceptance, not-applicable decision, or explicit pause. Queuing the same reminder twice is idempotent. There is no background scheduler in this milestone.

Evidence intake supports the supplied structured CSV records. Arbitrary PDF/OCR interpretation is not claimed. Export/re-import is a versioned review workbook; only designated review columns can change, stale versions are rejected, and an explicit app action confirms changes. A new evidence event invalidates prior review exports.

## Boundaries for Thomas and Jason

- `src/core`: pure validation and workflow functions, independent of visual styling.
- `src/lib`: Excel/CSV adapters and browser persistence.
- `src/components`: replaceable plain interface for Thomas.
- `fixtures` and `public/samples`: synthetic examples only.
- Jason's proposed guidance updater must publish reviewed, versioned rules. This milestone uses a fixed, visible method version; there is no invented live ATO update.

## Integrations

Next.js deployment on Vercel, preferably a preview deployment first. Do not push or replace the remote default branch as part of local implementation without an explicit publishing request.

Google Drive can store entity/year-scoped document packs but is not a substitute for request state or application permissions. Initially provide a Drive-ready folder layout and downloadable files. A live connector requires a Google Cloud OAuth client, redirect URL and consent. Prefer selected-file `drive.file` access over whole-Drive access. No Drive connection is claimed before it exists.

Xero is a later read-only ledger integration after the course account's permissions are verified. No financial data is written to Xero. Tax decisions remain with an appropriately qualified practitioner.

## Acceptance

Import all four supplied workbooks. Generate separate FY26 questions without carrying forward amounts. Show a $5,200 cash-dividend comparison against $4,200 supporting evidence as a $1,000 difference, then accept an additional $1,000 document without double counting. Wrong-year, wrong-entity and credit-versus-cash evidence cannot reconcile that request. Export/re-import adviser values with stale-version protection. Rehearse the whole path in a browser and build successfully for Vercel.

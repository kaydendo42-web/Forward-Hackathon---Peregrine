# Peregrine Implementation Plan

> For agentic workers: execute task-by-task with test-first verification. Workbook creation is an independent delegated task. Keep application changes in this session.

**Goal:** deliver four FY25 synthetic workbooks and a deployable, working FY26 evidence-collection demonstration.

**Architecture:** pure TypeScript workflow with explicit immutable updates, file adapters and a thin Next.js interface. Browser storage is an explicitly limited demo adapter, never a production client-data store.

**Tech stack:** Next.js, React, TypeScript, ExcelJS for application file interoperability, Vitest. Standalone supplied workbooks are authored separately with Artifact Tool.

**Spec:** `docs/design.md`.

## Global constraints

Synthetic data only. No ATO lodgment, actual email, live tax calculations or fabricated integrations. Amounts are stored in cents. Match entity, period, component, currency and basis. No arbitrary formulas or macro execution on import. Show errors without silently replacing them with zero.

## 1. Workbook fixtures

- [x] Author four independently reviewed workbook instances, with `Peregrine_Metadata` and `Peregrine_Lines` tables and supporting FY25 evidence.
- [x] Reconcile company supporting records and trust-to-individual allocations; render each tab and scan formula errors.

## 2. Workflow engine

Files: `src/core/types.ts`, `src/core/workflow.ts`, `tests/workflow.test.ts`.

Interfaces: `createWorkspace()`, `importBaseline(state, pack)`, `startSeason(state, entityId)`, `setComparison(state, requestId, amountCents)`, `receiveEvidence(state, requestId, evidence)`, `recordAnswer(state, requestId, answer)`, `reviewRequest(state, requestId, decision, note)`, `queueOutreach(state, entityId, kind)`. Every transition returns a new `Workspace` and increments `version` only on change.

- [x] Write failing tests for no prior-year carry-forward, amount gap, duplicate source, mismatched year/entity/component, review gates, reminder suppression and idempotency.
- [x] Run `npm test -- tests/workflow.test.ts`; confirm missing implementation failures.
- [x] Implement integer-cent reconciliation, deterministic request IDs, source links, separate evidence/review state, explicit pauses and a draft outbox.
- [x] Run the tests and confirm expected literal differences (100000 cents, then zero).

## 3. File round trip

Files: `src/lib/workbooks.ts`, `src/lib/evidence.ts`, `tests/files.test.ts`.

Interfaces: `readBaseline(bytes): Promise<Baseline>`, `readEvidenceCsv(text): EvidenceInput[]`, `exportReview(state, entityId): Promise<ArrayBuffer>`, `previewReview(bytes, state, entityId): Promise<ReviewChange[]>`.

- [x] Write failing cases for absent tables, formulas in data, duplicate IDs, unknown money, negative legitimate values, and stale review versions.
- [x] Implement strict named-table parsing, bounded file sizes/rows, scalar values and change previews. No formula evaluator.
- [x] Export a workbook, edit designated review fields, import and assert the proposed change without applying it automatically.

## 4. Browser demo

Files: `src/app/{layout,page}.tsx`, `src/app/globals.css`, `src/components/workspace.tsx`, `src/lib/storage.ts`, `tests/demo.spec.ts`.

- [x] Write a browser test covering import, season creation, wrong-year rejection, the dividend gap, evidence completion, review and persistence.
- [x] Build plain entity navigation, requests table, source details, CSV upload, draft outbox and review import preview.
- [x] Run the test against the local server and check mobile layout (390 px, no horizontal overflow); fix user-visible failures. Keyboard-only navigation has not been separately audited.

## 5. Delivery

Status 12 September 2026: 43 unit tests, 2 browser tests, typecheck, production build and `npm audit` (0 vulnerabilities) all pass locally. Nothing has been committed, pushed or deployed yet.

- [x] `npm test`, `npm run typecheck`, `npm run build`.
- [x] Document the exact demo steps, Google Drive folder plan and outstanding cloud configuration (`README.md`).
- [ ] Verify Vercel account and deploy a preview if authorised access is available; otherwise provide exact repository import settings. No false deployment claims.
- [ ] Report tests, workbook outputs, preview URL if successful, and remaining integration work.

import { expect, it } from 'vitest';
import { commitWorkspace, parseSavedWorkspace, STORAGE_KEY } from '../src/lib/storage';
import { createWorkspace, importBaseline, startSeason } from '../src/core/workflow';
import { baseline } from './fixtures';
import { buildIntakeContext, recordIntakeProposal, verifyIntake } from '../src/lib/intake';

it('restores valid state without silently accepting malformed records', () => {
  const state = startSeason(importBaseline(createWorkspace(), baseline), 'alex-taylor');
  expect(parseSavedWorkspace(JSON.stringify(state))).toEqual(state);
  expect(() => parseSavedWorkspace('{bad')).toThrow();
  expect(() => parseSavedWorkspace(JSON.stringify({ ...state, requests: [{}] }))).toThrow();
});

it('starts empty only when no saved workspace exists', () => {
  expect(parseSavedWorkspace(null)).toEqual(createWorkspace());
});

function memoryStore(initial: string | null) {
  const map = new Map<string, string>();
  if (initial !== null) map.set(STORAGE_KEY, initial);
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); }, map };
}

it('commits a workspace computed from the version currently saved', () => {
  const base = importBaseline(createWorkspace(), baseline);
  const store = memoryStore(JSON.stringify(base));
  const next = startSeason(base, 'alex-taylor');
  commitWorkspace(store, base, next);
  expect(parseSavedWorkspace(store.getItem(STORAGE_KEY))).toEqual(next);
});

it('rejects a commit when another tab advanced the saved version after the operation started', () => {
  const base = importBaseline(createWorkspace(), baseline);
  const store = memoryStore(JSON.stringify(base));
  const next = startSeason(base, 'alex-taylor'); // computed from base during an async file step
  const otherTab = startSeason(base, 'alex-taylor');
  const newer = { ...otherTab, version: otherTab.version + 1 };
  store.setItem(STORAGE_KEY, JSON.stringify(newer)); // other tab saved first
  expect(() => commitWorkspace(store, base, next)).toThrow(/Another tab changed/);
  expect(parseSavedWorkspace(store.getItem(STORAGE_KEY))).toEqual(newer);
});

it('rejects a commit when the demo was reset elsewhere', () => {
  const base = importBaseline(createWorkspace(), baseline);
  const store = memoryStore(null);
  expect(() => commitWorkspace(store, base, startSeason(base, 'alex-taylor'))).toThrow(/Another tab changed/);
  expect(store.getItem(STORAGE_KEY)).toBeNull();
});

it('round-trips a workspace with intake proposals and leaves one without them unchanged', () => {
  const base = startSeason(importBaseline(createWorkspace(), baseline), 'alex-taylor');
  const plain = parseSavedWorkspace(JSON.stringify(base));
  expect('intake' in plain).toBe(false);
  const ctx = buildIntakeContext(base);
  const withIntake = recordIntakeProposal(base, {
    id: 'intake-1', messageId: '<m@example.com>', attachmentIndex: 0, filename: 'a.jpg', contentType: 'image/jpeg', size: 1, fileHash: 'c'.repeat(64),
    model: 'm', promptVersion: 'intake-1', createdAt: '2026-09-14T00:00:00.000Z', source: 'image',
    documents: verifyIntake([{ docType: 'x', entityNameSeen: 'Alex Taylor', periodStart: '', periodEnd: '', amounts: [], proposedEntityId: 'alex-taylor',
      proposedRequestId: 'alex-taylor:2026:ALE-DIV-CASH', confidence: 'low', reason: '', syntheticMarker: false }], ctx),
    review: { status: 'pending', decidedAt: '', note: '' },
  });
  expect(parseSavedWorkspace(JSON.stringify(withIntake))).toEqual(withIntake);
  expect(() => parseSavedWorkspace(JSON.stringify({ ...withIntake, intake: [{ id: 'bad' }] }))).toThrow();
});

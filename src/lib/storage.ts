import { z } from 'zod';
import { createWorkspace } from '../core/workflow';
import type { Workspace } from '../core/types';

export const STORAGE_KEY = 'peregrine-synthetic-workspace-v1';
const text = z.string().max(8000), money = z.number().int().min(-1e12).max(1e12).nullable();
const line = z.object({ id: text, category: text, label: text, component: text, amountCents: money,
  currency: text, basis: text, sourceRef: text, recurrence: z.literal('annual'), requestText: text });
const baseline = z.object({ workbookId: text, entityId: text, entityName: text, entityType: z.enum(['individual', 'company', 'trust']),
  financialYear: z.literal(2025), baselineVersion: z.number().int().positive(), synthetic: z.literal(true), lines: z.array(line).max(200) });
const evidence = z.object({ documentId: text, lineId: text, entityId: text, financialYear: z.number().int(),
  component: text, currency: text, basis: text, amountCents: money, description: text, filename: text, fileHash: text });
const request = z.object({ id: text, entityId: text, financialYear: z.literal(2026), lineId: text, category: text, label: text,
  question: text, reason: text, component: text, currency: text, basis: text, priorAmountCents: money, comparisonCents: money,
  evidence: z.array(evidence).max(200), answer: text, review: z.enum(['pending', 'accepted', 'not_applicable', 'follow_up']),
  reviewNote: text, paused: z.boolean(), origin: z.enum(['baseline', 'discovery', 'planning']), methodVersion: text });
const schema = z.object({ schemaVersion: z.literal(1), version: z.number().int().nonnegative(),
  baselines: z.array(baseline).max(20), requests: z.array(request).max(1000),
  outbox: z.array(z.object({ id: text, entityId: text, kind: z.enum(['initial', 'reminder']), status: z.enum(['draft', 'superseded']),
    requestIds: z.array(text), subject: text, body: z.string().max(100_000), fingerprint: z.string().max(100_000) })).max(1000),
  audit: z.array(z.object({ id: text, at: text, action: text, entityId: text, detail: text })).max(10_000) });

export function parseSavedWorkspace(raw: string | null): Workspace {
  if (raw === null) return createWorkspace();
  return schema.parse(JSON.parse(raw));
}

type KeyValueStore = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * Save `next`, which was computed from `base`, only if `base` is still the
 * saved version. An operation that awaited a file step may be racing a save
 * from another tab; comparing against the operation's own starting version
 * (not the latest in-memory copy) is what makes that race detectable.
 */
export function commitWorkspace(store: KeyValueStore, base: Workspace, next: Workspace) {
  const latest = parseSavedWorkspace(store.getItem(STORAGE_KEY));
  if (latest.version !== base.version) throw new Error('Another tab changed this workspace. Reload before continuing.');
  store.setItem(STORAGE_KEY, JSON.stringify(next));
}

function openFiles(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('peregrine-synthetic-files', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('files');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Browser file storage is unavailable.'));
  });
}

export async function keepOriginal(hash: string, bytes: ArrayBuffer) {
  const db = await openFiles();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('files', 'readwrite');
      tx.objectStore('files').put(bytes, hash);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(new Error('Could not retain the original file. Browser storage may be full.'));
      tx.onabort = () => reject(new Error('Original-file storage was interrupted.'));
    });
  } finally { db.close(); }
}

export async function readOriginal(hash: string): Promise<ArrayBuffer> {
  const db = await openFiles();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction('files').objectStore('files').get(hash);
      request.onsuccess = () => request.result ? resolve(request.result) : reject(new Error('Original file is not in this browser. Upload it again.'));
      request.onerror = () => reject(new Error('Could not read the original file.'));
    });
  } finally { db.close(); }
}

export async function sha256(bytes: ArrayBuffer) {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}

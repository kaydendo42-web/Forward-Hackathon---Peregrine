import type { CollectionRequest, Workspace } from './types';
import { collectionStatus } from './workflow';

// Read-only rollups for the family tree in the sidebar: which entity is still missing
// details, and what each request line is waiting on. Pure functions over the workspace.

export type LineStatusKey = 'awaiting' | 'review' | 'difference' | 'followUp' | 'done' | 'paused';
export type EntitySummary = {
  hasBaseline: boolean; total: number; awaiting: number; review: number; difference: number;
  followUp: number; done: number; paused: number; documents: number;
};

const STATUS_KEY: Record<string, LineStatusKey> = {
  'Accepted for demo': 'done', 'Not applicable': 'done', 'Paused': 'paused', 'Follow-up required': 'followUp',
  'Amount difference': 'difference', 'Needs adviser review': 'review', 'Awaiting client': 'awaiting',
};

/** The same wording the request list uses, plus a stable key for styling and counting. */
export function lineStatus(request: CollectionRequest): { key: LineStatusKey; label: string } {
  const label = collectionStatus(request);
  return { key: STATUS_KEY[label] ?? 'awaiting', label };
}

export function entitySummary(state: Workspace, entityId: string): EntitySummary {
  const summary: EntitySummary = { hasBaseline: state.baselines.some(b => b.entityId === entityId), total: 0, awaiting: 0, review: 0, difference: 0, followUp: 0, done: 0, paused: 0, documents: 0 };
  for (const request of state.requests) {
    if (request.entityId !== entityId) continue;
    summary.total += 1;
    summary[lineStatus(request).key] += 1;
    summary.documents += request.evidence.length;
  }
  return summary;
}

export function groupSummary(state: Workspace, entityIds: string[]) {
  const totals = { entities: entityIds.length, withBaseline: 0, total: 0, awaiting: 0, review: 0, difference: 0, followUp: 0, done: 0, paused: 0, documents: 0 };
  for (const id of entityIds) {
    const s = entitySummary(state, id);
    if (s.hasBaseline) totals.withBaseline += 1;
    for (const key of ['total', 'awaiting', 'review', 'difference', 'followUp', 'done', 'paused', 'documents'] as const) totals[key] += s[key];
  }
  return totals;
}

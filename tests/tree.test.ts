import { describe, expect, it } from 'vitest';
import { entitySummary, groupSummary, lineStatus } from '../src/core/tree';
import * as workflow from '../src/core/workflow';
import { baseline, evidence } from './fixtures';

const ALE_DIV = 'alex-taylor:2026:ALE-DIV-CASH';
const CHANGES = 'alex-taylor:2026:CHANGES';
const season = () => workflow.startSeason(workflow.importBaseline(workflow.createWorkspace(), baseline), 'alex-taylor');

describe('entitySummary', () => {
  it('reports no baseline and no requests for an unknown entity', () => {
    expect(entitySummary(workflow.createWorkspace(), 'alex-taylor')).toEqual({ hasBaseline: false, total: 0, awaiting: 0, review: 0, difference: 0, followUp: 0, done: 0, paused: 0, documents: 0 });
  });
  it('counts every request as awaiting right after the season starts', () => {
    expect(entitySummary(season(), 'alex-taylor')).toMatchObject({ hasBaseline: true, total: 2, awaiting: 2, review: 0, done: 0, documents: 0 });
  });
  it('moves counts as evidence, answers, differences and decisions arrive', () => {
    let s = workflow.setComparison(season(), ALE_DIV, 520000);
    s = workflow.receiveEvidence(s, ALE_DIV, evidence);                    // 4,200 vs 5,200 → difference
    expect(entitySummary(s, 'alex-taylor')).toMatchObject({ awaiting: 1, difference: 1, documents: 1 });
    s = workflow.recordAnswer(s, CHANGES, 'No changes.');
    expect(entitySummary(s, 'alex-taylor')).toMatchObject({ awaiting: 0, review: 1, difference: 1 });
    s = workflow.reviewRequest(s, ALE_DIV, 'follow_up', 'Send the missing $1,000 statement.');
    s = workflow.reviewRequest(s, CHANGES, 'accepted', 'Noted.');
    expect(entitySummary(s, 'alex-taylor')).toMatchObject({ followUp: 1, done: 1, awaiting: 0 });
    s = workflow.pauseRequest(s, ALE_DIV, true);
    expect(entitySummary(s, 'alex-taylor')).toMatchObject({ paused: 1, followUp: 0 });
  });
});

describe('lineStatus and groupSummary', () => {
  it('labels a request line for the tree', () => {
    const s = season();
    expect(lineStatus(s.requests[0])).toEqual({ key: 'awaiting', label: 'Awaiting client' });
    const paused = workflow.pauseRequest(s, ALE_DIV, true);
    expect(lineStatus(paused.requests.find(r => r.id === ALE_DIV)!)).toEqual({ key: 'paused', label: 'Paused' });
  });
  it('adds up member entities', () => {
    const totals = groupSummary(season(), ['alex-taylor', 'sam-taylor']);
    expect(totals).toMatchObject({ entities: 2, withBaseline: 1, total: 2, awaiting: 2 });
  });
});

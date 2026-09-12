import { describe, expect, it } from 'vitest';
import * as workflow from '../src/core/workflow';
import { applyProposalItem, buildContext, buildMessages, parseReply, PROMPT_VERSION, type Proposal } from '../src/lib/assist';
import { baseline, evidence } from './fixtures';

function active() {
  const state = workflow.startSeason(workflow.importBaseline(workflow.createWorkspace(), baseline), 'alex-taylor');
  return workflow.receiveEvidence(state, state.requests[0].id, evidence);
}
function proposal<T extends Proposal['task']>(task: T, items: Proposal['items'], sourceHash?: string): Proposal {
  return { task, model: 'test-model', promptVersion: PROMPT_VERSION, createdAt: '2026-09-12T00:00:00.000Z', sourceHash, items };
}

describe('reply parsing', () => {
  it('parses fenced JSON and keeps only schema-valid shapes', () => {
    const items = parseReply('follow_up', '```json\n{"items":[{"text":"Please send the July statement.","basis":["issuer A"]}]}\n```');
    expect(items).toEqual([{ text: 'Please send the July statement.', basis: ['issuer A'] }]);
  });
  it('rejects fractional cents, missing fields and non-JSON', () => {
    expect(() => parseReply('extract', '{"items":[{"documentId":"D1","amount":"12.345","description":"x","quote":"q"}]}')).toThrow();
    expect(() => parseReply('reword', '{"items":[{"basis":[]}]}')).toThrow();
    expect(() => parseReply('reword', 'Sure! Here is the answer.')).toThrow(/JSON/);
    expect(() => parseReply('triage', JSON.stringify({ items: Array.from({ length: 21 }, () => ({ label: 'x', note: 'y', basis: [] })) }))).toThrow();
  });
});

describe('context and prompts', () => {
  it('summarises the request in AUD and bounds pasted text', () => {
    const state = active();
    const ctx = buildContext(state.requests[0], baseline, ' Statement text ');
    expect(ctx.request.priorAmountAud).toBe('4800.00');
    expect(ctx.request.evidence[0]).toEqual({ documentId: 'FY26-DIV-A', amountAud: '4200.00', description: 'Synthetic issuer statement A' });
    expect(ctx.text).toBe('Statement text');
    expect(() => buildContext(state.requests[0], baseline, 'x'.repeat(20_001))).toThrow(/20/);
  });
  it('states propose-only, the FY window and the JSON contract', () => {
    const ctx = buildContext(active().requests[0], baseline);
    const [system, user] = buildMessages('follow_up', ctx);
    expect(system.role).toBe('system');
    expect(system.content).toMatch(/1 July 2025/);
    expect(system.content).toMatch(/Do not invent/i);
    expect(user.content).toMatch(/"items"/);
    expect(user.content).toMatch(/Cash dividends/);
  });
});

describe('accepting proposals', () => {
  it('links extracted rows with identity fixed from the request, not the model', () => {
    const state = active(); const req = state.requests[0];
    const next = applyProposalItem(state, req, proposal('extract', [
      { documentId: 'FY26-DIV-B', amount: '1000.00', description: 'Issuer B final dividend', quote: 'Final dividend $1,000.00' },
    ], 'abc123'), 0);
    const linked = next.requests[0].evidence.at(-1)!;
    expect(linked).toMatchObject({ documentId: 'FY26-DIV-B', amountCents: 100000, lineId: 'ALE-DIV-CASH', entityId: 'alex-taylor', financialYear: 2026, component: 'cash', filename: 'pasted-text', fileHash: 'abc123' });
    expect(linked.description).toMatch(/Final dividend \$1,000\.00/);
    expect(next.audit.at(-1)).toMatchObject({ action: 'ai_proposal_accepted' });
    expect(next.audit.at(-1)?.detail).toMatch(/test-model/);
  });
  it('routes follow-up, reword and triage through existing transitions', () => {
    const state = active(); const req = state.requests[0];
    const followed = applyProposalItem(state, req, proposal('follow_up', [{ text: 'Please confirm the DRP election.', basis: [] }]), 0);
    expect(followed.requests[0]).toMatchObject({ review: 'follow_up', reviewNote: 'Please confirm the DRP election.' });
    const reworded = applyProposalItem(state, req, proposal('reword', [{ question: 'FY2026: Provide all dividend statements.', basis: [] }]), 0);
    expect(reworded.requests[0].question).toBe('FY2026: Provide all dividend statements.');
    const changes = state.requests.find(r => r.lineId === 'CHANGES')!;
    const triaged = applyProposalItem(state, changes, proposal('triage', [{ label: 'Rental property records', note: 'Client reported a new rental; obtain lease and agent statements.', basis: ['bought a unit'] }]), 0);
    expect(triaged.requests.at(-1)).toMatchObject({ origin: 'planning', label: 'Rental property records' });
  });
  it('refuses an out-of-range item index', () => {
    const state = active();
    expect(() => applyProposalItem(state, state.requests[0], proposal('reword', []), 0)).toThrow(/item/i);
  });
});

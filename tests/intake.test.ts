import { describe, expect, it } from 'vitest';
import { buildIntakeContext, buildIntakeMessages, parseIntakeAmount, parseIntakeReply, verifyIntake, type RawIntakeDocument } from '../src/lib/intake';
import * as workflow from '../src/core/workflow';
import type { Baseline } from '../src/core/types';
import { baseline } from './fixtures';

const trust: Baseline = {
  workbookId: 'FY25-taylor-family-trust', entityId: 'taylor-family-trust', entityName: 'Taylor Family Trust', entityType: 'trust',
  financialYear: 2025, baselineVersion: 1, synthetic: true,
  lines: [{ id: 'TR-BANK', category: 'bank', label: 'Trust bank balance', component: 'closing_balance', amountCents: 10000000,
    currency: 'AUD', basis: 'closing_balance', sourceRef: 'FY25-BANK', requestText: 'Provide the 30 June trust bank statement.', recurrence: 'annual' }],
};
function family() {
  let s = workflow.importBaseline(workflow.createWorkspace(), baseline);
  s = workflow.importBaseline(s, trust);
  s = workflow.startSeason(s, 'alex-taylor');
  return workflow.startSeason(s, 'taylor-family-trust');
}
const TR_BANK = 'taylor-family-trust:2026:TR-BANK';
const ALE_DIV = 'alex-taylor:2026:ALE-DIV-CASH';

describe('parseIntakeAmount', () => {
  it('reads printed money forms into integer cents', () => {
    expect(parseIntakeAmount('$108,125.00')).toBe(10812500);
    expect(parseIntakeAmount('1,325.00')).toBe(132500);
    expect(parseIntakeAmount('(5,000.00)')).toBe(-500000);
    expect(parseIntakeAmount('-175.00')).toBe(-17500);
    expect(parseIntakeAmount('AUD 1,200')).toBe(120000);
    expect(parseIntakeAmount(108125)).toBe(10812500);
    expect(parseIntakeAmount(12.5)).toBe(1250);
  });
  it('returns null for unreadable or absurd values', () => {
    expect(parseIntakeAmount('')).toBeNull();
    expect(parseIntakeAmount('n/a')).toBeNull();
    expect(parseIntakeAmount('12.345')).toBeNull();
    expect(parseIntakeAmount(null)).toBeNull();
    expect(parseIntakeAmount('1'.repeat(13))).toBeNull();
    expect(parseIntakeAmount(Number.NaN)).toBeNull();
  });
});

describe('parseIntakeReply', () => {
  const reply = `Sure, here is the JSON output for the image:

{"documents":[{"docType":"Trust Account Statement","entityNameSeen":"Oakwood Family Trust","periodStart":"1 June 2026","periodEnd":"30 June 2026","keyAmounts":[{"label":"Closing Balance","amount":"$108,125.00"}],"proposedEntityId":"taylor-family-trust","proposedRequestId":"taylor-family-trust:2026:TR-BANK","confidence":"medium","reason":"Bank statement for a trust","syntheticMarker":true}]}.`;

  it('extracts the JSON block from prose and coerces amounts', () => {
    const docs = parseIntakeReply(reply);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ docType: 'Trust Account Statement', entityNameSeen: 'Oakwood Family Trust', proposedRequestId: 'taylor-family-trust:2026:TR-BANK', confidence: 'medium', syntheticMarker: true });
    expect(docs[0].amounts).toEqual([{ label: 'Closing Balance', amountCents: 10812500 }]);
  });
  it('accepts "amounts" as well as "keyAmounts" and defaults missing fields', () => {
    const docs = parseIntakeReply('{"documents":[{"docType":"Resolution","amounts":[{"label":"x","amount":null}]}]}');
    expect(docs[0]).toMatchObject({ entityNameSeen: '', periodStart: '', proposedEntityId: '', confidence: 'low', syntheticMarker: false });
    expect(docs[0].amounts).toEqual([{ label: 'x', amountCents: null }]);
  });
  it('rejects replies without a JSON object or without documents', () => {
    expect(() => parseIntakeReply('No documents here.')).toThrow(/no JSON/i);
    expect(() => parseIntakeReply('{"items":[]}')).toThrow();
    expect(() => parseIntakeReply('{"documents": "nope"}')).toThrow();
  });
  it('caps documents and amounts', () => {
    const many = JSON.stringify({ documents: Array.from({ length: 12 }, () => ({ docType: 'x', amounts: [] })) });
    expect(() => parseIntakeReply(many)).toThrow();
  });
});

describe('buildIntakeContext', () => {
  it('lists entities and only open, unpaused requests without evidence or answers', () => {
    let s = family();
    s = workflow.pauseRequest(s, ALE_DIV, true);
    const ctx = buildIntakeContext(s);
    expect(ctx.entities.map(e => e.entityId)).toEqual(['alex-taylor', 'taylor-family-trust']);
    expect(ctx.requests.map(r => r.id)).not.toContain(ALE_DIV);
    expect(ctx.requests.find(r => r.id === TR_BANK)).toMatchObject({ entityId: 'taylor-family-trust', lineId: 'TR-BANK', component: 'closing_balance', financialYear: 2026 });
    expect(JSON.stringify(ctx)).not.toMatch(/"(evidence|answer|reviewNote|comparisonCents)":/);
  });
});

describe('buildIntakeMessages', () => {
  it('sends the image as an image_url part and the context as JSON', () => {
    const msgs = buildIntakeMessages(buildIntakeContext(family()), { kind: 'image', jpegBase64: 'AAAA' });
    expect(msgs[0].role).toBe('system');
    expect(msgs[0].content).toMatch(/synthetic/i);
    const user = msgs[1].content as { type: string; text?: string; image_url?: { url: string } }[];
    expect(user.find(p => p.type === 'image_url')?.image_url?.url).toBe('data:image/jpeg;base64,AAAA');
    expect(user.find(p => p.type === 'text')?.text).toContain(TR_BANK);
  });
  it('sends extracted PDF text inline', () => {
    const msgs = buildIntakeMessages(buildIntakeContext(family()), { kind: 'text', text: 'Closing balance 108,125.00' });
    expect(typeof msgs[1].content).toBe('string');
    expect(msgs[1].content).toContain('Closing balance 108,125.00');
  });
});

describe('verifyIntake', () => {
  const ctx = buildIntakeContext(family());
  const raw = (over: Partial<RawIntakeDocument> = {}): RawIntakeDocument => ({
    docType: 'Bank statement', entityNameSeen: 'Taylor Family Trust', periodStart: '1 June 2026', periodEnd: '30 June 2026',
    amounts: [], proposedEntityId: 'taylor-family-trust', proposedRequestId: TR_BANK, confidence: 'high', reason: '', syntheticMarker: false, ...over,
  });
  it('flags an exact name, in-year period and valid target', () => {
    expect(verifyIntake([raw()], ctx)[0].flags).toEqual({ nameMatch: 'match', periodInYear: true, syntheticMarker: false, targetValid: true });
  });
  it('flags Oakwood as a mismatch and keeps the document', () => {
    const [doc] = verifyIntake([raw({ entityNameSeen: 'Oakwood Family Trust' })], ctx);
    expect(doc.flags.nameMatch).toBe('mismatch');
    expect(doc.entityNameSeen).toBe('Oakwood Family Trust');
  });
  it('flags a shared surname as partial', () => {
    expect(verifyIntake([raw({ entityNameSeen: 'Alex Taylor' })], ctx)[0].flags.nameMatch).toBe('partial');
  });
  it('matches against every entity when the proposed entity is empty, and the target is then invalid', () => {
    const [doc] = verifyIntake([raw({ proposedEntityId: '', proposedRequestId: '', entityNameSeen: 'alex taylor' })], ctx);
    expect(doc.flags).toMatchObject({ nameMatch: 'match', targetValid: false });
  });
  it('flags a request under another entity or a reviewed request as invalid', () => {
    expect(verifyIntake([raw({ proposedRequestId: ALE_DIV })], ctx)[0].flags.targetValid).toBe(false);
    const reviewed = workflow.reviewRequest(family(), TR_BANK, 'not_applicable', 'closed');
    expect(verifyIntake([raw()], buildIntakeContext(reviewed))[0].flags.targetValid).toBe(false);
  });
  it('flags periods outside FY2026 and treats unreadable dates as in-year', () => {
    expect(verifyIntake([raw({ periodStart: '1 July 2024', periodEnd: '30 June 2025' })], ctx)[0].flags.periodInYear).toBe(false);
    expect(verifyIntake([raw({ periodStart: '30/06/2026', periodEnd: '30/06/2026' })], ctx)[0].flags.periodInYear).toBe(true);
    expect(verifyIntake([raw({ periodStart: 'June', periodEnd: '' })], ctx)[0].flags.periodInYear).toBe(true);
  });
  it('sets the synthetic flag from the model or from the text it read', () => {
    expect(verifyIntake([raw({ syntheticMarker: true })], ctx)[0].flags.syntheticMarker).toBe(true);
    expect(verifyIntake([raw({ docType: 'SYNTHETIC DEMO statement' })], ctx)[0].flags.syntheticMarker).toBe(true);
  });
});

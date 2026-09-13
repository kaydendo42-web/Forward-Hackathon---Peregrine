import { describe, expect, it } from 'vitest';
import { applyIntakeDocument, buildIntakeContext, buildIntakeMessages, intakeDocumentId, linkedRequestFor, parseIntakeAmount, parseIntakeReply, recordIntakeProposal, rejectIntakeProposal, verifyIntake, type RawIntakeDocument } from '../src/lib/intake';
import * as workflow from '../src/core/workflow';
import type { Baseline, IntakeProposal } from '../src/core/types';
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

const HASH = 'a'.repeat(64);
function proposal(over: Partial<IntakeProposal> = {}): IntakeProposal {
  const ctx = buildIntakeContext(family());
  return {
    id: 'intake-1', messageId: '<reply-1@example.com>', attachmentIndex: 0, filename: 'statement.jpg', contentType: 'image/jpeg', size: 1234,
    fileHash: HASH, model: 'meta/llama-3.2-11b-vision-instruct', promptVersion: 'intake-1', createdAt: '2026-09-14T00:00:00.000Z', source: 'image',
    documents: verifyIntake([{ docType: 'Bank statement', entityNameSeen: 'Taylor Family Trust', periodStart: '1 June 2026', periodEnd: '30 June 2026',
      amounts: [{ label: 'Closing Balance', amountCents: 10812500 }], proposedEntityId: 'taylor-family-trust', proposedRequestId: TR_BANK,
      confidence: 'high', reason: 'Trust bank statement', syntheticMarker: true }], ctx),
    review: { status: 'pending', decidedAt: '', note: '' }, ...over,
  };
}

describe('recordIntakeProposal', () => {
  it('stores a validated proposal and logs a read event without applying anything', () => {
    const base = family();
    const next = recordIntakeProposal(base, proposal());
    expect(next.intake).toHaveLength(1);
    expect(next.version).toBe(base.version + 1);
    expect(next.audit.at(-1)).toMatchObject({ action: 'intake_read', entityId: 'taylor-family-trust' });
    expect(next.requests.find(r => r.id === TR_BANK)!.evidence).toEqual([]);
  });
  it('replaces an earlier pending proposal for the same attachment', () => {
    let s = recordIntakeProposal(family(), proposal({ id: 'intake-1' }));
    s = recordIntakeProposal(s, proposal({ id: 'intake-2' }));
    expect(s.intake!.map(p => p.id)).toEqual(['intake-2']);
  });
  it('rejects an invalid proposal', () => {
    expect(() => recordIntakeProposal(family(), proposal({ fileHash: 'nope' }))).toThrow();
  });
});

describe('applyIntakeDocument', () => {
  it("links evidence on the chosen request using that request's own fields and logs the acceptance", () => {
    const s = recordIntakeProposal(family(), proposal());
    const next = applyIntakeDocument(s, 'intake-1', 0, { requestId: TR_BANK, amountCents: 10812500, description: 'Bank statement — Taylor Family Trust — June 2026' });
    const req = next.requests.find(r => r.id === TR_BANK)!;
    expect(req.evidence).toHaveLength(1);
    expect(req.evidence[0]).toMatchObject({ documentId: intakeDocumentId(HASH, 0), lineId: 'TR-BANK', entityId: 'taylor-family-trust', financialYear: 2026,
      component: 'closing_balance', basis: 'closing_balance', currency: 'AUD', amountCents: 10812500, filename: 'statement.jpg', fileHash: HASH });
    expect(next.intake![0].review.status).toBe('accepted');
    expect(next.audit.at(-1)).toMatchObject({ action: 'intake_accepted' });
    expect(next.audit.at(-1)!.detail).toMatch(/meta\/llama-3.2-11b-vision-instruct/);
    expect(next.audit.at(-1)!.detail).toMatch(/intake-1/);
    expect(linkedRequestFor(next, next.intake![0], 0)?.id).toBe(TR_BANK);
  });
  it("records an adviser override when the target differs from the model's proposal", () => {
    const s = recordIntakeProposal(family(), proposal());
    const next = applyIntakeDocument(s, 'intake-1', 0, { requestId: ALE_DIV, amountCents: null, description: 'Moved by adviser' });
    expect(next.audit.at(-1)!.detail).toMatch(/override/i);
    expect(next.requests.find(r => r.id === ALE_DIV)!.evidence[0].amountCents).toBeNull();
  });
  it('surfaces workflow errors unchanged (closing balance conflict)', () => {
    let s = recordIntakeProposal(family(), proposal());
    s = applyIntakeDocument(s, 'intake-1', 0, { requestId: TR_BANK, amountCents: 10812500, description: 'first' });
    const second = recordIntakeProposal(s, proposal({ id: 'intake-2', attachmentIndex: 1, fileHash: 'b'.repeat(64) }));
    expect(() => applyIntakeDocument(second, 'intake-2', 0, { requestId: TR_BANK, amountCents: 100, description: 'second' })).toThrow(/closing balance/i);
  });
  it('refuses a rejected proposal, an unknown document or an empty description', () => {
    const s = rejectIntakeProposal(recordIntakeProposal(family(), proposal()), 'intake-1', 'wrong family');
    expect(() => applyIntakeDocument(s, 'intake-1', 0, { requestId: TR_BANK, amountCents: null, description: 'x' })).toThrow(/rejected/i);
    const open = recordIntakeProposal(family(), proposal());
    expect(() => applyIntakeDocument(open, 'intake-1', 3, { requestId: TR_BANK, amountCents: null, description: 'x' })).toThrow(/document/i);
    expect(() => applyIntakeDocument(open, 'intake-1', 0, { requestId: TR_BANK, amountCents: null, description: '  ' })).toThrow();
  });
});

describe('rejectIntakeProposal', () => {
  it('marks the proposal rejected with the note and logs it', () => {
    const next = rejectIntakeProposal(recordIntakeProposal(family(), proposal()), 'intake-1', 'Belongs to another client');
    expect(next.intake![0].review).toMatchObject({ status: 'rejected', note: 'Belongs to another client' });
    expect(next.intake![0].review.decidedAt).not.toBe('');
    expect(next.audit.at(-1)).toMatchObject({ action: 'intake_rejected' });
  });
});

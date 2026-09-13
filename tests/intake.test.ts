import { describe, expect, it } from 'vitest';
import { parseIntakeAmount, parseIntakeReply } from '../src/lib/intake';

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

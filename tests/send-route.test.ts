import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendMail = vi.fn();
vi.mock('nodemailer', () => ({ default: { createTransport: vi.fn(() => ({ sendMail })) } }));

import { POST } from '../src/app/api/send/route';
import nodemailer from 'nodemailer';

const draft = { draftId: 'draft-3', entityId: 'alex-taylor', to: 'taylorfamilyexample@gmail.com',
  subject: 'FY2026 information request — Alex Taylor', body: 'Hello Alex Taylor,\n\n1. FY2026: Provide statements.\n\nSYNTHETIC DEMO' };
const good = { 'x-assist-passcode': 'open-sesame', 'sec-fetch-site': 'same-origin' };

function call(headers: Record<string, string>, payload: unknown = draft) {
  return POST(new Request('http://localhost/api/send', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof payload === 'string' ? payload : JSON.stringify(payload) }));
}

describe('POST /api/send', () => {
  beforeEach(() => {
    vi.stubEnv('SMTP_USER', 'taylorfamilyexample@gmail.com');
    vi.stubEnv('SMTP_PASS', 'abcd efgh ijkl mnop');
    vi.stubEnv('OUTREACH_ALLOWED_RECIPIENTS', 'taylorfamilyexample@gmail.com, Other@Example.com');
    vi.stubEnv('AI_ASSIST_PASSCODE', 'open-sesame');
    sendMail.mockReset(); sendMail.mockResolvedValue({ messageId: '<msg-1@gmail.com>' });
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('503 when SMTP or the allowlist is not configured', async () => {
    vi.stubEnv('SMTP_PASS', '');
    expect((await call(good)).status).toBe(503);
    vi.stubEnv('SMTP_PASS', 'x'); vi.stubEnv('OUTREACH_ALLOWED_RECIPIENTS', '');
    expect((await call(good)).status).toBe(503);
  });
  it('401 and 403 gates match the assist route', async () => {
    expect((await call({ 'sec-fetch-site': 'same-origin' })).status).toBe(401);
    expect((await call({ ...good, 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect(sendMail).not.toHaveBeenCalled();
  });
  it('400 on a malformed body', async () => {
    expect((await call(good, '{')).status).toBe(400);
    expect((await call(good, { ...draft, to: 'not-an-email' })).status).toBe(400);
  });
  it('403 for a recipient outside the verified list, case-insensitively matched', async () => {
    const res = await call(good, { ...draft, to: 'stranger@example.com' });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/verified/i);
    expect(sendMail).not.toHaveBeenCalled();
    expect((await call(good, { ...draft, to: 'other@example.com' })).status).toBe(200);
  });
  it('200 sends through Gmail SMTP with the draft content and returns a receipt', async () => {
    const res = await call(good);
    expect(res.status).toBe(200);
    const { receipt } = await res.json();
    expect(receipt).toMatchObject({ to: 'taylorfamilyexample@gmail.com', messageId: '<msg-1@gmail.com>' });
    expect(Date.parse(receipt.sentAt)).not.toBeNaN();
    expect(nodemailer.createTransport).toHaveBeenCalledWith(expect.objectContaining({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: 'taylorfamilyexample@gmail.com', pass: 'abcd efgh ijkl mnop' } }));
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ from: expect.stringContaining('taylorfamilyexample@gmail.com'), to: 'taylorfamilyexample@gmail.com', subject: draft.subject, text: draft.body }));
    expect(sendMail.mock.calls[0][0].html).toBeUndefined();
  });
  it('502 when SMTP rejects the message', async () => {
    sendMail.mockRejectedValue(new Error('535 Authentication failed'));
    const res = await call(good);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/could not be sent/i);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { readGmailInbox } = vi.hoisted(() => ({ readGmailInbox: vi.fn() }));
vi.mock('../src/lib/inbox-reader', async importOriginal => ({
  ...await importOriginal<typeof import('../src/lib/inbox-reader')>(),
  readGmailInbox,
}));

import { POST } from '../src/app/api/inbox/route';

const goodHeaders = { 'x-assist-passcode': 'open-sesame', 'sec-fetch-site': 'same-origin' };

function call(headers: Record<string, string> = goodHeaders) {
  return POST(new Request('http://localhost/api/inbox', { method: 'POST', headers }));
}

describe('POST /api/inbox', () => {
  beforeEach(() => {
    vi.stubEnv('SMTP_USER', 'adviser@example.com');
    vi.stubEnv('SMTP_PASS', 'app-password');
    vi.stubEnv('OUTREACH_ALLOWED_RECIPIENTS', 'family@example.com, other@example.com');
    vi.stubEnv('AI_ASSIST_PASSCODE', 'open-sesame');
    readGmailInbox.mockReset();
    readGmailInbox.mockResolvedValue({ messages: [], checkedAt: '2026-09-12T04:00:00.000Z' });
  });

  afterEach(() => vi.unstubAllEnvs());

  it('returns 503 without calling IMAP when configuration is incomplete', async () => {
    vi.stubEnv('SMTP_PASS', '');
    expect((await call()).status).toBe(503);
    vi.stubEnv('SMTP_PASS', 'x');
    vi.stubEnv('OUTREACH_ALLOWED_RECIPIENTS', '');
    expect((await call()).status).toBe(503);
    expect(readGmailInbox).not.toHaveBeenCalled();
  });

  it('requires the passcode and an explicit same-origin browser request before calling IMAP', async () => {
    expect((await call({ 'sec-fetch-site': 'same-origin' })).status).toBe(401);
    expect((await call({ 'x-assist-passcode': 'open-sesame', 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await call({ 'x-assist-passcode': 'open-sesame' })).status).toBe(403);
    expect(readGmailInbox).not.toHaveBeenCalled();
  });

  it('returns the bounded reader result without caching it', async () => {
    readGmailInbox.mockResolvedValue({
      messages: [{
        messageId: '<reply@example.com>', inReplyTo: null, references: [], from: 'family@example.com',
        date: '2026-09-12T03:00:00.000Z', subject: 'Reply', text: 'Here are the records.',
        attachments: [], textTruncated: false,
      }],
      checkedAt: '2026-09-12T04:00:00.000Z',
    });

    const response = await call();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual(expect.objectContaining({ checkedAt: '2026-09-12T04:00:00.000Z' }));
    expect(readGmailInbox).toHaveBeenCalledWith({
      user: 'adviser@example.com', pass: 'app-password',
      allowedSenders: 'family@example.com, other@example.com',
    });
  });

  it('sanitizes provider failures and credentials', async () => {
    readGmailInbox.mockRejectedValue(new Error('AUTHENTICATIONFAILED app-password secret-provider-detail'));

    const response = await call();
    const body = JSON.stringify(await response.json());

    expect(response.status).toBe(502);
    expect(body).toMatch(/could not be checked/i);
    expect(body).not.toContain('app-password');
    expect(body).not.toContain('secret-provider-detail');
  });
});

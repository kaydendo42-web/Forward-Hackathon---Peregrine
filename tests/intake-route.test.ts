import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as workflow from '../src/core/workflow';
import { buildIntakeContext } from '../src/lib/intake';
import { baseline } from './fixtures';

const { downloadGmailAttachment } = vi.hoisted(() => ({ downloadGmailAttachment: vi.fn() }));
vi.mock('../src/lib/inbox-reader', async importOriginal => ({
  ...await importOriginal<typeof import('../src/lib/inbox-reader')>(),
  downloadGmailAttachment,
}));
import { InboxReadError } from '../src/lib/inbox-reader';
import { POST } from '../src/app/api/intake/route';

const STATEMENT = readFileSync('tests/fixtures/intake/statement.jpg');
const state = workflow.startSeason(workflow.importBaseline(workflow.createWorkspace(), baseline), 'alex-taylor');
const context = buildIntakeContext(state);
const good = { 'x-assist-passcode': 'open-sesame', 'sec-fetch-site': 'same-origin' };
const body = JSON.stringify({ messageId: '<reply-1@example.com>', attachmentIndex: 0, context });
const REPLY = '{"documents":[{"docType":"Dividend statement","entityNameSeen":"Alex Taylor","periodStart":"1 July 2025","periodEnd":"30 June 2026","amounts":[{"label":"Cash dividend","amount":"$4,200.00"}],"proposedEntityId":"alex-taylor","proposedRequestId":"alex-taylor:2026:ALE-DIV-CASH","confidence":"high","reason":"Dividend statement addressed to Alex","syntheticMarker":true}]}';

function call(headers: Record<string, string>, payload = body) {
  return POST(new Request('http://localhost/api/intake', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: payload }));
}
function nim(content: string, status = 200) {
  return new Response(status === 200 ? JSON.stringify({ choices: [{ message: { content } }] }) : 'error', { status, headers: { 'content-type': 'application/json' } });
}
/** Same minimal PDF builder as tests/intake-server.test.ts (duplicated so each file reads on its own). */
function tinyPdf(text: string) {
  const escaped = text.replace(/[\\()]/g, m => `\\${m}`);
  const lines = escaped.match(/.{1,60}/g) ?? [''];
  const stream = `BT /F1 12 Tf 14 TL 40 780 Td ${lines.map(l => `(${l}) Tj T*`).join(' ')} ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n'; const offsets: number[] = [];
  objects.forEach((obj, i) => { offsets.push(body.length); body += `${i + 1} 0 obj\n${obj}\nendobj\n`; });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

describe('POST /api/intake', () => {
  beforeEach(() => {
    for (const [k, v] of Object.entries({ NVIDIA_NIM_API_KEY: 'nvapi-test', NVIDIA_NIM_MODEL: 'nvidia/nemotron-3.5-lightning-30b-a3b', NVIDIA_NIM_VISION_MODEL: 'meta/llama-3.2-11b-vision-instruct',
      AI_ASSIST_PASSCODE: 'open-sesame', SMTP_USER: 'adviser@example.com', SMTP_PASS: 'app-password', OUTREACH_ALLOWED_RECIPIENTS: 'family@example.com' })) vi.stubEnv(k, v);
    downloadGmailAttachment.mockReset();
    downloadGmailAttachment.mockResolvedValue({ filename: 'statement.jpg', contentType: 'image/jpeg', bytes: STATEMENT });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it('503 when any required setting is missing, before anything else', async () => {
    for (const name of ['NVIDIA_NIM_VISION_MODEL', 'SMTP_PASS', 'AI_ASSIST_PASSCODE']) {
      vi.stubEnv(name, '');
      expect((await call({})).status).toBe(503);
      vi.stubEnv(name, 'x');
    }
    expect(downloadGmailAttachment).not.toHaveBeenCalled();
  });
  it('401 / 403 / 400 gates', async () => {
    expect((await call({ 'sec-fetch-site': 'same-origin' })).status).toBe(401);
    expect((await call({ ...good, 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await call(good, '{"messageId":1}')).status).toBe(400);
    expect((await call(good, 'nope')).status).toBe(400);
    expect(downloadGmailAttachment).not.toHaveBeenCalled();
  });
  it('maps download errors to 404 / 413 / 415 / 504 / 502', async () => {
    for (const [code, status] of [['not_found', 404], ['too_large', 413], ['unsupported_type', 415], ['timeout', 504], ['provider', 502]] as const) {
      downloadGmailAttachment.mockRejectedValueOnce(new InboxReadError(code));
      expect((await call(good)).status).toBe(status);
    }
  });
  it('415 when the bytes do not match a supported type even if the mail declared one', async () => {
    downloadGmailAttachment.mockResolvedValue({ filename: 'x.jpg', contentType: 'image/jpeg', bytes: Buffer.from('GIF89a....') });
    const res = await call(good);
    expect(res.status).toBe(415);
  });
  it('422 for a PDF without a text layer', async () => {
    downloadGmailAttachment.mockResolvedValue({ filename: 'scan.pdf', contentType: 'application/pdf', bytes: Buffer.from('%PDF-1.4\n%%EOF\n') });
    const res = await call(good);
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/PDF/);
  });
  it('200: shrinks the image, calls the vision model, verifies the proposal, returns bytes and hash', async () => {
    const fetchMock = vi.fn().mockResolvedValue(nim(`Sure!\n${REPLY}`));
    vi.stubGlobal('fetch', fetchMock);
    const res = await call(good);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.file).toMatchObject({ filename: 'statement.jpg', contentType: 'image/jpeg', size: STATEMENT.length });
    expect(Buffer.from(data.file.bytesBase64, 'base64').equals(STATEMENT)).toBe(true);
    expect(data.file.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(data.proposal).toMatchObject({ messageId: '<reply-1@example.com>', attachmentIndex: 0, model: 'meta/llama-3.2-11b-vision-instruct', promptVersion: 'intake-1', source: 'image', fileHash: data.file.sha256 });
    expect(data.proposal.documents[0]).toMatchObject({ proposedRequestId: 'alex-taylor:2026:ALE-DIV-CASH', amounts: [{ label: 'Cash dividend', amountCents: 420000 }],
      flags: { nameMatch: 'match', periodInYear: true, syntheticMarker: true, targetValid: true } });
    expect(data.proposal.id).toBeUndefined();
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.model).toBe('meta/llama-3.2-11b-vision-instruct');
    const image = sent.messages[1].content.find((p: { type: string }) => p.type === 'image_url').image_url.url as string;
    expect(image.startsWith('data:image/jpeg;base64,/9j/')).toBe(true);
    expect(image.length).toBeLessThan(170 * 1024 + 30);
  });
  it('retries once on unusable JSON, then 502', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(nim('no json here')).mockResolvedValueOnce(nim(REPLY));
    vi.stubGlobal('fetch', fetchMock);
    expect((await call(good)).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).messages).toHaveLength(3);
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => nim('still nothing')));
    const res = await call(good);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/unusable/i);
  });
  it('503 with retry-later on HTTP 429, without a second attempt', async () => {
    const fetchMock = vi.fn().mockResolvedValue(nim('', 429));
    vi.stubGlobal('fetch', fetchMock);
    const res = await call(good);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/busy|later/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('504 when the shared deadline aborts the model call', async () => {
    vi.useFakeTimers();
    const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
    vi.stubGlobal('fetch', vi.fn((_url: string, init: { signal: AbortSignal }) => init.signal.aborted
      ? Promise.reject(abortError())
      : new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(abortError())))));
    const pending = call(good);
    await vi.advanceTimersByTimeAsync(54_000);
    expect((await pending).status).toBe(504);
  });
  it('uses the text model for a PDF with a text layer', async () => {
    const pdf = tinyPdf('Dividend statement for Alex Taylor cash dividend 4,200.00 paid during FY2026. '.repeat(4));
    downloadGmailAttachment.mockResolvedValue({ filename: 'statement.pdf', contentType: 'application/pdf', bytes: pdf });
    const fetchMock = vi.fn().mockResolvedValue(nim(REPLY));
    vi.stubGlobal('fetch', fetchMock);
    const res = await call(good);
    expect(res.status).toBe(200);
    expect((await res.json()).proposal).toMatchObject({ source: 'pdf_text', model: 'nvidia/nemotron-3.5-lightning-30b-a3b' });
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(sent.messages[1].content).toContain('4,200.00');
  });
});

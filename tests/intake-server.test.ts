import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { completeChat, IntakePrepareError, MAX_IMAGE_BASE64, prepareImage, preparePdf, sha256Hex, sniffType } from '../src/lib/intake-server';

const STATEMENT = readFileSync('tests/fixtures/intake/statement.jpg');

/** A minimal single-page PDF with the given text, wrapped into 60-character lines so nothing falls off the page. */
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

describe('sniffType and sha256Hex', () => {
  it('recognises JPEG, PNG and PDF magic numbers only', async () => {
    expect(sniffType(STATEMENT)).toBe('image/jpeg');
    expect(sniffType(await sharp({ create: { width: 4, height: 4, channels: 3, background: '#fff' } }).png().toBuffer())).toBe('image/png');
    expect(sniffType(tinyPdf('hello'))).toBe('application/pdf');
    expect(sniffType(Buffer.from('GIF89a'))).toBeNull();
    expect(sniffType(Buffer.alloc(0))).toBeNull();
  });
  it('hashes bytes to lowercase hex', () => {
    expect(sha256Hex(Buffer.from('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('prepareImage', () => {
  it('returns a JPEG base64 under the inline limit for a large noisy image', async () => {
    const noise = Buffer.from(Array.from({ length: 2000 * 2000 * 3 }, () => Math.floor(Math.random() * 256)));
    const big = await sharp(noise, { raw: { width: 2000, height: 2000, channels: 3 } }).png().toBuffer();
    expect(big.length).toBeGreaterThan(MAX_IMAGE_BASE64);
    const out = await prepareImage(big);
    expect(out.kind).toBe('image');
    expect(out.jpegBase64.length).toBeLessThanOrEqual(MAX_IMAGE_BASE64);
    expect(out.jpegBase64.startsWith('/9j/')).toBe(true);
  }, 30_000);
  it('keeps a small photo readable and rejects non-images', async () => {
    const out = await prepareImage(STATEMENT);
    expect(out.jpegBase64.length).toBeLessThanOrEqual(MAX_IMAGE_BASE64);
    await expect(prepareImage(Buffer.from('not an image'))).rejects.toBeInstanceOf(IntakePrepareError);
  });
});

describe('preparePdf', () => {
  it('extracts text from a PDF with a text layer', async () => {
    const out = await preparePdf(tinyPdf('Closing balance 108,125.00 for the Taylor Family Trust at 30 June 2026. '.repeat(4)));
    expect(out.kind).toBe('text');
    expect(out.text).toContain('108,125.00');
  });
  it('rejects a PDF without enough text', async () => {
    await expect(preparePdf(tinyPdf('short'))).rejects.toMatchObject({ reason: expect.stringMatching(/no text layer|scanned/i) });
  });
  it('rejects bytes that are not a PDF', async () => {
    await expect(preparePdf(Buffer.from('nope'))).rejects.toBeInstanceOf(IntakePrepareError);
  });
});

describe('completeChat', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('posts to NIM with the bearer key and returns the message content', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '{"documents":[]}' } }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const content = await completeChat('nvapi-x', 'meta/llama-3.2-11b-vision-instruct', [{ role: 'user', content: 'hi' }], new AbortController().signal);
    expect(content).toBe('{"documents":[]}');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://integrate.api.nvidia.com/v1/chat/completions');
    expect(init.headers.authorization).toBe('Bearer nvapi-x');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ model: 'meta/llama-3.2-11b-vision-instruct', temperature: 0.1, max_tokens: 1500, stream: false });
    expect(body.chat_template_kwargs).toBeUndefined();
  });
  it('disables thinking for Nemotron and surfaces HTTP status in the error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('busy', { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(completeChat('k', 'nvidia/nemotron-3.5-lightning-30b-a3b', [{ role: 'user', content: 'hi' }], new AbortController().signal)).rejects.toThrow(/429/);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).chat_template_kwargs).toEqual({ enable_thinking: false });
  });
});

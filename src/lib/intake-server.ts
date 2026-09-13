import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { ChatMessage } from './intake';

// Server-only helpers for attachment intake: identify bytes, shrink an image to what NIM
// accepts inline, pull text out of a PDF, and call the model. Nothing here logs content.

export const MAX_IMAGE_BASE64 = 170 * 1024;
export const MAX_PDF_TEXT = 20_000;
export const MIN_PDF_TEXT = 200;
export const NIM_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';

export class IntakePrepareError extends Error {
  constructor(readonly reason: string) { super(reason); this.name = 'IntakePrepareError'; }
}

export function sniffType(bytes: Buffer): 'image/jpeg' | 'image/png' | 'application/pdf' | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}

export function sha256Hex(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Auto-orient, fit inside 1200 px, then step JPEG quality down until the base64 fits the inline cap. */
export async function prepareImage(bytes: Buffer): Promise<{ kind: 'image'; jpegBase64: string }> {
  try { await sharp(bytes, { failOn: 'error', limitInputPixels: 50_000_000 }).metadata(); }
  catch { throw new IntakePrepareError('The attachment could not be decoded as an image.'); }
  for (const edge of [1200, 900]) {
    for (const quality of [70, 60, 50, 40, 30]) {
      const out = await sharp(bytes).rotate().resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true }).jpeg({ quality, mozjpeg: true }).toBuffer();
      const jpegBase64 = out.toString('base64');
      if (jpegBase64.length <= MAX_IMAGE_BASE64) return { kind: 'image', jpegBase64 };
    }
  }
  throw new IntakePrepareError('The image could not be reduced enough to send to the model.');
}

/** Text layer of the first 20 pages. A scanned PDF has none and is refused here rather than guessed at. */
export async function preparePdf(bytes: Buffer): Promise<{ kind: 'text'; text: string }> {
  let text = '';
  // pdf.js references DOMMatrix at module load and the serverless Node runtime has none; a
  // stub is enough because text extraction never draws. Loaded lazily so a photo-only
  // deployment never evaluates pdf.js at all.
  const globals = globalThis as { DOMMatrix?: unknown };
  globals.DOMMatrix ??= class DOMMatrix {};
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(bytes) });
  try { text = (await parser.getText({ first: 20 })).text ?? ''; }
  catch { throw new IntakePrepareError('The attachment could not be read as a PDF.'); }
  finally { await parser.destroy().catch(() => undefined); }
  if (text.replace(/\s/g, '').length < MIN_PDF_TEXT) throw new IntakePrepareError('This looks like a scanned PDF with no text layer. Ask for a photo or a text PDF, or assign it manually.');
  return { kind: 'text', text: text.slice(0, MAX_PDF_TEXT) };
}

/** Same shape as the assist route's call; kept separate so the live assist path is untouched. */
export async function completeChat(key: string, model: string, messages: ChatMessage[], signal: AbortSignal) {
  const options = model.startsWith('nvidia/nemotron') ? { temperature: 0.1, max_tokens: 1500, chat_template_kwargs: { enable_thinking: false } } : { temperature: 0.1, max_tokens: 1500 };
  const res = await fetch(NIM_URL, {
    method: 'POST', signal,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ model, messages, ...options, stream: false }),
  });
  if (!res.ok) throw new Error(`Model service returned ${res.status}.`);
  const data = await res.json() as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('Model service returned no message.');
  return content;
}

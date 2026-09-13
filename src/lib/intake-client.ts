import { z } from 'zod';
import type { IntakeProposal } from '../core/types';
import { intakeDocumentSchema, type IntakeContext } from './intake';
import { keepOriginal, sha256 } from './storage';

const responseSchema = z.object({
  file: z.object({ filename: z.string().max(300), contentType: z.string().max(100), size: z.number().int().nonnegative(), sha256: z.string().regex(/^[0-9a-f]{64}$/), bytesBase64: z.string().max(12_000_000) }),
  proposal: z.object({ messageId: z.string().max(1000), attachmentIndex: z.number().int().min(0).max(29), filename: z.string().max(300), contentType: z.string().max(100),
    size: z.number().int().nonnegative(), fileHash: z.string().regex(/^[0-9a-f]{64}$/), model: z.string().max(200), promptVersion: z.string().max(40), createdAt: z.string().max(40),
    source: z.enum(['image', 'pdf_text']), documents: z.array(intakeDocumentSchema).max(10) }),
});

function decode(base64: string) {
  const binary = atob(base64); const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/** Reads one attachment through the gated route, verifies the hash locally, keeps the original bytes, returns the proposal. */
export async function readAttachment(passcode: string, messageId: string, attachmentIndex: number, context: IntakeContext): Promise<Omit<IntakeProposal, 'id' | 'review'>> {
  if (!passcode) throw new Error('Enter the demo passcode first.');
  const res = await fetch('/api/intake', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-assist-passcode': passcode },
    body: JSON.stringify({ messageId, attachmentIndex, context }),
  });
  const data = await res.json().catch(() => ({})) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Attachment read failed (${res.status}).`);
  const { file, proposal } = responseSchema.parse(data);
  const bytes = decode(file.bytesBase64);
  if (await sha256(bytes) !== file.sha256 || proposal.fileHash !== file.sha256) throw new Error('The attachment bytes did not match their hash. Nothing was saved.');
  await keepOriginal(file.sha256, bytes);
  return proposal;
}

import { z } from 'zod';
import { gate, json } from '../../../lib/gate';
import { downloadGmailAttachment, InboxReadError } from '../../../lib/inbox-reader';
import { buildIntakeMessages, intakeContextSchema, parseIntakeReply, PROMPT_VERSION, verifyIntake, type RawIntakeDocument } from '../../../lib/intake';
import { completeChat, IntakePrepareError, prepareImage, preparePdf, sha256Hex, sniffType } from '../../../lib/intake-server';
import type { IntakeProposal } from '../../../core/types';

// One attachment per call: download from the firm mailbox, shrink or extract, ask the model,
// check the answer, hand everything back to the browser. Nothing is stored or logged here.

export const maxDuration = 60;
const TOTAL_TIMEOUT_MS = 54_000;

const bodySchema = z.object({ messageId: z.string().max(1000), attachmentIndex: z.number().int().min(0).max(29), context: intakeContextSchema });
const DOWNLOAD_STATUS: Record<InboxReadError['code'], number> = { configuration: 503, timeout: 504, provider: 502, not_found: 404, too_large: 413, unsupported_type: 415 };

export async function POST(req: Request) {
  const env = {
    key: process.env.NVIDIA_NIM_API_KEY, model: process.env.NVIDIA_NIM_MODEL, visionModel: process.env.NVIDIA_NIM_VISION_MODEL, passcode: process.env.AI_ASSIST_PASSCODE,
    user: process.env.SMTP_USER, pass: process.env.SMTP_PASS, allowedSenders: process.env.OUTREACH_ALLOWED_RECIPIENTS,
  };
  if (Object.values(env).some(v => !v)) return json(503, { error: 'Attachment intake is not configured on this deployment.' });
  const blocked = gate(req, env.passcode!); if (blocked) return blocked;

  let parsed: z.infer<typeof bodySchema>;
  try { parsed = bodySchema.parse(await req.json()); }
  catch { return json(400, { error: 'Invalid intake request.' }); }
  const { messageId, attachmentIndex, context } = parsed;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOTAL_TIMEOUT_MS);
  try {
    let file: Awaited<ReturnType<typeof downloadGmailAttachment>>;
    try { file = await downloadGmailAttachment({ user: env.user!, pass: env.pass!, allowedSenders: env.allowedSenders! }, messageId, attachmentIndex); }
    catch (e) {
      if (e instanceof InboxReadError) return json(DOWNLOAD_STATUS[e.code], { error: e.message });
      return json(502, { error: 'The attachment could not be downloaded.' });
    }
    const contentType = sniffType(file.bytes);
    if (!contentType || contentType !== file.contentType) return json(415, { error: 'The attachment bytes are not the JPEG, PNG or PDF the email declared.' });

    let prepared;
    try { prepared = contentType === 'application/pdf' ? await preparePdf(file.bytes) : await prepareImage(file.bytes); }
    catch (e) { return json(422, { error: e instanceof IntakePrepareError ? e.reason : 'The attachment could not be prepared.' }); }

    const chosenModel = prepared.kind === 'image' ? env.visionModel! : env.model!;
    const messages = buildIntakeMessages(context, prepared);
    let documents: RawIntakeDocument[] | undefined; let lastError = 'Model returned unusable output.';
    for (let attempt = 0; attempt < 2 && !documents; attempt++) {
      const conversation = attempt === 0 ? messages : [...messages, { role: 'user' as const, content: 'Return only the JSON object {"documents":[...]} with no other text.' }];
      let reply: string;
      try { reply = await completeChat(env.key!, chosenModel, conversation, controller.signal); }
      catch (e) {
        if (e instanceof Error && e.name === 'AbortError') return json(504, { error: 'The model did not answer within the time limit.' });
        if (e instanceof Error && e.message.includes('429')) return json(503, { error: 'The model service is busy. Try again later.' });
        return json(502, { error: e instanceof Error && e.message.startsWith('Model service') ? e.message : 'Model service request failed.' });
      }
      try { documents = parseIntakeReply(reply); }
      catch (e) { lastError = e instanceof Error ? e.message : lastError; }
    }
    if (!documents) return json(502, { error: `Model returned unusable output: ${lastError}` });

    const sha256 = sha256Hex(file.bytes);
    const proposal: Omit<IntakeProposal, 'id' | 'review'> = {
      messageId, attachmentIndex, filename: file.filename, contentType, size: file.bytes.length, fileHash: sha256,
      model: chosenModel, promptVersion: PROMPT_VERSION, createdAt: new Date().toISOString(), source: prepared.kind === 'image' ? 'image' : 'pdf_text',
      documents: verifyIntake(documents, context),
    };
    return json(200, { file: { filename: file.filename, contentType, size: file.bytes.length, sha256, bytesBase64: file.bytes.toString('base64') }, proposal });
  } finally {
    clearTimeout(timer);
  }
}

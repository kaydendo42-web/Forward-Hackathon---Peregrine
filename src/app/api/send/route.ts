import nodemailer from 'nodemailer';
import { z } from 'zod';
import { gate, json } from '../../../lib/gate';

// Sends one outbox draft through Gmail SMTP. Recipients must be on the server-side
// verified list; the browser only supplies the draft it wants sent.

export const maxDuration = 30;

const bodySchema = z.object({
  draftId: z.string().min(1).max(80), entityId: z.string().min(1).max(80),
  to: z.string().trim().email().max(320), subject: z.string().trim().min(1).max(200), body: z.string().min(1).max(20_000),
});

function allowedRecipients(raw: string) {
  return new Set(raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
}

export async function POST(req: Request) {
  const user = process.env.SMTP_USER, pass = process.env.SMTP_PASS, allow = process.env.OUTREACH_ALLOWED_RECIPIENTS, passcode = process.env.AI_ASSIST_PASSCODE;
  if (!user || !pass || !allow || !passcode) return json(503, { error: 'Email sending is not configured on this deployment.' });
  const blocked = gate(req, passcode); if (blocked) return blocked;

  let draft;
  try { draft = bodySchema.parse(await req.json()); }
  catch { return json(400, { error: 'Invalid send request.' }); }
  if (!allowedRecipients(allow).has(draft.to.toLowerCase())) return json(403, { error: 'Recipient is not on the verified recipient list for this demo.' });

  const transport = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user, pass }, connectionTimeout: 15_000, socketTimeout: 15_000 });
  try {
    const info = await transport.sendMail({ from: `"Peregrine adviser (synthetic demo)" <${user}>`, to: draft.to, subject: draft.subject, text: draft.body,
      headers: { 'X-Peregrine-Draft': draft.draftId, 'X-Peregrine-Entity': draft.entityId } });
    return json(200, { receipt: { to: draft.to, messageId: String(info.messageId), sentAt: new Date().toISOString() } });
  } catch (e) {
    const reason = e instanceof Error ? e.message.split('\n')[0].slice(0, 200) : 'unknown error';
    return json(502, { error: `The email could not be sent: ${reason}` });
  }
}

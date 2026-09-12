import { gate, json } from '../../../lib/gate';
import { InboxReadError, readGmailInbox } from '../../../lib/inbox-reader';

export const maxDuration = 30;

export async function POST(req: Request) {
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const allowedSenders = process.env.OUTREACH_ALLOWED_RECIPIENTS;
  const passcode = process.env.AI_ASSIST_PASSCODE;
  if (!user || !pass || !allowedSenders || !passcode) return json(503, { error: 'Inbox access is not configured on this deployment.' });

  const blocked = gate(req, passcode);
  if (blocked) return blocked;
  if (req.headers.get('sec-fetch-site') !== 'same-origin') return json(403, { error: 'This route accepts requests from this app only.' });

  try {
    return json(200, await readGmailInbox({ user, pass, allowedSenders }));
  } catch (error) {
    if (error instanceof InboxReadError && error.code === 'configuration') return json(503, { error: 'Inbox access is not configured on this deployment.' });
    return json(502, { error: 'The inbox could not be checked.' });
  }
}

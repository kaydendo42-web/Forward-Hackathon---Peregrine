import { timingSafeEqual } from 'node:crypto';
import { assistRequestSchema, buildMessages, parseReply, PROMPT_VERSION, type Proposal } from '../../../lib/assist';

// Thin, gated proxy to NVIDIA NIM. The API key never leaves this handler.
// Nothing returned here is applied to the workspace; the browser shows it as a proposal.

export const maxDuration = 30;

const NIM_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const TIMEOUT_MS = 20_000;

function json(status: number, payload: unknown) {
  return Response.json(payload, { status, headers: { 'cache-control': 'no-store' } });
}

function passcodeMatches(presented: string | null, expected: string) {
  if (!presented) return false;
  const a = Buffer.from(presented, 'utf8'), b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

async function complete(key: string, model: string, messages: { role: 'system' | 'user' | 'assistant'; content: string }[]) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(NIM_URL, {
      method: 'POST', signal: controller.signal,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ model, messages, temperature: 0.1, max_tokens: 1500, stream: false }),
    });
    if (!res.ok) throw new Error(`Model service returned ${res.status}.`);
    const data = await res.json() as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('Model service returned no message.');
    return content;
  } finally { clearTimeout(timer); }
}

export async function POST(req: Request) {
  const key = process.env.NVIDIA_NIM_API_KEY, model = process.env.NVIDIA_NIM_MODEL, passcode = process.env.AI_ASSIST_PASSCODE;
  if (!key || !model || !passcode) return json(503, { error: 'AI assist is not configured on this deployment.' });
  if (!passcodeMatches(req.headers.get('x-assist-passcode'), passcode)) return json(401, { error: 'AI assist passcode is missing or incorrect.' });
  const site = req.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin') return json(403, { error: 'AI assist accepts requests from this app only.' });

  let parsed;
  try { parsed = assistRequestSchema.parse(await req.json()); }
  catch { return json(400, { error: 'Invalid assist request.' }); }
  const { task, context } = parsed;

  const messages = buildMessages(task, context);
  let items: Proposal['items'] | undefined; let lastError = 'Model returned unusable output.';
  for (let attempt = 0; attempt < 2 && !items; attempt++) {
    const conversation = attempt === 0 ? messages : [...messages, { role: 'user' as const, content: 'Return only the JSON object {"items":[...]} with no other text.' }];
    try { items = parseReply(task, await complete(key, model, conversation)); }
    catch (e) {
      const aborted = e instanceof Error && e.name === 'AbortError';
      lastError = aborted ? 'Model service timed out.' : e instanceof Error ? e.message : lastError;
      // Upstream failures are not worth a retry; only unusable model output is.
      if (aborted || lastError.startsWith('Model service')) return json(502, { error: lastError });
    }
  }
  if (!items) return json(502, { error: `Model returned unusable output: ${lastError}` });
  const proposal: Proposal = { task, model, promptVersion: PROMPT_VERSION, createdAt: new Date().toISOString(), items };
  return json(200, { proposal });
}

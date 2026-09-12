import { assistRequestSchema, buildMessages, parseReply, PROMPT_VERSION, type Proposal } from '../../../lib/assist';
import { gate, json } from '../../../lib/gate';

// Thin, gated proxy to NVIDIA NIM. The API key never leaves this handler.
// Nothing returned here is applied to the workspace; the browser shows it as a proposal.

export const maxDuration = 60;

const NIM_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const TOTAL_TIMEOUT_MS = 54_000;

async function complete(key: string, model: string, messages: { role: 'system' | 'user' | 'assistant'; content: string }[], signal: AbortSignal) {
  const modelOptions = model === 'moonshotai/kimi-k3'
    ? { temperature: 1, max_tokens: 4096, reasoning_effort: 'low' as const }
    : model === 'nvidia/nemotron-3.5-lightning-30b-a3b'
      ? { temperature: 0.1, max_tokens: 1500, chat_template_kwargs: { enable_thinking: false } }
      : { temperature: 0.1, max_tokens: 1500 };
  const res = await fetch(NIM_URL, {
    method: 'POST', signal,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ model, messages, ...modelOptions, stream: false }),
  });
  if (!res.ok) throw new Error(`Model service returned ${res.status}.`);
  const data = await res.json() as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('Model service returned no message.');
  return content;
}

export async function POST(req: Request) {
  const key = process.env.NVIDIA_NIM_API_KEY, model = process.env.NVIDIA_NIM_MODEL, passcode = process.env.AI_ASSIST_PASSCODE;
  if (!key || !model || !passcode) return json(503, { error: 'AI assist is not configured on this deployment.' });
  const blocked = gate(req, passcode); if (blocked) return blocked;

  let parsed;
  try { parsed = assistRequestSchema.parse(await req.json()); }
  catch { return json(400, { error: 'Invalid assist request.' }); }
  const { task, context } = parsed;

  const messages = buildMessages(task, context);
  let items: Proposal['items'] | undefined; let lastError = 'Model returned unusable output.';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOTAL_TIMEOUT_MS);
  try {
    for (let attempt = 0; attempt < 2 && !items; attempt++) {
      const conversation = attempt === 0 ? messages : [...messages, { role: 'user' as const, content: 'Return only the JSON object {"items":[...]} with no other text.' }];
      let reply: string;
      try { reply = await complete(key, model, conversation, controller.signal); }
      catch (e) {
        const aborted = e instanceof Error && e.name === 'AbortError';
        if (aborted) return json(502, { error: 'Model service timed out.' });
        if (e instanceof Error && e.message.startsWith('Model service')) return json(502, { error: e.message });
        return json(502, { error: 'Model service request failed.' });
      }
      try { items = parseReply(task, reply); }
      catch (e) { lastError = e instanceof Error ? e.message : lastError; }
    }
  } finally {
    clearTimeout(timer);
  }
  if (!items) return json(502, { error: `Model returned unusable output: ${lastError}` });
  const proposal: Proposal = { task, model, promptVersion: PROMPT_VERSION, createdAt: new Date().toISOString(), items };
  return json(200, { proposal });
}

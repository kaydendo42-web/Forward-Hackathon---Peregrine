import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  buildMessages, buildProposals, describePassages, guidanceIndexSchema, guidanceRequestSchema,
  lineQuery, parseReply, PROMPT_VERSION, selectPassages, verifyItems, type GuidanceIndex,
} from '../../../lib/guidance';
import { gate, json } from '../../../lib/gate';

// Thin, gated proxy to NVIDIA NIM, mirroring /api/assist. The API key never leaves this
// handler and no model content is logged.
//
// Retrieval runs here rather than in the browser for two reasons: the passage index is
// far too large to ship to a client, and quote verification must run against passages
// the server retrieved itself. A quote checked against client-supplied text would prove
// nothing. Items whose quote is not found verbatim are dropped before the response is
// built, so an unverified proposal never reaches an adviser's screen.

export const maxDuration = 60;

const NIM_CHAT_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const NIM_EMBED_URL = 'https://integrate.api.nvidia.com/v1/embeddings';
const TOTAL_TIMEOUT_MS = 54_000;
const INDEX_PATH = path.join(process.cwd(), 'guidance', 'index.json');

let cachedIndex: Promise<GuidanceIndex> | null = null;
function loadIndex() {
  cachedIndex ??= readFile(INDEX_PATH, 'utf8').then(raw => guidanceIndexSchema.parse(JSON.parse(raw)));
  return cachedIndex;
}

/**
 * Embed the query with the SAME model that produced the index's passage vectors.
 * Mixing models would silently score against an unrelated vector space.
 */
async function embedQuery(key: string, model: string, query: string, signal: AbortSignal) {
  const res = await fetch(NIM_EMBED_URL, {
    method: 'POST', signal,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ model, input: [query], input_type: 'query', encoding_format: 'float', truncate: 'END' }),
  });
  if (!res.ok) throw new Error(`Embedding service returned ${res.status}.`);
  const data = await res.json() as { data?: { embedding?: number[] }[] };
  const vector = data.data?.[0]?.embedding;
  if (!Array.isArray(vector) || !vector.length) throw new Error('Embedding service returned no vector.');
  return vector;
}

async function complete(key: string, model: string, messages: { role: 'system' | 'user' | 'assistant'; content: string }[], signal: AbortSignal) {
  const modelOptions = model === 'moonshotai/kimi-k3'
    ? { temperature: 1, max_tokens: 4096, reasoning_effort: 'low' as const }
    : model === 'nvidia/nemotron-3.5-lightning-30b-a3b'
      ? { temperature: 0.1, max_tokens: 1500, chat_template_kwargs: { enable_thinking: false } }
      : { temperature: 0.1, max_tokens: 1500 };
  const res = await fetch(NIM_CHAT_URL, {
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

/** The source register, so the review panel can show each citation's title and URL. */
export async function GET(req: Request) {
  const passcode = process.env.AI_ASSIST_PASSCODE;
  if (!passcode) return json(503, { error: 'The guidance agent is not configured on this deployment.' });
  const blocked = gate(req, passcode); if (blocked) return blocked;
  try {
    const index = await loadIndex();
    return json(200, {
      sources: index.sources, scoringMode: index.scoringMode,
      embeddingModel: index.embeddingModel, builtAt: index.builtAt, passageCount: index.passages.length,
    });
  } catch {
    return json(503, { error: 'The guidance index is not available on this deployment.' });
  }
}

export async function POST(req: Request) {
  const key = process.env.NVIDIA_NIM_API_KEY, model = process.env.NVIDIA_NIM_MODEL, passcode = process.env.AI_ASSIST_PASSCODE;
  if (!key || !model || !passcode) return json(503, { error: 'The guidance agent is not configured on this deployment.' });
  const blocked = gate(req, passcode); if (blocked) return blocked;

  let parsed;
  try { parsed = guidanceRequestSchema.parse(await req.json()); }
  catch { return json(400, { error: 'Invalid guidance request.' }); }
  const { line } = parsed;

  let index: GuidanceIndex;
  try { index = await loadIndex(); }
  catch { return json(503, { error: 'The guidance index is not available on this deployment.' }); }

  const query = lineQuery({ category: line.category, label: line.label, component: line.component, requestText: line.currentText });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOTAL_TIMEOUT_MS);
  try {
    // Embedding retrieval when the index has vectors; keyword scoring is the fallback,
    // and which one ran is reported so a weaker result is never passed off as the strong one.
    let queryEmbedding: number[] | null = null;
    if (index.scoringMode === 'embedding' && index.embeddingModel) {
      try { queryEmbedding = await embedQuery(key, index.embeddingModel, query, controller.signal); }
      catch { queryEmbedding = null; }
    }
    const scoringMode = queryEmbedding ? 'embedding' : 'keyword';
    const passages = describePassages(selectPassages(index, query, queryEmbedding), index.sources);
    const createdAt = new Date().toISOString();
    if (!passages.length) {
      return json(200, { proposal: { lineId: line.lineId, model, promptVersion: PROMPT_VERSION, createdAt, scoringMode, items: [], dropped: 0, passages: [] } });
    }

    const messages = buildMessages(line, passages);
    let reply: ReturnType<typeof parseReply> | undefined; let lastError = 'Model returned unusable output.';
    for (let attempt = 0; attempt < 2 && !reply; attempt++) {
      const conversation = attempt === 0 ? messages : [...messages, { role: 'user' as const, content: 'Return only the JSON object {"items":[...]} with no other text.' }];
      let content: string;
      try { content = await complete(key, model, conversation, controller.signal); }
      catch (e) {
        const aborted = e instanceof Error && e.name === 'AbortError';
        if (aborted) return json(502, { error: 'Model service timed out.' });
        if (e instanceof Error && e.message.startsWith('Model service')) return json(502, { error: e.message });
        return json(502, { error: 'Model service request failed.' });
      }
      try { reply = parseReply(content); }
      catch (e) { lastError = e instanceof Error ? e.message : lastError; }
    }
    if (!reply) return json(502, { error: `Model returned unusable output: ${lastError}` });

    const { kept, dropped } = verifyItems(reply.items, passages);
    return json(200, {
      proposal: {
        lineId: line.lineId, model, promptVersion: PROMPT_VERSION, createdAt, scoringMode,
        items: buildProposals(line, kept, index.sources, model, createdAt),
        dropped: dropped.length, malformed: reply.malformed,
        passages: passages.map(passage => ({
          id: passage.id, sourceId: passage.sourceId, sourceTitle: passage.sourceTitle,
          sourceStatus: passage.sourceStatus, synthetic: passage.synthetic,
        })),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

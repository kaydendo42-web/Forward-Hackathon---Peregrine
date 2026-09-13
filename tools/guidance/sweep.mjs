#!/usr/bin/env node
// Run every baseline line in fixtures/fy25/manifest.json through the guidance agent and
// write one JSON file per line that produced a verified proposal.
//
// This is the offline batch path. It calls NVIDIA NIM directly rather than through
// /api/guidance so it needs no dev server, but it shares the prompt, parsing, quote
// verification and proposal shape with the route, so both produce identical proposals.
//
// Proposals are written PENDING. Nothing here changes a request, a workspace or a
// workbook, and an empty result for a line is a normal, expected outcome.
//
//   node tools/guidance/sweep.mjs                 # all 18 lines
//   node tools/guidance/sweep.mjs --only ALE-DIV-CASH,TR-DOC   # one or more line ids
//   node tools/guidance/sweep.mjs --dry-run       # retrieval only, no model calls

import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadGuidance, readEnvLocal } from './build-index.mjs';

const {
  buildMessages, buildProposals, describePassages, lineQuery, parseReply,
  selectPassages, verifyItems,
} = await loadGuidance();

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const indexPath = path.join(repoRoot, 'guidance', 'index.json');
const manifestPath = path.join(repoRoot, 'fixtures', 'fy25', 'manifest.json');
const proposalsDir = path.join(repoRoot, 'guidance', 'proposals');

const NIM_CHAT_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const NIM_EMBED_URL = 'https://integrate.api.nvidia.com/v1/embeddings';
const TIMEOUT_MS = 54_000;

function modelOptions(model) {
  if (model === 'moonshotai/kimi-k3') return { temperature: 1, max_tokens: 4096, reasoning_effort: 'low' };
  if (model === 'nvidia/nemotron-3.5-lightning-30b-a3b') {
    return { temperature: 0.1, max_tokens: 1500, chat_template_kwargs: { enable_thinking: false } };
  }
  return { temperature: 0.1, max_tokens: 1500 };
}

async function complete(key, model, messages, signal) {
  const res = await fetch(NIM_CHAT_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ model, messages, ...modelOptions(model), stream: false }),
    signal,
  });
  if (!res.ok) throw new Error(`model service returned ${res.status}`);
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('model service returned no message');
  return content;
}

async function embedQueries(key, model, queries) {
  const vectors = [];
  for (let i = 0; i < queries.length; i += 16) {
    const res = await fetch(NIM_EMBED_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ model, input: queries.slice(i, i + 16), input_type: 'query', encoding_format: 'float', truncate: 'END' }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`embedding service returned ${res.status}`);
    vectors.push(...(await res.json()).data.map((row) => row.embedding));
  }
  return vectors;
}

function toGuidanceLine(line, entityType) {
  return {
    lineId: line.line_id, entityType, category: line.category, label: line.label,
    component: line.component, basis: line.basis, currentText: line.request_text,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
  const dryRun = args.includes('--dry-run');

  const index = JSON.parse(await readFile(indexPath, 'utf8'));
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const lines = manifest.entities.flatMap((entity) =>
    entity.lines.map((line) => toGuidanceLine(line, entity.entity_type)));
  const wantedIds = only ? only.split(',').map((id) => id.trim()).filter(Boolean) : null;
  const wanted = wantedIds ? lines.filter((line) => wantedIds.includes(line.lineId)) : lines;
  if (!wanted.length) throw new Error(`no baseline line with id ${only}`);

  const env = await readEnvLocal();
  const key = process.env.NVIDIA_NIM_API_KEY || env.get('NVIDIA_NIM_API_KEY');
  const model = process.env.NVIDIA_NIM_MODEL || env.get('NVIDIA_NIM_MODEL');
  if (!dryRun && (!key || !model)) throw new Error('NVIDIA_NIM_API_KEY and NVIDIA_NIM_MODEL must be set (checked environment and .env.local)');

  const queries = wanted.map((line) => lineQuery({ category: line.category, label: line.label, component: line.component, requestText: line.currentText }));
  let embeddings = wanted.map(() => null);
  let scoringMode = 'keyword';
  if (index.scoringMode === 'embedding' && index.embeddingModel && key) {
    try {
      embeddings = await embedQueries(key, index.embeddingModel, queries);
      scoringMode = 'embedding';
    } catch (error) {
      console.log(`query embeddings unavailable, using keyword scoring - ${error.message}`);
    }
  }
  console.log(`sweeping ${wanted.length} line(s), scoring mode "${scoringMode}", model ${dryRun ? '(dry run)' : model}\n`);

  await mkdir(proposalsDir, { recursive: true });
  // Clear only the files this sweep is about to reconsider, so a stale proposal for a
  // line that now returns nothing cannot linger and look current.
  for (const file of await readdir(proposalsDir).catch(() => [])) {
    if (file.endsWith('.json') && wanted.some((line) => `${line.lineId}.json` === file)) {
      await unlink(path.join(proposalsDir, file));
    }
  }

  const summary = [];
  for (const [i, line] of wanted.entries()) {
    const passages = describePassages(selectPassages(index, queries[i], embeddings[i]), index.sources);
    const row = { lineId: line.lineId, passages: passages.length, items: 0, dropped: 0, malformed: 0, ms: 0, error: null };

    if (dryRun) {
      row.sources = [...new Set(passages.map((passage) => passage.sourceId))];
      summary.push(row);
      console.log(`${line.lineId.padEnd(15)} ${passages.length} passage(s): ${row.sources.join(', ')}`);
      continue;
    }

    const started = Date.now();
    let reply;
    let lastError = 'model returned unusable output';
    const messages = buildMessages(line, passages);
    // One deadline for the line, shared by both attempts, exactly as the route does -
    // otherwise a retry after a slow first call can double the wait.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      for (let attempt = 0; attempt < 2 && !reply; attempt++) {
        const conversation = attempt === 0 ? messages
          : [...messages, { role: 'user', content: 'Return only the JSON object {"items":[...]} with no other text.' }];
        try { reply = parseReply(await complete(key, model, conversation, controller.signal)); }
        catch (error) {
          lastError = error.message;
          if (controller.signal.aborted) break;
        }
      }
    } finally { clearTimeout(timer); }
    row.ms = Date.now() - started;

    if (!reply) {
      row.error = lastError;
      summary.push(row);
      console.log(`${line.lineId.padEnd(15)} FAILED after ${row.ms}ms - ${lastError.slice(0, 120)}`);
      continue;
    }
    row.malformed = reply.malformed;

    const { kept, dropped } = verifyItems(reply.items, passages);
    const proposals = buildProposals(line, kept, index.sources, model);
    row.items = proposals.length;
    row.dropped = dropped.length;
    summary.push(row);

    if (proposals.length) {
      await writeFile(path.join(proposalsDir, `${line.lineId}.json`), `${JSON.stringify(proposals, null, 2)}\n`, 'utf8');
    }
    console.log(
      `${line.lineId.padEnd(15)} ${String(row.ms).padStart(6)}ms  proposed ${reply.items.length}  verified ${proposals.length}  dropped ${dropped.length}  malformed ${reply.malformed}`
      + (proposals.length ? `  -> ${proposals.map((proposal) => proposal.sourceId).join(', ')}` : ''),
    );
  }

  if (dryRun) return;
  const proposed = summary.filter((row) => row.items > 0);
  const latencies = summary.filter((row) => row.ms > 0).map((row) => row.ms).sort((a, b) => a - b);
  console.log(
    `\n${proposed.length}/${summary.length} line(s) produced a verified proposal`
    + ` (${proposed.map((row) => row.lineId).join(', ') || 'none'})`
    + `\n${summary.reduce((total, row) => total + row.dropped, 0)} item(s) dropped by quote verification`
    + `\n${summary.filter((row) => row.error).length} line(s) failed`
    + (latencies.length ? `\nlatency per call: min ${latencies[0]}ms, median ${latencies[Math.floor(latencies.length / 2)]}ms, max ${latencies.at(-1)}ms` : ''),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

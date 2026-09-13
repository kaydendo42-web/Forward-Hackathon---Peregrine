#!/usr/bin/env node
// Chunk guidance/sources/*.txt into passages and write guidance/index.json.
//
// Tries NVIDIA hosted embeddings first. If they are unavailable for any reason -
// no API key, auth refused, model name wrong, request failed - the index is still
// built, in keyword mode, and index.json records which mode is active. Retrieval
// quality differs between the two; the mode is never hidden.
//
//   node tools/guidance/build-index.mjs              # try embeddings, fall back
//   node tools/guidance/build-index.mjs --keyword    # skip embeddings entirely
//
// Reads NVIDIA_NIM_API_KEY from .env.local. Values are never printed or logged.

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Load src/lib/guidance.ts from a plain Node script.
 *
 * Node runs TypeScript directly but resolves specifiers literally, while the app's
 * own imports omit file extensions because Next and Vitest resolve them. Rather than
 * change how the application code is written for the benefit of two tools, the tools
 * add the extension back when a relative specifier does not resolve. Registered once,
 * before the dynamic import, because a static import would be resolved too early.
 */
let guidanceModule = null;
export async function loadGuidance() {
  if (guidanceModule) return guidanceModule;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try { return nextResolve(specifier, context); }
      catch (error) {
        if (!specifier.startsWith('.')) throw error;
        for (const extension of ['.ts', '.tsx']) {
          try { return nextResolve(specifier + extension, context); } catch { /* try the next one */ }
        }
        throw error;
      }
    },
  });
  guidanceModule = await import('../../src/lib/guidance.ts');
  return guidanceModule;
}

const { chunkText, CHUNK_WORDS, CHUNK_OVERLAP_WORDS } = await loadGuidance();

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const sourcesDir = path.join(repoRoot, 'guidance', 'sources');
const indexPath = path.join(repoRoot, 'guidance', 'index.json');

const EMBED_URL = 'https://integrate.api.nvidia.com/v1/embeddings';
// Retrieval model, confirmed against GET /v1/models on 13 September 2026. The older
// nv-embedqa-e5-v5 reached end of life on 25 August 2026 and now answers 410. Set
// NVIDIA_NIM_EMBED_MODEL to override when this one is retired in turn.
// Asymmetric retrieval: passages and queries are embedded with matching input_type.
const EMBED_MODEL = process.env.NVIDIA_NIM_EMBED_MODEL || 'nvidia/nemotron-3-embed-1b';
const EMBED_BATCH = 16;
const EMBED_TIMEOUT_MS = 54_000;
// 6 decimals costs nothing measurable in cosine similarity and keeps the committed
// index to a reviewable size.
const EMBED_PRECISION = 1e6;

/** Minimal .env.local reader so tools work without a dotenv dependency. */
export async function readEnvLocal(root = repoRoot) {
  const values = new Map();
  let raw;
  try { raw = await readFile(path.join(root, '.env.local'), 'utf8'); }
  catch { return values; }
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!match || line.trimStart().startsWith('#')) continue;
    const value = match[2].trim().replace(/^["']|["']$/g, '');
    if (value) values.set(match[1], value);
  }
  return values;
}

export async function embedBatch(key, inputs, inputType) {
  const response = await fetch(EMBED_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input: inputs, input_type: inputType, encoding_format: 'float', truncate: 'END' }),
    signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`embeddings returned ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }
  const data = await response.json();
  const vectors = (data.data ?? []).map((row) => row.embedding);
  if (vectors.length !== inputs.length || vectors.some((vector) => !Array.isArray(vector) || !vector.length)) {
    throw new Error('embeddings response did not contain one vector per input');
  }
  return vectors.map((vector) => vector.map((value) => Math.round(value * EMBED_PRECISION) / EMBED_PRECISION));
}

async function loadSources() {
  const files = (await readdir(sourcesDir)).filter((name) => name.endsWith('.json')).sort();
  const sources = [];
  for (const file of files) {
    const sidecar = JSON.parse(await readFile(path.join(sourcesDir, file), 'utf8'));
    if (sidecar.fetchError) {
      console.log(`skipping ${sidecar.id}: recorded as not saved (${sidecar.fetchError})`);
      continue;
    }
    let body;
    try { body = await readFile(path.join(sourcesDir, `${sidecar.id}.txt`), 'utf8'); }
    catch { console.log(`skipping ${sidecar.id}: ${sidecar.id}.txt is missing`); continue; }
    sources.push({ sidecar, body });
  }
  return sources;
}

async function main() {
  const keywordOnly = process.argv.includes('--keyword');
  const sources = await loadSources();
  if (!sources.length) throw new Error('no saved sources found; run fetch-sources.mjs first');

  const passages = [];
  const catalogue = [];
  for (const { sidecar, body } of sources) {
    const chunks = chunkText(sidecar.id, body);
    passages.push(...chunks);
    catalogue.push({
      id: sidecar.id, title: sidecar.title, url: sidecar.url ?? null, retrievedAt: sidecar.retrievedAt,
      sha256: sidecar.sha256, publishedDate: sidecar.publishedDate ?? null,
      appliesToYears: sidecar.appliesToYears ?? [], sourceStatus: sidecar.sourceStatus,
      synthetic: Boolean(sidecar.synthetic),
    });
    console.log(`${sidecar.id}: ${chunks.length} passage(s)`);
  }

  let scoringMode = 'keyword';
  let embeddingModel = null;
  if (!keywordOnly) {
    const key = process.env.NVIDIA_NIM_API_KEY || (await readEnvLocal()).get('NVIDIA_NIM_API_KEY');
    if (!key) {
      console.log('embeddings skipped: NVIDIA_NIM_API_KEY is not set (checked environment and .env.local)');
    } else {
      try {
        const started = Date.now();
        for (let i = 0; i < passages.length; i += EMBED_BATCH) {
          const batch = passages.slice(i, i + EMBED_BATCH);
          const vectors = await embedBatch(key, batch.map((passage) => passage.text), 'passage');
          batch.forEach((passage, j) => { passage.embedding = vectors[j]; });
          console.log(`embedded ${Math.min(i + EMBED_BATCH, passages.length)}/${passages.length}`);
        }
        scoringMode = 'embedding';
        embeddingModel = EMBED_MODEL;
        console.log(`embeddings complete in ${((Date.now() - started) / 1000).toFixed(1)}s, ${passages[0].embedding.length} dimensions`);
      } catch (error) {
        for (const passage of passages) delete passage.embedding;
        console.log(`embeddings unavailable, falling back to keyword scoring - ${error.message}`);
      }
    }
  }

  const index = {
    builtAt: new Date().toISOString(),
    scoringMode,
    embeddingModel,
    chunkWords: CHUNK_WORDS,
    chunkOverlapWords: CHUNK_OVERLAP_WORDS,
    sources: catalogue,
    passages,
  };
  await writeFile(indexPath, `${JSON.stringify(index, null, scoringMode === 'embedding' ? 0 : 2)}\n`, 'utf8');
  console.log(`index.json written: ${catalogue.length} sources, ${passages.length} passages, scoring mode "${scoringMode}"`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

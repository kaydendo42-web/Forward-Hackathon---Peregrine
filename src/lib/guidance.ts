import { z } from 'zod';
import type { EntityType, GuidanceProposal, Workspace } from '../core/types';
import { logEvent } from '../core/workflow';

// Pure guidance-agent core, shared by the route handler, the browser, the sweep tool
// and tests. Nothing here performs I/O.
//
// The agent reads official guidance, retrieves the passages bearing on one baseline
// line, and asks a model whether that line's request wording should change. The model
// only ever PROPOSES, and every proposal must quote its source verbatim: a quote that
// is not found in the cited passage is dropped in code, before any adviser sees it.
// Accepting a proposal changes request wording only — never a tax position, and never
// a request that already exists.

export const PROMPT_VERSION = 'guidance-1';

// ---------------------------------------------------------------- sources and index

export const SOURCE_STATUSES = ['final_guidance', 'draft', 'announcement', 'synthetic_fixture'] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];

const text = z.string().max(8000);

export const guidanceSourceSchema = z.object({
  id: z.string().min(1).max(120),
  title: text,
  url: z.string().max(2000).nullable(),
  retrievedAt: z.string().max(40),
  sha256: z.string().max(64),
  publishedDate: z.string().max(40).nullable(),
  appliesToYears: z.array(z.number().int()).max(20),
  sourceStatus: z.enum(SOURCE_STATUSES),
  synthetic: z.boolean(),
});
export type GuidanceSource = z.infer<typeof guidanceSourceSchema>;

export const passageSchema = z.object({
  id: z.string().min(1).max(160),
  sourceId: z.string().min(1).max(120),
  text: z.string().min(1).max(20_000),
  embedding: z.array(z.number()).max(8192).optional(),
});
export type Passage = z.infer<typeof passageSchema>;

export const SCORING_MODES = ['embedding', 'keyword'] as const;
export type ScoringMode = (typeof SCORING_MODES)[number];

export const guidanceIndexSchema = z.object({
  builtAt: z.string().max(40),
  scoringMode: z.enum(SCORING_MODES),
  embeddingModel: z.string().max(200).nullable(),
  chunkWords: z.number().int().positive(),
  chunkOverlapWords: z.number().int().nonnegative(),
  sources: z.array(guidanceSourceSchema).max(200),
  passages: z.array(passageSchema).max(20_000),
});
export type GuidanceIndex = z.infer<typeof guidanceIndexSchema>;

// ---------------------------------------------------------------------- chunking

export const CHUNK_WORDS = 600;
export const CHUNK_OVERLAP_WORDS = 80;

/**
 * Split one source into overlapping word windows, keeping its `sourceId`. Overlap
 * stops a sentence that straddles a boundary from being lost to retrieval. Words are
 * rejoined with single spaces; `verifyQuote` normalises whitespace the same way, so a
 * quote taken from a passage still matches the passage it came from.
 */
export function chunkText(sourceId: string, body: string, words = CHUNK_WORDS, overlap = CHUNK_OVERLAP_WORDS): Passage[] {
  if (words <= 0 || overlap < 0 || overlap >= words) throw new Error('Chunk size must exceed its overlap.');
  const tokens = body.split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const step = words - overlap;
  const passages: Passage[] = [];
  for (let start = 0; start < tokens.length; start += step) {
    passages.push({ id: `${sourceId}#${passages.length}`, sourceId, text: tokens.slice(start, start + words).join(' ') });
    if (start + words >= tokens.length) break;
  }
  return passages;
}

// ----------------------------------------------------------------------- scoring

const STOPWORDS = new Set([
  'a', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'do', 'does', 'for', 'from',
  'had', 'has', 'have', 'how', 'if', 'in', 'into', 'is', 'it', 'its', 'may', 'must', 'no', 'not', 'of', 'on',
  'or', 'our', 'out', 'should', 'so', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they',
  'this', 'those', 'to', 'up', 'was', 'were', 'what', 'when', 'which', 'who', 'will', 'with', 'you', 'your',
]);

/** Light stem: enough to tie statement/statements and provide/providing together. */
export function stem(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  for (const suffix of ['ing', 'ed', 'es', 's']) {
    if (word.length > suffix.length + 3 && word.endsWith(suffix)) return word.slice(0, -suffix.length);
  }
  return word;
}

export function tokenise(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(word => word.length > 1 && !STOPWORDS.has(word))
    .map(stem);
}

function termFrequencies(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

// BM25 constants: k1 damps repeated terms, b controls how hard length is penalised,
// k3 damps repeated QUERY terms. k3 matters here because a line's query is built by
// concatenating its category, label, component and request text, so a word can repeat
// three or four times as an artefact of that concatenation rather than because the
// line is really that much more about it.
const BM25_K1 = 1.2;
const BM25_B = 0.75;
const BM25_K3 = 2;

/**
 * TF-weighted overlap (BM25) between the query and each passage. Inverse document
 * frequency is computed across the supplied passages, so words on every ATO page
 * (`tax`, `year`) count for less than distinguishing ones, and length normalisation is
 * relative to the average passage — without it a short source outranks long ones on
 * generic words alone. Query term frequency is a weight too, which is what lets the
 * distinctive part of a line (`dividend`, `cash`) outweigh its boilerplate
 * (`provide the current-year`). Returns one score per passage, in the order given.
 */
export function keywordScores(query: string, passages: Passage[]): number[] {
  const queryTerms = termFrequencies(tokenise(query));
  if (!queryTerms.size || !passages.length) return passages.map(() => 0);

  const passageTokens = passages.map(passage => tokenise(passage.text));
  const documentCount = new Map<string, number>();
  for (const tokens of passageTokens) {
    for (const term of new Set(tokens)) documentCount.set(term, (documentCount.get(term) ?? 0) + 1);
  }
  const lengths = passageTokens.map(tokens => tokens.length);
  const averageLength = lengths.reduce((sum, length) => sum + length, 0) / passages.length || 1;

  return passageTokens.map((tokens, i) => {
    const frequencies = termFrequencies(tokens);
    let score = 0;
    for (const [term, queryCount] of queryTerms) {
      const count = frequencies.get(term);
      if (!count) continue;
      const seen = documentCount.get(term) ?? 0;
      const idf = Math.log(1 + (passages.length - seen + 0.5) / (seen + 0.5));
      const norm = count + BM25_K1 * (1 - BM25_B + BM25_B * (lengths[i]! / averageLength));
      const queryWeight = ((BM25_K3 + 1) * queryCount) / (BM25_K3 + queryCount);
      score += queryWeight * idf * ((count * (BM25_K1 + 1)) / norm);
    }
    return score;
  });
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; normA += a[i]! ** 2; normB += b[i]! ** 2; }
  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  return magnitude ? dot / magnitude : 0;
}

export function embeddingScores(queryEmbedding: number[], passages: Passage[]): number[] {
  return passages.map(passage => passage.embedding ? cosineSimilarity(queryEmbedding, passage.embedding) : 0);
}

export const TOP_PASSAGES = 5;
export type ScoredPassage = { passage: Passage; score: number };

/**
 * Top passages for one query. Embedding mode needs both an index built with vectors
 * and an embedded query; anything else falls back to keyword scoring rather than
 * silently returning nothing.
 */
export function selectPassages(
  index: GuidanceIndex, query: string, queryEmbedding: number[] | null = null, top = TOP_PASSAGES,
): ScoredPassage[] {
  const usable = index.scoringMode === 'embedding' && queryEmbedding?.length
    && index.passages.some(passage => passage.embedding?.length);
  const scores = usable ? embeddingScores(queryEmbedding, index.passages) : keywordScores(query, index.passages);
  return index.passages
    .map((passage, i) => ({ passage, score: scores[i] ?? 0 }))
    .filter(scored => scored.score > 0)
    .sort((a, b) => b.score - a.score || a.passage.id.localeCompare(b.passage.id))
    .slice(0, top);
}

/** The retrieval query for one baseline line: what the line is, plus how it is asked today. */
export function lineQuery(line: { category: string; label: string; component: string; requestText: string }): string {
  return `${line.category.replaceAll('_', ' ')} ${line.label} ${line.component.replaceAll('_', ' ')} ${line.requestText}`;
}

// --------------------------------------------------------------------- proposals

/** Wording advanced by an accepted guidance proposal. `demo-method-1` stays the default. */
export const GUIDANCE_METHOD_VERSION = 'demo-method-2';
export const MAX_ITEMS = 5;

const ENTITY_TYPES = ['individual', 'company', 'trust'] as const satisfies readonly EntityType[];

/** Exactly what the model is allowed to return. Everything else on a proposal is filled in by code. */
export const guidanceItemSchema = z.object({
  proposedText: z.string().trim().min(1).max(400),
  sourceId: z.string().trim().min(1).max(120),
  quote: z.string().trim().min(1).max(500),
  appliesToEntityTypes: z.array(z.enum(ENTITY_TYPES)).min(1).max(3),
  appliesToYears: z.array(z.number().int().min(2000).max(2100)).min(1).max(10),
  rationale: z.string().trim().min(1).max(600),
});
export type GuidanceItem = z.infer<typeof guidanceItemSchema>;

// Typed against the shared Workspace type so the schema and the stored shape cannot drift.
export const guidanceProposalSchema: z.ZodType<GuidanceProposal> = z.object({
  lineId: z.string().min(1).max(80),
  currentText: z.string().max(4000),
  proposedText: z.string().trim().min(1).max(400),
  sourceId: z.string().min(1).max(120),
  quote: z.string().trim().min(1).max(500),
  appliesToEntityTypes: z.array(z.enum(ENTITY_TYPES)).min(1).max(3),
  appliesToYears: z.array(z.number().int()).min(1).max(10),
  sourceStatus: z.enum(SOURCE_STATUSES),
  rationale: z.string().trim().min(1).max(600),
  retrievedAt: z.string().max(40),
  sourceHash: z.string().max(64),
  model: z.string().max(200),
  promptVersion: z.string().max(40),
  createdAt: z.string().max(40),
  review: z.object({
    status: z.enum(['pending', 'accepted', 'rejected']),
    reviewer: z.string().max(200),
    decidedAt: z.string().max(40),
  }),
});

export const guidanceLineSchema = z.object({
  lineId: z.string().min(1).max(80), entityType: z.enum(ENTITY_TYPES), category: z.string().max(80),
  label: z.string().max(200), component: z.string().max(80), basis: z.string().max(80),
  currentText: z.string().max(4000),
});
export type GuidanceLine = z.infer<typeof guidanceLineSchema>;
export const guidanceRequestSchema = z.object({ line: guidanceLineSchema });

/** One proposal's identity for lookup: the schema carries no id of its own. */
export function proposalKey(proposal: GuidanceProposal): string {
  return `${proposal.lineId}|${proposal.sourceId}|${proposal.createdAt}`;
}

// ----------------------------------------------------------------------- prompts

const SYSTEM = `You help an Australian tax adviser keep a client information-request checklist current as official guidance changes. All entity data is SYNTHETIC demonstration data. FY2026 means the Australian financial year 1 July 2025 to 30 June 2026.
You only PROPOSE. A human adviser reviews and accepts or rejects every item before it changes anything. Do not give tax advice, do not state a tax position, and do not calculate tax.
You are changing only the EVIDENCE REQUEST WORDING sent to a client: what documents they should provide. You are not deciding what is taxable.
Every item MUST quote a passage supplied below, copied VERBATIM, character for character, from that passage's text. Do not paraphrase, shorten, join two sentences, or fix punctuation inside a quote. An item whose quote is not found in the passage it cites is discarded automatically.
Propose a change ONLY when a supplied passage actually supports it. If nothing supports a change to this line, return {"items":[]}. An empty list is a correct and expected answer, and is better than a weak proposal.
FY25 (2024-25) guidance does not establish an FY2026 requirement. A passage that applies only to an earlier year cannot justify changing an FY2026 request.
A budget announcement or a proposed measure is not enacted law. Do not treat announced measures as settled requirements.
A passage labelled sourceStatus "synthetic_fixture" is fabricated demonstration material, not real guidance. You may still propose from it, because this is a demo, but never describe it as an ATO rule or as law in your rationale.
Set appliesToEntityTypes to the entity types the passage genuinely covers, and appliesToYears to the financial years it applies to.
Reply with ONLY a JSON object of the form {"items":[...]} - no prose, no markdown.`;

const TASK = `Decide whether this baseline line's client request wording should change for FY2026.
The line's current wording is line.currentText. Propose new wording only if a supplied passage shows the current wording would miss evidence, ask for the wrong thing, or be less specific than the guidance supports.
proposedText is the replacement wording sent to the client: one or two plain sentences, under 400 characters, no "FY2026:" prefix (the app adds it), no jargon, naming the documents to provide.
sourceId must be the sourceId of the passage you quote. quote must appear verbatim in that passage, and must be ONE short sentence under 400 characters - copy the single sentence that best supports the change, not a whole paragraph.
rationale states what the passage requires and why the current wording is insufficient, in under 600 characters.
Items: {"proposedText": string, "sourceId": string, "quote": string, "appliesToEntityTypes": string[], "appliesToYears": number[], "rationale": string}.
Return at most 1 item for this line. Return {"items":[]} if no supplied passage supports a change.`;

export type PromptPassage = {
  id: string; sourceId: string; sourceTitle: string; sourceStatus: SourceStatus;
  publishedDate: string | null; appliesToYears: number[]; synthetic: boolean; text: string;
};

/** Attach each passage's provenance, so the model can weigh status and year rather than guess. */
export function describePassages(scored: ScoredPassage[], sources: GuidanceSource[]): PromptPassage[] {
  return scored.map(({ passage }) => {
    const source = sources.find(candidate => candidate.id === passage.sourceId);
    return {
      id: passage.id, sourceId: passage.sourceId, sourceTitle: source?.title ?? passage.sourceId,
      sourceStatus: source?.sourceStatus ?? 'draft', publishedDate: source?.publishedDate ?? null,
      appliesToYears: source?.appliesToYears ?? [], synthetic: Boolean(source?.synthetic), text: passage.text,
    };
  });
}

export function buildMessages(line: GuidanceLine, passages: PromptPassage[]) {
  // Deliberately omits each passage's own `id`. Showing both `id` ("src#3") and
  // `sourceId` ("src") invites the model to cite the wrong one, which then reads as a
  // failed citation when it was really an ambiguous prompt.
  const payload = {
    financialYear: 2026, line,
    passages: passages.map(({ id, ...passage }) => passage),
  };
  return [
    { role: 'system' as const, content: SYSTEM },
    { role: 'user' as const, content: `${TASK}\n\nContext (JSON):\n${JSON.stringify(payload, null, 1)}\n\nReturn {"items":[...]} only.` },
  ];
}

/**
 * Parse the model's reply into items. A reply that is not JSON, or not shaped
 * `{"items":[...]}`, is rejected outright — that is a broken answer, not a weak one.
 *
 * Individual items that fail the schema are dropped and counted rather than failing
 * the whole reply: in live runs a single over-long quote would otherwise discard a
 * line's entire answer, including items that were perfectly good. The count is
 * returned so a model that is quietly misbehaving still shows up in the sweep report.
 */
export function parseReply(content: string): { items: GuidanceItem[]; malformed: number } {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = trimmed.indexOf('{'); const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Model reply did not contain a JSON object.');
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed.slice(start, end + 1)); }
  catch { throw new Error('Model reply was not valid JSON.'); }
  const raw = z.object({ items: z.array(z.unknown()).max(MAX_ITEMS * 4) }).parse(parsed).items;

  const items: GuidanceItem[] = []; let malformed = 0;
  for (const candidate of raw) {
    const result = guidanceItemSchema.safeParse(candidate);
    if (result.success) items.push(result.data); else malformed++;
  }
  return { items: items.slice(0, MAX_ITEMS), malformed };
}

// ------------------------------------------------------------ quote verification

/** Collapse runs of whitespace so a quote split across lines still matches its passage. */
const normaliseWhitespace = (value: string) => value.replace(/\s+/g, ' ').trim();

/**
 * True only when the item's quote appears verbatim - after whitespace normalisation
 * and nothing else - inside a supplied passage belonging to the source the item cites.
 *
 * This is the load-bearing check of the whole agent. A model that invents a quote, or
 * quotes a source it was not given, produces an item that no adviser ever sees. It is
 * deliberately strict: case and punctuation must match, because "verbatim" is the only
 * property that makes the citation worth anything.
 */
export function verifyQuote(item: GuidanceItem, passages: PromptPassage[]): boolean {
  const quote = normaliseWhitespace(item.quote);
  if (!quote) return false;
  const sourceId = resolveSourceId(item.sourceId, passages);
  if (!sourceId) return false;
  return passages.some(passage => passage.sourceId === sourceId && normaliseWhitespace(passage.text).includes(quote));
}

/**
 * Accept a citation of either the source ("ato-itr-2026-dividends") or one of its
 * passages ("ato-itr-2026-dividends#1"), returning the source id. Both name the same
 * supplied document, so treating a passage-id citation as a miss would reject a
 * perfectly good verbatim quote. Anything not among the supplied passages returns
 * null and the item is dropped - the strictness that matters is unchanged.
 */
function resolveSourceId(cited: string, passages: PromptPassage[]): string | null {
  if (passages.some(passage => passage.sourceId === cited)) return cited;
  return passages.find(passage => passage.id === cited)?.sourceId ?? null;
}

export function verifyItems(items: GuidanceItem[], passages: PromptPassage[]): { kept: GuidanceItem[]; dropped: GuidanceItem[] } {
  const kept: GuidanceItem[] = [], dropped: GuidanceItem[] = [];
  for (const item of items) {
    const sourceId = resolveSourceId(item.sourceId, passages);
    const canonical = sourceId ? { ...item, sourceId } : item;
    (verifyQuote(canonical, passages) ? kept : dropped).push(canonical);
  }
  return { kept, dropped };
}

/** Fill the code-owned fields of a proposal from the source register. Verified items only. */
export function buildProposals(
  line: GuidanceLine, items: GuidanceItem[], sources: GuidanceSource[], model: string, createdAt = new Date().toISOString(),
): GuidanceProposal[] {
  return items.flatMap(item => {
    const source = sources.find(candidate => candidate.id === item.sourceId);
    if (!source) return [];
    return [{
      lineId: line.lineId, currentText: line.currentText, proposedText: item.proposedText,
      sourceId: source.id, quote: item.quote,
      appliesToEntityTypes: item.appliesToEntityTypes, appliesToYears: item.appliesToYears,
      sourceStatus: source.sourceStatus, rationale: item.rationale,
      retrievedAt: source.retrievedAt, sourceHash: source.sha256,
      model, promptVersion: PROMPT_VERSION, createdAt,
      review: { status: 'pending' as const, reviewer: '', decidedAt: '' },
    }];
  });
}

// --------------------------------------------------------------- adviser decision

/**
 * Record proposals for review, ignoring ones already held. Nothing is applied: every
 * proposal lands pending and waits for an adviser. The event says where they came from,
 * so a later reader can tell a sweep file from a live check.
 */
export function addGuidanceProposals(state: Workspace, incoming: GuidanceProposal[], origin: string): Workspace {
  const existing = state.guidance ?? [];
  const known = new Set(existing.map(proposalKey));
  const fresh = incoming.filter(proposal => !known.has(proposalKey(proposal)));
  if (!fresh.length) throw new Error('Those guidance proposals are already in this workspace.');

  const unknownLine = fresh.find(proposal => !state.baselines.some(baseline => baseline.lines.some(line => line.id === proposal.lineId)));
  if (unknownLine) throw new Error(`Proposal refers to baseline line ${unknownLine.lineId}, which is not in this workspace.`);

  const entityId = locate(state, fresh[0]!.lineId).entityId;
  const detail = `${fresh.length} guidance proposal(s) recorded for review from ${origin}: ${fresh.map(proposal => `${proposal.lineId} (source ${proposal.sourceId}, ${proposal.sourceStatus})`).join('; ')}. Nothing is applied until an adviser accepts.`;
  return logEvent({ ...state, guidance: [...existing, ...fresh] }, entityId, 'guidance_proposals_recorded', detail);
}

function decide(state: Workspace, proposal: GuidanceProposal, status: 'accepted' | 'rejected', reviewer: string) {
  if (proposal.review.status !== 'pending') throw new Error('This guidance proposal has already been reviewed.');
  const key = proposalKey(proposal);
  const decided: GuidanceProposal = { ...proposal, review: { status, reviewer: reviewer.trim().slice(0, 200), decidedAt: new Date().toISOString() } };
  const existing = state.guidance ?? [];
  const guidance = existing.some(candidate => proposalKey(candidate) === key)
    ? existing.map(candidate => proposalKey(candidate) === key ? decided : candidate)
    : [...existing, decided];
  return { decided, guidance };
}

function locate(state: Workspace, lineId: string) {
  const matches = state.baselines.filter(baseline => baseline.lines.some(line => line.id === lineId));
  if (matches.length !== 1) throw new Error(`Baseline line ${lineId} is not in this workspace, or is not unique.`);
  return matches[0]!;
}

/**
 * Accept one proposal: replace that single baseline line's `requestText` and stamp the
 * line `demo-method-2`.
 *
 * Existing FY26 requests - draft, sent or reviewed - are deliberately left alone. The
 * new wording takes effect at the next `startSeason()`, so accepting a wording change
 * never rewrites a question a client has already been asked.
 */
export function applyGuidanceProposal(state: Workspace, proposal: GuidanceProposal, reviewer = ''): Workspace {
  const baseline = locate(state, proposal.lineId);
  if (!proposal.appliesToEntityTypes.includes(baseline.entityType)) {
    throw new Error(`This proposal applies to entity types ${proposal.appliesToEntityTypes.join(', ')}; ${baseline.entityName} is of type ${baseline.entityType}.`);
  }
  const { decided, guidance } = decide(state, proposal, 'accepted', reviewer);
  const baselines = state.baselines.map(candidate => candidate.entityId !== baseline.entityId ? candidate : {
    ...candidate,
    lines: candidate.lines.map(line => line.id !== proposal.lineId ? line
      : { ...line, requestText: decided.proposedText, methodVersion: GUIDANCE_METHOD_VERSION }),
  });
  const detail = `Guidance proposal accepted for line ${proposal.lineId}: wording advanced to ${GUIDANCE_METHOD_VERSION} (model ${proposal.model}, prompt ${proposal.promptVersion}, source ${proposal.sourceId}, source hash ${proposal.sourceHash}, status ${proposal.sourceStatus}). Existing FY2026 requests are unchanged; the new wording applies from the next season.`;
  return logEvent({ ...state, baselines, guidance }, baseline.entityId, 'guidance_proposal_accepted', detail);
}

/** Reject one proposal: nothing about the baseline changes, and the decision is logged. */
export function rejectGuidanceProposal(state: Workspace, proposal: GuidanceProposal, reviewer = ''): Workspace {
  const baseline = locate(state, proposal.lineId);
  const { guidance } = decide(state, proposal, 'rejected', reviewer);
  const detail = `Guidance proposal rejected for line ${proposal.lineId} (model ${proposal.model}, prompt ${proposal.promptVersion}, source ${proposal.sourceId}, source hash ${proposal.sourceHash}). Request wording is unchanged.`;
  return logEvent({ ...state, guidance }, baseline.entityId, 'guidance_proposal_rejected', detail);
}

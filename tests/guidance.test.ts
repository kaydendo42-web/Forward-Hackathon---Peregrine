import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import * as workflow from '../src/core/workflow';
import {
  addGuidanceProposals, applyGuidanceProposal, buildMessages, buildProposals, chunkText,
  cosineSimilarity, describePassages, embeddingScores, guidanceIndexSchema, GUIDANCE_METHOD_VERSION,
  guidanceProposalSchema, keywordScores, lineQuery, parseReply, rejectGuidanceProposal,
  selectPassages, stem, tokenise, verifyQuote, verifyItems,
  type GuidanceItem, type GuidanceIndex, type GuidanceSource, type Passage, type PromptPassage,
} from '../src/lib/guidance';
import { parseSavedWorkspace } from '../src/lib/storage';
import { baseline } from './fixtures';

// A tiny corpus: one passage obviously answers the dividend question, the others are
// plausible neighbours from the same kind of source.
const passages: Passage[] = [
  { id: 'src-a#0', sourceId: 'src-a', text: 'Your dividend statements should show the franked and unfranked dividend amounts and the franking credit for each holding. Keep your dividend statements for five years.' },
  { id: 'src-b#0', sourceId: 'src-b', text: 'Show the total interest credited to your bank accounts and term deposits during the income year. Your financial institution issues an annual interest summary.' },
  { id: 'src-c#0', sourceId: 'src-c', text: 'Write at item 8 label C the gross amount of current trade debtors from the company accounts at the end of the accounting period.' },
];

function index(overrides: Partial<GuidanceIndex> = {}): GuidanceIndex {
  return {
    builtAt: '2026-09-13T00:00:00.000Z', scoringMode: 'keyword', embeddingModel: null,
    chunkWords: 600, chunkOverlapWords: 80, sources: [], passages, ...overrides,
  };
}

describe('chunking', () => {
  it('keeps the source id and overlaps windows so a straddling sentence survives', () => {
    const body = Array.from({ length: 1400 }, (_, i) => `w${i}`).join(' ');
    const chunks = chunkText('src-a', body, 600, 80);
    expect(chunks.map(chunk => chunk.sourceId)).toEqual(['src-a', 'src-a', 'src-a']);
    expect(chunks.map(chunk => chunk.id)).toEqual(['src-a#0', 'src-a#1', 'src-a#2']);
    expect(chunks[0]!.text.split(' ')).toHaveLength(600);
    // Window two starts 520 words in, so the last 80 words of window one reappear.
    expect(chunks[1]!.text.startsWith('w520 w521')).toBe(true);
    expect(chunks[0]!.text.endsWith('w598 w599')).toBe(true);
  });
  it('returns nothing for empty text and refuses an overlap it cannot advance past', () => {
    expect(chunkText('src-a', '   ')).toEqual([]);
    expect(() => chunkText('src-a', 'a b c', 10, 10)).toThrow(/overlap/);
  });
});

describe('tokenising', () => {
  it('lowercases, drops stopwords and stems lightly', () => {
    expect(tokenise('Provide the dividend STATEMENTS showing components')).toEqual(['provide', 'dividend', 'statement', 'show', 'component']);
    expect(stem('statements')).toBe('statement');
    expect(stem('is')).toBe('is');
  });
});

describe('keyword scoring', () => {
  it('ranks the obviously relevant passage first', () => {
    const query = lineQuery({ category: 'dividends', label: 'Cash dividends', component: 'cash', requestText: 'Provide current-year dividend statements showing the dividend components.' });
    const scores = keywordScores(query, passages);
    expect(scores[0]).toBeGreaterThan(scores[1]!);
    expect(scores[0]).toBeGreaterThan(scores[2]!);
    expect(selectPassages(index(), query)[0]!.passage.id).toBe('src-a#0');
  });
  it('ranks a different line onto its own passage', () => {
    const query = lineQuery({ category: 'interest', label: 'Bank interest', component: 'gross', requestText: 'Provide the annual interest summary for each bank account.' });
    expect(selectPassages(index(), query)[0]!.passage.id).toBe('src-b#0');
  });
  it('scores zero when nothing overlaps', () => {
    expect(keywordScores('zzz qqq', passages)).toEqual([0, 0, 0]);
    expect(selectPassages(index(), 'zzz qqq')).toEqual([]);
  });
});

describe('embedding scoring', () => {
  const embedded = passages.map((passage, i) => ({ ...passage, embedding: [[1, 0, 0], [0, 1, 0], [0, 0, 1]][i]! }));

  it('computes cosine similarity and tolerates mismatched vectors', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
  });
  it('ranks the obviously relevant passage first', () => {
    const scores = embeddingScores([0.9, 0.1, 0], embedded);
    expect(scores[0]).toBeGreaterThan(scores[1]!);
    const top = selectPassages(index({ scoringMode: 'embedding', embeddingModel: 'test-embed', passages: embedded }), 'ignored in embedding mode', [0.9, 0.1, 0]);
    expect(top[0]!.passage.id).toBe('src-a#0');
  });
  it('falls back to keyword scoring when the index or the query has no vectors', () => {
    const query = lineQuery({ category: 'interest', label: 'Bank interest', component: 'gross', requestText: 'Provide the annual interest summary for each bank account.' });
    // Embedding mode declared, but the passages carry no vectors.
    expect(selectPassages(index({ scoringMode: 'embedding' }), query, [1, 0, 0])[0]!.passage.id).toBe('src-b#0');
    // Vectors present, but the query was not embedded.
    expect(selectPassages(index({ scoringMode: 'embedding', passages: embedded }), query, null)[0]!.passage.id).toBe('src-b#0');
  });
});

describe('index shape', () => {
  it('validates a built index and rejects an unknown scoring mode', () => {
    expect(() => guidanceIndexSchema.parse(index())).not.toThrow();
    expect(() => guidanceIndexSchema.parse({ ...index(), scoringMode: 'magic' })).toThrow();
  });
});

// ---------------------------------------------------------------------------------
// Proposal path: prompts, quote verification, adviser decision, and the corpus on disk.

const promptPassages: PromptPassage[] = [
  { id: 'src-a#0', sourceId: 'src-a', sourceTitle: 'Dividends 2026', sourceStatus: 'final_guidance', publishedDate: '2026-05-30', appliesToYears: [2026], synthetic: false, text: passages[0]!.text },
  { id: 'src-d#0', sourceId: 'src-d', sourceTitle: 'SYNTHETIC TEST FIXTURE - dividend evidence', sourceStatus: 'synthetic_fixture', publishedDate: null, appliesToYears: [2026], synthetic: true, text: 'Collect the cash dividend amount and the franking credit amount as separate figures.' },
];
const promptSources: GuidanceSource[] = [
  { id: 'src-a', title: 'Dividends 2026', url: 'https://example.invalid/dividends', retrievedAt: '2026-09-13T00:00:00.000Z', sha256: 'a'.repeat(64), publishedDate: '2026-05-30', appliesToYears: [2026], sourceStatus: 'final_guidance', synthetic: false },
  { id: 'src-d', title: 'SYNTHETIC TEST FIXTURE - dividend evidence', url: null, retrievedAt: '2026-09-13T00:00:00.000Z', sha256: 'd'.repeat(64), publishedDate: null, appliesToYears: [2026], sourceStatus: 'synthetic_fixture', synthetic: true },
];
const line = {
  lineId: 'ALE-DIV-CASH', entityType: 'individual' as const, category: 'dividends', label: 'Cash dividends',
  component: 'cash', basis: 'cash', currentText: 'Please provide current-year dividend statements.',
};
function item(overrides: Partial<GuidanceItem> = {}): GuidanceItem {
  return {
    proposedText: 'Provide dividend statements showing cash and franking amounts separately.',
    sourceId: 'src-a',
    quote: 'Your dividend statements should show the franked and unfranked dividend amounts',
    appliesToEntityTypes: ['individual'], appliesToYears: [2026],
    rationale: 'The current wording does not ask for the components separately.', ...overrides,
  };
}

describe('reply parsing', () => {
  it('parses fenced JSON and accepts an empty items array as a valid answer', () => {
    expect(parseReply('```json\n{"items":[]}\n```')).toEqual({ items: [], malformed: 0 });
    const one = parseReply(`Sure, here you go: ${JSON.stringify({ items: [item()] })}`);
    expect(one.items).toHaveLength(1);
    expect(one.malformed).toBe(0);
  });
  it('rejects a reply that is not JSON or not the expected shape', () => {
    expect(() => parseReply('Sure! I think the wording is fine.')).toThrow(/JSON/);
    expect(() => parseReply('{not json at all}')).toThrow(/valid JSON/);
    expect(() => parseReply('{"proposals":[]}')).toThrow();
  });
  it('drops an individual malformed item instead of discarding the whole reply', () => {
    // An over-long quote must not cost us the good item alongside it.
    const reply = parseReply(JSON.stringify({ items: [item({ quote: 'q'.repeat(501) }), item()] }));
    expect(reply.items).toHaveLength(1);
    expect(reply.malformed).toBe(1);
  });
});

describe('quote verification', () => {
  it('accepts a quote that appears verbatim in the cited source', () => {
    expect(verifyQuote(item(), promptPassages)).toBe(true);
  });
  it('rejects a fabricated quote, a paraphrase, and a source that was never supplied', () => {
    expect(verifyQuote(item({ quote: 'Dividend statements must be notarised by the registry.' }), promptPassages)).toBe(false);
    // Same meaning, different words: still not verbatim, so still rejected.
    expect(verifyQuote(item({ quote: 'Your dividend statements ought to show the franked amounts' }), promptPassages)).toBe(false);
    expect(verifyQuote(item({ sourceId: 'src-never-supplied' }), promptPassages)).toBe(false);
    // Right words, wrong source.
    expect(verifyQuote(item({ sourceId: 'src-d' }), promptPassages)).toBe(false);
  });
  it('ignores whitespace differences but not wording ones', () => {
    expect(verifyQuote(item({ quote: '  Your dividend   statements\nshould show the franked  ' }), promptPassages)).toBe(true);
    expect(verifyQuote(item({ quote: 'your dividend statements should show the franked' }), promptPassages)).toBe(false);
  });
  it('accepts a citation of a passage id belonging to the source, and canonicalises it', () => {
    expect(verifyQuote(item({ sourceId: 'src-a#0' }), promptPassages)).toBe(true);
    const { kept } = verifyItems([item({ sourceId: 'src-a#0' })], promptPassages);
    expect(kept[0]!.sourceId).toBe('src-a');
  });
  it('splits items into kept and dropped', () => {
    const { kept, dropped } = verifyItems([item(), item({ quote: 'invented' })], promptPassages);
    expect(kept).toHaveLength(1);
    expect(dropped).toHaveLength(1);
  });
});

describe('prompt construction', () => {
  it('states the demo, review and verbatim-quote rules, and never leaks a passage id', () => {
    const [system, user] = buildMessages(line, promptPassages);
    expect(system!.content).toMatch(/SYNTHETIC/);
    expect(system!.content).toMatch(/1 July 2025 to 30 June 2026/);
    expect(system!.content).toMatch(/only PROPOSE/);
    expect(system!.content).toMatch(/VERBATIM/);
    expect(system!.content).toMatch(/\{"items":\[\]\}/);
    expect(system!.content).toMatch(/not enacted law/);
    expect(system!.content).toMatch(/does not establish an FY2026 requirement/);
    // Passage ids are omitted so the model cannot cite one instead of its source id.
    expect(user!.content).not.toMatch(/src-a#0/);
    expect(user!.content).toMatch(/"sourceId": "src-a"/);
    expect(user!.content).toMatch(/synthetic_fixture/);
  });
});

describe('building a proposal', () => {
  it('fills provenance from the register and never trusts the model for it', () => {
    const [proposal] = buildProposals(line, [item({ sourceId: 'src-d', quote: 'Collect the cash dividend amount' })], promptSources, 'test-model', '2026-09-13T00:00:00.000Z');
    expect(proposal!.sourceStatus).toBe('synthetic_fixture');
    expect(proposal!.sourceHash).toBe('d'.repeat(64));
    expect(proposal!.currentText).toBe(line.currentText);
    expect(proposal!.review).toEqual({ status: 'pending', reviewer: '', decidedAt: '' });
    expect(() => guidanceProposalSchema.parse(proposal)).not.toThrow();
  });
  it('drops an item whose source is not in the register', () => {
    expect(buildProposals(line, [item({ sourceId: 'unregistered' })], promptSources, 'test-model')).toEqual([]);
  });
});

describe('adviser decision', () => {
  const proposal = buildProposals(line, [item()], promptSources, 'test-model', '2026-09-13T00:00:00.000Z')[0]!;
  function seeded() {
    const started = workflow.startSeason(workflow.importBaseline(workflow.createWorkspace(), baseline), 'alex-taylor');
    return addGuidanceProposals(started, [proposal], 'test');
  }

  it('updates only the targeted baseline line and stamps demo-method-2', () => {
    const next = applyGuidanceProposal(seeded(), proposal, 'JY');
    const lines = next.baselines[0]!.lines;
    expect(lines.find(entry => entry.id === 'ALE-DIV-CASH')!.requestText).toBe(proposal.proposedText);
    expect(lines.find(entry => entry.id === 'ALE-DIV-CASH')!.methodVersion).toBe(GUIDANCE_METHOD_VERSION);
    expect(lines.filter(entry => entry.methodVersion !== undefined)).toHaveLength(1);
  });

  it('leaves existing requests and drafts untouched', () => {
    const before = seeded();
    const after = applyGuidanceProposal(before, proposal, 'JY');
    expect(after.requests).toEqual(before.requests);
    expect(after.requests.every(request => request.methodVersion === workflow.METHOD_VERSION)).toBe(true);
    expect(after.outbox).toEqual(before.outbox);
  });

  it('writes an audit event naming the model, prompt, source and hash', () => {
    const after = applyGuidanceProposal(seeded(), proposal, 'JY');
    const event = after.audit.at(-1)!;
    expect(event.action).toBe('guidance_proposal_accepted');
    expect(event.detail).toContain('ALE-DIV-CASH');
    expect(event.detail).toContain('test-model');
    expect(event.detail).toContain('guidance-1');
    expect(event.detail).toContain('src-a');
    expect(event.detail).toContain('a'.repeat(64));
    expect(after.guidance![0]!.review).toMatchObject({ status: 'accepted', reviewer: 'JY' });
  });

  it('rejecting changes no wording but is still recorded', () => {
    const before = seeded();
    const after = rejectGuidanceProposal(before, proposal, 'JY');
    expect(after.baselines).toEqual(before.baselines);
    expect(after.audit.at(-1)!.action).toBe('guidance_proposal_rejected');
    expect(after.guidance![0]!.review.status).toBe('rejected');
  });

  it('refuses a second decision, a mismatched entity type and an unknown line', () => {
    const decided = applyGuidanceProposal(seeded(), proposal, 'JY');
    expect(() => applyGuidanceProposal(decided, decided.guidance![0]!, 'JY')).toThrow(/already been reviewed/);
    expect(() => applyGuidanceProposal(seeded(), { ...proposal, appliesToEntityTypes: ['company'] }, '')).toThrow(/entity types/);
    expect(() => applyGuidanceProposal(seeded(), { ...proposal, lineId: 'NOT-A-LINE' }, '')).toThrow(/not in this workspace/);
  });

  it('survives a save and reload through the stored workspace schema', () => {
    const after = applyGuidanceProposal(seeded(), proposal, 'JY');
    const reloaded = parseSavedWorkspace(JSON.stringify(after));
    expect(reloaded.baselines[0]!.lines[0]!.methodVersion).toBe(GUIDANCE_METHOD_VERSION);
    expect(reloaded.guidance).toHaveLength(1);
    // A workspace saved before the guidance track existed still loads.
    const { guidance, ...legacy } = after;
    expect(guidance).toBeDefined();
    expect(parseSavedWorkspace(JSON.stringify(legacy)).guidance).toBeUndefined();
  });
});

describe('the committed corpus', () => {
  const register = readFileSync('guidance/sources/register.md', 'utf8');
  const sidecars = readdirSync('guidance/sources')
    .filter(name => name.endsWith('.json'))
    .map(name => JSON.parse(readFileSync(`guidance/sources/${name}`, 'utf8')));

  it('lists every source in the register, and every listed file exists', () => {
    expect(sidecars.length).toBeGreaterThanOrEqual(7);
    for (const sidecar of sidecars) {
      expect(register).toContain(sidecar.id);
      if (sidecar.fetchError) continue;
      expect(readFileSync(`guidance/sources/${sidecar.id}.txt`, 'utf8').length).toBeGreaterThan(0);
    }
  });

  it('labels the one synthetic fixture everywhere it appears', () => {
    const synthetic = sidecars.filter(sidecar => sidecar.synthetic);
    expect(synthetic).toHaveLength(1);
    const fixture = synthetic[0];
    expect(fixture.sourceStatus).toBe('synthetic_fixture');
    expect(fixture.id).toMatch(/^SYNTHETIC-/);
    expect(fixture.title).toMatch(/SYNTHETIC TEST FIXTURE/);
    expect(readFileSync(`guidance/sources/${fixture.id}.txt`, 'utf8').split('\n')[0]).toMatch(/^SYNTHETIC TEST FIXTURE/);
    // Real sources must never be marked synthetic, and each is a fetched ATO page.
    for (const sidecar of sidecars.filter(entry => !entry.synthetic)) {
      expect(sidecar.sourceStatus).not.toBe('synthetic_fixture');
      expect(sidecar.url).toMatch(/^https:\/\/www\.ato\.gov\.au\//);
    }
  });

  it('never invents a publication date', () => {
    for (const sidecar of sidecars) {
      expect(sidecar.publishedDate === null || /^\d{4}-\d{2}-\d{2}/.test(sidecar.publishedDate)).toBe(true);
    }
  });

  it('holds only proposals whose quote is verbatim in the source it cites', () => {
    const normalise = (value: string) => value.replace(/\s+/g, ' ').trim();
    const files = readdirSync('guidance/proposals').filter(name => name.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      for (const proposal of guidanceProposalSchema.array().parse(JSON.parse(readFileSync(`guidance/proposals/${file}`, 'utf8')))) {
        const sidecar = sidecars.find(entry => entry.id === proposal.sourceId);
        expect(sidecar, `${file} cites unknown source ${proposal.sourceId}`).toBeDefined();
        expect(proposal.sourceHash).toBe(sidecar.sha256);
        expect(proposal.sourceStatus).toBe(sidecar.sourceStatus);
        expect(proposal.review.status).toBe('pending');
        const body = readFileSync(`guidance/sources/${proposal.sourceId}.txt`, 'utf8');
        expect(normalise(body).includes(normalise(proposal.quote)), `${file} quote not found in ${proposal.sourceId}`).toBe(true);
      }
    }
  });
});

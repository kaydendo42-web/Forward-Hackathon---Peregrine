#!/usr/bin/env node
// Fetch official guidance pages into guidance/sources/ as plain text plus a JSON
// sidecar, then rebuild guidance/sources/register.md from every sidecar found.
//
// Synthetic demo tooling. Fetched pages are public ATO instruction pages; nothing
// here interprets them or decides a tax position. A page that cannot be fetched is
// recorded as such in the register, never replaced with invented content.
//
//   node tools/guidance/fetch-sources.mjs               # fetch every source
//   node tools/guidance/fetch-sources.mjs --only <id>   # fetch one
//   node tools/guidance/fetch-sources.mjs --register-only

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const sourcesDir = path.join(repoRoot, 'guidance', 'sources');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

// Official pages chosen for the 18 FY25 baseline lines. `covers` is documentation
// only; retrieval scores passages and never reads this field.
const SOURCES = [
  {
    id: 'ato-itr-2026-salary-wages',
    url: 'https://www.ato.gov.au/forms-and-instructions/individual-tax-return-2026-instructions/income-questions-1-12-individual-tax-return-2026/1-salary-or-wages-2026',
    appliesToYears: [2026],
    sourceStatus: 'final_guidance',
    covers: ['ALE-EMP', 'SAM-EMP'],
  },
  {
    id: 'ato-itr-2026-gross-interest',
    url: 'https://www.ato.gov.au/forms-and-instructions/individual-tax-return-2026-instructions/income-questions-1-12-individual-tax-return-2026/10-gross-interest-2026',
    appliesToYears: [2026],
    sourceStatus: 'final_guidance',
    covers: ['ALE-INT', 'SAM-INT'],
  },
  {
    id: 'ato-itr-2026-dividends',
    url: 'https://www.ato.gov.au/forms-and-instructions/individual-tax-return-2026-instructions/income-questions-1-12-individual-tax-return-2026/11-dividends-2026',
    appliesToYears: [2026],
    sourceStatus: 'final_guidance',
    covers: ['ALE-DIV-CASH', 'ALE-DIV-CREDIT'],
  },
  {
    id: 'ato-itr-2026-partnerships-trusts',
    url: 'https://www.ato.gov.au/forms-and-instructions/individual-supplementary-tax-return-2026-instructions/income-questions-13-24-supplementary-tax-return-2026/13-partnerships-and-trusts-2026',
    appliesToYears: [2026],
    sourceStatus: 'final_guidance',
    covers: ['ALE-TRUST', 'SAM-TRUST'],
  },
  {
    id: 'ato-trust-income-schedule-2026',
    url: 'https://www.ato.gov.au/forms-and-instructions/trust-income-schedule-2026-instructions/instructions-to-complete-the-trust-income-schedule-2026',
    appliesToYears: [2026],
    sourceStatus: 'final_guidance',
    covers: ['ALE-TRUST', 'SAM-TRUST'],
  },
  {
    // The company return's balance-sheet labels (total assets, trade debtors and
    // creditors, loans to shareholders) sit under item 8, not on the index pages.
    id: 'ato-company-return-2026',
    url: 'https://www.ato.gov.au/forms-and-instructions/company-tax-return-2026-instructions/instructions-to-complete-the-company-tax-return-2026/items-6-to-14/8-financial-and-other-information',
    appliesToYears: [2026],
    sourceStatus: 'final_guidance',
    covers: ['CO-BANK', 'CO-AR', 'CO-AP', 'CO-ASSET', 'CO-LOAN'],
  },
  {
    // Item 58 is the statement of distribution to beneficiaries.
    id: 'ato-trust-return-2026',
    url: 'https://www.ato.gov.au/forms-and-instructions/trust-tax-return-2026-instructions/instructions-to-complete-the-trust-tax-return-2026/instructions-for-trust-items-33-to-61-and-the-declaration/statement-of-distribution-item-58',
    appliesToYears: [2026],
    sourceStatus: 'final_guidance',
    covers: ['TR-BANK', 'TR-INVEST', 'TR-DIST-ALE', 'TR-DIST-SAM', 'TR-DOC'],
  },
  {
    id: 'ato-trustees-tax-time-2026',
    url: 'https://www.ato.gov.au/businesses-and-organisations/business-bulletins-newsroom/what-trustees-need-to-know-for-tax-time-2026',
    appliesToYears: [2026],
    sourceStatus: 'final_guidance',
    covers: ['TR-DOC', 'TR-DIST-ALE', 'TR-DIST-SAM'],
  },
  {
    id: 'ato-records-business',
    url: 'https://www.ato.gov.au/businesses-and-organisations/preparing-lodging-and-paying/record-keeping-for-business/overview-of-record-keeping-rules-for-business',
    appliesToYears: [2026],
    sourceStatus: 'final_guidance',
    covers: ['CO-BANK', 'CO-AR', 'CO-AP', 'CO-ASSET', 'CO-LOAN', 'TR-BANK', 'TR-INVEST'],
  },
  {
    id: 'ato-records-individuals',
    url: 'https://www.ato.gov.au/individuals-and-families/income-deductions-offsets-and-records/records-you-need-to-keep',
    appliesToYears: [2026],
    sourceStatus: 'final_guidance',
    covers: ['ALE-EMP', 'ALE-INT', 'ALE-DIV-CASH', 'ALE-DIV-CREDIT', 'SAM-EMP', 'SAM-INT'],
  },
];

const ENTITIES = new Map([
  ['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"],
  ['nbsp', ' '], ['ndash', '-'], ['mdash', '-'], ['hellip', '...'],
  ['lsquo', "'"], ['rsquo', "'"], ['ldquo', '"'], ['rdquo', '"'],
]);

function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, name) => {
    if (ENTITIES.has(name)) return ENTITIES.get(name);
    if (name.startsWith('#x') || name.startsWith('#X')) {
      const code = Number.parseInt(name.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (name.startsWith('#')) {
      const code = Number.parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return whole;
  });
}

// Deliberately small: enough to turn an ATO instruction page into readable
// paragraphs. Not a general HTML parser.
export function htmlToText(html) {
  let working = html;
  working = working.replace(/<!--[\s\S]*?-->/g, ' ');
  working = working.replace(/<(script|style|noscript|svg|head|nav|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');

  const main = working.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  if (main) working = main[1];

  working = working.replace(/<li\b[^>]*>/gi, '\n- ');
  working = working.replace(/<br\s*\/?>/gi, '\n');
  working = working.replace(/<\/(p|div|li|tr|h1|h2|h3|h4|h5|h6|section|article|table|ul|ol|dt|dd)>/gi, '\n');
  working = working.replace(/<\/t[dh]>/gi, ' | ');
  working = working.replace(/<[^>]+>/g, ' ');

  working = decodeEntities(working);
  working = working.replace(/\r\n?/g, '\n');
  working = working
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').replace(/\s*\|\s*$/, '').trim())
    .join('\n');
  working = working.replace(/\n{3,}/g, '\n\n');
  return working.trim();
}

// ATO pages put the site header (search box, log-in prompts, menu) inside <main>.
// The page title reappears as its own line where the article starts, so cut to
// there. If the title is not found as a line, keep everything rather than guess.
export function trimChrome(text, title) {
  if (!title) return text;
  const heading = title.replace(/\s*\|\s*Australian Taxation Office\s*$/i, '').trim();
  if (!heading) return text;
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim().toLowerCase() === heading.toLowerCase());
  return start > 0 ? lines.slice(start).join('\n').trim() : text;
}

function metaContent(html, name) {
  const direct = html.match(
    new RegExp(`<meta[^>]*name=["']${name}["'][^>]*content=["']([^"']*)["']`, 'i'),
  );
  if (direct) return decodeEntities(direct[1]);
  const reversed = html.match(
    new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*name=["']${name}["']`, 'i'),
  );
  return reversed ? decodeEntities(reversed[1]) : null;
}

// ATO pages carry `dcterms.modified` as `scheme=dcterms.ISO8601; <iso>`. Anything
// we cannot read as a date stays null — the register never guesses a date.
export function readPublishedDate(html) {
  for (const name of ['dcterms.modified', 'dcterms.created', 'dcterms.date']) {
    const raw = metaContent(html, name);
    if (!raw) continue;
    const iso = raw.match(/(\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?)/);
    if (iso) return iso[1];
  }
  return null;
}

export function readTitle(html) {
  const dc = metaContent(html, 'dcterms.title');
  if (dc) return dc.trim();
  const tag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return tag ? decodeEntities(tag[1]).trim() : null;
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

async function fetchSource(source) {
  const retrievedAt = new Date().toISOString();
  let response;
  try {
    response = await fetch(source.url, {
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    return { ...source, retrievedAt, fetchError: `request failed: ${error.message}` };
  }

  if (!response.ok) {
    return { ...source, retrievedAt, httpStatus: response.status, fetchError: `HTTP ${response.status}` };
  }

  const html = await response.text();
  const title = readTitle(html) ?? source.id;
  const text = trimChrome(htmlToText(html), title);
  if (text.length < 500) {
    return {
      ...source,
      retrievedAt,
      httpStatus: response.status,
      fetchError: `extracted only ${text.length} characters; not saved`,
    };
  }

  return {
    id: source.id,
    title,
    url: response.url || source.url,
    retrievedAt,
    sha256: sha256(text),
    publishedDate: readPublishedDate(html),
    appliesToYears: source.appliesToYears,
    sourceStatus: source.sourceStatus,
    synthetic: false,
    covers: source.covers,
    httpStatus: response.status,
    characters: text.length,
    text,
  };
}

async function writeSource(record) {
  const { text, ...sidecar } = record;
  if (text) {
    await writeFile(path.join(sourcesDir, `${record.id}.txt`), `${text}\n`, 'utf8');
  }
  await writeFile(
    path.join(sourcesDir, `${record.id}.json`),
    `${JSON.stringify(sidecar, null, 2)}\n`,
    'utf8',
  );
}

function escapeCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export async function buildRegister() {
  const files = (await readdir(sourcesDir)).filter((name) => name.endsWith('.json')).sort();
  const rows = [];
  for (const file of files) {
    rows.push(JSON.parse(await readFile(path.join(sourcesDir, file), 'utf8')));
  }

  const lines = [
    '# Guidance source register',
    '',
    'Generated by `tools/guidance/fetch-sources.mjs`. Do not edit by hand.',
    '',
    'Every row is a file in this folder. `sha256` is of the saved `.txt` content, so a re-fetch',
    'that changes the hash means the page changed. `publishedDate` is the date the page itself',
    'states (ATO `dcterms.modified`); `null` means the page stated none and none was guessed.',
    '`appliesToYears` is the financial year the guidance applies to, which is not the same thing',
    'as when it was published.',
    '',
    'Rows marked `synthetic: **yes**` are **synthetic test fixtures authored for this demo**.',
    'They are not ATO material and state no real rule.',
    '',
    '| id | title | url | retrievedAt | sha256 | publishedDate | appliesToYears | sourceStatus | synthetic | status |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ];

  for (const row of rows) {
    lines.push(
      `| \`${escapeCell(row.id)}\` | ${escapeCell(row.title)} | ${row.url ? `<${escapeCell(row.url)}>` : '—'} `
      + `| ${escapeCell(row.retrievedAt)} | \`${escapeCell(row.sha256 ?? '—')}\` `
      + `| ${row.publishedDate ? escapeCell(row.publishedDate) : '`null`'} `
      + `| ${escapeCell((row.appliesToYears ?? []).join(', '))} | ${escapeCell(row.sourceStatus)} `
      + `| ${row.synthetic ? '**yes**' : 'no'} `
      + `| ${row.fetchError ? `NOT SAVED — ${escapeCell(row.fetchError)}` : 'saved'} |`,
    );
  }

  const saved = rows.filter((row) => !row.fetchError).length;
  lines.push(
    '',
    `${saved} of ${rows.length} listed sources have saved text.`,
    '',
    '## Line coverage',
    '',
    'Which baseline lines each source was chosen for. Documentation only — retrieval scores',
    'passages and ignores this table.',
    '',
    '| id | covers |',
    '|---|---|',
  );
  for (const row of rows) {
    lines.push(`| \`${escapeCell(row.id)}\` | ${escapeCell((row.covers ?? []).join(', ')) || '—'} |`);
  }

  await writeFile(path.join(sourcesDir, 'register.md'), `${lines.join('\n')}\n`, 'utf8');
  return { total: rows.length, saved };
}

async function main() {
  const args = process.argv.slice(2);
  const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
  await mkdir(sourcesDir, { recursive: true });

  if (!args.includes('--register-only')) {
    const wanted = only ? SOURCES.filter((source) => source.id === only) : SOURCES;
    if (wanted.length === 0) throw new Error(`no source with id ${only}`);

    for (const source of wanted) {
      const record = await fetchSource(source);
      await writeSource(record);
      if (record.fetchError) {
        console.log(`x ${record.id} - ${record.fetchError}`);
      } else {
        console.log(
          `ok ${record.id} - ${record.characters} chars - modified ${record.publishedDate ?? 'not stated'} - ${record.sha256.slice(0, 12)}`,
        );
      }
    }
  }

  const { total, saved } = await buildRegister();
  console.log(`register.md rebuilt: ${saved}/${total} sources with saved text`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

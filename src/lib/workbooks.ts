import ExcelJS from 'exceljs';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { Baseline, CollectionRequest, EntityType, EvidenceInput, ReviewChange, Workspace } from '../core/types';
import { reconcile } from '../core/workflow';
import { parseMoney } from './evidence';

const LINE_COLUMNS = ['line_id', 'entity_id', 'financial_year', 'category', 'label', 'component', 'amount', 'currency', 'basis', 'source_ref', 'recurrence', 'request_text'];
const REVIEW_COLUMNS = ['request_id', 'line_id', 'label', 'comparison_aud', 'evidence_aud', 'difference_aud', 'decision', 'review_note'];
type Bytes = ArrayBuffer | Uint8Array;
type Scalar = string | number | boolean | null;

async function load(bytes: Bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (data.byteLength > 25_000_000) throw new Error('Workbook exceeds the 25 MB demo limit.');
  let total = 0; let count = 0;
  const archive = unzipSync(data, { filter(file) {
    total += file.originalSize; count++;
    if (total > 60_000_000 || count > 400) throw new Error('Workbook expands beyond the demo safety limit.');
    if (/vbaProject|externalLinks|embeddings/i.test(file.name)) throw new Error('Macros, embedded objects and external links are not supported.');
    return true;
  } });
  let converted = false;
  for (const name of Object.keys(archive)) {
    if (/^xl\/worksheets\/_rels\/.*\.rels$/.test(name)) {
      const original = strFromU8(archive[name]);
      const relative = original.replace(/Target="\/xl\/tables\/(table\d+\.xml)"/g, 'Target="../tables/$1"');
      if (relative !== original) { archive[name] = strToU8(relative); converted = true; }
    }
    if (!name.endsWith('.xml')) continue;
    let xml = strFromU8(archive[name]);
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('XML entities are not supported.');
    // ExcelJS is not namespace-aware. Normalise an OOXML namespace alias in
    // memory only; the original uploaded workbook remains unchanged.
    const ns = /xmlns:([A-Za-z_][\w.-]*)="http:\/\/schemas.openxmlformats.org\/spreadsheetml\/2006\/main"/.exec(xml);
    if (ns) {
      const prefix = ns[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      xml = xml.replace(ns[0], 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"')
        .replace(new RegExp(`(<\\/?)${prefix}:`, 'g'), '$1');
      archive[name] = strToU8(xml); converted = true;
    }
  }
  const book = new ExcelJS.Workbook();
  await book.xlsx.load((converted ? zipSync(archive) : data) as unknown as ExcelJS.Buffer);
  return book;
}

function scalar(cell: ExcelJS.Cell): Scalar {
  const value = cell.value;
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return value;
  if ('formula' in value || 'sharedFormula' in value) throw new Error(`Formula in imported data at ${cell.address}; use explicit values.`);
  throw new Error(`Unsupported cell value at ${cell.address}; use plain text or numbers.`);
}

function namedTable(book: ExcelJS.Workbook, name: string): Scalar[][] {
  const found: { sheet: ExcelJS.Worksheet; range: string }[] = [];
  for (const sheet of book.worksheets) {
    const table = sheet.getTable(name) as (ExcelJS.Table & { model?: { tableRef?: string } }) | undefined;
    if (table?.model?.tableRef) found.push({ sheet, range: table.model.tableRef });
  }
  if (found.length !== 1) throw new Error(`Expected exactly one named table ${name}.`);
  const { sheet, range } = found[0];
  const [from, to] = range.split(':'); const start = sheet.getCell(from); const end = sheet.getCell(to ?? from);
  const firstRow = Number(start.row), lastRow = Number(end.row), firstCol = Number(start.col), lastCol = Number(end.col);
  if (lastRow - firstRow > 200 || lastCol - firstCol > 20 || lastRow > 2000 || lastCol > 100) throw new Error('Table exceeds the demo row or column limit.');
  return Array.from({ length: lastRow - firstRow + 1 }, (_, r) =>
    Array.from({ length: lastCol - firstCol + 1 }, (_, c) => scalar(sheet.getCell(firstRow + r, firstCol + c))));
}

function metadata(book: ExcelJS.Workbook, tableName: string) {
  const rows = namedTable(book, tableName);
  if (JSON.stringify(rows[0]) !== JSON.stringify(['key', 'value'])) throw new Error('Metadata columns must be key,value.');
  const result: Record<string, Scalar> = Object.create(null);
  for (const row of rows.slice(1)) {
    const key = required(row[0], 'metadata key');
    if (key in result) throw new Error(`Duplicate metadata key: ${key}.`);
    result[key] = row[1];
  }
  return result;
}

function required(value: Scalar, name: string) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4000) throw new Error(`${name} must contain plain text.`);
  return value.trim();
}

export async function readBaseline(bytes: Bytes): Promise<Baseline> {
  const book = await load(bytes); const meta = metadata(book, 'Peregrine_Metadata');
  if (String(meta.schema_version) !== '1' || String(meta.template_version) !== '1') throw new Error('Unsupported workbook schema or template version.');
  if (String(meta.synthetic) !== 'true' || Number(meta.financial_year) !== 2025) throw new Error('Use the synthetic FY25 workbook templates. Real client data is not supported.');
  const entityType = required(meta.entity_type, 'Entity type');
  if (!['individual', 'company', 'trust'].includes(entityType)) throw new Error('Unsupported entity type.');
  const entityId = required(meta.entity_id, 'Entity ID');
  if (!/^[a-z0-9-]{1,80}$/.test(entityId)) throw new Error('Invalid entity ID.');
  if (!Number.isSafeInteger(Number(meta.baseline_version)) || Number(meta.baseline_version) < 1) throw new Error('Invalid baseline version.');
  const rows = namedTable(book, 'Peregrine_Lines');
  if (JSON.stringify(rows[0]) !== JSON.stringify(LINE_COLUMNS)) throw new Error('Workbook Data columns do not match schema version 1.');
  if (rows.length < 2) throw new Error('Workbook has no workpaper lines.');
  const lines = rows.slice(1).map(row => {
    const [id, owner, year, category, label, component, amount, currency, basis, source, recurrence, question] = row;
    if (owner !== entityId || Number(year) !== 2025) throw new Error('Data row entity or financial year mismatch.');
    if (recurrence !== 'annual') throw new Error('Unsupported recurrence.');
    if (amount !== null && typeof amount !== 'number') throw new Error('Amounts must be numeric cells or blank.');
    if (currency !== 'AUD') throw new Error('This prototype supports AUD only.');
    return { id: required(id, 'Line ID'), category: required(category, 'Category'), label: required(label, 'Label'),
      component: required(component, 'Component'), amountCents: parseMoney(amount), currency,
      basis: required(basis, 'Basis'), sourceRef: required(source, 'Source reference'), recurrence: 'annual' as const,
      requestText: required(question, 'Request text') };
  });
  if (new Set(lines.map(l => l.id)).size !== lines.length) throw new Error('Duplicate workpaper line ID.');
  return { workbookId: required(meta.workbook_id, 'Workbook ID'), entityId, entityName: required(meta.entity_name, 'Entity name'),
    entityType: entityType as EntityType, financialYear: 2025, baselineVersion: Number(meta.baseline_version), synthetic: true, lines };
}

function sourceColumns(req: CollectionRequest): Scalar[] {
  const { evidenceCents, differenceCents } = reconcile(req);
  return [req.id, req.lineId, req.label, req.comparisonCents === null ? null : req.comparisonCents / 100,
    evidenceCents === null ? null : evidenceCents / 100, differenceCents === null ? null : differenceCents / 100];
}

/** Loads original file bytes by SHA-256 (the browser reads IndexedDB); null when unavailable. */
export type OriginalLoader = (fileHash: string) => Promise<ArrayBuffer | null>;

function evidenceSource(e: EvidenceInput) {
  if (e.documentId.startsWith('intake-')) return 'Reply attachment (model-read, adviser-accepted)';
  if (e.filename === 'pasted-text') return 'Pasted text (AI extract, adviser-accepted)';
  return 'CSV upload';
}
function imageExtension(bytes: Uint8Array): 'jpeg' | 'png' | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  return null;
}

/**
 * FY26 review workbook: Review table for adviser decisions (the only sheet re-imported),
 * an Evidence sheet listing every linked document with its source, and an Attachments
 * sheet that embeds accepted photos when the caller can supply the original bytes.
 */
export async function exportReview(state: Workspace, entityId: string, loadOriginal?: OriginalLoader): Promise<ArrayBuffer> {
  const requests = state.requests.filter(r => r.entityId === entityId);
  if (!requests.length) throw new Error('Start the collection season before exporting review.');
  const book = new ExcelJS.Workbook(); book.creator = 'Peregrine synthetic demonstration';
  const meta = book.addWorksheet('Metadata');
  meta.addTable({ name: 'Peregrine_Review_Metadata', ref: 'A1', headerRow: true,
    columns: [{ name: 'key' }, { name: 'value' }], rows: [
      ['schema_version', '1'], ['entity_id', entityId], ['financial_year', 2026], ['base_version', state.version], ['synthetic', 'true'],
    ] });
  meta.getColumn(1).width = 26; meta.getColumn(2).width = 50;
  meta.getCell('A9').value = 'SYNTHETIC DEMO. Workbook text is not authenticated approval.';
  const sheet = book.addWorksheet('Review');
  sheet.getCell('A1').value = `FY26 review — ${entityId}`;
  sheet.getCell('A2').value = 'Edit decision and review_note only. Return to Peregrine to preview and confirm.';
  sheet.getCell('A3').value = 'Use accepted, not_applicable, or follow_up. Prior-year amounts are not current evidence.';
  sheet.addTable({ name: 'Peregrine_Review', ref: 'A5', headerRow: true,
    columns: REVIEW_COLUMNS.map(name => ({ name })), rows: requests.map(r => [...sourceColumns(r), r.review, r.reviewNote]),
    style: { theme: 'TableStyleMedium2', showRowStripes: true } });
  [42, 22, 34, 20, 20, 20, 22, 60].forEach((width, i) => { sheet.getColumn(i + 1).width = width; });
  for (let row = 6; row < 6 + requests.length; row++) {
    sheet.getRow(row).height = 42;
    for (let c = 1; c <= 8; c++) sheet.getCell(row, c).alignment = { vertical: 'middle', wrapText: true };
    for (const c of [4, 5, 6]) sheet.getCell(row, c).numFmt = '#,##0.00;[Red](#,##0.00)';
    sheet.getCell(row, 7).dataValidation = { type: 'list', allowBlank: false, formulae: ['"pending,accepted,not_applicable,follow_up"'] };
    for (const c of [7, 8]) sheet.getCell(row, c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };
  }
  sheet.views = [{ state: 'frozen', ySplit: 5, xSplit: 2 }];
  const sources = book.addWorksheet('Evidence');
  sources.addRow(['Request ID', 'Line', 'Document ID', 'File', 'Source', 'Component', 'Amount AUD', 'SHA-256', 'Description', 'Adviser decision']);
  sources.getRow(1).font = { bold: true };
  requests.forEach(r => r.evidence.forEach(e => sources.addRow([r.id, r.lineId, e.documentId, e.filename, evidenceSource(e), e.component, e.amountCents === null ? null : e.amountCents / 100, e.fileHash, e.description, r.review])));
  sources.columns.forEach(c => { c.width = 30; });
  sources.views = [{ state: 'frozen', ySplit: 1 }];

  const attachments = book.addWorksheet('Attachments');
  attachments.getColumn(1).width = 110;
  attachments.getCell('A1').value = `Attachments — accepted documents for ${entityId}, FY2026`;
  attachments.getCell('A1').font = { bold: true, size: 13 };
  attachments.getCell('A2').value = 'Each photo below was linked to its request line by an adviser. Figures were checked against the image before acceptance. Originals stay hashed in the adviser\'s browser; PDFs and CSVs are listed, not embedded.';
  let row = 3;
  const ROWS_PER_IMAGE = 28;
  for (const r of requests) {
    for (const e of r.evidence) {
      const bytes = loadOriginal ? await loadOriginal(e.fileHash) : null;
      const data = bytes ? new Uint8Array(bytes) : null;
      const extension = data ? imageExtension(data) : null;
      const caption = `${r.lineId} · ${r.label} · ${e.documentId} · ${e.filename} · ${e.amountCents === null ? 'no amount' : `AUD ${(e.amountCents / 100).toFixed(2)}`} · sha256 ${e.fileHash.slice(0, 16)}… · decision: ${r.review}`;
      attachments.getCell(row, 1).value = extension ? caption : `${caption} · ${bytes ? 'not an image — listed only' : 'not embedded (original stays in the browser)'}`;
      attachments.getCell(row, 1).font = { bold: true };
      attachments.getCell(row, 1).alignment = { wrapText: true };
      if (extension && data) {
        const imageId = book.addImage({ buffer: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer, extension });
        attachments.addImage(imageId, { tl: { col: 0, row }, ext: { width: 720, height: 520 }, editAs: 'oneCell' });
        row += ROWS_PER_IMAGE;
      } else {
        row += 2;
      }
    }
  }
  const buffer = await book.xlsx.writeBuffer();
  return new Uint8Array(buffer).buffer as ArrayBuffer;
}

export async function previewReview(bytes: Bytes, state: Workspace, entityId: string): Promise<ReviewChange[]> {
  const book = await load(bytes); const meta = metadata(book, 'Peregrine_Review_Metadata');
  if (meta.entity_id !== entityId) throw new Error('Review workbook entity mismatch.');
  if (String(meta.schema_version) !== '1' || Number(meta.financial_year) !== 2026 || String(meta.synthetic) !== 'true') throw new Error('Invalid review workbook metadata.');
  if (Number(meta.base_version) !== state.version) throw new Error('Stale workbook. Export the latest review workbook; newer evidence or decisions must not be overwritten.');
  const rows = namedTable(book, 'Peregrine_Review');
  if (JSON.stringify(rows[0]) !== JSON.stringify(REVIEW_COLUMNS)) throw new Error('Review columns changed.');
  const expected = state.requests.filter(r => r.entityId === entityId);
  if (rows.length - 1 !== expected.length) throw new Error('Review rows were added or deleted; import is not safe.');
  const seen = new Set<string>(); const changes: ReviewChange[] = [];
  for (const row of rows.slice(1)) {
    const id = required(row[0], 'Request ID'); const req = expected.find(r => r.id === id);
    if (!req || seen.has(id)) throw new Error('Unknown or duplicate review row.');
    seen.add(id);
    if (JSON.stringify(row.slice(0, 6)) !== JSON.stringify(sourceColumns(req))) throw new Error(`Source values changed for ${req.label}. Edit only decision and review_note.`);
    const decision = required(row[6], 'Decision'); const note = row[7] === null || row[7] === '' ? '' : required(row[7], 'Review note');
    if (decision === req.review && note === req.reviewNote) continue;
    if (!['accepted', 'not_applicable', 'follow_up'].includes(decision)) throw new Error('Use accepted, not_applicable, or follow_up for a changed decision.');
    if (!note.trim()) throw new Error('Every changed decision requires a review note.');
    changes.push({ requestId: id, decision: decision as ReviewChange['decision'], note });
  }
  return changes;
}

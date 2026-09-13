import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import * as files from '../src/lib/workbooks';
import * as evidenceFiles from '../src/lib/evidence';
import * as workflow from '../src/core/workflow';
import { baseline, evidence } from './fixtures';
import { readFile } from 'node:fs/promises';

async function makeBaseline(formula = false) {
  const book = new ExcelJS.Workbook();
  const meta = book.addWorksheet('Renamed profile');
  meta.addTable({ name: 'Peregrine_Metadata', ref: 'B3', headerRow: true,
    columns: [{ name: 'key' }, { name: 'value' }], rows: [
      ['schema_version', '1'], ['workbook_id', 'FY25-alex-taylor'], ['entity_id', 'alex-taylor'],
      ['entity_name', 'Alex Taylor'], ['entity_type', 'individual'], ['financial_year', 2025],
      ['synthetic', 'true'], ['template_version', '1'], ['baseline_version', 1], ['status', 'synthetic_reviewed'],
    ] });
  book.addWorksheet('Renamed data').addTable({ name: 'Peregrine_Lines', ref: 'C4', headerRow: true,
    columns: ['line_id', 'entity_id', 'financial_year', 'category', 'label', 'component', 'amount', 'currency', 'basis', 'source_ref', 'recurrence', 'request_text'].map(name => ({ name })),
    rows: [['ALE-DIV-CASH', 'alex-taylor', 2025, 'dividends', 'Cash dividends', 'cash', formula ? { formula: '1+1', result: 4800 } : 4800, 'AUD', 'cash', 'FY25-DIV', 'annual', 'Provide statements.']] });
  return book.xlsx.writeBuffer();
}

describe('baseline import', () => {
  it('imports the supplied standards-compliant namespace-prefixed workbook', async () => {
    const bytes = await readFile('outputs/fy25-baseline/alex-taylor-FY25.xlsx');
    const pack = await files.readBaseline(bytes);
    expect(pack.lines).toHaveLength(5);
    expect(pack.lines.find(l => l.id === 'ALE-DIV-CASH')?.amountCents).toBe(480000);
  });
  it('locates named tables regardless of worksheet names or cell positions', async () => {
    const pack = await files.readBaseline(await makeBaseline());
    expect(pack.lines[0].amountCents).toBe(480000);
    expect(pack.entityId).toBe('alex-taylor');
  });
  it('rejects cached formula results as baseline source values', async () => {
    await expect(files.readBaseline(await makeBaseline(true))).rejects.toThrow(/formula/i);
  });
  it('rejects files without the agreed tables', async () => {
    const book = new ExcelJS.Workbook(); book.addWorksheet('Other');
    await expect(files.readBaseline(await book.xlsx.writeBuffer())).rejects.toThrow(/Peregrine_Metadata/);
  });
});

describe('CSV evidence parsing', () => {
  const headers = 'document_id,line_id,entity_id,financial_year,component,currency,basis,amount,description';
  it('reads quoted descriptions and zero amounts without losing provenance', () => {
    const rows = evidenceFiles.readEvidenceCsv(`${headers}\r\nD1,ALE-DIV-CASH,alex-taylor,2026,cash,AUD,cash,0,"Synthetic, statement"`);
    expect(rows[0].amountCents).toBe(0);
    expect(rows[0].description).toBe('Synthetic, statement');
  });
  it('keeps empty amounts null, accepts negatives, and rejects malformed values', () => {
    expect(evidenceFiles.parseMoney('')).toBeNull();
    expect(evidenceFiles.parseMoney('-123.45')).toBe(-12345);
    expect(() => evidenceFiles.parseMoney('12abc')).toThrow(/amount/i);
    expect(() => evidenceFiles.parseMoney('1.234')).toThrow(/amount/i);
  });
  it('rejects duplicate identity rows in one file', () => {
    const row = 'D1,ALE-DIV-CASH,alex-taylor,2026,cash,AUD,cash,4200,Fixture';
    expect(() => evidenceFiles.readEvidenceCsv(`${headers}\n${row}\n${row}`)).toThrow(/duplicate/i);
  });
  it('rejects unexpected columns and unclosed quotes', () => {
    expect(() => evidenceFiles.readEvidenceCsv('wrong,columns\na,b')).toThrow(/columns/i);
    expect(() => evidenceFiles.readEvidenceCsv(`${headers}\n"bad`)).toThrow(/quote/i);
  });
});

describe('versioned review round trip', () => {
  function active() {
    let state = workflow.startSeason(workflow.importBaseline(workflow.createWorkspace(), baseline), 'alex-taylor');
    return workflow.receiveEvidence(state, state.requests[0].id, evidence);
  }
  it('previews only designated review fields and does not apply typed approval automatically', async () => {
    const state = active(); const book = new ExcelJS.Workbook();
    await book.xlsx.load(await files.exportReview(state, 'alex-taylor'));
    const sheet = book.getWorksheet('Review')!;
    sheet.getCell('G6').value = 'accepted'; sheet.getCell('H6').value = 'Source checked';
    const result = await files.previewReview(await book.xlsx.writeBuffer(), state, 'alex-taylor');
    expect(result).toEqual([{ requestId: 'alex-taylor:2026:ALE-DIV-CASH', decision: 'accepted', note: 'Source checked' }]);
    expect(state.requests[0].review).toBe('pending');
  });
  it('rejects stale versions after new evidence arrives', async () => {
    const state = active(); const file = await files.exportReview(state, 'alex-taylor');
    const changed = workflow.recordAnswer(state, state.requests[0].id, 'Updated answer');
    await expect(files.previewReview(file, changed, 'alex-taylor')).rejects.toThrow(/stale/i);
  });
  it('rejects modified source values and wrong entity exports', async () => {
    const state = active(); const book = new ExcelJS.Workbook();
    await book.xlsx.load(await files.exportReview(state, 'alex-taylor'));
    book.getWorksheet('Review')!.getCell('D6').value = 999;
    await expect(files.previewReview(await book.xlsx.writeBuffer(), state, 'alex-taylor')).rejects.toThrow(/source/i);
    await expect(files.previewReview(await files.exportReview(state, 'alex-taylor'), state, 'sam-taylor')).rejects.toThrow(/entity/i);
  });
});

describe('exportReview attachments', () => {
  const HASH = 'e'.repeat(64);
  async function withIntakeEvidence() {
    let state = workflow.startSeason(workflow.importBaseline(workflow.createWorkspace(), baseline), 'alex-taylor');
    state = workflow.receiveEvidence(state, 'alex-taylor:2026:ALE-DIV-CASH', { ...evidence, documentId: `intake-${HASH.slice(0, 16)}-0`, filename: 'statement.jpg', fileHash: HASH, description: 'Dividend statement — Alex Taylor' });
    state = workflow.receiveEvidence(state, 'alex-taylor:2026:ALE-DIV-CASH', { ...evidence, documentId: 'FY26-DIV-B', amountCents: 100000, filename: 'dividend-b.csv', fileHash: 'f'.repeat(64) });
    return state;
  }
  it('lists source and adviser decision per evidence row and embeds photos on an Attachments sheet', async () => {
    const jpeg = await readFile('tests/fixtures/intake/statement.jpg');
    const loads: string[] = [];
    const bytes = await files.exportReview(await withIntakeEvidence(), 'alex-taylor', async hash => { loads.push(hash); return hash === HASH ? new Uint8Array(jpeg).buffer : null; });
    const book = new ExcelJS.Workbook(); await book.xlsx.load(bytes);
    const rows = book.getWorksheet('Evidence')!.getSheetValues().slice(1).map(r => (r as unknown[]).slice(1));
    expect(rows[0]).toEqual(['Request ID', 'Line', 'Document ID', 'File', 'Source', 'Component', 'Amount AUD', 'SHA-256', 'Description', 'Adviser decision']);
    expect(rows[1]).toMatchObject({ 1: 'ALE-DIV-CASH', 3: 'statement.jpg', 4: 'Reply attachment (model-read, adviser-accepted)', 9: 'pending' });
    expect(rows[2]).toMatchObject({ 3: 'dividend-b.csv', 4: 'CSV upload' });
    expect(loads).toEqual([HASH, 'f'.repeat(64)]);
    const attachments = book.getWorksheet('Attachments')!;
    expect(attachments.getCell('A1').value).toMatch(/Attachments/);
    expect(attachments.getImages()).toHaveLength(1);
    expect(String(attachments.getCell('A3').value)).toContain('ALE-DIV-CASH');
    expect(String(attachments.getCell('A3').value)).toContain('statement.jpg');
    expect(book.model.media?.[0]?.extension).toBe('jpeg');
  });
  it('still exports without a loader, noting that originals stay in the browser', async () => {
    const book = new ExcelJS.Workbook(); await book.xlsx.load(await files.exportReview(await withIntakeEvidence(), 'alex-taylor'));
    const attachments = book.getWorksheet('Attachments')!;
    expect(attachments.getImages()).toHaveLength(0);
    expect(String(attachments.getCell('A3').value)).toMatch(/not embedded|browser/i);
  });
});

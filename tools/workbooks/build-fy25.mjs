import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { SpreadsheetFile, Workbook } from '@oai/artifact-tool';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outputDir = path.join(root, 'outputs/fy25-baseline');
const fixtureDir = path.join(root, 'fixtures/fy25');
const publicDir = path.join(root, 'public/samples/fy25');
const previewDir = path.join(outputDir, 'verification');
const columns = ['line_id', 'entity_id', 'financial_year', 'category', 'label', 'component', 'amount', 'currency', 'basis', 'source_ref', 'recurrence', 'request_text'];
const evidenceColumns = ['document_id', 'line_id', 'entity_id', 'financial_year', 'component', 'currency', 'basis', 'amount', 'description'];
const money = '#,##0;(#,##0);"—"';
const colors = { ink: '#162537', muted: '#576779', header: '#263D55', rule: '#B5C1CC', stripe: '#F0F4F7', linked: '#008000', input: '#0000FF' };
const entities = [
  { id: 'alex-taylor', name: 'Alex Taylor', type: 'individual', rows: [
    ['ALE-EMP', 'employment', 'Salary or wages', 'gross', 112000, 'gross', 'FY25-ALE-EMP', 'Provide your current-year income statement and confirm any change of employer.'],
    ['ALE-INT', 'interest', 'Bank interest', 'gross', 850, 'gross', 'FY25-ALE-INT', 'Provide the current-year annual interest summary and confirm account ownership.'],
    ['ALE-DIV-CASH', 'dividends', 'Cash dividends', 'cash', 4800, 'cash', 'FY25-ALE-DIV', 'Provide current-year dividend statements showing the cash dividend components.'],
    ['ALE-DIV-CREDIT', 'dividends', 'Franking credits', 'franking_credit', 1600, 'gross', 'FY25-ALE-DIV', 'Provide the franking credit component on the current-year dividend statements.'],
    ['ALE-TRUST', 'trust_income', 'Trust ordinary-income allocation', 'ordinary_income', 18000, 'gross', 'FY25-ALE-TRUST', 'Provide the current-year beneficiary statement with each income and credit component.'],
  ] },
  { id: 'sam-taylor', name: 'Sam Taylor', type: 'individual', rows: [
    ['SAM-EMP', 'employment', 'Salary or wages', 'gross', 76000, 'gross', 'FY25-SAM-EMP', 'Provide your current-year income statement and confirm any change of employer.'],
    ['SAM-INT', 'interest', 'Bank interest', 'gross', 420, 'gross', 'FY25-SAM-INT', 'Provide the current-year annual interest summary and confirm account ownership.'],
    ['SAM-TRUST', 'trust_income', 'Trust ordinary-income allocation', 'ordinary_income', 12000, 'gross', 'FY25-SAM-TRUST', 'Provide the current-year beneficiary statement with each income and credit component.'],
  ] },
  { id: 'taylor-services', name: 'Taylor Services Pty Ltd', type: 'company', rows: [
    ['CO-BANK', 'bank', 'Reconciled bank balance', 'closing_balance', 38000, 'closing_balance', 'FY25-CO-BANK', 'Provide the 30 June bank statement and reconciliation for the current year.'],
    ['CO-AR', 'receivables', 'Trade receivables', 'closing_balance', 24000, 'closing_balance', 'FY25-CO-AR', 'Provide the current-year aged receivables listing and subsequent receipt details.'],
    ['CO-AP', 'payables', 'Trade payables', 'closing_balance', 12000, 'closing_balance', 'FY25-CO-AP', 'Provide the current-year aged payables listing and material unpaid supplier invoices.'],
    ['CO-ASSET', 'assets', 'Equipment carrying amount', 'closing_balance', 30000, 'closing_balance', 'FY25-CO-ASSET', 'Provide the current-year asset register and invoices for additions or disposals.'],
    ['CO-LOAN', 'related_parties', 'Shareholder loan payable', 'closing_balance', 20000, 'closing_balance', 'FY25-CO-LOAN', 'Provide the current-year related-party loan ledger and supporting terms for adviser review.'],
  ] },
  { id: 'taylor-family-trust', name: 'Taylor Family Trust', type: 'trust', rows: [
    ['TR-BANK', 'bank', 'Reconciled bank balance', 'closing_balance', 16000, 'closing_balance', 'FY25-TR-BANK', 'Provide the 30 June trust bank statement and reconciliation for the current year.'],
    ['TR-INVEST', 'investments', 'Investment carrying amount', 'closing_balance', 150000, 'closing_balance', 'FY25-TR-INVEST', 'Provide the current-year investment statements and acquisition or disposal records.'],
    ['TR-DIST-ALE', 'beneficiary_info', 'Alex Taylor ordinary-income allocation', 'ordinary_income', 18000, 'gross', 'FY25-TR-DIST', 'Provide the current-year beneficiary allocation record for Alex with separate components.'],
    ['TR-DIST-SAM', 'beneficiary_info', 'Sam Taylor ordinary-income allocation', 'ordinary_income', 12000, 'gross', 'FY25-TR-DIST', 'Provide the current-year beneficiary allocation record for Sam with separate components.'],
    ['TR-DOC', 'trust_documents', 'Trust document checklist', 'document', null, 'document', 'FY25-TR-DOC', 'Provide current-year trust resolutions and confirm any deed amendments or trustee changes.'],
  ] },
].map(e => ({ ...e, entity_id: e.id, entity_name: e.name, entity_type: e.type, financial_year: 2025, workbook_filename: `${e.id}-FY25.xlsx`, workbook_path: `outputs/fy25-baseline/${e.id}-FY25.xlsx`, download_path: `/samples/fy25/${e.id}-FY25.xlsx`, evidence_filename: `${e.id}-evidence-FY25.csv`, lines: e.rows.map(([line_id, category, label, component, amount, basis, source_ref, request_text]) => ({ line_id, entity_id: e.id, financial_year: 2025, category, label, component, amount, currency: 'AUD', basis, source_ref, recurrence: 'annual', request_text })) }));

const descriptions = {
  'ALE-EMP': 'Synthetic annual income-statement fixture. Fictional employer: Wattle Studio Pty Ltd. Gross salary only; withholding not supplied.',
  'ALE-INT': 'Synthetic annual interest-summary fixture. Alex sole ownership. No bank account identifier or withholding amount supplied.',
  'ALE-DIV-CASH': 'Synthetic dividend-summary fixture: cash dividends 4800. Same document supports the separate 1600 franking-credit line.',
  'ALE-DIV-CREDIT': 'Synthetic dividend-summary fixture: franking credits 1600. Credit is separate from cash paid.',
  'ALE-TRUST': 'Synthetic beneficiary-summary fixture from Taylor Family Trust. Ordinary-income component only, matching TR-DIST-ALE.',
  'SAM-EMP': 'Synthetic annual income-statement fixture. Fictional employer: Southern Learning Pty Ltd. Gross salary only; withholding not supplied.',
  'SAM-INT': 'Synthetic annual interest-summary fixture. Sam sole ownership. No bank account identifier or withholding amount supplied.',
  'SAM-TRUST': 'Synthetic beneficiary-summary fixture from Taylor Family Trust. Ordinary-income component only, matching TR-DIST-SAM.',
  'CO-BANK': 'Synthetic reconciliation: statement balance 40000 plus deposit 1000 less outstanding payments 3000 equals book balance 38000.',
  'CO-AR': 'Synthetic aged-receivables control: three fictional open invoices of 9000, 8000 and 7000. Total 24000.',
  'CO-AP': 'Synthetic aged-payables control: three fictional unpaid bills of 5000, 4000 and 3000. Total 12000.',
  'CO-ASSET': 'Synthetic equipment register: cost 43000 less accumulated book depreciation 13000 equals carrying amount 30000. No tax depreciation.',
  'CO-LOAN': 'Synthetic loan ledger: opening payable 15000 plus advances 8000 less repayments 3000 equals closing payable 20000. Terms unassessed.',
  'TR-BANK': 'Synthetic reconciliation: statement balance 15000 plus deposit 2000 less outstanding payment 1000 equals book balance 16000.',
  'TR-INVEST': 'Synthetic investment register: illustrative cost carrying amounts 100000 and 50000. No current market valuation or tax cost-base conclusion.',
  'TR-DIST-ALE': 'Synthetic adviser allocation record: Alex ordinary-income allocation 18000. No executed resolution or approval represented.',
  'TR-DIST-SAM': 'Synthetic adviser allocation record: Sam ordinary-income allocation 12000. No executed resolution or approval represented.',
  'TR-DOC': 'Synthetic document checklist record only. Executed trust deed and signed distribution resolution are not supplied. Amount intentionally blank.',
};
const notes = {
  individual: 'Selected income components only. Deductions, withholding, offsets and tax liability are outside this fixture.',
  company: 'Illustrative closing balances and supporting schedules only. No tax adjustments, GST analysis or tax liability is calculated.',
  trust: 'Illustrative balances and ordinary-income allocations only. Legal entitlement, tax character and resolution validity need adviser assessment.',
};
const checks = [];
const font = 'Helvetica Neue';
function letters(index) { let s = ''; for (let n = index + 1; n; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s; }
function values(sheet, cell, matrix) { sheet.getRange(cell).write(matrix); }
function setFormula(sheet, cell, formula) { sheet.getRange(cell).formulas = [[formula]]; sheet.getRange(cell).format.font.color = formula.includes('!') ? colors.linked : '#000000'; }
function fmtMoney(sheet, range) { sheet.getRange(range).setNumberFormat(money); sheet.getRange(range).format.horizontalAlignment = 'right'; }
function header(sheet, row, headers, start = 2) {
  const range = sheet.getRangeByIndexes(row - 1, start, 1, headers.length);
  range.values = [headers];
  range.format = { fill: colors.header, font: { name: font, size: 11, bold: true, color: '#FFFFFF' }, wrapText: true, horizontalAlignment: 'center', verticalAlignment: 'center', rowHeight: 34 };
}
function band(sheet, row, title, end = 'H') { values(sheet, `C${row}`, [[title]]); sheet.getRange(`C${row}:${end}${row}`).format = { fill: colors.stripe, font: { bold: true }, rowHeight: 26 }; }
function total(sheet, row, label, formula, cell = 'E') { values(sheet, `C${row}`, [[label]]); setFormula(sheet, `${cell}${row}`, formula); sheet.getRange(`C${row}:${cell}${row}`).format.borders = { top: { style: 'thin', color: colors.rule } }; sheet.getRange(`C${row}:${cell}${row}`).format.font.bold = true; fmtMoney(sheet, `${cell}${row}`); }
function note(sheet, row, text, cell = 'C', end = 'H') { values(sheet, `${cell}${row}`, [[text]]); sheet.getRange(`${cell}${row}:${end}${row}`).format.rowHeight = 30; sheet.getRange(`${cell}${row}`).format = { font: { name: font, size: 10, color: colors.muted, italic: true }, wrapText: false }; }
function base(wb, name, e, lastRow = 25, lastCol = 'H', widths = [36, 24, 20, 20, 24, 36]) {
  const sh = wb.worksheets.getItem(name);
  sh.showGridLines = false;
  sh.getRange(`A1:${lastCol}${lastRow}`).format = { font: { name: font, size: 11, color: colors.ink }, rowHeight: 24, verticalAlignment: 'center' };
  sh.getRange('A:B').format.columnWidth = 2;
  widths.forEach((width, i) => sh.getRange(`${letters(i + 2)}:${letters(i + 2)}`).format.columnWidth = width);
  values(sh, 'C2', [[name]]);
  sh.getRange(`C2:${lastCol}2`).format = { font: { size: 18, bold: true }, rowHeight: 32, borders: { bottom: { style: 'thin', color: colors.rule } } };
  values(sh, 'C3', [[`${e.name} · FY25 · 1 July 2024 to 30 June 2025 · AUD · Synthetic`]]);
  sh.getRange('C3').format.font = { name: font, size: 10, color: colors.muted, italic: true };
  return sh;
}
function lookup(e, id) { return `INDEX('Data'!$G$7:$G$${6 + e.lines.length},MATCH("${id}",'Data'!$A$7:$A$${6 + e.lines.length},0))`; }
function evidenceLookup(e, id) { return `SUMIF('Evidence'!$B$7:$B$${6 + e.lines.length},"${id}",'Evidence'!$H$7:$H$${6 + e.lines.length})`; }
function expect(e, sh, cell, expected, meaning) { checks.push({ entity_id: e.id, sheet: sh.name, cell, expected, meaning, actual: sh.getRange(cell).values[0][0] }); assert.equal(sh.getRange(cell).values[0][0], expected, `${e.id} ${sh.name}!${cell}: ${meaning}`); }

function metadata(wb, e, names) {
  const sh = wb.worksheets.getItem('Metadata');
  sh.showGridLines = false;
  sh.getRange('A1:F31').format = { font: { name: font, size: 11, color: colors.ink }, rowHeight: 25, verticalAlignment: 'center' };
  sh.getRange('A:A').format.columnWidth = 24; sh.getRange('B:B').format.columnWidth = 40; sh.getRange('C:C').format.columnWidth = 3;
  sh.getRange('D:D').format.columnWidth = 32; sh.getRange('E:E').format.columnWidth = 48; sh.getRange('F:F').format.columnWidth = 15;
  values(sh, 'A2', [[`${e.name} — FY25`]]); sh.getRange('A2:F2').format = { font: { size: 18, bold: true }, rowHeight: 34, borders: { bottom: { style: 'thin', color: colors.rule } } };
  values(sh, 'A3', [['Peregrine synthetic baseline · 1 July 2024 to 30 June 2025 · AUD']]); sh.getRange('A3').format.font = { italic: true, size: 10, color: colors.muted };
  const data = [['key', 'value'], ['schema_version', '1'], ['workbook_id', `FY25-${e.id}`], ['entity_id', e.id], ['entity_name', e.name], ['entity_type', e.type], ['financial_year', 2025], ['synthetic', 'true'], ['template_version', '1'], ['baseline_version', 1], ['status', 'synthetic_reviewed']];
  values(sh, 'A6', data); const table = sh.tables.add('A6:B16', true, 'Peregrine_Metadata'); table.showFilterButton = false;
  sh.getRange('A6:B6').format = { fill: colors.header, font: { color: '#FFFFFF', bold: true }, rowHeight: 30 };
  sh.getRange('B7:B16').format.wrapText = true;
  values(sh, 'D6', [['Workbook contents', 'Purpose']]); sh.getRange('D6:E6').format = { fill: colors.header, font: { color: '#FFFFFF', bold: true }, rowHeight: 30 };
  const purposes = { Metadata: 'Entity, period, schema and scope', Income: 'Employment and interest reconciliation', Dividends: 'Cash and franking-credit components', 'Trust Income': 'Ordinary-income allocation and evidence', Mapping: 'Selected FY25 return references', Queries: 'Current-year evidence prompts', 'Trial Balance': 'Illustrative closing debit and credit balances', 'Bank Reconciliation': 'Statement-to-book balance bridge', 'Receivables and Payables': 'Open invoice and bill detail', Assets: 'Book carrying-amount reconciliation', 'Related Parties': 'Illustrative shareholder loan movement', Investments: 'Holding detail at seeded carrying amounts', Beneficiaries: 'Ordinary-income pool and individual allocations', 'Trust Documents': 'Document availability and adviser questions', Evidence: 'Independent synthetic evidence records', Data: 'Named import table with stable line IDs' };
  values(sh, 'D7', names.map(n => [n, purposes[n]])); sh.getRange(`D7:E${6 + names.length}`).format.wrapText = true; sh.getRange(`D7:E${6 + names.length}`).format.rowHeight = 35;
  values(sh, 'A19', [['Scope and use']]); sh.getRange('A19:F19').format = { fill: colors.stripe, font: { bold: true } };
  const scope = ['All people, organisations, amounts and documents in this workbook are fictional.', notes[e.type], 'This is a limited workpaper prototype. It is not a completed tax return or an ATO lodgment record.', 'The synthetic_reviewed value seeds the demo. Import approval requires an authenticated event in the app.', 'Use FY25 only as a comparative and enquiry source. Obtain separate evidence for the current financial year.', 'Green figures link to another sheet. Black figures calculate within the sheet. Missing document amounts stay blank.'];
  scope.forEach((s, i) => { values(sh, `A${21 + i}`, [[s]]); sh.getRange(`A${21 + i}:F${21 + i}`).format.rowHeight = 27; });
  return sh;
}

function dataAndEvidence(wb, e) {
  const data = wb.worksheets.getItem('Data'); data.showGridLines = false;
  data.getRange(`A1:L${e.lines.length + 8}`).format = { font: { name: font, size: 11, color: colors.ink }, rowHeight: 42, verticalAlignment: 'center' };
  [20, 25, 16, 22, 39, 24, 17, 13, 23, 24, 16, 75].forEach((w, i) => data.getRange(`${letters(i)}:${letters(i)}`).format.columnWidth = w);
  values(data, 'A2', [['FY25 import lines']]); data.getRange('A2:L2').format = { font: { size: 18, bold: true }, rowHeight: 34, borders: { bottom: { style: 'thin', color: colors.rule } } };
  values(data, 'A3', [[`${e.name} · Synthetic · Named table Peregrine_Lines · Numeric amounts only; no formulas`]]); data.getRange('A3').format.font = { italic: true, size: 10, color: colors.muted };
  values(data, 'A6', [columns, ...e.lines.map(l => columns.map(c => l[c]))]); data.tables.add(`A6:L${6 + e.lines.length}`, true, 'Peregrine_Lines');
  header(data, 6, columns, 0); data.getRange(`A7:L${6 + e.lines.length}`).format.wrapText = true; data.getRange(`A7:L${6 + e.lines.length}`).format.rowHeight = 64; fmtMoney(data, `G7:G${6 + e.lines.length}`); data.getRange(`C7:C${6 + e.lines.length}`).setNumberFormat('0');
  data.freezePanes.freezeRows(6); data.freezePanes.freezeColumns(2);
  const evidence = wb.worksheets.getItem('Evidence'); evidence.showGridLines = false;
  evidence.getRange(`A1:I${e.lines.length + 11}`).format = { font: { name: font, size: 11, color: colors.ink }, rowHeight: 32, verticalAlignment: 'center' };
  [24, 21, 27, 16, 24, 13, 23, 19, 91].forEach((w, i) => evidence.getRange(`${letters(i)}:${letters(i)}`).format.columnWidth = w);
  values(evidence, 'A2', [['Synthetic evidence index']]); evidence.getRange('A2:I2').format = { font: { size: 18, bold: true }, rowHeight: 34, borders: { bottom: { style: 'thin', color: colors.rule } } };
  values(evidence, 'A3', [[`${e.name} · FY25 · Structured test records; no genuine issuer statements`]]); evidence.getRange('A3').format.font = { italic: true, size: 10, color: colors.muted };
  const ev = e.lines.map(l => ({ document_id: l.source_ref, line_id: l.line_id, entity_id: e.id, financial_year: 2025, component: l.component, currency: 'AUD', basis: l.basis, amount: l.amount, description: descriptions[l.line_id] }));
  values(evidence, 'A6', [evidenceColumns, ...ev.map(l => evidenceColumns.map(c => l[c]))]); evidence.tables.add(`A6:I${6 + ev.length}`, true, 'Peregrine_Evidence'); header(evidence, 6, evidenceColumns, 0);
  evidence.getRange(`A7:I${6 + ev.length}`).format.wrapText = true; evidence.getRange(`A7:I${6 + ev.length}`).format.rowHeight = 72; fmtMoney(evidence, `H7:H${6 + ev.length}`); evidence.getRange(`D7:D${6 + ev.length}`).setNumberFormat('0');
  values(evidence, `A${9 + ev.length}`, [['One document may support separate components. Match line, entity, period, component, currency and basis before comparing.']]);
  evidence.freezePanes.freezeRows(6); evidence.freezePanes.freezeColumns(2);
  return ev;
}
function reconcileRows(sh, e, items, start = 7) {
  header(sh, start - 1, ['Line / source', 'Component', 'Baseline AUD', 'Evidence AUD', 'Difference AUD', 'Evidence ID']);
  items.forEach((id, i) => { const row = start + i; const line = e.lines.find(l => l.line_id === id); values(sh, `C${row}`, [[line.label, line.component, null, null, null, line.source_ref]]); setFormula(sh, `E${row}`, `=${lookup(e, id)}`); setFormula(sh, `F${row}`, `=${evidenceLookup(e, id)}`); setFormula(sh, `G${row}`, `=E${row}-F${row}`); sh.getRange(`C${row}:H${row}`).format.wrapText = true; sh.getRange(`C${row}:H${row}`).format.rowHeight = 40; });
  fmtMoney(sh, `E${start}:G${start + items.length - 1}`);
  items.forEach((id, i) => expect(e, sh, `G${start + i}`, 0, `${id} evidence difference`));
}

function individual(wb, e) {
  const p = e.id === 'alex-taylor' ? 'ALE' : 'SAM';
  const income = base(wb, 'Income', e, 24);
  reconcileRows(income, e, [`${p}-EMP`, `${p}-INT`]);
  total(income, 10, 'Employment and interest subtotal', '=SUM(E7:E8)');
  band(income, 13, 'Source detail');
  values(income, 'C15', [['Employment source', p === 'ALE' ? 'Wattle Studio Pty Ltd' : 'Southern Learning Pty Ltd'], ['Interest ownership', 'Sole ownership assumed in the synthetic fixture'], ['Withholding', 'Not supplied; no withholding amount has been inferred']]);
  income.getRange('D15:D17').format.wrapText = false;
  note(income, 20, 'The subtotal contains only the two displayed gross components. It is not taxable income.');
  expect(e, income, 'E10', p === 'ALE' ? 112850 : 76420, 'Employment plus interest');
  if (p === 'ALE') {
    const div = base(wb, 'Dividends', e, 24); reconcileRows(div, e, ['ALE-DIV-CASH', 'ALE-DIV-CREDIT']);
    band(div, 12, 'Component handling');
    note(div, 14, 'Cash dividends are bank receipts. Franking credits are a separate statement component.');
    note(div, 15, 'The sample does not split the cash amount into franked and unfranked portions.');
    note(div, 16, 'No combined dividend amount or tax liability is calculated.');
    values(div, 'C19', [['FY25 mapping enquiry', 'Confirm franked / unfranked cash split before assigning return sublabels.']]);
    expect(e, div, 'E7', 4800, 'Cash dividends'); expect(e, div, 'E8', 1600, 'Franking credits');
  }
  const trust = base(wb, 'Trust Income', e, 26); reconcileRows(trust, e, [`${p}-TRUST`]);
  band(trust, 11, 'Allocation context');
  values(trust, 'C13', [['Source trust', 'Taylor Family Trust'], ['Component', 'Ordinary income only'], ['Cross-reference', p === 'ALE' ? 'TR-DIST-ALE' : 'TR-DIST-SAM'], ['Tax and legal assessment', 'Not performed in this synthetic fixture']]);
  note(trust, 19, 'The matching trust line is reconciled when building the family pack. No external workbook link is used.');
  note(trust, 20, 'Other trust components may require different return references. Obtain the full beneficiary statement.');
  expect(e, trust, 'E7', p === 'ALE' ? 18000 : 12000, 'Ordinary trust income');
  const map = base(wb, 'Mapping', e, 28, 'G', [26, 25, 26, 70, 10]);
  header(map, 6, ['Category', 'Component', 'FY25 reference', 'Scope / required clarification']);
  const mappings = [['employment', 'gross', 'Item 1', 'Salary or wages. The withholding component is not supplied.'], ['interest', 'gross', 'Item 10', 'Gross interest. Do not infer tax withheld from the gross amount.'], ...(p === 'ALE' ? [['dividends', 'cash', 'Item 11', 'Franked and unfranked cash split requires a dividend statement.'], ['dividends', 'franking_credit', 'Item 11', 'Keep credits separate from cash dividends.']] : []), ['trust_income', 'ordinary_income', 'Supplementary item 13', 'Selected ordinary income only. This is not a complete mapping of trust components.']];
  values(map, 'C7', mappings); map.getRange(`C7:F${6 + mappings.length}`).format.wrapText = true; map.getRange(`C7:F${6 + mappings.length}`).format.rowHeight = 52;
  band(map, 15, 'Reference context', 'F');
  note(map, 17, 'References are limited to the FY25 individual return and supplement reviewed for this prototype.', 'C', 'F');
  values(map, 'C19', [['Australian Taxation Office — Individual tax return 2025'], ['https://iorder.com.au/publication/Download.aspx?ProdID=2541-6.2025'], ['Australian Taxation Office — Supplementary tax return 2025'], ['https://iorder.com.au/publication/Download.aspx?ProdID=2679-6.2025']]);
  map.getRange('C19:C22').format.font.size = 10;
  const queries = base(wb, 'Queries', e, 29, 'F', [24, 31, 84, 22]); header(queries, 6, ['Prior-year line', 'Reason', 'Current-year request', 'Evidence state']);
  values(queries, 'C7', e.lines.map(l => [l.line_id, `FY25 ${l.label.toLowerCase()}`, l.request_text, 'Not yet requested'])); queries.getRange(`C7:F${6 + e.lines.length}`).format.wrapText = true; queries.getRange(`C7:F${6 + e.lines.length}`).format.rowHeight = 60;
  band(queries, 15, 'Change discovery', 'F');
  values(queries, 'C17', [['New income sources', 'Confirm any new employer, bank account, investment or trust distribution.'], ['Ceased activities', 'Confirm whether each prior-year source continued, ceased or changed ownership.'], ['Unlisted matters', 'Ask about deductions and other relevant facts through the adviser-approved checklist.']]); queries.getRange('D17:D19').format.wrapText = false;
  note(queries, 22, 'FY25 amounts trigger enquiries only. No amount in this sheet represents accepted FY26 income.', 'C', 'F');
}

function trialBalance(wb, e) {
  const sh = base(wb, 'Trial Balance', e, 29, 'G', [40, 22, 22, 28, 48]); header(sh, 6, ['Account', 'Debit AUD', 'Credit AUD', 'Source', 'Comment']);
  const company = e.type === 'company';
  const lines = company ? [ ['Bank', 'CO-BANK', 'D', 'Reconciled cash'], ['Trade receivables', 'CO-AR', 'D', 'Open customer invoices'], ['Equipment carrying amount', 'CO-ASSET', 'D', 'Net book carrying amount'], ['Trade payables', 'CO-AP', 'E', 'Unpaid supplier bills'], ['Shareholder loan payable', 'CO-LOAN', 'E', 'Liability; terms unassessed'], ['Contributed equity', 10000, 'E', 'Seeded supporting balance'], ['Retained earnings', 50000, 'E', 'Seeded supporting balance'] ] : [ ['Bank', 'TR-BANK', 'D', 'Reconciled cash'], ['Investments', 'TR-INVEST', 'D', 'Seeded cost carrying amounts'], ['Alex beneficiary payable', 'TR-DIST-ALE', 'E', 'Illustrative unpaid allocation'], ['Sam beneficiary payable', 'TR-DIST-SAM', 'E', 'Illustrative unpaid allocation'], ['Settled capital', 100, 'E', 'Seeded supporting balance'], ['Accumulated funds', 135900, 'E', 'Seeded supporting balance'] ];
  lines.forEach(([label, source, col, comment], i) => { const r = 7 + i; values(sh, `C${r}`, [[label, null, null, typeof source === 'number' ? 'Synthetic supporting record' : source, comment]]); if (typeof source === 'number') values(sh, `${col}${r}`, [[source]]); else setFormula(sh, `${col}${r}`, `=${lookup(e, source)}`); });
  sh.getRange(`C7:G${6 + lines.length}`).format.wrapText = true; sh.getRange(`C7:G${6 + lines.length}`).format.rowHeight = 38; fmtMoney(sh, `D7:E${7 + lines.length}`);
  const end = 6 + lines.length, totalRow = end + 2;
  values(sh, `C${totalRow}`, [['Closing balance totals']]); setFormula(sh, `D${totalRow}`, `=SUM(D7:D${end})`); setFormula(sh, `E${totalRow}`, `=SUM(E7:E${end})`); sh.getRange(`C${totalRow}:E${totalRow}`).format = { font: { bold: true }, borders: { top: { style: 'thin', color: colors.rule } } }; fmtMoney(sh, `D${totalRow}:E${totalRow}`);
  total(sh, totalRow + 2, 'Debit less credit difference', `=D${totalRow}-E${totalRow}`);
  note(sh, totalRow + 5, 'Supporting equity / funds balances are explicit synthetic inputs. This is an illustrative closing-balance schedule.');
  note(sh, totalRow + 6, 'The sample omits the income statement, tax adjustments and full financial-report disclosures.');
  expect(e, sh, `D${totalRow}`, company ? 92000 : 166000, 'Trial balance debit'); expect(e, sh, `E${totalRow}`, company ? 92000 : 166000, 'Trial balance credit'); expect(e, sh, `E${totalRow + 2}`, 0, 'Trial balance difference');
}
function bank(wb, e) {
  const sh = base(wb, 'Bank Reconciliation', e, 26, 'G', [48, 25, 23, 27, 36]); const company = e.type === 'company';
  header(sh, 6, ['Reconciliation item', 'Basis', 'Amount AUD', 'Evidence reference', 'Context']);
  values(sh, 'C7', [['Statement closing balance', 'Statement', company ? 40000 : 15000, company ? 'FY25-CO-BANK' : 'FY25-TR-BANK', '30 June 2025; fictional bank'], ['Deposit in transit', 'Add', company ? 1000 : 2000, 'Synthetic reconciling item', 'Not on statement at 30 June'], ['Outstanding payments', 'Less', company ? -3000 : -1000, 'Synthetic reconciling item', 'Not on statement at 30 June']]);
  sh.getRange('C7:G9').format.wrapText = true; sh.getRange('C7:G9').format.rowHeight = 40; fmtMoney(sh, 'E7:E15');
  total(sh, 11, 'Adjusted statement balance', '=SUM(E7:E9)'); values(sh, 'C13', [['Book closing balance']]); setFormula(sh, 'E13', `=${lookup(e, company ? 'CO-BANK' : 'TR-BANK')}`); total(sh, 15, 'Statement-to-book difference', '=E11-E13');
  band(sh, 19, 'Reconciliation scope', 'G'); note(sh, 21, 'The statement and reconciling items are seeded test inputs. No bank feed or genuine account is represented.'); note(sh, 22, 'Confirm outstanding items against subsequent transactions when real evidence is supplied.');
  expect(e, sh, 'E11', company ? 38000 : 16000, 'Adjusted bank balance'); expect(e, sh, 'E15', 0, 'Bank reconciliation difference');
}
function company(wb, e) {
  trialBalance(wb, e); bank(wb, e);
  const trade = base(wb, 'Receivables and Payables', e, 31, 'G', [30, 36, 22, 25, 42]);
  header(trade, 6, ['Invoice / bill', 'Fictional counterparty', 'Outstanding AUD', 'Due date', 'Evidence reference']);
  values(trade, 'C7', [['INV-25061', 'Copper Gum Design', 9000, new Date('2025-06-15T00:00:00Z'), 'FY25-CO-AR'], ['INV-25072', 'Paperbark Studio', 8000, new Date('2025-07-15T00:00:00Z'), 'FY25-CO-AR'], ['INV-25083', 'Saltbush Projects', 7000, new Date('2025-07-30T00:00:00Z'), 'FY25-CO-AR']]);
  trade.getRange('F7:F9').setNumberFormat('dd mmm yyyy'); fmtMoney(trade, 'E7:E12'); total(trade, 11, 'Receivables detail total', '=SUM(E7:E9)'); total(trade, 12, 'Difference to control balance', `=E11-${lookup(e, 'CO-AR')}`);
  band(trade, 16, 'Trade payables', 'G'); header(trade, 18, ['Invoice / bill', 'Fictional counterparty', 'Outstanding AUD', 'Due date', 'Evidence reference']);
  values(trade, 'C19', [['BILL-25044', 'Blue Wren Supplies', 5000, new Date('2025-06-28T00:00:00Z'), 'FY25-CO-AP'], ['BILL-25056', 'Banksia Equipment', 4000, new Date('2025-07-10T00:00:00Z'), 'FY25-CO-AP'], ['BILL-25067', 'Mallee Services', 3000, new Date('2025-07-20T00:00:00Z'), 'FY25-CO-AP']]);
  trade.getRange('F19:F21').setNumberFormat('dd mmm yyyy'); fmtMoney(trade, 'E19:E24'); total(trade, 23, 'Payables detail total', '=SUM(E19:E21)'); total(trade, 24, 'Difference to control balance', `=E23-${lookup(e, 'CO-AP')}`); note(trade, 28, 'Outstanding amounts are synthetic closing balances. GST and recoverability conclusions are outside this sample.');
  expect(e, trade, 'E11', 24000, 'Receivables invoices'); expect(e, trade, 'E12', 0, 'Receivables control difference'); expect(e, trade, 'E23', 12000, 'Payables bills'); expect(e, trade, 'E24', 0, 'Payables control difference');
  const assets = base(wb, 'Assets', e, 24, 'G', [39, 23, 25, 24, 40]); header(assets, 6, ['Asset group', 'Cost AUD', 'Accumulated book depreciation AUD', 'Carrying amount AUD', 'Evidence reference']); assets.getRange('C6:G6').format.rowHeight = 55;
  values(assets, 'C7', [['Computer equipment', 18000, 6000, null, 'FY25-CO-ASSET'], ['Office equipment', 25000, 7000, null, 'FY25-CO-ASSET']]); setFormula(assets, 'F7', '=D7-E7'); setFormula(assets, 'F8', '=D8-E8'); fmtMoney(assets, 'D7:F10'); values(assets, 'C10', [['Register totals']]); ['D', 'E', 'F'].forEach(c => setFormula(assets, `${c}10`, `=SUM(${c}7:${c}8)`)); assets.getRange('C10:F10').format = { font: { bold: true }, borders: { top: { style: 'thin', color: colors.rule } } }; total(assets, 13, 'Difference to carrying amount', `=F10-${lookup(e, 'CO-ASSET')}`, 'F'); band(assets, 17, 'Book basis', 'G'); note(assets, 19, 'Accumulated depreciation is a supplied synthetic book balance. No useful life or tax deduction is inferred.'); note(assets, 20, 'Obtain acquisition, disposal and depreciation records for the current year.');
  expect(e, assets, 'D10', 43000, 'Asset cost'); expect(e, assets, 'E10', 13000, 'Accumulated book depreciation'); expect(e, assets, 'F10', 30000, 'Asset carrying amount'); expect(e, assets, 'F13', 0, 'Asset control difference');
  const related = base(wb, 'Related Parties', e, 26, 'G', [48, 30, 25, 28, 34]); header(related, 6, ['Shareholder loan movement', 'Direction', 'Amount AUD', 'Evidence reference', 'Context']); values(related, 'C7', [['Opening payable', 'Liability', 15000, 'FY25-CO-LOAN', 'Fictional Shareholder A'], ['Advances received', 'Increase payable', 8000, 'FY25-CO-LOAN', 'Synthetic cash advances'], ['Repayments made', 'Decrease payable', -3000, 'FY25-CO-LOAN', 'Synthetic repayments']]); related.getRange('C7:G9').format.wrapText = true; related.getRange('C7:G9').format.rowHeight = 40; fmtMoney(related, 'E7:E14'); total(related, 11, 'Closing payable', '=SUM(E7:E9)'); total(related, 14, 'Difference to control balance', `=E11-${lookup(e, 'CO-LOAN')}`); band(related, 18, 'Adviser matters', 'G'); note(related, 20, 'Confirm lender identity, loan terms and the direction of each related-party balance.'); note(related, 21, 'No company tax-return label or Division 7A conclusion is assigned in this fixture.');
  expect(e, related, 'E11', 20000, 'Related-party closing payable'); expect(e, related, 'E14', 0, 'Related-party control difference');
}
function trust(wb, e) {
  trialBalance(wb, e); bank(wb, e);
  const investments = base(wb, 'Investments', e, 25, 'G', [43, 27, 25, 30, 38]); header(investments, 6, ['Fictional holding', 'Carrying basis', 'Carrying amount AUD', 'Evidence reference', 'Valuation context']);
  values(investments, 'C7', [['Southern Index Fund units', 'Seeded cost', 100000, 'FY25-TR-INVEST', 'No market price supplied'], ['Wattle Industries shares', 'Seeded cost', 50000, 'FY25-TR-INVEST', 'No tax cost-base conclusion']]); investments.getRange('C7:G8').format.wrapText = true; investments.getRange('C7:G8').format.rowHeight = 44; fmtMoney(investments, 'E7:E13'); total(investments, 10, 'Investment carrying amount', '=SUM(E7:E8)'); total(investments, 13, 'Difference to control balance', `=E10-${lookup(e, 'TR-INVEST')}`); band(investments, 17, 'Current-year evidence', 'G'); note(investments, 19, 'Obtain holding statements, purchases, sales and income statements. Keep valuation and tax basis distinct.'); note(investments, 20, 'This schedule does not calculate capital gains, distributions or market movements.');
  expect(e, investments, 'E10', 150000, 'Investment carrying amount'); expect(e, investments, 'E13', 0, 'Investment control difference');
  const bene = base(wb, 'Beneficiaries', e, 28, 'H', [28, 24, 23, 23, 27, 37]); reconcileRows(bene, e, ['TR-DIST-ALE', 'TR-DIST-SAM']); total(bene, 11, 'Ordinary-income allocations', '=SUM(E7:E8)'); values(bene, 'C13', [['Synthetic ordinary-income pool']]); values(bene, 'E13', [[30000]]); fmtMoney(bene, 'E13'); total(bene, 15, 'Unallocated pool difference', '=E13-E11');
  band(bene, 19, 'Matching individual workpapers'); values(bene, 'C21', [['Alex Taylor', 'ALE-TRUST', 'Ordinary income'], ['Sam Taylor', 'SAM-TRUST', 'Ordinary income']]); note(bene, 24, 'The family pack checks both individual amounts against these lines. No external workbook link is used.'); note(bene, 25, 'The allocation record is fictional and does not establish legal entitlement or approve a distribution.');
  expect(e, bene, 'E11', 30000, 'Beneficiary allocations'); expect(e, bene, 'E15', 0, 'Unallocated ordinary-income pool');
  const docs = base(wb, 'Trust Documents', e, 29, 'F', [38, 35, 83, 26]); header(docs, 6, ['Document / record', 'Availability in fixture', 'Adviser enquiry', 'Evidence reference']);
  values(docs, 'C7', [['Document checklist', 'Synthetic record held', 'This checklist documents what the demonstration contains.', 'FY25-TR-DOC'], ['Ordinary-income allocation record', 'Synthetic record held', 'Reconcile the two allocations with the full beneficiary statements.', 'FY25-TR-DIST'], ['Executed trust deed and amendments', 'Not supplied', 'Obtain executed documents and confirm current trustee details.', 'No original document'], ['Signed distribution resolution', 'Not supplied', 'Obtain the executed current-year record and assess its validity.', 'No original document']]); docs.getRange('C7:F10').format.wrapText = true; docs.getRange('C7:F10').format.rowHeight = 60;
  band(docs, 14, 'Document amount', 'F'); values(docs, 'C16', [['TR-DOC amount', 'Intentionally blank']]); note(docs, 18, 'A document requirement has no monetary amount. Blank is not zero.', 'C', 'F'); band(docs, 21, 'Limitations', 'F'); note(docs, 23, 'No deed, signature, trustee identity or legal approval is fabricated by this workbook.', 'C', 'F'); note(docs, 24, 'The synthetic baseline status does not resolve missing executed documents.', 'C', 'F');
}

function csv(matrix) { return matrix.map(row => row.map(v => v === null || v === undefined ? '' : `"${String(v).replaceAll('"', '""')}"`).join(',')).join('\r\n') + '\r\n'; }
await Promise.all([outputDir, fixtureDir, publicDir, previewDir].map(dir => fs.mkdir(dir, { recursive: true })));
const manifest = { schema_version: '1', financial_year: 2025, currency: 'AUD', synthetic: true, baseline_version: 1, status: 'synthetic_reviewed', period_start: '2024-07-01', period_end: '2025-06-30', line_columns: columns, evidence_columns: evidenceColumns, entities: entities.map(({ rows, ...e }) => e), supporting_detail: { filename: 'company-supporting-detail-FY25.csv', purpose: 'Supplementary invoice, bill and equipment detail. Do not import alongside evidence control rows as additive evidence.' }, limitations: ['Synthetic test records only; no genuine issuer documents.', 'Selected workpapers, not complete tax returns or financial statements.', 'No tax liability, tax depreciation, legal distribution approval, TFNs, bank identifiers or signatures.', 'Prior-year figures never populate accepted current-year amounts.'] };
await fs.writeFile(path.join(fixtureDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
const detail = [
  ['FY25-CO-AR-DETAIL', 'CO-AR', 'taylor-services', 2025, 'closing_balance', 'AUD', 'closing_balance', 9000, 'Synthetic INV-25061; Copper Gum Design; due 2025-06-15; outstanding invoice'],
  ['FY25-CO-AR-DETAIL', 'CO-AR', 'taylor-services', 2025, 'closing_balance', 'AUD', 'closing_balance', 8000, 'Synthetic INV-25072; Paperbark Studio; due 2025-07-15; outstanding invoice'],
  ['FY25-CO-AR-DETAIL', 'CO-AR', 'taylor-services', 2025, 'closing_balance', 'AUD', 'closing_balance', 7000, 'Synthetic INV-25083; Saltbush Projects; due 2025-07-30; outstanding invoice'],
  ['FY25-CO-AP-DETAIL', 'CO-AP', 'taylor-services', 2025, 'closing_balance', 'AUD', 'closing_balance', 5000, 'Synthetic BILL-25044; Blue Wren Supplies; due 2025-06-28; unpaid bill'],
  ['FY25-CO-AP-DETAIL', 'CO-AP', 'taylor-services', 2025, 'closing_balance', 'AUD', 'closing_balance', 4000, 'Synthetic BILL-25056; Banksia Equipment; due 2025-07-10; unpaid bill'],
  ['FY25-CO-AP-DETAIL', 'CO-AP', 'taylor-services', 2025, 'closing_balance', 'AUD', 'closing_balance', 3000, 'Synthetic BILL-25067; Mallee Services; due 2025-07-20; unpaid bill'],
  ['FY25-CO-ASSET-DETAIL', 'CO-ASSET', 'taylor-services', 2025, 'closing_balance', 'AUD', 'closing_balance', 12000, 'Synthetic computer equipment: cost 18000 less accumulated book depreciation 6000'],
  ['FY25-CO-ASSET-DETAIL', 'CO-ASSET', 'taylor-services', 2025, 'closing_balance', 'AUD', 'closing_balance', 18000, 'Synthetic office equipment: cost 25000 less accumulated book depreciation 7000'],
];
await fs.writeFile(path.join(fixtureDir, 'company-supporting-detail-FY25.csv'), csv([evidenceColumns, ...detail]));
const alex = entities.find(e => e.id === 'alex-taylor'), sam = entities.find(e => e.id === 'sam-taylor'), tr = entities.find(e => e.type === 'trust');
assert.equal(alex.lines.find(l => l.line_id === 'ALE-TRUST').amount, tr.lines.find(l => l.line_id === 'TR-DIST-ALE').amount);
assert.equal(sam.lines.find(l => l.line_id === 'SAM-TRUST').amount, tr.lines.find(l => l.line_id === 'TR-DIST-SAM').amount);
assert.equal(tr.lines.filter(l => l.category === 'beneficiary_info').reduce((s, l) => s + l.amount, 0), 30000);
const results = [];
for (const e of entities) {
  const wb = Workbook.create();
  const specialist = e.type === 'individual' ? ['Income', ...(e.id === 'alex-taylor' ? ['Dividends'] : []), 'Trust Income', 'Mapping', 'Queries'] : e.type === 'company' ? ['Trial Balance', 'Bank Reconciliation', 'Receivables and Payables', 'Assets', 'Related Parties'] : ['Trial Balance', 'Bank Reconciliation', 'Investments', 'Beneficiaries', 'Trust Documents'];
  const names = ['Metadata', ...specialist, 'Evidence', 'Data']; names.forEach(name => wb.worksheets.add(name));
  metadata(wb, e, names);
  const ev = dataAndEvidence(wb, e);
  if (e.type === 'individual') individual(wb, e); else if (e.type === 'company') company(wb, e); else trust(wb, e);
  for (const line of e.lines) { const records = ev.filter(v => v.line_id === line.line_id); assert.equal(records.length, 1); assert.equal(records[0].amount, line.amount); assert.equal(records[0].document_id, line.source_ref); assert.equal(line.amount === null || typeof line.amount === 'number', true); }
  assert.equal(wb.worksheets.getItem('Data').getRange(`A7:L${6 + e.lines.length}`).formulas.flat().some(Boolean), false);
  const scan = await wb.inspect({ kind: 'match', searchTerm: '#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!|#SPILL!|#CALC!', options: { useRegex: true, maxResults: 300 }, summary: 'Final formula error scan', maxChars: 5000 });
  assert.equal(/#REF!|#DIV\/0!|#VALUE!|#NAME\?|#N\/A|#NUM!|#NULL!|#SPILL!|#CALC!/.test(scan.ndjson), false, scan.ndjson);
  const key = await wb.inspect({ kind: 'table', range: `Data!A6:L${6 + e.lines.length}`, include: 'values,formulas', tableMaxRows: 8, tableMaxCols: 12, maxChars: 3500 });
  await fs.writeFile(path.join(previewDir, `${e.id}-inspection.ndjson`), `${scan.ndjson}\n${key.ndjson}\n`);
  await fs.writeFile(path.join(fixtureDir, e.evidence_filename), csv([evidenceColumns, ...ev.map(l => evidenceColumns.map(c => l[c]))]));
  const rendered = [];
  for (const name of names) {
    const ranges = name === 'Data' ? [`A1:F${6 + e.lines.length}`, `G1:L${6 + e.lines.length}`] : name === 'Evidence' ? [`A1:E${6 + e.lines.length}`, `F1:I${9 + e.lines.length}`] : [undefined];
    for (let i = 0; i < ranges.length; i++) {
      const png = await wb.render({ sheetName: name, ...(ranges[i] ? { range: ranges[i] } : { autoCrop: 'all' }), scale: 1.5, format: 'png' });
      const filename = `${e.id}-${name.toLowerCase().replaceAll(' ', '-')}${ranges.length > 1 ? `-${i + 1}` : ''}.png`;
      await fs.writeFile(path.join(previewDir, filename), new Uint8Array(await png.arrayBuffer())); rendered.push(filename);
    }
  }
  const out = await SpreadsheetFile.exportXlsx(wb); const destination = path.join(outputDir, e.workbook_filename); await out.save(destination); await fs.copyFile(destination, path.join(publicDir, e.workbook_filename));
  results.push({ entity_id: e.id, filename: e.workbook_filename, sheets: names, imported_line_count: e.lines.length, formula_scan: scan.ndjson, rendered, formula_assertions: checks.filter(c => c.entity_id === e.id) });
  console.log(JSON.stringify({ entity: e.id, workbook: destination, sheets: names.length, lines: e.lines.length, checks: checks.filter(c => c.entity_id === e.id).length, renders: rendered.length }));
}
await fs.writeFile(path.join(previewDir, 'verification.json'), JSON.stringify({ synthetic: true, generation_library: '@oai/artifact-tool', font, font_availability: 'Helvetica Neue is installed on authoring host; target Excel environment not tested.', formula_assertions: checks.length, cross_entity_allocation_total: 30000, native_excel_verified: false, results }, null, 2) + '\n');
console.log(`Created ${results.length} workbooks, ${checks.length} formula assertions, 18 matching evidence records.`);

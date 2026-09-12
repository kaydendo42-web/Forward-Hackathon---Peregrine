import type { EvidenceInput } from '../core/types';
import { assertAmount } from '../core/workflow';

export const EVIDENCE_COLUMNS = ['document_id', 'line_id', 'entity_id', 'financial_year', 'component', 'currency', 'basis', 'amount', 'description'];

export function parseMoney(raw: string | number | null): number | null {
  if (raw === null || String(raw).trim() === '') return null;
  const value = String(raw).trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(value)) throw new Error('Invalid amount: enter a number with up to two decimal places, without currency symbols or separators.');
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = value.replace('-', '').split('.');
  const cents = (Number(whole) * 100 + Number(fraction.padEnd(2, '0'))) * (negative ? -1 : 1);
  assertAmount(cents); return cents;
}

function parseCsv(text: string): string[][] {
  if (text.length > 250_000) throw new Error('Evidence CSV is too large (250 KB maximum).');
  const result: string[][] = []; let row: string[] = []; let value = ''; let quoted = false; let closed = false;
  const input = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted) {
      if (c === '"' && input[i + 1] === '"') { value += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else value += c;
      continue;
    }
    if (c === '"') {
      if (value || closed) throw new Error('Invalid CSV quote.');
      quoted = true;
    } else if (c === ',' || c === '\n' || c === '\r') {
      row.push(value); value = ''; closed = false;
      if (c !== ',') {
        if (row.some(cell => cell !== '')) result.push(row);
        row = []; if (c === '\r' && input[i + 1] === '\n') i++;
      }
    } else {
      if (closed) throw new Error('Unexpected text after a CSV quote.');
      value += c;
    }
  }
  if (quoted) throw new Error('Unclosed CSV quote.');
  row.push(value); if (row.some(cell => cell !== '')) result.push(row);
  if (result.length > 201) throw new Error('Use at most 200 evidence rows.');
  return result;
}

export function readEvidenceCsv(text: string): EvidenceInput[] {
  const rows = parseCsv(text);
  if (JSON.stringify(rows[0]) !== JSON.stringify(EVIDENCE_COLUMNS)) throw new Error(`Evidence columns must be: ${EVIDENCE_COLUMNS.join(',')}. Download a sample first.`);
  if (rows.length < 2) throw new Error('The evidence file contains no records.');
  const seen = new Set<string>();
  return rows.slice(1).map((row, index) => {
    if (row.length !== EVIDENCE_COLUMNS.length) throw new Error(`Unexpected columns on row ${index + 2}.`);
    const [documentId, lineId, entityId, year, component, currency, basis, amount, description] = row.map(c => c.trim());
    for (const field of [documentId, lineId, entityId, year, component, currency, basis, description]) {
      if (!field || field.length > 4000) throw new Error(`Required evidence field missing or too long on row ${index + 2}.`);
    }
    if (!/^20\d{2}$/.test(year)) throw new Error('Invalid financial year.');
    const identity = JSON.stringify([documentId, lineId, entityId, year, component]);
    if (seen.has(identity)) throw new Error(`Duplicate evidence row for ${documentId}.`);
    seen.add(identity);
    return { documentId, lineId, entityId, financialYear: Number(year), component, currency, basis,
      amountCents: parseMoney(amount), description, filename: '', fileHash: '' };
  });
}

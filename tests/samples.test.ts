import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { allSamplePaths, entities, evidencePath } from '../src/lib/samples';
import { readEvidenceCsv } from '../src/lib/evidence';

const publicDir = join(process.cwd(), 'public');

it('every linked sample file exists in public/', () => {
  const missing = allSamplePaths().filter(p => !existsSync(join(publicDir, p)));
  expect(missing).toEqual([]);
});

it('published FY25 evidence CSVs parse and belong to their entity', () => {
  for (const entity of entities) {
    const records = readEvidenceCsv(readFileSync(join(publicDir, evidencePath(entity.id)), 'utf8'));
    expect(records.length).toBeGreaterThan(0);
    expect(records.every(r => r.entityId === entity.id && r.financialYear === 2025)).toBe(true);
  }
});

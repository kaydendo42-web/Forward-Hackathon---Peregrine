import type { Baseline, EvidenceInput } from '../src/core/types';
export const baseline: Baseline = {
  workbookId: 'FY25-alex-taylor', entityId: 'alex-taylor', entityName: 'Alex Taylor', entityType: 'individual',
  financialYear: 2025, baselineVersion: 1, synthetic: true,
  lines: [{ id: 'ALE-DIV-CASH', category: 'dividends', label: 'Cash dividends', component: 'cash',
    amountCents: 480000, currency: 'AUD', basis: 'cash', sourceRef: 'FY25-DIV', requestText: 'Please provide current-year dividend statements.', recurrence: 'annual' }],
};
export const evidence: EvidenceInput = {
  documentId: 'FY26-DIV-A', lineId: 'ALE-DIV-CASH', entityId: 'alex-taylor', financialYear: 2026,
  component: 'cash', currency: 'AUD', basis: 'cash', amountCents: 420000,
  description: 'Synthetic issuer statement A', filename: 'dividend-a.csv', fileHash: 'hash-a',
};

export const entities = [
  { id: 'alex-taylor', name: 'Alex Taylor', type: 'Individual' },
  { id: 'sam-taylor', name: 'Sam Taylor', type: 'Individual' },
  { id: 'taylor-services', name: 'Taylor Services Pty Ltd', type: 'Company' },
  { id: 'taylor-family-trust', name: 'Taylor Family Trust', type: 'Trust' },
] as const;

export function workbookPath(entityId: string) { return `/samples/fy25/${entityId}-FY25.xlsx`; }
export function evidencePath(entityId: string) { return `/samples/fy25/${entityId}-evidence-FY25.csv`; }

export const fy26Samples = [
  { file: 'alex-dividend-a.csv', label: 'Alex cash dividends — $4,200' },
  { file: 'alex-dividend-b.csv', label: 'Alex missing cash dividends — $1,000' },
  { file: 'alex-wrong-year.csv', label: 'Wrong-year rejection test' },
  { file: 'alex-franking-credit.csv', label: 'Alex franking credits — separate component' },
  { file: 'company-bank.csv', label: 'Company bank closing balance' },
] as const;

export function fy26Path(file: string) { return `/samples/fy26/${file}`; }

/** Every public path the Files tab links to. Tested against the public folder. */
export function allSamplePaths() {
  return [...entities.flatMap(e => [workbookPath(e.id), evidencePath(e.id)]), ...fy26Samples.map(s => fy26Path(s.file))];
}

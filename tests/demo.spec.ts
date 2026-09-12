import { expect, test } from '@playwright/test';
import ExcelJS from 'exceljs';

test('workbook → outreach → evidence gap → review survives a reload', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Collection workspace' })).toBeVisible();
  await page.getByRole('button', { name: 'Load synthetic family' }).click();
  await expect(page.getByText('4 baselines imported')).toBeVisible();
  await page.getByRole('button', { name: 'Generate FY26 requests' }).click();
  await page.getByRole('button', { name: 'Draft initial outreach' }).click();
  await expect(page.getByText('Draft created. No email was sent.')).toBeVisible();
  await page.getByRole('button', { name: 'Cash dividends', exact: true }).click();
  await page.getByLabel('FY26 comparison amount (AUD)').fill('5200');
  await page.getByRole('button', { name: 'Save comparison' }).click();
  await page.getByLabel('Evidence CSV').setInputFiles('public/samples/fy26/alex-wrong-year.csv');
  await expect(page.getByTestId('error')).toContainText('Evidence financialYear mismatch: expected 2026, received 2025');
  await page.getByLabel('Evidence CSV').setInputFiles('public/samples/fy26/alex-dividend-a.csv');
  await expect(page.getByTestId('difference')).toContainText('$1,000.00');
  await page.getByLabel('Evidence CSV').setInputFiles('public/samples/fy26/alex-dividend-b.csv');
  await expect(page.getByTestId('difference')).toContainText('$0.00');
  await page.getByLabel('Review note').fill('Both synthetic issuer statements checked against the FY26 comparison.');
  await page.getByRole('button', { name: 'Accept evidence for demo' }).click();
  await expect(page.getByTestId('selected-status')).toContainText('Accepted for demo');
  await page.reload();
  await page.getByRole('button', { name: 'Cash dividends', exact: true }).click();
  await expect(page.getByTestId('selected-status')).toContainText('Accepted for demo');
  await expect(page.getByText('No live integrations')).toBeVisible();

  // Adviser handoff: export, edit only decision/review_note in Excel, preview, confirm.
  const [exported] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export review workbook' }).click()]);
  expect(exported.suggestedFilename()).toMatch(/^alex-taylor-FY26-review-v\d+\.xlsx$/);
  const book = new ExcelJS.Workbook();
  await book.xlsx.readFile((await exported.path())!);
  const review = book.getWorksheet('Review')!;
  const interestRow = [7, 8, 9, 10, 11].find(r => review.getCell(r, 2).value === 'ALE-INT')!;
  review.getCell(interestRow, 7).value = 'not_applicable';
  review.getCell(interestRow, 8).value = 'Synthetic: account closed before 1 July 2025.';
  const edited = Buffer.from(await book.xlsx.writeBuffer());
  const reviewFile = { name: 'edited-review.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: edited };
  await page.getByLabel('Review workbook').setInputFiles(reviewFile);
  await expect(page.getByRole('heading', { name: '1 proposed review changes' })).toBeVisible();
  await page.getByRole('button', { name: 'Confirm review changes' }).click();
  await expect(page.getByText('Review changes confirmed in the demo.')).toBeVisible();
  await page.getByRole('button', { name: 'Bank interest', exact: true }).click();
  await expect(page.getByTestId('selected-status')).toContainText('Not applicable');

  // The confirmed import advanced the version, so the same export is now stale.
  await page.getByLabel('Review workbook').setInputFiles(reviewFile);
  await expect(page.getByTestId('error')).toContainText('Stale workbook');
});

test('rejects a workbook without named tables and remains usable on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const book = new ExcelJS.Workbook();
  book.addWorksheet('Data').addRow(['line_id', 'entity_id']);
  const bytes = Buffer.from(await book.xlsx.writeBuffer());
  await page.getByLabel('FY25 workbook').setInputFiles({ name: 'no-tables.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: bytes });
  await expect(page.getByTestId('error')).toContainText('Expected exactly one named table Peregrine_Metadata');
  await expect(page.getByText('Review baseline import')).toHaveCount(0);
  await page.getByRole('button', { name: 'Load synthetic family' }).click();
  await expect(page.getByText('4 baselines imported')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Collection workspace' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

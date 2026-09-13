import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import ExcelJS from 'exceljs';

const STATEMENT = readFileSync('tests/fixtures/intake/statement.jpg');
const SHA = createHash('sha256').update(STATEMENT).digest('hex');

test('reply attachment → read → mismatch blocks accept → adviser override → evidence linked → reload persists', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Load synthetic family' }).click();
  await page.getByRole('button', { name: /^Taylor Family Trust/ }).click();
  await page.getByRole('button', { name: 'Generate FY26 requests' }).click();
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await page.getByLabel('Inbox passcode').fill('demo');
  await page.route('**/api/inbox', route => route.fulfill({ json: { checkedAt: new Date().toISOString(), messages: [{
    messageId: '<reply-9@example.com>', inReplyTo: null, references: [], from: 'taylorfamilyexample@gmail.com', date: new Date().toISOString(),
    subject: 'Trust documents', text: 'Attached as requested.', textTruncated: false,
    attachments: [{ filename: 'statement.jpg', size: STATEMENT.length, contentType: 'image/jpeg' }] }] } }));
  await page.getByRole('button', { name: 'Check inbox' }).click();
  await expect(page.getByTestId('inbox-reply')).toHaveCount(1);

  await page.route('**/api/intake', async route => {
    const body = route.request().postDataJSON();
    expect(body.messageId).toBe('<reply-9@example.com>');
    expect(body.context.requests.some((r: { id: string }) => r.id === 'taylor-family-trust:2026:TR-BANK')).toBe(true);
    await route.fulfill({ json: {
      file: { filename: 'statement.jpg', contentType: 'image/jpeg', size: STATEMENT.length, sha256: SHA, bytesBase64: STATEMENT.toString('base64') },
      proposal: { messageId: '<reply-9@example.com>', attachmentIndex: 0, filename: 'statement.jpg', contentType: 'image/jpeg', size: STATEMENT.length, fileHash: SHA,
        model: 'meta/llama-3.2-11b-vision-instruct', promptVersion: 'intake-1', createdAt: new Date().toISOString(), source: 'image',
        documents: [{ docType: 'Trust Account Statement', entityNameSeen: 'Oakwood Family Trust', periodStart: '1 June 2026', periodEnd: '30 June 2026',
          amounts: [{ label: 'Closing Balance', amountCents: 10812500 }], proposedEntityId: '', proposedRequestId: '', confidence: 'medium', reason: 'Bank statement for a trust',
          flags: { nameMatch: 'mismatch', periodInYear: true, syntheticMarker: true, targetValid: false } }] } } });
  });
  await page.getByRole('button', { name: 'Read 1 attachment' }).click();
  const doc = page.getByTestId('intake-document');
  await expect(doc).toContainText('Name mismatch');
  await expect(doc).toContainText('Synthetic marker seen');
  await expect(page.getByRole('img', { name: 'Attachment statement.jpg' })).toBeVisible();
  await expect(doc.getByRole('button', { name: /Accept/ })).toBeDisabled();

  await doc.getByLabel('Entity').selectOption('taylor-family-trust');
  await doc.getByLabel('Request line').selectOption('taylor-family-trust:2026:TR-BANK');
  await expect(doc.getByRole('button', { name: 'Accept with adviser override' })).toBeEnabled();
  await doc.getByRole('button', { name: 'Accept with adviser override' }).click();
  await expect(page.getByTestId('intake-linked')).toContainText('Linked to');

  await page.getByTestId('intake-linked').getByRole('button', { name: 'Open request' }).click();
  await expect(page.getByText(`intake-${SHA.slice(0, 16)}-0`)).toBeVisible();
  await expect(page.getByText('$108,125.00').first()).toBeVisible();

  // The accepted photo lands in the exported FY26 workbook: Evidence row + embedded image.
  const [exported] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export review workbook' }).click()]);
  const book = new ExcelJS.Workbook(); await book.xlsx.readFile((await exported.path())!);
  const evidenceRows = book.getWorksheet('Evidence')!.getSheetValues().slice(2).map(r => (r as unknown[]).slice(1));
  expect(evidenceRows.some(r => r[1] === 'TR-BANK' && r[3] === 'statement.jpg' && String(r[4]).startsWith('Reply attachment'))).toBe(true);
  expect(book.getWorksheet('Attachments')!.getImages()).toHaveLength(1);

  await page.reload();
  await page.getByRole('button', { name: /^Taylor Family Trust/ }).click();
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await expect(page.getByTestId('intake-linked')).toContainText('Linked to');
  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  await expect(page.getByText(/adviser override/).first()).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await expect(page.getByTestId('intake-proposal')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('with the route unconfigured the reply still shows and the error is visible', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Load synthetic family' }).click();
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await page.getByLabel('Inbox passcode').fill('demo');
  await page.route('**/api/inbox', route => route.fulfill({ json: { checkedAt: new Date().toISOString(), messages: [{
    messageId: '<reply-10@example.com>', inReplyTo: null, references: [], from: 'taylorfamilyexample@gmail.com', date: new Date().toISOString(),
    subject: 'Photos', text: '', textTruncated: false, attachments: [{ filename: 'a.jpg', size: 10, contentType: 'image/jpeg' }] }] } }));
  await page.getByRole('button', { name: 'Check inbox' }).click();
  await page.route('**/api/intake', route => route.fulfill({ status: 503, json: { error: 'Attachment intake is not configured on this deployment.' } }));
  await page.getByRole('button', { name: 'Read 1 attachment' }).click();
  await expect(page.getByTestId('error')).toContainText('not configured');
  await expect(page.getByTestId('intake-proposal')).toHaveCount(0);
});

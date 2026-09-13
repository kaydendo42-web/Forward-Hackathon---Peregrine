import { expect, test } from '@playwright/test';

test('sent request → matched reply → explicit acceptance → reload and duplicate poll', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Load synthetic family' }).click();
  await expect(page.getByText('4 baselines imported')).toBeVisible();
  await page.getByRole('button', { name: 'Generate FY26 requests' }).click();
  await page.getByRole('button', { name: 'Draft initial outreach' }).click();
  await page.getByRole('button', { name: /^Outbox/ }).click();
  let releaseSend!: () => void;
  const sendGate = new Promise<void>(resolve => { releaseSend = resolve; });
  await page.route('**/api/send', async route => {
    await sendGate;
    await route.fulfill({ json: { receipt: { to: 'taylorfamilyexample@gmail.com', messageId: '<outgoing@example.com>', sentAt: new Date().toISOString() } } });
  });
  await page.getByRole('button', { name: 'Send to family (demo)' }).click();
  await page.getByLabel('Demo passcode').fill('demo');
  await page.getByRole('button', { name: 'Confirm and send' }).click();
  await expect(page.getByRole('button', { name: 'Load synthetic family' })).toBeDisabled();
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Check inbox' })).toBeDisabled();
  releaseSend();
  await expect(page.getByText(/Emailed taylorfamilyexample/)).toBeVisible();
  await page.getByRole('button', { name: /^Outbox/ }).click();
  await expect(page.getByTestId('draft-status')).toContainText('Sent to');
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await page.route('**/api/inbox', route => route.fulfill({ status: 503, json: { error: 'Inbox is not configured on this deployment.' } }));
  await page.getByRole('button', { name: 'Check inbox' }).click();
  await expect(page.getByTestId('error')).toContainText('Inbox is not configured');
  await page.unroute('**/api/inbox');
  const text = 'I opened a new investment account during FY26.';
  await page.route('**/api/inbox', route => route.fulfill({ json: { checkedAt: new Date().toISOString(), messages: [{
    messageId: '<reply@example.com>', inReplyTo: '<outgoing@example.com>', references: [], from: 'taylorfamilyexample@gmail.com',
    date: new Date().toISOString(), subject: 'Re: Alex FY26 requests', text, textTruncated: false,
    attachments: [{ filename: 'statement.csv', contentType: 'text/csv', size: 1200 }],
  }] } }));
  await page.getByRole('button', { name: 'Check inbox' }).click();
  await expect(page.getByTestId('inbox-reply')).toContainText('Matched to:');
  await expect(page.getByRole('button', { name: /^Read \d+ attachments?$/ })).toBeVisible();   // attachments are listed; nothing downloaded until asked
  await page.getByRole('button', { name: 'Open request and AI assist' }).click();
  await expect(page.getByLabel('Client answer')).toHaveValue('');
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await page.getByRole('button', { name: 'Accept reply as answer' }).click();
  await expect(page.getByTestId('reply-accepted')).toBeVisible();
  await page.getByRole('button', { name: 'Open request and AI assist' }).click();
  await expect(page.getByLabel('Client answer')).toHaveValue(text);
  await expect(page.getByTestId('selected-status')).toContainText('Needs adviser review');
  await expect(page.getByRole('button', { name: 'Triage reported changes' })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await expect(page.getByTestId('reply-accepted')).toBeVisible();
  await page.getByRole('button', { name: 'Check inbox' }).click();
  await expect(page.getByText('Inbox checked: 0 new replies. No answers applied automatically.')).toBeVisible();
  await expect(page.getByTestId('inbox-reply')).toHaveCount(1);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByLabel('Client-view simulation').check();
  await expect(page.getByRole('button', { name: 'Check inbox' })).toHaveCount(0);
});

test('unmatched replies need an explicit request and manual confirmation', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Load synthetic family' }).click();
  await expect(page.getByText('4 baselines imported')).toBeVisible();
  await page.getByRole('button', { name: 'Generate FY26 requests' }).click();
  await page.route('**/api/inbox', route => route.fulfill({ json: { checkedAt: new Date().toISOString(), messages: [{
    messageId: '<unmatched@example.com>', inReplyTo: null, references: [], from: 'taylorfamilyexample@gmail.com',
    date: new Date().toISOString(), subject: 'New information', text: 'No changes for FY26.', textTruncated: false, attachments: [],
  }] } }));
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await page.getByLabel('Inbox passcode').fill('demo');
  await page.getByRole('button', { name: 'Check inbox' }).click();
  await expect(page.getByRole('button', { name: 'Accept reply as answer' })).toBeDisabled();
  await page.getByLabel('Assign reply to request').selectOption({ label: 'Current-year changes · FY2026' });
  await expect(page.getByRole('button', { name: 'Accept reply as answer' })).toBeDisabled();
  await page.getByLabel(/I confirm this reply belongs to Alex Taylor/).check();
  await page.getByRole('button', { name: 'Accept reply as answer' }).click();
  await expect(page.getByTestId('reply-accepted')).toBeVisible();
  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  await expect(page.getByText(/explicit manual assignment/)).toBeVisible();
});

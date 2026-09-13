import { expect, test } from '@playwright/test';

test('one warm family email covers every entity with outstanding items', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Load synthetic family' }).click();
  await page.getByRole('button', { name: 'Generate FY26 requests' }).click();           // Alex
  await page.getByRole('button', { name: /^Taylor Family Trust/ }).click();
  await page.getByRole('button', { name: 'Generate FY26 requests' }).click();           // Trust
  await page.getByRole('button', { name: 'Draft family email' }).click();
  await expect(page.locator('.feedback .notice')).toContainText('Family email drafted for Alan Taylor');
  await page.getByRole('button', { name: /^Outbox/ }).click();
  const draft = page.locator('article.draft').first();
  await expect(draft).toContainText('FY2026 information request — Taylor family (2 entities)');
  await expect(draft).toContainText('Family group · one email to Alan Taylor');
  await expect(draft.locator('pre')).toContainText('Hi Alan,');
  await expect(draft.locator('pre')).toContainText('Alex Taylor');
  await expect(draft.locator('pre')).toContainText('Taylor Family Trust');
  await expect(draft.locator('pre')).toContainText('Reply to this email with documents attached');
  // The same draft is visible from another member entity, and the tab count agrees.
  await page.getByRole('button', { name: /^Alex Taylor/ }).click();
  await expect(page.getByRole('button', { name: /^Outbox \(1\)/ })).toBeVisible();
  await page.getByRole('button', { name: /^Outbox/ }).click();
  await expect(page.locator('article.draft').first()).toContainText('Taylor family (2 entities)');
  // Drafting again with nothing changed adds nothing.
  await page.getByRole('button', { name: 'Requests', exact: true }).click();
  await page.getByRole('button', { name: 'Draft family email' }).click();
  await expect(page.getByRole('button', { name: /^Outbox \(1\)/ })).toBeVisible();
});

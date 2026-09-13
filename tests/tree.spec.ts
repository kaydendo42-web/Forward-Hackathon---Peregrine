import { expect, test } from '@playwright/test';

test('sidebar tree shows what each entity is missing and opens a request line', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Load synthetic family' }).click();
  await expect(page.getByTestId('tree-totals')).toContainText('4 of 4 baselines loaded');
  await page.getByRole('button', { name: 'Generate FY26 requests' }).click();
  await expect(page.getByTestId('tree-totals')).toContainText('awaiting client');
  const alex = page.getByRole('button', { name: /^Alex Taylor/ });
  await expect(alex).toContainText('awaiting client');
  await expect(alex).toHaveAttribute('aria-expanded', 'true');
  const lines = page.getByRole('list', { name: 'Alex Taylor request lines' });
  await expect(lines.getByRole('button')).toHaveCount(6);
  await lines.getByRole('button', { name: /Cash dividends/ }).click();
  await expect(page.getByRole('heading', { name: /Cash dividends/ })).toBeVisible();
  await expect(lines.getByRole('button', { name: /Cash dividends/ })).toHaveAttribute('aria-current', 'true');
  // Another entity collapses Alex and shows its own state.
  await page.getByRole('button', { name: /^Sam Taylor/ }).click();
  await expect(page.getByRole('list', { name: 'Alex Taylor request lines' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Sam Taylor/ })).toContainText('no FY26 requests yet');
  await page.getByRole('button', { name: 'Generate FY26 for whole family' }).click();
  await expect(page.getByRole('button', { name: /^Sam Taylor/ })).toContainText('awaiting client');
  await expect(page.getByRole('button', { name: /^Taylor Services/ })).toContainText('awaiting client');
  await expect(page.getByRole('button', { name: 'Generate FY26 for whole family' })).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

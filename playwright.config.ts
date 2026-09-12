import { defineConfig } from '@playwright/test';

// Set PLAYWRIGHT_BASE_URL to run the journeys against a deployed URL instead of the local dev server.
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3000';

export default defineConfig({
  testDir: './tests', testMatch: '**/*.spec.ts', workers: 1,
  use: { baseURL, headless: true,
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {} },
  webServer: process.env.PLAYWRIGHT_BASE_URL ? undefined
    : { command: 'npm run dev', url: baseURL, reuseExistingServer: !process.env.CI, timeout: 60000 },
});

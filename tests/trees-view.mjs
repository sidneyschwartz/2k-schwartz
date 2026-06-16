// Wide-angle screenshot to verify trees look good. Uses ?hole=4 (Birch Bend —
// tree-lined par-4) and takes the shot at a moment when many trees are in
// frame.

import { chromium } from 'playwright';

const URL = process.env.URL || 'http://localhost:3000/?golf=1';
const SHOT = 'tests/trees-view.png';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(URL, { waitUntil: 'networkidle' });
// Let scene initialize.
await page.waitForTimeout(2500);

await page.screenshot({ path: SHOT, fullPage: false });
console.log(`screenshot → ${SHOT}`);
if (errors.length) console.log('errors:\n - ' + errors.slice(0, 5).join('\n - '));
await browser.close();

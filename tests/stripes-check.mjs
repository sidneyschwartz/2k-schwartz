// Boot directly into hole 2 (Doglegs Right) — has a long fairway — and screenshot
// to verify the mowed fairway stripes are visible from the tee box.

import { chromium } from 'playwright';

const URL = process.env.URL || 'http://localhost:3000/?golf=1';
const SHOT = 'tests/stripes-check.png';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

// Advance to hole 2 via the debug sink (zeroes ball at cup → triggers hole advance)
const ok = await page.evaluate(() => {
  const c = document.getElementById('sport-host')?._golfController;
  if (!c?._debugSink) return false;
  c._debugSink();
  return true;
});
console.log('sink fired:', ok);

// Allow flyover into hole 2 to complete
await page.waitForTimeout(4000);

await page.screenshot({ path: SHOT });
console.log('screenshot →', SHOT);
if (errors.length) console.log('errors:\n - ' + errors.slice(0, 5).join('\n - '));
await browser.close();

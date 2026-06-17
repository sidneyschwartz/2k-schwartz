// Fire a driver shot on hole 1 and screenshot mid-flight to verify the fairway
// no longer renders as washed-out white.

import { chromium } from 'playwright';

const URL = process.env.URL || 'http://localhost:3000/?golf=1';
const SHOT = 'tests/flight-check.png';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

const ok = await page.evaluate(() => {
  const c = document.getElementById('sport-host')?._golfController;
  if (!c?._debugShoot) return false;
  c._debugShoot({ power: 0.9, aimYaw: 0 });
  return true;
});
console.log('shot fired:', ok);

// Mid-flight ~1.2s after launch
await page.waitForTimeout(1200);

await page.screenshot({ path: SHOT });
console.log('screenshot →', SHOT);
if (errors.length) console.log('errors:\n - ' + errors.slice(0, 5).join('\n - '));
await browser.close();

// Browser smoke test for the golf scene. Boots Vite, opens the page, captures
// JS console errors, screenshots, and inspects the canvas to detect a "blue
// screen" (no terrain rendered) condition.
//
// Run: node tests/smoke-browser.mjs
// Assumes the dev server is already running at http://localhost:3000.

import { chromium } from 'playwright';
import fs from 'node:fs';

const URL = process.env.URL || 'http://localhost:3000/?golf=1&debug=1';
const SHOT_PATH = 'tests/smoke-shot.png';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();

const consoleErrors = [];
const pageErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => { pageErrors.push(err.message); });

console.log(`opening ${URL}`);
await page.goto(URL, { waitUntil: 'networkidle' });

// Give the rAF loop ~2s to make a real frame.
await page.waitForTimeout(2000);

await page.screenshot({ path: SHOT_PATH, fullPage: false });
console.log(`screenshot → ${SHOT_PATH}`);

// Inspect the canvas pixels to detect "all blue" symptom.
const stats = await page.evaluate(() => {
  const c = document.querySelector('canvas.golf-canvas');
  if (!c) return { error: 'no canvas.golf-canvas' };
  const w = c.width, h = c.height;
  // Snapshot a center crop into a 2D canvas for pixel sampling.
  const tmp = document.createElement('canvas');
  tmp.width = w; tmp.height = h;
  const ctx = tmp.getContext('2d');
  try { ctx.drawImage(c, 0, 0); } catch (e) { return { error: 'drawImage failed: ' + e.message }; }
  let blueish = 0, total = 0, blackish = 0;
  const sampleSize = 200;
  const step = Math.max(1, Math.floor(Math.min(w, h) / sampleSize));
  const data = ctx.getImageData(0, 0, w, h).data;
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      total++;
      // "blueish" = blue dominant, low red, low green
      if (b > 120 && b > r + 20 && b > g + 20) blueish++;
      if (r < 20 && g < 20 && b < 20) blackish++;
    }
  }
  return {
    canvasW: w, canvasH: h, total,
    blueish, blackish,
    blueishPct: total ? blueish / total : 0,
    blackishPct: total ? blackish / total : 0,
    // Pull a couple of pixel samples near corners and center.
    samples: [
      { label: 'tl', px: pixel(data, w, 50, 50) },
      { label: 'center', px: pixel(data, w, w >> 1, h >> 1) },
      { label: 'br', px: pixel(data, w, w - 50, h - 50) },
    ],
  };
  function pixel(d, w, x, y) {
    const i = (y * w + x) * 4;
    return `rgba(${d[i]},${d[i+1]},${d[i+2]},${d[i+3]})`;
  }
});

const debugText = await page.evaluate(() => {
  const el = document.querySelector('pre');
  return el ? el.textContent : null;
});

console.log('canvas stats:', JSON.stringify(stats, null, 2));
console.log('debug overlay:\n' + (debugText ?? '<none>'));

if (consoleErrors.length) console.log('console errors:\n - ' + consoleErrors.join('\n - '));
if (pageErrors.length) console.log('pageerror:\n - ' + pageErrors.join('\n - '));

await browser.close();

let exit = 0;
if (stats.error) { console.error('FAIL:', stats.error); exit = 1; }
else if (stats.blueishPct > 0.85) {
  console.error(`FAIL: scene is ${(stats.blueishPct * 100).toFixed(1)}% blue — likely terrain not rendered`);
  exit = 1;
} else {
  console.log('OK: canvas has visible non-blue content');
}
if (pageErrors.length) { console.error(`FAIL: ${pageErrors.length} page errors`); exit = 1; }

process.exit(exit);

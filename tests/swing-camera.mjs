// Drives a real swing and samples camera + ball positions over time so we can see
// whether the camera loses/abandons the player after a shot.
// Run with dev server up: node tests/swing-camera.mjs

import { chromium } from 'playwright';

const URL = process.env.URL || 'http://localhost:3000/?golf=1&debug=1';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

// Helper to read engine state from the live controller.
async function snap(label) {
  const s = await page.evaluate(() => {
    const c = document.querySelector('#sport-host')?._golfController
      || window._golfController;
    // Fall back: read the debug overlay text.
    const dbg = document.querySelector('pre')?.textContent ?? '';
    return { dbg };
  });
  return { label, ...s };
}

// Three meter clicks = full swing (start power, lock power, lock accuracy).
// The swing controller listens on window for Space.
async function clickMeter() {
  await page.keyboard.press('Space');
}

console.log('=== before swing ===');
console.log((await snap('idle')).dbg);

// Swing: press space to start, wait a beat, press to lock power, wait, press to lock accuracy.
await clickMeter();                 // start power-rising
await page.waitForTimeout(450);
await clickMeter();                 // lock power
await page.waitForTimeout(250);
await clickMeter();                 // lock accuracy -> shot fires

// Sample camera + ball during the flight.
const frames = [];
for (let i = 0; i < 12; i++) {
  await page.waitForTimeout(350);
  const dbg = await page.evaluate(() => document.querySelector('pre')?.textContent ?? '');
  frames.push(dbg);
  if (i === 2) await page.screenshot({ path: 'tests/swing-flight.png' });
  if (i === 7) await page.screenshot({ path: 'tests/swing-mid.png' });
}
await page.screenshot({ path: 'tests/swing-settled.png' });

console.log('\n=== during/after flight (every 350ms) ===');
frames.forEach((f, i) => {
  const cam = f.match(/cam:\s+(.*)/)?.[1] ?? '?';
  const ball = f.match(/ball:\s+(.*)/)?.[1] ?? '?';
  const lie = f.match(/lie:\s+(.*)/)?.[1] ?? '?';
  console.log(`t+${((i + 1) * 0.35).toFixed(2)}s  cam[${cam}]  ball[${ball}]  lie[${lie}]`);
});

if (errors.length) console.log('\npage errors:\n - ' + errors.join('\n - '));
console.log('\nscreenshots: tests/swing-flight.png, tests/swing-mid.png, tests/swing-settled.png');
await browser.close();

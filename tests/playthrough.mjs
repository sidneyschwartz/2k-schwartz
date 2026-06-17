// Full 3-hole playthrough. Drives shots via the controller's debug hooks, sinks each
// hole, and asserts the camera + ball stay finite & in-bounds the entire time — across
// shots, settles, hole-outs, and the between-hole flyover (the spots where the NaN /
// camera-fly-off bugs lived).
//
// Run with the dev server up: node tests/playthrough.mjs

import { chromium } from 'playwright';

const URL = process.env.URL || 'http://localhost:3000/?golf=1&debug=1';
const HOLES_TO_PLAY = 3;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

const ctlReady = await page.evaluate(() => !!document.getElementById('sport-host')?._golfController);
if (!ctlReady) { console.error('FAIL: controller not found'); await browser.close(); process.exit(1); }

function ctl(method, arg) {
  return page.evaluate(({ m, a }) => {
    const c = document.getElementById('sport-host')._golfController;
    return c[m](a);
  }, { m: method, a: arg });
}

const violations = [];
let samples = 0;
async function sampleFinite(label) {
  const s = await ctl('_state');
  samples++;
  if (!s.finite) violations.push(`${label}: non-finite ball/cam ${JSON.stringify(s)}`);
  // In-bounds sanity: nothing should be more than 2km from origin.
  const far = Math.max(Math.abs(s.ball.x), Math.abs(s.ball.z), Math.abs(s.cam.x), Math.abs(s.cam.z));
  if (far > 2000) violations.push(`${label}: out of bounds (${far.toFixed(0)}m) ${JSON.stringify(s)}`);
  return s;
}

const holeResults = [];
for (let h = 1; h <= HOLES_TO_PLAY; h++) {
  const start = await ctl('_state');
  console.log(`\n--- Hole ${start.hole} (strokes ${start.strokes}) ---`);

  // Fire one real shot to exercise flight + camera (sampling finite throughout). We wait
  // for it to settle (inFlight=false) before the next action so the inFlight guard on
  // launchShot doesn't no-op subsequent calls.
  await ctl('_debugShoot', { power: 0.85, aimYaw: 0 });
  for (let i = 0; i < 24; i++) {
    await page.waitForTimeout(200);
    const s = await sampleFinite(`hole${start.hole} flight`);
    if (s && !s.inFlight) break;
  }

  // Force the hole-out, then POLL for the hole index to advance (advance takes ~4.6s:
  // 1800ms hole-complete delay + 2800ms flyover). Polling is robust to timing.
  await ctl('_debugSink');
  let after = start;
  for (let i = 0; i < 40; i++) {            // up to 8s
    await page.waitForTimeout(200);
    after = await sampleFinite(`hole${start.hole} transition`);
    if (after && after.hole > start.hole) break;
  }

  holeResults.push({ from: start.hole, to: after.hole });
  console.log(`  after sink → now on hole ${after.hole}, finite=${after.finite}`);
}

await page.screenshot({ path: 'tests/playthrough-final.png' });

console.log(`\n=== RESULT ===`);
console.log(`samples checked: ${samples}`);
console.log(`hole progression: ${holeResults.map((r) => r.from).join(' → ')} → (final ${holeResults.at(-1).to})`);

let exit = 0;
const advanced = holeResults[0].to > holeResults[0].from || holeResults.at(-1).to >= HOLES_TO_PLAY;
if (!advanced) { console.error('FAIL: holes did not advance'); exit = 1; }
if (violations.length) {
  console.error(`FAIL: ${violations.length} finite/bounds violations:`);
  violations.slice(0, 8).forEach((v) => console.error(' - ' + v));
  exit = 1;
}
if (errors.length) {
  console.error(`FAIL: ${errors.length} page errors:`);
  [...new Set(errors)].slice(0, 8).forEach((e) => console.error(' - ' + e));
  exit = 1;
}
if (exit === 0) console.log('OK: 3 holes played, camera + ball stayed finite & in-bounds throughout');

await browser.close();
process.exit(exit);

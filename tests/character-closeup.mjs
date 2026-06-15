// Closer look at the golfer at the tee: moves the camera in tight so we can
// verify human-readable proportions.

import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

await page.goto('http://localhost:3000/?golf=1', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

// Try to use the controller (if exposed) to position the camera.
const moved = await page.evaluate(() => {
  const host = document.querySelector('#sport-host');
  const ctrl = host?._golfController;
  if (!ctrl) return { error: 'no controller' };
  // Grab the camera and any scene we can find via the controller's debug hooks.
  const dbg = ctrl.debug?.();
  if (!dbg) return { error: 'no controller.debug' };
  const { camera, scene } = dbg;
  if (!camera) return { error: 'no camera' };
  // Position camera ~3m behind, 1.8m up, looking down toward the golfer.
  camera.position.set(0, 1.7, -3.0);
  camera.lookAt(0, 1.2, 0);
  camera.updateProjectionMatrix();
  return { ok: true, sceneObjects: scene?.children?.length ?? 0 };
});
console.log('move result:', JSON.stringify(moved));
await page.waitForTimeout(500);

await page.screenshot({ path: 'tests/character-closeup.png' });
console.log('screenshot → tests/character-closeup.png');
if (pageErrors.length) console.log('page errors:\n - ' + pageErrors.join('\n - '));

await browser.close();

// Offline carry-calibration sim — measures carry/apex/flight-time per club using the
// real physics module, no browser. Run: node tests/carry-sim.mjs
// Use this (fast) for any aero/club tuning instead of browser screenshots.
import { createPhysics } from '../src/sports/golf/physics.js';
import { clubs } from '../src/sports/golf/clubs.js';

function simulate(club) {
  const phy = createPhysics();
  const r = phy.BALL_RADIUS;
  phy.ball.position.set(0, r + 0.02, 0);
  const speed = club.maxPower;            // full power, no accuracy error
  const loft = club.loft;
  const horiz = speed * Math.cos(loft);
  const vy = speed * Math.sin(loft);
  phy.ball.velocity.set(0, vy, horiz);    // aim straight down +Z
  phy.ball.angularVelocity.set(-club.backspin, 0, 0); // backspin about -X (lift up)
  phy.ball.wakeUp();

  let maxY = 0, landZ = 0, t = 0, airborne = false;
  for (let i = 0; i < 1200; i++) {
    phy.step(1 / 60);
    t += 1 / 60;
    const p = phy.ball.position;
    if (p.y > maxY) maxY = p.y;
    if (p.y > 0.5) airborne = true;
    if (airborne && p.y <= r + 0.03) { landZ = p.z; break; }
  }
  return { carry: Math.round(landZ), apex: Math.round(maxY), time: t.toFixed(1) };
}

console.log('Club        v0    loft   spin   carry  apex  time');
console.log('--------    ----  ----   ----   -----  ----  ----');
for (const c of clubs) {
  if (c.name === 'Putter') continue;
  const r = simulate(c);
  console.log(
    c.name.padEnd(8), String(c.maxPower).padStart(5),
    String(Math.round((c.loft * 180) / Math.PI) + '°').padStart(5),
    String(c.backspin).padStart(6),
    String(r.carry + 'm').padStart(7),
    String(r.apex + 'm').padStart(5),
    String(r.time + 's').padStart(6),
  );
}

// Isolate the NaN-on-shot bug: create the physics world, launch a driver exactly
// like golf.js does, step it, and assert the ball never becomes NaN.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPhysics } from '../src/sports/golf/physics.js';
import { clubByName } from '../src/sports/golf/clubs.js';

function isFiniteVec(v) {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

test('driver launch stays finite over 6s of flight', () => {
  const physics = createPhysics();
  physics.setWind({ speed: 4, dir: 0.2 });
  physics.setGreenSlope({ ax: 0.2, az: 0.1 });

  const club = clubByName('Driver');
  // place ball on tee
  physics.ball.position.set(0, physics.BALL_RADIUS + 0.02, 0);
  physics.ball.velocity.set(0, 0, 0);
  physics.ball.angularVelocity.set(0, 0, 0);
  physics.ball.wakeUp();

  // launch (replicate golf.js math, power 0.9, no accuracy error)
  const power = 0.9, accuracyError = 0.0, yaw = 0;
  const speed = club.maxPower * Math.max(0.05, power);
  const loft = club.loft;
  const dirX = Math.sin(yaw), dirZ = Math.cos(yaw);
  physics.ball.velocity.set(dirX * speed * Math.cos(loft), speed * Math.sin(loft), dirZ * speed * Math.cos(loft));
  const sideAxisX = -dirZ, sideAxisZ = dirX;
  physics.ball.angularVelocity.set(sideAxisX * club.backspin, accuracyError * club.sidespinScale * 400, sideAxisZ * club.backspin);

  assert.ok(isFiniteVec(physics.ball.velocity), 'velocity finite at launch');

  for (let i = 0; i < 360; i++) { // 6s @ 60Hz
    physics.step(1 / 60);
    assert.ok(isFiniteVec(physics.ball.position), `ball position NaN at step ${i}`);
    assert.ok(isFiniteVec(physics.ball.velocity), `ball velocity NaN at step ${i}`);
  }
});

test('putt with green slope stays finite', () => {
  const physics = createPhysics();
  physics.setGreenSlope({ ax: 0.25, az: 0.2 });
  physics.ball.position.set(0, physics.BALL_RADIUS, 5);
  physics.ball.velocity.set(0, 0, -3); // rolling putt
  physics.ball.angularVelocity.set(0, 0, 0);
  physics.ball.wakeUp();
  for (let i = 0; i < 240; i++) {
    physics.step(1 / 60);
    assert.ok(Number.isFinite(physics.ball.position.x), `putt NaN at step ${i}`);
  }
});

// Lie detection sanity. Verifies that the ball-on-surface classifier hits the right
// region type for points placed on known features of hole 1 (Lakeside par-3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOLES } from '../src/sports/golf/course/holes.js';
import { lieAt } from '../src/sports/golf/course/terrain.js';
import { shotModifiers, LIE_LABELS } from '../src/sports/golf/lies.js';

const hole1 = HOLES[0]; // Lakeside

test('tee position reads as tee', () => {
  assert.equal(lieAt(hole1.tee.x, hole1.tee.z, hole1), 'tee');
});

test('pin position reads as green', () => {
  assert.equal(lieAt(hole1.pin.x, hole1.pin.z, hole1), 'green');
});

test('a point in the lake reads as water', () => {
  // Water rect at (0, 70, w=60, d=80) — center is in the lake
  const water = hole1.regions.find((r) => r.type === 'water');
  assert.ok(water);
  const lie = lieAt(water.x, water.z, hole1);
  assert.equal(lie, 'water');
});

test('shotModifiers returns identity-ish for fairway', () => {
  const mods = shotModifiers('fairway');
  assert.equal(mods.powerMul, 1);
  assert.equal(mods.spinMul, 1);
});

test('shotModifiers penalizes sand more than rough', () => {
  const sand = shotModifiers('sand');
  const rough = shotModifiers('rough');
  assert.ok(sand.powerMul < rough.powerMul, 'sand should hurt power more than rough');
  assert.ok(sand.loftBias >= rough.loftBias, 'sand should add at least as much loft as rough');
});

test('LIE_LABELS covers all surface types', () => {
  ['tee', 'fairway', 'rough', 'sand', 'green', 'water', 'oob'].forEach((k) => {
    assert.ok(LIE_LABELS[k], `missing label for ${k}`);
  });
});

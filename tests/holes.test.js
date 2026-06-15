// Holes data sanity. Catches typos like missing pin/tee or zero-yardage holes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOLES, getHole, holeCount, coursePar } from '../src/sports/golf/course/holes.js';

test('18 holes defined, numbered 1..18, each with par 3/4/5', () => {
  assert.equal(HOLES.length, 18);
  assert.equal(holeCount(), 18);
  HOLES.forEach((h, i) => {
    assert.equal(h.number, i + 1, `hole at index ${i} should be number ${i + 1}`);
    assert.ok([3, 4, 5].includes(h.par), `hole ${h.number} par must be 3/4/5`);
    assert.ok(typeof h.name === 'string' && h.name.length > 0);
    assert.ok(h.yardage > 50 && h.yardage < 700, `hole ${h.number} yardage out of range`);
    assert.ok(h.tee && typeof h.tee.x === 'number' && typeof h.tee.z === 'number');
    assert.ok(h.pin && typeof h.pin.x === 'number' && typeof h.pin.z === 'number');
    assert.ok(Array.isArray(h.regions) && h.regions.length > 0);
  });
});

test('coursePar is between 70 and 73 (sanity)', () => {
  const p = coursePar();
  assert.ok(p >= 70 && p <= 73, `expected par ~72, got ${p}`);
});

test('getHole returns hole 1 for invalid input', () => {
  assert.equal(getHole(99).number, 1);
  assert.equal(getHole(0).number, 1);
});

test('each hole has a green region with non-zero radius', () => {
  for (const h of HOLES) {
    const green = h.regions.find((r) => r.type === 'green');
    assert.ok(green, `hole ${h.number} missing green`);
    assert.ok(green.r > 5, `hole ${h.number} green radius too small`);
  }
});

test('each hole has a tee region', () => {
  for (const h of HOLES) {
    const tee = h.regions.find((r) => r.type === 'tee');
    assert.ok(tee, `hole ${h.number} missing tee`);
  }
});

// Clubs sanity: 5 expected clubs, distance ordering matches reality, putter is special.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clubs, clubByName } from '../src/sports/golf/clubs.js';

test('5 clubs defined in long-to-short order (except putter)', () => {
  assert.equal(clubs.length, 5);
  // Driver > 5-Iron > 9-Iron > Wedge in maxPower
  const fullSwingClubs = clubs.filter((c) => c.name !== 'Putter');
  for (let i = 0; i < fullSwingClubs.length - 1; i++) {
    assert.ok(
      fullSwingClubs[i].maxPower > fullSwingClubs[i + 1].maxPower,
      `${fullSwingClubs[i].name} should have more power than ${fullSwingClubs[i + 1].name}`,
    );
  }
});

test('loft ascends as clubs get shorter (except putter)', () => {
  const driver = clubByName('Driver');
  const fiveI = clubByName('5-Iron');
  const wedge = clubByName('Wedge');
  assert.ok(driver.loft < fiveI.loft);
  assert.ok(fiveI.loft < wedge.loft);
});

test('putter has minimal loft and minimal power', () => {
  const putter = clubByName('Putter');
  assert.ok(putter.loft < 0.2, 'putter loft should be ~0');
  assert.ok(putter.maxPower < 20, 'putter maxPower should be ground-roll speed, not flight');
});

test('clubByName fallback returns first club', () => {
  assert.equal(clubByName('Nonexistent').name, clubs[0].name);
});

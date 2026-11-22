// Water per day, from the total volume of a device, in the timezone of Gladys.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayOf, shiftDay, noteTotal, litersOf, lastDays, KEEP_DAYS } from '../src/consumption.js';

const ZONE = 'Europe/Paris';

test('days in the timezone of Gladys, across months', () => {
  assert.equal(dayOf(Date.parse('2026-11-22T23:30:00Z'), ZONE), '2026-11-23');
  assert.equal(dayOf(Date.parse('2026-11-22T23:30:00Z'), 'UTC'), '2026-11-22');
  assert.equal(shiftDay('2026-03-01', -1), '2026-02-28');
  assert.equal(shiftDay('2026-12-31', 1), '2027-01-01');
});

test('the first total of each day, today so far, a meter reset starts again', () => {
  const usage = {};
  noteTotal(usage, 1000, Date.parse('2026-11-21T08:00:00Z'), ZONE);
  noteTotal(usage, 1150, Date.parse('2026-11-21T20:00:00Z'), ZONE);
  noteTotal(usage, 1200, Date.parse('2026-11-22T06:00:00Z'), ZONE);
  noteTotal(usage, 1260, Date.parse('2026-11-22T12:00:00Z'), ZONE);
  noteTotal(usage, null, Date.parse('2026-11-22T12:30:00Z'), ZONE);
  assert.deepEqual(usage.days, { '2026-11-21': 1000, '2026-11-22': 1200 });
  assert.equal(litersOf(usage, '2026-11-21', '2026-11-22'), 200);
  assert.equal(litersOf(usage, '2026-11-22', '2026-11-22'), 60);
  assert.equal(litersOf(usage, '2026-11-20', '2026-11-22'), null);
  const days = lastDays(usage, 3, Date.parse('2026-11-22T12:00:00Z'), ZONE);
  assert.deepEqual(days, [
    { day: '2026-11-20', liters: null },
    { day: '2026-11-21', liters: 200 },
    { day: '2026-11-22', liters: 60 },
  ]);
  noteTotal(usage, 5, Date.parse('2026-11-22T13:00:00Z'), ZONE);
  assert.deepEqual(usage.days, { '2026-11-22': 5 });
});

test(`${KEEP_DAYS} days kept`, () => {
  const usage = {};
  const start = Date.parse('2026-01-01T12:00:00Z');
  for (let day = 0; day < 60; day += 1) {
    noteTotal(usage, day * 100, start + day * 24 * 3600 * 1000, ZONE);
  }
  assert.equal(Object.keys(usage.days).length, KEEP_DAYS);
});

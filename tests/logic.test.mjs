import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTrains, board, departures, connect, plan, defaultDirection, FILTERS, ST, DEFAULT_RIDES, DEFAULT_SETTINGS } from '../logic.js';

const raw = JSON.parse(readFileSync(new URL('./fixture.json', import.meta.url)));
const trains = parseTrains(raw);
const S = { ...DEFAULT_SETTINGS, apiKey: 'x' };

test('parseTrains drops no-passenger, blank and --- entries; ARR/BRD become 0', () => {
  assert.equal(trains.length, 18); // 20 rows minus "No Passenger" and "---"
  assert.ok(trains.every(t => typeof t.min === 'number'));
  assert.equal(trains.find(t => t.station === 'A02' && t.line === 'RD' && t.destCode === 'B11').min, 0);
  assert.equal(trains.find(t => t.station === 'K03' && t.destCode === 'K08').min, 0);
});

test('direction filters', () => {
  const vn = board(trains, ST.VAN_NESS, FILTERS.redSouth, 0);
  assert.deepEqual(vn.map(t => t.min), [3, 11, 16, 22]); // no Shady Grove train
  const fw = board(trains, ST.FARRAGUT_WEST, FILTERS.orsvWest, 0);
  assert.deepEqual(fw.map(t => t.min), [4, 9, 15]); // no Blue, no eastbound
  const fwEast = board(trains, ST.FARRAGUT_WEST, FILTERS.orsvEast, 0);
  assert.deepEqual(fwEast.map(t => t.min), [3, 8]);
  const fnNorth = board(trains, ST.FARRAGUT_NORTH, FILTERS.redNorth, 0);
  assert.deepEqual(fnNorth.map(t => t.min), [2, 9]);
  const vsEast = board(trains, ST.VIRGINIA_SQ, FILTERS.orsvEast, 0);
  assert.deepEqual(vsEast.map(t => t.min), [2, 9]);
});

test('board ages predictions by elapsed time', () => {
  const vn = board(trains, ST.VAN_NESS, FILTERS.redSouth, 2);
  assert.deepEqual(vn.map(t => t.away), [1, 9, 14, 20]);
});

test('departures: walk 10 + cushion 2', () => {
  const d = departures(board(trains, ST.VAN_NESS, FILTERS.redSouth, 0), 10, 2);
  assert.deepEqual(d.map(x => [x.train.min, x.leaveIn, x.status]), [
    [3, -9, 'gone'], [11, -1, 'hurry'], [16, 4, 'ok'], [22, 10, 'ok'],
  ]);
});

test('connect picks first reachable train, rates slack, flags hustle', () => {
  const fw = board(trains, ST.FARRAGUT_WEST, FILTERS.orsvWest, 0); // 4, 9, 15
  const a = connect(8, fw, 5);
  assert.equal(a.train.min, 9); assert.equal(a.wait, 1); assert.equal(a.rating, 'tight');
  assert.equal(a.hustle, null);
  const b = connect(5, fw, 5);
  assert.equal(b.train.min, 9); assert.equal(b.rating, 'comfortable'); assert.equal(b.hustle.min, 4);
  const c = connect(30, fw, 5);
  assert.equal(c.estimate, true); assert.equal(c.wait, 2.5);
  const e = connect(3, [], 5);
  assert.equal(e.estimate, true);
});

test('morning plan', () => {
  const p = plan('am', trains, S, DEFAULT_RIDES, 0);
  assert.equal(p.hero.train.min, 16);
  assert.equal(p.hero.leaveIn, 4);
  assert.equal(p.hurry.train.min, 11);
  // 16 + 9 ride + 4 walk = 29, beyond FW board -> estimate: +2.5 wait +11 ride +4 walk
  assert.equal(p.hero.conn.estimate, true);
  assert.equal(p.hero.arriveIn, 29 + 2.5 + 11 + 4);
  // crossing: Red at Farragut North southbound 0 and 6
  assert.deepEqual(p.crossing.map(c => c.train.min), [0, 6]);
  assert.equal(p.crossing[0].conn.train.min, 4);  // ready at 4 -> Vienna at 4, 0 slack
  assert.equal(p.crossing[0].conn.rating, 'tight');
  assert.equal(p.crossing[1].conn.train.min, 15); // ready at 10 -> 15, comfortable
  assert.equal(p.crossing[1].conn.hustle.min, 9);
});

test('evening plan', () => {
  const p = plan('pm', trains, S, DEFAULT_RIDES, 0);
  // Va Sq eastbound at 2 and 9; officeWalk 4 + cushion 2 -> leaveIn -4 (gone), 3 (ok)
  assert.equal(p.hero.train.min, 9);
  assert.equal(p.hero.leaveIn, 3);
  assert.equal(p.hurry, null);
  assert.deepEqual(p.crossing.map(c => c.train.min), [3, 8]);
  assert.equal(p.crossing[0].conn.train.min, 9); // ready at 7 -> Shady Grove at 9
  assert.equal(p.transferBoard.length, 2);
});

test('defaultDirection switches at 1pm', () => {
  assert.equal(defaultDirection(new Date(2026, 9, 5, 7, 30)), 'am');
  assert.equal(defaultDirection(new Date(2026, 9, 5, 12, 59)), 'am');
  assert.equal(defaultDirection(new Date(2026, 9, 5, 13, 0)), 'pm');
});

test('empty payload is safe', () => {
  const p = plan('am', parseTrains({}), S, DEFAULT_RIDES, 0);
  assert.equal(p.hero, null);
  assert.deepEqual(p.deps, []);
});

test('live snapshot: null destination codes still sort into the right direction', () => {
  const live = parseTrains(JSON.parse(readFileSync(new URL('./live-snapshot.json', import.meta.url))));
  const am = plan('am', live, S, DEFAULT_RIDES, 0);
  assert.ok(am.deps.length > 0 && am.deps.every(d => d.train.line === 'RD' && !/shady/i.test(d.train.dest)));
  assert.ok(am.transferBoard.length > 0 && am.transferBoard.every(t => ['OR', 'SV'].includes(t.line) && /vienna|ashburn/i.test(t.dest)));
  const pm = plan('pm', live, S, DEFAULT_RIDES, 0);
  assert.ok(pm.deps.length > 0 && pm.deps.every(d => /crlt|carrollton|largo/i.test(d.train.dest)));
  assert.ok(pm.transferBoard.length > 0 && pm.transferBoard.every(t => /shady/i.test(t.dest)));
});

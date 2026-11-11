import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handle, seed, marginOf } from '../lib/core.mjs';
import { fileStore } from '../lib/store-file.mjs';
import { routeFor } from '../lib/config.mjs';

const env = { BLADE_OFFICE_PASSCODE: 'o', BLADE_FLOOR_PASSCODE: 'f' };
let store;
const call = async (passcode, method, path, body) => {
  const r = await handle(store, env, { method, path, passcode, body });
  return { status: r.status, data: r.headers['content-type'].includes('json') ? JSON.parse(r.body) : r.body };
};
const office = (m, p, b) => call('o', m, p, b);
const floor = (m, p, b) => call('f', m, p, b);
const newOrder = async (extra = {}) =>
  (await office('POST', 'orders', { customer: 'Test Co', qty: 2, type: 'SLOTTED', price: 390, ourCost: 200, by: 'K', ...extra })).data;
// Most rules are about ordinary work, so get a new blade past its serial first.
const pastLaser = async (ids) => { for (const id of [].concat(ids)) await toStep(id, 'wash_in'); };
const toStep = async (id, target) => {
  for (const step of routeFor('NEW')) {
    if (step === target) return;
    const serial = step === 'laser' ? (await floor('POST', 'laser/reserve', { bladeId: id, by: 'M' })).data.serial : undefined;
    const r = await floor('POST', 'steps/complete', { bladeIds: [id], step, by: 'M', carrier: 'UPS', serial });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
};

beforeEach(() => {
  store = fileStore(mkdtempSync(join(tmpdir(), 'blades-')));
});

test('no passcode, a wrong one, or unset env all fail closed', async () => {
  assert.equal((await call(undefined, 'GET', 'state')).status, 401);
  assert.equal((await call('nope', 'GET', 'state')).status, 401);
  const r = await handle(store, {}, { method: 'GET', path: 'state', passcode: 'o' });
  assert.equal(r.status, 401);
});

test('a blade walks every step from order to delivered', async () => {
  const { bladeIds } = await newOrder({ qty: 1 });
  await toStep(bladeIds[0], null);
  const { data } = await office('GET', 'state');
  const b = data.blades.find((x) => x.id === bladeIds[0]);
  assert.equal(b.stage, 'delivered');
  assert.equal(b.serial, 'ND0000001');
  assert.deepEqual(b.history.map((h) => h.step), ['order', 'serial', 'laser', 'wash_in', 'tipping', 'side_grind', 'face_grind', 'top_grind', 'wash_out', 'dip', 'crate', 'ship', 'deliver']);
  assert.equal(data.serials[0].status, 'lasered');
});

test('finishing the same step twice is refused', async () => {
  const { bladeIds } = await newOrder({ qty: 1 });
  await pastLaser(bladeIds);
  const body = { bladeIds, step: 'wash_in', by: 'M' };
  assert.equal((await floor('POST', 'steps/complete', body)).status, 200);
  const again = await floor('POST', 'steps/complete', body);
  assert.equal(again.status, 409);
  assert.match(again.data.error, /not at this step/);
});

test('steps cannot be skipped', async () => {
  const { bladeIds } = await newOrder({ qty: 1 });
  assert.equal((await floor('POST', 'steps/complete', { bladeIds, step: 'dip', by: 'M' })).status, 409);
});

test('a batch reports the blade that could not move and moves the rest', async () => {
  const { bladeIds } = await newOrder();
  await pastLaser(bladeIds);
  await floor('POST', 'steps/complete', { bladeIds: [bladeIds[0]], step: 'wash_in', by: 'M' });
  const r = await floor('POST', 'steps/complete', { bladeIds, step: 'wash_in', by: 'M' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.results.map((x) => x.ok), [false, true]);
});

test('the name of who did it is required', async () => {
  const { bladeIds } = await newOrder({ qty: 1 });
  assert.equal((await floor('POST', 'steps/complete', { bladeIds, step: 'wash_in' })).status, 400);
});

test('simultaneous requests for a serial never share a number', async () => {
  const { bladeIds } = await newOrder({ qty: 8 });
  for (const id of bladeIds) await toStep(id, 'laser');
  const got = await Promise.all(bladeIds.map((bladeId) => floor('POST', 'laser/reserve', { bladeId, by: 'M' })));
  const serials = got.map((g) => g.data.serial);
  assert.equal(new Set(serials).size, 8);
});

test('asking for a serial twice returns the same one', async () => {
  const { bladeIds } = await newOrder({ qty: 1 });
  await toStep(bladeIds[0], 'laser');
  const a = await floor('POST', 'laser/reserve', { bladeId: bladeIds[0], by: 'M' });
  const b = await floor('POST', 'laser/reserve', { bladeId: bladeIds[0], by: 'M' });
  assert.equal(a.data.serial, b.data.serial);
});

test('a typed serial already in the register is refused', async () => {
  const { bladeIds } = await newOrder();
  for (const id of bladeIds) await toStep(id, 'laser');
  assert.equal((await floor('POST', 'laser/reserve', { bladeId: bladeIds[0], by: 'M', serial: 'ND0000005' })).status, 200);
  const dup = await floor('POST', 'laser/reserve', { bladeId: bladeIds[1], by: 'M', serial: 'ND0000005' });
  assert.equal(dup.status, 409);
  assert.equal((await floor('POST', 'laser/reserve', { bladeId: bladeIds[1], by: 'M', serial: 'ABC' })).status, 400);
});

test('laser needs a serial first and takes one blade at a time', async () => {
  const { bladeIds } = await newOrder();
  for (const id of bladeIds) await toStep(id, 'laser');
  assert.equal((await floor('POST', 'steps/complete', { bladeIds: [bladeIds[0]], step: 'laser', by: 'M' })).status, 409);
  assert.equal((await floor('POST', 'steps/complete', { bladeIds, step: 'laser', by: 'M' })).status, 400);
});

test('a voided serial is never handed out again and frees the blade', async () => {
  const { bladeIds } = await newOrder({ qty: 1 });
  await toStep(bladeIds[0], 'laser');
  const first = await floor('POST', 'laser/reserve', { bladeId: bladeIds[0], by: 'M' });
  assert.equal((await office('POST', 'serials/void', { serial: first.data.serial, reason: 'bad burn', by: 'K' })).status, 200);
  const second = await floor('POST', 'laser/reserve', { bladeId: bladeIds[0], by: 'M' });
  assert.notEqual(second.data.serial, first.data.serial);
});

test('a serial on the steel cannot be voided', async () => {
  const { bladeIds } = await newOrder({ qty: 1 });
  await toStep(bladeIds[0], 'dip');
  const { data } = await office('GET', 'state');
  assert.equal((await office('POST', 'serials/void', { serial: data.serials[0].serial, reason: 'x', by: 'K' })).status, 409);
});

test('scrapping a lasered blade keeps its number in the register', async () => {
  const { bladeIds } = await newOrder({ qty: 1 });
  await toStep(bladeIds[0], 'dip');
  await floor('POST', 'blades/scrap', { bladeId: bladeIds[0], by: 'M', reason: 'cracked' });
  const { data } = await office('GET', 'state');
  assert.equal(data.serials[0].status, 'scrapped');
  assert.equal(data.nextSerial, 'ND0000002');
});

test('rework goes back only, and keeps the serial', async () => {
  const { bladeIds } = await newOrder({ qty: 1 });
  await toStep(bladeIds[0], 'dip');
  assert.equal((await floor('POST', 'blades/back', { bladeId: bladeIds[0], toStep: 'crate', by: 'M', reason: 'x' })).status, 409);
  assert.equal((await floor('POST', 'blades/back', { bladeId: bladeIds[0], toStep: 'side_grind', by: 'M' })).status, 400);
  const r = await floor('POST', 'blades/back', { bladeId: bladeIds[0], toStep: 'side_grind', by: 'M', reason: 'chipped tooth' });
  assert.equal(r.data.stage, 'side_grind');
  assert.equal(r.data.serial, 'ND0000001');
});

test('stock cannot ship until it is assigned to a customer order', async () => {
  const stock = (await office('POST', 'orders', { kind: 'stock', qty: 1, type: 'SOLID', by: 'K' })).data;
  const id = stock.bladeIds[0];
  const { serial } = (await floor('POST', 'laser/reserve', { bladeId: id, by: 'M' })).data;
  for (const step of routeFor('NEW').slice(0, routeFor('NEW').indexOf('ship'))) {
    await floor('POST', 'steps/complete', { bladeIds: [id], step, by: 'M', serial });
  }
  const blocked = await floor('POST', 'steps/complete', { bladeIds: [id], step: 'ship', by: 'M', carrier: 'UPS' });
  assert.equal(blocked.status, 409);
  const { order } = await newOrder({ qty: 1 });
  await office('POST', 'blades/assign', { bladeIds: [id], orderId: order.id, by: 'K', price: 345 });
  assert.equal((await floor('POST', 'steps/complete', { bladeIds: [id], step: 'ship', by: 'M', carrier: 'UPS' })).status, 200);
});

test('the floor passcode never receives money or customer contact, on reads or writes', async () => {
  const { bladeIds } = await newOrder({ qty: 1, contact: '601-555-0100' });
  const { data } = await floor('GET', 'state');
  const seen = JSON.stringify(data);
  assert.ok(!/"price"|"ourCost"|"margin"|"shipCost"|601-555/.test(seen));
  const w = await floor('POST', 'steps/complete', { bladeIds, step: 'wash_in', by: 'M' });
  assert.ok(!/"price"|"ourCost"|"margin"|"shipCost"/.test(JSON.stringify(w.data)));
});

test('the floor passcode cannot use office routes', async () => {
  for (const path of ['orders', 'blades/update', 'blades/assign', 'serials/void', 'admin/seed']) {
    assert.equal((await floor('POST', path, {})).status, 403, path);
  }
  assert.equal((await floor('GET', 'export.csv')).status, 403);
});

test('imported records reproduce the sheet margins and the next serial is 41', async () => {
  await seed(store);
  const { data } = await office('GET', 'state');
  const serial = (n) => data.blades.find((b) => b.serial === 'ND' + String(n).padStart(7, '0'));
  const expected = { 1: 165, 2: 190, 3: 165, 4: 190, 5: 165, 6: 180, 8: 190, 11: 180, 13: 190, 21: 145, 24: 145 };
  for (const [n, m] of Object.entries(expected)) assert.equal(marginOf(serial(n)), m, `blade ${n}`);
  assert.equal(data.blades.length, 40);
  assert.equal(data.nextSerial, 'ND0000041');
});

test('seeding twice changes nothing and does not overwrite live work', async () => {
  await seed(store);
  await floor('POST', 'steps/complete', { bladeIds: ['imp_40'], step: 'dip', by: 'M' });
  assert.equal((await seed(store)).added, 0);
  const { data } = await office('GET', 'state');
  assert.equal(data.blades.find((b) => b.id === 'imp_40').stage, 'crate');
});

test('new orders never collide with imported order numbers', async () => {
  await seed(store);
  const { order } = await newOrder({ qty: 1 });
  assert.equal(order.id, 1001);
});

test('export keeps the sheet columns and defuses spreadsheet formulas', async () => {
  await newOrder({ qty: 1, customer: '=HYPERLINK("x")' });
  const { data } = await office('GET', 'export.csv');
  assert.match(data, /^Blade ID,Type,Blank Manufacturer,Tips,Core,Customer/);
  assert.match(data, /'=HYPERLINK/);
});

test('a typed serial replaces an unburned reservation and voids it', async () => {
  const { bladeIds } = await newOrder({ qty: 1 });
  await toStep(bladeIds[0], 'laser');
  const held = (await floor('POST', 'laser/reserve', { bladeId: bladeIds[0], by: 'M' })).data.serial;
  const r = await floor('POST', 'laser/reserve', { bladeId: bladeIds[0], by: 'M', serial: 'ND0000003' });
  assert.equal(r.status, 200);
  assert.equal(r.data.serial, 'ND0000003');
  const { data } = await office('GET', 'state');
  assert.equal(data.serials.find((s) => s.serial === held).status, 'void');
  assert.equal(data.blades[0].serial, 'ND0000003');
});

test('a typo cannot jump the serial sequence', async () => {
  const { bladeIds } = await newOrder({ qty: 1 });
  await toStep(bladeIds[0], 'laser');
  const r = await floor('POST', 'laser/reserve', { bladeId: bladeIds[0], by: 'M', serial: 'ND0009000' });
  assert.equal(r.status, 400);
  assert.equal((await office('GET', 'state')).data.nextSerial, 'ND0000001');
});

test('the floor cannot write money through the ship step', async () => {
  const { bladeIds } = await newOrder({ qty: 1 });
  await toStep(bladeIds[0], 'ship');
  await floor('POST', 'steps/complete', { bladeIds, step: 'ship', by: 'M', carrier: 'UPS', shipCost: 999 });
  const { data } = await office('GET', 'state');
  assert.equal(data.blades[0].shipCost, null);
});

test('shipping cost splits across only the blades that ship, with no lost cents', async () => {
  const { bladeIds } = await newOrder({ qty: 3 });
  for (const id of bladeIds) await toStep(id, 'ship');
  await office('POST', 'steps/complete', { bladeIds: [bladeIds[0]], step: 'ship', by: 'K', carrier: 'UPS' });
  const r = await office('POST', 'steps/complete', { bladeIds, step: 'ship', by: 'K', carrier: 'UPS', shipCost: 25 });
  assert.deepEqual(r.data.results.map((x) => x.ok), [false, true, true]);
  assert.deepEqual(r.data.results.slice(1).map((x) => x.blade.shipCost), [12.5, 12.5]);
  const three = await newOrder({ qty: 3 });
  for (const id of three.bladeIds) await toStep(id, 'ship');
  const t = await office('POST', 'steps/complete', { bladeIds: three.bladeIds, step: 'ship', by: 'K', carrier: 'UPS', shipCost: 25 });
  assert.equal(t.data.results.reduce((sum, x) => sum + Math.round(x.blade.shipCost * 100), 0), 2500);
});

test('a bad order leaves nothing behind', async () => {
  const before = (await office('GET', 'state')).data.orders.length;
  assert.equal((await office('POST', 'orders', { customer: 'X', qty: 1, type: 'SOLID', ourCost: 'abc', by: 'K' })).status, 400);
  assert.equal((await office('POST', 'orders', { customer: 'X', qty: 0, stockBladeIds: ['nope'], type: 'SOLID', by: 'K' })).status, 404);
  assert.equal((await office('GET', 'state')).data.orders.length, before);
});

test('blades cannot be taken from another customer', async () => {
  const a = await newOrder({ qty: 1 });
  const b = await newOrder({ qty: 1, customer: 'Other' });
  assert.equal((await office('POST', 'blades/assign', { bladeIds: a.bladeIds, orderId: b.order.id, by: 'K' })).status, 409);
});

test('scrap and void refuse repeats', async () => {
  const { bladeIds } = await newOrder({ qty: 2 });
  await floor('POST', 'blades/scrap', { bladeId: bladeIds[0], by: 'M', reason: 'cracked' });
  assert.equal((await floor('POST', 'blades/scrap', { bladeId: bladeIds[0], by: 'M', reason: 'again' })).status, 409);
  await toStep(bladeIds[1], 'laser');
  const s = (await floor('POST', 'laser/reserve', { bladeId: bladeIds[1], by: 'M' })).data.serial;
  await office('POST', 'serials/void', { serial: s, reason: 'first', by: 'K' });
  assert.equal((await office('POST', 'serials/void', { serial: s, reason: 'second', by: 'K' })).status, 409);
});

test('sending a shipped blade back clears the shipment but keeps the record', async () => {
  const { bladeIds } = await newOrder({ qty: 1 });
  await toStep(bladeIds[0], 'deliver');
  const r = await floor('POST', 'blades/back', { bladeId: bladeIds[0], toStep: 'crate', by: 'M', reason: 'wrong crate' });
  assert.equal(r.data.carrier, undefined);
  assert.ok(r.data.history.some((h) => h.carrier === 'UPS'));
});

test('edits name who made them and never put dollars in history the floor can read', async () => {
  const { bladeIds } = await newOrder({ qty: 1 });
  assert.equal((await office('POST', 'blades/update', { bladeId: bladeIds[0], price: 400 })).status, 400);
  await office('POST', 'blades/update', { bladeId: bladeIds[0], price: 400, by: 'K' });
  const { data } = await floor('GET', 'state');
  const last = data.blades[0].history.at(-1);
  assert.equal(last.by, 'K');
  assert.equal(last.note, 'Changed: price');
  assert.equal(data.blades[0].price, undefined);
});

test('sold dates follow the shop clock, not UTC', async () => {
  const { shopDate } = await import('../lib/core.mjs');
  assert.equal(shopDate(new Date('2026-11-05T04:17:00Z')), '2026-11-04');
});

test('negative margins export as numbers', async () => {
  await newOrder({ qty: 1, price: 100, ourCost: 140 });
  const { data } = await office('GET', 'export.csv');
  assert.match(data, /,-40,/);
  assert.ok(!data.includes("'-40"));
});

test('two blades holding one serial are reported, never hidden', async () => {
  const { bladeIds } = await newOrder();
  for (const id of bladeIds) {
    const cur = await store.get(`blades/${id}`);
    await store.put(`blades/${id}`, { ...cur.data, serial: 'ND0000007' });
  }
  assert.deepEqual((await office('GET', 'state')).data.duplicateSerials, ['ND0000007']);
});

test('lasered refuses when the blade no longer holds the number on the screen', async () => {
  const { bladeIds: [id] } = await newOrder({ qty: 1 });
  await toStep(id, 'laser');
  const first = (await floor('POST', 'laser/reserve', { bladeId: id, by: 'M' })).data.serial;
  await office('POST', 'serials/void', { serial: first, reason: 'x', by: 'K' });
  const second = (await floor('POST', 'laser/reserve', { bladeId: id, by: 'N' })).data.serial;
  const r = await floor('POST', 'steps/complete', { bladeIds: [id], step: 'laser', by: 'M', serial: first });
  assert.equal(r.status, 409);
  assert.match(r.data.error, new RegExp(second));
  const { data } = await office('GET', 'state');
  assert.equal(data.blades[0].stage, 'laser');
  assert.equal(data.serials.find((s) => s.serial === second).status, 'reserved');
});

test('a burned number cannot be replaced from the floor, and stays lasered', async () => {
  const { bladeIds: [id] } = await newOrder({ qty: 1 });
  await toStep(id, 'dip');
  await floor('POST', 'blades/back', { bladeId: id, toStep: 'laser', by: 'M', reason: 'faint' });
  const r = await floor('POST', 'laser/reserve', { bladeId: id, by: 'M', serial: 'ND0000002' });
  assert.equal(r.status, 409);
  const { data } = await office('GET', 'state');
  assert.equal(data.serials[0].status, 'lasered');
  assert.equal(data.serials.length, 1);
});

test('re-burning the same number after a send back still works', async () => {
  const { bladeIds: [id] } = await newOrder({ qty: 1 });
  await toStep(id, 'dip');
  await floor('POST', 'blades/back', { bladeId: id, toStep: 'laser', by: 'M', reason: 'faint' });
  assert.equal((await floor('POST', 'steps/complete', { bladeIds: [id], step: 'laser', by: 'M', serial: 'ND0000001' })).status, 200);
});

test('the office can untangle two swapped numbers', async () => {
  const { bladeIds: [a, b] } = await newOrder();
  await toStep(a, 'dip');
  await toStep(b, 'dip');
  await office('POST', 'serials/correct', { bladeId: a, serial: 'ND0000002', reason: 'swapped', by: 'K' });
  let { data } = await office('GET', 'state');
  assert.equal(data.blades.find((x) => x.id === b).serial, null);
  assert.match(data.blades.find((x) => x.id === b).check, /ND0000002/);
  await office('POST', 'serials/correct', { bladeId: b, serial: 'ND0000001', reason: 'swapped', by: 'K' });
  ({ data } = await office('GET', 'state'));
  assert.equal(data.blades.find((x) => x.id === a).serial, 'ND0000002');
  assert.equal(data.blades.find((x) => x.id === b).serial, 'ND0000001');
  assert.deepEqual(data.serials.map((s) => s.status), ['lasered', 'lasered']);
  assert.deepEqual(data.duplicateSerials, []);
  assert.equal((await floor('POST', 'serials/correct', { bladeId: a, serial: 'ND0000001', reason: 'x', by: 'M' })).status, 403);
});

test('a voided number burned anyway can be put right by the office', async () => {
  const { bladeIds: [id] } = await newOrder({ qty: 1 });
  await toStep(id, 'laser');
  const s = (await floor('POST', 'laser/reserve', { bladeId: id, by: 'M' })).data.serial;
  await office('POST', 'serials/void', { serial: s, reason: 'x', by: 'K' });
  assert.equal((await floor('POST', 'laser/reserve', { bladeId: id, by: 'M', serial: s })).status, 409);
  await office('POST', 'serials/correct', { bladeId: id, serial: s, reason: 'it was burned', by: 'K' });
  assert.equal((await office('GET', 'state')).data.serials.find((x) => x.serial === s).status, 'lasered');
});

test('a wrong assignment can go back to stock, then to the right customer', async () => {
  const { bladeIds: [id] } = await newOrder({ qty: 1 });
  await office('POST', 'blades/unassign', { bladeId: id, by: 'K' });
  const { order } = await newOrder({ qty: 1, customer: 'Right Co' });
  assert.equal((await office('POST', 'blades/assign', { bladeIds: [id], orderId: order.id, by: 'K' })).status, 200);
  assert.equal((await floor('POST', 'blades/unassign', { bladeId: id, by: 'M' })).status, 403);
});

test('concurrent assigns: one customer wins and the other is told', async () => {
  const stock = (await office('POST', 'orders', { kind: 'stock', qty: 1, type: 'SOLID', by: 'K' })).data.bladeIds[0];
  const a = (await newOrder({ qty: 1 })).order.id;
  const b = (await newOrder({ qty: 1 })).order.id;
  const [x, y] = await Promise.all([a, b].map((orderId) => office('POST', 'blades/assign', { bladeIds: [stock], orderId, by: 'K' })));
  assert.deepEqual([x.status, y.status].sort(), [200, 409]);
});

test('the floor sending a blade back leaves its money alone', async () => {
  await seed(store);
  await floor('POST', 'blades/back', { bladeId: 'imp_1', toStep: 'ship', by: 'M', reason: 'wrong box' });
  const b = (await office('GET', 'state')).data.blades.find((x) => x.id === 'imp_1');
  assert.equal(b.shipCost, 25);
  assert.equal(b.margin, 165);
});

test('reworked blades do not keep the old crate or receiver', async () => {
  const { bladeIds: [id] } = await newOrder({ qty: 1 });
  await toStep(id, 'crate');
  await floor('POST', 'steps/complete', { bladeIds: [id], step: 'crate', by: 'M', crateNo: '7' });
  await floor('POST', 'blades/back', { bladeId: id, toStep: 'crate', by: 'M', reason: 'x' });
  await floor('POST', 'steps/complete', { bladeIds: [id], step: 'crate', by: 'M' });
  assert.equal((await office('GET', 'state')).data.blades[0].crateNo, '');
});

test('shipping fills in a missing sold date, and ND0000000 is not a serial', async () => {
  const { bladeIds: [id] } = await newOrder({ qty: 1 });
  await store.put(`blades/${id}`, { ...(await store.get(`blades/${id}`)).data, soldDate: null });
  await toStep(id, 'deliver');
  assert.ok((await office('GET', 'state')).data.blades[0].soldDate);
  const b = await newOrder({ qty: 1 });
  await toStep(b.bladeIds[0], 'laser');
  assert.equal((await floor('POST', 'laser/reserve', { bladeId: b.bladeIds[0], by: 'M', serial: 'ND0000000' })).status, 400);
});

test('a stock build with stock blades leaves no order behind', async () => {
  assert.equal((await office('POST', 'orders', { kind: 'stock', qty: 1, type: 'SOLID', stockBladeIds: ['x'], by: 'K' })).status, 400);
  assert.equal((await office('GET', 'state')).data.orders.length, 0);
});

test('writes refuse to run without an etag', async () => {
  const { bladeIds: [id] } = await newOrder({ qty: 1, assignSerials: true });
  const realGet = store.get;
  store.get = async (k) => {
    const r = await realGet(k);
    return r && { data: r.data };
  };
  const res = await floor('POST', 'steps/complete', { bladeIds: [id], step: 'laser', by: 'M', serial: 'ND0000001' });
  store.get = realGet;
  assert.equal(res.status, 500);
  assert.equal((await office('GET', 'state')).data.blades[0].stage, 'laser');
});

test('a corrected number stays on the steel through rework and cannot be voided', async () => {
  const { bladeIds: [id] } = await newOrder({ qty: 1 });
  await toStep(id, 'dip');
  await floor('POST', 'blades/back', { bladeId: id, toStep: 'side_grind', by: 'M', reason: 'x' });
  await office('POST', 'serials/correct', { bladeId: id, serial: 'ND0000002', reason: 'misread', by: 'K' });
  assert.equal((await office('POST', 'serials/void', { serial: 'ND0000002', reason: 'x', by: 'K' })).status, 409);
  await floor('POST', 'blades/scrap', { bladeId: id, by: 'M', reason: 'cracked' });
  assert.equal((await office('GET', 'state')).data.serials.find((s) => s.serial === 'ND0000002').status, 'scrapped');
});

test('a corrected serial cannot jump the sequence', async () => {
  const { bladeIds: [id] } = await newOrder({ qty: 1 });
  await toStep(id, 'dip');
  assert.equal((await office('POST', 'serials/correct', { bladeId: id, serial: 'ND9999999', reason: 'typo', by: 'K' })).status, 400);
  assert.equal((await office('GET', 'state')).data.nextSerial, 'ND0000002');
});

test('a blade past the laser with no serial on record cannot ship', async () => {
  const { bladeIds: [a, b] } = await newOrder();
  await toStep(a, 'ship');
  await toStep(b, 'ship');
  await office('POST', 'serials/correct', { bladeId: a, serial: 'ND0000002', reason: 'swapped', by: 'K' });
  const r = await floor('POST', 'steps/complete', { bladeIds: [b], step: 'ship', by: 'M', carrier: 'UPS' });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /no serial/);
});

const walkRefurb = async (id, target) => {
  for (const step of routeFor('REFURB')) {
    if (step === target) return;
    const serial = step === 'laser' ? (await floor('POST', 'laser/reserve', { bladeId: id, by: 'M' })).data.serial : undefined;
    const r = await floor('POST', 'steps/complete', { bladeIds: [id], step, by: 'M', carrier: 'UPS', serial });
    assert.equal(r.status, 200, step + JSON.stringify(r.data));
  }
};

test('refurbished blades lose old tips, then roller, then polish, and get lasered; new blades do none of the first three', async () => {
  assert.deepEqual(routeFor('REFURB').slice(0, 6), ['remove_tips', 'flatten', 'polish', 'blank_check', 'laser', 'wash_in']);
  assert.ok(routeFor('REFURB').includes('laser'));
  assert.equal(routeFor('NEW')[0], 'laser');
  const fresh = await newOrder({ qty: 1 });
  const refurb = await newOrder({ qty: 1, condition: 'REFURB', customer: 'Refurb Co' });
  let { data } = await office('GET', 'state');
  assert.equal(data.blades.find((b) => b.id === fresh.bladeIds[0]).stage, 'laser');
  const id = refurb.bladeIds[0];
  assert.equal(data.blades.find((b) => b.id === id).stage, 'remove_tips');
  assert.equal((await floor('POST', 'steps/complete', { bladeIds: fresh.bladeIds, step: 'polish', by: 'M' })).status, 409);
  await walkRefurb(id, null);
  ({ data } = await office('GET', 'state'));
  const b = data.blades.find((x) => x.id === id);
  assert.equal(b.stage, 'delivered');
  assert.equal(b.serial, 'RD0000001');
  assert.equal(data.serials[0].status, 'lasered');
});

test('a refurbished blade cannot ship without its serial', async () => {
  const { bladeIds: [id] } = await newOrder({ qty: 1, condition: 'REFURB' });
  await walkRefurb(id, 'laser');
  assert.equal((await floor('POST', 'steps/complete', { bladeIds: [id], step: 'ship', by: 'M', carrier: 'UPS' })).status, 409);
});

test('a new blade cannot be sent to a refurbishing step', async () => {
  const n = await newOrder({ qty: 1 });
  await toStep(n.bladeIds[0], 'top_grind');
  for (const toStep_ of ['remove_tips', 'flatten', 'polish', 'blank_check']) {
    assert.equal((await floor('POST', 'blades/back', { bladeId: n.bladeIds[0], toStep: toStep_, by: 'M', reason: 'x' })).status, 409);
  }
});

test('a bad condition is refused, and it can only change before work starts', async () => {
  assert.equal((await office('POST', 'orders', { customer: 'X', qty: 1, type: 'SOLID', condition: 'USED', by: 'K' })).status, 400);
  const { bladeIds: [id] } = await newOrder({ qty: 1 });
  const moved = await office('POST', 'blades/update', { bladeId: id, condition: 'REFURB', by: 'K' });
  assert.equal(moved.data.stage, 'remove_tips');
  await floor('POST', 'steps/complete', { bladeIds: [id], step: 'remove_tips', by: 'M' });
  assert.equal((await office('POST', 'blades/update', { bladeId: id, condition: 'NEW', by: 'K' })).status, 409);
});

test('blades imported before the field existed count as new', async () => {
  await seed(store);
  const cur = await store.get('blades/imp_40');
  const { condition, ...old } = cur.data;
  await store.put('blades/imp_40', old);
  assert.equal((await floor('POST', 'steps/complete', { bladeIds: ['imp_40'], step: 'dip', by: 'M' })).status, 200);
  assert.equal((await office('GET', 'state')).data.blades.find((b) => b.id === 'imp_40').stage, 'crate');
});

test('the machine number goes in the history on machine steps only', async () => {
  const { bladeIds: [id] } = await newOrder({ qty: 1 });
  await pastLaser(id);
  await floor('POST', 'steps/complete', { bladeIds: [id], step: 'wash_in', by: 'M', machine: 'WASH-1' });
  await floor('POST', 'steps/complete', { bladeIds: [id], step: 'tipping', by: 'M', machine: 'HBTM-01' });
  const h = (await floor('GET', 'state')).data.blades[0].history;
  assert.equal(h.find((e) => e.step === 'tipping').machine, 'HBTM-01');
  assert.equal(h.find((e) => e.step === 'wash_in').machine, 'WASH-1');
  const other = (await newOrder({ qty: 1 })).bladeIds[0];
  await toStep(other, 'dip');
  await floor('POST', 'steps/complete', { bladeIds: [other], step: 'dip', by: 'M', machine: 'X' });
  const after = (await floor('GET', 'state')).data.blades.find((b) => b.id === other).history;
  assert.equal(after.find((e) => e.step === 'dip').machine, undefined);
});

test('a blade bought finished skips the build and still gets a serial', async () => {
  assert.deepEqual(routeFor('RESALE'), ['laser', 'wash_out', 'dip', 'crate', 'ship', 'deliver']);
  const { bladeIds: [id] } = await newOrder({ qty: 1, condition: 'RESALE' });
  const s = (await floor('POST', 'laser/reserve', { bladeId: id, by: 'M' })).data.serial;
  assert.equal(s, 'ND0000001');
  assert.equal((await floor('POST', 'steps/complete', { bladeIds: [id], step: 'tipping', by: 'M' })).status, 409);
  assert.equal((await floor('POST', 'steps/complete', { bladeIds: [id], step: 'laser', by: 'M', serial: s })).status, 200);
});

test('grinding runs sides, then face, then top', async () => {
  const r = routeFor('NEW');
  assert.ok(r.indexOf('tipping') < r.indexOf('side_grind') && r.indexOf('side_grind') < r.indexOf('face_grind') && r.indexOf('face_grind') < r.indexOf('top_grind'));
  const { bladeIds: [id] } = await newOrder({ qty: 1 });
  await toStep(id, 'side_grind');
  assert.equal((await floor('POST', 'steps/complete', { bladeIds: [id], step: 'top_grind', by: 'M' })).status, 409);
});

test('the log name Pat is not recorded as the customer', async () => {
  await seed(store);
  const { data } = await office('GET', 'state');
  assert.ok(!data.orders.some((o) => /Pat/.test(o.customer)));
  assert.match(data.blades.find((b) => b.id === 'imp_27').check, /Pat/);
});

test('an order can take its serials up front, and they are issued only once', async () => {
  const a = await newOrder({ qty: 3, assignSerials: true });
  const b = await newOrder({ qty: 2, assignSerials: true });
  const { data } = await office('GET', 'state');
  const of = (ids) => ids.map((id) => data.blades.find((x) => x.id === id).serial);
  assert.deepEqual(of(a.bladeIds), ['ND0000001', 'ND0000002', 'ND0000003']);
  assert.deepEqual(of(b.bladeIds), ['ND0000004', 'ND0000005']);
  assert.ok(data.serials.every((s) => s.status === 'reserved'));
  assert.equal(data.nextSerial, 'ND0000006');
});

test('simultaneous orders never share a serial', async () => {
  const got = await Promise.all([1, 2, 3, 4].map(() => newOrder({ qty: 3, assignSerials: true })));
  const { data } = await office('GET', 'state');
  const all = got.flatMap((g) => g.bladeIds).map((id) => data.blades.find((x) => x.id === id).serial);
  assert.equal(new Set(all).size, 12);
  assert.deepEqual(data.duplicateSerials, []);
});

test('the serial comes first on every kind of blade that has no prep to do', async () => {
  assert.equal(routeFor('NEW')[0], 'laser');
  assert.equal(routeFor('RESALE')[0], 'laser');
  assert.deepEqual(routeFor('REFURB').slice(0, 5), ['remove_tips', 'flatten', 'polish', 'blank_check', 'laser']);
});

test('a job with order serials walks to delivered and burns those numbers', async () => {
  const { bladeIds: [id] } = await newOrder({ qty: 1, assignSerials: true });
  await toStep(id, null);
  const { data } = await office('GET', 'state');
  assert.equal(data.blades[0].stage, 'delivered');
  assert.equal(data.blades[0].serial, 'ND0000001');
  assert.equal(data.serials[0].status, 'lasered');
});

test('a held job takes no ticks until it is started', async () => {
  const { order, bladeIds } = await newOrder({ qty: 1, hold: true, assignSerials: true });
  const body = { bladeIds, step: 'laser', by: 'M', serial: 'ND0000001' };
  const held = await floor('POST', 'steps/complete', body);
  assert.equal(held.status, 409);
  assert.match(held.data.error, /on hold/);
  assert.equal((await floor('POST', 'orders/hold', { id: order.id, by: 'M' })).status, 400);
  assert.equal((await floor('POST', 'orders/hold', { id: order.id, by: 'M', start: true })).status, 200);
  assert.equal((await floor('POST', 'steps/complete', body)).status, 200);
  assert.equal((await floor('POST', 'orders/hold', { id: order.id, by: 'M', reason: 'No tips' })).data.hold.reason, 'No tips');
  assert.equal((await floor('POST', 'steps/complete', { bladeIds, step: 'wash_in', by: 'M' })).status, 409);
});

test('cancelling hands unburned numbers to the next job and sends burned blades to stock', async () => {
  const { order, bladeIds: [a, b, c] } = await newOrder({ qty: 3, assignSerials: true });
  await floor('POST', 'steps/complete', { bladeIds: [a], step: 'laser', by: 'M', serial: 'ND0000001' });
  assert.equal((await floor('POST', 'orders/cancel', { id: order.id, by: 'M', reason: 'x' })).status, 403);
  assert.equal((await office('POST', 'orders/cancel', { id: order.id, by: 'K' })).status, 400);
  const r = await office('POST', 'orders/cancel', { id: order.id, by: 'K', reason: 'Customer backed out' });
  assert.deepEqual(r.data.released, ['ND0000002', 'ND0000003']);
  assert.deepEqual(r.data.toStock, ['ND0000001']);
  let { data } = await office('GET', 'state');
  assert.equal(data.nextSerial, 'ND0000002');
  const kept = data.blades.find((x) => x.id === a);
  assert.equal(data.orders.find((o) => o.id === kept.orderId).kind, 'stock');
  assert.equal(kept.serial, 'ND0000001');
  const next = await newOrder({ qty: 3, assignSerials: true });
  ({ data } = await office('GET', 'state'));
  assert.deepEqual(next.bladeIds.map((id) => data.blades.find((x) => x.id === id).serial), ['ND0000002', 'ND0000003', 'ND0000004']);
  assert.deepEqual(data.duplicateSerials, []);
});

test('scrapping an unburned blade hands its number back; a burned one never comes back', async () => {
  const { bladeIds: [a, b] } = await newOrder({ qty: 2, assignSerials: true });
  await floor('POST', 'blades/scrap', { bladeId: a, by: 'M', reason: 'warped' });
  let { data } = await office('GET', 'state');
  assert.equal(data.nextSerial, 'ND0000001');
  assert.equal(data.blades.find((x) => x.id === a).serial, null);
  await floor('POST', 'steps/complete', { bladeIds: [b], step: 'laser', by: 'M', serial: 'ND0000002' });
  await floor('POST', 'blades/scrap', { bladeId: b, by: 'M', reason: 'cracked' });
  ({ data } = await office('GET', 'state'));
  assert.equal(data.serials.find((s) => s.serial === 'ND0000002').status, 'scrapped');
  assert.equal(data.nextSerial, 'ND0000001');
});

test('anyone can start blades for inventory; the floor cannot set money on them', async () => {
  const r = await floor('POST', 'inventory', { by: 'M', qty: 2, type: 'SOLID', condition: 'NEW', price: 999, ourCost: 1 });
  assert.equal(r.status, 200);
  const { data } = await office('GET', 'state');
  assert.equal(data.orders[0].kind, 'stock');
  assert.equal(data.orders[0].hold, undefined);
  assert.ok(data.blades.every((b) => b.price === null && b.ourCost === null));
  assert.deepEqual(data.blades.map((b) => b.serial).sort(), ['ND0000001', 'ND0000002']);
});

test('an inventory blade walks to the shelf, then sells onto a customer order with its serial', async () => {
  const { bladeIds: [id] } = (await floor('POST', 'inventory', { by: 'M', qty: 1, type: 'SOLID', condition: 'RESALE' })).data;
  for (const step of ['laser', 'wash_out', 'dip', 'crate']) {
    assert.equal((await floor('POST', 'steps/complete', { bladeIds: [id], step, by: 'M', serial: 'ND0000001' })).status, 200, step);
  }
  assert.equal((await floor('POST', 'steps/complete', { bladeIds: [id], step: 'ship', by: 'M', carrier: 'UPS' })).status, 409);
  const { order } = await newOrder({ qty: 0, stockBladeIds: [id], customer: 'Buyer Co', price: 345 });
  assert.equal((await floor('POST', 'steps/complete', { bladeIds: [id], step: 'ship', by: 'M', carrier: 'UPS' })).status, 200);
  const { data } = await office('GET', 'state');
  const b = data.blades.find((x) => x.id === id);
  assert.equal(b.orderId, order.id);
  assert.equal(b.serial, 'ND0000001');
  assert.equal(b.price, 345);
});

test('a typed number is on the steel: scrap and cancel can never put it back in the pool', async () => {
  const { order, bladeIds: [a, b] } = await newOrder({ qty: 2, assignSerials: true });
  await floor('POST', 'laser/reserve', { bladeId: a, by: 'M', serial: 'ND0000003' });
  let { data } = await office('GET', 'state');
  assert.equal(data.serials.find((s) => s.serial === 'ND0000003').status, 'lasered');
  assert.equal(data.serials.find((s) => s.serial === 'ND0000001').status, 'void');
  await floor('POST', 'blades/scrap', { bladeId: a, by: 'M', reason: 'cracked' });
  ({ data } = await office('GET', 'state'));
  assert.equal(data.serials.find((s) => s.serial === 'ND0000003').status, 'scrapped');
  await office('POST', 'orders/cancel', { id: order.id, by: 'K', reason: 'x' });
  const next = await newOrder({ qty: 2, assignSerials: true });
  ({ data } = await office('GET', 'state'));
  const got = next.bladeIds.map((id) => data.blades.find((x) => x.id === id).serial);
  assert.ok(!got.includes('ND0000003') && !got.includes('ND0000001'));
});

test('typing the number a blade already holds marks it burned', async () => {
  const { order, bladeIds: [id] } = await newOrder({ qty: 1, assignSerials: true });
  await floor('POST', 'laser/reserve', { bladeId: id, by: 'M', serial: 'ND0000001' });
  await office('POST', 'orders/cancel', { id: order.id, by: 'K', reason: 'x' });
  const { data } = await office('GET', 'state');
  assert.equal(data.serials[0].status, 'lasered');
  assert.notEqual(data.nextSerial, 'ND0000001');
  assert.equal(data.blades.find((b) => b.id === id).serial, 'ND0000001');
});

test('a free number can be typed at the laser, once', async () => {
  const c = await newOrder({ qty: 1, assignSerials: true });
  await office('POST', 'orders/cancel', { id: c.order.id, by: 'K', reason: 'x' });
  const { bladeIds: [a, b] } = await newOrder({ qty: 2 });
  assert.equal((await floor('POST', 'laser/reserve', { bladeId: a, by: 'M', serial: 'ND0000001' })).status, 200);
  assert.equal((await office('GET', 'state')).data.serials.find((s) => s.serial === 'ND0000001').status, 'lasered');
  assert.equal((await floor('POST', 'laser/reserve', { bladeId: b, by: 'M', serial: 'ND0000001' })).status, 409);
});

test('cancelling an order returns a stock blade to its inventory job, number intact', async () => {
  const { order: job, bladeIds: [id] } = (await floor('POST', 'inventory', { by: 'M', qty: 1, type: 'SOLID', condition: 'NEW' })).data;
  const sale = await newOrder({ qty: 0, stockBladeIds: [id] });
  await office('POST', 'orders/cancel', { id: sale.order.id, by: 'K', reason: 'Backed out' });
  const { data } = await office('GET', 'state');
  const b = data.blades.find((x) => x.id === id);
  assert.equal(b.orderId, job.id);
  assert.equal(b.serial, 'ND0000001');
  assert.notEqual(b.stage, 'scrapped');
  assert.equal(data.serials[0].status, 'reserved');
});

test('blades leaving a cancelled order or Back to stock always keep a job', async () => {
  const c = await newOrder({ qty: 1, assignSerials: true });
  await floor('POST', 'steps/complete', { bladeIds: c.bladeIds, step: 'laser', by: 'M', serial: 'ND0000001' });
  await office('POST', 'orders/cancel', { id: c.order.id, by: 'K', reason: 'x' });
  const d = await newOrder({ qty: 1 });
  await office('POST', 'blades/unassign', { bladeId: d.bladeIds[0], by: 'K' });
  const { data } = await office('GET', 'state');
  for (const id of [...c.bladeIds, ...d.bladeIds]) {
    const b = data.blades.find((x) => x.id === id);
    assert.equal(data.orders.find((o) => o.id === b.orderId).kind, 'stock');
  }
});

test('a cancelled order takes no stock, and its never-built blades leave the export', async () => {
  const stock = (await floor('POST', 'inventory', { by: 'M', qty: 1, type: 'SOLID', condition: 'NEW' })).data;
  const c = await newOrder({ qty: 2, customer: 'Gone Co', assignSerials: true });
  await office('POST', 'orders/cancel', { id: c.order.id, by: 'K', reason: 'x' });
  assert.equal((await office('POST', 'blades/assign', { bladeIds: stock.bladeIds, orderId: c.order.id, by: 'K' })).status, 409);
  const { data } = await office('GET', 'export.csv');
  assert.ok(!data.includes('Gone Co'));
});

test('kind can change on a held job with reserved numbers, and on an old blade where the step is shared', async () => {
  const { bladeIds: [id] } = await newOrder({ qty: 1, assignSerials: true, hold: true });
  const moved = await office('POST', 'blades/update', { bladeId: id, condition: 'RESALE', by: 'K' });
  assert.equal(moved.status, 200);
  assert.equal(moved.data.stage, 'laser');
  assert.equal(moved.data.serial, 'ND0000001');
  await seed(store);
  const old = await office('POST', 'blades/update', { bladeId: 'imp_40', condition: 'RESALE', by: 'K' });
  assert.equal(old.data.stage, 'dip');
});

test('refurbished blades count on their own RD series, and new blades stay on ND', async () => {
  const n = await newOrder({ qty: 2, assignSerials: true });
  const r = await newOrder({ qty: 2, assignSerials: true, condition: 'REFURB' });
  const b = await newOrder({ qty: 1, assignSerials: true, condition: 'RESALE' });
  const inv = (await floor('POST', 'inventory', { by: 'M', qty: 1, type: 'SOLID', condition: 'REFURB' })).data;
  const { data } = await office('GET', 'state');
  const of = (ids) => ids.map((id) => data.blades.find((x) => x.id === id).serial);
  assert.deepEqual(of(n.bladeIds), ['ND0000001', 'ND0000002']);
  assert.deepEqual(of(r.bladeIds), ['RD0000001', 'RD0000002']);
  assert.deepEqual(of(b.bladeIds), ['ND0000003']);
  assert.deepEqual(of(inv.bladeIds), ['RD0000003']);
  assert.equal(data.nextSerial, 'ND0000004');
  assert.equal(data.nextRefurbSerial, 'RD0000004');
});

test('a refurbished blade walks to delivered and burns its RD number', async () => {
  const { bladeIds: [id] } = await newOrder({ qty: 1, assignSerials: true, condition: 'REFURB' });
  for (const step of routeFor('REFURB')) {
    const r = await floor('POST', 'steps/complete', { bladeIds: [id], step, by: 'M', carrier: 'UPS', serial: 'RD0000001' });
    assert.equal(r.status, 200, step + JSON.stringify(r.data));
  }
  const { data } = await office('GET', 'state');
  assert.equal(data.serials[0].status, 'lasered');
  assert.equal(data.nextRefurbSerial, 'RD0000002');
  assert.equal(data.nextSerial, 'ND0000001');
});

test('a typed serial must match the kind of blade', async () => {
  const r = await newOrder({ qty: 1, condition: 'REFURB' });
  for (const step of routeFor('REFURB').slice(0, 4)) await floor('POST', 'steps/complete', { bladeIds: r.bladeIds, step, by: 'M' });
  assert.equal((await floor('POST', 'laser/reserve', { bladeId: r.bladeIds[0], by: 'M', serial: 'ND0000001' })).status, 400);
  const n = await newOrder({ qty: 1 });
  assert.equal((await floor('POST', 'laser/reserve', { bladeId: n.bladeIds[0], by: 'M', serial: 'RD0000001' })).status, 400);
  assert.equal((await floor('POST', 'laser/reserve', { bladeId: r.bladeIds[0], by: 'M', serial: 'RD0000001' })).data.serial, 'RD0000001');
});

test('a free RD number goes only to the next refurb', async () => {
  const r = await newOrder({ qty: 1, assignSerials: true, condition: 'REFURB' });
  await office('POST', 'orders/cancel', { id: r.order.id, by: 'K', reason: 'x' });
  const n = await newOrder({ qty: 1, assignSerials: true });
  const again = await newOrder({ qty: 1, assignSerials: true, condition: 'REFURB' });
  const { data } = await office('GET', 'state');
  const of = (id) => data.blades.find((x) => x.id === id).serial;
  assert.equal(of(n.bladeIds[0]), 'ND0000001');
  assert.equal(of(again.bladeIds[0]), 'RD0000001');
});

test('changing kind swaps an unburned number to the right series, and refuses a burned one', async () => {
  const { bladeIds: [id] } = await newOrder({ qty: 1, assignSerials: true, hold: true });
  const moved = await office('POST', 'blades/update', { bladeId: id, condition: 'REFURB', by: 'K' });
  assert.equal(moved.data.serial, 'RD0000001');
  assert.equal(moved.data.stage, 'remove_tips');
  let { data } = await office('GET', 'state');
  assert.equal(data.serials.find((s) => s.serial === 'ND0000001').status, 'open');
  assert.equal(data.nextSerial, 'ND0000001');
  const b = await newOrder({ qty: 1, assignSerials: true });
  const s = data.nextSerial;
  await floor('POST', 'steps/complete', { bladeIds: b.bladeIds, step: 'laser', by: 'M', serial: s });
  assert.equal((await office('POST', 'blades/update', { bladeId: b.bladeIds[0], condition: 'REFURB', by: 'K' })).status, 409);
  ({ data } = await office('GET', 'state'));
  assert.equal(data.blades.find((x) => x.id === b.bladeIds[0]).serial, s);
  assert.deepEqual(data.duplicateSerials, []);
});

test('the same digits in two series are two different numbers', async () => {
  const a = await newOrder({ qty: 1, assignSerials: true });
  const b = await newOrder({ qty: 1, assignSerials: true, condition: 'REFURB' });
  const { data } = await office('GET', 'state');
  assert.deepEqual(data.duplicateSerials, []);
  assert.equal(data.serials.length, 2);
  assert.ok(a && b);
});

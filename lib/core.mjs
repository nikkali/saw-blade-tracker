import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { config, STEP_IDS, CONDITIONS, conditionOf, routeFor, prefixFor, DONE, SCRAPPED, SERIAL, SPEC } from './config.mjs';
import { seedDocs } from './seed.mjs';

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new ApiError(status, message);
};

const text = (v, max = 300) => (v === undefined || v === null ? '' : String(v).trim().slice(0, max));
const money = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) fail(400, `Not a dollar amount: ${v}`);
  return Math.round(n * 100) / 100;
};
// The shop's calendar date. A sale at 10 PM in Columbia, MS belongs to that day, not to UTC's tomorrow.
export const shopDate = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(d);
const stageName = (id) => (id === DONE ? 'Delivered' : id === SCRAPPED ? 'Scrapped' : config.STEPS.find((s) => s.id === id)?.label || id);
const newId = () => 'b_' + randomBytes(6).toString('hex');
const needBy = (body) => text(body.by, 80) || fail(400, 'Who did this? Pick your name first.');

const MAX_SERIAL_JUMP = 25;
export const serialFor = (n, prefix = SERIAL.prefix) => prefix + String(n).padStart(SERIAL.digits, '0');
const inSeries = (serial, prefix) => String(serial).startsWith(prefix);
const serialNumber = (s) => {
  const m = new RegExp(`^(?:${SERIAL.prefix}|${SERIAL.refurbPrefix})(\\d{${SERIAL.digits}})$`).exec(s || '');
  return m ? Number(m[1]) : null;
};
export const laserText = (serial) => [serial, SPEC.line1, SPEC.line2, SPEC.line3, SPEC.line4];

/* Margin matches the shop spreadsheet: price - (our cost + shipping cost). */
export function marginOf(blade) {
  if (blade.price == null || blade.ourCost == null) return null;
  return Math.round((blade.price - blade.ourCost - (blade.shipCost || 0)) * 100) / 100;
}

const sha = (s) => createHash('sha256').update(String(s)).digest();
const same = (a, b) => timingSafeEqual(sha(a), sha(b));

/** Fails closed: with no passcode configured nobody gets in. */
export function roleFor(passcode, env) {
  if (!passcode) return null;
  if (env.BLADE_OFFICE_PASSCODE && same(passcode, env.BLADE_OFFICE_PASSCODE)) return 'office';
  if (env.BLADE_FLOOR_PASSCODE && same(passcode, env.BLADE_FLOOR_PASSCODE)) return 'floor';
  return null;
}

/** Read, change, write back only if nobody else wrote in between. */
async function mutate(store, key, change) {
  for (let i = 0; i < 6; i++) {
    const cur = await store.get(key);
    if (!cur) fail(404, `Not found: ${key}`);
    // Without an etag the write below would be unconditional and could overwrite someone's work.
    if (!cur.etag) throw new Error(`Storage returned no etag for ${key}`);
    const next = change(structuredClone(cur.data));
    if (await store.put(key, next, { onlyIfMatch: cur.etag })) return next;
  }
  fail(409, 'Someone else is updating this. Try again.');
}

async function loadAll(store, prefix) {
  const keys = await store.list(prefix);
  const out = [];
  for (let i = 0; i < keys.length; i += 40) {
    const docs = await Promise.all(keys.slice(i, i + 40).map((k) => store.get(k)));
    for (const d of docs) if (d) out.push(d.data);
  }
  return out;
}

const stripMoney = (b) => {
  const { price, ourCost, shipCost, ...rest } = b;
  return rest;
};

export async function getState(store, role) {
  const [blades, orders, serials] = await Promise.all([
    loadAll(store, 'blades/'),
    loadAll(store, 'orders/').then((all) => all.filter((o) => !o.claiming)),
    loadAll(store, 'serials/'),
  ]);
  return {
    role,
    config,
    blades: role === 'office' ? blades.map((b) => ({ ...b, margin: marginOf(b) })) : blades.map(stripMoney),
    orders: role === 'office' ? orders : orders.map(({ contact, ...o }) => o),
    serials,
    nextSerial: nextSerialOf(serials),
    nextRefurbSerial: nextSerialOf(serials, SERIAL.refurbPrefix),
    duplicateSerials: duplicatesIn(blades),
  };
}

const duplicatesIn = (blades) => {
  const seen = new Map();
  for (const b of blades) if (b.serial) seen.set(b.serial, (seen.get(b.serial) || 0) + 1);
  return [...seen].filter(([, n]) => n > 1).map(([serial]) => serial);
};
// Numbers handed back unburned go out again first, lowest first.
const openSerials = (serials, prefix = SERIAL.prefix) => serials.filter((s) => s.status === 'open' && inSeries(s.serial, prefix)).map((s) => s.serial).sort();
const nextSerialOf = (serials, prefix = SERIAL.prefix) => openSerials(serials, prefix)[0] || serialFor(nextNumber(serials, prefix), prefix);
const nextNumber = (serials, prefix = SERIAL.prefix) => serials.filter((s) => inSeries(s.serial, prefix)).reduce((m, s) => Math.max(m, serialNumber(s.serial) || 0), 0) + 1;

async function claimOrderNumber(store) {
  const existing = await store.list('orders/');
  let n = existing.reduce((m, k) => Math.max(m, Number(k.split('/')[1]) || 0), 1000) + 1;
  for (let i = 0; i < 25; i++, n++) {
    if (await store.put(`orders/${n}`, { id: n, claiming: true }, { onlyIfNew: true })) return n;
  }
  fail(409, 'Could not get an order number. Try again.');
}

export async function createOrder(store, body) {
  const kind = body.kind === 'stock' ? 'stock' : 'customer';
  const customer = kind === 'stock' ? 'Stock' : text(body.customer, 120) || fail(400, 'Customer name is required.');
  const qty = Number(body.qty ?? 0);
  if (!Number.isInteger(qty) || qty < 0 || qty > 200) fail(400, 'Quantity must be 0 to 200.');
  const stockIds = Array.isArray(body.stockBladeIds) ? body.stockBladeIds.map(String) : [];
  if (qty + stockIds.length < 1) fail(400, 'An order needs at least one blade.');
  if (kind === 'stock' && stockIds.length) fail(400, 'A stock build cannot use stock blades.');
  const type = config.TYPES.includes(body.type) ? body.type : fail(400, 'Pick slotted or solid.');
  const condition = body.condition ?? 'NEW';
  if (!CONDITIONS.some((c) => c.value === condition)) fail(400, 'Pick the kind of blade.');
  const by = needBy(body);
  const at = new Date().toISOString();
  const price = money(body.price);
  const ourCost = money(body.ourCost);
  for (const sid of stockIds) {
    const stock = await store.get(`blades/${sid}`);
    if (!stock) fail(404, 'A picked stock blade no longer exists.');
    await assertAssignable(store, stock.data);
  }

  const id = await claimOrderNumber(store);
  // The order's serials are taken up front, so the job card can show its block of numbers.
  const take = body.assignSerials ? await serialTaker(store, prefixFor(condition)) : null;
  const order = {
    id,
    kind,
    customer,
    contact: text(body.contact),
    po: text(body.po, 80),
    due: text(body.due, 10),
    shipMethod: text(body.shipMethod, 40),
    notes: text(body.notes, 1000),
    createdAt: at,
    createdBy: by,
    ...(body.hold ? { hold: { reason: text(body.holdReason, 200) || 'Not started', by, at } } : {}),
  };
  await store.put(`orders/${id}`, order);

  const bladeIds = [];
  for (let i = 0; i < qty; i++) {
    const bladeId = newId();
    const serial = take ? await take({ bladeId, status: 'reserved', reservedAt: at, reservedBy: by }) : null;
    const blade = {
      id: bladeId,
      orderId: id,
      serial,
      type,
      condition,
      blankMaker: text(body.blankMaker, 40),
      tipMaker: text(body.tipMaker, 40),
      core: text(body.core, 20),
      stage: routeFor(condition)[0],
      price,
      ourCost,
      shipCost: null,
      soldDate: kind === 'customer' ? shopDate(new Date(at)) : null,
      history: [{ step: 'order', at, by, note: serial ? `Order ${id}, serial ${serial} assigned` : `Order ${id}` }],
    };
    await store.put(`blades/${blade.id}`, blade, { onlyIfNew: true });
    bladeIds.push(blade.id);
  }
  let stockResults = [];
  if (stockIds.length) {
    stockResults = (await assignBlades(store, { bladeIds: stockIds, orderId: id, by, price: body.price }, { allFail: true })).results;
  }
  return { order, bladeIds, stockResults };
}

/** Put a whole job on hold, or start it. No step can be finished while it is held. */
export async function holdOrder(store, body) {
  const by = needBy(body);
  const start = Boolean(body.start);
  const reason = text(body.reason, 200);
  if (!start && !reason) fail(400, 'Why is it on hold?');
  return mutate(store, `orders/${Number(body.id)}`, (o) => {
    const at = new Date().toISOString();
    (o.history ||= []).push({ at, by, note: start ? 'Started' : `On hold: ${reason}` });
    if (start) delete o.hold;
    else o.hold = { reason, by, at };
    return o;
  });
}

/** Add blades to inventory: the same walk through the shop, with no customer.
 *  The floor can start one too, so anything about money is left for the office. */
export async function addInventory(store, body, role) {
  const { price, ourCost, ...rest } = body;
  return createOrder(store, { ...(role === 'office' ? body : rest), kind: 'stock', assignSerials: true, hold: false });
}

/** The stock job a blade returns to: where it came from, or a new one, so it keeps a card. */
async function stockHomeFor(store, b, by, at, why) {
  const old = b.stockOrderId ? await store.get(`orders/${b.stockOrderId}`) : null;
  if (old && !old.data.cancelled) return b.stockOrderId;
  const id = await claimOrderNumber(store);
  await store.put(`orders/${id}`, { id, kind: 'stock', customer: 'Stock', contact: '', po: '', due: '', shipMethod: '', notes: why, createdAt: at, createdBy: by });
  return id;
}

/** Unburned numbers go back out; a burned blade, or one that came from stock, goes to inventory with its number. */
export async function cancelOrder(store, body) {
  const by = needBy(body);
  const reason = text(body.reason, 300) || fail(400, 'Why is it being cancelled?');
  const id = Number(body.id);
  const at = new Date().toISOString();
  const blades = (await loadAll(store, 'blades/')).filter((b) => b.orderId === id);
  if (blades.some((b) => b.stage === 'deliver' || b.stage === DONE)) fail(409, 'Part of this order already shipped. Handle those blades one at a time.');
  const moved = { toStock: [], released: [] };
  let spare = null;
  for (const b of blades) {
    if (b.stage === SCRAPPED) continue;
    const reg = b.serial ? await store.get(`serials/${b.serial}`) : null;
    const burned = reg?.data.status === 'lasered';
    const keep = burned || b.stockOrderId;
    const home = keep ? (b.stockOrderId ? await stockHomeFor(store, b, by, at, `From cancelled order ${id}`) : (spare ??= await stockHomeFor(store, b, by, at, `From cancelled order ${id}`))) : null;
    await mutate(store, `blades/${b.id}`, (x) => {
      x.history.push({ step: 'cancel', at, by, note: `Order ${id} cancelled: ${reason}` });
      if (keep) {
        x.orderId = home;
        x.soldDate = null;
        delete x.soldNoDate;
        delete x.stockOrderId;
      } else {
        x.stage = SCRAPPED;
        x.cancelled = true;
        x.serial = null;
      }
      return x;
    });
    if (keep) moved.toStock.push(b.serial || `Order ${home} blade`);
    else if (b.serial) {
      await releaseSerial(store, b.serial, `Order ${id} cancelled`, by, at);
      moved.released.push(b.serial);
    }
  }
  const order = await mutate(store, `orders/${id}`, (o) => {
    delete o.hold;
    o.cancelled = { reason, by, at };
    return o;
  });
  return { order, toStock: moved.toStock.sort(), released: moved.released.sort() };
}

/** Hand an unburned number back, keeping a record of where it has been. */
function releaseSerial(store, serial, why, by, at) {
  return mutate(store, `serials/${serial}`, (s) => {
    if (s.status !== 'reserved') fail(409, `${serial} is ${s.status} and cannot go back.`);
    return { serial, status: 'open', releasedAt: at, releasedBy: by, releasedWhy: why, past: [...(s.past || []), { bladeId: s.bladeId, reservedAt: s.reservedAt }] };
  });
}

export async function updateOrder(store, body) {
  const by = needBy(body);
  const id = Number(body.id);
  return mutate(store, `orders/${id}`, (o) => {
    const changed = [];
    for (const f of ['customer', 'contact', 'po', 'due', 'shipMethod', 'notes']) {
      if (body[f] === undefined) continue;
      const v = text(body[f], f === 'notes' ? 1000 : 120);
      if (v !== o[f]) changed.push(f);
      o[f] = v;
    }
    if (changed.length) (o.history ||= []).push({ at: new Date().toISOString(), by, note: `Changed: ${changed.join(', ')}` });
    return o;
  });
}

/** Give finished or in-progress stock blades to a customer order. */
async function assertAssignable(store, b) {
  if (b.stage === SCRAPPED) fail(409, `${label(b)} was scrapped.`);
  if (b.stage === 'deliver' || b.stage === DONE) fail(409, `${label(b)} already shipped.`);
  const cur = b.orderId && (await store.get(`orders/${b.orderId}`));
  if (cur && cur.data.kind === 'customer') fail(409, `${label(b)} already belongs to order ${b.orderId}, ${cur.data.customer}.`);
}

export async function assignBlades(store, body, { allFail = false } = {}) {
  const by = needBy(body);
  const order = await store.get(`orders/${Number(body.orderId)}`);
  if (!order) fail(404, 'No such order.');
  if (order.data.kind !== 'customer') fail(400, 'Blades can only be assigned to a customer order.');
  if (order.data.cancelled) fail(409, `Order ${order.data.id} was cancelled.`);
  const results = [];
  for (const id of body.bladeIds || []) {
    const at = new Date().toISOString();
    results.push(
      await attempt(id, async () => {
        const cur = await store.get(`blades/${id}`);
        if (!cur) fail(404, 'No such blade.');
        await assertAssignable(store, cur.data);
        return mutate(store, `blades/${id}`, (b) => {
          if (b.orderId !== cur.data.orderId) fail(409, `${label(b)} was just assigned to another order.`);
          if (b.orderId) b.stockOrderId = b.orderId;
          b.orderId = order.data.id;
          b.soldDate = shopDate(new Date(at));
          if (body.price !== undefined && body.price !== '') b.price = money(body.price);
          b.history.push({ step: 'assign', at, by, note: `To order ${order.data.id}, ${order.data.customer}` });
          return b;
        });
      }),
    );
  }
  return allFail ? { results } : batchResult(results);
}

async function attempt(id, fn) {
  try {
    return { id, ok: true, blade: await fn() };
  } catch (e) {
    if (e instanceof ApiError) return { id, ok: false, error: e.message };
    throw e;
  }
}
function batchResult(results) {
  if (results.length && results.every((r) => !r.ok)) fail(409, [...new Set(results.map((r) => r.error))].join(' '));
  return { results };
}

/** Finish a step. Each blade must be sitting at that step, so a double tap or a
 *  second person on another tablet cannot move a blade twice. */
export async function completeStep(store, body, role) {
  const by = needBy(body);
  const step = body.step;
  const idx = STEP_IDS.indexOf(step);
  if (idx < 0) fail(400, `Unknown step: ${step}`);
  const ids = Array.isArray(body.bladeIds) ? body.bladeIds.map(String) : [];
  if (!ids.length) fail(400, 'No blades selected.');
  if (step === 'laser' && ids.length > 1) fail(400, 'Laser one blade at a time, so each serial lands on the right blade.');
  const carrier = text(body.carrier, 40);
  if (step === 'ship' && !carrier) fail(400, 'How is it shipping?');
  const at = role === 'office' && body.at ? new Date(body.at).toISOString() : new Date().toISOString();
  // Split the shipment's cost across the blades actually shipping; leftover cents go on the first ones.
  const shipShare = new Map();
  if (step === 'ship' && role === 'office' && body.shipCost !== undefined && body.shipCost !== '') {
    const cents = Math.round(money(body.shipCost) * 100);
    const docs = await Promise.all(ids.map((id) => store.get(`blades/${id}`)));
    const moving = [];
    for (let i = 0; i < ids.length; i++) {
      const b = docs[i]?.data;
      if (!b || b.stage !== 'ship') continue;
      const o = b.orderId && (await store.get(`orders/${b.orderId}`));
      if (o && o.data.kind === 'customer') moving.push(ids[i]);
    }
    moving.forEach((id, i) => {
      const each = Math.floor(cents / moving.length) + (i < cents % moving.length ? 1 : 0);
      shipShare.set(id, each / 100);
    });
  }

  const results = [];
  for (const id of ids) {
    results.push(
      await attempt(id, async () => {
        const cur = await store.get(`blades/${id}`);
        if (!cur) fail(404, 'No such blade.');
        const job = cur.data.orderId && (await store.get(`orders/${cur.data.orderId}`));
        if (job?.data.hold) fail(409, `Order ${cur.data.orderId} is on hold: ${job.data.hold.reason}. Start it first.`);
        if (step === 'ship') {
          const order = cur.data.orderId && (await store.get(`orders/${cur.data.orderId}`));
          if (!order || order.data.kind !== 'customer') fail(409, `${label(cur.data)} is stock. Assign it to an order before shipping.`);
          if (!cur.data.serial) fail(409, `Order ${cur.data.orderId} blade has no serial on record. Ask the office to correct it before shipping.`);
        }
        if (step === 'laser') {
          const held = cur.data.serial;
          if (cur.data.stage !== 'laser') fail(409, `${label(cur.data)} is not at this step. It is at ${stageName(cur.data.stage)}.`);
          if (!held) fail(409, 'Get a serial for this blade first.');
          if (text(body.serial, 20) !== held) fail(409, `This blade now holds ${held}, not ${text(body.serial, 20) || 'the number on your screen'}. Check the steel before going on.`);
          // The register goes first: it decides any race against a void or a typed number.
          await mutate(store, `serials/${held}`, (s) => {
            if (s.bladeId !== id || (s.status !== 'reserved' && s.status !== 'lasered')) fail(409, `${held} is ${s.status} in the register. Get the office before burning it.`);
            return { ...s, status: 'lasered', laseredAt: at, laseredBy: by };
          });
        }
        return mutate(store, `blades/${id}`, (b) => {
          if (b.stage !== step) {
            fail(409, `${label(b)} is not at this step. It is at ${stageName(b.stage)}.`);
          }
          if (step === 'laser' && b.serial !== cur.data.serial) fail(409, `This blade now holds ${b.serial}. Check the steel before going on.`);
          const event = { step, at, by };
          if (config.STEPS[idx].machine && text(body.machine, 40)) event.machine = text(body.machine, 40);
          if (text(body.note, 500)) event.note = text(body.note, 500);
          if (step === 'crate') {
            b.crateNo = text(body.crateNo, 40);
            if (b.crateNo) event.crateNo = b.crateNo;
          }
          if (step === 'ship') {
            b.carrier = carrier;
            b.soldDate ||= shopDate(new Date(at));
            b.tracking = text(body.tracking, 80);
            if (shipShare.has(id)) b.shipCost = shipShare.get(id);
            event.carrier = carrier;
            if (b.tracking) event.tracking = b.tracking;
          }
          if (step === 'deliver') {
            b.receivedBy = text(body.receivedBy, 80);
            if (b.receivedBy) event.receivedBy = b.receivedBy;
          }
          b.history.push(event);
          const route = routeFor(conditionOf(b));
          b.stage = route[route.indexOf(step) + 1] || DONE;
          return b;
        });
      }),
    );
  }
  return batchResult(results);
}

const label = (b) => b.serial || `Order ${b.orderId} blade`;

/** Create-only, then read back as a second guard. */
async function claimSerial(store, serial, doc) {
  if (!(await store.put(`serials/${serial}`, doc, { onlyIfNew: true }))) return false;
  return (await store.get(`serials/${serial}`))?.data.bladeId === doc.bladeId;
}

/** Numbers one after another for a new order: handed-back ones first, then fresh. */
async function serialTaker(store, prefix = SERIAL.prefix) {
  const serials = await loadAll(store, 'serials/');
  const open = openSerials(serials, prefix);
  let n = nextNumber(serials, prefix);
  return async (fields) => {
    while (open.length) {
      const serial = open.shift();
      const cur = await store.get(`serials/${serial}`);
      if (cur?.data.status !== 'open') continue;
      if (await store.put(`serials/${serial}`, { ...cur.data, ...fields, status: 'reserved', serial }, { onlyIfMatch: cur.etag })) return serial;
    }
    for (let i = 0; i < 25; i++, n++) {
      const serial = serialFor(n, prefix);
      if (await claimSerial(store, serial, { ...fields, serial })) { n++; return serial; }
    }
    fail(409, 'Could not get serials for this order. Check Orders before trying again.');
  };
}

/** Hand out the next serial, or record one already on the steel. The claim is
 *  create-only, so no two blades can ever hold the same number. */
export async function reserveSerial(store, body) {
  const by = needBy(body);
  const id = String(body.bladeId || '');
  const cur = await store.get(`blades/${id}`);
  if (!cur) fail(404, 'No such blade.');
  const asked = body.serial ? text(body.serial, 20).toUpperCase() : null;
  const held = cur.data.serial;
  if (held && asked === held && cur.data.stage === 'laser') {
    // Typed means it is on the steel already, so it can never go back in the pool.
    await mutate(store, `serials/${held}`, (s) => {
      if (s.status === 'void' || s.bladeId !== id) fail(409, `${held} is ${s.status} in the register. Ask the office to correct the serial.`);
      return { ...s, status: 'lasered', laseredAt: new Date().toISOString(), laseredBy: by };
    });
    return { blade: cur.data, serial: held, laserText: laserText(held) };
  }
  if (held && (!asked || asked === held)) return { blade: cur.data, serial: held, laserText: laserText(held) };
  if (cur.data.stage !== 'laser') fail(409, 'That blade is not at the laser.');
  if (held) {
    const heldDoc = await store.get(`serials/${held}`);
    if (heldDoc && (heldDoc.data.status === 'lasered' || heldDoc.data.status === 'scrapped')) {
      fail(409, `${held} is already on this blade's steel. Ask the office to correct the serial.`);
    }
  }

  const at = new Date().toISOString();
  const doc = (serial) => ({ serial, bladeId: id, status: 'reserved', reservedAt: at, reservedBy: by });
  const claim = (candidate) => claimSerial(store, candidate, doc(candidate));
  let serial = null;
  if (body.serial) {
    const series = prefixFor(conditionOf(cur.data));
    if (!serialNumber(asked) || !inSeries(asked, series)) fail(400, `Serials on this blade look like ${serialFor(41, series)}.`);
    const onSteel = { ...doc(asked), status: 'lasered', laseredAt: at, laseredBy: by };
    const known = await store.get(`serials/${asked}`);
    if (known) {
      const free = known.data.status === 'open' && (await store.put(`serials/${asked}`, { ...known.data, ...onSteel }, { onlyIfMatch: known.etag }));
      if (!free) fail(409, `${asked} is already in the register.`);
    } else {
      // A typo here would jump the whole sequence for good.
      const limit = nextNumber(await loadAll(store, 'serials/'), series) + MAX_SERIAL_JUMP;
      if (serialNumber(asked) >= limit) fail(400, `${asked} is too far past the next number. Check the blade, or ask the office.`);
      if (!(await claimSerial(store, asked, onSteel))) fail(409, `${asked} is already in the register.`);
    }
    serial = asked;
  } else {
    const take = await serialTaker(store, prefixFor(conditionOf(cur.data)));
    serial = await take({ bladeId: id, status: 'reserved', reservedAt: at, reservedBy: by });
    if (!serial) fail(409, 'Could not get a serial. Try again.');
  }
  try {
    if (held) {
      await mutate(store, `serials/${held}`, (s) => {
        if (s.status === 'lasered' || s.status === 'scrapped') fail(409, `${held} was just burned on this blade.`);
        return { ...s, status: 'void', voidReason: `Not used: ${serial} went on the blade instead`, voidedBy: by, voidedAt: at };
      });
    }
    const blade = await mutate(store, `blades/${id}`, (b) => {
      if (b.stage !== 'laser') fail(409, 'That blade is not at the laser.');
      if (b.serial !== held) fail(409, `That blade changed to ${b.serial}. Try again.`);
      b.serial = serial;
      b.history.push({ step: 'serial', at, by, note: held ? `Serial ${serial} is on the steel. ${held} was not used and is void.` : `Serial ${serial} assigned` });
      return b;
    });
    return { blade, serial, laserText: laserText(serial) };
  } catch (e) {
    await mutate(store, `serials/${serial}`, (s) => ({ ...s, status: 'void', voidReason: `Never reached a blade: ${e.message}` }));
    throw e;
  }
}

/** Office fix for when the steel and the record disagree: a swapped pair, or a
 *  number that was voided but burned anyway. Every change is written to history. */
export async function correctSerial(store, body) {
  const by = needBy(body);
  const reason = text(body.reason, 300) || fail(400, 'Why is the serial being corrected?');
  const serial = text(body.serial, 20).toUpperCase();
  if (!serialNumber(serial)) fail(400, `Serials look like ${serialFor(41)} or ${serialFor(1, SERIAL.refurbPrefix)}.`);
  const id = String(body.bladeId || '');
  const at = new Date().toISOString();
  const cur = await store.get(`blades/${id}`);
  if (!cur) fail(404, 'No such blade.');
  if (cur.data.serial === serial) fail(409, `This blade already holds ${serial}.`);
  const old = cur.data.serial;

  const target = await store.get(`serials/${serial}`);
  if (!target) {
    const limit = nextNumber(await loadAll(store, 'serials/'), serial.slice(0, SERIAL.prefix.length)) + MAX_SERIAL_JUMP;
    if (serialNumber(serial) >= limit) fail(400, `${serial} is too far past the next number. Check the steel again.`);
  }
  const other = target?.data.bladeId && target.data.bladeId !== id ? await store.get(`blades/${target.data.bladeId}`) : null;
  if (other?.data.serial === serial) {
    await mutate(store, `blades/${other.data.id}`, (b) => {
      b.serial = null;
      b.check = `${serial} moved to another blade: ${reason} Check the steel and record the right number.`;
      b.history.push({ step: 'serial', at, by, note: `Serial ${serial} taken off: ${reason}` });
      return b;
    });
  }
  // The office read this number off the blade, so it is on the steel whatever step the blade is at.
  const status = cur.data.stage === SCRAPPED ? 'scrapped' : 'lasered';
  const fresh = { serial, bladeId: id, status, correctedAt: at, correctedBy: by, correctedReason: reason };
  if (target) await mutate(store, `serials/${serial}`, () => fresh);
  else if (!(await store.put(`serials/${serial}`, fresh, { onlyIfNew: true }))) fail(409, 'Someone just took that number. Try again.');

  const blade = await mutate(store, `blades/${id}`, (b) => {
    b.serial = serial;
    b.history.push({ step: 'serial', at, by, note: `Serial corrected${old ? ` from ${old}` : ''} to ${serial}: ${reason}` });
    return b;
  });
  if (old) {
    await mutate(store, `serials/${old}`, (s) =>
      s.bladeId === id ? { ...s, status: 'void', voidReason: `Corrected to ${serial}: ${reason}`, voidedBy: by, voidedAt: at } : s,
    );
  }
  return blade;
}

/** Undo a wrong assignment: the blade goes back to stock. */
export async function unassignBlade(store, body) {
  const by = needBy(body);
  const at = new Date().toISOString();
  const cur = await store.get(`blades/${String(body.bladeId)}`);
  if (!cur) fail(404, 'No such blade.');
  const check = (b) => {
    if (b.stage === SCRAPPED) fail(409, 'That blade was scrapped.');
    if (b.stage === 'deliver' || b.stage === DONE) fail(409, 'That blade already shipped. Send it back first.');
  };
  check(cur.data);
  const owner = cur.data.orderId ? await store.get(`orders/${cur.data.orderId}`) : null;
  if (!owner || owner.data.kind !== 'customer') fail(409, 'That blade is already stock.');
  const home = await stockHomeFor(store, cur.data, by, at, `From order ${cur.data.orderId}`);
  return mutate(store, `blades/${cur.data.id}`, (b) => {
    check(b);
    b.history.push({ step: 'assign', at, by, note: `Back to stock from order ${b.orderId}` });
    b.orderId = home;
    b.soldDate = null;
    delete b.soldNoDate;
    delete b.stockOrderId;
    return b;
  });
}

/** A voided number stays in the register forever and is never handed out again. */
export async function voidSerial(store, body) {
  const by = needBy(body);
  const reason = text(body.reason, 300) || fail(400, 'Why is this serial void?');
  const serial = text(body.serial, 20);
  const doc = await store.get(`serials/${serial}`);
  if (!doc) fail(404, 'That serial is not in the register.');
  const voided = await mutate(store, `serials/${serial}`, (s) => {
    if (s.status === 'lasered' || s.status === 'scrapped') fail(409, 'That serial is on the steel. Scrap the blade instead of voiding the number.');
    if (s.status === 'void') fail(409, 'That serial is already void.');
    return { ...s, status: 'void', voidReason: reason, voidedBy: by, voidedAt: new Date().toISOString() };
  });
  if (doc.data.bladeId) {
    await mutate(store, `blades/${doc.data.bladeId}`, (b) => {
      if (b.serial === serial) {
        b.serial = null;
        b.history.push({ step: 'serial', at: new Date().toISOString(), by, note: `Serial ${serial} voided: ${reason}` });
      }
      return b;
    });
  }
  return voided;
}

export async function sendBack(store, body) {
  const by = needBy(body);
  const reason = text(body.reason, 500) || fail(400, 'Why is it going back?');
  const to = STEP_IDS.indexOf(body.toStep);
  if (to < 0) fail(400, 'Unknown step.');
  return mutate(store, `blades/${String(body.bladeId)}`, (b) => {
    if (!routeFor(conditionOf(b)).includes(body.toStep)) fail(409, 'That step is not on this blade\'s route.');
    const from = STEP_IDS.indexOf(b.stage);
    if (from < 0 && b.stage !== DONE) fail(409, 'That blade is scrapped.');
    if (from >= 0 && to >= from) fail(409, 'A blade can only go back to an earlier step.');
    b.history.push({ step: 'rework', at: new Date().toISOString(), by, note: `Back to ${body.toStep}: ${reason}` });
    b.stage = body.toStep;
    // Going back before a step undoes what that step recorded; the history keeps it.
    // Shipping cost stays: it is money, and only the office changes money.
    if (to <= STEP_IDS.indexOf('crate')) delete b.crateNo;
    if (to <= STEP_IDS.indexOf('ship')) {
      delete b.carrier;
      delete b.tracking;
    }
    delete b.receivedBy;
    return b;
  });
}

export async function scrapBlade(store, body) {
  const by = needBy(body);
  const reason = text(body.reason, 500) || fail(400, 'Why is it scrapped?');
  const blade = await mutate(store, `blades/${String(body.bladeId)}`, (b) => {
    if (b.stage === SCRAPPED) fail(409, 'That blade is already scrapped.');
    if (b.stage === DONE) fail(409, 'That blade was delivered. Send it back first if it came home.');
    b.history.push({ step: 'scrap', at: new Date().toISOString(), by, note: reason });
    b.stage = SCRAPPED;
    return b;
  });
  if (blade.serial) {
    const reg = await store.get(`serials/${blade.serial}`);
    if (reg?.data.status === 'reserved') {
      await releaseSerial(store, blade.serial, `Blade scrapped: ${reason}`, by, new Date().toISOString());
      return mutate(store, `blades/${blade.id}`, (b) => ({ ...b, serial: null }));
    }
    await mutate(store, `serials/${blade.serial}`, (s) => ({
      ...s,
      status: s.status === 'lasered' ? 'scrapped' : 'void',
      voidReason: reason,
    }));
  }
  return blade;
}

export async function updateBlade(store, body) {
  const by = needBy(body);
  const before = await store.get(`blades/${String(body.bladeId)}`);
  const reg = before?.data.serial ? await store.get(`serials/${before.data.serial}`) : null;
  const burned = reg?.data.status === 'lasered' || reg?.data.status === 'scrapped';
  const changing = before && body.condition !== undefined && body.condition !== conditionOf(before.data) && CONDITIONS.some((c) => c.value === body.condition);
  const crossing = changing && before.data.serial && prefixFor(body.condition) !== prefixFor(conditionOf(before.data));
  if (crossing && burned) fail(409, `${before.data.serial} is on the steel, so this blade can't change between new and refurbished. Scrap it or correct the record.`);
  if (crossing && before.data.stage !== routeFor(conditionOf(before.data))[0] && !routeFor(body.condition).includes(before.data.stage)) fail(409, 'That blade has started its route. Its kind can no longer change.');
  const at = new Date().toISOString();
  const swapped = crossing ? await (await serialTaker(store, prefixFor(body.condition)))({ bladeId: before.data.id, status: 'reserved', reservedAt: at, reservedBy: by }) : null;
  const updated = await mutateBlade();
  if (swapped) await releaseSerial(store, before.data.serial, `Blade changed to ${body.condition}`, by, at);
  return updated;
  function mutateBlade() { return mutate(store, `blades/${String(body.bladeId)}`, (b) => {
    if (swapped) {
      b.history.push({ step: 'serial', at, by, note: `Serial changed from ${b.serial} to ${swapped}: kind of blade changed` });
      b.serial = swapped;
    }
    // History reaches the floor, so it names what changed and never the dollar amounts.
    const changed = [];
    const set = (f, v) => {
      if ((b[f] ?? null) !== (v ?? null) && !(b[f] == null && v === '')) changed.push(f);
      b[f] = v;
    };
    for (const f of ['price', 'ourCost', 'shipCost']) if (body[f] !== undefined) set(f, money(body[f]));
    for (const f of ['blankMaker', 'tipMaker', 'core', 'soldDate']) if (body[f] !== undefined) set(f, text(body[f], 40));
    if (body.type !== undefined) {
      if (!config.TYPES.includes(body.type)) fail(400, 'Pick slotted or solid.');
      set('type', body.type);
    }
    if (body.condition !== undefined && body.condition !== conditionOf(b)) {
      if (!CONDITIONS.some((c) => c.value === body.condition)) fail(400, 'Pick the kind of blade.');
      // The route depends on this: it can change before work starts, or where the blade's step is on both routes.
      const atStart = b.stage === routeFor(conditionOf(b))[0] && !burned;
      if (atStart) b.stage = routeFor(body.condition)[0];
      else if (b.stage !== DONE && !routeFor(body.condition).includes(b.stage)) fail(409, 'That blade has started its route. Its kind can no longer change.');
      set('condition', body.condition);
    }
    if (body.clearCheck && b.check) {
      b.history.push({ step: 'edit', at: new Date().toISOString(), by, note: `Check cleared: ${b.check}` });
      delete b.check;
    }
    if (changed.length) b.history.push({ step: 'edit', at: new Date().toISOString(), by, note: `Changed: ${changed.join(', ')}` });
    return b;
  }); }
}

const csvCell = (v) => {
  let s = v === null || v === undefined ? '' : String(v);
  if (typeof v !== 'number' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Same columns as the shop's Blade Inventory sheet, plus where the blade is now. */
export async function exportCsv(store) {
  const [blades, orders] = await Promise.all([loadAll(store, 'blades/'), loadAll(store, 'orders/')]);
  const byId = new Map(orders.map((o) => [o.id, o]));
  const head = ['Blade ID', 'Type', 'Blank Manufacturer', 'Tips', 'Core', 'Customer', 'Shipping Type', 'Blade Price', 'Our Cost', 'Shipping Cost', 'Total Cost', 'Date Sold', 'Margin', 'Stage', 'Order', 'Crate', 'Tracking', 'Kind'];
  const rows = blades
    .filter((b) => !b.cancelled)
    .sort((a, b) => String(a.serial || 'ZZ').localeCompare(String(b.serial || 'ZZ')))
    .map((b) => {
      const o = byId.get(b.orderId);
      const total = b.ourCost == null ? '' : Math.round((b.ourCost + (b.shipCost || 0)) * 100) / 100;
      return [b.serial, b.type, b.blankMaker, b.tipMaker, b.core, o?.customer, b.carrier, b.price, b.ourCost, b.shipCost, total, b.soldDate, marginOf(b), b.stage, b.orderId, b.crateNo, b.tracking, conditionOf(b)];
    });
  return [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** Load the spreadsheet and paper log. Create-only: it never overwrites live records. */
export async function seed(store) {
  let added = 0;
  for (const { key, doc } of seedDocs()) if (await store.put(key, doc, { onlyIfNew: true })) added++;
  return { added };
}

const ROUTES = {
  'POST orders': { office: true, run: (s, b) => createOrder(s, b) },
  'POST orders/update': { office: true, run: (s, b) => updateOrder(s, b) },
  'POST orders/hold': { run: (s, b) => holdOrder(s, b) },
  'POST orders/cancel': { office: true, run: (s, b) => cancelOrder(s, b) },
  'POST inventory': { run: (s, b, role) => addInventory(s, b, role) },
  'POST blades/assign': { office: true, run: (s, b) => assignBlades(s, b) },
  'POST blades/unassign': { office: true, run: (s, b) => unassignBlade(s, b) },
  'POST serials/correct': { office: true, run: (s, b) => correctSerial(s, b) },
  'POST blades/update': { office: true, run: (s, b) => updateBlade(s, b) },
  'POST blades/scrap': { run: (s, b) => scrapBlade(s, b) },
  'POST blades/back': { run: (s, b) => sendBack(s, b) },
  'POST steps/complete': { run: (s, b, role) => completeStep(s, b, role) },
  'POST laser/reserve': { run: (s, b) => reserveSerial(s, b) },
  'POST serials/void': { office: true, run: (s, b) => voidSerial(s, b) },
  'POST admin/seed': { office: true, run: (s) => seed(s) },
};

const json = (status, body) => ({ status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(body) });

/** One entry point, shared by the Netlify function, the dev server and the tests. */
export async function handle(store, env, { method, path, passcode, body }) {
  try {
    const role = roleFor(passcode, env);
    if (!role) return json(401, { error: 'Wrong passcode.' });
    const route = `${method} ${path}`;
    if (route === 'GET state') return json(200, await getState(store, role));
    if (route === 'GET export.csv') {
      if (role !== 'office') return json(403, { error: 'Office only.' });
      return { status: 200, headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="helanbak-blades.csv"', 'cache-control': 'no-store' }, body: await exportCsv(store) };
    }
    const r = ROUTES[route];
    if (!r) return json(404, { error: 'No such route.' });
    if (r.office && role !== 'office') return json(403, { error: 'Office only.' });
    const result = await r.run(store, body || {}, role);
    return json(200, role === 'office' ? result : scrub(result));
  } catch (e) {
    if (e instanceof ApiError) return json(e.status, { error: e.message });
    console.error(e);
    return json(500, { error: 'Something went wrong on the server.' });
  }
}

/** Nothing a floor passcode receives may carry money, including write responses. */
function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (!['price', 'ourCost', 'shipCost', 'margin', 'contact'].includes(k)) out[k] = scrub(v);
    }
    return out;
  }
  return value;
}

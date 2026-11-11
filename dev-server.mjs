// Local only. Uses a file store under .data and throwaway passcodes.
// By default it serves this Mac alone and loads the real starting records.
// BLADE_DEMO=1 uses fake records in .data-demo and serves the Wi-Fi, for testing on a shop tablet.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handle, seed, createOrder, completeStep, addInventory } from './lib/core.mjs';
import { fileStore } from './lib/store-file.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT || 4177);
const demo = process.env.BLADE_DEMO === '1';
const store = fileStore(join(here, demo ? '.data-demo' : '.data'));
const env = {
  BLADE_OFFICE_PASSCODE: process.env.BLADE_OFFICE_PASSCODE || 'office-dev',
  BLADE_FLOOR_PASSCODE: process.env.BLADE_FLOOR_PASSCODE || 'floor-dev',
};
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

if (!demo) {
  await seed(store);
} else if (!(await store.list('orders/')).length) {
  const by = 'Demo';
  const job = (o) => createOrder(store, { by, price: 100, ourCost: 50, assignSerials: true, ...o });
  const move = async (ids, steps) => {
    for (const step of steps) {
      for (const id of ids) {
        const b = (await store.get(`blades/${id}`)).data;
        await completeStep(store, { bladeIds: [id], step, by, carrier: 'UPS', serial: b.serial }, 'office');
      }
    }
  };
  await job({ customer: 'Demo Timber Co', qty: 2, type: 'SOLID', condition: 'NEW', hold: true, due: '2026-11-20' });
  await job({ customer: 'Demo Line Clearing', qty: 1, type: 'SLOTTED', condition: 'REFURB', hold: true, holdReason: 'Waiting on the customer to bring the blade' });
  const a = await job({ customer: 'Demo Land Clearing', qty: 2, type: 'SOLID', condition: 'REFURB', due: '2026-11-12' });
  await move(a.bladeIds, ['remove_tips', 'flatten']);
  const b = await job({ customer: 'Demo Tree Service', qty: 4, type: 'SLOTTED', condition: 'NEW', due: '2026-11-10' });
  await move(b.bladeIds, ['laser', 'wash_in']);
  const c = await job({ customer: 'Demo Right of Way', qty: 8, type: 'SLOTTED', condition: 'NEW', due: '2026-11-07' });
  await move(c.bladeIds, ['laser', 'wash_in', 'tipping', 'side_grind', 'face_grind']);
  await move(c.bladeIds.slice(0, 5), ['top_grind']);
  const d = await job({ customer: 'Demo eBay', qty: 2, type: 'SLOTTED', condition: 'RESALE' });
  await move(d.bladeIds, ['laser', 'wash_out']);
  const e = await job({ customer: 'Demo Utility Crew', qty: 3, type: 'SOLID', condition: 'NEW' });
  await move(e.bladeIds, ['laser', 'wash_in', 'tipping', 'side_grind', 'face_grind', 'top_grind', 'wash_out', 'dip', 'crate']);
  const st = await addInventory(store, { by, qty: 2, type: 'SOLID', condition: 'NEW' }, 'office');
  await move(st.bladeIds, ['laser', 'wash_in', 'tipping', 'side_grind', 'face_grind', 'top_grind', 'wash_out', 'dip', 'crate']);
  const st2 = await addInventory(store, { by, qty: 3, type: 'SLOTTED', condition: 'NEW' }, 'office');
  await move(st2.bladeIds, ['laser', 'wash_in']);
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    let raw = '';
    for await (const c of req) raw += c;
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      res.writeHead(400).end('{"error":"Bad request."}');
      return;
    }
    const r = await handle(store, env, { method: req.method, path: url.pathname.slice(5), passcode: req.headers['x-passcode'], body });
    res.writeHead(r.status, r.headers).end(r.body);
    return;
  }
  const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname);
  try {
    const data = await readFile(join(here, 'public', rel));
    res.writeHead(200, { 'content-type': TYPES[extname(rel)] || 'application/octet-stream' }).end(data);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(port, demo ? '0.0.0.0' : '127.0.0.1', () => console.log(`Blade tracker on port ${port}${demo ? ', fake data, open to the Wi-Fi' : ', this Mac only'} (office-dev / floor-dev)`));

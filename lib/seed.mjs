import { serialFor } from './core.mjs';

// Sample starting records (made-up customers and costs) showing how an old
// spreadsheet (ND0000001-24) and a paper numbering log (25-40) are imported.
// Replace them with your own. Anything a person should confirm carries a `check` note.
const IMPORTED = 'Imported from the Blade Inventory sheet';
const LOG = 'Imported from the paper numbering log';

const groups = [
  { customer: 'Sample Timber Co', sold: '2026-10-08', carrier: 'UPS', from: 1, to: 5, type: 'SLOTTED', maker: 'MAKER-A', tips: 'Maker A', core: 'NO', price: 390, cost: 200, ship: { 1: 25, 3: 25, 5: 25 }, stage: 'deliver', check: 'UPS: delivery not confirmed on the sheet.' },
  { customer: 'Sample Tree Service', sold: '2026-10-10', carrier: 'Delivered by us', from: 6, to: 7, type: 'SLOTTED', maker: 'MAKER-B', tips: 'Maker B', core: 'NO', price: 380, cost: 200, stage: 'delivered' },
  { customer: 'Sample Land Clearing', sold: '2026-10-12', carrier: 'Delivered by us', from: 8, to: 10, type: 'SLOTTED', maker: 'MAKER-B', tips: 'Maker B', core: 'NO', price: 390, cost: 200, stage: 'delivered' },
  { customer: null, from: 11, to: 12, type: 'SOLID', maker: 'MAKER-B', tips: 'Maker B', core: '', price: 380, cost: 200, stage: 'crate', check: 'Sheet shows no sale. Which step is it really at?' },
  { customer: 'Sample Right of Way', sold: '2026-10-20', carrier: 'Delivered by us', from: 13, to: 20, type: 'SLOTTED', maker: 'MAKER-B', tips: 'Maker B', core: 'NO', price: 390, cost: 200, stage: 'delivered' },
  { customer: 'Online sale', sold: '2026-10-21', carrier: 'UPS', from: 21, to: 22, type: 'SLOTTED', maker: 'MAKER-B', tips: 'Maker B', core: '', price: 345, cost: 200, stage: 'deliver', check: 'UPS: no shipping cost or marketplace fee on the sheet, so margin is overstated.' },
  { customer: 'Online sale', sold: null, from: 23, to: 24, type: 'SLOTTED', maker: 'MAKER-B', tips: 'Maker B', core: '', price: 345, cost: 200, stage: 'ship', check: 'On the sheet under Online sale with no sold date. Listed, or sold?' },
];

// Paper log: number, type, date written beside it, sold date, name beside it.
const logged = [
  [25, null, '2026-10-29', 'sold', null, 'Type not written. The slanted dates beside 25 and 26 are hard to read.'],
  [26, null, '2026-10-30', null, 'Pat', 'Type not written. The slanted dates beside 25 and 26 are hard to read.'],
  [27, 'SOLID', '2026-10-30', 'sold', 'Pat'],
  [28, 'SLOTTED', '2026-10-31'],
  [29, 'SLOTTED', '2026-10-31'],
  [30, 'SLOTTED', '2026-10-31'],
  [31, 'SOLID', '2026-10-31', 'sold', 'Pat'],
  [32, 'SLOTTED', '2026-10-31', '2026-11-02'],
  [33, 'SLOTTED', '2026-10-31'],
  [34, 'SLOTTED', '2026-10-31', '2026-11-02'],
  [35, 'SOLID', '2026-11-02', '2026-11-02'],
  [36, 'SOLID', '2026-11-02'],
  [37, 'SOLID', '2026-11-02'],
  [38, 'SOLID', '2026-11-02'],
  [39, 'SOLID', '2026-11-02'],
  [40, 'SOLID', '2026-11-02'],
];

export function seedDocs() {
  const docs = [];
  let orderId = 900;
  const orderFor = new Map();
  const order = (name, kind, createdAt, note) => {
    const key = `${kind}:${name}:${createdAt}`;
    if (!orderFor.has(key)) {
      const id = ++orderId;
      orderFor.set(key, id);
      docs.push({ key: `orders/${id}`, doc: { id, kind, customer: name, contact: '', po: '', due: '', shipMethod: '', notes: note, createdAt: `${createdAt}T12:00:00.000Z`, createdBy: 'Import' } });
    }
    return orderFor.get(key);
  };
  const addBlade = (n, b, at, by, note) => {
    const serial = serialFor(n);
    docs.push({ key: `blades/imp_${n}`, doc: { id: `imp_${n}`, serial, imported: true, condition: 'NEW', ...b, history: [{ step: 'import', at: `${at}T12:00:00.000Z`, by, note }] } });
    docs.push({ key: `serials/${serial}`, doc: { serial, bladeId: `imp_${n}`, status: 'lasered', laseredAt: `${at}T12:00:00.000Z`, laseredBy: by === 'Import' ? '' : by, imported: true } });
  };

  for (const g of groups) {
    const orderId = order(g.customer || 'Stock', g.customer ? 'customer' : 'stock', g.sold || '2026-10-21', IMPORTED);
    for (let n = g.from; n <= g.to; n++) {
      addBlade(n, { orderId, type: g.type, blankMaker: g.maker, tipMaker: g.tips, core: g.core, stage: g.stage, price: g.price, ourCost: g.cost, shipCost: g.ship?.[n] ?? null, soldDate: g.sold || null, carrier: g.carrier || '', ...(g.check ? { check: g.check } : {}) }, g.sold || '2026-10-21', 'Import', IMPORTED);
    }
  }
  for (const [n, type, date, sold, name, note] of logged) {
    const isSold = Boolean(sold) || Boolean(name);
    const orderId = isSold ? order('Sold, name not on the log', 'customer', '2026-11-02', `${LOG}. Fill in the real customer.`) : order('Stock', 'stock', '2026-11-02', LOG);
    const checks = [note, name ? `Log says ${name}: the owner says Pat drops blades off, so this is likely who delivers, not who bought.` : null, type ? null : 'Type?', 'Which step is it at? Started at Dip tips because it is lasered.', isSold ? 'Who bought it, at what price?' : null].filter(Boolean);
    addBlade(n, { orderId, type: type || 'SLOTTED', blankMaker: '', tipMaker: '', core: '', stage: 'dip', price: null, ourCost: null, shipCost: null, soldDate: sold && sold !== 'sold' ? sold : null, ...(isSold && (!sold || sold === 'sold') ? { soldNoDate: true } : {}), carrier: '', check: checks.join(' ') }, date, 'Shop log', LOG);
  }
  return docs;
}

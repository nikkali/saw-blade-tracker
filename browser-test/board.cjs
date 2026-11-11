// Walks the job board in a real browser on fake data. It starts its own server on
// port 4193 with an empty demo folder, so real records are never touched.
//   npm i --no-save playwright-core && node browser-test/board.cjs
const { chromium } = require('playwright-core');
const { spawn } = require('node:child_process');
const { rmSync } = require('node:fs');
const { join } = require('node:path');

const ROOT = join(__dirname, '..');
const U = 'http://localhost:4193/';
let pass = 0;
const bad = [];
const errors = [];
const ok = (c, label) => { if (c) pass++; else { bad.push(label); console.log('FAIL', label); } };
const api = (code, path, body) => fetch(U + 'api/' + path, { method: body ? 'POST' : 'GET', headers: { 'x-passcode': code }, body: body && JSON.stringify(body) }).then((r) => r.json());
const state = () => api('office-dev', 'state');

async function open(browser, code, width, height) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  await ctx.addInitScript(() => { try { localStorage.setItem('blade.name', 'Tester'); } catch {} });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(U);
  await page.fill('input.passcode', code);
  await page.keyboard.press('Enter');
  await page.waitForSelector('.lanes');
  return page;
}
const go = async (p, hash) => { await p.evaluate((h) => { location.hash = h; }, hash); await p.waitForTimeout(500); };
const laneOf = (p, text) => p.evaluate((t) => { const c = [...document.querySelectorAll('.job-card')].find((x) => x.textContent.includes(t)); return c ? c.dataset.lane : null; }, text);
// Taps the lit box and finishes whatever sheet comes up.
async function tickNext(p, fill) {
  await p.click('.tick.next');
  await p.waitForSelector('dialog[open]');
  if (fill) await fill();
  for (let i = 0; i < 3 && (await p.locator('dialog[open] .btn.main:not([disabled])').count()); i++) {
    await p.locator('dialog[open] .btn.main').click();
    await p.waitForFunction(() => !document.querySelector('dialog[open] .btn.main[disabled]'));
    await p.waitForTimeout(250);
  }
}
async function laser(p, jobHash, blades) {
  for (let i = 0; i < blades; i++) {
    await go(p, jobHash);
    await p.click('.tick.next');
    await p.waitForTimeout(150);
    if (await p.locator('dialog[open]').count()) await p.locator('dialog[open] .btn.wide').first().click();
    await p.waitForSelector('.serial-huge');
    await p.getByRole('button', { name: 'Lasered', exact: true }).click();
    await p.waitForSelector('.tick');
  }
}

async function walk(browser, w, h) {
  const tag = `${w}x${h}`;
  const p = await open(browser, 'office-dev', w, h);
  const name = `Walk ${tag}`;

  // New order, through the form
  await go(p, '#/orders/new');
  await p.locator('label.field', { hasText: 'Customer' }).locator('input').fill(name);
  await p.getByRole('button', { name: 'SLOTTED', exact: true }).click();
  await p.locator('label.field', { hasText: 'Quantity to make' }).locator('input').fill('2');
  await p.locator('label.field', { hasText: 'Price each' }).locator('input').fill('390');
  await p.locator('label.field', { hasText: 'Our cost each' }).locator('input').fill('200');
  await p.getByRole('button', { name: 'Create order' }).click();
  await p.waitForFunction(() => location.hash.startsWith('#/job/'));
  const order = (await state()).orders.find((o) => o.customer === name);
  ok(order && order.hold, `${tag}: a new order starts on hold`);
  const blades = (await state()).blades.filter((b) => b.orderId === order.id);
  ok(blades.length === 2 && blades.every((b) => b.serial), `${tag}: the order took its serials`);
  const job = '#/job/' + order.id;
  await go(p, '#/board');
  const lane0 = await laneOf(p, name);
  ok(lane0 === 'hold', `${tag}: card is in Hold`);

  // Start, then every box
  await go(p, job);
  ok(await p.locator('.tick.next').count() === 0, `${tag}: no box is live on hold`);
  await p.getByRole('button', { name: 'Start this job' }).click();
  await p.locator('dialog[open] .btn.main').click();
  await p.waitForSelector('.tick.next');
  const labels = await p.locator('.check-label').allInnerTexts();
  ok(labels.join() === 'Laser serial,Wash blank,Tipping,Grind sides,Grind face,Grind top,Final wash,Dip tips,Crate,Ship,Delivery', `${tag}: new build boxes: ${labels.join()}`);
  await laser(p, job, 2);
  await go(p, job);
  await tickNext(p);
  await go(p, '#/board');
  ok((await laneOf(p, name)) === 'tipping', `${tag}: card moved to Tipping`);
  await go(p, job);
  await p.click('.tick.next');
  await p.locator('dialog[open] .pick-row').first().click();
  await p.locator('dialog[open] .btn.main').click();
  await p.waitForTimeout(300);
  ok((await p.locator('.tick.next .check-count').innerText()) === '1/2', `${tag}: partial pick shows 1/2`);
  await go(p, '#/board');
  ok((await laneOf(p, name)) === 'tipping', `${tag}: card stays with the blade behind`);
  await go(p, job);
  for (let i = 0; i < 2; i++) await tickNext(p);
  await go(p, '#/board');
  ok((await laneOf(p, name)) === 'finishing', `${tag}: card in Finishing, tipping count ok`);
  await go(p, job);
  await p.waitForSelector('.tick.next');
  while ((await p.locator('.tick.next .check-label').innerText()) !== 'Crate') await tickNext(p);
  await go(p, '#/board');
  ok((await laneOf(p, name)) === 'ship_out', `${tag}: card in Ship Out`);
  await go(p, job);
  await tickNext(p);
  await p.click('.tick.next');
  await p.waitForSelector('dialog[open]');
  await p.locator('dialog[open] .btn.main').click();
  await p.getByRole('button', { name: 'UPS', exact: true }).click();
  await p.locator('dialog[open] .btn.main').click();
  await p.waitForFunction(() => !document.querySelector('dialog[open]'));
  await p.waitForTimeout(300);
  await tickNext(p);
  const done = (await state()).blades.filter((b) => b.orderId === order.id);
  ok(done.every((b) => b.stage === 'delivered'), `${tag}: delivered: ${done.map((b) => b.stage)}`);
  await go(p, '#/board');
  ok((await laneOf(p, name)) === null, `${tag}: a delivered job leaves the board`);

  // Inventory, from the board, on the floor passcode
  const f = await open(browser, 'floor-dev', w, h);
  await f.getByRole('button', { name: 'Add to inventory' }).click();
  await f.locator('dialog[open] label.field', { hasText: 'How many' }).locator('input').fill('1');
  await f.locator('dialog[open]').getByRole('button', { name: 'SOLID', exact: true }).click();
  await f.locator('dialog[open]').getByRole('button', { name: 'Bought finished', exact: true }).click();
  await f.locator('dialog[open] .btn.main').click();
  await f.waitForSelector('.tick.next');
  const hash = await f.evaluate(() => location.hash);
  const labels2 = await f.locator('.check-label').allInnerTexts();
  ok(labels2.join() === 'Laser serial,Final wash,Dip tips,Crate', `${tag}: inventory boxes stop at Crate: ${labels2.join()}`);
  await laser(f, hash, 1);
  await go(f, hash);
  for (let i = 0; i < 3; i++) await tickNext(f);
  const body = await f.locator('body').innerText();
  ok(body.includes('Finished'), `${tag}: a finished inventory job says so`);
  await go(f, '#/inventory');
  const stockOrder = Number(hash.split('/').pop());
  const stockId = (await state()).blades.find((b) => b.orderId === stockOrder).serial;
  ok(/^ND/.test(stockId), `${tag}: blade is on the Inventory screen: ${stockId}`);
  const fstate = JSON.stringify(await api('floor-dev', 'state'));
  ok(!/"price"|"ourCost"|"margin"|"shipCost"/.test(fstate), `${tag}: floor receives no money`);
  await f.context().close();

  // Sell it through the form, then cancel: it returns to inventory with its number
  await go(p, '#/orders/new');
  await p.locator('label.field', { hasText: 'Customer' }).locator('input').fill(name + ' sale');
  await p.getByRole('button', { name: 'SOLID', exact: true }).click();
  await p.getByRole('button', { name: 'Bought finished', exact: true }).click();
  await p.waitForSelector('.pick-row');
  await p.locator('.pick-row', { hasText: stockId }).click();
  await p.getByRole('button', { name: 'Create order' }).click();
  await p.waitForFunction(() => location.hash.startsWith('#/job/'));
  const sale = (await state()).orders.find((o) => o.customer === name + ' sale');
  const sold = (await state()).blades.find((b) => b.serial === stockId);
  ok(sold.orderId === sale.id, `${tag}: stock blade moved to the sale with its serial`);
  await api('office-dev', 'orders/hold', { id: sale.id, by: 'T', start: true });
  await go(p, '#/job/' + sale.id);
  await p.getByRole('button', { name: 'Cancel this order' }).click();
  await p.locator('dialog[open] textarea').fill('Changed their mind');
  await p.locator('dialog[open] .btn.main').click();
  await p.waitForSelector('.lanes');
  const back = (await state()).blades.find((b) => b.serial === stockId);
  ok(back.stage === 'ship' && (await state()).orders.find((o) => o.id === back.orderId).kind === 'stock', `${tag}: cancel returns it to inventory`);

  // A refurb gets the RD series and shows it on the card
  await go(p, '#/orders/new');
  await p.locator('label.field', { hasText: 'Customer' }).locator('input').fill(name + ' refurb');
  await p.getByRole('button', { name: 'SOLID', exact: true }).click();
  await p.getByRole('button', { name: 'Refurbished', exact: true }).click();
  await p.locator('label.field', { hasText: 'Quantity to make' }).locator('input').fill('1');
  await p.getByRole('button', { name: 'Create order' }).click();
  await p.waitForFunction(() => location.hash.startsWith('#/job/'));
  await p.waitForSelector('.job-serials');
  ok(/RD\d{7}/.test(await p.locator('.job-serials').innerText()), `${tag}: refurb card shows an RD serial`);
  ok((await p.locator('.check-label').allInnerTexts()).slice(0, 5).join() === 'Remove old tips,Flatten (roller),Polish,Blank check,Laser serial', `${tag}: refurb boxes start with its prep, then the laser`);

  // Nothing spills out of a card
  await go(p, '#/board');
  const spill = await p.evaluate(() => {
    const out = [];
    for (const card of document.querySelectorAll('.job-card, .tick')) {
      const c = card.getBoundingClientRect();
      for (const el of card.querySelectorAll('*')) { const r = el.getBoundingClientRect(); if (r.width && r.right > c.right + 0.5) out.push(el.textContent.slice(0, 20)); }
    }
    return out;
  });
  ok(!spill.length, `${tag}: nothing spills off a card: ${spill.join()}`);
  ok((await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth)), `${tag}: no sideways scroll`);
  await p.context().close();
}

(async () => {
  rmSync(join(ROOT, '.data-demo'), { recursive: true, force: true });
  const srv = spawn('node', ['dev-server.mjs'], { cwd: ROOT, env: { ...process.env, BLADE_DEMO: '1', PORT: '4193' }, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1500));
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  try {
    for (const [w, h] of [[1024, 440], [1024, 768], [390, 844]]) {
      try { await walk(browser, w, h); } catch (e) { bad.push(`${w}x${h} threw: ${e.message.split('\n').slice(0, 2).join(' ')}`); console.log('THROW', w, h, e.message.slice(0, 300)); }
    }
  } finally {
    await browser.close();
    srv.kill();
    rmSync(join(ROOT, '.data-demo'), { recursive: true, force: true });
  }
  console.log(`passed ${pass}, failed ${bad.length}; page errors: ${errors.length ? errors.join(' / ') : 'none'}`);
  process.exit(bad.length ? 1 : 0);
})();

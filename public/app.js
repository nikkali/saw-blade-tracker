'use strict';
/* Helanbak blade tracker front end. No framework. Every piece of data reaches the
   DOM through h(), which only ever uses text nodes and setAttribute, so free text
   (customer names, notes) cannot become markup. Do not add innerHTML here. */

(function () {
  /* ---------- small helpers ---------- */

  const $ = (id) => document.getElementById(id);

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (k === 'value') el.value = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    add(el, kids);
    return el;
  }
  function add(el, kids) {
    for (const k of kids) {
      if (k === null || k === undefined || k === false) continue;
      if (Array.isArray(k)) add(el, k);
      else el.append(k instanceof Node ? k : document.createTextNode(String(k)));
    }
  }
  const clear = (el, ...kids) => {
    el.textContent = '';
    add(el, kids);
  };

  const local = {
    mem: {},
    get(k) {
      try {
        const v = localStorage.getItem(k);
        if (v !== null) return v;
      } catch { /* blocked storage: fall back to memory */ }
      return this.mem[k] || '';
    },
    set(k, v) {
      this.mem[k] = v;
      try { localStorage.setItem(k, v); } catch { /* memory copy still works */ }
    },
    del(k) {
      delete this.mem[k];
      try { localStorage.removeItem(k); } catch { /* nothing to do */ }
    },
  };

  /* ---------- state ---------- */

  const S = {
    pass: local.get('blade.passcode'),
    name: local.get('blade.name'),
    state: null,
    offline: false,
    signInError: '',
    lastJson: '',
    lastRender: 0,
    dirty: false,
    seq: 0,
  };
  const ui = {
    route: [],
    sel: {},
    search: '',
    orderFilter: 'open',
    serialQ: '',
    moneyMissing: false,
    notice: null,
    pendingNotice: null,
    formLock: false,
    laserText: {},
  };
  const sheets = [];

  const NET_MSG = "Can't reach the server. Your last tap may not have saved.";
  class NetErr extends Error { constructor() { super(NET_MSG); } }
  class ApiErr extends Error { constructor(m, status) { super(m); this.status = status; } }

  const cfg = () => S.state.config;
  const isOffice = () => S.state && S.state.role === 'office';
  const steps = () => cfg().STEPS;
  const stepById = (id) => steps().find((s) => s.id === id);
  const conditionOf = (b) => b.condition || 'NEW';
  const routeOf = (b) => steps().filter((s) => !s.only || s.only.includes(conditionOf(b)));
  const realOrders = () => S.state.orders.filter((o) => !o.claiming);
  const orderOf = (b) => S.state.orders.find((o) => o.id === b.orderId) || null;
  const bladeById = (id) => S.state.blades.find((b) => b.id === id) || null;
  const isStock = (b) => { const o = orderOf(b); return !o || o.kind !== 'customer'; };
  const customerOf = (b) => (isStock(b) ? 'Stock' : orderOf(b).customer);
  const bladeName = (b) => b.serial || (b.orderId ? `Order ${b.orderId} · blade` : 'Stock blade');
  const stageLabel = (stage) => {
    if (stage === cfg().DONE) return 'Delivered';
    if (stage === cfg().SCRAPPED) return 'Scrapped';
    const s = stepById(stage);
    return s ? s.label : stage;
  };
  const isFinished = (b) => b.stage === cfg().DONE || b.stage === cfg().SCRAPPED;
  const friendly = (msg) => String(msg).replace(/\(now: ([\w-]+)\)/, (_, id) => `(now: ${stageLabel(id)})`);
  const errText = (e) => (e instanceof NetErr ? NET_MSG : friendly(e.message || 'Something went wrong.'));

  /* ---------- formatting ---------- */

  function since(iso) {
    const ms = Date.now() - new Date(iso).getTime();
    if (!(ms > 0)) return 'under an hour';
    const hours = Math.floor(ms / 3600000);
    if (hours < 1) return 'under an hour';
    if (hours < 24) return hours === 1 ? '1 hour' : `${hours} hours`;
    const days = Math.floor(hours / 24);
    return days === 1 ? '1 day' : `${days} days`;
  }
  const MOVES = new Set(['serial', 'assign']);
  function waitingSince(b) {
    for (let i = (b.history || []).length - 1; i >= 0; i--) {
      if (!MOVES.has(b.history[i].step) && b.history[i].at) return b.history[i].at;
    }
    return b.history && b.history[0] ? b.history[0].at : new Date().toISOString();
  }
  function dayText(ymd) {
    if (!ymd) return '';
    /* A bare date is a calendar day. A full timestamp is shown in the shop's local day. */
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
    const d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(ymd);
    if (isNaN(d)) return ymd;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function whenText(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return String(iso);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function dollars(n) {
    if (n === null || n === undefined) return '';
    const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (n < 0 ? '-$' : '$') + abs;
  }
  const plural = (n, one, many) => (n === 1 ? `1 ${one}` : `${n} ${many || one + 's'}`);
  const todayYmd = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  /* '' stays '', a number comes back as a number, anything else throws a plain sentence. */
  function moneyIn(raw, label) {
    const t = String(raw || '').replace(/[$,\s]/g, '');
    if (!t) return '';
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0) throw new ApiErr(`${label} must be a dollar amount, like 390 or 25.50.`);
    return n;
  }
  const serialNum = (s) => {
    const m = /(\d+)$/.exec(s || '');
    return m ? Number(m[1]) : 0;
  };
  const seriesOf = (b) => (b.condition === 'REFURB' ? cfg().SERIAL.refurbPrefix : cfg().SERIAL.prefix);
  const nextFor = (b) => (b.condition === 'REFURB' ? S.state.nextRefurbSerial : S.state.nextSerial);
  /* Plain digits take the blade's own series; a typed ND or RD is kept as typed. */
  function normalizeSerial(raw, fallback) {
    const { prefix, refurbPrefix, digits } = cfg().SERIAL;
    const m = new RegExp(`^(${prefix}|${refurbPrefix})?0*(\\d+)$`, 'i').exec(String(raw).trim());
    if (!m || m[2].length > digits) return null;
    return (m[1] ? m[1].toUpperCase() : fallback || prefix) + m[2].padStart(digits, '0');
  }
  function laserLines(id, serial) {
    const cached = ui.laserText[id];
    if (cached && cached[0] === serial) return cached;
    const spec = cfg().SPEC;
    return [serial, ...Object.keys(spec).filter((k) => /^line\d+$/.test(k)).sort().map((k) => spec[k])];
  }

  /* ---------- server ---------- */

  async function api(path, body, wantText) {
    const headers = { 'x-passcode': S.pass };
    if (body) headers['content-type'] = 'application/json';
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    let res;
    try {
      res = await fetch('/api/' + path, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal });
    } catch {
      throw new NetErr();
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401) {
      signOut('That passcode did not work. Check it and try again.');
      throw new ApiErr('Wrong passcode.', 401);
    }
    if (wantText && res.ok) return res.blob();
    const text = await res.text().catch(() => '');
    let data = null;
    try { data = JSON.parse(text); } catch { /* handled below */ }
    if (!res.ok) throw new ApiErr((data && data.error) || 'Something went wrong on the server.', res.status);
    if (!data) throw new ApiErr('The server sent back something unexpected.', res.status);
    data.__text = text;
    return data;
  }

  async function refresh() {
    if (!S.pass) return;
    const seq = ++S.seq;
    try {
      const data = await api('state');
      if (seq !== S.seq || !S.pass) return;
      const text = data.__text;
      delete data.__text;
      const changed = text !== S.lastJson;
      S.lastJson = text;
      S.state = data;
      const wasOffline = S.offline;
      S.offline = false;
      renderBanner();
      if (changed || wasOffline || Date.now() - S.lastRender > 300000) softRender();
    } catch (e) {
      if (seq !== S.seq || !S.pass) return;
      if (e instanceof NetErr) {
        S.offline = true;
        renderBanner();
        if (!S.state) renderView();
      } else if (e.status !== 401) {
        setNotice({ bad: true, title: errText(e) });
      }
    }
  }

  /* Every write refreshes afterwards, whether or not it worked. */
  async function write(path, body) {
    if (ui.notice) setNotice(null); /* the old message must not read as this tap's result */
    try {
      const out = await api(path, body);
      delete out.__text;
      await refresh();
      return out;
    } catch (e) {
      if (e instanceof ApiErr && e.status === 401) throw e;
      await refresh();
      if (e instanceof NetErr) {
        S.offline = true;
        renderBanner();
      }
      throw e;
    }
  }

  function signOut(message) {
    local.del('blade.passcode');
    S.pass = '';
    S.state = null;
    S.lastJson = '';
    S.signInError = message || '';
    closeAllSheets();
    ui.formLock = false;
    ui.notice = null;
    render();
  }

  /* ---------- double-tap guard ---------- */

  let busy = false;
  function guarded(btn, fn, busyText) {
    return async (ev) => {
      if (ev && ev.preventDefault) ev.preventDefault();
      if (busy) return;
      busy = true;
      const label = btn.textContent;
      btn.disabled = true;
      btn.textContent = busyText || 'Saving...';
      try {
        await fn(ev);
      } finally {
        busy = false;
        if (btn.isConnected) {
          btn.disabled = false;
          btn.textContent = label;
        }
      }
    };
  }
  /* A button whose click is guarded. */
  function actionBtn(cls, label, fn, busyText) {
    const b = h('button', { class: cls, type: 'button' }, label);
    b.addEventListener('click', guarded(b, fn, busyText));
    return b;
  }

  /* ---------- sheets ---------- */

  function openSheet(title, build, onClose) {
    const heading = h('h2', { tabindex: '-1' }, title);
    const inner = h('div', { class: 'sheet-in' }, heading);
    const dlg = h('dialog', { class: 'sheet', 'aria-label': title }, inner);
    const close = () => {
      const i = sheets.indexOf(dlg);
      if (i < 0) return;
      sheets.splice(i, 1);
      if (dlg.open) dlg.close();
      dlg.remove();
      if (onClose) onClose();
      if (S.dirty) softRender();
    };
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      if (!busy) close();
    });
    dlg.__close = close;
    add(inner, [build(close, inner)]);
    document.body.append(dlg);
    sheets.push(dlg);
    dlg.showModal();
    heading.focus(); /* so a phone keyboard does not jump up on open */
    return close;
  }
  function closeAllSheets() {
    [...sheets].forEach((d) => d.__close());
  }
  function errBox() {
    const box = h('div', { class: 'error hidden', role: 'alert' });
    box.show = (msg) => {
      box.textContent = msg;
      box.classList.remove('hidden');
      box.scrollIntoView({ block: 'nearest' });
    };
    box.hide = () => box.classList.add('hidden');
    return box;
  }

  function field(label, control, hint, cls) {
    return h('label', { class: 'field ' + (cls || '') }, h('span', null, label), control, hint ? h('small', null, hint) : null);
  }
  const textInput = (value, extra) => h('input', { type: 'text', value: value === null || value === undefined ? '' : String(value), autocomplete: 'off', ...extra });
  const moneyInput = (value) => textInput(value === null || value === undefined ? '' : value, { inputmode: 'decimal', placeholder: '$' });
  function listInput(value, options, extra) {
    const id = 'dl' + Math.random().toString(36).slice(2);
    const input = textInput(value, { list: id, ...extra });
    const dl = h('datalist', { id }, options.map((o) => h('option', { value: o })));
    const wrap = h('div', null, input, dl);
    wrap.input = input;
    return wrap;
  }
  /* Big one-of-many buttons. */
  function choices(options, value, onChange) {
    const wrap = h('div', { class: 'choices', role: 'group' });
    wrap.value = value || '';
    const paint = () => [...wrap.children].forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.val === wrap.value)));
    for (const o of options) {
      const val = typeof o === 'string' ? o : o.value;
      const label = typeof o === 'string' ? o : o.label;
      const b = h('button', { class: 'choice', type: 'button', 'aria-pressed': 'false' }, label);
      b.dataset.val = val;
      b.addEventListener('click', () => {
        wrap.value = val;
        paint();
        if (onChange) onChange(val);
      });
      wrap.append(b);
    }
    paint();
    return wrap;
  }
  /* Tap-to-tick list of blades, for picking stock. */
  function pickList(blades, picked) {
    return h('div', { class: 'pick' }, blades.map((b) => {
      const row = h('button', { class: 'pick-row' + (picked.has(b.id) ? ' selected' : ''), type: 'button', 'aria-pressed': String(picked.has(b.id)) },
        h('span', { class: 'box' }),
        h('span', { class: 'row-text' },
          h('span', { class: 'row-title' }, h('span', { class: 'row-name' }, bladeName(b)), typePill(b.type), condPill(b)),
          h('span', { class: 'row-sub' }, `At ${stageLabel(b.stage)}`)));
      row.addEventListener('click', () => {
        if (picked.has(b.id)) picked.delete(b.id); else picked.add(b.id);
        row.classList.toggle('selected', picked.has(b.id));
        row.setAttribute('aria-pressed', String(picked.has(b.id)));
      });
      return row;
    }));
  }
  const availableStock = (type, condition) => S.state.blades.filter((b) =>
    isStock(b) && !isFinished(b) && b.stage !== 'deliver' && (!type || b.type === type) && (!condition || conditionOf(b) === condition))
    .sort((a, c) => serialNum(a.serial) - serialNum(c.serial));

  /* ---------- who is doing this ---------- */

  function namesSeen() {
    const seen = new Set();
    for (const b of S.state ? S.state.blades : []) {
      for (const ev of b.history || []) if (ev.by && ev.by !== 'Import') seen.add(ev.by);
    }
    if (S.state) for (const o of S.state.orders) if (o.createdBy && o.createdBy !== 'Import') seen.add(o.createdBy);
    return [...seen].sort((a, c) => a.localeCompare(c));
  }
  function setName(name) {
    S.name = name;
    local.set('blade.name', name);
    renderChrome();
    if (!ui.formLock && !sheets.length) renderView();
  }
  function nameForm(onDone, extra) {
    const input = textInput('', { placeholder: 'Type your name', autocapitalize: 'words', 'aria-label': 'Your name' });
    const err = errBox();
    const save = (name) => {
      const n = String(name).trim();
      if (!n) return err.show('Type your name or tap one above.');
      setName(n);
      onDone(n);
    };
    const seen = namesSeen();
    const form = h('form', { class: 'stack', onsubmit: (e) => { e.preventDefault(); save(input.value); } },
      seen.length ? h('div', { class: 'choices' }, seen.map((n) => h('button', { class: 'choice', type: 'button', onclick: () => save(n) }, n))) : null,
      input,
      err,
      h('button', { class: 'btn main wide', type: 'submit' }, 'Save name'),
      extra || null);
    return form;
  }
  /* Resolves with a name, asking once if there is none. Null means they backed out. */
  function needName() {
    if (S.name) return Promise.resolve(S.name);
    return new Promise((resolve) => {
      openSheet('Who is working?', (done) => nameForm((n) => {
        resolve(n);
        done();
      }, h('button', { class: 'btn wide', type: 'button', onclick: () => done() }, 'Not now')), () => resolve(null));
    });
  }
  function openAccount() {
    openSheet(S.name ? `Working as ${S.name}` : 'Who is working?', (done) => h('div', { class: 'stack' },
      h('p', { class: 'muted' }, isOffice() ? 'Signed in as Office.' : 'Signed in as Shop floor.'),
      h('h3', null, 'Change name'),
      nameForm(() => done()),
      h('button', { class: 'btn wide', type: 'button', onclick: () => { done(); signOut(); } }, 'Sign out'),
      h('button', { class: 'btn wide', type: 'button', onclick: () => done() }, 'Cancel')));
  }

  /* ---------- notices ---------- */

  function setNotice(n) {
    ui.notice = n;
    renderNotice();
    if (n) $('notice').scrollIntoView({ block: 'nearest' });
  }
  function renderNotice() {
    const n = ui.notice;
    if (!n) return clear($('notice'));
    clear($('notice'), h('div', { class: 'notice' + (n.bad ? ' bad' : ''), role: 'status' },
      h('div', null, h('b', null, n.title),
        n.lines && n.lines.length ? h('ul', null, n.lines.map((l) => h('li', null, l))) : null,
        n.hint ? h('p', { class: 'muted' }, n.hint) : null),
      h('button', { type: 'button', onclick: () => setNotice(null) }, 'OK')));
  }
  function go(hash, notice) {
    ui.pendingNotice = notice || null;
    if (location.hash === hash) route();
    else location.hash = hash;
  }

  /* ---------- rendering ---------- */

  const isTyping = () => {
    const a = document.activeElement;
    return !!a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
  };
  function softRender() {
    if (sheets.length || ui.formLock || isTyping()) {
      S.dirty = true;
      if (ui.formLock || isTyping()) renderChrome();
      return;
    }
    render();
  }
  document.addEventListener('focusout', () => {
    setTimeout(() => { if (S.dirty && !isTyping()) softRender(); }, 300);
  });

  function render() {
    S.dirty = false;
    S.lastRender = Date.now();
    renderChrome();
    renderBanner();
    renderNotice();
    const y = window.scrollY;
    renderView();
    if (y) window.scrollTo(0, y);
  }

  function navItems() {
    const items = [['#/board', 'Board', 'board'], ['#/orders', 'Orders', 'orders'], ['#/inventory', 'Inventory', 'inventory'], ['#/serials', 'Serials', 'serials']];
    if (isOffice()) items.push(['#/money', 'Money', 'money']);
    return items;
  }
  function renderChrome() {
    if (!S.pass || !S.state) {
      clear($('top'));
      clear($('tabs'));
      return;
    }
    const cur = activeTab();
    const links = () => navItems().map(([href, label, key]) => h('a', { href, 'aria-current': key === cur ? 'page' : null }, label));
    clear($('top'),
      h('a', { class: 'brand', href: '#/board' }, 'HELANBAK', h('small', null, 'Blades')),
      h('div', { class: 'topnav' }, links()),
      h('button', { class: 'who', type: 'button', onclick: openAccount, 'aria-label': 'Change name or sign out' },
        h('b', null, S.name || 'Who is working?'), h('span', null, S.name ? 'Change or sign out' : 'Set name')));
    clear($('tabs'), links());
  }
  function activeTab() {
    const r = ui.route[0];
    if (r === 'orders' || r === 'order') return 'orders';
    if (r === 'job') return 'board';
    if (r === 'inventory') return 'inventory';
    if (r === 'serials') return 'serials';
    if (r === 'money') return 'money';
    return 'board';
  }
  function renderBanner() {
    if (!S.offline) return clear($('banner'));
    const retry = h('button', { type: 'button' }, 'Try again');
    retry.addEventListener('click', guarded(retry, refresh, 'Trying...'));
    clear($('banner'), h('div', { class: 'banner', role: 'alert' }, h('p', null, NET_MSG), retry));
  }
  function renderView() {
    const view = $('view');
    view.className = '';
    if (!S.pass) return renderSignIn(view);
    if (!S.state) return clear(view, h('p', { class: 'pad' }, S.offline ? '' : 'Loading...'));
    const [a, b, c] = ui.route;
    if (a === 'station' && b === 'laser' && c) return renderLaserBlade(view, c);
    if (a === 'station' && b) return b === 'laser' && stepById('laser') ? renderLaserList(view) : renderStation(view, b);
    if (a === 'blade' && b) return renderBlade(view, b);
    if (a === 'orders' && b === 'new' && isOffice()) return renderNewOrder(view);
    if (a === 'orders') return renderOrders(view);
    if (a === 'order' && b) return renderOrder(view, Number(b));
    if (a === 'job' && b) return renderJob(view, Number(b));
    if (a === 'inventory') return renderInventory(view);
    if (a === 'serials') return renderSerials(view);
    if (a === 'money' && isOffice()) return renderMoney(view);
    return renderBoard(view);
  }

  function route() {
    closeAllSheets();
    ui.route = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
    ui.formLock = ui.route[0] === 'orders' && ui.route[1] === 'new' && isOffice();
    ui.notice = ui.pendingNotice;
    ui.pendingNotice = null;
    render();
    window.scrollTo(0, 0);
    const heading = $('view').querySelector('h1');
    if (heading) {
      heading.setAttribute('tabindex', '-1');
      heading.focus({ preventScroll: true });
    }
  }
  // Another tablet may have moved blades since the last timed refresh.
  window.addEventListener('hashchange', () => { route(); if (S.pass) refresh(); });

  /* ---------- pieces ---------- */

  const typePill = (t) => h('span', { class: 'pill type-' + String(t).toLowerCase() }, t);
  const condPill = (b) => (conditionOf(b) === 'NEW' ? null : h('span', { class: 'pill refurb' }, conditionOf(b)));
  const checkPill = (b) => (b.check ? h('span', { class: 'pill check' }, 'Check') : null);
  function backLink(href, label) {
    return h('a', { class: 'linklike back', href }, '< ' + label);
  }
  function fact(label, value) {
    if (value === null || value === undefined || value === '') return null;
    return h('div', null, h('dt', null, label), h('dd', null, value));
  }

  /* ---------- sign in ---------- */

  function renderSignIn(view) {
    const input = h('input', { type: 'password', class: 'passcode', autocomplete: 'current-password', 'aria-label': 'Passcode', placeholder: 'Passcode' });
    const err = errBox();
    const btn = h('button', { class: 'btn main wide', type: 'submit' }, 'Sign in');
    const submit = guarded(btn, async () => {
      err.hide();
      const code = input.value.trim();
      if (!code) return err.show('Type the passcode.');
      S.pass = code;
      S.signInError = '';
      try {
        const data = await api('state');
        delete data.__text;
        S.state = data;
        S.offline = false;
        local.set('blade.passcode', code);
        await refresh();
        route();
        if (!S.name) needName();
      } catch (e) {
        S.pass = '';
        S.state = null;
        if (e instanceof NetErr) err.show(NET_MSG);
        else if (e.status === 401) {
          /* signOut already re-rendered this screen with the message */
        } else err.show(errText(e));
      }
    }, 'Checking...');
    clear(view, h('div', { class: 'signin' },
      h('p', { class: 'brand-big' }, 'HELANBAK'),
      h('h1', null, 'Blade tracker'),
      h('form', { onsubmit: submit, novalidate: true },
        field('Passcode', input),
        S.signInError ? h('div', { class: 'error', role: 'alert' }, S.signInError) : null,
        err,
        btn)));
  }

  /* ---------- board ---------- */

  function searchAll(q) {
    const t = q.trim().toLowerCase();
    if (!t) return null;
    const m = new RegExp(`^(?:${cfg().SERIAL.prefix.toLowerCase()}|${cfg().SERIAL.refurbPrefix.toLowerCase()})?0*(\\d+)$`).exec(t);
    const bladeHits = [];
    if (m) {
      const n = m[1];
      const withSerial = S.state.blades.filter((b) => b.serial);
      const exact = withSerial.filter((b) => String(serialNum(b.serial)) === n);
      const near = withSerial.filter((b) => String(serialNum(b.serial)) !== n && String(serialNum(b.serial)).startsWith(n));
      bladeHits.push(...exact, ...near);
    } else {
      bladeHits.push(...S.state.blades.filter((b) => b.serial && b.serial.toLowerCase().includes(t)));
    }
    const orderHits = realOrders().filter((o) =>
      String(o.customer || '').toLowerCase().includes(t) ||
      String(o.po || '').toLowerCase().includes(t) ||
      (m && String(o.id) === m[1]));
    return { blades: bladeHits.slice(0, 12), orders: orderHits.slice(0, 12).sort((a, c) => c.id - a.id) };
  }
  function renderResults(box) {
    const r = searchAll(ui.search);
    if (!r) return clear(box);
    if (!r.blades.length && !r.orders.length) {
      return clear(box, h('p', { class: 'warn' }, `Nothing found for "${ui.search.trim()}".`));
    }
    clear(box, h('ul', { class: 'rows' },
      r.blades.map((b) => h('li', { class: 'row' }, h('a', { class: 'row-main', href: '#/blade/' + encodeURIComponent(b.id) },
        h('span', { class: 'row-text' },
          h('span', { class: 'row-title' }, h('span', { class: 'row-name' }, bladeName(b)), typePill(b.type), condPill(b)),
          h('span', { class: 'row-sub' }, `${customerOf(b)} · ${stageLabel(b.stage)}`))))),
      r.orders.map((o) => h('li', { class: 'row' }, h('a', { class: 'row-main', href: '#/order/' + o.id },
        h('span', { class: 'row-text' },
          h('span', { class: 'row-name' }, o.customer),
          h('span', { class: 'row-sub' }, `Order ${o.id} · ${plural(bladesOf(o).length, 'blade')}`)))))));
  }
  function renderBoard(view) {
    const results = h('div', { class: 'results' });
    const input = h('input', {
      type: 'search', value: ui.search, placeholder: 'Find a serial, order or customer', 'aria-label': 'Find a serial, order or customer',
      autocomplete: 'off', autocapitalize: 'off', enterkeyhint: 'search',
      oninput: (e) => { ui.search = e.target.value; renderResults(results); },
      onkeydown: (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const first = results.querySelector('a');
        if (first) location.hash = first.getAttribute('href');
      },
    });
    renderResults(results);
    const jobs = realOrders().map((o) => ({ o, lane: laneOf(o) })).filter((j) => j.lane);
    clear(view,
      h('div', { class: 'board-top' }, h('div', { class: 'search-box' }, input),
        h('button', { class: 'btn', type: 'button', onclick: () => addInventorySheet() }, 'Add to inventory'),
        isOffice() ? h('a', { class: 'btn main', href: '#/orders/new' }, 'New order') : null),
      results,
      h('h1', { class: 'sr' }, 'Shop board'),
      h('div', { class: 'lanes' }, cfg().STAGES.map((st) => {
        const here = jobs.filter((j) => j.lane === st.id).sort((x, y) => dueSort(x.o, y.o));
        return h('section', { class: 'lane', 'data-lane': st.id, 'aria-label': st.label },
          h('h2', { class: 'lane-head' }, h('span', null, st.label), h('span', { class: 'lane-count' }, here.length)),
          here.length ? here.map((j) => jobCard(j.o, j.lane)) : h('p', { class: 'lane-empty' }, 'Nothing here'));
      })),
      h('p', { class: 'next-line' }, h('a', { href: '#/inventory' }, `${plural(readyStock().length, 'blade')} in inventory`), ' · Next serial ', h('b', null, S.state.nextSerial), ' · Next refurb ', h('b', null, S.state.nextRefurbSerial)));
  }

  /* ---------- job cards ---------- */

  const liveBlades = (o) => bladesOf(o).filter((b) => b.stage !== cfg().SCRAPPED);
  const dueSort = (a, c) => (a.due || '9999').localeCompare(c.due || '9999') || a.id - c.id;
  /* Crated with no customer: finished and on the shelf. */
  const readyStock = () => S.state.blades.filter((b) => isStock(b) && b.stage === 'ship');
  const jobName = (o) => (o.kind === 'stock' ? 'For inventory' : o.customer);
  /* A card sits with its furthest-behind blade, so a job can't look further along than it is. */
  function laneOf(o) {
    if (o.cancelled) return null;
    const open = liveBlades(o).filter((b) => b.stage !== cfg().DONE);
    if (!open.length) return null;
    if (o.hold) return 'hold';
    if (o.kind === 'stock' && open.every((b) => b.stage === 'ship')) return null;
    const order = steps().map((s) => s.id);
    const first = open.map((b) => order.indexOf(b.stage)).sort((x, y) => x - y)[0];
    return steps()[first].stage;
  }
  /* The steps this job goes through, each with how many blades have passed it. Inventory stops at Crate. */
  function jobSteps(o) {
    const blades = liveBlades(o);
    const stopAtCrate = o.kind === 'stock';
    return steps().filter((s) => !(stopAtCrate && (s.id === 'ship' || s.id === 'deliver')) && blades.some((b) => routeOf(b).some((r) => r.id === s.id))).map((s) => {
      const on = blades.filter((b) => routeOf(b).some((r) => r.id === s.id));
      const passed = on.filter((b) => {
        if (b.stage === cfg().DONE) return true;
        const route = routeOf(b).map((r) => r.id);
        return route.indexOf(b.stage) > route.indexOf(s.id);
      });
      const waiting = on.filter((b) => b.stage === s.id);
      const events = on.flatMap((b) => (b.history || []).filter((e) => e.step === s.id));
      return { step: s, total: on.length, done: passed.length, waiting, last: events.sort((x, y) => String(y.at).localeCompare(String(x.at)))[0] };
    });
  }
  function serialRange(o) {
    const nums = liveBlades(o).map((b) => b.serial).filter(Boolean).sort();
    if (!nums.length) return 'No serials';
    const runs = [];
    for (const n of nums) {
      const run = runs[runs.length - 1];
      if (run && n.slice(0, 2) === run[1].slice(0, 2) && serialNum(n) === serialNum(run[1]) + 1) run[1] = n;
      else runs.push([n, n]);
    }
    return runs.map(([x, y]) => (x === y ? x : `${x} to ${y}`)).join(', ');
  }
  function dueChip(o) {
    if (!o.due) return null;
    const days = Math.ceil((new Date(o.due + 'T23:59:59') - Date.now()) / 86400000);
    const late = days < 0;
    return h('span', { class: 'due' + (late ? ' late' : days <= 2 ? ' soon' : '') }, late ? `${-days}d late` : days === 0 ? 'Due today' : `Due ${new Date(o.due + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`);
  }
  function jobLine(o) {
    const blades = liveBlades(o);
    const types = [...new Set(blades.map((b) => b.type))].join(' + ');
    const kinds = [...new Set(blades.map(conditionOf))].filter((k) => k !== 'NEW');
    return h('span', { class: 'job-line' }, plural(blades.length, 'blade'), ` · ${types} `, kinds.map((k) => h('span', { class: 'pill refurb' }, k)));
  }
  function jobCard(o, lane) {
    const next = jobSteps(o).find((r) => r.waiting.length);
    const isNow = o.hold ? o.hold.reason : next ? `${next.step.label}${next.total > 1 ? ` · ${next.done} of ${next.total} done` : ''}` : 'Waiting';
    return h('a', { class: 'job-card', 'data-lane': lane, href: '#/job/' + o.id },
      h('span', { class: 'job-top' }, h('span', { class: 'job-num' }, `Order ${o.id}`), dueChip(o)),
      h('span', { class: 'job-cust' + (o.kind === 'stock' ? ' stock' : '') }, jobName(o)),
      jobLine(o),
      h('span', { class: 'job-next' }, h('b', null, o.hold ? 'On hold' : 'Next'), ' ', isNow));
  }
  function setHold(o, start) {
    openSheet(start ? `Start order ${o.id}` : `Put order ${o.id} on hold`, (done) => {
      const err = errBox();
      const reason = h('textarea', { rows: 2 });
      return h('div', { class: 'stack' },
        start ? h('p', null, `This sends it to the floor. It was held for: ${o.hold ? o.hold.reason : ''}`) : field('Why is it on hold?', reason),
        err,
        actionBtn('btn main wide', start ? 'Start this job' : 'Put on hold', async () => {
          err.hide();
          if (!start && !reason.value.trim()) return err.show('Say why it is on hold.');
          const by = await needName();
          if (!by) return;
          try {
            await write('orders/hold', { id: o.id, by, ...(start ? { start: true } : { reason: reason.value }) });
            done();
            render();
          } catch (e) {
            if (e instanceof ApiErr && e.status === 401) return;
            err.show(errText(e));
          }
        }),
        h('button', { class: 'btn wide', type: 'button', onclick: () => { if (!busy) done(); } }, 'Cancel'));
    });
  }
  function cancelSheet(o) {
    openSheet(`Cancel order ${o.id}`, (done) => {
      const err = errBox();
      const reason = h('textarea', { rows: 2 });
      return h('div', { class: 'stack' },
        h('p', null, 'Numbers not yet on the steel go back out for the next job. A blade already lasered keeps its number and goes to inventory.'),
        field('Why is it being cancelled?', reason),
        err,
        actionBtn('btn main wide', 'Cancel this order', async () => {
          err.hide();
          if (!reason.value.trim()) return err.show('Say why.');
          const by = await needName();
          if (!by) return;
          try {
            const res = await write('orders/cancel', { id: o.id, by, reason: reason.value });
            done();
            go('#/board', { title: `Order ${o.id} cancelled.`, lines: [res.released.length ? `Back out: ${res.released.join(', ')}` : '', res.toStock.length ? `To inventory: ${res.toStock.join(', ')}` : ''].filter(Boolean) });
          } catch (e) {
            if (e instanceof ApiErr && e.status === 401) return;
            err.show(errText(e));
          }
        }),
        h('button', { class: 'btn wide', type: 'button', onclick: () => { if (!busy) done(); } }, 'Keep the order'));
    });
  }
  function addInventorySheet() {
    openSheet('Add to inventory', (done) => {
      const err = errBox();
      const qty = textInput('', { inputmode: 'numeric' });
      const type = choices(cfg().TYPES, '');
      const condition = choices(cfg().CONDITIONS, 'NEW');
      const blank = listInput('', cfg().MAKERS);
      const tips = listInput('', cfg().MAKERS);
      return h('div', { class: 'stack' },
        h('p', null, 'These go through the shop like any job, then wait in inventory until they sell. Each one gets its serial now.'),
        field('How many?', qty),
        h('div', null, h('p', null, h('b', null, 'Type')), type),
        h('div', null, h('p', null, h('b', null, 'Kind of blade')), condition),
        field('Blank maker', blank), field('Tips', tips),
        err,
        actionBtn('btn main wide', 'Add to inventory', async () => {
          err.hide();
          const q = Number(qty.value);
          if (!Number.isInteger(q) || q < 1 || q > 200) return err.show('How many blades? 1 to 200.');
          if (!type.value) return err.show(`Tap ${cfg().TYPES.join(' or ')}.`);
          const by = await needName();
          if (!by) return;
          try {
            const res = await write('inventory', { by, qty: q, type: type.value, condition: condition.value, blankMaker: blank.input.value, tipMaker: tips.input.value });
            done();
            go('#/job/' + res.order.id, { title: `${plural(q, 'blade')} started for inventory.` });
          } catch (e) {
            if (e instanceof ApiErr && e.status === 401) return;
            err.show(errText(e));
          }
        }),
        h('button', { class: 'btn wide', type: 'button', onclick: () => { if (!busy) done(); } }, 'Cancel'));
    });
  }
  function renderInventory(view) {
    const ready = readyStock().sort((a, c) => serialNum(a.serial) - serialNum(c.serial));
    const groups = {};
    for (const b of ready) (groups[`${b.type} ${conditionOf(b)}`] ||= []).push(b);
    const inWork = S.state.blades.filter((b) => isStock(b) && !isFinished(b) && b.stage !== 'ship' && b.stage !== 'deliver');
    clear(view,
      h('div', { class: 'head-row' }, h('h1', null, 'Inventory'),
        h('button', { class: 'btn main', type: 'button', onclick: () => addInventorySheet() }, 'Add to inventory')),
      h('p', { style: 'margin-bottom:12px' }, `${plural(ready.length, 'blade')} ready to sell. ${plural(inWork.length, 'blade')} still in the shop.`),
      Object.keys(groups).sort().map((g) => h('div', { class: 'section' },
        h('h2', null, `${g.replace(' NEW', '').replace(' REFURB', ' refurbished').replace(' RESALE', ' bought finished')} (${groups[g].length})`),
        h('ul', { class: 'job-blades' }, groups[g].map((b) => h('li', null, h('a', { href: '#/blade/' + encodeURIComponent(b.id) }, h('b', null, bladeName(b))), ' ', checkPill(b)))))),
      ready.length ? h('p', { class: 'muted', style: 'margin-top:12px' }, 'To sell one, start a new order and pick it from stock.') : null,
      inWork.length ? h('div', { class: 'section' }, h('h2', null, 'Still in the shop'),
        h('ul', { class: 'job-blades' }, inWork.map((b) => h('li', null, h('a', { href: '#/blade/' + encodeURIComponent(b.id) }, h('b', null, bladeName(b))), ` ${stageLabel(b.stage)}`)))) : null);
  }
  /* Tapping the lit box. One blade finishes straight away; several let you pick which. */
  function tickStep(o, row) {
    const step = row.step;
    const blades = row.waiting;
    if (step.id === 'laser') {
      if (blades.length === 1) { location.hash = '#/station/laser/' + encodeURIComponent(blades[0].id); return; }
      return openSheet('Which blade is on the laser?', (done) => h('div', { class: 'stack' },
        blades.map((b) => h('button', { class: 'btn wide', type: 'button', onclick: () => { done(); location.hash = '#/station/laser/' + encodeURIComponent(b.id); } }, bladeName(b))),
        h('button', { class: 'btn wide', type: 'button', onclick: () => done() }, 'Cancel')));
    }
    const needsMore = ['crate', 'ship', 'deliver'].includes(step.id);
    const picked = new Set(blades.map((b) => b.id));
    const chosen = () => blades.filter((b) => picked.has(b.id));
    if (needsMore && blades.length === 1) return stepSheet(step, blades);
    openSheet(step.verb, (done) => {
      const err = errBox();
      return h('div', { class: 'stack' },
        step.hint ? h('p', null, step.hint) : null,
        blades.length > 1 ? h('p', null, h('b', null, 'All of these? Tap off any you did not finish.')) : null,
        blades.length > 1 ? pickList(blades, picked) : null,
        machineField(step),
        err,
        actionBtn('btn main wide', step.verb, async () => {
          err.hide();
          if (!picked.size) return err.show('Pick at least one blade.');
          if (needsMore) { done(); return stepSheet(step, chosen()); }
          try {
            const notice = await finishStep(step, [...picked], {});
            if (!notice) return;
            done();
            render();
            setNotice(notice);
          } catch (e) {
            if (e instanceof ApiErr && e.status === 401) return;
            err.show(errText(e));
          }
        }),
        h('button', { class: 'btn wide', type: 'button', onclick: () => { if (!busy) done(); } }, 'Cancel'));
    });
  }
  function renderJob(view, id) {
    const o = realOrders().find((x) => x.id === id);
    if (!o) return clear(view, notHere('That order is not here.'));
    const rows = jobSteps(o);
    const nextStep = (rows.find((r) => r.waiting.length) || {}).step;
    const stages = cfg().STAGES.filter((st) => rows.some((r) => r.step.stage === st.id));
    const lane = laneOf(o);
    const blades = bladesOf(o).sort((a, c) => serialNum(a.serial) - serialNum(c.serial));
    clear(view,
      backLink('#/board', 'Board'),
      h('div', { class: 'head-row' },
        h('h1', null, `Order ${o.id}`),
        o.hold
          ? h('button', { class: 'btn main', type: 'button', onclick: () => setHold(o, true) }, 'Start this job')
          : lane ? h('button', { class: 'btn', type: 'button', onclick: () => setHold(o, false) }, 'Put on hold') : null),
      h('p', { class: 'job-sum' }, h('b', null, jobName(o)), ' · ', jobLine(o), ' ', dueChip(o)),
      h('p', { class: 'job-serials' }, 'Serials ', h('b', null, serialRange(o))),
      o.cancelled ? h('p', { class: 'warn', style: 'margin-bottom:12px' }, `Cancelled: ${o.cancelled.reason}`) : null,
      o.hold ? h('p', { class: 'warn', style: 'margin-bottom:12px' }, `On hold: ${o.hold.reason}`) : null,
      o.kind === 'stock' && !lane && !o.cancelled && liveBlades(o).length ? h('p', { style: 'margin-bottom:12px' }, h('b', null, 'Finished. '), 'These are in ', h('a', { class: 'big-link', href: '#/inventory' }, 'inventory'), ' until they sell.') : null,
      h('div', { class: 'job-stages' }, stages.map((st) => h('section', { class: 'job-stage' },
        h('h2', null, st.label),
        h('ul', { class: 'checks' }, rows.filter((r) => r.step.stage === st.id).map((r) => {
          const done = r.done === r.total;
          const live = !o.hold && r.waiting.length > 0;
          const isNext = live && r.step === nextStep;
          const who = r.last ? [r.last.by, r.last.machine].filter(Boolean).join(' · ') : '';
          return h('li', null, h('button', {
            class: 'tick' + (done ? ' done' : isNext ? ' next' : live ? ' live' : ''), type: 'button', disabled: !live,
            onclick: () => tickStep(o, r),
          },
          h('span', { class: 'box', 'aria-hidden': 'true' }, done ? '✓' : ''),
          h('span', { class: 'check-label' }, r.step.label),
          r.total > 1 ? h('span', { class: 'check-count' }, `${r.done}/${r.total}`) : null,
          who ? h('span', { class: 'check-who' }, who) : null));
        }))))),
      h('div', { class: 'section' },
        h('h2', null, 'Blades'),
        h('ul', { class: 'job-blades' }, blades.map((b) => h('li', null,
          h('a', { href: '#/blade/' + encodeURIComponent(b.id) }, h('b', null, bladeName(b))), ` ${stageLabel(b.stage)}`, ' ', checkPill(b))))),
      h('p', { style: 'margin-top:14px' }, h('a', { class: 'linklike', href: '#/order/' + o.id }, isOffice() ? 'Order details, price and stock' : 'Order details')),
      isOffice() && lane ? h('p', { style: 'margin-top:14px' }, h('button', { class: 'linklike', type: 'button', onclick: () => cancelSheet(o) }, 'Cancel this order')) : null);
  }

  /* ---------- station ---------- */

  function placeOf(good) {
    const stages = [...new Set(good.map((r) => r.blade && r.blade.stage))];
    if (stages.length !== 1 || !stages[0]) return 'moved';
    return stages[0] === cfg().DONE ? 'delivered' : `moved to ${stageLabel(stages[0])}`;
  }
  function reportBatch(res, step) {
    const results = res.results || [];
    const good = results.filter((r) => r.ok);
    const bad = results.filter((r) => !r.ok);
    const nameOf = (id) => {
      const b = bladeById(id);
      return b ? bladeName(b) : id;
    };
    const place = placeOf(good);
    const title = bad.length
      ? `${plural(good.length, 'blade')} ${place}. ${plural(bad.length, 'blade')} did not move:`
      : `${plural(good.length, 'blade')} ${place}.`;
    return {
      bad: bad.length > 0,
      title,
      lines: bad.map((r) => `${nameOf(r.id)}: ${friendly(r.error)}`),
      hint: bad.length ? null : 'Wrong blade? Open it and use Send back.',
    };
  }
  const machineOf = (step) => local.get('machine:' + step.id) || (step.machines || [])[0] || '';
  function machineField(step) {
    if (!step.machine) return null;
    const box = listInput(machineOf(step), step.machines || [], { autocapitalize: 'characters' });
    box.input.addEventListener('input', () => local.set('machine:' + step.id, box.input.value.trim()));
    return field('Machine number', box);
  }
  async function finishStep(step, ids, extra) {
    const by = await needName();
    if (!by) return null;
    const machine = step.machine ? machineOf(step) : '';
    const res = await write('steps/complete', { step: step.id, bladeIds: ids, by, ...(machine ? { machine } : {}), ...extra });
    ui.sel[step.id] = new Set();
    return reportBatch(res, step);
  }

  function stepSheet(step, blades) {
    const ids = blades.map((b) => b.id);
    const title = `${step.verb} (${ids.length})`;
    const names = [...new Set(blades.map(customerOf))];
    openSheet(title, (done) => {
      const err = errBox();
      const summary = h('p', null, `${plural(ids.length, 'blade')} for ${names.join(', ')}`);
      const confirmBtn = (getExtra) => actionBtn('btn main wide', title, async () => {
        err.hide();
        let extra;
        try {
          extra = getExtra();
        } catch (e) {
          return err.show(errText(e));
        }
        try {
          const notice = await finishStep(step, ids, extra);
          if (!notice) return;
          done();
          render();
          setNotice(notice);
        } catch (e) {
          if (e instanceof ApiErr && e.status === 401) return;
          err.show(errText(e));
        }
      });
      const cancel = h('button', { class: 'btn wide', type: 'button', onclick: () => { if (!busy) done(); } }, 'Cancel');

      if (step.id === 'crate') {
        const crate = textInput('', { inputmode: 'numeric' });
        return h('div', { class: 'stack' }, summary, field('Crate number (if it has one)', crate), err,
          confirmBtn(() => ({ crateNo: crate.value })), cancel);
      }
      if (step.id === 'deliver') {
        const rec = textInput('', { autocapitalize: 'words' });
        return h('div', { class: 'stack' }, summary, field('Received by (if you know)', rec), err,
          confirmBtn(() => ({ receivedBy: rec.value })), cancel);
      }
      /* ship */
      const methods = [...new Set(blades.map((b) => (orderOf(b) || {}).shipMethod).filter(Boolean))];
      const carrier = choices(cfg().CARRIERS, '', () => err.hide());
      const tracking = textInput('', { autocapitalize: 'characters' });
      const cost = isOffice() ? moneyInput('') : null;
      const each = h('small', null);
      if (cost) {
        cost.addEventListener('input', () => {
          let n = '';
          try { n = moneyIn(cost.value, 'Shipping cost'); } catch { n = ''; }
          each.textContent = n !== '' && ids.length > 1 ? `Splits to ${dollars(Math.round((n / ids.length) * 100) / 100)} a blade.` : '';
        });
      }
      return h('div', { class: 'stack' }, summary,
        names.length > 1 ? h('p', { class: 'warn' }, 'These blades go to more than one customer. Check this is one shipment.') : null,
        methods.length ? h('p', { class: 'muted' }, `The order says: ${methods.join(', ')}`) : null,
        h('div', null, h('p', null, h('b', null, 'How is it shipping?')), carrier),
        field('Tracking number (if it has one)', tracking),
        cost ? h('label', { class: 'field' }, h('span', null, 'Shipping cost, total for this shipment'), cost, each) : null,
        err,
        confirmBtn(() => {
          if (!carrier.value) throw new ApiErr('Tap how it is shipping.');
          const extra = { carrier: carrier.value, tracking: tracking.value };
          if (cost) {
            const n = moneyIn(cost.value, 'Shipping cost');
            if (n !== '') extra.shipCost = n;
          }
          return extra;
        }),
        cancel);
    });
  }

  function renderStation(view, stepId) {
    const step = stepById(stepId);
    if (!step) return clear(view, notHere('That step is not in the route.'));
    const waiting = S.state.blades.filter((b) => b.stage === stepId)
      .sort((a, c) => waitingSince(a).localeCompare(waitingSince(c)));
    const blocked = (b) => stepId === 'ship' && isStock(b);
    const free = waiting.filter((b) => !blocked(b));
    const sel = ui.sel[stepId] || (ui.sel[stepId] = new Set());
    for (const id of [...sel]) if (!free.some((b) => b.id === id)) sel.delete(id);

    const repaint = () => renderView();
    const needsSheet = ['crate', 'ship', 'deliver'].includes(stepId);
    const count = sel.size;
    const mainLabel = count ? `${step.verb} (${count})` : step.verb;

    const main = h('button', { class: 'btn main wide', type: 'button', disabled: !count }, mainLabel);
    main.addEventListener('click', guarded(main, async () => {
      const picked = free.filter((b) => sel.has(b.id));
      if (!picked.length) return;
      if (needsSheet) return stepSheet(step, picked);
      try {
        const notice = await finishStep(step, picked.map((b) => b.id), {});
        if (!notice) return;
        renderView();
        setNotice(notice);
      } catch (e) {
        if (e instanceof ApiErr && e.status === 401) return;
        if (!(e instanceof NetErr)) setNotice({ bad: true, title: errText(e) }); /* the banner already says it */
      }
    }));

    const allPicked = free.length > 0 && count === free.length;
    clear(view,
      backLink('#/board', 'Board'),
      h('div', { class: 'head-row' },
        h('h1', null, step.label),
        free.length ? h('button', {
          class: 'btn', type: 'button',
          onclick: () => {
            if (allPicked) sel.clear(); else free.forEach((b) => sel.add(b.id));
            repaint();
          },
        }, allPicked ? 'Clear all' : `Select all (${free.length})`) : null),
      waiting.length
        ? h('ul', { class: 'rows' }, waiting.map((b) => {
          const off = blocked(b);
          const picked = sel.has(b.id);
          return h('li', { class: 'row' + (picked ? ' selected' : '') + (off ? ' off' : '') },
            h('button', {
              class: 'row-main', type: 'button', disabled: off, 'aria-pressed': off ? null : String(picked),
              onclick: () => {
                if (picked) sel.delete(b.id); else sel.add(b.id);
                repaint();
              },
            },
            off ? null : h('span', { class: 'box' }),
            h('span', { class: 'row-text' },
              h('span', { class: 'row-title' }, h('span', { class: 'row-name' }, bladeName(b)), typePill(b.type), condPill(b), checkPill(b)),
              h('span', { class: 'row-sub' }, customerOf(b)),
              off ? h('span', { class: 'row-sub' }, h('b', null, 'Stock: assign to an order first')) : h('span', { class: 'row-sub' }, `Waiting ${since(waitingSince(b))}`))),
            h('a', { class: 'row-more', href: '#/blade/' + encodeURIComponent(b.id), 'aria-label': `Details for ${bladeName(b)}` }, 'Details'));
        }))
        : h('p', { class: 'pad muted' }, `Nothing waiting at ${step.label}.`));
    if (step.hint) view.querySelector('.head-row').after(h('p', { style: 'margin-bottom:12px' }, step.hint));
    if (free.length) {
      view.classList.add('has-bar');
      view.classList.toggle('has-machine', Boolean(step.machine));
      view.append(h('div', { class: 'action-bar' }, h('div', { class: 'action-bar-in' },
        machineField(step),
        h('p', null, count ? `Recorded as ${S.name || 'you'}` : 'Tap the blades you finished.'),
        main)));
    }
  }
  function notHere(msg) {
    return h('div', { class: 'stack' }, h('h1', null, msg), h('a', { class: 'btn', href: '#/board' }, 'Back to Board'));
  }

  /* ---------- laser ---------- */

  function renderLaserList(view) {
    const step = stepById('laser');
    const waiting = S.state.blades.filter((b) => b.stage === 'laser')
      .sort((a, c) => waitingSince(a).localeCompare(waitingSince(c)));
    clear(view,
      backLink('#/board', 'Board'),
      h('div', { class: 'head-row' }, h('h1', null, step.label)),
      h('p', { class: 'muted', style: 'margin-bottom:12px' }, 'One blade at a time. Tap the one on the laser.'),
      waiting.length
        ? h('ul', { class: 'rows' }, waiting.map((b) => h('li', { class: 'row' },
          h('a', { class: 'row-main', href: '#/station/laser/' + encodeURIComponent(b.id) },
            h('span', { class: 'row-text' },
              h('span', { class: 'row-title' }, h('span', { class: 'row-name' }, bladeName(b)), typePill(b.type), condPill(b), checkPill(b)),
              h('span', { class: 'row-sub' }, customerOf(b)),
              h('span', { class: 'row-sub' }, `Waiting ${since(waitingSince(b))}`))),
          h('a', { class: 'row-more', href: '#/blade/' + encodeURIComponent(b.id), 'aria-label': `Details for ${bladeName(b)}` }, 'Details'))))
        : h('p', { class: 'pad muted' }, `Nothing waiting at ${step.label}.`));
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const t = h('textarea', { readonly: true, style: 'position:fixed;top:0;left:0;opacity:0' });
      t.value = text;
      (sheets[sheets.length - 1] || document.body).append(t);
      t.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      t.remove();
      return ok;
    }
  }
  function copyBtn(label, text, cls) {
    const b = h('button', { class: cls || 'btn', type: 'button' }, label);
    b.addEventListener('click', async () => {
      const ok = await copyText(text);
      b.textContent = ok ? 'Copied' : 'Copy failed';
      setTimeout(() => { if (b.isConnected) b.textContent = label; }, 1800);
    });
    return b;
  }

  function manualSerialSheet(blade) {
    openSheet('Already lasered with a different number', (done) => {
      const err = errBox();
      const preview = h('div', { class: 'hidden' });
      const input = textInput('', { inputmode: 'text', autocapitalize: 'characters', placeholder: 'Like ' + nextFor(blade) });
      const nextN = serialNum(nextFor(blade));
      input.addEventListener('input', () => {
        const s = normalizeSerial(input.value, seriesOf(blade));
        if (!s) return preview.classList.add('hidden');
        preview.classList.remove('hidden');
        const taken = S.state.serials.find((x) => x.serial === s && x.status !== 'open');
        clear(preview,
          h('p', { class: 'preview' }, s),
          taken ? h('p', { class: 'warn' }, `${s} is already in the register, so it cannot be used again.`)
            : serialNum(s) > nextN ? h('p', { class: 'warn' }, `That is past the next number, ${nextFor(blade)}. The numbers in between get skipped for good. Check it against the blade.`) : null);
      });
      return h('div', { class: 'stack' },
        h('p', null, 'Type the number that is on the steel for this blade.'),
        field('Serial on the blade', input),
        preview,
        err,
        actionBtn('btn main wide', 'Save this number', async () => {
          err.hide();
          const serial = normalizeSerial(input.value, seriesOf(blade));
          if (!serial) return err.show(`Serials look like ${nextFor(blade)}.`);
          const by = await needName();
          if (!by) return;
          try {
            const res = await write('laser/reserve', { bladeId: blade.id, by, serial });
            ui.laserText[blade.id] = res.laserText;
            done();
            render();
          } catch (e) {
            if (e instanceof ApiErr && e.status === 401) return;
            err.show(errText(e));
          }
        }),
        h('button', { class: 'btn wide', type: 'button', onclick: () => { if (!busy) done(); } }, 'Cancel'));
    });
  }

  function renderLaserBlade(view, id) {
    const blade = bladeById(id);
    const back = blade && blade.orderId ? backLink('#/job/' + blade.orderId, `Order ${blade.orderId}`) : backLink('#/station/laser', stageLabel('laser'));
    if (!blade) return clear(view, back, notHere('That blade is not here.'));
    if (blade.stage !== 'laser') {
      return clear(view, back, h('div', { class: 'stack' },
        h('h1', null, bladeName(blade)),
        h('p', { class: 'warn' }, `This blade is not at the laser any more. It is at ${stageLabel(blade.stage)}.`),
        h('a', { class: 'btn', href: '#/station/laser' }, 'Back to the laser list')));
    }
    const step = stepById('laser');
    const err = errBox();
    const about = h('p', { style: 'margin:8px 0 14px' }, typePill(blade.type), ' ', customerOf(blade), ' ', checkPill(blade));
    const checkNote = blade.check ? h('p', { class: 'warn', style: 'margin-bottom:14px' }, blade.check) : null;
    const otherLink = h('button', { class: 'linklike', type: 'button', onclick: () => manualSerialSheet(blade) }, 'Already lasered with a different number');

    if (!blade.serial) {
      clear(view, back,
        h('h1', null, bladeName(blade)), about, checkNote,
        h('p', { class: 'muted', style: 'margin-bottom:8px' }, `Next number is ${nextFor(blade)}.`),
        err,
        actionBtn('btn main wide', 'Get serial', async () => {
          err.hide();
          const by = await needName();
          if (!by) return;
          try {
            const res = await write('laser/reserve', { bladeId: blade.id, by });
            ui.laserText[blade.id] = res.laserText;
            render();
          } catch (e) {
            if (e instanceof ApiErr && e.status === 401) return;
            err.show(errText(e));
          }
        }, 'Getting number...'),
        otherLink);
      return;
    }

    const lines = laserLines(blade.id, blade.serial);
    const reg = S.state.serials.find((s) => s.serial === blade.serial);
    clear(view, back,
      h('h1', { class: 'serial-huge' }, blade.serial), about, checkNote,
      reg && reg.status === 'lasered' ? h('p', { class: 'warn', style: 'margin-bottom:14px' }, 'This number is already on this blade. It came back here to be marked again.') : null,
      h('p', { class: 'laser-note', style: 'margin-bottom:8px' }, 'Enter this in the Trotec Ruby software on the laser laptop.'),
      h('ul', { class: 'laser-lines' }, lines.map((line) => h('li', { class: 'laser-line' }, h('code', null, line), copyBtn('Copy', line)))),
      h('div', { class: 'laser-actions' },
      h('div', { class: 'laser-copy' }, copyBtn('Copy all', lines.join('\n'), 'btn wide')),
      machineField(step),
      err,
      actionBtn('btn main wide', step.verb, async () => {
        err.hide();
        try {
          const serial = blade.serial;
          const notice = await finishStep(step, [blade.id], { serial });
          if (!notice) return;
          if (!notice.bad) notice.title = `${serial} ${step.verb.toLowerCase()}. ${notice.title.replace(/^1 blade /, 'Blade ')}`;
          go(blade.orderId ? '#/job/' + blade.orderId : '#/station/laser', notice);
        } catch (e) {
          if (e instanceof ApiErr && e.status === 401) return;
          err.show(errText(e));
        }
      })),
      otherLink);
  }

  /* ---------- blade page ---------- */

  function eventTitle(ev) {
    const s = stepById(ev.step);
    if (s) return s.verb;
    return { order: 'Order started', import: 'Imported', serial: 'Serial', assign: 'Order changed', cancel: 'Order cancelled', edit: 'Edited', rework: 'Sent back', scrap: 'Scrapped' }[ev.step] || ev.step;
  }
  function eventNote(ev) {
    return String(ev.note || '').replace(/^Back to ([\w-]+):/, (_, id) => `Back to ${stageLabel(id)}:`);
  }
  function tracker(b) {
    const route = routeOf(b);
    const idx = route.findIndex((s) => s.id === b.stage);
    const delivered = b.stage === cfg().DONE;
    return h('ol', { class: 'tracker' }, route.map((s, i) => {
      const state = delivered || (idx >= 0 && i < idx) ? 'done' : i === idx ? 'here' : '';
      return h('li', { class: state, 'aria-current': state === 'here' ? 'step' : null },
        h('span', { class: 'dot' }, i + 1),
        h('span', null, s.label, state === 'here' ? ' (here now)' : ''));
    }));
  }
  function sendBackSheet(b) {
    const route = routeOf(b);
    const idx = route.findIndex((s) => s.id === b.stage);
    const earlier = b.stage === cfg().DONE ? route : route.slice(0, Math.max(idx, 0));
    openSheet(`Send back ${bladeName(b)}`, (done) => {
      const err = errBox();
      const to = choices(earlier.map((s) => ({ value: s.id, label: s.label })));
      const reason = h('textarea', { rows: 2 });
      return h('div', { class: 'stack' },
        h('div', null, h('p', null, h('b', null, 'Back to which step?')), to),
        field('Why is it going back?', reason),
        err,
        actionBtn('btn main wide', 'Send back', async () => {
          err.hide();
          if (!to.value) return err.show('Tap the step it goes back to.');
          if (!reason.value.trim()) return err.show('Say why it is going back.');
          const by = await needName();
          if (!by) return;
          try {
            await write('blades/back', { bladeId: b.id, toStep: to.value, reason: reason.value, by });
            done();
            render();
            setNotice({ title: `${bladeName(b)} sent back to ${stageLabel(to.value)}.` });
          } catch (e) {
            if (e instanceof ApiErr && e.status === 401) return;
            err.show(errText(e));
          }
        }),
        h('button', { class: 'btn wide', type: 'button', onclick: () => { if (!busy) done(); } }, 'Cancel'));
    });
  }
  function scrapSheet(b) {
    openSheet(`Scrap ${bladeName(b)}`, (done) => {
      const err = errBox();
      const reason = h('textarea', { rows: 2 });
      const confirmBox = h('div', { class: 'stack hidden' });
      const first = h('div', { class: 'stack' },
        field('Why is it scrapped?', reason),
        err,
        h('button', {
          class: 'btn danger wide', type: 'button',
          onclick: () => {
            err.hide();
            if (!reason.value.trim()) return err.show('Say why it is scrapped.');
            first.classList.add('hidden');
            confirmBox.classList.remove('hidden');
          },
        }, 'Scrap this blade'),
        h('button', { class: 'btn wide', type: 'button', onclick: () => done() }, 'Cancel'));
      const err2 = errBox();
      add(confirmBox, [
        h('p', { class: 'warn' }, b.serial
          ? `Scrap ${b.serial}? This cannot be undone. If the number is on the steel it is retired for good. If not, it goes to the next job.`
          : `Scrap ${bladeName(b)}? This cannot be undone.`),
        err2,
        actionBtn('btn danger wide', 'Yes, scrap it', async () => {
          err2.hide();
          const by = await needName();
          if (!by) return;
          try {
            await write('blades/scrap', { bladeId: b.id, reason: reason.value, by });
            done();
            render();
            setNotice({ title: `${bladeName(b)} scrapped.` });
          } catch (e) {
            if (e instanceof ApiErr && e.status === 401) return;
            err2.show(errText(e));
          }
        }),
        h('button', { class: 'btn wide', type: 'button', onclick: () => { if (!busy) done(); } }, 'No, keep it'),
      ]);
      return h('div', null, first, confirmBox);
    });
  }
  function editBladeSheet(b) {
    openSheet(`Edit ${bladeName(b)}`, (done) => {
      const err = errBox();
      const type = choices(cfg().TYPES, b.type);
      const condition = choices(cfg().CONDITIONS, conditionOf(b));
      const blank = listInput(b.blankMaker, cfg().MAKERS);
      const tips = listInput(b.tipMaker, cfg().MAKERS);
      const core = textInput(b.core);
      const price = moneyInput(b.price);
      const cost = moneyInput(b.ourCost);
      const ship = moneyInput(b.shipCost);
      const sold = h('input', { type: 'date', value: b.soldDate || '' });
      return h('div', { class: 'stack' },
        h('div', null, h('p', null, h('b', null, 'Type')), type),
        h('div', null, h('p', null, h('b', null, 'Kind of blade')), condition),
        field('Blank maker', blank), field('Tips', tips), field('Core', core),
        field('Price', price), field('Our cost', cost), field('Shipping cost', ship), field('Date sold', sold),
        err,
        actionBtn('btn main wide', 'Save', async () => {
          err.hide();
          const by = await needName();
          if (!by) return;
          try {
            const fields = {
              type: type.value, condition: condition.value,
              blankMaker: blank.input.value, tipMaker: tips.input.value, core: core.value,
              price: moneyIn(price.value, 'Price'), ourCost: moneyIn(cost.value, 'Our cost'), shipCost: moneyIn(ship.value, 'Shipping cost'),
              soldDate: sold.value,
            };
            // Send only what this sheet changed, so it cannot undo a save from another tablet.
            const body = { by, bladeId: b.id };
            for (const [k, v] of Object.entries(fields)) if ((v ?? '') !== ((k === 'condition' ? conditionOf(b) : b[k]) ?? '')) body[k] = v;
            await write('blades/update', body);
            done();
            render();
            setNotice({ title: `${bladeName(b)} saved.` });
          } catch (e) {
            if (e instanceof ApiErr && e.status === 401) return;
            err.show(errText(e));
          }
        }),
        h('button', { class: 'btn wide', type: 'button', onclick: () => { if (!busy) done(); } }, 'Cancel'));
    });
  }
  function correctSerialSheet(b) {
    openSheet(`Correct serial on ${bladeName(b)}`, (done) => {
      const err = errBox();
      const input = textInput('');
      const reason = h('textarea', { rows: 2 });
      return h('div', { class: 'stack' },
        h('p', null, 'For when the steel and the record disagree. Read the number off the blade. If another blade holds that number, it loses it and gets a Check marker.'),
        field('Number on the steel', input),
        field('What happened?', reason),
        err,
        actionBtn('btn main wide', 'Correct serial', async () => {
          err.hide();
          const serial = normalizeSerial(input.value, seriesOf(b));
          if (!serial) return err.show(`Serials look like ${nextFor(b)}.`);
          if (!reason.value.trim()) return err.show('Say what happened.');
          const by = await needName();
          if (!by) return;
          try {
            await write('serials/correct', { bladeId: b.id, serial, reason: reason.value, by });
            done();
            go('#/blade/' + encodeURIComponent(b.id), { title: `Serial corrected to ${serial}.` });
          } catch (e) {
            if (e instanceof ApiErr && e.status === 401) return;
            err.show(errText(e));
          }
        }),
        h('button', { class: 'btn wide', type: 'button', onclick: () => { if (!busy) done(); } }, 'Cancel'));
    });
  }
  function backToStockBtn(b) {
    return actionBtn('btn wide', 'Back to stock', async () => {
      const by = await needName();
      if (!by) return;
      try {
        await write('blades/unassign', { bladeId: b.id, by });
        renderView();
        setNotice({ title: `${bladeName(b)} is back in stock.` });
      } catch (e) {
        if (e instanceof ApiErr && e.status === 401) return;
        if (!(e instanceof NetErr)) setNotice({ bad: true, title: errText(e) });
      }
    });
  }
  function clearCheck(b) {
    return actionBtn('btn', 'Clear check', async () => {
      const by = await needName();
      if (!by) return;
      try {
        await write('blades/update', { by, bladeId: b.id, clearCheck: true });
        renderView();
        setNotice({ title: `Check cleared on ${bladeName(b)}.` });
      } catch (e) {
        if (e instanceof ApiErr && e.status === 401) return;
        if (!(e instanceof NetErr)) setNotice({ bad: true, title: errText(e) });
      }
    }, 'Clearing...');
  }

  function renderBlade(view, id) {
    const b = bladeById(id);
    if (!b) return clear(view, notHere('That blade is not here.'));
    const o = orderOf(b);
    const scrapped = b.stage === cfg().SCRAPPED;
    const delivered = b.stage === cfg().DONE;
    const idx = routeOf(b).findIndex((s) => s.id === b.stage);
    const canBack = !scrapped && (delivered || idx > 0);
    const atStep = idx >= 0;
    const hist = [...(b.history || [])].reverse();
    clear(view,
      h('button', { class: 'linklike back', type: 'button', onclick: () => { if (history.length > 1) history.back(); else location.hash = '#/board'; } }, '< Back'),
      h('div', { class: 'head-row' }, h('h1', null, bladeName(b)), typePill(b.type), condPill(b)),
      b.check ? h('div', { class: 'warn', style: 'margin-bottom:14px' },
        h('p', null, h('b', null, 'Check: '), b.check),
        isOffice() ? h('div', { style: 'margin-top:10px' }, clearCheck(b)) : null) : null,
      scrapped ? h('p', { class: 'error', style: 'margin-bottom:14px' }, 'This blade was scrapped.') : null,

      h('div', { class: 'section', style: 'margin-top:0' },
        h('h2', null, delivered ? 'Delivered' : scrapped ? 'Route' : `At ${stageLabel(b.stage)}`),
        tracker(b),
        atStep ? h('a', { class: 'btn wide', style: 'margin-top:12px', href: '#/station/' + encodeURIComponent(b.stage) }, `Go to ${stageLabel(b.stage)}`) : null),

      h('div', { class: 'section' },
        h('h2', null, 'Details'),
        h('dl', { class: 'facts' },
          fact('Serial', b.serial || 'Not yet'),
          fact('Type', b.type),
          fact('Blank maker', b.blankMaker || 'Not recorded'),
          fact('Tips', b.tipMaker || 'Not recorded'),
          fact('Core', b.core || 'Not recorded'),
          fact('Customer', customerOf(b)),
          fact('Order', o ? h('a', { class: 'big-link', href: o.kind === 'stock' ? '#/job/' + o.id : '#/order/' + o.id }, `Order ${o.id}`) : 'None'),
          fact('Crate', b.crateNo),
          fact('Shipping', b.carrier),
          fact('Tracking', b.tracking),
          fact('Received by', b.receivedBy),
          fact('Date sold', dayText(b.soldDate)))),

      isOffice() ? h('div', { class: 'section' },
        h('h2', null, 'Money'),
        h('dl', { class: 'facts' },
          fact('Price', dollars(b.price) || 'Not set'),
          fact('Our cost', dollars(b.ourCost) || 'Not set'),
          fact('Shipping cost', dollars(b.shipCost) || 'None'),
          fact('Margin', b.margin === null || b.margin === undefined ? 'Needs price and cost' : h('span', { class: b.margin < 0 ? 'neg' : null }, dollars(b.margin)))),
        h('button', { class: 'btn wide', style: 'margin-top:12px', type: 'button', onclick: () => editBladeSheet(b) }, 'Edit this blade'),
        h('button', { class: 'btn wide', style: 'margin-top:12px', type: 'button', onclick: () => correctSerialSheet(b) }, 'Correct the serial'),
        !isStock(b) && ['deliver', cfg().DONE, cfg().SCRAPPED].indexOf(b.stage) < 0 ? h('div', { style: 'margin-top:12px' }, backToStockBtn(b)) : null) : null,

      h('div', { class: 'section' },
        h('h2', null, 'History'),
        hist.length ? h('ol', { class: 'history' }, hist.map((ev) => h('li', null,
          h('b', null, eventTitle(ev)),
          h('span', { class: 'meta' }, [ev.step === 'import' ? dayText(ev.at) : whenText(ev.at), ev.by].filter(Boolean).join(' · ')),
          ev.note ? h('span', { class: 'meta' }, eventNote(ev)) : null,
          ev.machine ? h('span', { class: 'meta' }, `Machine ${ev.machine}`) : null,
          ev.crateNo ? h('span', { class: 'meta' }, `Crate ${ev.crateNo}`) : null,
          ev.carrier ? h('span', { class: 'meta' }, `By ${ev.carrier}`) : null,
          ev.tracking ? h('span', { class: 'meta' }, `Tracking ${ev.tracking}`) : null,
          ev.receivedBy ? h('span', { class: 'meta' }, `Received by ${ev.receivedBy}`) : null))) : h('p', { class: 'muted' }, 'Nothing recorded yet.')),

      !scrapped ? h('div', { class: 'section' },
        h('h2', null, 'Something wrong?'),
        h('div', { class: 'btn-row' },
          canBack ? h('button', { class: 'btn', type: 'button', onclick: () => sendBackSheet(b) }, 'Send back') : null,
          h('button', { class: 'btn', type: 'button', onclick: () => scrapSheet(b) }, 'Scrap'))) : null);
  }

  /* ---------- orders ---------- */

  const bladesOf = (o) => S.state.blades.filter((b) => b.orderId === o.id);
  const orderDone = (o) => bladesOf(o).every(isFinished);
  function whereSummary(blades) {
    const parts = [];
    for (const s of steps()) {
      const n = blades.filter((b) => b.stage === s.id).length;
      if (n) parts.push(`${n} at ${s.label}`);
    }
    const d = blades.filter((b) => b.stage === cfg().DONE).length;
    const x = blades.filter((b) => b.stage === cfg().SCRAPPED).length;
    if (d) parts.push(`${d} delivered`);
    if (x) parts.push(`${x} scrapped`);
    return parts.join(', ') || 'No blades left on this order';
  }
  function strip(blades) {
    const cells = steps().map((s) => {
      const n = blades.filter((b) => b.stage === s.id).length;
      return h('i', { class: n ? 'on' : null, title: s.label }, n || '');
    });
    const d = blades.filter((b) => b.stage === cfg().DONE).length;
    cells.push(h('i', { class: d ? 'fin' : null, title: 'Delivered' }, d || ''));
    return h('div', { class: 'strip', 'aria-hidden': 'true' }, cells);
  }
  function renderOrders(view) {
    const all = realOrders().sort((a, c) => c.id - a.id);
    const open = all.filter((o) => !orderDone(o));
    const done = all.filter(orderDone);
    const list = ui.orderFilter === 'open' ? open : done;
    const today = todayYmd();
    clear(view,
      h('div', { class: 'head-row' },
        h('h1', null, 'Orders'),
        isOffice() ? h('a', { class: 'btn', href: '#/orders/new' }, 'New order') : null),
      h('div', { style: 'margin-bottom:14px' }, choices(
        [{ value: 'open', label: `Open (${open.length})` }, { value: 'done', label: `Finished (${done.length})` }],
        ui.orderFilter,
        (v) => { ui.orderFilter = v; renderView(); })),
      list.length
        ? h('ul', { class: 'rows' }, list.map((o) => {
          const blades = bladesOf(o);
          const late = o.due && o.due < today && !orderDone(o);
          return h('li', { class: 'row' }, h('a', { class: 'row-main', href: '#/order/' + o.id },
            h('span', { class: 'row-text' },
              h('span', { class: 'row-name' }, o.kind === 'stock' ? 'Stock' : o.customer),
              h('span', { class: 'row-sub' }, `Order ${o.id} · ${plural(blades.length, 'blade')}`,
                o.due ? ' · ' : '', o.due ? h('span', { class: late ? 'tag-late' : null }, `${late ? 'Late, due' : 'Due'} ${dayText(o.due)}`) : null),
              strip(blades),
              h('span', { class: 'row-sub', style: 'margin-top:4px;color:var(--ink-soft)' }, whereSummary(blades)))));
        }))
        : h('p', { class: 'pad muted' }, ui.orderFilter === 'open' ? 'No open orders.' : 'No finished orders yet.'));
  }

  function renderOrder(view, id) {
    const o = realOrders().find((x) => x.id === id);
    if (!o) return clear(view, notHere('That order is not here.'));
    const blades = bladesOf(o).sort((a, c) => serialNum(a.serial) - serialNum(c.serial));
    const office = isOffice();
    const live = blades.filter((b) => b.stage !== cfg().SCRAPPED);
    const totalPrice = office ? live.reduce((t, b) => t + (b.price || 0), 0) : 0;
    const totalMargin = office ? live.reduce((t, b) => t + (b.margin || 0), 0) : 0;
    const stockLeft = office && o.kind === 'customer' && !o.cancelled ? availableStock() : [];
    clear(view,
      backLink('#/orders', 'Orders'),
      o.cancelled ? h('p', { class: 'warn', style: 'margin:8px 0' }, `Cancelled: ${o.cancelled.reason}`) : null,
      h('div', { class: 'head-row' }, h('h1', null, o.kind === 'stock' ? 'Stock build' : o.customer)),
      h('dl', { class: 'facts' },
        fact('Order', String(o.id)),
        o.kind === 'stock' ? null : fact('Customer', o.customer),
        office ? fact('Contact', o.contact) : null,
        fact('PO', o.po),
        fact('Due', dayText(o.due)),
        fact('Ship method', o.shipMethod),
        fact('Started', dayText(o.createdAt)),
        fact('Notes', o.notes),
        office ? fact('Total price', dollars(totalPrice)) : null,
        office ? fact('Total margin', dollars(totalMargin)) : null),
      office ? h('div', { class: 'btn-row', style: 'margin-top:12px' },
        h('button', { class: 'btn', type: 'button', onclick: () => editOrderSheet(o) }, 'Edit details'),
        stockLeft.length ? h('button', { class: 'btn', type: 'button', onclick: () => assignSheet(o) }, 'Add stock blades') : null) : null,
      h('div', { class: 'section' },
        h('h2', null, `Blades (${blades.length})`),
        strip(blades),
        h('p', { class: 'muted', style: 'margin:6px 0 12px' }, whereSummary(blades)),
        blades.length ? h('ul', { class: 'rows' }, blades.map((b) => h('li', { class: 'row' },
          h('a', { class: 'row-main', href: '#/blade/' + encodeURIComponent(b.id) },
            h('span', { class: 'row-text' },
              h('span', { class: 'row-title' }, h('span', { class: 'row-name' }, bladeName(b)), typePill(b.type), condPill(b), checkPill(b)),
              h('span', { class: 'row-sub' }, stageLabel(b.stage)),
              office && b.price !== null && b.price !== undefined ? h('span', { class: 'row-sub' }, dollars(b.price)) : null))))) : null));
  }

  function editOrderSheet(o) {
    openSheet(`Edit order ${o.id}`, (done) => {
      const err = errBox();
      const stock = o.kind === 'stock';
      const customer = textInput(o.customer);
      const contact = textInput(o.contact);
      const po = textInput(o.po);
      const due = h('input', { type: 'date', value: o.due || '' });
      const ship = listInput(o.shipMethod, cfg().CARRIERS);
      const notes = h('textarea', { rows: 3 });
      notes.value = o.notes || '';
      return h('div', { class: 'stack' },
        stock ? null : field('Customer', customer),
        field('Contact', contact), field('PO', po), field('Due date', due), field('Ship method', ship), field('Notes', notes),
        err,
        actionBtn('btn main wide', 'Save', async () => {
          err.hide();
          if (!stock && !customer.value.trim()) return err.show('Customer name is required.');
          const by = await needName();
          if (!by) return;
          const body = { by, id: o.id, contact: contact.value, po: po.value, due: due.value, shipMethod: ship.input.value, notes: notes.value };
          if (!stock) body.customer = customer.value;
          try {
            await write('orders/update', body);
            done();
            render();
            setNotice({ title: `Order ${o.id} saved.` });
          } catch (e) {
            if (e instanceof ApiErr && e.status === 401) return;
            err.show(errText(e));
          }
        }),
        h('button', { class: 'btn wide', type: 'button', onclick: () => { if (!busy) done(); } }, 'Cancel'));
    });
  }
  function assignSheet(o) {
    openSheet(`Add stock blades to order ${o.id}`, (done) => {
      const err = errBox();
      const picked = new Set();
      const price = moneyInput('');
      return h('div', { class: 'stack' },
        pickList(availableStock(), picked),
        field('Price each', price, 'Leave empty to keep the price each blade already has.'),
        err,
        actionBtn('btn main wide', 'Add to this order', async () => {
          err.hide();
          if (!picked.size) return err.show('Tap at least one blade.');
          const by = await needName();
          if (!by) return;
          try {
            const p = moneyIn(price.value, 'Price each');
            const res = await write('blades/assign', { orderId: o.id, bladeIds: [...picked], by, price: p });
            done();
            render();
            const bad = res.results.filter((r) => !r.ok);
            const good = res.results.length - bad.length;
            setNotice({
              bad: bad.length > 0,
              title: bad.length ? `${plural(good, 'blade')} added. ${plural(bad.length, 'blade')} did not move:` : `${plural(good, 'blade')} added.`,
              lines: bad.map((r) => { const b = bladeById(r.id); return `${b ? bladeName(b) : r.id}: ${friendly(r.error)}`; }),
            });
          } catch (e) {
            if (e instanceof ApiErr && e.status === 401) return;
            err.show(errText(e));
          }
        }),
        h('button', { class: 'btn wide', type: 'button', onclick: () => { if (!busy) done(); } }, 'Cancel'));
    });
  }

  function renderNewOrder(view) {
    const err = errBox();
    const customers = [...new Set(realOrders().filter((o) => o.kind === 'customer').map((o) => o.customer))].sort();
    const customer = listInput('', customers, { autocapitalize: 'words' });
    const contact = textInput('');
    const po = textInput('');
    const due = h('input', { type: 'date' });
    const qty = textInput('', { inputmode: 'numeric' });
    const picked = new Set();
    const stockBox = h('div', { class: 'span2' });
    const paintStock = () => {
      picked.clear();
      if (kind.value === 'stock' || !type.value) return clear(stockBox);
      const list = availableStock(type.value, condition.value);
      if (!list.length) return clear(stockBox, h('p', { class: 'muted' }, `No matching ${type.value} blades in stock.`));
      clear(stockBox, h('div', { class: 'stack' },
        h('h3', null, `Use ${type.value} stock instead of building new`),
        h('p', { class: 'muted' }, 'Stock blades keep their own cost. A price below replaces their price.'),
        pickList(list, picked)));
    };
    const condition = choices(cfg().CONDITIONS, 'NEW', paintStock);
    const type = choices(cfg().TYPES, '', paintStock);
    const blank = listInput('', cfg().MAKERS);
    const tips = listInput('', cfg().MAKERS);
    const core = listInput('', ['NO', 'YES']);
    const price = moneyInput('');
    const cost = moneyInput('');
    const ship = listInput('', cfg().CARRIERS);
    const notes = h('textarea', { rows: 3 });

    const customerOnly = [
      field('Customer', customer, null, 'span2'),
      field('Contact', contact),
      field('PO', po),
    ];
    const kind = choices([{ value: 'customer', label: 'Customer order' }, { value: 'stock', label: 'New stock build' }], 'customer', () => {
      customerOnly.forEach((f) => f.classList.toggle('hidden', kind.value === 'stock'));
      title.textContent = kind.value === 'stock' ? 'New stock build' : 'New order';
      save.textContent = kind.value === 'stock' ? 'Start stock build' : 'Create order';
      paintStock();
    });
    const title = h('h1', null, 'New order');
    const save = h('button', { class: 'btn main wide', type: 'button' }, 'Create order');

    save.addEventListener('click', guarded(save, async () => {
      err.hide();
      const stock = kind.value === 'stock';
      const body = {};
      try {
        if (!stock && !customer.input.value.trim()) throw new ApiErr('Customer name is required.');
        if (!type.value) throw new ApiErr(`Tap ${cfg().TYPES.join(' or ')}.`);
        const q = qty.value.trim() === '' ? 0 : Number(qty.value);
        if (!Number.isInteger(q) || q < 0 || q > 200) throw new ApiErr('Quantity must be a whole number, 0 to 200.');
        if (q + picked.size < 1) throw new ApiErr(stock ? 'How many blades to make?' : 'How many blades to make? Or pick stock blades to use.');
        Object.assign(body, {
          kind: stock ? 'stock' : 'customer',
          qty: q, type: type.value, condition: condition.value, hold: !stock, assignSerials: true,
          blankMaker: blank.input.value, tipMaker: tips.input.value, core: core.input.value,
          price: moneyIn(price.value, 'Price each'), ourCost: moneyIn(cost.value, 'Our cost each'),
          due: due.value, shipMethod: ship.input.value, notes: notes.value,
        });
        if (!stock) Object.assign(body, { customer: customer.input.value, contact: contact.value, po: po.value, stockBladeIds: [...picked] });
      } catch (e) {
        return err.show(errText(e));
      }
      const by = await needName();
      if (!by) return;
      body.by = by;
      const stockIds = [...picked];
      try {
        const res = await write('orders', body);
        const id = res.order.id;
        const missed = (res.stockResults || []).filter((r) => !r.ok);
        ui.orderFilter = 'open';
        ui.formLock = false;
        go('#/job/' + id, missed.length
          ? { bad: true, title: `Order ${id} created. ${plural(missed.length, 'stock blade')} did not move:`, lines: missed.map((r) => r.error) }
          : { title: `Order ${id} created with ${plural(res.bladeIds.length + stockIds.length, 'blade')}.` });
      } catch (e) {
        if (e instanceof ApiErr && e.status === 401) return;
        err.show(errText(e));
      }
    }, 'Creating...'));

    clear(view,
      backLink('#/orders', 'Orders'),
      h('div', { class: 'head-row' }, title),
      h('div', { style: 'margin-bottom:16px' }, kind),
      h('div', { class: 'form-grid' },
        customerOnly,
        field('Due date', due),
        h('div', { class: 'span2' }, h('p', null, h('b', null, 'Type')), type),
        h('div', { class: 'span2' }, h('p', null, h('b', null, 'Kind of blade')), condition),
        field('Quantity to make', qty),
        field('Core', core),
        field('Blank maker', blank),
        field('Tips', tips),
        field('Price each', price, 'Usually 380 solid, 390 slotted. $50 off with a core.'),
        field('Our cost each', cost),
        field('Ship method', ship),
        stockBox,
        field('Notes', notes, null, 'span2'),
        h('div', { class: 'span2 stack' }, err, save)));
  }

  /* ---------- serials ---------- */

  const STATUS = { open: 'Free', reserved: 'Reserved', lasered: 'Lasered', void: 'Void', scrapped: 'Scrapped' };
  function serialRows(box) {
    const q = ui.serialQ.trim().toLowerCase();
    const digits = /^(?:[a-z]*)0*(\d+)$/.exec(q);
    const rows = [...S.state.serials].sort((a, c) => String(c.serial).localeCompare(String(a.serial))).map((s) => {
      const b = s.status !== 'open' && s.bladeId ? bladeById(s.bladeId) : null;
      return { s, b, customer: b ? customerOf(b) : '' };
    }).filter(({ s, customer }) => {
      if (!q) return true;
      if (digits && String(serialNum(s.serial)).startsWith(digits[1])) return true;
      return s.serial.toLowerCase().includes(q) || customer.toLowerCase().includes(q) || String(s.status).includes(q);
    });
    if (!rows.length) return clear(box, h('p', { class: 'pad muted' }, q ? `Nothing found for "${ui.serialQ.trim()}".` : 'No numbers in the register yet.'));
    clear(box, h('ul', { class: 'rows' }, rows.map(({ s, b, customer }) => {
      const free = s.status === 'open';
      const when = free ? s.releasedAt : s.laseredAt || s.reservedAt;
      const who = free ? s.releasedBy : s.voidedBy || s.laseredBy || s.reservedBy;
      return h('li', { class: 'row serial-row' },
        h('div', { class: 'row-main' },
          h('span', { class: 'row-text' },
            h('span', { class: 'row-title' }, h('span', { class: 'row-name' }, s.serial), h('span', { class: 'pill ' + s.status }, STATUS[s.status] || s.status)),
            h('span', { class: 'row-sub' }, free ? `Goes to the next job. ${s.releasedWhy || ''}` : customer || 'No blade'),
            h('span', { class: 'row-sub' }, [dayText(when), who].filter(Boolean).join(' · ')),
            s.voidReason ? h('span', { class: 'row-sub' }, `Reason: ${s.voidReason}`) : null,
            isOffice() && s.status === 'reserved' ? h('button', { class: 'btn', style: 'margin-top:8px', type: 'button', onclick: () => voidSheet(s) }, 'Void this number') : null)),
        b ? h('a', { class: 'row-more', href: '#/blade/' + encodeURIComponent(b.id), 'aria-label': `Blade for ${s.serial}` }, 'Blade') : null);
    })));
  }
  function voidSheet(s) {
    openSheet(`Void ${s.serial}`, (done) => {
      const err = errBox();
      const reason = h('textarea', { rows: 2 });
      return h('div', { class: 'stack' },
        h('p', { class: 'warn' }, 'This number stays in the register and is never used again. The blade goes back to needing a number.'),
        field('Why is it void?', reason),
        err,
        actionBtn('btn danger wide', `Void ${s.serial}`, async () => {
          err.hide();
          if (!reason.value.trim()) return err.show('Say why it is void.');
          const by = await needName();
          if (!by) return;
          try {
            await write('serials/void', { serial: s.serial, reason: reason.value, by });
            done();
            render();
            setNotice({ title: `${s.serial} voided.` });
          } catch (e) {
            if (e instanceof ApiErr && e.status === 401) return;
            err.show(errText(e));
          }
        }),
        h('button', { class: 'btn wide', type: 'button', onclick: () => { if (!busy) done(); } }, 'Cancel'));
    });
  }
  function renderSerials(view) {
    const box = h('div');
    const input = h('input', {
      type: 'search', value: ui.serialQ, placeholder: 'Find a number or customer', 'aria-label': 'Find a number or customer', autocomplete: 'off',
      oninput: (e) => { ui.serialQ = e.target.value; serialRows(box); },
    });
    serialRows(box);
    clear(view,
      h('div', { class: 'head-row' }, h('h1', null, 'Serials')),
      h('p', { style: 'margin-bottom:12px' }, h('b', null, 'A number is used once, ever.'), ` Next is ${S.state.nextSerial} for new blades and ${S.state.nextRefurbSerial} for refurbished.`),
      (S.state.duplicateSerials || []).length ? h('p', { class: 'warn', style: 'margin-bottom:12px' }, `Two blades are holding the same number: ${S.state.duplicateSerials.join(', ')}. Check the steel on both before anything ships.`) : null,
      h('div', { style: 'margin-bottom:14px' }, input),
      box);
  }

  /* ---------- money ---------- */

  async function downloadCsv() {
    try {
      const blob = await api('export.csv', null, true);
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: `helanbak-blades-${todayYmd()}.csv` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) {
      if (e instanceof ApiErr && e.status === 401) return;
      if (e instanceof NetErr) {
        S.offline = true;
        renderBanner();
      } else {
        setNotice({ bad: true, title: errText(e) });
      }
    }
  }
  function renderMoney(view) {
    const blades = S.state.blades;
    const order = [...blades].sort((a, c) => {
      const x = serialNum(a.serial) || Infinity;
      const y = serialNum(c.serial) || Infinity;
      return x === y ? 0 : x - y;
    });
    const live = blades.filter((b) => b.stage !== cfg().SCRAPPED);
    const sold = live.filter((b) => b.soldDate || b.soldNoDate);
    const revenue = sold.reduce((t, b) => t + (b.price || 0), 0);
    const margin = sold.reduce((t, b) => t + (b.margin || 0), 0);
    const missing = live.filter((b) => b.price === null || b.price === undefined);
    const soldUnpriced = sold.filter((b) => b.price === null || b.price === undefined).length;
    const checks = blades.filter((b) => b.check).sort((a, c) => serialNum(a.serial) - serialNum(c.serial));
    const rows = ui.moneyMissing ? order.filter((b) => missing.includes(b)) : order;
    const num = (v, neg) => h('td', { class: 'num' + (neg ? ' neg' : '') }, v);
    clear(view,
      h('div', { class: 'head-row' },
        h('h1', null, 'Money'),
        actionBtn('btn', 'Download CSV', downloadCsv, 'Downloading...')),
      h('div', { class: 'totals' },
        h('div', { class: 'total' }, h('span', null, 'Blades sold'), h('b', null, sold.length)),
        h('div', { class: 'total' }, h('span', null, 'Revenue'), h('b', null, dollars(revenue))),
        h('div', { class: 'total' }, h('span', null, 'Margin'), h('b', { class: margin < 0 ? 'neg' : null }, dollars(margin))),
        h('div', { class: 'total' }, h('span', null, 'Blades missing a price'), h('b', null, missing.length))),
      soldUnpriced ? h('p', { class: 'warn', style: 'margin-bottom:12px' }, `${plural(soldUnpriced, 'sold blade has', 'sold blades have')} no price yet, so revenue and margin are low by that much.`) : null,
      missing.length || ui.moneyMissing ? h('div', { style: 'margin-bottom:12px' }, h('button', {
        class: 'btn', type: 'button', onclick: () => { ui.moneyMissing = !ui.moneyMissing; renderView(); },
      }, ui.moneyMissing ? 'Show all blades' : 'Show only blades missing a price')) : null,
      h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Blade money table' },
        h('table', null,
          h('thead', null, h('tr', null,
            ['Blade ID', 'Type', 'Blank', 'Tips', 'Core', 'Customer', 'Shipping'].map((t) => h('th', null, t)),
            ['Price', 'Our cost', 'Ship cost', 'Margin'].map((t) => h('th', { class: 'num' }, t)),
            ['Date sold', 'Step'].map((t) => h('th', null, t)))),
          h('tbody', null, rows.map((b) => h('tr', null,
            h('td', null, h('a', { href: '#/blade/' + encodeURIComponent(b.id) }, b.serial || `Order ${b.orderId}`)),
            h('td', null, b.type), h('td', null, b.blankMaker), h('td', null, b.tipMaker), h('td', null, b.core),
            h('td', null, customerOf(b)), h('td', null, b.carrier),
            num(dollars(b.price)), num(dollars(b.ourCost)), num(dollars(b.shipCost)),
            num(dollars(b.margin), b.margin < 0),
            h('td', null, dayText(b.soldDate)), h('td', null, stageLabel(b.stage))))))),
      h('div', { class: 'section' },
        h('h2', null, `Needs checking (${checks.length})`),
        checks.length ? h('ul', { class: 'rows' }, checks.map((b) => h('li', { class: 'row' },
          h('div', { class: 'row-main', style: 'cursor:default' },
            h('span', { class: 'row-text' },
              h('span', { class: 'row-title' }, h('span', { class: 'row-name' }, bladeName(b)), typePill(b.type), condPill(b)),
              h('span', { class: 'row-sub' }, `${customerOf(b)} · ${stageLabel(b.stage)}`),
              h('span', { class: 'row-sub' }, b.check),
              h('span', { style: 'display:block;margin-top:8px' }, clearCheck(b)))),
          h('a', { class: 'row-more', href: '#/blade/' + encodeURIComponent(b.id), 'aria-label': `Open ${bladeName(b)}` }, 'Open')))) : h('p', { class: 'muted' }, 'Nothing needs checking.')));
  }

  /* ---------- start ---------- */

  async function boot() {
    ui.route = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
    if (!S.pass) return render();
    render();
    await refresh();
    if (S.state) {
      route();
    }
  }
  setInterval(() => { if (S.pass && !document.hidden) refresh(); }, 20000);
  document.addEventListener('visibilitychange', () => { if (S.pass && !document.hidden) refresh(); });
  boot();
})();

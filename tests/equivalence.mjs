// Teste de equivalência: a versão refatorada (Telemetria_ME1.html) deve se comportar exatamente como a v10
// original (tests/reference/Telemetria_ME1_v10.html). As duas páginas recebem as mesmas ações, no Chromium, e são
// comparadas em: resultados internos da simulação (quadros, telemetria, hora a hora, balanço dos passes), texto
// visível, estilo computado de todos os elementos, pixels do canvas em vários instantes, captura da página inteira,
// memória salva no PC e arquivos baixados.
//
// Uso:  npm install && npm test          (ou: node tests/equivalence.mjs [--fuzz=N] [--only=nome] [--no-screens])
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NEW_FILE = path.join(ROOT, 'Telemetria_ME1.html');
const REF_FILE = path.join(ROOT, 'tests', 'reference', 'Telemetria_ME1_v10.html');
const STORAGE_KEY = 'telemetria_me1_gabriel_ivasko_v2';
const FIXED_NOW = new Date('2026-03-14T09:26:53');

const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));
const FUZZ_RUNS = Number(args.fuzz ?? 40);
const ONLY = args.only || null;
const SCREENS = !args['no-screens'];

// ── Cópia da versão nova com um gancho de teste (expõe o estado interno; o arquivo entregue não muda) ──
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'me1-eq-'));
const newSrc = fs.readFileSync(NEW_FILE, 'utf8');
const HOOK_MARK = '\nboot();\n})();';
if (!newSrc.includes(HOOK_MARK)) throw new Error('Marcador de inicialização não encontrado na versão nova');
const NEW_HOOKED = path.join(tmpDir, 'new.html');
fs.writeFileSync(NEW_HOOKED, newSrc.replace(HOOK_MARK, '\nboot();\nwindow.__ME1__ = { config, ui, playback, getResults: () => results };\n})();'));
const REF_COPY = path.join(tmpDir, 'ref.html');
fs.copyFileSync(REF_FILE, REF_COPY);

// ── Leitura do estado interno, com o mesmo formato nas duas versões ──
const PERSISTED = ['seqMode', 'nC2', 'nC1', 'unit', 'ref10', 'speed', 'calcMult', 'calcCadencia', 'l4After', 'rngSeed', 'global', 'lengths', 'widths', 'view', 'carsCfg', 'platCfg', 'passCfg', 'servCfg'];
const READ_INTERNALS = {
  ref: `(() => ({
    frames, logsByProfile, logsByCarIdx, hourly: hourlyLogs, passByProfile: passLogsByProfile, passByIdx: passLogsByIdx,
    playback: { simTime: state.simTime, loopStart: state.loopStart, loopEnd: state.loopEnd, playing: state.playing },
    ui: { cfgTab: state.cfgTab, servTab: state.servTab, openPanels: state.openPanels, selectedLogKey: state.selectedLogKey,
          tableMode: state.tableMode, hourlyBase: state.hourlyBase, passRelease: state.passRelease },
    config: Object.fromEntries(${JSON.stringify(PERSISTED)}.map(k => [k, state[k]]))
  }))()`,
  new: `(() => { const r = __ME1__.getResults(); return {
    frames: r.frames, logsByProfile: r.logsByProfile, logsByCarIdx: r.logsByCarIdx, hourly: r.hourly,
    passByProfile: r.passByProfile, passByIdx: r.passByIdx,
    playback: { ...__ME1__.playback }, ui: __ME1__.ui,
    config: Object.fromEntries(${JSON.stringify(PERSISTED)}.map(k => [k, __ME1__.config[k]]))
  }; })()`
};
const SET_SIMTIME = {
  ref: t => `state.simTime = ${t}`,
  new: t => `__ME1__.playback.simTime = ${t}`
};

// Utilitários injetados nas duas páginas: JSON canônico (chaves ordenadas; "flags" é um campo novo e interno) e SHA-256.
const INIT_SCRIPT = `
  (() => {
    let s = 0x2545F491;
    Math.random = () => { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    window.__canon = v => JSON.stringify(v, (k, val) => {
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        const o = {};
        Object.keys(val).sort().forEach(kk => { if (kk !== 'flags') o[kk] = val[kk]; });
        return o;
      }
      return val;
    });
    window.__sha = async str => {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
      return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    };
    window.__frames2 = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  })();
`;

let failures = 0;
let checks = 0;
const log = (...a) => console.log(...a);
function fail(scenario, what, detail) {
  failures++;
  console.log(`  ✖ [${scenario}] ${what}${detail ? `\n      ${String(detail).split('\n').join('\n      ')}` : ''}`);
}

// ── Sessão: uma página de cada versão, dirigidas em paralelo ──
class Session {
  constructor(browser, name, { storage = null, viewport = { width: 1280, height: 900 } } = {}) {
    this.browser = browser;
    this.name = name;
    this.storage = storage;
    this.viewport = viewport;
    this.pages = {};
    this.errors = { ref: [], new: [] };
  }

  async open() {
    for (const kind of ['ref', 'new']) {
      const ctx = await this.browser.newContext({ viewport: this.viewport, deviceScaleFactor: 1, acceptDownloads: true });
      await ctx.clock.setFixedTime(FIXED_NOW);
      await ctx.addInitScript(INIT_SCRIPT);
      if (this.storage) {
        await ctx.addInitScript(([key, entries]) => {
          if (sessionStorage.getItem('__seeded')) return;
          sessionStorage.setItem('__seeded', '1');
          localStorage.clear();
          entries.forEach(([k, v]) => localStorage.setItem(k || key, v));
        }, [STORAGE_KEY, this.storage]);
      }
      const page = await ctx.newPage();
      page.on('pageerror', e => this.errors[kind].push(e.message));
      page.on('console', m => { if (m.type() === 'error') this.errors[kind].push(m.text().split('\n')[0]); });
      await page.goto('file://' + (kind === 'ref' ? REF_COPY : NEW_HOOKED));
      await page.evaluate('__frames2()');
      this.pages[kind] = page;
    }
    // Pausa e fixa o tempo da animação (a partir daqui tudo é determinístico)
    await this.both(p => p.locator('#playBtn').click());
    await this.both((p, kind) => p.evaluate(SET_SIMTIME[kind](`(${READ_INTERNALS[kind]}).playback.loopStart`)));
    await this.settle();
  }

  async both(fn) {
    const out = {};
    for (const kind of ['ref', 'new']) out[kind] = await fn(this.pages[kind], kind);
    return out;
  }

  async settle() {
    await this.both(p => p.evaluate('__frames2()'));
  }

  async close() {
    for (const p of Object.values(this.pages)) await p.context().close();
  }

  // ── Ações (mesmos seletores/textos nas duas versões) ──
  async click(selector) {
    await this.both(p => p.locator(selector).first().click());
    await this.settle();
  }
  async clickText(text, scope = 'button') {
    await this.both(p => p.locator(scope, { hasText: text }).first().click());
    await this.settle();
  }
  async setRange(selector, value) {
    await this.both(p => p.evaluate(([sel, v]) => {
      const el = document.querySelector(sel);
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, [selector, String(value)]));
    await this.settle();
  }
  async setNumber(selector, value, { input = true, change = true } = {}) {
    await this.both(p => p.evaluate(([sel, v, inp, chg]) => {
      const el = document.querySelector(sel);
      el.value = v;
      if (inp) el.dispatchEvent(new Event('input', { bubbles: true }));
      if (chg) el.dispatchEvent(new Event('change', { bubbles: true }));
    }, [selector, String(value), input, change]));
    await this.settle();
  }
  async type(selector, text) {
    await this.both(async p => { await p.locator(selector).fill(''); await p.locator(selector).pressSequentially(text); });
    await this.settle();
  }
  async selectOption(selector, value) {
    await this.both(p => p.locator(selector).selectOption(value));
    await this.settle();
  }
  async importFile(name, content) {
    await this.both(async p => {
      const [chooser] = await Promise.all([p.waitForEvent('filechooser'), p.locator('button', { hasText: 'Importar Parâmetros' }).click()]);
      await chooser.setFiles({ name, mimeType: 'application/json', buffer: Buffer.from(content) });
    });
    await this.both(p => p.waitForTimeout(150));
    await this.settle();
  }
  async download(buttonText) {
    return this.both(async p => {
      const [dl] = await Promise.all([p.waitForEvent('download'), p.locator('button', { hasText: buttonText }).first().click()]);
      return { name: dl.suggestedFilename(), text: fs.readFileSync(await dl.path(), 'utf8') };
    });
  }
  async setSimTime(t) {
    await this.both((p, kind) => p.evaluate(SET_SIMTIME[kind](t)));
    await this.settle();
  }

  // ── Verificação completa ──
  async checkpoint(label, { canvasSamples = 10, styles = true, screenshot = SCREENS } = {}) {
    const tag = `${this.name} · ${label}`;
    checks++;
    // Toast tem temporizador: guarda o texto e esconde nas duas antes de comparar
    const toast = await this.both(p => p.evaluate(() => {
      const el = document.getElementById('memToast');
      const t = el.textContent;
      el.classList.remove('show');
      return t;
    }));
    if (toast.ref !== toast.new) fail(tag, 'texto do aviso (toast) difere', `${toast.ref} | ${toast.new}`);
    await this.settle();

    // 1) Estado interno da simulação, por componente
    const internals = await this.both((p, kind) => p.evaluate(async src => {
      const data = eval(src);
      const out = {};
      for (const k of Object.keys(data)) out[k] = await __sha(__canon(data[k]));
      return out;
    }, READ_INTERNALS[kind]));
    for (const k of Object.keys(internals.ref)) {
      if (internals.ref[k] !== internals.new[k]) await this.explainInternal(tag, k);
    }

    // 2) Texto visível da página e tabelas (texto + cor + peso de cada célula)
    const dom = await this.both(p => p.evaluate(() => {
      const cells = sel => Array.from(document.querySelectorAll(sel + ' tr')).map(tr => [tr.className, ...Array.from(tr.children).map(td => {
        const cs = getComputedStyle(td);
        const b = td.querySelector('b');
        return [td.innerText, cs.color, cs.fontWeight, b ? getComputedStyle(b).color : ''];
      })]);
      // Atributo "value" só dos campos fixos (com id): nos campos gerados a versão nova sempre grava o valor formatado
      const fields = Array.from(document.querySelectorAll('input, select')).map(el => [el.id, el.type, el.value, el.id ? el.getAttribute('value') : '', el.min, el.max, el.step]);
      return {
        scroll: `${window.scrollX},${window.scrollY}`,
        focus: document.activeElement ? `${document.activeElement.tagName}#${document.activeElement.id}` : '',
        text: document.body.innerText,
        tables: JSON.stringify([cells('#tableBody'), cells('#hourlyTableBody'), cells('#passBalanceBody')]),
        fields: JSON.stringify(fields),
        titles: JSON.stringify(Array.from(document.querySelectorAll('[title]')).map(el => el.title)),
        select: JSON.stringify(Array.from(document.querySelectorAll('#carSelectDropdown option')).map(o => [o.value, o.textContent, o.selected]))
      };
    }));
    for (const k of Object.keys(dom.ref)) {
      if (dom.ref[k] !== dom.new[k]) fail(tag, `DOM: ${k} difere`, firstDiff(dom.ref[k], dom.new[k]));
    }

    // 3) Estilo computado de todos os elementos (mesma árvore nas duas versões)
    if (styles) {
      const css = await this.both(p => p.evaluate(async () => {
        const els = Array.from(document.body.querySelectorAll('*'));
        const rows = els.map(el => {
          const cs = getComputedStyle(el);
          const props = [];
          for (let i = 0; i < cs.length; i++) props.push(cs[i] + ':' + cs.getPropertyValue(cs[i]));
          return el.tagName + '|' + props.join(';');
        });
        return { n: els.length, hash: await __sha(rows.join('\n')), rows };
      }));
      if (css.ref.n !== css.new.n) fail(tag, `árvore de elementos difere (${css.ref.n} vs ${css.new.n})`);
      else if (css.ref.hash !== css.new.hash) {
        const i = css.ref.rows.findIndex((r, idx) => r !== css.new.rows[idx]);
        const a = css.ref.rows[i].split(';'), b = css.new.rows[i].split(';');
        const diffs = a.map((x, j) => (x !== b[j] ? `${x}  ≠  ${b[j]}` : null)).filter(Boolean).slice(0, 8);
        fail(tag, `estilo computado difere no elemento #${i} (${a[0].split('|')[0]})`, diffs.join('\n'));
      }
    }

    // 4) Canvas em vários instantes do laço (e no instante atual)
    if (canvasSamples) {
      const base = await this.both((p, kind) => p.evaluate(src => eval(src).playback, READ_INTERNALS[kind]));
      const { loopStart, loopEnd, simTime } = base.ref;
      const times = [simTime, 0];
      for (let i = 0; i < canvasSamples; i++) times.push(loopStart + ((loopEnd - loopStart) * (i + 0.37)) / canvasSamples);
      for (const t of times) {
        await this.setSimTime(t);
        const img = await this.both(p => p.evaluate(async () => ({
          data: await __sha(document.getElementById('simCanvas').toDataURL()),
          hud: ['timeBadge', 'gapBadge', 'ffBadge'].map(id => document.getElementById(id).textContent).join(' | ')
        })));
        if (img.ref.data !== img.new.data) fail(tag, `canvas difere em t=${t.toFixed(2)}`, await this.canvasDiff());
        if (img.ref.hud !== img.new.hud) fail(tag, `badges do canvas diferem em t=${t.toFixed(2)}`, `${img.ref.hud}\n${img.new.hud}`);
      }
      await this.setSimTime(simTime);
    }

    // 5) Página inteira. Os badges do canvas são repintados a cada quadro e o Chromium varia ±1 nível de cor
    //    nas bordas deles até comparando a v10 com ela mesma: tenta algumas vezes e tolera só esse ruído.
    if (screenshot) {
      let shots, stats;
      for (let attempt = 0; attempt < 3; attempt++) {
        shots = await this.both(p => p.screenshot({ fullPage: true }));
        if (shots.ref.equals(shots.new)) { stats = null; break; }
        stats = await this.screenshotStats(shots);
      }
      if (stats && !(stats.maxDiff <= 2 && stats.n <= 64)) fail(tag, 'captura da página inteira difere', await this.screenshotDiff(shots));
    }

    // 6) Memória do PC
    const mem = await this.both(p => p.evaluate(k => localStorage.getItem(k), STORAGE_KEY));
    if (mem.ref !== mem.new) fail(tag, 'memória salva (localStorage) difere', firstDiff(mem.ref, mem.new));

    // 7) Erros de execução: devem ser os mesmos nas duas (ex.: memória corrompida quebra as duas do mesmo jeito)
    const errs = kind => [...new Set(this.errors[kind])].sort().join('\n');
    if (errs('ref') !== errs('new')) fail(tag, 'erros de execução diferem', `v10:\n${errs('ref') || '(nenhum)'}\nnova:\n${errs('new') || '(nenhum)'}`);
    this.errors = { ref: [], new: [] };
  }

  async explainInternal(tag, key) {
    const parts = await this.both((p, kind) => p.evaluate(([src, k]) => {
      const v = eval(src)[k];
      if (k === 'frames') return { n: v.length, items: v.map(f => __canon(f)) };
      return { n: 1, items: [__canon(v)] };
    }, [READ_INTERNALS[kind], key]));
    if (parts.ref.n !== parts.new.n) return fail(tag, `interno "${key}": tamanhos diferem (${parts.ref.n} vs ${parts.new.n})`);
    const i = parts.ref.items.findIndex((x, j) => x !== parts.new.items[j]);
    fail(tag, `interno "${key}" difere${key === 'frames' ? ` (quadro ${i})` : ''}`, firstDiff(parts.ref.items[i], parts.new.items[i]));
  }

  async canvasDiff() {
    const px = await this.both(p => p.evaluate(() => {
      const c = document.getElementById('simCanvas');
      return { w: c.width, h: c.height, d: Array.from(c.getContext('2d').getImageData(0, 0, c.width, c.height).data) };
    }));
    if (px.ref.w !== px.new.w || px.ref.h !== px.new.h) return `tamanhos: ${px.ref.w}x${px.ref.h} vs ${px.new.w}x${px.new.h}`;
    let n = 0, maxD = 0, first = null;
    for (let i = 0; i < px.ref.d.length; i++) {
      const d = Math.abs(px.ref.d[i] - px.new.d[i]);
      if (d) { n++; maxD = Math.max(maxD, d); if (!first) first = i; }
    }
    const p0 = first / 4;
    return `${n} canais diferentes (dif. máx ${maxD}); primeiro em x=${p0 % px.ref.w}, y=${Math.floor(p0 / px.ref.w)}`;
  }

  async screenshotStats(shots) {
    return this.pages.new.evaluate(async ([a, b]) => {
      const load = src => new Promise(r => { const im = new Image(); im.onload = () => r(im); im.src = 'data:image/png;base64,' + src; });
      const [ia, ib] = await Promise.all([load(a), load(b)]);
      if (ia.width !== ib.width || ia.height !== ib.height) return { n: Infinity, maxDiff: Infinity };
      const data = im => { const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const x = c.getContext('2d'); x.drawImage(im, 0, 0); return x.getImageData(0, 0, im.width, im.height).data; };
      const da = data(ia), db = data(ib);
      let n = 0, maxDiff = 0;
      for (let i = 0; i < da.length; i += 4) {
        const d = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]));
        if (d) { n++; maxDiff = Math.max(maxDiff, d); }
      }
      return { n, maxDiff };
    }, [shots.ref.toString('base64'), shots.new.toString('base64')]);
  }

  async screenshotDiff(shots) {
    const page = this.pages.new;
    const res = await page.evaluate(async ([a, b]) => {
      const load = src => new Promise(r => { const im = new Image(); im.onload = () => r(im); im.src = 'data:image/png;base64,' + src; });
      const [ia, ib] = await Promise.all([load(a), load(b)]);
      if (ia.width !== ib.width || ia.height !== ib.height) return { msg: `tamanhos: ${ia.width}x${ia.height} vs ${ib.width}x${ib.height}`, pts: [] };
      const data = im => { const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const x = c.getContext('2d'); x.drawImage(im, 0, 0); return x.getImageData(0, 0, im.width, im.height).data; };
      const da = data(ia), db = data(ib);
      let n = 0, minY = Infinity, maxY = -1;
      const pts = [];
      for (let i = 0; i < da.length; i += 4) {
        if (da[i] !== db[i] || da[i + 1] !== db[i + 1] || da[i + 2] !== db[i + 2]) {
          n++;
          const x = (i / 4) % ia.width, y = Math.floor(i / 4 / ia.width);
          minY = Math.min(minY, y); maxY = Math.max(maxY, y);
          if (pts.length < 3) pts.push([x, y]);
        }
      }
      return { msg: `${n} pixels diferentes (linhas ${minY}–${maxY})`, pts };
    }, [shots.ref.toString('base64'), shots.new.toString('base64')]);
    const where = [];
    for (const [x, y] of res.pts) {
      const at = await this.both(p => p.evaluate(([x, y]) => {
        window.scrollTo(0, Math.max(0, y - 200));
        const el = document.elementFromPoint(x, y - window.scrollY);
        const out = el ? `${el.tagName}#${el.id}.${el.className} "${(el.textContent || '').slice(0, 40)}"` : '-';
        window.scrollTo(0, 0);
        return out;
      }, [x, y]));
      where.push(`(${x},${y}) v10: ${at.ref} | nova: ${at.new}`);
    }
    return [res.msg, ...where].join('\n');
  }
}

function firstDiff(a, b) {
  a = String(a); b = String(b);
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  const from = Math.max(0, i - 80);
  return `pos ${i}\n  v10:  …${a.slice(from, i + 120)}\n  nova: …${b.slice(from, i + 120)}`;
}

// ── Cenários roteirizados ──
const F = {
  entry: n => `#entrySafetyContainer > .param-box:nth-child(${n}) input[type=number]`,
  entryRange: n => `#entrySafetyContainer > .param-box:nth-child(${n}) input[type=range]`,
  trecho: (card, field) => `#carTrechosContainer > .trecho-card:nth-child(${card}) .grid-6col > .param-box:nth-child(${field}) input[type=number]`,
  trechoRange: (card, field) => `#carTrechosContainer > .trecho-card:nth-child(${card}) .grid-6col > .param-box:nth-child(${field}) input[type=range]`,
  trechoDel: card => `#carTrechosContainer > .trecho-card:nth-child(${card}) .trecho-card-header button`,
  pass: (card, field) => `#passParamsContainer > .trecho-card:nth-child(${card}) .grid-4col > .param-box:nth-child(${field}) input[type=number]`,
  passRange: (card, field) => `#passParamsContainer > .trecho-card:nth-child(${card}) .grid-4col > .param-box:nth-child(${field}) input[type=range]`,
  passDel: card => `#passParamsContainer > .trecho-card:nth-child(${card}) .trecho-card-header button`,
  plat: n => `#platParamsContainer > .param-box:nth-child(${n}) input[type=number]`,
  serv: n => `#servParamsContainer > .param-box:nth-child(${n}) input[type=number]`,
  servRange: n => `#servParamsContainer > .param-box:nth-child(${n}) input[type=range]`,
  length: n => `#lengthParamsContainer > .param-box:nth-child(${n}) input[type=number]`,
  lengthRange: n => `#lengthParamsContainer > .param-box:nth-child(${n}) input[type=range]`
};

const legacyConfig = {
  seqMode: 'C2_C1', nC2: 2, nC1: 1, unit: 's', ref10: 'front', speed: 10,
  global: { Dmin: 1.1, Dff: 6.5, Hmax: 1.5 },
  lengths: { XDF: { L2: 5.2, L3: 5.9, L4: 6.6 } },
  view: { h: 640, line: 200, zoom: 120 },
  carsCfg: {
    C1: { E0: 5.0, p1_pos: 9, v_t1: 2.5, h_t1: 1.2, p1_time: 30, p2_pos: 18, v_t2: 1.5, h_t2: 1.3, p2_time: 0, p3_pos: 27, v_t3: 1.2, h_t3: 1.2, p3_time: 90, p4_pos: 40, v_t4: 1.1, h_t4: 1.2, p4_time: 0 },
    C2: { E0: 4.2 }
  },
  platCfg: { enabled: true, len: 4.0, x_in: 2.5, x_out: 18.0, v_move: 5.0, follow_stops: 2 },
  passCfg: { enabled: true, passes: [{ id: 1, x_in: 0, x_out: 12, t_op: 200, tol: 10 }, { id: 2, x_in: 12, x_out: 26, t_op: 0, tol: 25 }, { id: 3, x_in: 26, x_out: 40, t_op: 120, tol: 0 }] },
  servCfg: { enabled: true, len: 2.2, XDF: { x0: 27, x_start: 20, t_op: 40 }, X62: { x0: 29, x_start: 23, t_follow: 30 } }
};

const SCENARIOS = {
  async padrao(s) {
    await s.checkpoint('carregado');
    await s.click('#seq_ONLY_C2');
    await s.checkpoint('apenas XDF');
    await s.click('#seq_ONLY_C1');
    await s.checkpoint('apenas X62');
    await s.click('#seq_C2_C1');
    await s.setNumber('#num_nC2', 3, { input: false });
    await s.setRange('#rng_nC1', 2);
    await s.checkpoint('3 XDF → 2 X62');
    await s.setNumber('#num_nC2', 45, { input: false });
    await s.checkpoint('qtd. acima do slider');
    await s.setNumber('#num_nC1', '0', { input: false });
    await s.checkpoint('qtd. inválida', { canvasSamples: 2 });
  },

  async tamanhos(s) {
    await s.click('#chev_sizes');
    await s.setNumber('#num_l4After', 0, { input: false });
    await s.checkpoint('sem L4');
    await s.setRange('#rng_l4After', 3);
    await s.checkpoint('L4 após 3');
    await s.setNumber('#num_l4After', 40, { input: false });
    await s.checkpoint('L4 após 40', { canvasSamples: 4 });
    await s.clickText('Sortear Sequência');
    await s.checkpoint('sorteio');
    await s.setNumber(F.length(3), 7.4, { input: false });
    await s.setRange(F.lengthRange(4), 4.8);
    await s.setNumber(F.length(5), '0.4', { input: false });
    await s.checkpoint('comprimentos');
    await s.click('#hint_sizes');
    await s.checkpoint('painel fechado', { canvasSamples: 0 });
  },

  async unidades_e_tabelas(s) {
    await s.click('#unitMin');
    await s.click('#refRear');
    await s.checkpoint('min + traseira');
    for (const tab of ['#pTab_C2', '#pTab_C1', '#pTab_PLAT_XDF', '#pTab_C3']) {
      await s.click(tab);
      await s.checkpoint('aba ' + tab, { canvasSamples: 0, screenshot: false });
    }
    for (const v of ['V1', 'V2']) {
      await s.selectOption('#carSelectDropdown', v);
      await s.checkpoint('lote ' + v, { canvasSamples: 0, screenshot: false });
    }
    await s.click('#tableBody tr:nth-child(3)');
    await s.checkpoint('clique na linha da tabela', { canvasSamples: 1 });
    await s.click('#toggleTableModeBtn');
    await s.click('#hrZeroBtn');
    await s.checkpoint('hora a hora desde t=0');
    await s.click('#hourlyTableBody tr:nth-child(4)');
    await s.click('#hrRegimeBtn');
    await s.setNumber('#num_calcMult', '2.5', { change: false });
    await s.setNumber('#num_calcCadencia', '40', { change: false });
    await s.checkpoint('calculadora (negativo)', { canvasSamples: 1 });
    await s.setNumber('#num_calcCadencia', 'abc', { change: false });
    await s.click('#toggleTableModeBtn');
    await s.click('#unitS');
    await s.checkpoint('volta ao esquema');
    await s.click('#sp100');
    await s.click('#playBtn');
    await s.click('#playBtn');
    await s.clickText('Fluxo Contínuo', '.controls-bar button');
    await s.checkpoint('fluxo contínuo', { canvasSamples: 1 });
    await s.clickText('Início (t=0)');
    await s.checkpoint('início', { canvasSamples: 1 });
  },

  async passes(s) {
    await s.setNumber(F.pass(3, 3), 600, { input: false });
    await s.setRange(F.passRange(2, 3), 240);
    await s.setNumber(F.pass(2, 4), 40, { input: false });
    await s.checkpoint('tempos de operação XDF');
    await s.click('#passTab_X62');
    await s.setNumber(F.pass(1, 3), 500, { input: false });
    await s.setNumber(F.pass(4, 1), 25, { input: false });
    await s.checkpoint('passes X62 (reordenados)');
    await s.clickText('Adicionar Passe');
    await s.checkpoint('passe adicionado');
    await s.click(F.passDel(2));
    await s.checkpoint('passe removido');
    await s.click('#passReleaseBtn');
    await s.checkpoint('linha liberada');
    await s.click('#passReleaseBtn');
    await s.click('#passToggleBtn');
    await s.checkpoint('passes inativos');
    await s.click('#passToggleBtn');
    await s.click('#unitMin');
    await s.setNumber(F.pass(1, 3), 3.5, { input: false });
    await s.checkpoint('tempo do passe em minutos');
    await s.click('#hint_pass');
    await s.click('#passTab_XDF');
    await s.checkpoint('aba reabre o painel');
  },

  async travamento(s) {
    // Altura acima do limite + passe com tempo: o carro fica vermelho preso no limite → linha travada
    await s.setNumber(F.pass(1, 3), 300, { input: false });
    await s.setNumber(F.entry(4), 1.0, { input: false });
    await s.checkpoint('linha travada');
    await s.click('#deadlockBanner button');
    await s.checkpoint('liberar pelo banner');
    await s.click('#releaseBanner button');
    await s.checkpoint('volta ao normal');
    await s.setNumber(F.entry(4), 1.5, { input: false });
    await s.setNumber(F.entry(3), 7.5, { input: false });
    await s.setNumber(F.entry(2), 2.2, { input: false });
    await s.setRange(F.entryRange(1), 6.3);
    await s.checkpoint('Dff, Dmin e E0');
  },

  async servant_e_plataforma(s) {
    await s.click('#hint_serv');
    await s.click('#hint_plat');
    await s.setNumber(F.serv(6), 200, { input: false });
    await s.setRange(F.servRange(1), 2.6);
    await s.checkpoint('servant XDF');
    await s.click('#servTab_X62');
    await s.setNumber(F.serv(7), 120, { input: false });
    await s.setNumber(F.serv(2), 20, { input: false });
    await s.checkpoint('servant X62');
    await s.setNumber(F.plat(4), 6, { input: false });
    await s.setNumber(F.plat(7), 9, { input: false });
    await s.setNumber(F.plat(5), 1, { input: false });
    await s.setNumber(F.plat(8), 36, { input: false });
    await s.checkpoint('plataforma');
    await s.setNumber(F.plat(4), 0, { input: false });
    await s.checkpoint('entrada 0 m', { canvasSamples: 4 });
    await s.setNumber('#w_serv', 2.4, { input: true, change: false });
    await s.setNumber('#v_gap', 0, { input: true, change: true });
    await s.setNumber('#w_plat', 9, { input: true, change: true });
    await s.checkpoint('larguras');
    await s.click('#servToggleBtn');
    await s.checkpoint('servant inativa');
    await s.click('#servToggleBtn');
    await s.click('#platToggleBtn');
    await s.checkpoint('plataforma inativa');
    await s.click('#pTab_PLAT_XDF');
    await s.checkpoint('aba plataforma inativa', { canvasSamples: 0 });
  },

  async trechos(s) {
    await s.click('#cfgTab_C1');
    await s.clickText('Adicionar Trecho');
    await s.checkpoint('trecho adicionado (X62)');
    await s.setNumber(F.trecho(2, 1), 33, { input: false });
    await s.checkpoint('trecho reordenado');
    await s.setNumber(F.trecho(1, 5), 1.9, { input: false });
    await s.setNumber(F.trecho(1, 6), 20, { input: false });
    await s.setRange(F.trechoRange(3, 4), 45);
    await s.checkpoint('altura na parada com transição');
    await s.click(F.trechoDel(1));
    await s.checkpoint('trecho removido');
    await s.click('#cfgTab_C3');
    await s.click(F.trechoDel(4));
    await s.click(F.trechoDel(3));
    await s.click(F.trechoDel(2));
    await s.checkpoint('XDF←X62 com 1 trecho');
    await s.click('#hint_ops');
    await s.click('#cfgTab_C2');
    await s.checkpoint('aba reabre o painel');
  },

  async janela(s) {
    await s.setNumber('#v_zoom', 180, { input: true, change: false });
    await s.checkpoint('zoom');
    await s.click('#v_auto');
    await s.checkpoint('auto desligado');
    await s.setNumber('#v_h', 760, { input: true, change: false });
    await s.setNumber('#v_line', 300, { input: true, change: true });
    await s.checkpoint('altura e linha manuais');
    await s.both(async p => {
      const box = await p.locator('#canvasResizer').boundingBox();
      await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await p.mouse.down();
      await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 120, { steps: 5 });
      await p.mouse.up();
    });
    await s.settle();
    await s.checkpoint('arraste da barra');
    await s.click('#v_auto');
    await s.both(p => p.setViewportSize({ width: 900, height: 800 }));
    await s.settle();
    await s.checkpoint('janela redimensionada');
    await s.both(p => p.setViewportSize({ width: 640, height: 800 }));
    await s.settle();
    await s.checkpoint('celular');
  },

  async memoria(s) {
    await s.setNumber(F.pass(3, 3), 120, { input: false });
    await s.click('#seq_ONLY_C2');
    const exported = await s.download('Exportar Parâmetros');
    if (exported.ref.name !== exported.new.name) fail(s.name, 'nome do .json exportado difere', `${exported.ref.name} | ${exported.new.name}`);
    if (exported.ref.text !== exported.new.text) fail(s.name, '.json exportado difere', firstDiff(exported.ref.text, exported.new.text));
    await s.checkpoint('exportado');
    await s.clickText('Restaurar Padrão');
    await s.checkpoint('padrão restaurado');
    await s.importFile('params.json', exported.ref.text);
    await s.checkpoint('reimportado');
    await s.importFile('legado.json', JSON.stringify(legacyConfig));
    await s.checkpoint('formato antigo importado');
    await s.importFile('quebrado.json', '{ isto não é json');
    await s.checkpoint('arquivo inválido', { canvasSamples: 0 });
    await s.importFile('numero.json', '42');
    await s.checkpoint('json não-objeto', { canvasSamples: 0 });
  },

  async protecao(s) {
    const blocked = await s.both(p => p.evaluate(() => {
      const fire = init => { const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }); document.dispatchEvent(e); return e.defaultPrevented; };
      const ctx = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      document.body.dispatchEvent(ctx);
      return JSON.stringify([
        fire({ key: 'F12' }), fire({ key: 'I', ctrlKey: true, shiftKey: true }), fire({ key: 'u', ctrlKey: true }),
        fire({ key: 's', ctrlKey: true }), fire({ key: 'i', metaKey: true, altKey: true }), fire({ key: 'a', ctrlKey: true }),
        fire({ key: 'x' }), ctx.defaultPrevented
      ]);
    }));
    if (blocked.ref !== blocked.new) fail(s.name, 'bloqueio de atalhos difere', `${blocked.ref} | ${blocked.new}`);
    await s.type('#txtPwdInput', '1028');
    await s.checkpoint('senha errada', { canvasSamples: 0 });
    await s.type('#txtPwdInput', '1027');
    await s.checkpoint('senha certa', { canvasSamples: 0 });
    const txt = await s.download('Baixar .TXT');
    if (txt.ref.name !== txt.new.name) fail(s.name, 'nome do .txt difere', `${txt.ref.name} | ${txt.new.name}`);
    await s.checkpoint('após download', { canvasSamples: 0 });
    // A cópia baixada abre "trancada" e funciona
    for (const kind of ['ref', 'new']) {
      const file = path.join(tmpDir, `snapshot-${kind}.html`);
      fs.writeFileSync(file, txt[kind].text);
      if (!txt[kind].text.startsWith('<!DOCTYPE html>\n<html')) fail(s.name, `.txt (${kind}) não começa com o HTML`);
      const ctx = await s.browser.newContext();
      const page = await ctx.newPage();
      const errs = [];
      page.on('pageerror', e => errs.push(e.message));
      await page.goto('file://' + file);
      await page.waitForTimeout(400);
      const st = await page.evaluate(() => ({
        pwd: getComputedStyle(document.getElementById('txtPwdWrap')).display,
        btn: getComputedStyle(document.getElementById('downloadTxtBtn')).display,
        val: document.getElementById('txtPwdInput').value,
        rows: document.querySelectorAll('#tableBody tr').length
      }));
      if (st.pwd === 'none' || st.btn !== 'none' || st.val !== '' || !st.rows) fail(s.name, `cópia .txt (${kind}) não abre trancada/funcional`, JSON.stringify(st));
      if (errs.length) fail(s.name, `cópia .txt (${kind}) com erros`, errs.join('\n'));
      await ctx.close();
    }
  }
};

// Memória salva por versões anteriores
const STORAGE_SCENARIOS = {
  memoria_v1: [['telemetria_me1_gabriel_ivasko_v1', JSON.stringify({ config: legacyConfig })]],
  memoria_v2_pura: [[STORAGE_KEY, JSON.stringify({ ...legacyConfig, unit: 'min', seqMode: 'ONLY_C1' })]],
  memoria_corrompida: [[STORAGE_KEY, '{"config": {"carsCfg": {"C2": {"trechos": [{"pos": "x"}]}}}}']],
  memoria_string: [[STORAGE_KEY, '"abc"']]
};

// ── Configurações aleatórias (dentro dos limites dos sliders) ──
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function randomConfig(seed) {
  const r = mulberry32(seed);
  const pick = arr => arr[Math.floor(r() * arr.length)];
  const num = (lo, hi, step) => Math.round((lo + r() * (hi - lo)) / step) * step;
  const chance = p => r() < p;
  const trechos = () => {
    const n = 1 + Math.floor(r() * 5);
    const cuts = Array.from({ length: n - 1 }, () => num(3, 38, 0.1)).sort((a, b) => a - b);
    return [...cuts, 40].map((pos, i) => ({
      id: i + 1, pos, v_move: num(0.8, 14, 0.01), h_move: chance(0.15) ? num(1.3, 2.0, 0.01) : 1.2,
      t_stop: chance(0.45) ? num(10, 500, 1) : 0, h_stop: chance(0.25) ? num(0.8, 1.9, 0.01) : 1.2, t_h_stop: chance(0.3) ? num(1, 40, 1) : 0
    }));
  };
  const passes = () => {
    const n = 1 + Math.floor(r() * 5);
    const cuts = [0, ...Array.from({ length: n - 1 }, () => num(2, 38, 0.1)).sort((a, b) => a - b), 40];
    return cuts.slice(0, -1).map((x, i) => ({ id: i + 1, x_in: x, x_out: cuts[i + 1], t_op: chance(0.5) ? num(20, 700, 1) : 0, tol: chance(0.4) ? num(0, 60, 1) : 0 }));
  };
  return {
    seqMode: pick(['C2_C1', 'C2_C1', 'ONLY_C2', 'ONLY_C1']), nC2: 1 + Math.floor(r() * 4), nC1: 1 + Math.floor(r() * 3),
    unit: pick(['s', 'min']), ref10: pick(['front', 'rear']), speed: 20, calcMult: num(0.5, 3, 0.1), calcCadencia: num(0, 10, 1),
    l4After: Math.floor(r() * 8), rngSeed: 100000 + Math.floor(r() * 800000),
    global: { C: 5.7, Dmin: num(0.5, 3, 0.05), Dff: chance(0.3) ? num(4, 12, 0.05) : 0, Hmax: chance(0.2) ? num(1.0, 1.4, 0.01) : num(1.4, 2.2, 0.01) },
    lengths: { XDF: { L2: num(4.5, 6, 0.01), L3: num(5, 6.5, 0.01), L4: num(5.5, 7.5, 0.01) }, X62: { L2: num(4.5, 6, 0.01), L3: num(5, 6.5, 0.01), L4: num(5.5, 7.5, 0.01) } },
    widths: { XDF: num(1.2, 2.6, 0.05), X62: num(1.2, 2.6, 0.05), plat: num(0.6, 2.2, 0.05), serv: num(0.4, 1.6, 0.05) },
    view: { auto: chance(0.8), h: num(300, 900, 10), line: num(100, 300, 10), zoom: num(60, 200, 10), gap: num(0, 3, 0.1) },
    carsCfg: { C1: { E0: num(2, 9, 0.05), trechos: trechos() }, C2: { E0: num(2, 9, 0.05), trechos: trechos() }, C3: { E0: num(2, 9, 0.05), trechos: trechos() } },
    platCfg: { enabled: chance(0.8), len: num(2, 7, 0.05), x_in: num(0, 8, 0.1), x_out: num(15, 40, 0.1), v_move: num(1, 15, 0.01), follow_stops: 1 + Math.floor(r() * 3), car_trigger: num(0, 10, 0.1), entry_dist: num(0.5, 8, 0.1), exit_dist: num(0.5, 10, 0.1) },
    passCfg: { enabled: chance(0.8), tab: pick(['XDF', 'X62']), XDF: { passes: passes() }, X62: { passes: passes() } },
    servCfg: {
      enabled: chance(0.85), len: num(0.8, 4, 0.05),
      XDF: { x0: num(18, 34, 0.1), trigger_x: num(5, 25, 0.1), v_to_p0: num(50, 600, 5), car_wait_pos: num(10, 32, 0.1), t_op: num(0, 200, 1), t_move_pos: num(0, 120, 1), v_move_pos: num(50, 500, 5), v_retorno: num(50, 600, 5) },
      X62: { x0: num(20, 34, 0.1), x_start: num(12, 20, 0.1), trigger_x: num(5, 25, 0.1), v_to_p0: num(50, 600, 5), car_wait_pos: num(10, 32, 0.1), t_follow: num(0, 200, 1), v_retorno: num(50, 600, 5) }
    }
  };
}

// ── Execução ──
const browser = await chromium.launch();
const started = Date.now();
try {
  const runScenario = async (name, opts, body) => {
    if (ONLY && !name.includes(ONLY)) return;
    const s = new Session(browser, name, opts);
    const t0 = Date.now();
    try {
      await s.open();
      await body(s);
    } catch (e) {
      fail(name, 'exceção no roteiro', e.stack);
    } finally {
      await s.close();
    }
    log(`  ${failures ? '·' : '✔'} ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  };

  log('Cenários roteirizados');
  for (const [name, body] of Object.entries(SCENARIOS)) await runScenario(name, {}, body);
  for (const [name, storage] of Object.entries(STORAGE_SCENARIOS)) {
    await runScenario(name, { storage }, async s => {
      await s.checkpoint('carregado da memória');
      await s.click('#seq_C2_C1');
      await s.checkpoint('após alteração', { canvasSamples: 3 });
    });
  }

  log(`Configurações aleatórias (${FUZZ_RUNS})`);
  for (let i = 0; i < FUZZ_RUNS; i++) {
    const cfg = randomConfig(1000 + i);
    await runScenario(`aleatoria_${i}`, { storage: [[STORAGE_KEY, JSON.stringify({ app: 'Telemetria_ME1', config: cfg })]] }, async s => {
      await s.checkpoint('carregado', { canvasSamples: 6, screenshot: i % 5 === 0 && SCREENS, styles: i % 5 === 0 });
      await s.click('#passReleaseBtn');
      await s.checkpoint('linha liberada', { canvasSamples: 2, screenshot: false, styles: false });
    });
  }
} finally {
  await browser.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

log(`\n${checks} pontos de verificação em ${((Date.now() - started) / 1000).toFixed(0)} s — ${failures ? `${failures} DIFERENÇA(S)` : 'nenhuma diferença'}`);
process.exit(failures ? 1 : 0);

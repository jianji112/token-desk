#!/usr/bin/env node
/**
 * test/run.mjs — token-desk P0-0 harness（只读：不修改 public/app 下任何主代码）
 *
 * 做法：
 *   1. 起一个本地 HTTP 服务，把 public/app/assets 原样提供出来（index.html / app.js / style.css / bootstrap.js 都是原件）；
 *   2. 同源提供 mock 的 /api/log/（可编程分页、可延迟、可 429/500、可记录请求序列）；
 *   3. 用 headless Chrome + CDP 打开真实 index.html，通过
 *      Page.addScriptToEvaluateOnNewDocument 在 app.js 之前：冻结 Date.now + 预置 localStorage；
 *   4. 用 __app 已导出的调试 API（rawClear/raw/rawAgg/meta/pf/state/loadUsage/refreshUsageDelta）
 *      驱动扫描/增量，断言"改好之后"的期望值 —— 所以现在跑必然是红的多、绿的少，这就是基线。
 *
 * 用法：
 *   node test/run.mjs                # 跑全部用例，打印结果
 *   node test/run.mjs --only=F2,F3   # 只跑指定用例
 *   node test/run.mjs --json         # 额外输出机器可读 JSON
 *
 * 依赖：node >= 20（用内置 WebSocket）、本机 google-chrome。无 npm 依赖。
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');            // = public/
const ASSETS = path.join(ROOT, 'app', 'assets');
// Chrome profile 属于一次性产物，放缓存目录，绝不落进仓库
const SCRATCH = process.env.BH_AGENT_WORKSPACE || path.join(process.env.HOME || '/tmp', '.hermes', 'cache', 'scratch');
const CHROME_PROFILE = path.join(SCRATCH, 'td-test-chrome');

/** 冻结时钟：所有时间基准都从这里算，禁止用真实时间（否则 CI 上 F2/F10/F11 必然抖） */
const NOW = 1761000000;
const DAY = 86400;

const argv = process.argv.slice(2);
const ONLY = (argv.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const EMIT_JSON = argv.includes('--json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────── mock 服务
const state = {
  gate: true, // true = /api/log/ 一律返回空（用于让 boot 阶段安静），fixture 开始前打开
  log: [], // [{p,size,start,end,t}]
  pages: new Map(), // page -> {items,total?,status?,body?,delay?}
  dynamic: null, // (page, req) => {items,total?} | undefined
  onRespond: null, // (page, req) => void  （用于 F9 在 p1 之后插入新行）
};

function mockReset() {
  state.gate = true;
  state.log = [];
  state.pages = new Map();
  state.dynamic = null;
  state.onRespond = null;
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(ASSETS, path.normalize(rel));
  if (!file.startsWith(ASSETS)) { res.writeHead(403); res.end('no'); return true; }
  if (!existsSync(file)) return false;
  const ext = path.extname(file);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(readFileSync(file));
  return true;
}

const server = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  const p = u.pathname;

  if (p.startsWith('/api/log/')) {
    const rec = {
      p: Number(u.searchParams.get('p') || '1'),
      size: Number(u.searchParams.get('page_size') || '0'),
      start: Number(u.searchParams.get('start_timestamp') || '0'),
      end: Number(u.searchParams.get('end_timestamp') || '0'),
      t: Date.now(),
    };
    state.log.push(rec);
    if (state.gate) return sendJson(res, 200, { success: true, data: { items: [], total: 0 } });
    let spec = state.pages.get(rec.p);
    if (!spec && state.dynamic) spec = state.dynamic(rec.p, rec);
    if (!spec) spec = { items: [], total: 0 };
    if (spec.delay) await sleep(spec.delay);
    if (state.onRespond) state.onRespond(rec.p, rec, spec);
    if (spec.status && spec.status !== 200) {
      return sendJson(res, spec.status, spec.body || { success: false, message: 'mock HTTP ' + spec.status + ' (429)' });
    }
    const data = { items: spec.items || [] };
    if (spec.total !== undefined) data.total = spec.total;
    return sendJson(res, 200, { success: true, data });
  }

  // 其余 NewAPI 端点：给能让 boot 安静跑完的最小合法响应
  if (p.startsWith('/api/user/self')) {
    return sendJson(res, 200, { success: true, data: { id: 1, username: 'tester', quota: 1000000, used_quota: 0, request_count: 0 } });
  }
  if (p.startsWith('/api/')) {
    return sendJson(res, 200, { success: true, data: { items: [], total: 0 } });
  }

  if (serveStatic(res, p)) return;
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('404');
});

// ─────────────────────────────────────────── CDP
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error('CDP ' + JSON.stringify(m.error)));
        else resolve(m.result);
      }
    });
    ws.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('CDP closed'));
      this.pending.clear();
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(msg));
    });
  }
}

async function launchChrome() {
  rmSync(CHROME_PROFILE, { recursive: true, force: true });
  mkdirSync(CHROME_PROFILE, { recursive: true });
  const bin = process.env.CHROME || 'google-chrome';
  const proc = spawn(bin, [
    '--headless=new',
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    '--user-data-dir=' + CHROME_PROFILE,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-sandbox',
    '--disable-extensions',
    // 关键：宿主机有 http_proxy，Chrome 会把 127.0.0.1 也送进代理导致 Page.navigate 卡 20s
    '--no-proxy-server',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-default-apps',
    '--no-pings',
    '--window-size=900,1400',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  proc.stderr.on('data', (d) => { err += d; });

  const portFile = path.join(CHROME_PROFILE, 'DevToolsActivePort');
  for (let i = 0; i < 200; i++) {
    if (existsSync(portFile)) {
      const txt = readFileSync(portFile, 'utf8').split('\n');
      if (txt[0]) return { proc, port: Number(txt[0]) };
    }
    if (proc.exitCode != null) throw new Error('chrome 启动失败：' + err.slice(-800));
    await sleep(50);
  }
  throw new Error('chrome 未就绪：' + err.slice(-800));
}

async function connect(port) {
  const r = await fetch(`http://127.0.0.1:${port}/json/version`);
  const { webSocketDebuggerUrl } = await r.json();
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('CDP WS error')), { once: true });
  });
  return new Cdp(ws);
}

/** 每条用例一个全新 target：闭包变量（cacheMem / S / rawStore）天然隔离 */
async function openPage(cdp, port, cfg, preSeedJs = '') {
  const T = (label, t0) => { if (process.env.TD_TIMING) process.stderr.write(`      [open] ${label}=${Date.now() - t0}ms\n`); };
  let t = Date.now();
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  T('createTarget', t); t = Date.now();
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  T('attach', t); t = Date.now();
  const src = `(() => {
  const FIXED = ${NOW} * 1000;
  Date.now = () => FIXED;
  try { localStorage.clear(); } catch (e) {}
  window.__T = {
    row: (ts,id,tid,name,model,pt,ct,q) => [ts,tid,name,model,pt,ct,q,0,0,0,'',id],
    item: (ts,id,tid,name,model,pt,ct,q) => ({id:id,created_at:ts,token_id:tid,token_name:name,model_name:model,prompt_tokens:pt,completion_tokens:ct,quota:q,use_time:0.5,other:null}),
    seedRaw: (rows,extra) => localStorage.setItem('tokendesk.rawlog.v2', JSON.stringify(Object.assign({at:0,since:0,newest:0,pages:0,complete:false,rows:rows}, extra||{}))),
    agg: (r) => { const a = __app.rawAgg(r); return { req:a.req, prompt:a.prompt, completion:a.completion, total:a.total, quota:a.quota, capped: !!a.capped, names: Object.values(a.byKey).map(x=>x.name), keys: Object.keys(a.byKey) }; },
    raw: () => __app.raw(),
    pf: () => __app.pf(),
    sleep: (ms) => new Promise(r => setTimeout(r, ms))
  };
  try { localStorage.setItem('tokendesk.cfg.v1', JSON.stringify(${JSON.stringify(cfg)})); } catch (e) {}
  ${preSeedJs}
})();`;
  await cdp.send('Page.enable', {}, sessionId);
  T('page.enable', t); t = Date.now();
  await cdp.send('Runtime.enable', {}, sessionId);
  T('runtime.enable', t); t = Date.now();
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: src }, sessionId);
  T('addScript', t); t = Date.now();
  const url = `http://127.0.0.1:${port}/`;
  await cdp.send('Page.navigate', { url }, sessionId);
  T('navigate', t); t = Date.now();

  for (let i = 0; i < 200; i++) {
    const st = await evaluate(cdp, sessionId, '({r: document.readyState, a: typeof window.__app})', false).catch(() => null);
    if (st && st.r !== 'loading' && st.a === 'object') { T('ready+poll(' + i + ')', t); return { sessionId, targetId }; }
    await sleep(50);
  }
  throw new Error('页面未就绪（__app 未挂载）');
}

async function evaluate(cdp, sessionId, expression, awaitPromise = true) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise, userGesture: true }, sessionId);
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error('页面 JS 抛错：' + ((d.exception && (d.exception.description || d.exception.value)) || d.text));
  }
  return r.result.value;
}

// ─────────────────────────────────────────── 断言
function eq(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  return { label, actual, expected, ok };
}
function truthy(label, actual, expectTrue = true) {
  const ok = !!actual === !!expectTrue;
  return { label, actual, expected: expectTrue ? true : false, ok };
}

// ─────────────────────────────────────────── 用例
const baseCfg = (port, extra = {}) => ({
  newapiBase: `http://127.0.0.1:${port}`,
  newapiToken: 'test-token-0123456789abcdef',
  newapiUid: '1',
  hubBase: '',
  hubPass: '',
  range: '24h',
  maxPages: '80',
  guideDone: true,
  channel: 'browser',
  autoRefresh: '0',
  prefetch: '0',
  accRealm: 'all',
  privacy: false,
  ...extra,
});

/** 每条 fixture: { id, name, cfg, seed, settle, run(ctx) -> checks[] } */
const fixtures = [
  {
    id: 'F1',
    name: '基线全量扫描（24h / 3 行）',
    cfg: (port) => baseCfg(port),
    setup(port) {
      state.pages.set(1, {
        total: 3,
        items: [
          { id: 1, created_at: NOW - 3600, token_id: 7, token_name: 't7', model_name: 'gpt-4o', prompt_tokens: 100, completion_tokens: 200, quota: 1000 },
          { id: 2, created_at: NOW - 7200, token_id: 7, token_name: 't7', model_name: 'gpt-4o', prompt_tokens: 50, completion_tokens: 50, quota: 500 },
          { id: 3, created_at: NOW - 10800, token_id: 7, token_name: 't7', model_name: 'gpt-4o', prompt_tokens: 10, completion_tokens: 20, quota: 100 },
        ],
      });
    },
    run: `(async () => { await __app.loadUsage('24h', true); return { a: __T.agg('24h'), r: __T.raw(), busy: !!__app.state.busy.usage }; })()`,
    check(out) {
      return [
        eq('req', out.a.req, 3),
        eq('prompt', out.a.prompt, 160),
        eq('completion', out.a.completion, 270),
        eq('total', out.a.total, 430),
        eq('quota', out.a.quota, 1600),
        eq('raw.rows', out.r.rows, 3),
        eq('raw.coverFrom', out.r.coverFrom, NOW - DAY),
        eq('busy 收尾复位', out.busy, false),
      ];
    },
  },

  {
    id: 'F2',
    name: '同秒晚落库的行（deltaFetch 的 ts<=cutoff）',
    cfg: (port) => baseCfg(port),
    seed: `__T.seedRaw([__T.row(${NOW - 1000}, 1, 7, 't7', 'gpt-4o', 10, 10, 100)], { newest: ${NOW - 1000}, since: ${NOW - 1000} });`,
    setup() {
      state.pages.set(1, {
        total: 3,
        items: [
          { id: 99, created_at: NOW - 1000, token_id: 7, token_name: 't7', model_name: 'gpt-4o', prompt_tokens: 5, completion_tokens: 7, quota: 50 },
          { id: 1, created_at: NOW - 1000, token_id: 7, token_name: 't7', model_name: 'gpt-4o', prompt_tokens: 10, completion_tokens: 10, quota: 100 },
          { id: 100, created_at: NOW - 999, token_id: 7, token_name: 't7', model_name: 'gpt-4o', prompt_tokens: 3, completion_tokens: 3, quota: 30 },
        ],
      });
    },
    run: `(async () => { await __app.refreshUsageDelta(); return { a: __T.agg('24h'), r: __T.raw() }; })()`,
    check(out) {
      return [
        eq('raw.rows（同秒迟到行必须收下）', out.r.rows, 3),
        eq('req', out.a.req, 3),
        eq('prompt', out.a.prompt, 18),
        eq('completion', out.a.completion, 20),
        eq('total', out.a.total, 38),
        eq('quota', out.a.quota, 180),
      ];
    },
  },

  {
    id: 'F3',
    name: '同秒同签名的 3 条（rokey 未含 id）',
    cfg: (port) => baseCfg(port),
    seed: `__T.seedRaw([__T.row(${NOW - 5000}, 1, 7, 't7', 'gpt-4o', 1, 1, 10)], { newest: ${NOW - 5000}, since: ${NOW - 5000} });`,
    setup() {
      const one = (id) => ({ id, created_at: NOW - 4999, token_id: 7, token_name: 't7', model_name: 'gpt-4o', prompt_tokens: 5, completion_tokens: 5, quota: 50 });
      state.pages.set(1, { total: 3, items: [one(201), one(202), one(203)] });
    },
    run: `(async () => { await __app.refreshUsageDelta(); return { a: __T.agg('24h'), r: __T.raw() }; })()`,
    check(out) {
      return [
        eq('raw.rows（3 条同签名都不能被合并）', out.r.rows, 4),
        eq('req', out.a.req, 4),
        eq('prompt', out.a.prompt, 16),
        eq('completion', out.a.completion, 16),
        eq('quota', out.a.quota, 160),
      ];
    },
  },

  {
    id: 'F4a',
    name: 'RAW_CAP 未触顶（30 行，不得标 capped）',
    cfg: (port) => baseCfg(port),
    seed: `var rows=[]; for (var i=0;i<30;i++) rows.push(__T.row(${NOW - 100} - i, i + 1, 7, 't7', 'gpt-4o', 1, 1, 10)); __T.seedRaw(rows, { coverFrom: ${NOW - DAY}, newest: ${NOW - 100} });`,
    setup() {},
    run: `(async () => { __app.meta(); return { a: __T.agg('24h'), r: __T.raw() }; })()`,
    check(out) {
      return [
        eq('raw.rows', out.r.rows, 30),
        eq('coverFrom 不被改坏', out.r.coverFrom, NOW - DAY),
        eq('capped', out.a.capped, false),
      ];
    },
  },

  {
    id: 'F4b',
    name: 'RAW_CAP 触顶（40100 行 → 截断必须标注并停止重扫）',
    cfg: (port) => baseCfg(port, { prefetch: '1' }),
    settle: 1800,
    seed: `var rows=[]; for (var i=0;i<40100;i++) rows.push(__T.row(${NOW - 10} - i, 500000 + i, 7, 't7', 'gpt-4o', 1, 1, 10)); __T.seedRaw(rows, { newest: ${NOW - 10} });`,
    setup() {},
    run: `(async () => { __app.meta(); await __app.loadUsage('24h'); await __T.sleep(1600); return { a: __T.agg('24h'), r: __T.raw(), pf: __T.pf() }; })()`,
    check(out, ctx) {
      return [
        eq('raw.rows', out.r.rows, 40000),
        eq('coverFrom = 最老保留行 ts', out.r.coverFrom, NOW - 10 - 39999),
        eq('capped 必须为 true', out.a.capped, true),
        eq('prefetch 不得再排下一轮', out.pf.timer, false),
        eq('截断后不得再打 /api/log/（停止重扫）', ctx.mockLog.length, 0),
      ];
    },
  },

  {
    id: 'F5',
    name: '页数上限（总 30000 → 260 页封顶后不得零请求空转）',
    cfg: (port) => baseCfg(port, { maxPages: '80' }),
    slow: true,
    seed: ``,
    setup() {
      state.dynamic = (pg) => {
        const items = [];
        for (let i = 0; i < 100; i++) {
          const n = (pg - 1) * 100 + i;
          if (n >= 30000) break;
          items.push({ id: n + 1, created_at: NOW - 600 - n, token_id: 7, token_name: 't7', model_name: 'gpt-4o', prompt_tokens: 1, completion_tokens: 1, quota: 10 });
        }
        return { items, total: 30000 };
      };
    },
    run: `(async () => { await __app.loadUsage('24h', true); return { a: __T.agg('24h'), r: __T.raw(), pf: __T.pf() }; })()`,
    check(out, ctx) {
      const pages = ctx.mockLog.map((r) => r.p);
      return [
        eq('maxPages 实际生效值（CFG.maxPages=80 被强制抬到 260）', Math.max(...pages), 260),
        eq('raw.rows', out.r.rows, 26000),
        eq('capped 必须为 true', out.a.capped, true),
        eq('触顶后 st.scan 必须收尾（否则 20s 空转）', out.pf.scan, null),
      ];
    },
  },

  {
    id: 'F6',
    name: 'total 字段缺失（不得当作 0 → 不得标记已覆盖）',
    cfg: (port) => baseCfg(port),
    setup() {
      const mk = (base) => Array.from({ length: 100 }, (_, i) => ({
        id: base + i, created_at: NOW - 1000 - (base + i), token_id: 7, token_name: 't7',
        model_name: 'gpt-4o', prompt_tokens: 1, completion_tokens: 1, quota: 10,
      }));
      state.pages.set(1, { items: mk(1) }); // 故意不给 total
      state.pages.set(2, { items: mk(201) });
      state.pages.set(3, { items: [] });
    },
    run: `(async () => { await __app.loadUsage('24h', true); return { a: __T.agg('24h'), r: __T.raw() }; })()`,
    check(out, ctx) {
      const pages = ctx.mockLog.map((r) => r.p);
      return [
        eq('coverFrom 必须保持 null（total 未知 ≠ 已覆盖）', out.r.coverFrom, null),
        eq('必须翻到 p=2', pages.includes(2), true),
        eq('raw.rows', out.r.rows, 200),
      ];
    },
  },

  {
    id: 'F7a',
    name: '单页 500（数据不重复 + 错误必须可见）',
    cfg: (port) => baseCfg(port),
    setup() {
      const mk = (base, n) => Array.from({ length: n }, (_, i) => ({
        id: base + i, created_at: NOW - 1000 - (base + i), token_id: 7, token_name: 't7',
        model_name: 'gpt-4o', prompt_tokens: 1, completion_tokens: 1, quota: 10,
      }));
      state.pages.set(1, { items: mk(1, 100), total: 300 });
      state.pages.set(2, { status: 500, body: { success: false, message: 'boom' } });
      state.pages.set(3, { items: mk(301, 100), total: 300 });
    },
    run: `(async () => { try { await __app.loadUsage('24h', true); } catch (e) {} return { r: __T.raw(), err: __app.state.errors.usage || null }; })()`,
    check(out) {
      return [
        eq('raw.rows 只保留成功页', out.r.rows, 100),
        eq('S.errors.usage 必须被写入', typeof out.err, 'string'),
      ];
    },
  },

  {
    id: 'F7b',
    name: '429 重试后成功',
    cfg: (port) => baseCfg(port),
    slow: true,
    setup() {
      let n = 0;
      state.dynamic = (pg) => {
        if (pg !== 1) return { items: [] };
        n++;
        if (n <= 2) return { status: 429, body: { success: false, message: 'rate limited (429)' } };
        return {
          total: 100,
          items: Array.from({ length: 100 }, (_, i) => ({
            id: i + 1, created_at: NOW - 1000 - i, token_id: 7, token_name: 't7',
            model_name: 'gpt-4o', prompt_tokens: 1, completion_tokens: 1, quota: 10,
          })),
        };
      };
    },
    run: `(async () => { try { await __app.loadUsage('24h', true); } catch (e) {} return { r: __T.raw(), err: __app.state.errors.usage || null }; })()`,
    check(out) {
      return [
        eq('raw.rows', out.r.rows, 100),
        eq('不应留下错误', out.err, null),
      ];
    },
  },

  {
    id: 'F8',
    name: '切换网关（旧网关日志仓必须清掉）',
    cfg: (port) => baseCfg(port),
    seed: `var rows=[]; for (var i=0;i<100;i++) rows.push(__T.row(${NOW - 100} - i, i + 1, 9, 'A-token', 'gpt-4o', 1, 1, 10)); __T.seedRaw(rows, { coverFrom: ${NOW - DAY}, newest: ${NOW - 100} });`,
    setup() {
      state.pages.set(1, {
        total: 2,
        items: [
          { id: 1, created_at: NOW - 50, token_id: 11, token_name: 'B-token', model_name: 'gpt-4o', prompt_tokens: 2, completion_tokens: 2, quota: 20 },
          { id: 2, created_at: NOW - 60, token_id: 11, token_name: 'B-token', model_name: 'gpt-4o', prompt_tokens: 3, completion_tokens: 3, quota: 30 },
        ],
      });
    },
    run: `(async () => { await __app.loadUsage('24h'); return { a: __T.agg('24h'), r: __T.raw() }; })()`,
    check(out, ctx) {
      return [
        eq('不得到旧网关数据上就报"已覆盖"', out.a.req, 2),
        eq('byKey 只应有新网关令牌', out.a.names, ['B-token']),
        eq('必须真的去请求新网关', ctx.mockLog.length > 0, true),
      ];
    },
  },

  {
    id: 'F9',
    name: '翻页竞态（头部插入新行导致 offset 重叠）',
    cfg: (port) => baseCfg(port),
    setup() {
      const ds = Array.from({ length: 150 }, (_, i) => ({
        id: i + 1, created_at: NOW - 200 + i, token_id: 7, token_name: 't7',
        model_name: 'gpt-4o', prompt_tokens: 1, completion_tokens: 1, quota: 10,
      }));
      state.dynamic = (pg) => {
        const part = ds.slice((pg - 1) * 100, pg * 100);
        return { items: part.map((x) => ({ ...x })), total: ds.length };
      };
      let inserted = false;
      state.onRespond = (pg) => {
        if (pg !== 1 || inserted) return;
        inserted = true;
        // p1 响应之后，服务端头部插入 100 条新行 → 后续 offset 分页整体后移，p2 会重放 p1 的内容
        const fresh = [];
        for (let i = 0; i < 100; i++) {
          fresh.push({ id: 1001 + i, created_at: NOW - 300 + i, token_id: 7, token_name: 't7', model_name: 'gpt-4o', prompt_tokens: 1, completion_tokens: 1, quota: 10 });
        }
        ds.unshift(...fresh);
      };
    },
    run: `(async () => { await __app.loadUsage('24h', true); return { a: __T.agg('24h'), r: __T.raw() }; })()`,
    check(out, ctx) {
      const pages = ctx.mockLog.map((r) => r.p);
      return [
        eq('必须继续翻到 p=4（唯一行数不足 total）', pages.includes(4), true),
        eq('coverFrom 不得被标记', out.r.coverFrom, null),
        eq('raw.rows（唯一行数 150）', out.r.rows, 150),
      ];
    },
  },

  {
    id: 'F10',
    name: '20s 缓存（同一 delta 第二次不得发请求）',
    cfg: (port) => baseCfg(port),
    seed: `__T.seedRaw([__T.row(${NOW - 1000}, 1, 7, 't7', 'gpt-4o', 10, 10, 100)], { newest: ${NOW - 1000}, since: ${NOW - 1000} });`,
    setup() {
      state.pages.set(1, {
        total: 1,
        items: [{ id: 1, created_at: NOW - 1000, token_id: 7, token_name: 't7', model_name: 'gpt-4o', prompt_tokens: 10, completion_tokens: 10, quota: 100 }],
      });
    },
    run: `(async () => { await __app.refreshUsageDelta(); const n1 = __app.reqlog(); await __app.refreshUsageDelta(); const n2 = __app.reqlog(); return { n1, n2, r: __T.raw() }; })()`,
    check(out, ctx) {
      return [
        eq('raw.rows', out.r.rows, 1),
        eq('第二次 delta 必须命中 20s 缓存（HTTP 请求数不增加）', ctx.mockLog.length, 1),
      ];
    },
  },

  {
    id: 'F11',
    name: '时间保留（RAW_KEEP_SEC=7d+12h）',
    cfg: (port) => baseCfg(port),
    seed: `var rows=[]; for (var i=0;i<5;i++) rows.push(__T.row(${NOW - 8 * DAY} - i, 100 + i, 7, 't7', 'gpt-4o', 1, 1, 10)); for (var j=0;j<5;j++) rows.push(__T.row(${NOW - 7 * DAY} + 100 - j, 200 + j, 7, 't7', 'gpt-4o', 1, 1, 10)); rows.sort(function(a,b){return b[0]-a[0];}); __T.seedRaw(rows, { newest: ${NOW - 7 * DAY} + 100, coverFrom: ${NOW - 8 * DAY} });`,
    setup() {},
    run: `(async () => { __app.meta(); return { r: __T.raw(), a: __T.agg('7d') }; })()`,
    check(out) {
      return [
        eq('8 天前的行必须被裁掉', out.r.rows, 5),
        eq('coverFrom 抬到保留下界', out.r.coverFrom, NOW - (7 * DAY + 12 * 3600)),
      ];
    },
  },

  {
    id: 'F12',
    name: '升序返回守门（排序后合计与 F1 一致）',
    cfg: (port) => baseCfg(port),
    setup() {
      state.pages.set(1, {
        total: 3,
        items: [
          { id: 3, created_at: NOW - 10800, token_id: 7, token_name: 't7', model_name: 'gpt-4o', prompt_tokens: 10, completion_tokens: 20, quota: 100 },
          { id: 2, created_at: NOW - 7200, token_id: 7, token_name: 't7', model_name: 'gpt-4o', prompt_tokens: 50, completion_tokens: 50, quota: 500 },
          { id: 1, created_at: NOW - 3600, token_id: 7, token_name: 't7', model_name: 'gpt-4o', prompt_tokens: 100, completion_tokens: 200, quota: 1000 },
        ],
      });
    },
    run: `(async () => { await __app.loadUsage('24h', true); return { a: __T.agg('24h'), r: __T.raw() }; })()`,
    check(out) {
      return [
        eq('req', out.a.req, 3),
        eq('quota', out.a.quota, 1600),
        eq('raw.newest 必须是最新一行', out.r.newest, NOW - 3600),
      ];
    },
  },

  {
    id: 'F13',
    name: 'busy 竞态（delta 收尾清掉别人的 busy 标记）',
    cfg: (port) => baseCfg(port),
    seed: `__T.seedRaw([__T.row(${NOW - 1000}, 1, 7, 't7', 'gpt-4o', 10, 10, 100)], { newest: ${NOW - 1000}, since: ${NOW - 1000} });`,
    setup() {
      state.pages.set(1, {
        total: 3,
        delay: 500,
        items: [
          { id: 1, created_at: NOW - 1000, token_id: 7, token_name: 't7', model_name: 'gpt-4o', prompt_tokens: 10, completion_tokens: 10, quota: 100 },
          { id: 5001, created_at: NOW - 800, token_id: 7, token_name: 't7', model_name: 'gpt-4o', prompt_tokens: 1, completion_tokens: 1, quota: 10 },
        ],
      });
    },
    run: `(async () => {
      var p1 = __app.refreshUsageDelta();
      await __T.sleep(60);
      var p2 = __app.loadUsage('24h', true);
      await p1;
      await __T.sleep(80);
      var mid = !!__app.state.busy.usage;
      try { await p2; } catch (e) {}
      await __T.sleep(50);
      return { mid, end: !!__app.state.busy.usage, r: __T.raw(), a: __T.agg('24h') };
    })()`,
    check(out) {
      return [
        eq('delta 收尾时扫描仍在跑 → busy 必须仍为 true', out.mid, true),
        eq('全部结束后 busy 复位', out.end, false),
        eq('raw.rows', out.r.rows, 3),
      ];
    },
  },

  {
    id: 'F14',
    name: 'cacheMem 泄漏（50 次不同 start_timestamp 的 /api/log/ 必须被 LRU 限制）',
    cfg: (port) => baseCfg(port),
    seed: `__T.seedRaw([__T.row(${NOW - 1000}, 1, 7, 't7', 'gpt-4o', 10, 10, 100)], { newest: ${NOW - 1000}, since: ${NOW - 1000} });`,
    setup() {
      // 每页都空：deltaFetch 只发 1 请求就 done
      state.dynamic = () => ({ items: [], total: 0 });
    },
    run: `(async () => {
      for (var i = 0; i < 50; i++) {
        __app.__setNow(${NOW} + i * 60);   // end_timestamp 变化 → cache key 变化
        await __app.refreshUsageDelta();
      }
      var n = __app.cacheSize();
      __app.cacheClear();
      return { n: n, after: __app.cacheSize() };
    })()`,
    check(out) {
      return [
        eq('cacheMem 条目必须被限制（≤20）', out.n <= 20, true),
        eq('cacheClear() 后归零', out.after, 0),
        // 诊断项：必须打印真实条目数，否则泄漏速度无法量化（原写法 typeof 恒真 = 没测）
        { label: '实测条目数（诊断用）：50 次请求 → ' + out.n + ' 条', actual: out.n, expected: '（仅诊断，不计入通过判定）', ok: true },
      ];
    },
  },

  {
    id: 'F7c-js',
    name: 'bridge 永不回调 → JS 必须自己超时、reject 并清干净 pending',
    cfg: (port) => baseCfg(port, { channel: 'native' }),
    // 桩：NativeBridge.http 收下请求后永不回调（模拟 Java 侧丢线程 / 弱网卡死）
    preSeed: `window.NativeBridge = { http: function () { window.__bridge.calls++; } }; window.__bridge = { calls: 0 };`,
    setup() { state.dynamic = () => ({ items: [], total: 0 }); },
    run: `(async () => {
      var p0 = __app.__pending(), mid = -1, err = null;
      var t0 = performance.now();
      var pr = __app.__http('GET', 'http://127.0.0.1:1/api/log/?p=1&page_size=100&type=2', {}, null, 400)
        .then(function () { }, function (e) { err = String((e && e.message) || e); });
      await __T.sleep(60);
      mid = __app.__pending();           // 飞行中：必须多出我这一个 id
      await pr;
      var ms = Math.round(performance.now() - t0);
      return { err: err, ms: ms, p0: p0, mid: mid, pend: __app.__pending(), calls: window.__bridge.calls };
    })()`,
    check(out) {
      return [
        truthy('bridge 必须真的被调用（否则测的不是这条路径）', out.calls >= 1),
        truthy('JS 必须自己 reject（不能永久 pending）', !!out.err && /超时/.test(out.err)),
        truthy('飞行中 pending 必须登记（p0+1）', out.mid >= out.p0 + 1),
        truthy('超时后 pending 必须回到调用前（不泄漏回调）', out.pend <= out.p0),
        eq('超时时间必须贴合传入的 400ms（不得拖到 45s）', out.ms < 1500, true),
      ];
    },
  },
];

/** 明确测不了的：需要改主代码加钩子，或需要 Java/bridge */
const blocked = [
  { id: 'F7c-java', name: 'Java 侧超时/cancel（MainActivity.java:214-215 硬编码）', reason: '10s/45s 硬编码与缺失 cancel(id) 只能 Java 单测或真机验，web 侧不可达（F7c-js 已覆盖 JS 侧超时兜底）' },
];

// ─────────────────────────────────────────── 主流程
async function main() {
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;
  const { proc, port: cdpPort } = await launchChrome();
  const cdp = await connect(cdpPort);

  const results = [];
  const started = Date.now();

  for (const f of fixtures) {
    if (ONLY.length && !ONLY.includes(f.id)) continue;
    mockReset();
    const cfg = f.cfg ? f.cfg(port) : baseCfg(port);
    const t0 = Date.now();
    let checks = [];
    let error = null;
    let page = null;
    try {
      const tOpen = Date.now();
      page = await openPage(cdp, port, cfg, f.preSeed || '');
      const tReady = Date.now();
      // 让 boot 的 refreshAll（打到 gate 态 mock，秒回空）先跑完
      await sleep(f.settle || 350);
      // 清空日志仓「之后」才写入 seed：rawClear 会把 rawStore 置 null，
      // 先 seed 再 clear 会把 seed 一起删掉（上一版基线的 F2 假 PASS 就是这个原因）
      await evaluate(cdp, page.sessionId, '__app.rawClear();\n' + (f.seed || '') + '\ntrue;', false);
      await sleep(60);
      if (f.setup) f.setup(port, page);
      state.gate = false;
      state.log = [];
      const tRun = Date.now();
      const out = await evaluate(cdp, page.sessionId, f.run);
      const tDone = Date.now();
      if (process.env.TD_TIMING) {
        process.stderr.write(`      [timing] open=${tReady - tOpen} settle=${tRun - tReady} run=${tDone - tRun}\n`);
      }
      checks = f.check(out, { mockLog: state.log, port });
    } catch (e) {
      error = e.message || String(e);
    } finally {
      if (page) await cdp.send('Target.closeTarget', { targetId: page.targetId }).catch(() => {});
    }
    const ms = Date.now() - t0;
    const failed = error ? [] : checks.filter((c) => !c.ok);
    results.push({ id: f.id, name: f.name, ok: !error && failed.length === 0, error, checks, ms });
    process.stderr.write(`  ${f.id.padEnd(4)} ${error ? 'ERROR' : failed.length ? 'FAIL' : 'PASS'}  ${f.name} (${ms}ms)\n`);
  }

  proc.kill('SIGKILL');
  server.close();

  // ───────────────── 输出
  const lines = [];
  const push = (s = '') => lines.push(s);

  const hash = readFileSync(path.join(ASSETS, 'app.js'));
  const sha = (await import('node:crypto')).createHash('sha256').update(hash).digest('hex').slice(0, 16);
  const appLines = hash.toString('utf8').split('\n').length;

  push('=== token-desk P0-0 baseline (harness: public/test/run.mjs) ===');
  push(`生成时间   : ${new Date().toISOString()}`);
  push(`被测对象   : public/app/assets/app.js  sha256:${sha}…  ${appLines} 行  ${hash.length} 字节`);
  push(`时钟       : 冻结 NOW=${NOW} (${new Date(NOW * 1000).toISOString()})`);
  push(`浏览器     : ${process.env.CHROME || 'google-chrome'} (headless=new, CDP)`);
  push(`用例       : ${results.length} 条执行 / ${blocked.length} 条 blocked / 总耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
  push('');
  push('说明：断言写的是"P0-1/P0-2 修好之后"的期望值，所以当前 FAIL = 待修，PASS = 现状即正确（防回归）。');
  push('');

  for (const r of results) {
    push(`── ${r.id} ${r.name}  [${r.error ? 'ERROR' : r.checks.every((c) => c.ok) ? 'PASS' : 'FAIL'}]  ${r.ms}ms`);
    if (r.error) {
      push(`   ERROR: ${r.error}`);
    } else {
      for (const c of r.checks) {
        push(`   ${c.ok ? '✓' : '✗'} ${c.label}`);
        if (!c.ok) {
          push(`       expected: ${JSON.stringify(c.expected)}`);
          push(`       actual  : ${JSON.stringify(c.actual)}`);
        }
      }
    }
    push('');
  }

  push('── BLOCKED（本轮测不了，需要主代码加钩子或换 Java 单测）');
  for (const b of blocked) push(`   ${b.id} ${b.name}\n       ${b.reason}`);
  push('');

  const pass = results.filter((r) => r.ok).length;
  const fail = results.filter((r) => !r.ok && !r.error).length;
  const err = results.filter((r) => r.error).length;
  push(`SUMMARY: ${pass} pass / ${fail} fail / ${err} error / ${blocked.length} blocked`);
  push('');
  push('红用例清单：' + (results.filter((r) => !r.ok).map((r) => r.id).join(', ') || '（无）'));

  const text = lines.join('\n');
  const outFile = path.join(HERE, 'baseline-before.txt');
  writeFileSync(outFile, text + '\n');
  console.log('\n' + text);
  console.log(`\n[written] ${path.relative(process.cwd(), outFile)}`);
  if (EMIT_JSON) writeFileSync(path.join(HERE, 'baseline-before.json'), JSON.stringify({ NOW, sha, results, blocked }, null, 2));

  process.exitCode = err ? 2 : 0;
}

main().catch((e) => {
  console.error('harness 崩了：', e);
  process.exit(1);
});

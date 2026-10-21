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
 *   # 互斥锁：已有实例在跑时，后启动的直接退出（exit 2），防止并发跑污染时序敏感用例
 *
 * 依赖：node >= 20（用内置 WebSocket）、本机 google-chrome。无 npm 依赖。
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, openSync, closeSync, writeSync, statSync } from 'node:fs';
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
/** 输出文件名（默认 baseline-before，修完一个补丁用 --out=p0-1-f2 留证据） */
const OUT = (argv.find((a) => a.startsWith('--out=')) || '').slice(6).replace(/\.(txt|json)$/, '');
/** --out 的相对名基准是 test/（HERE），不是 CWD。
 *  所以 `--out=test/.run/x` 会落到 test/test/.run/x：跑满 50s+ 全绿之后才在最后一步 writeFileSync ENOENT、
 *  exit 1，白烧一轮还容易让人以为是用例失败。开局就先把目录查掉。 */
const resolveOut = (n) => (path.isAbsolute(n) ? n : path.join(HERE, n));
function checkOutDir() {
  const name = OUT || 'baseline-before';
  const dir = path.dirname(resolveOut(name + '.txt'));
  if (existsSync(dir)) return;
  console.error('[harness] --out 的目标目录不存在：' + dir);
  console.error('  相对名的基准是 test/，不是当前目录。仓库内的 .run/ 要写成 --out=.run/<名字>；');
  console.error('  写别处请给绝对路径（如 --out=<TMPDIR>/td-verify/x）。');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────── 进程级互斥锁
/** F13/F4b 对时序敏感，并发 Chrome 会互抢 CPU 造成 flake，全量/--only 跑都必须串行。
 *  锁文件固定 test/.run/run.lock（已被 .gitignore 忽略）——不放仓库根、不放缓存目录：
 *  放缓存目录会让独立副本的 A/B 串行实验互相顶死，CI 上也会写到 runner 家目录。
 *  实现：'wx' 独占创建（原子）并写入 pid；抢不到锁先判失效——
 *    持有进程活着且锁龄 < 30min → stderr 报占用并 exit 2；
 *    pid 已死，或锁龄 > 30min（pid 复用会把死进程误判成活）→ 接管并警告。
 *  释放：正常退出 / 异常 / SIGINT / SIGTERM 都要 unlink（只挂 'exit' 覆盖不到信号默认终止路径）。 */
const LOCK_DIR = path.join(HERE, '.run');
const LOCK_PATH = path.join(LOCK_DIR, 'run.lock');
const LOCK_STALE_MS = 30 * 60 * 1000;
let lockReleased = false;

function createLock() {
  const fd = openSync(LOCK_PATH, 'wx'); // 原子：文件已存在 → EEXIST
  writeSync(fd, String(process.pid));
  closeSync(fd);
}

function pidAlive(pid) {
  if (!(pid > 0)) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function releaseLock() {
  if (lockReleased) return;
  lockReleased = true;
  try { rmSync(LOCK_PATH, { force: true }); } catch (e) {}
}

function acquireLock() {
  mkdirSync(LOCK_DIR, { recursive: true }); // 取锁早于任何建目录动作，不建会 openSync ENOENT
  try {
    createLock();
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let raw = '';
    try { raw = readFileSync(LOCK_PATH, 'utf8').trim(); } catch (e2) {}
    let ageMs = Infinity;
    try { ageMs = Date.now() - statSync(LOCK_PATH).mtimeMs; } catch (e2) {}
    const pid = Number(raw) || 0;
    if (pidAlive(pid) && ageMs < LOCK_STALE_MS) {
      console.error(`[harness] 另一轮 harness 正在跑（pid=${pid}），本次退出（exit 2）。时序敏感用例禁止并发。`);
      process.exit(2);
    }
    console.error(`[harness] 接管失效锁 ${LOCK_PATH}：pid=${pid} 锁龄 ${Math.round(ageMs / 1000)}s（持有进程已退出或锁超 30min）`);
    try { rmSync(LOCK_PATH, { force: true }); } catch (e3) {}
    createLock();
  }
  process.on('exit', releaseLock);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { releaseLock(); process.exit(sig === 'SIGINT' ? 130 : 143); });
  }
}

/** 跨副本预检：锁是仓内路径，两份独立副本各锁各的、互不互斥，但 Chrome 仍会抢 CPU
 *  把 F13/F4b 这类时序用例拖成 flake。取锁之后再扫一遍 /proc 找同类 harness。
 *  判据只能用 argv：argv[0] basename 是 node/nodejs，且某个参数以 test/run.mjs 结尾。
 *  不能用 `pgrep -af 'node .*test/run.mjs'`——调用方的 shell wrapper 命令行里就含这串字，
 *  会把自己命中也算进来（实测把 pid 461198 的 bash 判成 harness）。 */
function findOtherHarness() {
  let names;
  try { names = readdirSync('/proc'); } catch (e) { return 0; }  // 非 Linux 直接跳过，不拦路
  const self = process.pid, parent = process.ppid;
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === self || pid === parent) continue;   // 排除自己与调用方 shell
    let raw = '';
    try { raw = readFileSync(`/proc/${name}/cmdline`, 'utf8'); } catch (e) { continue; }  // 权限/已退出
    if (!raw) continue;
    const av = raw.split('\0').filter(Boolean);
    if (av.length < 2) continue;
    const exe = path.basename(av[0]);
    if (exe !== 'node' && exe !== 'nodejs') continue;
    if (!av.slice(1).some((a) => a.endsWith('test/run.mjs'))) continue;
    return pid;
  }
  return 0;
}

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
    // 日志仓自 v3 起带网关指纹 base：缺指纹的仓来源不可验证，app 会整仓作废。
    // 所以种子默认按「当前网关」打指纹；要模拟升级前的老仓（无 base），传 base: null。
    seedRaw: (rows, extra) => {
      const st = Object.assign({ at: 0, since: 0, newest: 0, pages: 0, complete: false, rows: rows }, extra || {});
      if (!('base' in st)) st.base = __app.gatewayBase();
      else if (st.base === null) delete st.base;
      localStorage.setItem(__app.rawKey(), JSON.stringify(st));
    },
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
    // 模拟升级前的 v3 老仓：有行有 coverFrom，但没有网关指纹 base。
    // 真实升级场景走的就是这条「缺失」分支，所以这里不补 base（补了就只剩「网关不同」那条分支）
    seed: `var rows=[]; for (var i=0;i<100;i++) rows.push(__T.row(${NOW - 100} - i, i + 1, 9, 'A-token', 'gpt-4o', 1, 1, 10)); __T.seedRaw(rows, { base: null, coverFrom: ${NOW - DAY}, newest: ${NOW - 100} });`,
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
    id: 'F8b',
    name: '日常切换网关（仓里带的是旧网关指纹 → 同样必须整仓作废）',
    cfg: (port) => baseCfg(port),
    // F8 只覆盖「升级前老仓没有 base」的缺失分支。升级之后所有日常切换走的
    // 都是这条「base 存在但与当前网关不等」的分支，两条分支必须有各自常驻用例，
    // 否则 base !== cur 那条路径只有一次性副本探针做证，没有回归守门。
    seed: `var rows=[]; for (var i=0;i<100;i++) rows.push(__T.row(${NOW - 100} - i, i + 1, 9, 'A-token', 'gpt-4o', 1, 1, 10)); __T.seedRaw(rows, { base: 'http://127.0.0.1:9/old-gw', coverFrom: ${NOW - DAY}, newest: ${NOW - 100} });`,
    setup() {
      state.pages.set(1, {
        total: 2,
        items: [
          { id: 1, created_at: NOW - 50, token_id: 11, token_name: 'B-token', model_name: 'gpt-4o', prompt_tokens: 2, completion_tokens: 2, quota: 20 },
          { id: 2, created_at: NOW - 60, token_id: 11, token_name: 'B-token', model_name: 'gpt-4o', prompt_tokens: 3, completion_tokens: 3, quota: 30 },
        ],
      });
    },
    run: `(async () => {
      var before = {};
      try { before = JSON.parse(localStorage.getItem(__app.rawKey()) || '{}'); } catch (e) {}
      await __app.loadUsage('24h');
      return { sb: before.base || null, a: __T.agg('24h'), r: __T.raw() };
    })()`,
    check(out, ctx) {
      return [
        // fixture 自检：种子必须真的落进异网关指纹。若哪天 seedRaw 改成无条件覆盖 base，
        // 本用例会静默退化成 F8 的缺失分支，这里先把它按住
        eq('种子仓必须带异网关指纹', out.sb, 'http://127.0.0.1:9/old-gw'),
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
      var u0 = __app.state.usageRun || 0;
      var p1 = __app.refreshUsageDelta();
      await __T.sleep(60);
      var p2 = __app.loadUsage('24h', true);
      await p1;
      await __T.sleep(80);
      var mid = !!__app.state.busy.usage;
      try { await p2; } catch (e) {}
      await __T.sleep(50);
      return { mid, end: !!__app.state.busy.usage, r: __T.raw(), a: __T.agg('24h'), du: (__app.state.usageRun || 0) - u0 };
    })()`,
    check(out) {
      return [
        eq('delta 收尾时扫描仍在跑 → busy 必须仍为 true', out.mid, true),
        eq('全部结束后 busy 复位', out.end, false),
        // 原期望 3 是把 seed 的 id=1 与 mock p1 的 id=1 当两行算，实为同一请求，去重后 = seed + id=5001 = 2
        eq('raw.rows', out.r.rows, 2),
        // 补偿断言：光看行数会被去重掩盖，新行必须真的落库（newest 前移到 mock 的 NOW-800）
        eq('新行必须落库（newest 前移）', out.r.newest, NOW - 800),
        // 真正卡「两轮 delta 并发」：并发时必须共享同一轮，usageRun 只该 +1
        eq('usageRun 前后差（并发 delta 必须共享一轮）', out.du, 1),
      ];
    },
  },

  {
    id: 'F13b',
    name: '并发双 delta（两轮同时在飞必须共享，usageRun 只 +1、行不得重复拼接）',
    cfg: (port) => baseCfg(port),
    // F13 的 du==1 是改前改后都成立的守门断言（该 fixture 只发一轮 delta）；
    // 真正让「共享同一轮」可证伪的是本用例：两轮同时发起，若 deltaP 复用被去掉，
    // usageRun 会 +2、p=1 会被请求两次、两次 acc.concat(st.rows) 会把同一行拼两遍。
    seed: `__T.seedRaw([__T.row(${NOW - 1000}, 1, 7, 't7', 'gpt-4o', 10, 10, 100)], { newest: ${NOW - 1000}, since: ${NOW - 1000} });`,
    setup() {
      state.pages.set(1, {
        total: 2,
        delay: 300,
        items: [
          { id: 1, created_at: NOW - 1000, token_id: 7, token_name: 't7', model_name: 'gpt-4o', prompt_tokens: 10, completion_tokens: 10, quota: 100 },
          { id: 5001, created_at: NOW - 800, token_id: 7, token_name: 't7', model_name: 'gpt-4o', prompt_tokens: 1, completion_tokens: 1, quota: 10 },
        ],
      });
    },
    run: `(async () => {
      var u0 = __app.state.usageRun || 0;
      var p1 = __app.refreshUsageDelta();
      var p2 = __app.refreshUsageDelta();
      await Promise.all([p1, p2]);
      await __T.sleep(80);
      return { du: (__app.state.usageRun || 0) - u0, r: __T.raw(), a: __T.agg('24h') };
    })()`,
    check(out, ctx) {
      return [
        eq('usageRun 只该 +1（并发必须共享同一轮）', out.du, 1),
        eq('p=1 只该被请求一次', ctx.mockLog.filter((r) => r.p === 1).length, 1),
        eq('raw.rows 不得被重复拼接（seed 1 + 新增 1）', out.r.rows, 2),
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
    id: 'F15',
    name: '凭证通道（无桥 → 4 键回退明文；首次 rawLoad 时网关必须已就绪）',
    cfg: (port) => baseCfg(port),
    // 浏览器里没有 NativeBridge：四条敏感键必须回退 localStorage，否则桌面浏览器上配置会凭空丢；
    // 同时把 Wave B 的硬要求钉进断言——CFG.newapiBase 必须在任何 rawLoad() 之前就绪，
    // 否则启动期 rawBase() 拿到 ''，每次冷启动都判网关不等、整仓清空重扫。
    setup() {
      state.dynamic = () => ({ items: [], total: 0 });
    },
    run: `(async () => {
      var st = __app.secureState();
      var fb = __app.rawFirstBase();
      __app.cfg().newapiBase = 'http://127.0.0.1:9/fake';
      __app.cfg().newapiToken = 'fallback-token';
      __app.saveCfg();
      var o = {};
      try { o = JSON.parse(localStorage.getItem('tokendesk.cfg.v1') || '{}'); } catch (e) {}
      return { avail: st.available, dead: st.dead, keys: st.keys, fb: fb, plainBase: o.newapiBase || null, plainTok: o.newapiToken || null };
    })()`,
    check(out, ctx) {
      return [
        eq('浏览器无原生桥 → secureAvailable() 必须为 false', out.avail, false),
        eq('首次 rawLoad 时网关必须已就绪', out.fb, 'http://127.0.0.1:' + ctx.port),
        eq('无桥时 4 个敏感键必须回退明文（不得静默丢配置）', [out.plainBase, out.plainTok], ['http://127.0.0.1:9/fake', 'fallback-token']),
        eq('白名单键集合固定 4 个', out.keys, ['newapiBase', 'newapiToken', 'hubBase', 'hubPass']),
        eq('无桥时不得因回退而标红（回退是正常路径）', out.dead, false),
      ];
    },
  },

  {
    id: 'F16',
    name: 'secureAvailable()=true 但首次 secureSet 被拒 → 必须回退明文并标红',
    cfg: (port) => baseCfg(port),
    // 桩：KeyStore 能 load（available=true），但 secureSet 每次都返 false（真机生成密钥失败的最坏形态）。
    // 规格要求「available=true 之后仍须检查首次 secureSet 返回值」—— 只信 available 就会把令牌
    // 当成已加密、实际什么都没存，重启后配置凭空丢失，且用户看不到任何提示。
    preSeed: `window.NativeBridge = {
      secureAvailable: function () { return true; },
      secureSet: function () { window.__ss = (window.__ss || 0) + 1; return false; },
      secureGet: function () { return null; },
      secureClear: function () { window.__sc = (window.__sc || 0) + 1; }
    }; window.__ss = 0; window.__sc = 0;`,
    setup() { state.dynamic = () => ({ items: [], total: 0 }); },
    run: `(async () => {
      // 注意：boot() 里就调过一次 saveCfg()，所以进到用例时 bridge 已经被试过一次、dead 已置位。
      // 这里测的是「被拒之后」的契约：回退明文 + 标红 + 不再挨个键重试。
      var st0 = __app.secureState();
      var ss0 = window.__ss || 0;
      __app.cfg().newapiToken = 'plain-fallback-token';
      __app.cfg().hubBase = 'http://127.0.0.1:9/hub';
      __app.saveCfg();
      var st = __app.secureState();
      var o = {};
      try { o = JSON.parse(localStorage.getItem('tokendesk.cfg.v1') || '{}'); } catch (e) {}
      return { avail: st0.available, dead: st.dead, err: st.err, ss: window.__ss || 0, ss0: ss0,
               plainTok: o.newapiToken || null, plainHub: o.hubBase || null };
    })()`,
    check(out) {
      return [
        eq('桩必须让 secureAvailable() 为 true（否则测的不是这条路径）', out.avail, true),
        eq('secureSet 被拒后必须置 dead（此后一律回退明文）', out.dead, true),
        eq('必须把失败原因留给设置页标红（不得静默回退）', typeof out.err === 'string' && out.err.length > 0, true),
        eq('回退后令牌必须落明文（配置不许丢）', out.plainTok, 'plain-fallback-token'),
        eq('回退后其余敏感键也必须落明文', out.plainHub, 'http://127.0.0.1:9/hub'),
        eq('dead 之后再存配置不得再碰 bridge（不反复重试）', out.ss - out.ss0, 0),
        eq('整个开机过程 bridge 最多被试一次（4 键不许逐个试）', out.ss <= 1, true),
      ];
    },
  },

  {
    id: 'F17a',
    name: '壳内老配置一次性迁移：browser → native',
    cfg: (port) => baseCfg(port),   // baseCfg 默认 channel:'browser'，正好是老版本默认值
    // Wave B 关掉 file:// 万能跨源后，壳内「浏览器内核直连」对内网网关必然 CORS 失败；
    // 老版本默认 channel='browser'，这些用户升级后一开机全红，须一次性迁移。
    // 桩只有 bridge 对象、没有 secure API → secureAvailable()=false，走明文回退，与本例无关。
    preSeed: `window.NativeBridge = {};`,
    setup() { state.dynamic = () => ({ items: [], total: 0 }); },
    run: `(async () => {
      var ls = {};
      try { ls = JSON.parse(localStorage.getItem('tokendesk.cfg.v1') || '{}'); } catch (e) {}
      return { ch: __app.cfg().channel, lsCh: ls.channel || null, mig: localStorage.getItem('tokendesk.chanmig.v1') };
    })()`,
    check(out) {
      return [
        eq('壳内老配置 browser 必须迁成 native', out.ch, 'native'),
        eq('localStorage 里的 channel 也必须已翻成 native（不只是内存值）', out.lsCh, 'native'),
        eq('迁移 marker 必须落位（保证只迁一次）', out.mig, '1'),
      ];
    },
  },

  {
    id: 'F17b',
    name: '迁移只做一次：marker 已在 → 用户手动改回的 browser 必须保留',
    cfg: (port) => baseCfg(port),
    // 反方向保护：迁移若每次启动都跑，用户明确切回「浏览器内核直连」会被静默改掉，
    // 等于永远无法使用该通道（即使服务端返回了 CORS 头）。
    preSeed: `window.NativeBridge = {}; try { localStorage.setItem('tokendesk.chanmig.v1', '1'); } catch (e) {}`,
    setup() { state.dynamic = () => ({ items: [], total: 0 }); },
    run: `(async () => {
      var ls = {};
      try { ls = JSON.parse(localStorage.getItem('tokendesk.cfg.v1') || '{}'); } catch (e) {}
      return { ch: __app.cfg().channel, lsCh: ls.channel || null, mig: localStorage.getItem('tokendesk.chanmig.v1') };
    })()`,
    check(out) {
      return [
        eq('已迁移过就不再动 browser（用户显式选择必须保留）', out.ch, 'browser'),
        eq('localStorage 里的 channel 也保持 browser', out.lsCh, 'browser'),
        eq('marker 保持为 1', out.mig, '1'),
      ];
    },
  },

  {
    id: 'F19',
    name: '壳内 https + 原生：boot 不得回落「自动」，冲突卡只推内网地址',
    // 壳内是 file:// 页面，本版本已关掉万能跨源：https 用户一旦回落 auto 就落到
    // 「浏览器内核直连」，对内网/未开 CORS 的网关必失败（表现为全红）。所以壳内保持原生，
    // 由冲突卡如实告知「改用内网地址 / 服务端开 CORS」，而不是把人推去一个必死通道。
    cfg: (port) => baseCfg(port, { newapiBase: 'https://gw.example.com', channel: 'native' }),
    preSeed: `window.NativeBridge = {};`,
    setup() { state.dynamic = () => ({ items: [], total: 0 }); },
    run: `(async () => {
      var ch0 = __app.cfg().channel;
      // 源码里的预设是 __PRESET_*__ 占位（正式包由 build.sh 注入），测试手工注入才进得去按钮分支
      var lan = 'http://127.0.0.1:' + location.port + '/lan';
      __app.presets().lan.newapiBase = lan;
      __app.presets().lan.hubBase = '';
      __app.state.hubToken = 'keep-me';
      __app.showTab('settings');
      var el = document.querySelector('[data-view="settings"]');
      var txt = el ? el.textContent : '';
      var btn = document.getElementById('f-fixconf');
      var btnText = btn ? btn.textContent : null;
      if (btn) btn.click();
      return { ch0: ch0, txt: txt, btnText: btnText, lan: lan,
               ch1: __app.cfg().channel, base1: __app.cfg().newapiBase, hubTok: __app.state.hubToken };
    })()`,
    check(out) {
      return [
        eq('壳内 boot 不得把 https+原生 回落成「自动」', out.ch0, 'native'),
        eq('冲突卡必须说清壳内已关跨源（不能一句「改成自动」了事）', out.txt.indexOf('本版本壳内已关闭跨源访问') >= 0, true),
        eq('壳内冲突卡不得出现「一键改成「自动」」', out.txt.indexOf('一键改成「自动」') >= 0, false),
        eq('壳内按钮文案必须是「改用内网地址」', out.btnText, '改用内网地址'),
        eq('点按钮后通道仍是 native（绝不写 auto）', out.ch1, 'native'),
        eq('点按钮后地址换成内网预设', out.base1, out.lan),
        eq('换了网关 → hubToken 必须清掉（面板令牌绑定网关）', out.hubTok, ''),
      ];
    },
  },

  {
    id: 'F19b',
    name: '网页版（无桥）https + 原生：仍回落「自动」，壳内例外不得外溢',
    cfg: (port) => baseCfg(port, { newapiBase: 'https://gw.example.com', channel: 'native' }),
    setup() { state.dynamic = () => ({ items: [], total: 0 }); },
    run: `(async () => {
      var ls = {};
      try { ls = JSON.parse(localStorage.getItem('tokendesk.cfg.v1') || '{}'); } catch (e) {}
      __app.showTab('settings');
      return { bridge: !!window.NativeBridge, ch: __app.cfg().channel, lsCh: ls.channel || null,
               fix: !!document.getElementById('f-fixconf') };
    })()`,
    check(out) {
      return [
        eq('测试前提：网页版没有 NativeBridge', out.bridge, false),
        eq('网页版保持原行为：boot 把 https+原生 回落成「自动」', out.ch, 'auto'),
        eq('回落值必须落盘（不能只改内存）', out.lsCh, 'auto'),
        eq('通道已是 auto → 不该再显示冲突卡', out.fix, false),
      ];
    },
  },

  {
    id: 'F19c',
    name: '壳内冲突卡：没换成内网预设时不得清面板令牌',
    // 上一版把 S.hubToken='' 写在 if (gw0 !== newapiBase) 外面：预设恰好等于当前地址时
    // 网关一行没变，却把面板令牌清掉，用户白白重输一次密码。令牌绑定在网关上，只有换网关才该清。
    cfg: (port) => baseCfg(port, { newapiBase: 'https://lan.example.com', channel: 'native' }),
    preSeed: `window.NativeBridge = {};`,
    setup() { state.dynamic = () => ({ items: [], total: 0 }); },
    run: `(async () => {
      __app.presets().lan.newapiBase = 'https://lan.example.com';   // 与当前地址相同 → 点了等于没换网关
      __app.presets().lan.hubBase = '';
      __app.showTab('settings');
      var btn = document.getElementById('f-fixconf');
      var hasBtn = !!btn;
      __app.state.hubToken = 'keep-me';
      if (btn) btn.click();
      return { hasBtn: hasBtn, hubTok: __app.state.hubToken,
               ch: __app.cfg().channel, base: __app.cfg().newapiBase };
    })()`,
    check(out) {
      return [
        eq('测试前提：预设就绪时冲突卡必须有按钮', out.hasBtn, true),
        eq('网关没变 → hubToken 必须保留（上一版的 bug）', out.hubTok, 'keep-me'),
        eq('通道仍是 native', out.ch, 'native'),
        eq('地址不变', out.base, 'https://lan.example.com'),
      ];
    },
  },

  {
    id: 'F20',
    name: '错误卡片：壳内「浏览器内核直连失败」必须给「切回原生请求」一键退路',
    // 壳内 file:// 页面关了万能跨源之后，浏览器内核通道失败的真正原因是服务端没回 CORS 头，
    // 文案里已经说清楚了，但用户没有出口：这里给一键切回原生请求，且只切通道、不许清面板令牌。
    // 网页版（无桥）没有原生请求可切，按钮必须不出现。
    cfg: (port) => baseCfg(port, { channel: 'browser' }),
    preSeed: `window.NativeBridge = {};`,
    setup() { state.dynamic = () => ({ items: [], total: 0 }); },
    run: `(async () => {
      var MSG = '浏览器内核直连失败：Failed to fetch（该通道要求服务端返回 CORS 头）';
      function render(msg, ch) {
        __app.cfg().channel = ch;
        __app.state.errors.overview = msg;
        __app.showTab('overview');
        var b = document.querySelector('[data-err="native"]');
        return { has: !!b, text: b ? b.textContent : null,
                 retry: !!document.querySelector('[data-err="retry"]'),
                 settings: !!document.querySelector('[data-err="settings"]') };
      }
      var r1 = render(MSG, 'browser');                       // 壳内 + 直连失败 → 必须有
      var btn = document.querySelector('[data-err="native"]');
      __app.state.hubToken = 'keep-me';
      if (btn) btn.click();                                  // 点它
      var ch1 = __app.cfg().channel, hub1 = __app.state.hubToken;
      var ls1 = {};
      try { ls1 = JSON.parse(localStorage.getItem('tokendesk.cfg.v1') || '{}'); } catch (e) {}
      var r2 = render(MSG, 'native');                        // 已是原生 → 不该再出现
      var r3 = render('普通错误：令牌无效', 'browser');       // 壳内但非直连失败 → 不该出现
      delete window.NativeBridge;                            // 网页版：没有原生请求可切
      var r4 = render(MSG, 'browser');
      return { r1: r1, ch1: ch1, hub1: hub1, lsCh: ls1.channel || null,
               r2: r2, r3: r3, r4: r4 };
    })()`,
    check(out) {
      return [
        eq('壳内 + 直连失败 → 必须出现退回按钮', out.r1.has, true),
        eq('按钮文案', out.r1.text, '切回原生请求'),
        eq('原有「重试」「去设置」不得被挤掉', [out.r1.retry, out.r1.settings], [true, true]),
        eq('点一下切到原生请求', out.ch1, 'native'),
        eq('通道切换必须落盘', out.lsCh, 'native'),
        eq('只切通道、网关没变 → 面板令牌不得被清', out.hub1, 'keep-me'),
        eq('已是原生请求时不再显示该按钮（没有可切的东西）', out.r2.has, false),
        eq('错误文案不含「直连失败」时不得出现（不冒充退路）', out.r3.has, false),
        eq('网页版（无桥）不显示该按钮', out.r4.has, false),
      ];
    },
  },

  {
    id: 'F21',
    name: '启动清老日志仓 tokendesk.rawlog.v1（v3 不许被牵连）',
    // v1 是升级前遗留在 localStorage 里的裸行数组（真机上 653KB），v3 起已无任何代码读它，
    // 但验收项「旧 localStorage 键必须已清空」正是这一条：不清就永远是红的。
    // seed 必须在 app.js 之前写入（preSeed），才能测到「启动时」这一步。
    cfg: (port) => baseCfg(port),
    preSeed: `window.NativeBridge = {};
      try {
        localStorage.setItem('tokendesk.rawlog.v1', JSON.stringify({ rows: new Array(500).join('x') }));
        localStorage.setItem('tokendesk.rawlog.v2', '{"rows":[]}');
      } catch (e) {}`,
    setup() { state.dynamic = () => ({ items: [], total: 0 }); },
    run: `(async () => {
      var keys = [];
      try { for (var i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i)); } catch (e) {}
      var r = __app.raw();
      return { v1: localStorage.getItem('tokendesk.rawlog.v1'),
               v2: localStorage.getItem('tokendesk.rawlog.v2'),
               rawKey: __app.rawKey(), cfgAlive: !!localStorage.getItem('tokendesk.cfg.v1'),
               rows: r.rows, keys: keys.sort() };
    })()`,
    check(out) {
      return [
        eq('启动后 tokendesk.rawlog.v1 必须不存在', out.v1, null),
        eq('v1 清理不得把 v3 的键改掉（RAW_KEY 仍是 v3）', out.rawKey, 'tokendesk.rawlog.v3'),
        eq('v2 老键也仍然照旧被清（原有行为不许回退）', out.v2, null),
        eq('清理不得波及配置键', out.cfgAlive, true),
        eq('清理之后日志仓仍然可读（rows 数值正常）', typeof out.rows, 'number'),
        eq('localStorage 里不得再出现 v1 键名', out.keys.filter(function (k) { return k === 'tokendesk.rawlog.v1'; }).length, 0),
      ];
    },
  },

  {
    id: 'F22',
    name: '账号签到状态：以 hub 的 lastCheckin 真实记录为准（快照漂移不得误报未签到）',
    // 事故现场：hub 在 08:36:48 统一签到，但 credits.checkin.today_checked_in 只是各账号
    // 「拉积分那一刻」的快照（昨天 20:46 / 今天 05:10 / 06:40 …）。快照早于签到的账号一律
    // 显示「未签到」，面板（读 lastCheckin）却是全绿 —— 用户看到的就是「只有一个号签到了」。
    // 判定必须回到 lastCheckin：今天 → 已签到；不是今天 → 未签到；缺失才回落到快照逻辑。
    cfg: (port) => baseCfg(port),
    preSeed: `window.NativeBridge = {};`,
    setup() { state.dynamic = () => ({ items: [], total: 0 }); },
    run: `(async () => {
      function p2(n) { return n < 10 ? '0' + n : '' + n; }
      function dayOf(ts) { var d = new Date(ts); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); }
      var TODAY = dayOf(Date.now());                 // 由冻结时钟推出，不写死日期
      var YEST = dayOf(Date.now() - 86400000);
      function acc(uid, lastCheckin, ck) {
        return { uid: uid, realm: 'cn', enabled: true, nickname: uid,
                 lastCheckin: lastCheckin, credits: ck === null ? null : { checkin: ck } };
      }
      // A: 真实记录是今天，快照（旧）说未签到 → 必须「已签到」（事故原形）
      // B: 快照说已签到，真实记录是昨天 → 必须「未签到」（不许把旧快照当真）
      // C: 没有 lastCheckin（intl 号无签到功能）→ 回落快照逻辑，必须「无签到」
      __app.state.wb = {
        accounts: { accounts: [
          acc('u-today', TODAY + ' 08:36:48', { active: true, today_checked_in: false }),
          acc('u-yest', YEST + ' 08:36:48', { active: true, today_checked_in: true }),
          acc('u-none', null, null),
        ] },
        health: { ok: true, accounts: 3, accounts_ready: 3 },
      };
      __app.showTab('wb');
      var el = document.querySelector('[data-view="wb"]');
      var rows = [].slice.call(el ? el.querySelectorAll('.acc') : []).map(function (r) {
        var n = r.querySelector('.name'), m = r.querySelector('.meta');
        var sp = m ? m.querySelector('span[title]') : null;
        return { name: n ? n.textContent : '', meta: m ? m.textContent : '',
                 title: sp ? sp.getAttribute('title') : null };
      });
      function pick(uid) {
        for (var i = 0; i < rows.length; i++) if (rows[i].name.indexOf(uid) >= 0) return rows[i];
        return { name: '(missing)', meta: '', title: null };
      }
      return { n: rows.length, today: TODAY, yest: YEST,
               a: pick('u-today'), b: pick('u-yest'), c: pick('u-none') };
    })()`,
    check(out) {
      const tail = (s) => String(s || '').trim().slice(-3);
      return [
        eq('测试前提：三个账号各渲染一行', out.n, 3),
        eq('测试前提：昨天串与今天串不同（冻结时钟推算成功）', out.yest !== out.today, true),
        eq('今天有签到记录 → 已签到（快照说未签到也不算数）', tail(out.a.meta), '已签到'),
        eq('昨天有签到记录 → 未签到（不许被旧快照的 true 顶掉）', tail(out.b.meta), '未签到'),
        eq('没有 lastCheckin → 回落快照逻辑：无签到', tail(out.c.meta), '无签到'),
        eq('已签到那行的 title 必须挂上 lastCheckin 原文', (out.a.title || '').indexOf(out.today + ' 08:36:48') >= 0, true),
        eq('昨天那行的 title 也必须挂原文（方便肉眼核对）', (out.b.title || '').indexOf(out.yest + ' 08:36:48') >= 0, true),
        eq('回落分支也要有 title 说明依据', (out.c.title || '').indexOf('该账号无需签到') >= 0, true),
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
  { id: 'F7c-java', name: 'Java 侧超时/cancel/去重（JVM 单测覆盖，web harness 不执行 Java）', reason: '由 test/java/run-java-test.sh 覆盖：HttpJobRegistry.java:66-139（submit 去重/abort/cancel/cancelAll）+ MainActivity.java:40,171-195（jobs 注入、httpOpts 转发、clampTimeout 按参数回落默认值），实测 21 pass / 0 fail；web 侧只覆盖 JS 超时兜底（F7c-js）' },
];

// ─────────────────────────────────────────── 主流程
async function main() {
  checkOutDir(); // 目录不存在立刻 exit 2，别跑完 50s 才在写文件那一步崩
  acquireLock(); // 先拿锁再起服务/Chrome：抢不到锁直接 exit 2，绝不让两个 harness 并发跑
  // 锁管同仓；跨副本（csp-test/、审查副本）靠 /proc 扫 argv，同样 exit 2 走人
  const other = findOtherHarness();
  if (other) {
    console.error(`[harness] 另一轮 harness 正在跑（pid=${other}），本次退出（exit 2）。时序敏感用例禁止并发。`);
    process.exit(2);
  }
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;
  const { proc, port: cdpPort } = await launchChrome();
  const cdp = await connect(cdpPort);

  const results = [];

  // 首例导航冷启动：本进程第一次 Page.navigate 到真实页面要 25s 左右（Chrome/CDP 网络栈冷启，
  // index.html 本身只有一个本地 style.css，没有任何外链），F1 因此恒 25s+，看起来像用例本身慢。
  // 这里先开一页预热再丢弃，让第一个真用例的导航回到 <2s。只影响耗时，不涉及任何断言/fixture。
  {
    const warm = await openPage(cdp, port, baseCfg(port), '');
    await cdp.send('Target.closeTarget', { targetId: warm.targetId }).catch(() => {});
  }
  const started = Date.now();   // 计时从预热之后开始：总耗时只算真实用例

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
  const outName = OUT || 'baseline-before';
  // 绝对路径必须原样使用：path.join(HERE, '/abs/x') 会拼成 test//abs/x —— resolveOut 已处理
  const outFile = resolveOut(outName + '.txt');
  writeFileSync(outFile, text + '\n');
  console.log('\n' + text);
  console.log(`\n[written] ${path.relative(process.cwd(), outFile)}`);
  if (EMIT_JSON) writeFileSync(resolveOut(outName + '.json'), JSON.stringify({ NOW, sha, results, blocked }, null, 2));

  process.exitCode = err ? 2 : 0;
}

main().catch((e) => {
  console.error('harness 崩了：', e);
  process.exit(1);
});

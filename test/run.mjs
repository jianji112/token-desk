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
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');            // = public/
const ASSETS = path.join(ROOT, 'app', 'assets');
// Chrome profile 属于一次性产物，进系统临时目录，绝不落进仓库。
// 优先用 BH_AGENT_WORKSPACE（CI/沙箱里指向专用缓存），否则用系统临时目录。
const SCRATCH = process.env.BH_AGENT_WORKSPACE || process.env.TMPDIR || os.tmpdir();
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
  hits: [], // 全站请求流水 [{p,t}]（F34 断言「后台零请求」用）
  pages: new Map(), // page -> {items,total?,status?,body?,delay?}
  dynamic: null, // (page, req) => {items,total?} | undefined
  onRespond: null, // (page, req) => void  （用于 F9 在 p1 之后插入新行）
};

function mockReset() {
  state.gate = true;
  state.log = [];
  state.hits = [];
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
  // 全站请求流水（含 hub 的 /panel/login、/usage/recent）：F34 用它证明「切后台真的不发请求」。
  // 只记路径与时间，不参与任何业务分支。
  state.hits.push({ p: p, t: Date.now() });

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
        eq('壳内冲突卡必须给出「改用内网地址」的结论（不能一句「改成自动」了事）', out.txt.indexOf('改用内网地址') >= 0, true),
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
    id: 'F23a',
    name: '版本比较：点分段逐段数字比（1.0.9 < 1.0.10，不许按字符串比）',
    // 版本号一旦按字符串比，1.0.9 会被判成大于 1.0.10，用户永远收不到 1.0.10 的提示 ——
    // 这种错静默、无人报障，只能用纯函数边界钉死。本用例不许产生任何网络请求。
    cfg: (port) => baseCfg(port, { channel: 'native' }),
    preSeed: `window.NativeBridge = { appInfo: function () { return JSON.stringify({ version: '1.0.72', sdk: 34, model: 'test' }); } };
      // 只拦「更新检查」的端点（含真端点 api.github.com，好让漏传 urls 的用例被抓到），
      // 其余请求原样交给真 fetch —— 否则 app 自己的启动加载也被这场 mock 顶掉。
      (function () {
        var real = window.fetch;
        window.__UPDCALLS = [];
        window.fetch = function (u, o) {
          var s = String(u);
          if (s.indexOf('example.invalid') < 0 && s.indexOf('api.github.com') < 0) return real.call(window, u, o);
          window.__UPDCALLS.push(s);
          return Promise.reject(new Error('F23a 不该发请求'));
        };
      })();`,
    setup() { state.dynamic = () => ({ items: [], total: 0 }); },
    run: `(async () => {
      var C = __app.verCmp;
      return {
        a: C('1.0.9', '1.0.10'), b: C('1.0.72', '1.0.73'), c: C('1.0.72', '1.0.72'),
        d: C('1.0.73', '1.0.72'), e: C('1.0', '1.0.0'), f: C('2', '1.9.9'),
        g: C('', '1.0.73'), h: C('v1.0.72', 'v1.0.73'), i: C(null, null),
        fetches: window.__UPDCALLS.length
      };
    })()`,
    check(out) {
      return [
        eq('1.0.9 必须小于 1.0.10（字符串比会判反）', out.a, -1),
        eq('1.0.72 < 1.0.73', out.b, -1),
        eq('同版本必须相等', out.c, 0),
        eq('远端更老 → 本地更新（+1）', out.d, 1),
        eq('1.0 与 1.0.0 视为相等（短的一侧补零）', out.e, 0),
        eq('段数不同也不许错：2 > 1.9.9', out.f, 1),
        eq('一侧取不到数字 → 0（不可比宁可不提示）', out.g, 0),
        eq('带 v 前缀照常比', out.h, -1),
        eq('两侧都空 → 0', out.i, 0),
        eq('纯比较函数不得发出任何网络请求', out.fetches, 0),
      ];
    },
  },

  {
    id: 'F23b',
    name: '更新检查三态 DOM：发现新版本 / 已是最新 / 网络失败静默（不弹错、不进 errbox）',
    // 「只提示不下载」的对外承诺全靠这一条：有新版只多一行字 + 复制地址；
    // 已是最新就明说；失败一律静默回「未检查」，绝不用 errbox 或 err toast 吓人。
    cfg: (port) => baseCfg(port, { channel: 'native' }),
    preSeed: `window.NativeBridge = {
        appInfo: function () { return JSON.stringify({ version: '1.0.72', sdk: 34, model: 'test' }); },
        copy: function (t) { window.__COPIED = t; }
      };
      // 只拦更新检查端点，其余请求放给真 fetch（app 自己的启动加载不受影响）
      (function () {
        var real = window.fetch;
        window.__UPDCALLS = [];
        window.__MODE = 'new';
        window.fetch = function (u, o) {
          var s = String(u);
          if (s.indexOf('example.invalid') < 0 && s.indexOf('api.github.com') < 0) return real.call(window, u, o);
          window.__UPDCALLS.push(s);
          if (window.__MODE === 'fail') return Promise.reject(new Error('net down'));
          var tag = window.__MODE === 'new' ? 'v1.0.73' : 'v1.0.72';
          return Promise.resolve({ ok: true, status: 200, json: function () {
            return Promise.resolve({
              tag_name: tag,
              html_url: 'https://github.com/jianji112/token-desk/releases/tag/' + tag,
              body: '修复签到判定\\n其余细节见提交记录'
            });
          } });
        };
      })();`,
    setup() { state.dynamic = () => ({ items: [], total: 0 }); },
    run: `(async () => {
      __app.showTab('settings');
      var URLS = ['https://example.invalid/releases/latest'];
      // 设置页本来就可能有一条无关的 errbox（例如无 Keystore 的提示），
      // 所以断言的是「更新检查不许再添一条」，而不是「整页零 errbox」。
      var errbox0 = document.querySelectorAll('.errbox').length;
      var toast0 = document.getElementById('toast') ? document.getElementById('toast').className : '';
      function snap() {
        var line = document.getElementById('upd-line');
        var cp = document.getElementById('f-updcopy');
        var note = document.getElementById('upd-note');
        var btn = document.getElementById('f-updcheck');
        var toastEl = document.getElementById('toast');
        return {
          line: line ? line.textContent : null,
          cpShown: cp ? cp.style.display !== 'none' : null,
          note: (note && note.style.display !== 'none') ? note.textContent : '',
          btn: btn ? btn.textContent : null,
          btnDisabled: btn ? !!btn.disabled : null,
          errbox: document.querySelectorAll('.errbox').length,
          toastClass: toastEl ? toastEl.className : null
        };
      }
      window.__MODE = 'new';
      var u1 = await __app.checkUpdate({ force: true, cur: '1.0.72', urls: URLS });
      var st1 = u1.state, tag1 = u1.tag, url1 = u1.url;
      var s1 = snap();
      // 复制按钮走的是 NativeBridge.copy：必须把地址交给剪贴板，不许打开浏览器
      var cpBtn = document.getElementById('f-updcopy');
      if (cpBtn) cpBtn.onclick();
      var copied = window.__COPIED || '';
      window.__MODE = 'latest';
      var u2 = await __app.checkUpdate({ force: true, cur: '1.0.72', urls: URLS });
      var st2 = u2.state;
      var s2 = snap();
      window.__MODE = 'fail';
      var u3 = await __app.checkUpdate({ force: true, cur: '1.0.72', urls: URLS });
      var st3 = u3.state;
      var s3 = snap();
      return { errbox0: errbox0, toast0: toast0,
               st1: st1, tag1: tag1, url1: url1, s1: s1, copied: copied,
               st2: st2, s2: s2, st3: st3, s3: s3, fetches: window.__UPDCALLS.length };
    })()`,
    check(out) {
      return [
        eq('前提：设置页原本没有 errbox（有的话下面「不添一条」的断言就失效）', out.errbox0, 0),
        eq('远端 v1.0.73 → 状态 new', out.st1, 'new'),
        eq('新版 tag 只留数字段（去掉 v 前缀）', out.tag1, '1.0.73'),
        eq('状态里的下载地址是 Release 页面', out.url1, 'https://github.com/jianji112/token-desk/releases/tag/v1.0.73'),
        eq('设置页显示「发现新版本 v1.0.73（当前 1.0.72）」', out.s1.line, '发现新版本 v1.0.73（当前 1.0.72）'),
        eq('有新版才露出「复制下载地址」', out.s1.cpShown, true),
        eq('更新说明只取首行、不整段灌进设置页', out.s1.note, '修复签到判定'),
        eq('复制按钮交出的是 Release 页面地址', out.copied, 'https://github.com/jianji112/token-desk/releases/tag/v1.0.73'),
        eq('有新版不得有 errbox（只提示不报错）', out.s1.errbox, out.errbox0),
        eq('有新版不得出现 err toast', out.s1.toastClass === 'err', false),
        eq('远端 v1.0.72 → 状态 latest', out.st2, 'latest'),
        eq('已是最新时明说当前版本', out.s2.line, '已是最新（v1.0.72）'),
        eq('已是最新时复制按钮收起', out.s2.cpShown, false),
        eq('已是最新时没有说明行', out.s2.note, ''),
        eq('网络失败 → 状态 fail（内部状态，不外显成红字）', out.st3, 'fail'),
        eq('失败回到「未检查」，不显示上一次的结论', out.s3.line, '未检查'),
        eq('失败时按钮恢复可点、文案回到「检查更新」', out.s3.btn, '检查更新'),
        eq('失败时按钮不得停留在禁用态', out.s3.btnDisabled, false),
        eq('网络失败不得弹 errbox', out.s3.errbox, out.errbox0),
        eq('网络失败不得弹 err toast（静默）', out.s3.toastClass === 'err', false),
        eq('三次检查 = 三次请求，别无多发', out.fetches, 3),
      ];
    },
  },

  {
    id: 'F23c',
    name: '同日已查过：自动检查不再发请求（force 手动查仍可绕过）',
    // 预置「今天已查」标记 = 模拟同一天第二次冷启动。GitHub 未认证配额 60 次/小时/IP，
    // 一旦每次冷启都打一次，用户连开几次就把自己 IP 打到 403，之后永远查不到更新。
    cfg: (port) => baseCfg(port, { channel: 'native' }),
    preSeed: `window.NativeBridge = { appInfo: function () { return JSON.stringify({ version: '1.0.72', sdk: 34, model: 'test' }); } };
      (function () {
        var real = window.fetch;
        window.__UPDCALLS = [];
        window.fetch = function (u, o) {
          var s = String(u);
          if (s.indexOf('example.invalid') < 0 && s.indexOf('api.github.com') < 0) return real.call(window, u, o);
          window.__UPDCALLS.push(s);
          return Promise.resolve({ ok: true, status: 200, json: function () {
            return Promise.resolve({ tag_name: 'v1.0.72', html_url: 'https://example.invalid/r', body: '' });
          } });
        };
        // 限频窗口改用 UPD_AT（时间戳，成功失败都记）：预置「6 小时内刚查过」
        localStorage.setItem('tokendesk.updat.v1', String(Date.now()));
      })();`,
    setup() { state.dynamic = () => ({ items: [], total: 0 }); },
    run: `(async () => {
      var URLS = ['https://example.invalid/releases/latest'];
      var u1 = await __app.checkUpdate({ cur: '1.0.72', urls: URLS });   // 未 force：6 小时内查过 → 直接返回
      var st1 = u1.state, n1 = window.__UPDCALLS.length;
      var u2 = await __app.checkUpdate({ force: true, cur: '1.0.72', urls: URLS });  // 手动查绕过标记
      var st2 = u2.state, n2 = window.__UPDCALLS.length;
      await __app.checkUpdate({ cur: '1.0.72', urls: URLS });            // 再自动查一次：仍不请求
      var n3 = window.__UPDCALLS.length;
      return { st1: st1, n1: n1, st2: st2, n2: n2, n3: n3 };
    })()`,
    check(out) {
      return [
        eq('同日已查过 → 自动查不请求', out.n1, 0),
        eq('没查就没结论，状态保持 idle', out.st1, 'idle'),
        eq('手动查（force）必须绕过标记、真的发一次', out.n2, 1),
        eq('force 那次结果仍按真实数据判定（v1.0.72 即最新）', out.st2, 'latest'),
        eq('之后的自动查继续不请求', out.n3, 1),
      ];
    },
  },

  {
    id: 'F23d',
    name: '首次自动查后写「今天」标记；同日第二次不重复；http 页面 autoUpd 不发请求',
    // 两件事：(1) 标记必须真的写下来（否则跨冷启动的节流是假的）；
    // (2) autoUpd 的协议门 —— harness/桌面调试页是 http，桩了 NativeBridge 也不许真连 GitHub，
    // 否则每条用例的冷启动都会打一次外网，测试就不再是离线的。
    cfg: (port) => baseCfg(port, { channel: 'native' }),
    preSeed: `window.NativeBridge = { appInfo: function () { return JSON.stringify({ version: '1.0.72', sdk: 34, model: 'test' }); } };
      (function () {
        var real = window.fetch;
        window.__UPDCALLS = [];
        window.fetch = function (u, o) {
          var s = String(u);
          if (s.indexOf('example.invalid') < 0 && s.indexOf('api.github.com') < 0) return real.call(window, u, o);
          window.__UPDCALLS.push(s);
          return Promise.resolve({ ok: true, status: 200, json: function () {
            return Promise.resolve({ tag_name: 'v1.0.73', html_url: 'https://example.invalid/r', body: 'x' });
          } });
        };
      })();`,
    setup() { state.dynamic = () => ({ items: [], total: 0 }); },
    run: `(async () => {
      var URLS = ['https://example.invalid/releases/latest'];
      var n0 = window.__UPDCALLS.length;
      await __app.checkUpdate({ cur: '1.0.72', urls: URLS });        // 窗口外第一次：查
      var n1 = window.__UPDCALLS.length;
      var mark = localStorage.getItem('tokendesk.updat.v1');        // 限频时间戳（UPD_AT）
      await __app.checkUpdate({ cur: '1.0.72', urls: URLS });        // 6 小时窗口内第二次：不查
      var n2 = window.__UPDCALLS.length;
      await __app.autoUpd();                                          // 启动那次：http 页面 → 协议门
      var n3 = window.__UPDCALLS.length;
      var d = new Date(Date.now());
      function p2(n) { return n < 10 ? '0' + n : '' + n; }
      var today = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
      return { n0: n0, n1: n1, n2: n2, n3: n3, mark: mark, today: today,
               proto: location.protocol };
    })()`,
    check(out) {
      return [
        eq('起手不该有请求（老用例遗留的请求会被这里抓到）', out.n0, 0),
        eq('今天第一次查 → 恰好一次请求', out.n1, 1),
        truthy('限频时间戳必须真的写下来（跨冷启动生效的前提）', !!out.mark && isFinite(Number(out.mark)) && Number(out.mark) > 0),
        eq('同日第二次查 → 不再请求', out.n2, 1),
        eq('harness 是 http 页面：autoUpd 必须被协议门挡住、零请求', out.n3, 1),
        eq('前提确认：本页协议不是 file:', out.proto, 'http:'),
      ];
    },
  },

  {
    id: 'F23e',
    name: '更新检查固定走浏览器内核（不 fallback 原生桥）+ 超时 15s + 多源',
    // 主人 2026-10-21 定：更新检查以后只走浏览器内核。理由：走系统网络栈/代理，可达性由浏览器内核决定，
    // 比原生桥（Java HttpURLConnection，不走系统代理）更符合用户预期。
    // 所以 fetch 失败就是失败，不许偷偷改走原生桥 —— 原生桥可能绕过用户代理，
    // 在受限网络下反而更慢/更不通，且行为与「浏览器内核直连」设置不一致。
    cfg: (port) => baseCfg(port, { channel: 'browser' }),
    preSeed: `window.NativeBridge = {
        appInfo: function () { return JSON.stringify({ version: '1.1.5', sdk: 34, model: 'test' }); },
        http: function (id, method, url) {
          var u = String(url);
          // 只关心「更新检查」这条链：业务请求（127.0.0.1 的日志/token/status）走哪条通道是 channel 配置的事，
          // 与本用例无关，回空页即可，绝不计数。
          if (u.indexOf('api.github.com') < 0 && u.indexOf('example.invalid') < 0) {
            setTimeout(function () {
              window.__nativeHttp(id, JSON.stringify({ status: 200, ms: 1, via: 'native', body: JSON.stringify({ items: [], total: 0 }) }));
            }, 2);
            return;
          }
          window.__NATIVE_CALLS = (window.__NATIVE_CALLS || 0) + 1;
          window.__NATIVE_URLS = (window.__NATIVE_URLS || []).concat([u.slice(0, 70)]);
          setTimeout(function () {
            window.__nativeHttp(id, JSON.stringify({ status: 200, ms: 1, via: 'native', body: JSON.stringify({ items: [], total: 0 }) }));
          }, 2);
        }
      };
      (function () {
        var real = window.fetch;
        window.__FETCH_TRIED = 0;
        window.fetch = function (u, o) {
          var s = String(u);
          if (s.indexOf('example.invalid') < 0 && s.indexOf('api.github.com') < 0) return real.call(window, u, o);
          window.__FETCH_TRIED++;
          if (s.indexOf('api.github.com') >= 0) {
            return Promise.reject(new Error('net::ERR_CONNECTION_TIMED_OUT'));   // 直连源失败
          }
          return Promise.resolve({ ok: true, status: 200, json: function () {    // 镜像源成功
            return Promise.resolve({ tag_name: 'v1.1.9', html_url: 'https://example.invalid/r', body: 'x',
                                     assets: [{ name: 'TokenDesk-1.1.9.apk', browser_download_url: 'https://example.invalid/a.apk' }] });
          } });
        };
      })();`,
    setup() { state.dynamic = () => ({ items: [], total: 0 }); },
    run: `(async () => {
      var URLS = ['https://api.github.com/repos/x/y/releases/latest', 'https://example.invalid/releases/latest'];
      var r = await __app.checkUpdate({ force: true, cur: '1.1.5', urls: URLS });
      return { state: r.state, tag: r.tag, apkUrl: r.apkUrl,
               fetchTried: window.__FETCH_TRIED, nativeCalls: window.__NATIVE_CALLS || 0,
               nativeUrls: window.__NATIVE_URLS || [] };
    })()`,
    check(out) {
      return [
        eq('直连源失败后必须试镜像源（多源兜底）', out.fetchTried, 2),
        eq('更新检查全程不许碰原生桥（固定只走浏览器内核）', out.nativeCalls, 0),
        eq('镜像源兜底后必须拿到结论', out.state, 'new'),
        eq('版本号解析正确', out.tag, 'v1.1.9'.replace('v', '')),
        eq('APK 附件直链解析正确', out.apkUrl, 'https://example.invalid/a.apk'),
      ];
    },
  },

  {
    id: 'F24',
    name: '更新结论落盘：同日重开仍显示上次结论 + 「今天 HH:MM 查过」；跨天/换版本/失败一律作废',
    // 「只查一次」+「结论只在内存」= 用户刚查完、关掉再开就看到「未检查」，像坏了。
    // 落盘必须严格：同一天 + 同一版本 + 结论是 latest/new，三条同时满足才认；否则丢弃。
    // 失败不是结论：checkUpdate 失败时不许写回，也不许把上一次成功结论顶掉。
    cfg: (port) => baseCfg(port, { channel: 'native' }),
    preSeed: `window.NativeBridge = {
        appInfo: function () { return JSON.stringify({ version: '1.0.72', sdk: 34, model: 'test' }); },
        copy: function (t) { window.__COPIED = t; }
      };
      (function () {
        var real = window.fetch;
        window.__UPDCALLS = [];
        window.__MODE = 'latest';
        window.fetch = function (u, o) {
          var s = String(u);
          if (s.indexOf('example.invalid') < 0 && s.indexOf('api.github.com') < 0) return real.call(window, u, o);
          window.__UPDCALLS.push(s);
          if (window.__MODE === 'fail') return Promise.reject(new Error('net down'));
          var tag = window.__MODE === 'new' ? 'v1.0.73' : 'v1.0.72';
          return Promise.resolve({ ok: true, status: 200, json: function () {
            return Promise.resolve({ tag_name: tag, html_url: 'https://example.invalid/tag/' + tag, body: 'x' });
          } });
        };
      })();`,
    setup() { state.dynamic = () => ({ items: [], total: 0 }); },
    run: `(async () => {
      function p2(n) { return n < 10 ? '0' + n : '' + n; }
      function dayOf(ts) { var d = new Date(ts); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); }
      function line() { var e = document.getElementById('upd-line'); return e ? e.textContent : null; }
      function atEl() { var e = document.getElementById('upd-at'); return e ? { text: e.textContent, shown: e.style.display !== 'none' } : null; }
      // 重渲染 = 模拟冷启动后用户点进设置页；restore 必须发生在画 #upd-line 之前
      function rerender() { __app.showTab('usage'); __app.showTab('settings'); }
      var URLS = ['https://example.invalid/releases/latest'];
      var NOWMS = Date.now(), TODAY = dayOf(NOWMS), YEST = dayOf(NOWMS - 86400000);
      var d = new Date(NOWMS), HM = p2(d.getHours()) + ':' + p2(d.getMinutes());

      __app.showTab('settings');
      var line0 = line(), at0 = atEl();

      window.__MODE = 'latest';
      await __app.checkUpdate({ force: true, cur: '1.0.72', urls: URLS });
      var st0 = __app.upd().state, store = __app.updStore();

      __app.updForget();                       // 内存抹平 = 冷启动
      rerender();
      var line1 = line(), at1 = atEl(), st1 = __app.upd().state;

      var o1 = __app.updStore() || {}; o1.day = YEST;   // 跨天：昨天的结论不许冒充今天
      localStorage.setItem('tokendesk.updlast.v1', JSON.stringify(o1));
      __app.updForget();
      rerender();
      var line2 = line(), at2 = atEl(), st2 = __app.upd().state;

      var o2 = __app.updStore() || {}; o2.day = TODAY; o2.cur = '1.0.71';  // 换过版本：旧版本结论作废
      localStorage.setItem('tokendesk.updlast.v1', JSON.stringify(o2));
      __app.updForget();
      rerender();
      var line3 = line(), st3 = __app.upd().state;

      var beforeFail = localStorage.getItem('tokendesk.updlast.v1');
      window.__MODE = 'fail';
      __app.updForget();
      await __app.checkUpdate({ force: true, cur: '1.0.72', urls: URLS });
      var st4 = __app.upd().state;
      var afterFail = localStorage.getItem('tokendesk.updlast.v1');

      return {
        line0: line0, at0: at0, st0: st0, store: store,
        line1: line1, at1: at1, st1: st1,
        line2: line2, at2: at2, st2: st2,
        line3: line3, st3: st3,
        st4: st4, sameAfterFail: beforeFail === afterFail, line4: line(),
        today: TODAY, hm: HM, fetches: window.__UPDCALLS.length
      };
    })()`,
    check(out) {
      return [
        eq('起手：没查过就是「未检查」', out.line0, '未检查'),
        eq('起手：没有结论就没有「查过」时间行', out.at0.shown, false),
        eq('checkUpdate 成功 → latest', out.st0, 'latest'),
        eq('盘上必须有结论（重启才接得上）', !!out.store, true),
        eq('盘上记的是今天', out.store && out.store.day, out.today),
        eq('盘上记的是当前版本', out.store && out.store.cur, '1.0.72'),
        eq('盘上记的结论是 latest', out.store && out.store.state, 'latest'),
        eq('盘上记的时间戳 = 这次检查的时间', out.store && out.store.at, 1761000000 * 1000),
        eq('重开（内存抹平 + 重渲染）后仍显示上次结论', out.line1, '已是最新（v1.0.72）'),
        eq('重开后内存态也是 latest（不是只贴了一段文字）', out.st1, 'latest'),
        eq('「今天 HH:MM 查过」独立一行且真的显示', out.at1.text, '今天 ' + out.hm + ' 查过'),
        eq('时间行确实可见（不是被 display:none 藏住）', out.at1.shown, true),
        eq('跨天的结论一律作废（不拿昨天冒充今天）', out.line2, '未检查'),
        eq('跨天作废后内存态回 idle', out.st2, 'idle'),
        eq('跨天时连时间行也不许留', out.at2.shown, false),
        eq('版本变了的结论作废（1.0.71 的结论不喂给 1.0.72）', out.line3, '未检查'),
        eq('版本不符后内存态回 idle', out.st3, 'idle'),
        eq('网络失败 → 状态 fail', out.st4, 'fail'),
        eq('失败不写回盘上（失败不是结论）', out.sameAfterFail, true),
        eq('失败时结论行回到「未检查」', out.line4, '未检查'),
        eq('一次成功 + 一次失败 = 恰好两次请求', out.fetches, 2),
      ];
    },
  },

  {
    id: 'F25',
    name: '冷却名单以 /accounts 的 modelCooldowns 为准：/usage/remaining 的脏 cooling 行不得显示',
    // 实测脏数据（2026-10-21）：177****9351 / deepseek-v4.1-flash 在 /usage/remaining 里
    // cooling=true、used=0、segment start(08:14) > end(00:09)，而 /accounts 里 modelCooldowns 为空。
    // 显示口径必须回到账号记录：只认真的 modelCooldowns（未过期），冷数/可用数都按它重算。
    cfg: (port) => baseCfg(port, { channel: 'native' }),
    preSeed: `window.NativeBridge = {};`,
    setup() { state.dynamic = () => ({ items: [], total: 0 }); },
    run: `(async () => {
      var NOW = Math.floor(Date.now() / 1000);
      var EXP = NOW + 36000;
      __app.state.wb = {
        at: Date.now(), errors: {},
        accounts: { accounts: [
          { uid: 'u177', nickname: '177****9351', realm: 'cn', modelCooldowns: [] },
          { uid: 'uchen', nickname: '辰', realm: 'cn', modelCooldowns: [{ model: 'deepseek-v4.1-flash', expiresAt: EXP, startedAt: NOW - 600 }] },
          { uid: 'uintl', nickname: 'intl-acct', realm: 'intl', modelCooldowns: [{ model: 'deepseek-v4.1-flash', expiresAt: EXP, startedAt: NOW - 600 }] }
        ] },
        remain: {
          models: [{ realm: 'cn', model: 'deepseek-v4.1-flash', pairs: 4, available: 2, cooling: 2, unknown: 0, total_remaining: 130969454 }],
          rows: [
            { uid: 'u177', nickname: '177****9351', realm: 'cn', model: 'deepseek-v4.1-flash', used: 0, cooling: true, reset_at: EXP },
            { uid: 'uchen', nickname: '辰', realm: 'cn', model: 'deepseek-v4.1-flash', used: 199863195, cooling: true, reset_at: EXP }
          ]
        }
      };
      __app.state.remOpen = {};
      __app.showTab('wb');
      var view = document.querySelector('[data-view="wb"]');
      function rowText() {
        var tr = view.querySelector('tr.rem-row');
        return tr ? tr.textContent.replace(/\\s+/g, ' ').trim() : '';
      }
      var t1 = rowText();
      var tr1 = view.querySelector('tr.rem-row');
      if (tr1) tr1.click();                      // 展开冷却名单
      var det1 = view.querySelector('tr.rem-detail');
      var d1 = det1 ? det1.textContent.replace(/\\s+/g, ' ').trim() : '';

      // ② /accounts 拉失败 → 退回 remain rows，但 used=0 的脏行仍要被剔除
      var bak = __app.state.wb.accounts;
      __app.state.wb.accounts = null;
      __app.state.remOpen = {};
      __app.showTab('wb');
      var t2 = rowText();
      if (tr1) view.querySelector('tr.rem-row').click();
      var det2el = view.querySelector('tr.rem-detail');
      var d2 = det2el ? det2el.textContent.replace(/\\s+/g, ' ').trim() : '';
      __app.state.wb.accounts = bak;

      return { t1: t1, d1: d1, t2: t2, d2: d2, has177: d1.indexOf('177') >= 0, hasChen: d1.indexOf('辰') >= 0 };
    })()`,
    check(out) {
      return [
        eq('可用/冷 必须按账号真相重算（4 对 - 1 冷 = 3）', /3 \/ 冷1/.test(out.t1), true),
        eq('脏行 177****9351 不得进冷却名单', out.has177, false),
        eq('真在冷却的「辰」必须还在', out.hasChen, true),
        eq('展开后的名单里也不能出现 177', out.d1.indexOf('177') >= 0, false),
        eq('/accounts 缺失时退回 remain rows，仍要剔掉 used=0 的脏行（3 / 冷1）', /3 \/ 冷1/.test(out.t2), true),
        eq('退回路径的名单里也不能出现 177', out.d2.indexOf('177') >= 0, false),
      ];
    },
  },

  {
    id: 'F26',
    name: '新建令牌 + 首次复制带域名：POST 建 → 找回 id → 取 key → 分享面板；之后只复制密钥',
    // 契约（rc.45 实测）：POST /api/token/ 只回 {"success":true}，不返回 id；
    // 必须重拉列表按「名字 + 最新 created_time」找回 id，再 POST /api/token/<id>/key 拿密钥。
    cfg: (port) => baseCfg(port, { channel: 'browser', newapiBase: 'https://gw.example.xyz:16666' }),
    preSeed: `
      window.__CALLS = [];
      window.__COPIED = [];
      try {
        Object.defineProperty(navigator, 'clipboard', {
          value: { writeText: function (t) { window.__COPIED.push(t); return Promise.resolve(); } }
        });
      } catch (e) {}
      (function () {
        var TOK = { id: 99, name: '小明', status: 1, created_time: Math.floor(Date.now() / 1000),
                    expired_time: -1, remain_quota: 500000, unlimited_quota: false,
                    model_limits_enabled: true, model_limits: 'cn:deepseek-v4.1-flash',
                    used_quota: 0, accessed_time: 0 };
        function J(o) {
          return Promise.resolve({ ok: true, status: 200,
            text: function () { return Promise.resolve(JSON.stringify(o)); } });
        }
        var real = window.fetch;
        window.fetch = function (u, o) {
          var s = String(u), m = (o && o.method) || 'GET';
          if (s.indexOf('/api/token') < 0 && s.indexOf('/api/status') < 0) return real.call(window, u, o);
          window.__CALLS.push(m + ' ' + s);
          var path = s.split('?')[0];
          if (/\\/key$/.test(path)) return J({ success: true, data: { key: 'ABC123' } });
          if (path.indexOf('/api/status') >= 0) return J({ data: { quota_per_unit: 500000 } });
          if (/\\/api\\/token\\/?$/.test(path)) {
            if (m === 'POST') {
              var body = {};
              try { body = JSON.parse((o && o.body) || '{}'); } catch (e) {}
              window.__CREATED = body;
              return J({ success: true });
            }
            return J({ data: { page: 1, page_size: 100, total: 1, items: [TOK] } });
          }
          return J({ data: {} });
        };
      })();`,
    setup() { state.dynamic = () => ({ items: [], total: 0 }); },
    run: `(async () => {
      function sheetText() {
        var el = document.querySelector('#sheet textarea#shs-text');
        return el ? el.value : null;
      }
      __app.showTab('tokens');
      var newBtn = document.querySelector('[data-act="tok-new"]');
      var hasBtn = !!newBtn;
      if (newBtn) newBtn.click();
      var nameEl = document.getElementById('nt-name');
      var hasForm = !!nameEl;
      if (nameEl) nameEl.value = '小明';
      var models = document.getElementById('nt-models');
      if (models) models.value = 'cn:deepseek-v4.1-flash';
      var createBtn = document.querySelector('[data-sheet="create"]');
      if (createBtn) createBtn.click();
      await new Promise(function (r) { setTimeout(r, 900); });

      var txt1 = sheetText();
      var body1 = window.__CREATED || null;
      var calls = window.__CALLS.slice();

      // 分享面板里改地址 → 文案跟着变、且写回配置
      var baseEl = document.getElementById('shs-base');
      var base0 = baseEl ? baseEl.value : null;
      if (baseEl) { baseEl.value = 'https://other.example.xyz'; if (baseEl.onchange) baseEl.onchange(); }
      var txt2 = sheetText();

      var copyBtn = document.querySelector('[data-sheet="copy"]');
      if (copyBtn) copyBtn.click();
      var copied1 = window.__COPIED.slice();

      // 之后从列表再复制 → 只给纯密钥（首次标记已写）
      __app.showTab('tokens');
      var keyBtn = document.querySelector('[data-act="key"]');
      if (keyBtn) keyBtn.click();
      await new Promise(function (r) { setTimeout(r, 500); });
      var copied2 = window.__COPIED.slice();

      // 清掉标记 → 该令牌的下一次复制又回到分享文案（按令牌计「第一次」）
      try { localStorage.removeItem('tokendesk.tokshare.v1'); } catch (e) {}
      __app.showTab('tokens');
      var keyBtn2 = document.querySelector('[data-act="key"]');
      if (keyBtn2) keyBtn2.click();
      await new Promise(function (r) { setTimeout(r, 500); });
      var copied3 = window.__COPIED.slice();

      return { hasBtn: hasBtn, hasForm: hasForm, txt1: txt1, body1: body1, calls: calls,
               base0: base0, txt2: txt2, copied1: copied1, copied2: copied2, copied3: copied3,
               shareBase: __app.cfg().shareBase };
    })()`,
    check(out) {
      var t1 = String(out.txt1 || ''), t2 = String(out.txt2 || '');
      var b = out.body1 || {};
      return [
        eq('令牌页必须有「＋ 新建」按钮', out.hasBtn, true),
        eq('点开必须是新建表单', out.hasForm, true),
        eq('建令牌必须 POST /api/token/', out.calls.some(function (c) { return c.indexOf('POST') === 0 && /\/api\/token\/?$/.test(c.split(' ')[1].split('?')[0]); }), true),
        eq('body 必带名字', b.name, '小明'),
        eq('body 必带额度（非无限时用表单值）', b.remain_quota, 500000),
        eq('body 必带 unlimited_quota', b.unlimited_quota, false),
        eq('body 必带模型白名单开关与内容', b.model_limits_enabled === true && b.model_limits === 'cn:deepseek-v4.1-flash', true),
        eq('body 必带过期时间（-1=永不过期）', b.expired_time, -1),
        eq('创建后必须按名字回查列表拿 id 并取 key', out.calls.some(function (c) { return /\/api\/token\/99\/key$/.test(c); }), true),
        eq('分享文案默认用网关地址 + /v1', t1.indexOf('https://gw.example.xyz:16666/v1') >= 0, true),
        eq('分享文案的密钥必须带 sk- 前缀', t1.indexOf('sk-ABC123') >= 0, true),
        eq('分享文案必须写明模型', t1.indexOf('cn:deepseek-v4.1-flash') >= 0, true),
        eq('改分享地址后文案跟着换', t2.indexOf('https://other.example.xyz/v1') >= 0, true),
        eq('分享地址要写回配置（下次不用重填）', out.shareBase, 'https://other.example.xyz'),
        eq('复制文案 = 完整分享文案', String(out.copied1[0] || '').indexOf('接口地址：') >= 0, true),
        eq('之后复制只给纯密钥（sk- 开头、无接口地址）', out.copied2[out.copied2.length - 1], 'sk-ABC123'),
        eq('清掉标记后该令牌再复制又给分享文案', String(out.copied3[out.copied3.length - 1] || '').indexOf('接口地址：') >= 0, true),
      ];
    },
  },

  {
    id: 'F27',
    name: '统计偏好改了立刻生效并存盘：自动刷新重排定时器、范围/翻页/预取不等「保存并连接」',
    // 原实现只在 saveAndGo 的 collect() 里读这四项，用户改完不点「保存并连接」= 什么都不发生；
    // 切页签回来又被 renderSettings 的旧 CFG 覆盖 —— 主人报的「改了不保存、没生效」就是这个。
    cfg: (port) => baseCfg(port, { channel: 'native', autoRefresh: '60', prefetch: '1' }),
    preSeed: `window.NativeBridge = {};`,
    setup() { state.dynamic = () => ({ items: [], total: 0 }); },
    run: `(async () => {
      function store() {
        try { return JSON.parse(localStorage.getItem('tokendesk.cfg.v1') || '{}'); } catch (e) { return {}; }
      }
      function fire(el) { el.dispatchEvent(new Event('change', { bubbles: true })); }
      function sel(v) {
        var s = document.getElementById('f-auto');
        s.value = v; fire(s);
      }
      __app.showTab('settings');
      var a0 = __app.autoState();

      sel('30');
      var a1 = __app.autoState(), s1 = store();

      sel('0');
      var a2 = __app.autoState(), s2 = store();

      // 重新渲染（等价于切页签回来）：select 必须显示刚存的值，不能被旧 CFG 顶回去
      sel('300');
      __app.showTab('overview');
      __app.showTab('settings');
      var autoEl = document.getElementById('f-auto');
      var shown = autoEl ? autoEl.value : null;

      // 其余三项同样要「即时存」
      var r = document.getElementById('f-range'); r.value = '7d'; fire(r);
      var mp = document.getElementById('f-maxpages'); mp.value = '123'; fire(mp);
      var pf = document.getElementById('f-prefetch'); pf.value = '0'; fire(pf);
      var s3 = store();

      return { a0: a0, a1: a1, s1: s1, a2: a2, s2: s2, shown: shown, a3: __app.autoState(),
               s3: s3, range: __app.cfg().range, maxPages: __app.cfg().maxPages, prefetch: __app.cfg().prefetch };
    })()`,
    check(out) {
      return [
        eq('起手配置是每分钟一次', out.a0.sec, 60),
        eq('改成 30 秒 → 立即生效（定时器已重排）', out.a1.on === true && out.a1.sec === 30, true),
        eq('改成 30 秒 → 立刻写进 localStorage（不等保存按钮）', out.s1.autoRefresh, '30'),
        eq('改成关闭 → 定时器真的停掉', out.a2.on, false),
        eq('改成关闭 → 盘上也是 0', out.s2.autoRefresh, '0'),
        eq('重新渲染后下拉框显示的是刚存的值（不被旧 CFG 覆盖）', out.shown, '300'),
        eq('切页签回来定时器仍按 300 秒在跑', out.a3.on === true && out.a3.sec === 300, true),
        eq('默认范围即时落盘', out.s3.range, '7d'),
        eq('最大翻页数即时落盘', String(out.s3.maxPages), '123'),
        eq('后台预取即时落盘', String(out.s3.prefetch), '0'),
        eq('内存里的 CFG 与盘上一致', [out.range, out.maxPages, out.prefetch].join('|'), '7d|123|0'),
      ];
    },
  },

  {
    id: 'F28',
    name: '令牌列表：只有排序（无搜索/无筛选）、点胶囊循环四档、累计用紧凑单位',
    cfg: (port) => baseCfg(port, { channel: 'browser' }),
    preSeed: `
      (function () {
        var TOKS = [
          { id: 1, name: '何薛宝', status: 1, created_time: 1, expired_time: -1, remain_quota: 0, unlimited_quota: true, model_limits_enabled: false, model_limits: '', used_quota: 60985055487, accessed_time: 300 },
          { id: 2, name: 'Hermes', status: 2, created_time: 2, expired_time: 9999999999, remain_quota: 500000, unlimited_quota: false, model_limits_enabled: false, model_limits: '', used_quota: 1000000, accessed_time: 100 },
          { id: 3, name: '工作号', status: 1, created_time: 3, expired_time: 9999999999, remain_quota: 900000, unlimited_quota: false, model_limits_enabled: false, model_limits: '', used_quota: 2000000, accessed_time: 200 },
          { id: 4, name: '备用', status: 1, created_time: 4, expired_time: 9999999999, remain_quota: 0, unlimited_quota: true, model_limits_enabled: false, model_limits: '', used_quota: 5000, accessed_time: 50 }
        ];
        function J(o) { return Promise.resolve({ ok: true, status: 200, text: function () { return Promise.resolve(JSON.stringify(o)); } }); }
        var real = window.fetch;
        window.fetch = function (u, o) {
          var s = String(u);
          if (s.indexOf('/api/token') < 0 && s.indexOf('/api/status') < 0) return real.call(window, u, o);
          if (s.indexOf('/api/status') >= 0) return J({ data: {} });
          return J({ data: { page: 1, page_size: 100, total: TOKS.length, items: TOKS } });
        };
      })();`,
    setup() { state.dynamic = () => ({ items: [], total: 0 }); },
    run: `(async () => {
      await __app.loadOverview(true);
      __app.showTab('tokens');
      var view = document.querySelector('[data-view="tokens"]');
      function names() {
        var box = document.getElementById('tok-list');
        return box ? Array.prototype.map.call(box.querySelectorAll('.tok .tok-name'), function (e) { return e.textContent; }) : [];
      }
      function pill() { return view.querySelector('[data-act="tok-sort"]'); }
      var hasSearch = !!document.getElementById('tok-q');
      var hasSelect = !!document.getElementById('tok-sort');
      var hasFilter = !!view.querySelector('[data-act="tok-filter"]');
      var n0 = names(), lbl0 = pill() ? pill().textContent.trim() : null;
      var acc0 = view.querySelector('#tok-list .tok-line').textContent;

      pill().click();                                  // 按消耗 → 按剩余
      var lbl1 = pill().textContent.trim(), n1 = names();
      pill().click();                                  // → 按最近
      var lbl2 = pill().textContent.trim(), n2 = names();
      pill().click();                                  // → 按名称
      var lbl3 = pill().textContent.trim(), n3 = names();
      pill().click();                                  // → 回到按消耗
      var lbl4 = pill().textContent.trim(), n4 = names();

      // 切页签回来：排序档位必须还在（写回配置）
      __app.showTab('overview'); __app.showTab('tokens');
      var lbl5 = document.querySelector('[data-view="tokens"] [data-act="tok-sort"]').textContent.trim();

      return { hasSearch: hasSearch, hasSelect: hasSelect, hasFilter: hasFilter,
               n0: n0, lbl0: lbl0, acc0: acc0,
               lbl1: lbl1, n1: n1, lbl2: lbl2, n2: n2, lbl3: lbl3, n3: n3, lbl4: lbl4, n4: n4,
               lbl5: lbl5, sort: __app.cfg().tokSort };
    })()`,
    check(out) {
      return [
        eq('搜索框必须没了', out.hasSearch, false),
        eq('原生下拉也必须没了', out.hasSelect, false),
        eq('筛选按钮必须没了', out.hasFilter, false),
        eq('默认档位「按消耗」', out.lbl0, '按消耗'),
        eq('默认按消耗排序（何薛宝在最前）', out.n0[0], '何薛宝'),
        eq('累计金额用紧凑单位（带「万」）', out.acc0.indexOf('万') >= 0, true),
        // 两枚「无限额度」相减会给 Infinity-Infinity=NaN，比较器返回 NaN 时顺序未定义；
        // 期望：无限在前（内部按已用降序），再按剩余从多到少
        eq('按剩余：无限额度在前，且两枚无限按已用降序（何薛宝 → 备用）', out.n1.slice(0, 2).join(','), '何薛宝,备用'),
        eq('按剩余：非无限按剩余从多到少（工作号 900000 > Hermes 500000）', out.n1.slice(2).join(','), '工作号,Hermes'),
        eq('再点换「按最近」（accessed 最大的何薛宝）', out.lbl2 + '|' + out.n2[0], '按最近|何薛宝'),
        eq('再点换「按名称」（拼音序首条 备用）', out.lbl3 + '|' + out.n3[0], '按名称|备用'),
        eq('再点回到「按消耗」', out.lbl4 + '|' + out.n4[0], '按消耗|何薛宝'),
        eq('切页签回来档位保持', out.lbl5, '按消耗'),
        eq('排序写回配置', out.sort, 'usage'),
      ];
    },
  },

  {
    id: 'F29',
    name: '日志仓迁 IndexedDB：配额写满不砍行（不再制造「覆盖倒退」）、重启能从 IDB 接管回来',
    // 老实现：localStorage 写失败 → 把 rows 砍到 12000/8000/4000，界面只标 capped，用户看不出被砍。
    // 现在：IDB 存全量；localStorage 只是兼容镜像；两边都失败才降级，并把 degraded 暴露出来。
    cfg: (port) => baseCfg(port, { channel: 'native' }),
    preSeed: `window.NativeBridge = {};`,
    setup() { state.dynamic = () => ({ items: [], total: 0 }); },
    run: `(async () => {
      function sleep2(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
      var rows = [];
      for (var i = 0; i < 25; i++) rows.push(__T.row(1761000000 - i * 10, i + 1, 5, 'k5', 'gpt-4o', 10, 10, 100));
      __T.seedRaw(rows, { at: 1761000000 * 1000, since: 1761000000 - 300, newest: 1761000000, pages: 1, complete: true });
      var before = __app.raw();

      var realSet = localStorage.setItem.bind(localStorage);
      var quotaMode = false;
      localStorage.setItem = function (k, v) {
        if (quotaMode && k === __app.rawKey()) { var e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; }
        return realSet(k, v);
      };
      quotaMode = true;
      __app.meta();                       // rawMeta + rawSave(true)：配额满的情况下存盘
      await sleep2(120);
      var afterQuota = __app.raw();

      // 从 IDB 再把仓接回来：先抹内存 + 删 localStorage 镜像，模拟「重启后本地镜像被清」
      quotaMode = false;
      __app.rawDropMem();
      try { localStorage.removeItem(__app.rawKey()); } catch (e) {}
      var adopted = await __app.rawAdopt();
      var afterAdopt = __app.raw();

      return { before: before, afterQuota: afterQuota, adopted: adopted, afterAdopt: afterAdopt };
    })()`,
    check(out) {
      return [
        eq('起手 25 行', out.before.rows, 25),
        eq('配额满时不砍行（行数仍是 25，老实现会砍到 4000 以下）', out.afterQuota.rows, 25),
        eq('配额满时标记 degraded（界面会显示「仅内存」）', out.afterQuota.degraded, true),
        eq('IDB 可用（idb=true）', out.afterQuota.idb, true),
        eq('重启后能从 IDB 接管回来', out.adopted, true),
        eq('接管回来的行数一致', out.afterAdopt.rows, 25),
        eq('接管后不再是 degraded', out.afterAdopt.degraded, false),
      ];
    },
  },

  {
    id: 'F30',
    name: '更新一键下载：有原生桥才露「下载并安装」，下载的是 APK 附件直链；回调驱动提示',
    cfg: (port) => baseCfg(port, { channel: 'native' }),
    preSeed: `
      window.__DL = [];
      window.NativeBridge = {
        appInfo: function () { return JSON.stringify({ version: '1.0.72', sdk: 34, model: 'test' }); },
        copy: function (t) { window.__COPIED = t; },
        downloadApk: function (u, v) { window.__DL.push({ url: u, ver: v }); }
      };
      (function () {
        var real = window.fetch;
        window.fetch = function (u, o) {
          var s = String(u);
          if (s.indexOf('api.github.com') < 0 && s.indexOf('example.invalid') < 0) return real.call(window, u, o);
          return Promise.resolve({ ok: true, status: 200, json: function () {
            return Promise.resolve({
              tag_name: 'v1.0.73',
              html_url: 'https://example.invalid/releases/tag/v1.0.73',
              assets: [
                { name: 'notes.txt', browser_download_url: 'https://example.invalid/notes.txt' },
                { name: 'TokenDesk-1.0.73.apk', browser_download_url: 'https://example.invalid/dl/TokenDesk-1.0.73.apk' }
              ],
              body: 'x'
            });
          } });
        };
      })();`,
    setup() { state.dynamic = () => ({ items: [], total: 0 }); },
    run: `(async () => {
      __app.showTab('settings');
      await __app.checkUpdate({ force: true, cur: '1.0.72', urls: ['https://example.invalid/releases/latest'] });
      var dlBtn = document.getElementById('f-upddl');
      var cpBtn = document.getElementById('f-updcopy');
      var shown = dlBtn ? dlBtn.style.display !== 'none' : null;
      var note0 = document.getElementById('upd-note');
      if (dlBtn) dlBtn.click();                     // 点「下载并安装」
      var calls = window.__DL.slice();
      var noteBusy = document.getElementById('upd-note');
      window.__onApk({ ok: true, msg: '下载完成（116 KB），准备安装', file: 'TokenDesk-1.0.73.apk' });
      var note1 = document.getElementById('upd-note').textContent;   // 立刻取值：元素会被下一次回调改写
      window.__onApk({ ok: false, msg: '下载失败：HTTP 404' });
      var note2 = document.getElementById('upd-note').textContent;
      // 网页版：没有桥 → 下载按钮必须藏着，只能复制
      delete window.NativeBridge;
      __app.showTab('overview'); __app.showTab('settings');
      var dlBtn2 = document.getElementById('f-upddl');
      return {
        shown: shown, hasCopy: !!cpBtn && cpBtn.style.display !== 'none',
        calls: calls, noteBusy: noteBusy ? noteBusy.textContent : null,
        note1: note1, note2: note2,
        webShown: dlBtn2 ? dlBtn2.style.display !== 'none' : null
      };
    })()`,
    check(out) {
      return [
        eq('壳内发现新版 → 露「下载并安装」', out.shown, true),
        eq('同时保留「复制地址」', out.hasCopy, true),
        eq('点下载只调用一次原生桥', out.calls.length, 1),
        eq('下载的是 APK 附件直链（不是 release 页面，也不是 notes.txt）', out.calls[0].url, 'https://example.invalid/dl/TokenDesk-1.0.73.apk'),
        eq('版本号一并交给原生侧（文件名用得上）', out.calls[0].ver, '1.0.73'),
        eq('成功回调后提示下载完成', String(out.note1 || '').indexOf('下载完成') >= 0, true),
        eq('失败回调后提示真实原因', String(out.note2 || '').indexOf('HTTP 404') >= 0, true),
        eq('网页版（无桥）不许露下载按钮', out.webShown, false),
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

  // ── 波形 P0（1.0.102）：`<svg>` 里出现任何 HTML 元素都会把 svg 踹开，后面的 path
  //    变成 xhtml:PATH 不渲染 → 切到比本地仓更宽的窗口（unknown>0 插斜纹）时波形整条消失。
  //    这三条把「4 条 path 必须在 svg 里」「斜纹是 svg 的兄弟」「单桶/全零也不出空图」钉死。
  {
    id: 'F31',
    name: '波形：仓未覆盖窗口（unknown>0）时曲线仍必须画出来',
    cfg: (port) => baseCfg(port, { range: '24h' }),
    // 只种最近 6 小时的行，coverFrom 也停在 6 小时前 → 切 7 天必然 unknown>0（斜纹 96%）
    seed: `var rows=[]; for (var i=0;i<12;i++) rows.push(__T.row(${NOW - 1800} - i * 1800, 300 + i, 7, 't7', 'gpt-4o', 100 + i, 200, 100)); __T.seedRaw(rows, { newest: ${NOW - 1800}, coverFrom: ${NOW - 6 * 3600} });`,
    setup() { state.dynamic = () => ({ items: [], total: 0 }); },
    run: `(async () => {
      __app.cfg().range = '7d';
      __app.state.usage = __app.rawAgg('7d');
      __app.state.usageLive = null;
      __app.state.busy.usage = false;
      __app.showTab('overview');
      var w = document.getElementById('ov-wave');
      var svg = w && w.querySelector('svg');
      var line = w && w.querySelector('.w-line');
      var hatch = w && w.querySelector('.w-unk');
      var d = line ? (line.getAttribute('d') || '') : '';
      return {
        hasWave: !!w,
        paths: svg ? [].map.call(svg.querySelectorAll('path'), function (p) { return p.getAttribute('class'); }) : [],
        // namespaceURI 不是 SVG 的子元素 = 被 HTML 解析器踹出 svg 的残留
        foreign: svg ? [].filter.call(svg.children, function (e) { return e.namespaceURI !== 'http://www.w3.org/2000/svg'; }).map(function (e) { return e.tagName; }) : ['NO-SVG'],
        hatchW: hatch ? parseFloat(hatch.style.width) : 0,
        hatchInsideSvg: svg && hatch ? svg.contains(hatch) : null,
        segs: (d.match(/[LC]/g) || []).length,
        dHasNaN: /NaN|Infinity/.test(d),
        capL: w ? w.querySelector('.w-l').textContent : '',
      };
    })()`,
    check(out) {
      return [
        truthy('波形块必须存在', out.hasWave),
        eq('波形 4 条 path 必须都在 svg 里（P0 回归点）', out.paths, ['w-base', 'w-area', 'w-glow', 'w-line']),
        eq('svg 里不许有任何非 SVG 命名空间元素', out.foreign, []),
        eq('斜纹必须在 svg 外面（否则会踹开 svg）', out.hatchInsideSvg, false),
        truthy('本用例必须真的命中 unknown>0（斜纹 >90%）', out.hatchW > 90),
        truthy('曲线必须有 20+ 段（不是空 d / 不是单点）', out.segs > 20),
        eq('d 里不许出现 NaN/Infinity', out.dHasNaN, false),
        truthy('未覆盖段必须如实标注「仅覆盖」', /仅覆盖/.test(out.capL)),
      ];
    },
  },

  {
    id: 'F32',
    name: '波形：单桶态（今天 00:0x 只有一个点）仍要有描边',
    cfg: (port) => baseCfg(port, { range: 'today' }),
    seed: `__T.seedRaw([__T.row(${NOW} - 600, 401, 7, 't7', 'gpt-4o', 10, 10, 100)], { newest: ${NOW} - 600, coverFrom: ${NOW} - 3600 });`,
    setup() { state.dynamic = () => ({ items: [], total: 0 }); },
    run: `(async () => {
      // 把时钟拨到当天 00:20 → today 窗口 cnt = 1（seriesPath 的 n<2 分支）
      var d0 = new Date(${NOW} * 1000); d0.setHours(0, 20, 0, 0);
      __app.__setNow(Math.floor(d0.getTime() / 1000));
      __app.cfg().range = 'today';
      __app.state.usage = __app.rawAgg('today');
      __app.state.usageLive = null;
      __app.state.busy.usage = false;
      __app.showTab('overview');
      var w = document.getElementById('ov-wave');
      var line = w && w.querySelector('.w-line');
      var d = line ? (line.getAttribute('d') || '') : '';
      return {
        pts: __app.state.usage ? 1 : 1,
        paths: w ? [].map.call(w.querySelectorAll('svg path'), function (p) { return p.getAttribute('class'); }) : [],
        d: d,
        hasLine: /L/.test(d),
        dHasNaN: /NaN|Infinity/.test(d),
      };
    })()`,
    check(out) {
      return [
        eq('单桶时 4 条 path 仍在', out.paths, ['w-base', 'w-area', 'w-glow', 'w-line']),
        truthy('单点必须补一条线段（只有 M 的话 SVG 什么都不画）', out.hasLine),
        eq('d 里不许出现 NaN', out.dHasNaN, false),
      ];
    },
  },

  {
    id: 'F33',
    name: '波形：全零态（窗口内没有任何用量）给占位文案，不画空图',
    cfg: (port) => baseCfg(port, { range: '24h' }),
    seed: `__T.seedRaw([], { newest: ${NOW} - 600, coverFrom: ${NOW} - 7 * 3600 });`,
    setup() { state.dynamic = () => ({ items: [], total: 0 }); },
    run: `(async () => {
      __app.cfg().range = '24h';
      __app.state.usage = __app.rawAgg('24h');
      __app.state.usageLive = null;
      __app.state.busy.usage = false;
      __app.showTab('overview');
      var w = document.getElementById('ov-wave');
      return {
        hasWave: !!w,
        capL: w ? w.querySelector('.w-l').textContent : '',
        capR: w ? w.querySelector('.w-r').textContent : '',
        dot: w ? !!w.querySelector('.w-dot') : null,
        paths: w ? [].map.call(w.querySelectorAll('svg path'), function (p) { return p.getAttribute('class'); }) : [],
      };
    })()`,
    check(out) {
      return [
        truthy('全零也要有波形块（不能整块消失）', out.hasWave),
        eq('左侧文案必须是占位', out.capL, '暂无用量数据'),
        eq('右侧文案必须是占位', out.capR, '暂无用量'),
        eq('全零不画末端圆点（假的「当前值」）', out.dot, false),
        eq('4 条 path 仍在（占位不靠删元素实现）', out.paths, ['w-base', 'w-area', 'w-glow', 'w-line']),
      ];
    },
  },

  // ── 1.1.0 优化批（A 批短名单）
  {
    id: 'F34',
    name: 'U4-1 切后台零打点：document.hidden 时不发 /usage/recent',
    cfg: (port) => baseCfg(port, { range: '24h' }),
    // 桥只留 secure*（不需要 http）；hubBase 指本机 mock，/usage/recent 会真的打上来
    preSeed: `window.NativeBridge = { secureAvailable: function () { return false; }, secureGet: function () { return null; }, secureSet: function () { return false; } };`,
    setup() { state.dynamic = () => ({ items: [], total: 0 }); },
    run: `(async () => {
      __app.cfg().hubBase = 'http://127.0.0.1:' + location.port;
      __app.state.hubToken = 'tok';
      __app.state.tab = 'wb';
      var hide = function (v) { Object.defineProperty(document, 'hidden', { get: function () { return v; }, configurable: true }); };
      hide(true);
      // 后台：连打 3 次，一次都不许发出去
      for (var i = 0; i < 3; i++) { __app.pollLive(); await __T.sleep(40); }
      // 前台：立刻要发
      hide(false);
      __app.pollLive();
      await __T.sleep(120);
      return { ok: true };
    })()`,
    check() {
      // ⚠ 时序：前台那次可能还没落盘，所以按「后台期间」的命中数判断而不是总数
      const usageHits = state.hits.filter((h) => h.p.startsWith('/usage/')).length;
      return [
        truthy('前台那次必须真的打出去（否则本用例测的是空气）', usageHits >= 1),
        eq('后台 3 次 pollLive 必须零请求（前台只有 1 次）', usageHits, 1),
      ];
    },
  },

  {
    id: 'F35',
    name: 'U7-3 到期日按本地时区算：UTC 串不许差一天',
    cfg: (port) => baseCfg(port),
    run: `(() => {
      var cases = [
        // [入参, 期望的本地日]  —— 宿主时区 Asia/Shanghai（UTC+8）
        ['2026-10-24T23:30:00Z', '2026-10-25'],   // ⭐ 老实现切字符串会给 10-24（差一天）
        ['2026-10-24T13:00:00Z', '2026-10-24'],   // 不跨日：不许被顺手改坏
        ['2026-10-25T01:00:00+08:00', '2026-10-25'],  // 带偏移
        ['2026-10-24 21:00:00', '2026-10-24'],    // 无时区的本地串：按本地解释，原样不动
        ['2026-10-24', '2026-10-24'],             // 纯日期：就是那一天
      ];
      var out = [];
      for (var i = 0; i < cases.length; i++) {
        var ts = __app.tsOf(cases[i][0]);
        out.push({ inp: cases[i][0], ts: ts, day: __app.localDay(ts), want: cases[i][1] });
      }
      return { cases: out, bad: __app.tsOf('not-a-time') };
    })()`,
    check(out) {
      const checks = [eq('解析不了的串必须回 null（不许猜今天）', out.bad, null)];
      for (const c of out.cases) checks.push(eq(c.inp + ' → ' + c.want, c.day, c.want));
      return checks;
    },
  },

  {
    id: 'F36',
    name: 'U4-3 凭证不重写：纯 UI 动作不许再调 secureSet',
    cfg: (port) => baseCfg(port),
    // 计数桩：secureSet/secureGet 全走内存 Map，能数清调用次数
    preSeed: `window.__sec = { set: 0, get: 0, store: {} };
      window.NativeBridge = {
        secureAvailable: function () { return true; },
        secureGet: function (k) { window.__sec.get++; return (k in window.__sec.store) ? window.__sec.store[k] : null; },
        secureSet: function (k, v) { window.__sec.set++; window.__sec.store[k] = v; return true; }
      };`,
    setup() { state.dynamic = () => ({ items: [], total: 0 }); },
    run: `(async () => {
      var s0 = window.__sec.set;          // boot + migrateCreds 已经把 4 个键写过一遍
      __app.saveCfg();                    // 纯 UI 动作（切范围 / 点排序都长这样）
      var s1 = window.__sec.set;
      __app.cfg().privacy = !__app.cfg().privacy;
      __app.saveCfg();                    // 改的是普通字段，凭证仍没变
      var s2 = window.__sec.set;
      __app.cfg().newapiToken = 'chan' + 'ged-token';
      __app.saveCfg();                    // 真改了凭证：必须落盘
      var s3 = window.__sec.set;
      return { s0: s0, s1: s1, s2: s2, s3: s3, wrote: __app.secureWrote() };
    })()`,
    check(out) {
      return [
        truthy('开机确实写过凭证（否则桩没生效）', out.s0 >= 1),
        eq('值没变时 saveCfg 不许调 secureSet', out.s1, out.s0),
        eq('改普通字段也不许调 secureSet', out.s2, out.s0),
        eq('真改了令牌必须写一次（配置不许丢）', out.s3, out.s0 + 1),
        eq('落盘账本记的是新令牌', out.wrote.newapiToken, 'changed-token'),
      ];
    },
  },

  // ── 波形 1.1.1：覆盖标记 + 横轴刻度
  {
    id: 'F37',
    name: '波形：capped 且无重叠时覆盖标记必须跟上（不许满屏假斑马纹）',
    cfg: (port) => baseCfg(port, { range: '7d' }),
    // 现场复现：仓里其实有 7 天数据（7×24/6 = 28 桶），但 coverFrom 还停在「只扫过 24 小时」时
    // 标记的 now-24h，且已 capped（翻到 260 页上限）。UI 会写「仅覆盖 24 小时」+ 86% 斜纹。
    seed: `var rows=[]; for (var i=0;i<28;i++) rows.push(__T.row(${NOW} - i * 21600 - 60, ${600} + i, 7, 't7', 'gpt-4o', 100, 200, 100)); __T.seedRaw(rows, { newest: ${NOW} - 60, coverFrom: ${NOW} - 86400, capped: true });`,
    setup() { state.dynamic = () => ({ items: [], total: 0 }); },
    run: `(() => {
      __app.meta();                        // rawMeta() 跑一次：capped + 未脏 → 覆盖标记应推进到最老行
      __app.cfg().range = '7d';
      __app.state.usage = __app.rawAgg('7d');
      __app.state.usageLive = null;
      __app.state.busy.usage = false;
      __app.showTab('overview');
      var w = document.getElementById('ov-wave');
      var hatch = w && w.querySelector('.w-unk');
      return {
        coverFrom: __app.raw().coverFrom,
        oldest: ${NOW} - 27 * 21600 - 60,
        hatchW: hatch ? parseFloat(hatch.style.width) : 0,
        capL: w ? w.querySelector('.w-l').textContent : '',
        serUnknown: (__app.state.usage && __app.state.usage.range) || '',
      };
    })()`,
    check(out) {
      return [
        eq('coverFrom 必须推进到最老一行（capped + 无重叠 = 连续翻页）', out.coverFrom, out.oldest),
        eq('斜纹必须消失（覆盖已达 6.8 天，7 天窗口没有整桶未覆盖）', out.hatchW, 0),
        truthy('文案不许再写「仅覆盖」', !/仅覆盖/.test(out.capL)),
      ];
    },
  },

  {
    id: 'F38',
    name: '波形：24 小时窗口的边界桶不许被当成未覆盖（假斑马纹）',
    cfg: (port) => baseCfg(port, { range: '24h' }),
    // ⚠ 时间点必须卡在边界上才复现得出：coverFrom 要落在窗口首桶 (start, start+1h) 之内
    // （现场就是这德行：窗口按整点对齐，而 coverFrom 取「扫描那一刻 - 24h」= 20:40:35，
    //  比整点晚 40 分钟 → ceil 就多标一个桶 → 左边挂一条 4% 的斑马纹）
    seed: `var rows=[]; for (var i=0;i<24;i++) rows.push(__T.row(${NOW} - i * 3600 - 60, ${700} + i, 7, 't7', 'gpt-4o', 100, 200, 100)); __T.seedRaw(rows, { newest: ${NOW} - 60, coverFrom: ${NOW} + 1800 - 86400 });`,
    setup() { state.dynamic = () => ({ items: [], total: 0 }); },
    run: `(() => {
      __app.cfg().range = '24h';
      __app.state.usage = __app.rawAgg('24h');
      __app.state.usageLive = null;
      __app.state.busy.usage = false;
      __app.showTab('overview');
      var w = document.getElementById('ov-wave');
      var hatch = w && w.querySelector('.w-unk');
      var axis = w ? [].map.call(w.querySelectorAll('.w-axis span'), function (s) { return s.textContent; }) : [];
      return {
        hatchW: hatch ? parseFloat(hatch.style.width) : 0,
        capL: w ? w.querySelector('.w-l').textContent : '',
        axis: axis,
      };
    })()`,
    check(out) {
      return [
        eq('24 小时窗口不该有斜纹（窗口起点只比 coverFrom 早不到一个桶）', out.hatchW, 0),
        truthy('文案不该说「仅覆盖」', !/仅覆盖/.test(out.capL)),
        eq('横轴刻度必须有 5 个（24 小时 → HH:00）', out.axis.length, 5),
        truthy('小时档刻度形如 HH:00', out.axis.every((t) => /^\d{2}:00$/.test(t))),
      ];
    },
  },

  {
    id: 'F39',
    name: '波形：7 天横轴刻度按日期（MM-DD），首尾覆盖整个窗口',
    cfg: (port) => baseCfg(port, { range: '7d' }),
    seed: `var rows=[]; for (var i=0;i<28;i++) rows.push(__T.row(${NOW} - i * 21600 - 60, ${800} + i, 7, 't7', 'gpt-4o', 100, 200, 100)); __T.seedRaw(rows, { newest: ${NOW} - 60, coverFrom: ${NOW} - 7 * 86400 - 60 });`,
    setup() { state.dynamic = () => ({ items: [], total: 0 }); },
    run: `(() => {
      __app.cfg().range = '7d';
      __app.state.usage = __app.rawAgg('7d');
      __app.state.usageLive = null;
      __app.state.busy.usage = false;
      __app.showTab('overview');
      var w = document.getElementById('ov-wave');
      var axis = w ? [].map.call(w.querySelectorAll('.w-axis span'), function (s) { return s.textContent; }) : [];
      var hatch = w && w.querySelector('.w-unk');
      var d = w ? (w.querySelector('.w-line').getAttribute('d') || '') : '';
      return { axis: axis, hatchW: hatch ? parseFloat(hatch.style.width) : 0, segs: (d.match(/[LC]/g) || []).length };
    })()`,
    check(out) {
      const pad = (n) => String(n).padStart(2, '0');
      const day = (sec) => { const d = new Date(sec * 1000); return pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
      return [
        // 4 个而不是 5 个：28 桶 ÷ 3 = 9 桶 = 2.25 天，日期不会挤成相邻两天
        eq('7 天刻度 4 个', out.axis.length, 4),
        truthy('日期档刻度形如 MM-DD', out.axis.every((t) => /^\d{2}-\d{2}$/.test(t))),
        eq('末位刻度 = 当前桶（右端对齐）', out.axis[3], day(NOW)),
        truthy('相邻刻度不得同一天', out.axis.every((t, i) => i === 0 || t !== out.axis[i - 1])),
        eq('首尾不重复', out.axis[0] !== out.axis[3], true),
        eq('本用例不该有斜纹', out.hatchW, 0),
        truthy('曲线不许影响画线', out.segs > 20),
      ];
    },
  },

  {
    id: 'F40',
    name: '更新红点必须贴在设置图标右上角（不是底部中间）',
    // 现场复现：原 CSS 用 `right:calc(50% - 12px)` 相对按钮定位，红点跑到图标左侧/底部中间。
    // 而且 `.tab .ico-wrap` 选择器根本匹配不上 —— 底部按钮的 class 是 `on`（当前页签）、不是 `tab`，
    // 于是 .ico-wrap 没有 position:relative，红点改相对 nav 定位、偏出 34px。
    cfg: (port) => baseCfg(port),
    setup() { state.dynamic = () => ({ items: [], total: 0 }); },
    run: `(() => {
      var dot = document.getElementById('upd-dot');
      if (!dot) return { missing: true };
      dot.style.display = 'block';    // 默认 display:none（等 updPaint 判定），量尺寸前先亮出来
      var wrap = dot.parentNode;
      var ico = wrap.querySelector('svg');
      var cs = getComputedStyle(wrap);
      var d = dot.getBoundingClientRect(), i = ico.getBoundingClientRect();
      return {
        missing: false,
        wrapClass: wrap.className,
        wrapPos: cs.position,
        dotW: Math.round(d.width), dotH: Math.round(d.height),
        // 红点应该跨在图标右上角：水平方向落在图标右边缘附近、垂直方向靠顶部
        dxRight: Math.round(d.left - i.right),   // ≈ -1 ~ -4（压在右上角外侧）
        dyTop: Math.round(d.top - i.top),        // ≈ -1 ~ -3（略高于图标顶部）
        insideIcon: d.left > i.left + i.width / 2 && d.top > i.top + i.height / 2,
      };
    })()`,
    check(out) {
      return [
        truthy('红点元素必须存在', !out.missing),
        eq('红点必须包在 .ico-wrap 里（相对图标定位）', out.wrapClass, 'ico-wrap'),
        eq('.ico-wrap 必须有 position:relative（否则相对 nav 定位会偏出）', out.wrapPos, 'relative'),
        eq('红点尺寸 6x6', [out.dotW, out.dotH].join('x'), '6x6'),
        truthy('红点必须跨在图标右边缘（偏离不超过 6px）', Math.abs(out.dxRight) <= 6),
        truthy('红点必须在图标顶部附近（±4px）', Math.abs(out.dyTop) <= 4),
        eq('红点不许压在图标内部', out.insideIcon, false),
      ];
    },
  },

  {
    id: 'F41',
    name: '不在设置页时，检测到新版本也必须亮红点（启动自动检查就属于这种）',
    // 真实故障：updPaint() 开头是 `if (!line) return;`（不在设置页直接返回），
    // 而红点控制写在它之后 → 概览页/启动自动检查时永远执行不到，
    // 表现就是「明明检测到新版本，设置图标却不亮红点」。
    cfg: (port) => baseCfg(port, { range: '24h' }),
    preSeed: `(function () {
        var real = window.fetch;
        window.fetch = function (u, o) {
          var s = String(u);
          if (s.indexOf('api.github.com') < 0 && s.indexOf('example.invalid') < 0) return real.call(window, u, o);
          return Promise.resolve({ ok: true, status: 200, json: function () {
            return Promise.resolve({ tag_name: 'v9.9.9', html_url: 'https://example.invalid/r', body: 'x', assets: [] });
          } });
        };
      })();`,
    setup() { state.dynamic = () => ({ items: [], total: 0 }); },
    run: `(async () => {
      __app.showTab('overview');                       // 停在概览页：设置页根本没渲染
      await __app.checkUpdate({ force: true, cur: '1.1.6', urls: ['https://api.github.com/x'] });
      var dot = document.getElementById('upd-dot');
      return {
        state: __app.upd().state,
        onSettings: !!document.getElementById('upd-line'),   // 必须为 false（不在设置页）
        display: dot ? dot.style.display : null,
      };
    })()`,
    check(out) {
      return [
        eq('必须检测到新版本', out.state, 'new'),
        eq('前提确认：当前不在设置页（#upd-line 不存在）', out.onSettings, false),
        eq('不在设置页也必须点亮红点', out.display, 'block'),
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

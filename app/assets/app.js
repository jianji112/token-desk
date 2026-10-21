(function () {
  'use strict';

  var LS_KEY = 'tokendesk.cfg.v1';
  var CHAN_MIG = 'tokendesk.chanmig.v1';   // 一次性通道迁移标记：置 '1' 后永不重复迁移

  // ── 应用内更新检查的常量 ────────────────────────────────────
  // 版本源放 GitHub Releases：tag 和附件天然同步，不需要手工维护 version.json，
  // 也就没有「忘了改清单 → 静默不提示」这种错。该 API 带 ACAO:*，file:// 页面能直读
  // （CSP 的 connect-src 已是 http:/https:，见 index.html:6，不用改 CSP）。
  var UPD_DAY = 'tokendesk.updchecked.v1';  // 自动检查的「今天查过」标记，值 YYYY-MM-DD
  // 上一次检查的结论（只存结论，不存「检查中」）。同日重开 App 时设置页要能接着显示
  // 「已是最新（v1.0.72） · 今天 09:29 查过」——否则用户刚查完、关掉再开就看到「未检查」，像坏了。
  var UPD_LAST = 'tokendesk.updlast.v1';
  var UPD_URLS = [
    'https://api.github.com/repos/jianji112/token-desk/releases/latest'
  ];
  var UPD_TIMEOUT_MS = 4000;
  var PRESETS = {
    public: { newapiBase: '__PRESET_PUBLIC_NEWAPI__', hubBase: '__PRESET_PUBLIC_HUB__' },
    lan:    { newapiBase: '__PRESET_LAN_NEWAPI__',    hubBase: '__PRESET_LAN_HUB__' }
  };

  // 构建期未注入的占位符不算“可用地址”：否则点按钮会把 __PRESET_*__ 字面量写进配置
  function presetOk(v) { return !!v && String(v).indexOf('__PRESET_') < 0; }
  function presetReady(k) {
    return !!(PRESETS[k] && presetOk(PRESETS[k].newapiBase));
  }
  var DEF = {
    newapiBase: '',
    newapiToken: '',
    newapiUid: '1',
    hubBase: '',
    hubPass: '',
    range: '24h',
    maxPages: '80',
    channel: 'native',
    shareBase: '',        // 分享给朋友用的接口地址（留空=跟随构建期预设或 newapiBase）
    tokQuery: '',         // 令牌列表搜索词
    tokFilter: 'all',     // all|on|off|exp
    tokSort: 'usage',     // usage|quota|recent|name
    autoRefresh: '60',
    prefetch: '1',
    accRealm: 'all',
    privacy: false
  };

  var CACHE_PREFIX = 'tokendesk.cache.v1.';
  var USAGE_PREFIX = 'tokendesk.usage.v1.';
  var cacheMem = {};
  var CACHE_RULES = [
    [/\/v1\/models/, 10 * 60 * 1000],
    [/\/api\/user\/self/, 45 * 1000],
    [/\/api\/token\//, 45 * 1000],
    [/\/api\/log\//, 20 * 1000],
    [/\/accounts/, 45 * 1000],
    [/\/health/, 30 * 1000],
    [/\/scheduler/, 60 * 1000],
    [/\/usage\/(analytics|remaining)/, 60 * 1000]
  ];

  function ttlFor(key) {
    for (var i = 0; i < CACHE_RULES.length; i++) if (CACHE_RULES[i][0].test(key)) return CACHE_RULES[i][1];
    return 45 * 1000;
  }

  function cacheGet(key) {
    var e = cacheMem[key];
    if (!e) {
      try {
        var raw = localStorage.getItem(CACHE_PREFIX + key);
        if (raw) { e = JSON.parse(raw); cacheMem[key] = e; }
      } catch (err) { return null; }
    }
    if (!e || e.at == null) return null;
    return e;
  }

  function cacheFresh(key) {
    var e = cacheGet(key);
    if (!e) return null;
    return (Date.now() - e.at) < ttlFor(key) ? e : null;
  }

  function cacheStale(key) {
    var e = cacheGet(key);
    return e || null;
  }

  var MEM_ONLY = /\/api\/log\//;

  var CACHE_MEM_MAX = 20;

  function cachePut(key, v) {
    var e = { at: Date.now(), v: v };
    cacheMem[key] = e;
    cacheEvictMem();
    if (MEM_ONLY.test(key)) return;
    try {
      var json = JSON.stringify(e);
      if (json.length < 300000) localStorage.setItem(CACHE_PREFIX + key, json);
    } catch (err) { }
  }

  // /api/log/ 的缓存 key 带 start/end 时间戳：每次增量刷新都是一个新 key，而它
  // 在 MEM_ONLY 里、从不落盘 → 不设上限的话整个日志页会一直堆在内存里（50 次刷新
  // = 50 份整页数据）。按 at 淘汰最老的；时钟同毫秒时 sort 稳定，仍按插入序淘汰。
  function cacheEvictMem() {
    var keys = Object.keys(cacheMem);
    if (keys.length <= CACHE_MEM_MAX) return;
    keys.sort(function (a, b) { return (cacheMem[a].at || 0) - (cacheMem[b].at || 0); });
    for (var i = 0, drop = keys.length - CACHE_MEM_MAX; i < drop; i++) delete cacheMem[keys[i]];
  }

  function purgeLegacyCache() {
    try {
      var keys = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!k) continue;
        if (k.indexOf(USAGE_PREFIX) === 0) keys.push(k);
        else if (k.indexOf(CACHE_PREFIX) === 0 && k.indexOf('/api/log/') >= 0) keys.push(k);
      }
      keys.forEach(function (k) { localStorage.removeItem(k); });
    } catch (e) { }
  }

  function cacheSaveUsage(range, agg) {
    try { localStorage.setItem(USAGE_PREFIX + range, JSON.stringify({ since: agg.since, at: agg.at, agg: agg })); } catch (e) { }
  }

  function cacheLoadUsage(range) {
    try {
      var raw = localStorage.getItem(USAGE_PREFIX + range);
      if (!raw) return null;
      var o = JSON.parse(raw);
      if (!o || !o.agg) return null;
      return o;
    } catch (e) { return null; }
  }

  // v3：行结构多了第 12 位（日志 id），rokey 纳入 id 后旧缓存无法与新行去重，
  // 直接弃用旧键（只是本地缓存，下次扫描自愈）；旧键必须 remove，否则白占 5–10MB 配额
  var RAW_KEY = 'tokendesk.rawlog.v3';
  var RAW_KEY_LEGACY = 'tokendesk.rawlog.v2';

  // ── 日志仓持久层（IndexedDB 主存 + localStorage 兼容镜像）────────────────
  // localStorage 单源配额通常只有 5–10MB，40000 行整行 JSON 约 7MB —— 必撞墙。
  // 老实现撞墙时把 rows 砍到 12000/8000/4000，表现成「覆盖区间倒退」，界面还只标 capped。
  // 现在：IndexedDB 存全量，localStorage 只当兼容镜像（测试与老路径仍读它）；
  // 两边都写不进去才降级截断，并把 degraded 暴露给 __app.raw()。
  var IDB_NAME = 'tokendesk';
  var IDB_STORE = 'kv';
  var IDB_KEY = 'rawlog.v3';
  var idbPromise = null;
  var idbOK = null;        // null=未知 / true / false
  var rawDegraded = false; // 全量只在内存（两个持久层都失败）

  function idbOpen() {
    if (idbPromise) return idbPromise;
    idbPromise = new Promise(function (resolve) {
      try {
        if (typeof indexedDB === 'undefined' || !indexedDB) return resolve(null);
        var req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = function () {
          var db = req.result;
          if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { resolve(null); };
        req.onblocked = function () { resolve(null); };
      } catch (e) { resolve(null); }
    });
    return idbPromise;
  }

  function idbSet(json) {
    return idbOpen().then(function (db) {
      if (!db) { idbOK = false; return false; }
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(IDB_STORE, 'readwrite');
          tx.objectStore(IDB_STORE).put(json, IDB_KEY);
          tx.oncomplete = function () { idbOK = true; resolve(true); };
          tx.onerror = function () { idbOK = false; resolve(false); };
          tx.onabort = function () { idbOK = false; resolve(false); };
        } catch (e) { idbOK = false; resolve(false); }
      });
    }, function () { idbOK = false; return false; });
  }

  function idbGet() {
    return idbOpen().then(function (db) {
      if (!db) return null;
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(IDB_STORE, 'readonly');
          var rq = tx.objectStore(IDB_STORE).get(IDB_KEY);
          rq.onsuccess = function () { resolve(rq.result || null); };
          rq.onerror = function () { resolve(null); };
        } catch (e) { resolve(null); }
      });
    }, function () { return null; });
  }

  function idbDel() {
    return idbOpen().then(function (db) {
      if (!db) return false;
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(IDB_STORE, 'readwrite');
          tx.objectStore(IDB_STORE).delete(IDB_KEY);
          tx.oncomplete = function () { resolve(true); };
          tx.onerror = function () { resolve(false); };
        } catch (e) { resolve(false); }
      });
    }, function () { return false; });
  }

  // 启动时把 IDB 里更全/更新的仓接管进内存（localStorage 镜像可能被配额砍过）
  function rawIdbAdopt() {
    return idbGet().then(function (txt) {
      if (!txt) return false;
      var o = null;
      try { o = JSON.parse(txt); } catch (e) { return false; }
      if (!o || !o.rows || !o.rows.length) return false;
      var cur = rawBase();
      // 与 localStorage 同口径：网关变了 / 仓里没有 base（升级前老仓）一律不认领
      if (!o.base || o.base !== cur) return false;
      var mem = rawLoad();
      if (num(o.at) < num(mem.at) || o.rows.length <= mem.rows.length) return false;
      rawStore = o;
      rawAggMem = {};
      rawVer++;
      rawDegraded = false;    // 全量已经从 IDB 读回来，不再是「仅内存」
      return true;
    }, function () { return false; });
  }

  var RAW_CAP = 40000;
  var RAW_KEEP_SEC = 7 * 86400 + 12 * 3600;
  var rawStore = null;
  var rawVer = 0;
  var rawAggMem = {};
  // 诊断用：本页第一次 rawLoad() 时看到的是哪个网关。凭证通道改成异步/延后加载后，
  // 启动期这里会拿到 ''（网关未知）→ 每次冷启动都判 base 不等 → 整仓清空重扫。
  // 由 __app.rawFirstBase() 只读暴露，harness 断言它必须等于当前网关。
  var rawFirstBase = null;

  // 网关指纹：日志仓必须记住自己属于哪个网关。仓里的令牌名 / 统计 / 覆盖率只对原网关有效，
  // 而 rawCovered() 只看 coverFrom —— 换网关后旧仓会被当成「已覆盖」直接零请求返回，
  // 于是统计和令牌名全是旧实例的。规范必须走 normBase()：`http://a` 与 `http://a/` 是同一网关，
  // 原样字符串比较会把同一网关误判成换网关、白清一次仓。
  function rawBase() { return normBase(typeof CFG !== 'undefined' && CFG ? CFG.newapiBase : '', ''); }

  /** 丢掉内存仓与聚合缓存，并让在飞的翻页/聚合结果作废（rawVer 是它们的代次标记） */
  function rawDropMem() {
    rawStore = null;
    rawAggMem = {};
    rawVer++;
  }

  function rawLoad() {
    var cur = rawBase();
    if (rawFirstBase === null) rawFirstBase = cur;
    // 内存仓短路前先比网关：预置切换 / 手改地址 / __app 直调都可能绕过显式 rawReset()，
    // 只靠调用点兜会漏路径。base 变了就丢内存仓，否则旧网关的行会继续冒充新网关数据。
    if (rawStore) {
      if (rawStore.base === cur) return rawStore;
      rawDropMem();
      cacheClearAll();
    }
    try {
      var s0 = localStorage.getItem(RAW_KEY);
      if (s0) {
        var o = JSON.parse(s0);
        if (o && o.rows && o.rows.length) {
          if (o.base === cur) { rawStore = o; return rawStore; }
          // 两种都整仓作废：① 网关换了；② 仓里没有 base（升级前写入的 v3 老仓）。
          // ② 不许「认领」当前网关——认领等于让一个来源不可验证的仓冒充「已覆盖」，
          // rawCovered() 短路后零请求返回，F8 的旧网关数据会原样复发（代价：升级后清一次缓存）。
          // 连旧网关的 HTTP 缓存一起清：否则同窗口的缓存响应（例如启动期那次空的 /api/log/）
          // 会直接命中，扫出 0 行还被标成「已覆盖」
          try { localStorage.removeItem(RAW_KEY); } catch (e0) { }
          rawAggMem = {};
          rawVer++;
          cacheClearAll();
        }
      }
    } catch (e) { }
    try { localStorage.removeItem(RAW_KEY_LEGACY); } catch (e2) { }   // v2 缓存一次性清掉
    rawStore = { at: 0, since: 0, newest: 0, pages: 0, complete: false, base: cur, rows: [] };
    return rawStore;
  }

  /** 换网关时整仓作废：只清 cache 不够，RAW_KEY 里的历史行会继续冒充新网关的数据 */
  function rawReset() {
    rawDropMem();
    try { localStorage.removeItem(RAW_KEY); } catch (e) { }
    try { localStorage.removeItem(RAW_KEY_LEGACY); } catch (e1) { }
    idbDel();                    // 换网关：IDB 里那份也必须作废，否则下次启动又被接管回来
    rawDegraded = false;
    cacheClearAll();
    rawLoad();
  }

  var rawSaveTimer = null;
  function rawSave(now) {
    if (rawSaveTimer) { clearTimeout(rawSaveTimer); rawSaveTimer = null; }
    if (!now) { rawSaveTimer = setTimeout(function () { rawSaveTimer = null; rawSave(true); }, 4000); return; }
    var st = rawLoad();
    st.at = Date.now();
    var json;
    try { json = JSON.stringify(st); } catch (e) { return; }
    // ① 主存：IndexedDB 全量（异步，不阻塞扫描）；失败只影响持久化，不影响内存里的数据
    idbSet(json);
    // ② 兼容镜像：localStorage。写不进去不再砍行 —— 全量已在 IDB，砍了只会制造「覆盖区间倒退」
    try { localStorage.setItem(RAW_KEY, json); rawDegraded = false; return; } catch (e) { }
    purgeLegacyCache();
    try { localStorage.setItem(RAW_KEY, json); rawDegraded = false; return; } catch (e2) { }
    rawDegraded = true;
    // ③ 只有 IDB 也不可用时才走老降级（内存 + 截断），否则全量留在 IDB 里
    if (idbOK === false) {
      for (var cut = 12000; cut >= 4000; cut -= 4000) {
        if (st.rows.length <= cut) break;
        st.rows.length = cut;
        st.known = false; st.complete = false;
        rawMeta();
        try { localStorage.setItem(RAW_KEY, JSON.stringify(st)); rawDegraded = false; return; } catch (e3) { }
      }
    }
  }

  function rawCovered(sinceSec) {
    var st = rawLoad();
    if (!st.rows.length) return false;
    if (st.complete) return true;
    if (st.capped) return true;   // 已到容量/翻页上限：再扫也扫不出更多，停止重复扫描
    return st.coverFrom != null && st.coverFrom <= sinceSec;
  }

  function rawMarkCovered(sinceSec) {
    var st = rawLoad();
    st.coverFrom = (st.coverFrom == null) ? sinceSec : Math.min(st.coverFrom, sinceSec);
  }

  function rawMeta() {
    var st = rawLoad();
    if (!st.rows.length) { st.since = 0; st.newest = 0; rawVer++; return; }
    var seenK = {}, uniq = [];
    for (var i = 0; i < st.rows.length; i++) {
      var k = rokey(st.rows[i]);
      if (seenK[k]) continue;
      seenK[k] = 1;
      uniq.push(st.rows[i]);
    }
    if (uniq.length !== st.rows.length) st.rows = uniq;
    var nowSec = Math.floor(Date.now() / 1000);
    var floorTs = nowSec - RAW_KEEP_SEC;
    var keep = st.rows.length;
    while (keep > 0 && st.rows[keep - 1][0] < floorTs) keep--;
    if (keep < st.rows.length) {
      st.rows.length = keep;
      if (st.coverFrom != null && st.coverFrom < floorTs) st.coverFrom = floorTs;
    }
    if (st.rows.length > RAW_CAP) {
      st.rows.length = RAW_CAP;
      var cutTs = st.rows[st.rows.length - 1][0];
      // 截断后我们「只有最近这一段」：coverFrom 必须推进到最老保留行（原来只在
      // coverFrom 非 null 时才推进，导致 rawCovered 永远算不出来），并打 capped 标记
      st.capped = true;
      if (st.coverFrom == null || st.coverFrom < cutTs) st.coverFrom = cutTs;
    }
    if (st.rows[0][0] < st.rows[st.rows.length - 1][0]) {
      st.rows.sort(function (a, b) { return b[0] - a[0]; });
    }
    st.newest = st.rows[0][0];
    st.since = st.rows[st.rows.length - 1][0];
    rawVer++;
  }

  // 去重键必须含日志 id：同一秒、同 token/model/用量的两条不同请求，靠前 5 位
  // 完全一样，会被当成同一条合并（少算一次请求，且 fillTiming 把 A 的时延写到 B）
  function rokey(r) {
    var k = r[0] + '|' + r[1] + '|' + r[3] + '|' + r[4] + '|' + r[5];
    return (r[11] == null || r[11] === '') ? k : (k + '|' + r[11]);
  }

  function logTiming(it) {
    var total = 0, ttft = 0, bad = 0, eff = '';
    var u = num(it && it.use_time);
    if (u > 0) total = Math.round(u * 1000);
    var o = null;
    try {
      o = it && it.other ? (typeof it.other === 'string' ? JSON.parse(it.other) : it.other) : null;
    } catch (e) { o = null; }
    if (o && typeof o === 'object') {
      var fr = num(o.frt);
      if (fr > 0) ttft = Math.round(fr);
      var ss = o.stream_status || null;
      if (ss && typeof ss === 'object' && String(ss.status || '') === 'error') bad = 1;
      if (o.reasoning_effort != null) eff = String(o.reasoning_effort).slice(0, 12);
      var ai = o.admin_info || null;
      var pol = ai && ai.request_policy;
      if (pol && pol.length) {
        for (var i = pol.length - 1; i >= 0; i--) {
          var el = num(pol[i] && pol[i].elapsed_ms);
          if (el > 0) { total = Math.round(el); break; }
        }
      }
    }
    if (ttft > total) ttft = 0;
    return [total, ttft, bad, eff];
  }

  function logRow(it) {
    var t = logTiming(it);
    return [num(it.created_at), it.token_id, it.token_name, it.model_name,
      num(it.prompt_tokens), num(it.completion_tokens), num(it.quota), t[0], t[1], t[2], t[3],
      (it.id == null ? '' : it.id)];
  }

  function rowIdx(st, n) {
    var idx = {}, lim = Math.min(n || 400, st.rows.length);
    for (var i = 0; i < lim; i++) idx[rokey(st.rows[i])] = st.rows[i];
    return idx;
  }

  function fillTiming(idx, row) {
    var o = idx[rokey(row)];
    if (!o) return false;
    var changed = false;
    if (row[7]) {
      if (o[7] !== row[7] || o[8] !== row[8] || (o[9] || 0) !== (row[9] || 0)) {
        o[7] = row[7];
        o[8] = row[8];
        o[9] = row[9] || 0;
        changed = true;
      }
    }
    if (row[10] && o[10] !== row[10]) { o[10] = row[10]; changed = true; }
    return changed;
  }

  function rawAggFor(range) {
    var w = rangeSince(range);
    var hit = rawAggMem[range];
    if (hit && hit.ver === rawVer) return hit.agg;
    var agg = {
      range: range, since: w.since, label: w.label,
      req: 0, prompt: 0, completion: 0, total: 0, quota: 0,
      pages: 0, capped: false, aborted: false, local: true,
      byKey: {}, byModel: {}, recent: [], at: Date.now()
    };
    var st = rawLoad();
    for (var i = 0; i < st.rows.length; i++) {
      var r = st.rows[i];
      if (r[0] < w.since) break;
      absorbParts(agg, r[1] != null ? ('#' + r[1]) : (r[2] || '(未命名令牌)'), r[2], r[3], r[4], r[5], r[6], r[0], r[7], r[8], r[9], r[10]);
    }
    agg.pages = Math.max(1, Math.round(st.rows.length / 100));
    agg.capped = !!st.capped;
    rawAggMem[range] = { ver: rawVer, agg: agg };
    return agg;
  }

  function cacheClearAll() {
    cacheMem = {};
    try {
      var keys = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && (k.indexOf(CACHE_PREFIX) === 0 || k.indexOf(USAGE_PREFIX) === 0)) keys.push(k);
      }
      keys.forEach(function (k) { localStorage.removeItem(k); });
    } catch (e) { }
  }

  // ── 凭证通道（Wave B）：4 个敏感键走 Android Keystore，不再落 localStorage 明文
  // 契约（MainActivity.java:246-266 / SecureStore.java:82-154）：
  //   secureAvailable():boolean  只验 KeyStore 能否 load —— true 不等于写得进去
  //   secureSet(k,v):boolean     false = 键不在白名单 / 加密失败，必须回退并告知用户
  //   secureGet(k):String        null = 没存过
  // addJavascriptInterface 的方法在 JS 侧是同步调用，所以 loadCfg() 保持同步，
  // CFG.newapiBase 必然在任何 rawLoad() 之前就绪（异步化会让启动期 rawBase() 拿到 ''，
  // 每次冷启动都判网关不等 → 整仓清空重扫）。
  var SECURE_KEYS = ['newapiBase', 'newapiToken', 'hubBase', 'hubPass'];
  var SECURE_ERR = '';      // 非空 = 设置页标红
  var secureProbed = null;  // null 未探测 / true 可用 / false 不可用
  var secureDead = false;   // 首次写入被拒后置位：此后一律回退明文，不反复重试

  function nativeBridge() { return window.NativeBridge || null; }

  function secureAvailable() {
    if (secureProbed !== null) return secureProbed;
    var b = nativeBridge();
    if (!b || typeof b.secureAvailable !== 'function') { secureProbed = false; return false; }
    try { secureProbed = !!b.secureAvailable(); } catch (e) { secureProbed = false; }
    return secureProbed;
  }

  function secureGet(k) {
    if (!secureAvailable()) return null;
    try {
      var v = nativeBridge().secureGet(k);
      return (v === null || v === undefined || v === '') ? null : String(v);
    } catch (e) { return null; }
  }

  /** 只在真写成功时返回 true。available=true 但首次写入被拒（真机 KeyStore 生成密钥失败）时，
   *  置 secureDead 让后续一律回退明文，并把原因留给设置页标红 —— 静默回退等于骗用户。 */
  function secureSet(k, v) {
    if (!secureAvailable() || secureDead) return false;
    try {
      if (nativeBridge().secureSet(k, v == null ? '' : String(v))) return true;
      secureDead = true;
      SECURE_ERR = '系统安全存储写入失败（' + k + '）：已回退本机存储，配置不会丢，但令牌是明文保存。';
    } catch (e) {
      secureDead = true;
      SECURE_ERR = '系统安全存储异常（' + k + '：' + String((e && e.message) || e) + '）：已回退本机存储。';
    }
    return false;
  }

  function plainCfg(o) {
    var out = {};
    for (var k in o) if (SECURE_KEYS.indexOf(k) < 0) out[k] = o[k];
    return out;
  }

  // 升级迁移：老版本把 4 个令牌明文写在 LS_KEY 里。安全通道可用时立刻搬进 Keystore
  // 并把明文块重写成不含令牌的版本（真机验收第③项「旧 localStorage 键已清空」）。
  function migrateCreds() {
    if (!secureAvailable()) return;
    var raw = '';
    try { raw = localStorage.getItem(LS_KEY) || ''; } catch (e) { return; }
    if (!raw) return;
    var leak = false;
    try {
      var o = JSON.parse(raw);
      for (var i = 0; i < SECURE_KEYS.length; i++) if (o && o[SECURE_KEYS[i]]) leak = true;
    } catch (e) { return; }
    if (leak) saveCfg();
  }

  // Wave B 关掉 file:// 万能跨源后，壳内「浏览器内核直连」对内网网关必然 CORS 失败；
  // 老版本默认 channel='browser'，这些用户升级后一开机全红。一次性迁移成 native。
  // 只在壳内做（无 NativeBridge 的网页版和测试环境保持原值），迁移后用户可自由改回。
  // 硬约束：不许调 saveCfg() —— 它会对 4 个敏感键各调一次 secureSet，直接撞 F16 的
  // 「开机过程 bridge 最多试一次」。所以这里只直接改 LS_KEY 里的 channel 字段。
  function migrateChannel() {
    try {
      if (!window.NativeBridge) return;
      if (localStorage.getItem(CHAN_MIG) === '1') return;
      if (CFG.channel === 'browser') {
        var raw = localStorage.getItem(LS_KEY);
        if (raw) {
          var o = JSON.parse(raw);
          if (o && typeof o === 'object') { o.channel = 'native'; localStorage.setItem(LS_KEY, JSON.stringify(o)); }
        }
        CFG.channel = 'native';
      }
      localStorage.setItem(CHAN_MIG, '1');
    } catch (e) { }
  }

  // 老版本（v1）的日志仓：一个 650KB 级的裸行数组，v3 起已由 RAW_KEY / RAW_KEY_LEGACY 接管。
  // 它不参与任何业务逻辑，却会一直躺在 localStorage 里（旧验收项「旧键必须已清空」就是它）。
  // 启动时无条件清掉：幂等、不碰桥、绝不碰 v3 的 RAW_KEY。
  try { localStorage.removeItem('tokendesk.rawlog.v1'); } catch (e) { }

  var CFG = loadCfg();
  migrateChannel();  // 必须在 boot() 之前：boot 的 saveCfg() 会把 CFG.channel 写回 LS
  migrateCreds();   // 必须留在 boot() 之前：迁移只搬凭证，不碰日志仓
  var S = {
    tab: 'overview',
    modelsExpanded: false,
    remOpen: {},
    tokens: null,
    over: null,
    usage: null,
    usageLive: null,
    wb: null,
    rate: null,
    busy: {},
    errors: {},
    hubToken: '',
    hubAt: 0,
    abort: false,
    reqlog: []
  };

  function loadCfg() {
    var c = {};
    for (var k in DEF) c[k] = DEF[k];
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (raw) {
        var o = JSON.parse(raw);
        for (var k2 in o) if (o[k2] !== undefined && o[k2] !== null) c[k2] = o[k2];
      }
    } catch (e) { }
    // 敏感键以 Keystore 为准（覆盖 localStorage 里的旧值）；读不到（没存过 / 无桥）就沿用明文值。
    // 这里必须同步：CFG 要在 boot() 之前定型。
    for (var si = 0; si < SECURE_KEYS.length; si++) {
      var sv = secureGet(SECURE_KEYS[si]);
      if (sv !== null) c[SECURE_KEYS[si]] = sv;
    }
    if (window.__BOOTSTRAP__) for (var k3 in window.__BOOTSTRAP__) c[k3] = window.__BOOTSTRAP__[k3];
    return c;
  }

  function saveCfg() {
    // 4 个敏感键先写 Keystore：写成功就从明文块里摘掉（真机要求 localStorage 不留令牌）；
    // 不可用（浏览器 / 无桥）或写失败（白名单外 / 加密失败）则回退进明文块，保证配置不丢，
    // 失败原因由 secureSet() 记进 SECURE_ERR 在设置页标红。
    var plain = plainCfg(CFG);
    for (var i = 0; i < SECURE_KEYS.length; i++) {
      var k = SECURE_KEYS[i];
      var v = CFG[k] == null ? '' : String(CFG[k]);
      if (!secureSet(k, v)) plain[k] = v;
    }
    try { localStorage.setItem(LS_KEY, JSON.stringify(plain)); } catch (e) { }
  }

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function pv(s, fixed) {
    if (!CFG.privacy) return esc(s);
    var t = String(s == null ? '' : s);
    var n = t.length;
    var w = fixed ? 4.6 : (n <= 3 ? 3.0 : (n <= 6 ? 4.4 : (n <= 12 ? 5.8 : 7.0)));
    return '<span class="pvm" style="width:' + w + 'em"></span>';
  }

  function num(n) { n = Number(n); return isFinite(n) ? n : 0; }
  function fmtInt(n) { return Math.round(num(n)).toLocaleString('en-US'); }

  function parseRate(st) {
    if (!st) return null;
    var unit = num(st.quota_per_unit) > 0 ? num(st.quota_per_unit) : 500000;
    var kind = String(st.quota_display_type || '').toUpperCase();
    var fx = num(st.usd_exchange_rate) || num(st.price) || 1;
    if (kind === 'CNY') return { unit: unit, cny: fx > 0 ? fx : 1, sym: '¥', kind: 'CNY' };
    if (kind === 'CUSTOM') {
      var cr = num(st.custom_currency_exchange_rate);
      return { unit: unit, cny: cr > 0 ? cr : 1, sym: String(st.custom_currency_symbol || '') || '¤', kind: 'CUSTOM' };
    }
    if (kind === 'USD') return { unit: unit, cny: 1, sym: '$', kind: 'USD' };
    return { unit: unit, cny: fx > 0 ? fx : 1, sym: '¥', kind: 'CNY' };
  }

  function rateInfo() {
    var r = S.rate || {};
    var unit = num(r.unit) > 0 ? num(r.unit) : 500000;
    var cny = num(r.cny) > 0 ? num(r.cny) : 1;
    return { unit: unit, cny: cny, sym: r.sym || (S.rate ? '¥' : '$') };
  }

  function cnyNum(q) {
    var r = rateInfo();
    return num(q) / r.unit * r.cny;
  }

  function cnyOf(q) {
    var r = rateInfo();
    var v = cnyNum(q);
    if (!isFinite(v)) return r.sym + '—';
    if (v === 0) return r.sym + '0';
    var a = Math.abs(v);
    if (a >= 1000) return r.sym + fmtInt(v);
    if (a >= 1) return r.sym + v.toFixed(2);
    if (a >= 0.01) return r.sym + v.toFixed(3);
    return r.sym + v.toFixed(4);
  }

  // 累计金额用中文紧凑单位：¥890,379 这种长串在窄屏上挤掉别的列，且一眼读不出量级。
  // 只用于「累计」，本期仍用 cnyOf 给精确值（¥70.44）。
  function cnyCompact(q) {
    var r = rateInfo();
    var v = cnyNum(q);
    if (!isFinite(v)) return r.sym + '—';
    var a = Math.abs(v);
    if (a < 10000) return cnyOf(q);
    if (a >= 1e8) return r.sym + (v / 1e8).toFixed(2) + ' 亿';
    return r.sym + (v / 1e4).toFixed(1) + ' 万';
  }

  function fmtTok(n) {
    n = Math.round(num(n));
    var a = Math.abs(n);
    if (a >= 1e12) return (n / 1e12).toFixed(2) + 'T';
    if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (a >= 1e4) return (n / 1e3).toFixed(1) + 'K';
    return fmtInt(n);
  }
  function fmtQty(n) {
    n = Math.round(num(n));
    if (n === 0) return '0';
    var a = Math.abs(n);
    if (a >= 1e12) return (n / 1e12).toFixed(2) + 'T';
    if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (a >= 1e4) return (n / 1e3).toFixed(1) + 'K';
    return fmtInt(n);
  }
  function pad2(x) { return x < 10 ? '0' + x : String(x); }
  function pctText(part, total) {
    if (!total) return '0%';
    var v = part / total * 100;
    if (v > 0 && v < 0.1) return '<0.1%';
    return v.toFixed(1) + '%';
  }
  function fmtShort(ts) {
    if (!ts) return '—';
    var d = (ts instanceof Date) ? ts : new Date(num(ts) * 1000);
    var p2 = function (n) { return n < 10 ? '0' + n : '' + n; };
    return p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
  }

  function hhmmss(ts) {
    var d = ts ? new Date(ts) : new Date();
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  function fmtTime(ts) {
    if (!ts || ts < 0) return '—';
    var d = new Date(num(ts) * 1000);
    return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function fmtDate(ts) {
    if (!ts || ts < 0) return '永不';
    var d = new Date(num(ts) * 1000);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function ago(ts) {
    if (!ts || ts < 0) return '—';
    var s = Math.max(0, Date.now() / 1000 - num(ts));
    if (s < 60) return '刚刚';
    if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
    if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
    return Math.floor(s / 86400) + ' 天前';
  }
  function rangeSince(range) {
    var now = Math.floor(Date.now() / 1000);
    if (range === 'today') {
      var d = new Date(); d.setHours(0, 0, 0, 0);
      return { since: Math.floor(d.getTime() / 1000), label: '今天 00:00 起' };
    }
    if (range === '7d') return { since: now - 7 * 86400, label: '最近 7 天' };
    return { since: now - 86400, label: '最近 24 小时' };
  }
  var RANGE_NAME = { today: '今天', '24h': '24 小时', '7d': '7 天' };
  var RECENT_MAX = 20;

  var toastTimer = null;
  function toast(msg, kind) {
    var el = $('#toast');
    el.textContent = msg;
    el.className = kind === 'err' ? 'err' : (kind === 'ok' ? 'ok' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = 'hidden'; }, 2600);
  }

  function setSub(text) { $('#hdsub').textContent = text; }

  var seq = 0;
  var pending = {};

  // 原生通道两段超时（与 Java 侧 HttpJobRegistry.clampTimeout 对齐）。JS 兜底窗口故意早于
  // Java 侧到期，是为了让「谁结束这次请求」由 JS 掌握：JS 先超时 → 立刻 cancel(id) 断连。
  // 否则 JS 已 reject、Java 还在跑，用户重试用新 id 时服务器会收到同一个 POST 两次。
  var NATIVE_CONNECT_MS = 8000;
  var NATIVE_READ_MS = 15000;
  var NATIVE_JS_CAP_MS = NATIVE_CONNECT_MS + NATIVE_READ_MS - 1000;

  window.__nativeHttp = function (id, payload) {
    var p = pending[id];
    if (!p) return;
    delete pending[id];
    var o;
    try { o = JSON.parse(payload); } catch (e) { o = { error: '返回体解析失败' }; }
    if (o && o.error) p.reject(new Error(o.error));
    else p.resolve(o);
  };

  function logReq(method, url, status, ms, via) {
    var tag = via === 'cache' ? 'CA' : (via === 'native' ? 'NT' : (via === 'browser' ? 'BG' : (/^https:/i.test(url) && CFG.channel !== 'native' ? 'BG' : 'NT')));
    S.reqlog.unshift({ at: Date.now(), m: method, u: url, s: status, ms: num(ms), via: tag });
    if (tag !== 'CA' && tag !== 'cache') S.net = (S.net || 0) + 1;
    if (S.reqlog.length > 40) S.reqlog.length = 40;
  }

  function http(method, url, headers, body, timeout) {
    timeout = timeout || 45000;
    var isHttps = /^https:/i.test(url);
    var useBrowser;
    if (CFG.channel === 'browser') useBrowser = true;
    else if (CFG.channel === 'native') useBrowser = false;
    else useBrowser = isHttps;
    if (useBrowser && typeof fetch === 'function') {
      return browserHttp(method, url, headers, body, timeout);
    }
    return nativeHttp(method, url, headers, body, timeout);
  }

  function browserHttp(method, url, headers, body, timeout) {
    var ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, timeout);
    var opt = { method: method, headers: headers || {}, credentials: 'omit' };
    if (ctrl) opt.signal = ctrl.signal;
    if (body) opt.body = body;
    var t0 = Date.now();
    return fetch(url, opt).then(function (r) {
      return r.text().then(function (t) {
        clearTimeout(timer);
        return { status: r.status, body: t, ms: Date.now() - t0, via: 'browser' };
      });
    }, function (e) {
      clearTimeout(timer);
      var msg = String((e && e.message) || e);
      if (/abort/i.test(msg)) throw new Error('请求超时（' + Math.round(timeout / 1000) + 's）：' + url);
      throw new Error('浏览器内核直连失败：' + msg + '（检查地址是否可达、网关是否允许跨源）');
    });
  }

  function nativeHttp(method, url, headers, body, timeout) {
    return new Promise(function (resolve, reject) {
      var id = 'r' + (++seq);
      var settled = false;
      var waitMs = Math.min(num(timeout) > 0 ? num(timeout) : 45000, NATIVE_JS_CAP_MS);
      pending[id] = {
        resolve: function (v) { settled = true; resolve(v); },
        reject: function (e) { settled = true; reject(e); }
      };
      setTimeout(function () {
        if (!settled && pending[id]) {
          // 顺序不能换：先通知 Java 停（断连），再清本地登记，最后 reject。
          // 少这一步就是「同一 POST 发两次」的根因。
          try {
            if (window.NativeBridge && typeof window.NativeBridge.cancel === 'function') window.NativeBridge.cancel(id);
          } catch (e) { }
          delete pending[id];
          reject(new Error('请求超时（' + Math.round(waitMs / 1000) + 's）：' + url));
        }
      }, waitMs);

      var bridge = window.NativeBridge;
      if (bridge && (typeof bridge.httpOpts === 'function' || typeof bridge.http === 'function')) {
        try {
          var hj = JSON.stringify(headers || {});
          var bd = body || '';
          if (typeof bridge.httpOpts === 'function') {
            bridge.httpOpts(id, method, url, hj, bd, JSON.stringify({ connectMs: NATIVE_CONNECT_MS, readMs: NATIVE_READ_MS }));
          } else {
            bridge.http(id, method, url, hj, bd);
          }
        } catch (e) {
          delete pending[id];
          if (!settled) reject(new Error('原生请求失败：' + e.message));
        }
        return;
      }

      delete pending[id];
      fetch(url, { method: method, headers: headers || {}, body: body || undefined })
        .then(function (r) {
          return r.text().then(function (t) {
            logReq(method, url, r.status, 0);
            resolve({ status: r.status, body: t, ms: 0, via: 'fetch' });
          });
        })
        .catch(function (e) { reject(new Error('网络错误：' + e.message)); });
    });
  }

  function trimBase(u) { return String(u || '').replace(/\/+$/, ''); }

  function looksUrl(v) {
    var t = String(v || '').trim();
    return /^https?:\/\//i.test(t) || /^[\w.-]+:\d{2,5}$/.test(t);
  }

  function looksToken(v) {
    var t = String(v || '').trim();
    return /^[A-Za-z0-9_\-]{20,80}$/.test(t);
  }

  function normBase(u, fallback) {
    var s2 = String(u == null ? '' : u).trim()
      .replace(/^[\s\u3000]+|[\s\u3000]+$/g, '')
      .replace(/：/g, ':')
      .replace(/\s+/g, '');
    if (!s2) return fallback || '';
    if (!/^https?:\/\//i.test(s2)) {
      s2 = (/^localhost|^127\.|^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(s2) ? 'http://' : 'https://') + s2;
    }
    return s2.replace(/\/+$/, '');
  }

  function napiRaw(path, method, body, noCache) {
    if (!trimBase(CFG.newapiBase)) return Promise.reject(new Error('未填写 NewAPI 地址'));
    if (!CFG.newapiToken) return Promise.reject(new Error('未填写 NewAPI 管理令牌'));
    var verb0 = (method || 'GET').toUpperCase();
    var ckey = 'N ' + path;
    if (verb0 === 'GET' && !noCache) {
      var hit = cacheFresh(ckey);
      if (hit) { logReq('GET', path, 200, 0, 'cache'); return Promise.resolve(hit.v); }
    }
    var h = {
      'Authorization': 'Bearer ' + CFG.newapiToken,
      'New-Api-User': String(CFG.newapiUid || '1'),
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };
    var full = trimBase(CFG.newapiBase) + path;
    return http(method || 'GET', full, h, body ? JSON.stringify(body) : '')
      .then(function (r) {
        var j = null;
        try { j = JSON.parse(r.body); } catch (e) { }
        var snippet = String(r.body || '').replace(/\s+/g, ' ').slice(0, 120);
        if (r.status === 401 || r.status === 403) {
          throw new Error('NewAPI 鉴权失败（HTTP ' + r.status + '）\n地址：' + full +
            '\n该地址能连上，但令牌/用户 ID 不被接受。检查：①管理令牌是否「系统访问令牌」②用户 ID 是否本人 ③令牌是否被删/过期');
        }
        if (r.status >= 500) throw new Error('NewAPI 服务端错误（HTTP ' + r.status + '）：' + full + '\n' + snippet);
        if (r.status === 404) throw new Error('接口 404：' + full + '\n地址填错了（只填到端口，不要带 /api）');
        if (!j) throw new Error('NewAPI 返回非 JSON（HTTP ' + r.status + '）：' + full + '\n' + snippet);
        if (j.success === false) {
          var m = j.message || ('HTTP ' + r.status);
          throw new Error('NewAPI 报错：' + m + '\n地址：' + full +
            (/未授权|token|unauthor/i.test(m) ? '\n提示：多半是管理令牌不对，或用户 ID 不是令牌所属用户' : ''));
        }
        logReq(method || 'GET', path, r.status, r.ms, r.via);
        if (verb0 === 'GET') cachePut(ckey, j.data);
        return j.data;
      });
  }

  var hubLoginPending = null;

  function hubLogin() {
    if (hubLoginPending) return hubLoginPending;
    hubLoginPending = hubLoginOnce().then(function (t) {
      hubLoginPending = null;
      return t;
    }, function (e) {
      hubLoginPending = null;
      throw e;
    });
    return hubLoginPending;
  }

  function hubLoginOnce() {
    if (!CFG.hubPass) return Promise.reject(new Error('未填写 账号池面板密码'));
    return http('POST', trimBase(CFG.hubBase) + '/panel/login',
      { 'Content-Type': 'application/json' }, JSON.stringify({ password: CFG.hubPass }), 20000)
      .then(function (r) {
        var j = null;
        try { j = JSON.parse(r.body); } catch (e) { }
        if (!j || !j.ok || !j.token) {
          var msg = (j && (j.error || j.message)) || ('HTTP ' + r.status);
          throw new Error('面板登录失败：' + msg);
        }
        S.hubToken = j.token;
        S.hubAt = Date.now();
        logReq('POST', '/panel/login', r.status, r.ms, r.via);
        return j.token;
      });
  }

  function hubRaw(path, method, body, retried, noCache) {
    if (!trimBase(CFG.hubBase)) return Promise.reject(new Error('未填写 账号池地址'));
    var verb0 = (method || 'GET').toUpperCase();
    var ckey = 'H ' + path;
    if (verb0 === 'GET' && !noCache) {
      var hit = cacheFresh(ckey);
      if (hit) { logReq('GET', path, 200, 0, 'cache'); return Promise.resolve(hit.v); }
    }
    var pre = S.hubToken ? Promise.resolve(S.hubToken) : hubLogin();
    return pre.then(function (tok) {
      var h = { 'Content-Type': 'application/json', 'X-Panel-Token': tok };
      var url = trimBase(CFG.hubBase) + path;
      var verb = (method || 'GET').toUpperCase();
      var idempotent = verb === 'GET' || verb === 'HEAD';
      function attempt(n) {
        return http(verb, url, h, body !== undefined ? JSON.stringify(body) : '').catch(function (e) {
          if (!idempotent || n >= 2 || !/失败|超时|reset|ERR_/i.test(e.message)) throw e;
          return new Promise(function (res) { setTimeout(res, 900 * (n + 1)); }).then(function () { return attempt(n + 1); });
        });
      }
      return attempt(0);
    }).then(function (r) {
      var j = null;
      try { j = JSON.parse(r.body); } catch (e) { }
      if (r.status === 401 && !retried) {
        S.hubToken = '';
        return hubRaw(path, method, body, true, noCache);
      }
      if (r.status >= 400) {
        var inner = j && j.error && (j.error.message || j.error);
        throw new Error((inner || (j && j.message) || ('账号池接口 HTTP ' + r.status)) +
          '\n地址：' + trimBase(CFG.hubBase) + path);
      }
      logReq(method || 'GET', path, r.status, r.ms);
      if (verb0 === 'GET') cachePut(ckey, j);
      return j;
    });
  }

  function normTokens(data) {
    var items = (data && data.items) || (Array.isArray(data) ? data : []);
    return items.map(function (t) {
      var models = String(t.model_limits || '').split(',').map(function (s) { return s.trim(); })
        .filter(function (s) { return !!s; });
      return {
        id: t.id,
        name: t.name || ('#' + t.id),
        status: num(t.status),
        unlimited: !!t.unlimited_quota,
        remain: num(t.remain_quota),
        used: num(t.used_quota),
        expired: num(t.expired_time),
        accessed: num(t.accessed_time),
        models: models,
        raw: t
      };
    }).sort(function (a, b) { return b.used - a.used; });
  }

  function loadAllTokens(noCache) {
    var limit = 100;
    var cap = 1000;
    var items = [];
    function page(p) {
      return napiRaw('/api/token/?p=' + p + '&page_size=' + limit, 'GET', undefined, noCache).then(function (d) {
        var got = (d && d.items) || [];
        items = items.concat(got);
        var total = d && d.total != null ? num(d.total) : items.length;
        var more = got.length === limit && items.length < Math.min(total, cap);
        if (!more) return { items: items, total: total, truncated: total > items.length };
        return page(p + 1);
      });
    }
    return page(0);
  }

  function loadOverview(force) {
    if (S.busy.over && !force) return Promise.resolve();
    S.busy.over = true;
    setSub('读取 NewAPI 令牌…');
    return Promise.all([
      loadAllTokens(!!force),
      napiRaw('/api/status', 'GET', undefined, !!force).catch(function () { return null; })
    ]).then(function (res) {
      S.over = { at: Date.now(), tokenTotal: res[0].total, tokenTruncated: res[0].truncated };
      S.tokens = normTokens(res[0]);
      S.rate = parseRate(res[1]);
      delete S.errors.overview;
      setSub('已更新 ' + hhmmss());
    }).catch(function (e) {
      S.errors.overview = withNetHint(e.message);
      setSub('NewAPI 出错');
    }).then(function () {
      S.busy.over = false;
      if (S.tab === 'overview') renderOverview();
      if (S.tab === 'tokens') renderTokens();
    });
  }

  function applyLocalUsage(range, st, filling) {
    S.usage = rawAggFor(range);
    S.usage.filling = !!filling;
    S.usageLive = null;
    S.busy.usage = false;
    delete S.errors.usage;
    setSub('已更新 ' + hhmmss(st && st.at ? new Date(st.at) : new Date()) + ' · 本地');
    if (S.tab === 'overview') renderOverview();
    if (S.tab === 'usage') renderUsage();
    if (S.tab === 'tokens') renderTokens();
  }

  function loadUsage(range, force) {
    var wantRange = range || CFG.range;
    var w = rangeSince(wantRange);
    var st = rawLoad();

    if (!force && rawCovered(w.since)) {
      applyLocalUsage(wantRange, st);
      if (Date.now() - st.at > 60000) refreshUsageDelta();
      return Promise.resolve();
    }

    if (!force && st.rows.length && CFG.prefetch !== '0') {
      applyLocalUsage(wantRange, st, true);
      prefetchQueued = false;
      schedulePrefetch(200);
      return Promise.resolve();
    }

    S.busy.usage = true;
    if (S.tab === 'usage') renderUsage();
    var mine = ensureWindow(wantRange, w, force).then(function () {
      var st2 = rawLoad();
      if (!force && rawCovered(w.since)) applyLocalUsage(wantRange, st2);
    });
    S.usageP = mine;
    return mine.then(function () { if (S.usageP === mine) S.usageP = null; });
  }

  function absorbParts(agg, k, name, m, pt, ct, q, ts, totalMs, ttftMs, bad, eff) {
    name = name || '(未命名令牌)';
    m = m || '(未知模型)';
    pt = num(pt); ct = num(ct); q = num(q);
    var tk = pt + ct;

    agg.req++; agg.prompt += pt; agg.completion += ct; agg.total += tk; agg.quota += q;

    var K = agg.byKey[k] || (agg.byKey[k] = { name: name, req: 0, tokens: 0, prompt: 0, completion: 0, quota: 0, models: {} });
    K.name = name;
    K.req++; K.tokens += tk; K.prompt += pt; K.completion += ct; K.quota += q;
    var KM = K.models[m] || (K.models[m] = { req: 0, tokens: 0 });
    KM.req++; KM.tokens += tk;

    var M = agg.byModel[m] || (agg.byModel[m] = { req: 0, tokens: 0 });
    M.req++; M.tokens += tk;

    if (agg.recent.length < RECENT_MAX) {
      agg.recent.push({ created_at: ts, token_name: name, model_name: m,
        prompt_tokens: pt, completion_tokens: ct, quota: q,
        total_ms: num(totalMs), ttft_ms: num(ttftMs), bad: num(bad), effort: eff || '' });
    }
  }

  function clockOf(sec) {
    var d = new Date(num(sec) * 1000);
    var s = pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
    var n = new Date();
    if (d.getFullYear() !== n.getFullYear() || d.getMonth() !== n.getMonth() || d.getDate() !== n.getDate()) {
      s = pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + s;
    }
    return s;
  }

  function effortTag(eff) {
    var e = String(eff || '').trim();
    if (!e) return '';
    var k = e.toLowerCase();
    var label = (k === 'none' || k === 'null' || k === 'off') ? '关' : esc(e);
    return ' · <span class="eff e-' + esc(k.replace(/[^a-z0-9_-]/g, '')) + '">' + label + '</span>';
  }

  function speedText(r) {
    var ct = num(r && r.completion_tokens);
    var tot = num(r && r.total_ms);
    var ttft = num(r && r.ttft_ms);
    var bad = num(r && r.bad);
    if (!tot) return '—';
    var secs = (tot / 1000).toFixed(1) + ' s';
    if (ct <= 0) return bad ? '中断 · ' + secs : secs;
    var gen = tot - ttft;
    var tps = 0;
    if (ttft > 0 && gen > 200) tps = ct / (gen / 1000);
    else if (tot > 0) tps = ct / (tot / 1000);
    var parts = [];
    if (tps > 0) parts.push(Math.round(tps) + ' t/s');
    if (ttft > 0) parts.push('<span class="ttft">' + (ttft / 1000).toFixed(1) + ' s</span>');
    if (!parts.length) return secs;
    return parts.join(' ');
  }

  function absorb(agg, it) {
    var k = it.token_id != null ? ('#' + it.token_id) : (it.token_name || '(未命名令牌)');
    var t = logTiming(it);
    absorbParts(agg, k, it.token_name, it.model_name,
      it.prompt_tokens, it.completion_tokens, it.quota, it.created_at, t[0], t[1], t[2], t[3]);
  }

  function toggleAccount(uid, enable) {
    if (S.busy.acc) return;
    var apply = function () {
      S.busy.acc = uid;
      renderWB();
      toast(enable ? '正在启用…' : '正在停用…');
      hubRaw('/accounts/set', 'POST', { uid: uid, enabled: enable }).then(function (r) {
        var a = (r && r.account) || {};
        var nickname = a.nickname || uid.slice(0, 8);
        var list = (S.wb && S.wb.accounts && S.wb.accounts.accounts) || [];
        list.forEach(function (x) { if (x.uid === uid) x.enabled = (a.enabled != null ? a.enabled : enable); });
        if (S.wb && S.wb.health) {
          var on = list.filter(function (x) { return x.enabled; }).length;
          S.wb.health.accounts_ready = on;
        }
        S.busy.acc = '';
        renderWB();
        if (S.tab === 'overview') renderOverview();
        toast(nickname + (enable ? ' 已启用' : ' 已停用'), 'ok');
        hubRaw('/accounts?realm=all').then(function (v) {
          if (S.wb && v && v.accounts) { S.wb.accounts = v; if (S.tab === 'wb') renderWB(); }
        }, function () {});
      }, function (e) {
        S.busy.acc = '';
        renderWB();
        toast('操作失败：' + String(e.message).split('\n')[0], 'err');
      });
    };
    if (enable) { apply(); return; }
    confirmSheet('停用这个账号？', '账号会立刻退出账号池：不再参与任务，也不再被派发请求（随时可再打开开关恢复）。', apply);
  }

  function loadWB(force) {
    if (S.busy.wb && !force) return Promise.resolve();
    S.busy.wb = true;
    setSub('读取 账号池面板…');
    var nc = !!force;
    var jobs = [
      ['health', hubRaw('/health', 'GET', undefined, undefined, nc)],
      ['accounts', hubRaw('/accounts?realm=all', 'GET', undefined, undefined, nc)],
      ['sched', hubRaw('/scheduler', 'GET', undefined, undefined, nc)],
      ['models', Promise.all([hubRaw('/v1/models?realm=cn', 'GET', undefined, undefined, nc),
                             hubRaw('/v1/models?realm=intl', 'GET', undefined, undefined, nc)])],
      ['remain', hubRaw('/usage/remaining', 'GET', undefined, undefined, nc)],
      ['analytics', hubRaw('/usage/analytics?realm=all', 'GET', undefined, undefined, nc)],
      ['analyticsCn', hubRaw('/usage/analytics?realm=cn', 'GET', undefined, undefined, nc)],
      ['analyticsIntl', hubRaw('/usage/analytics?realm=intl', 'GET', undefined, undefined, nc)],
      ['credToday', hubRaw('/usage/analytics?realm=all&range=today', 'GET', undefined, undefined, nc)]
    ];
    var out = { errors: {}, at: Date.now() };
    return Promise.all(jobs.map(function (j) {
      return j[1].then(function (v) { return { k: j[0], v: v, ok: true }; },
        function (e) { return { k: j[0], v: null, ok: false, e: e.message }; });
    })).then(function (rs) {
      rs.forEach(function (r) {
        if (r.ok) out[r.k] = r.v; else out.errors[r.k] = r.e;
      });
      if (out.models) out.models = { cn: (out.models[0] && out.models[0].data) || [], intl: (out.models[1] && out.models[1].data) || [] };
      S.wb = out;
      setSub('已更新 ' + hhmmss());
    }).then(function () {
      S.busy.wb = false;
      if (S.tab === 'wb') renderWB();
      if (S.tab === 'overview') renderOverview();
    });
  }

  function viewEl(name) { return $('.view[data-view="' + name + '"]'); }

  function withNetHint(msg) {
    if (/^http:\/\/(192\.168|10\.|127\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(CFG.newapiBase)) {
      return msg + '\n提示：当前填的是局域网地址，只有在同一网络内可用；在外网请改用远程地址。';
    }
    return msg;
  }
  function errBox(msg) {
    var text = esc(msg).replace(/\n/g, '<br>');
    var isPublic = /^https:/i.test(CFG.newapiBase || '');
    // 壳内「浏览器内核直连失败」＝跨源被浏览器拦下（服务端没回 CORS 头），不是令牌/密码错。
    // 这类用户不该被留在死路上：给一个一键切回原生请求的按钮。判据只用 !!window.NativeBridge
    // （与 migrateChannel() 同一个判据），不看 secureAvailable()、也不猜用户填的是内网还是公网。
    var canNative = !!window.NativeBridge && CFG.channel !== 'native' && /浏览器内核直连失败/.test(String(msg || ''));
    return '<div class="errbox"><b>出错了</b>' + text +
      '<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">' +
      '<button class="btn ghost" style="height:36px;font-size:12px;flex:0 0 auto;padding:0 14px" data-err="retry">重试</button>' +
      '<button class="btn ghost" style="height:36px;font-size:12px;flex:0 0 auto;padding:0 14px" data-err="settings">去设置</button>' +
      (isPublic && presetReady('lan') ? '<button class="btn ok" style="height:36px;font-size:12px;flex:0 0 auto;padding:0 14px" data-err="lan">改用内网地址</button>' : '') +
      (canNative ? '<button class="btn ok" style="height:36px;font-size:12px;flex:0 0 auto;padding:0 14px" data-err="native">切回原生请求</button>' : '') +
      '</div></div>';
  }

  function renderOverview() {
    var el = viewEl('overview');
    var usage = S.usage;
    var live = S.usageLive;
    var show = live || usage;

    var html = '';

    if (S.errors.overview) html += errBox(S.errors.overview);

    var wb0 = S.wb;
    var cm0 = wb0 ? creditMap(wb0) : { today: {} };
    var credSum = 0, credHas = false;
    for (var ck0 in cm0.today) { credSum += num(cm0.today[ck0]); credHas = true; }

    html += '<div class="hero">' +
      '<div class="hero-top"><div>' +
      '<div class="hero-l">' + (show ? esc(show.label) : '用量') + ' Token' +
      (show && show.capped ? '（前 ' + show.pages + ' 页）' : '') + '</div>' +
      '<div class="hero-v mono">' + (show ? fmtTok(show.total) : (live ? '<span class="spin"></span>' : '—')) + '</div>' +
      '</div><button class="pill info" data-act="ov-range" title="点一下切换 今天 / 24 小时" ' +
      'style="border:0;font:inherit;cursor:pointer;display:inline-flex;align-items:center;gap:4px">' +
      esc(RANGE_NAME[(show && show.range) || CFG.range] || '24 小时') +
      '<span style="opacity:.65;font-size:11px">⇄</span></button></div>' +
      '<div class="hero-grid">' +
      '<div class="mini"><div class="k">请求</div><div class="v mono">' + (show ? fmtInt(show.req) : '—') + '</div></div>' +
      '<div class="mini"><div class="k">令牌 Key 数</div><div class="v mono">' + (S.tokens ? S.tokens.length : '—') + '</div></div>' +
      '<div class="mini"><div class="k">今日积分</div><div class="v mono cred">' + (credHas ? fmtCred(credSum) : '—') + '</div></div>' +
      '</div></div>';

    var keys = show ? Object.keys(show.byKey).map(function (k) {
      return { k: k, v: show.byKey[k] };
    }).sort(function (a, b) { return b.v.tokens - a.v.tokens; }).slice(0, 6) : [];

    html += '<div class="card"><div class="card-h"><div class="card-t">令牌消耗排行<span class="n">' +
      (show ? esc(show.label) : '') + '</span></div></div>';

    if (S.busy.usage) {
      html += '<div class="prog" id="ov-prog"><span class="spin"></span><span>统计中</span><div class="track"><i style="width:' +
        progressPct(S.usageLive) + '%"></i></div></div>';
    }
    if (!keys.length) {
      html += '<div class="empty">' + (S.busy.usage ? '正在汇总请求日志…' : '暂无数据，点右上角刷新') + '</div>';
    } else {
      var maxTok = keys[0].v.tokens || 1;
      keys.forEach(function (x) {
        var w = Math.max(2, Math.round(x.v.tokens / (show.total || maxTok) * 100));
        html += '<div class="row"><div class="grow"><div class="name">' + pv(x.v.name || x.k) + '</div>' +
          '<div class="bar"><i style="width:' + w + '%"></i></div></div>' +
          '<div class="val mono">' + fmtTok(x.v.tokens) + '<small>' + fmtInt(x.v.req) + ' 次</small></div></div>';
      });
    }
    html += '</div>';

    var recent = (show && show.recent) || [];
    html += '<div class="card"><div class="card-h"><div class="card-t">最近请求</div>' +
      '<span class="pill mute">' + (recent.length ? '最新 ' + Math.min(recent.length, RECENT_MAX) + ' 条' : '—') + '</span></div>';
    if (!recent.length) {
      html += '<div class="empty">暂无请求记录</div>';
    } else {
      recent.slice(0, RECENT_MAX).forEach(function (r) {
        html += '<div class="row"><div class="grow"><div class="name">' + esc(r.model_name || '—') + '</div>' +
          '<div class="meta">' + pv(r.token_name || '—') + ' · ' + clockOf(r.created_at) + ' · ' + speedText(r) + effortTag(r.effort) + '</div></div>' +
          '<div class="val mono">' + fmtTok(num(r.prompt_tokens) + num(r.completion_tokens)) + '</div></div>';
      });
    }
    html += '</div>';

    var wb = S.wb;
    html += '<div class="card"><div class="card-h"><div class="card-t">账号池面板</div>' +
      '<span class="pill ' + (wb && wb.health && wb.health.ok ? 'ok' : 'mute') + '">' +
      (wb && wb.health ? (wb.health.ok ? '在线' : '异常') : '未读取') + '</span></div>';
    if (!wb) {
      html += '<div class="empty">在「模型」页签加载面板数据</div>';
    } else {
      var accs = (wb.accounts && wb.accounts.accounts) || [];
      var totalRemain = 0, active = 0;
      accs.forEach(function (a) {
        var c = a.credits || {};
        totalRemain += num(c.remain);
        if (a.enabled) active++;
      });
      html += '<div class="kv"><span class="k">账号池</span><span class="v">' + (wb.health ? wb.health.accounts_ready + '/' + wb.health.accounts + ' 可用' : accs.length + ' 个') + '</span></div>' +
        '<div class="kv"><span class="k">启用账号</span><span class="v">' + active + ' / ' + accs.length + '</span></div>' +
        '<div class="kv"><span class="k">积分余额合计</span><span class="v mono">' + fmtQty(totalRemain) + '</span></div>' +
        '<div class="kv"><span class="k">调度器</span><span class="v">' + (wb.sched ? (wb.sched.enabled ? '运行中' : '已关闭') : '—') +
        (wb.sched && wb.sched.next_run_time ? ' · 下次 ' + esc(wb.sched.next_run_time.slice(5, 16)) : '') + '</span></div>';
    }
    html += '</div>';

    if (S.errors.usage) html += errBox(S.errors.usage);

    el.innerHTML = html;
  }

  function progressPct(agg) {
    if (!agg) return 5;
    return Math.min(95, 8 + Math.min(80, agg.pages * 5));
  }

  function tokUsedSum() {
    var s = 0;
    if (S.tokens) for (var i = 0; i < S.tokens.length; i++) s += num(S.tokens[i].used);
    return s;
  }

  function fmtCred(v) {
    v = num(v);
    if (v >= 10000) return fmtQty(v);
    var s = v.toFixed(2);
    var p = s.split('.');
    return p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + p[1];
  }

  function cumQuota(used, w) {
    var u = num(used);
    var win = w ? num(w.quota) : 0;
    return Math.max(u, win);
  }

  function renderTokens() {
    var el = viewEl('tokens');
    var html = '';

    if (S.busy.over && !S.tokens) html += '<div class="card"><div class="skel"></div><div class="skel" style="width:70%"></div></div>';
    if (S.errors.overview) html += errBox(S.errors.overview);

    var usage = S.usageLive || S.usage;
    var tTotal = (S.over && S.over.tokenTotal) || (S.tokens ? S.tokens.length : 0);
    var curRange = (usage && usage.range) || CFG.range;
    html += '<div class="card"><div class="card-h"><div class="card-t">令牌总览</div>' +
      '<span class="pill ' + (S.busy.usage ? 'warn' : 'mute') + '">' +
      (S.busy.usage ? '统计中' : esc(RANGE_NAME[curRange] || '')) + '</span></div>' +
      '<div class="seg" style="margin-bottom:10px">' +
      ['today', '24h', '7d'].map(function (r) {
        return '<button data-act="tok-range" data-range="' + r + '" class="' + (curRange === r ? 'on' : '') + '">' +
          RANGE_NAME[r] + '</button>';
      }).join('') + '</div>' +
      '<div class="tok-line" style="margin-top:8px">' +
      '<span><b class="mono">' + (S.tokens ? tTotal : '—') + '</b> Key</span>' +
      (S.over && S.over.tokenTruncated ? '<span class="pill warn">前 ' + S.tokens.length + '</span>' : '') +
      '<span><b class="mono">' + (usage ? fmtInt(usage.req) : '—') + '</b> 请求</span>' +
      '<span><b class="mono">' + (usage ? fmtTok(usage.total) : '—') + '</b> Token</span>' +
      '<span>本期 <b class="mono cny">' + (usage ? cnyOf(usage.quota) : '—') + '</b></span>' +
      '<span>累计 <b class="mono">' + (S.tokens ? cnyCompact(usage ? Math.max(tokUsedSum(), num(usage.quota)) : tokUsedSum()) : '—') + '</b></span>' +
      '</div>' +
      '</div>';

    if (!S.tokens) {
      html += '<div class="card"><div class="empty">还没有数据<br>点右上角「刷新」拉取令牌列表</div></div>';
      el.innerHTML = html;
      return;
    }

    html += '<div class="card"><div class="card-h"><div class="card-t">令牌列表</div>' +
      '<button class="tok-b ok" data-act="tok-new">＋ 新建</button></div>' +
      '<div class="tok-tools">' +
      '<input id="tok-q" type="search" placeholder="搜名称" value="' + esc(CFG.tokQuery || '') + '">' +
      '<select id="tok-sort">' +
      [['usage', '按消耗'], ['quota', '按剩余'], ['recent', '按最近'], ['name', '按名称']].map(function (o) {
        return '<option value="' + o[0] + '" ' + ((CFG.tokSort || 'usage') === o[0] ? 'selected' : '') + '>' + o[1] + '</option>';
      }).join('') + '</select></div>' +
      '<div class="seg" style="margin:0 0 8px">' +
      [['all', '全部'], ['on', '启用'], ['off', '停用'], ['exp', '将过期']].map(function (o) {
        return '<button data-act="tok-filter" data-f="' + o[0] + '" class="' + ((CFG.tokFilter || 'all') === o[0] ? 'on' : '') + '">' + o[1] + '</button>';
      }).join('') + '</div>' +
      '<div id="tok-list"></div></div>';

    html += '</div>';
    el.innerHTML = html;
    paintTokList();

    // 搜索框：只重画列表，不整页重画（否则每敲一个字都丢焦点）
    var qEl = $('#tok-q');
    if (qEl) {
      var qTimer = null;
      qEl.oninput = function () {
        CFG.tokQuery = qEl.value;
        if (qTimer) clearTimeout(qTimer);
        qTimer = setTimeout(function () { qTimer = null; saveCfg(); paintTokList(); }, 120);
      };
      qEl.onchange = function () { saveCfg(); paintTokList(); };
    }
    var sortEl = $('#tok-sort');
    if (sortEl) sortEl.onchange = function () {
      CFG.tokSort = sortEl.value;
      saveCfg();
      paintTokList();
    };
  }

  // 只重画列表容器：搜索框每敲一个字都要重排，整页 innerHTML 重画会丢焦点/光标。
  function paintTokList() {
    var box = $('#tok-list');
    if (!box) return;
    if (!S.tokens || !S.tokens.length) { box.innerHTML = '<div class="empty">没有令牌</div>'; return; }
    var usage = S.usageLive || S.usage;
    var now = Date.now();
    var q = String(CFG.tokQuery || '').trim().toLowerCase();
    var f = CFG.tokFilter || 'all';
    var sortKey = CFG.tokSort || 'usage';
    var soon = now + 7 * 86400 * 1000;

    function win(t) {
      if (!usage || !usage.byKey) return null;
      return usage.byKey['#' + t.id] || usage.byKey[t.name] || null;
    }
    var list = S.tokens.filter(function (t) {
      if (q && String(t.name).toLowerCase().indexOf(q) < 0) return false;
      var exp = t.expired > 0 ? t.expired * 1000 : 0;
      if (f === 'on' && t.status !== 1) return false;
      if (f === 'off' && t.status === 1) return false;
      if (f === 'exp' && !(exp && exp < soon)) return false;
      return true;
    });
    list.sort(function (a, b) {
      if (sortKey === 'name') return String(a.name).localeCompare(String(b.name), 'zh');
      if (sortKey === 'recent') return num(b.accessed) - num(a.accessed);
      if (sortKey === 'quota') {
        var qa = a.unlimited ? Infinity : num(a.remain), qb = b.unlimited ? Infinity : num(b.remain);
        return qb - qa;
      }
      var wa = win(a), wb2 = win(b);
      var va = wa ? num(wa.tokens) : 0, vb = wb2 ? num(wb2.tokens) : 0;
      if (vb !== va) return vb - va;
      return num(b.used) - num(a.used);
    });

    if (!list.length) { box.innerHTML = '<div class="empty">没有符合条件的令牌</div>'; return; }

    box.innerHTML = list.map(function (t) {
      var w = win(t);
      var isExpired = t.expired > 0 && t.expired * 1000 < now;
      // 状态不再单独占一个胶囊：启停按钮本身就是状态（点「停用」说明当前启用），
      // 停用的行在下面小字里标红「已停用」，整行也会变暗。
      var expiry = t.expired < 0 ? '永不过期' : (isExpired ? '已过期 ' + fmtDate(t.expired) : '至 ' + fmtDate(t.expired));

      return '<div class="tok' + (t.status === 1 ? '' : ' off') + '" data-id="' + t.id + '">' +
        '<div class="tok-h"><div class="tok-name">' + pv(t.name) + '</div>' +
        (isExpired ? '<span class="pill warn">过期</span>' : '') +
        '<button class="tok-b ' + (t.status === 1 ? 'warn' : 'ok') + '" data-act="toggle" data-id="' + t.id + '">' + (t.status === 1 ? '停用' : '启用') + '</button>' +
        '<button class="tok-b" data-act="edit" data-id="' + t.id + '">编辑</button>' +
        '<button class="tok-b" data-act="key" data-id="' + t.id + '">Key</button></div>' +
        '<div class="tok-line">' +
        '<span><b class="mono">' + (!usage ? '…' : fmtTok(w ? w.tokens : 0)) + '</b> Token</span>' +
        '<span><b class="mono">' + (!usage ? '—' : (w ? fmtInt(w.req) : '0')) + '</b> 请求</span>' +
        '<span><b class="mono cny">' + (!usage ? '…' : cnyOf(w ? w.quota : 0)) + '</b></span>' +
        '<span>累计 <b class="mono">' + cnyCompact(cumQuota(t.used, w)) + '</b></span>' +
        '</div>' +
        '<div class="tok-sub">' +
        (t.status === 1 ? '' : '<span style="color:#fca5a5">已停用</span>') +
        '<span>剩 ' + (t.unlimited ? '无限' : fmtQty(t.remain)) + '</span>' +
        '<span>' + esc(expiry) + '</span>' +
        '<span>' + ago(t.accessed) + '</span>' +
        '<span>' + (t.models.length ? '限 ' + t.models.length + ' 模型' : '不限模型') + '</span>' +
        '</div></div>';
    }).join('');
  }

  function setRange(r) {
    if (!r || r === CFG.range) return;
    CFG.range = r;
    saveCfg();
    renderTokens();
    loadUsage(r, false);
    toast('已切到「' + RANGE_NAME[r] + '」，列表按该时段消耗排序', 'ok');
  }

  function findToken(id) {
    id = Number(id);
    for (var i = 0; i < (S.tokens || []).length; i++) if (S.tokens[i].id === id) return S.tokens[i];
    return null;
  }

  var TOKEN_READONLY = { key: 1, created_time: 1, accessed_time: 1, used_quota: 1, DeletedAt: 1, user_id: 1 };

  function tokenBody(t, patch) {
    var raw = t.raw || {};
    var b = {};
    for (var k in raw) {
      if (Object.prototype.hasOwnProperty.call(raw, k) && !TOKEN_READONLY[k]) b[k] = raw[k];
    }
    if (b.id == null) b.id = t.id;
    if (b.name == null) b.name = t.name;
    if (b.expired_time == null) b.expired_time = -1;
    if (b.remain_quota == null) b.remain_quota = 0;
    if (b.unlimited_quota == null) b.unlimited_quota = !!t.unlimited;
    if (b.allow_ips == null) b.allow_ips = '';
    if (b.group == null) b.group = '';
    for (var k2 in (patch || {})) b[k2] = patch[k2];
    return b;
  }

  function putToken(body) {
    return napiRaw('/api/token/', 'PUT', body);
  }

  function toggleToken(id) {
    var t = findToken(id);
    if (!t) return;
    var next = num(t.raw.status) === 1 ? 2 : 1;
    confirmSheet(next === 1 ? '启用令牌' : '停用令牌',
      next === 1 ? '启用后该密钥立即恢复可用。' : '停用后使用「' + t.name + '」的所有调用会立即失败。',
      function () { doToggle(t, next); });
  }

  function doToggle(t, next) {
    toast(next === 1 ? '启用中…' : '停用中…');
    napiRaw('/api/token/?status_only=true', 'PUT', { id: t.id, status: next }).then(function () {
      toast(next === 1 ? '已启用「' + t.name + '」' : '已禁用「' + t.name + '」', 'ok');
      return loadOverview(true);
    }).catch(function (e) { toast(e.message, 'err'); });
  }

  // ── 分享给朋友的文案 ──────────────────────────────────────────
  // 第一次复制某枚令牌的密钥时，剪贴板里放的是这段（带接口地址/模型），之后只放纯密钥。
  var SHARE_MARK = 'tokendesk.tokshare.v1';
  function shareMarked(id) {
    try { return !!JSON.parse(localStorage.getItem(SHARE_MARK) || '{}')[id]; } catch (e) { return false; }
  }
  function markShared(id) {
    try {
      var o = {};
      try { o = JSON.parse(localStorage.getItem(SHARE_MARK) || '{}'); } catch (e) { o = {}; }
      o[id] = 1;
      localStorage.setItem(SHARE_MARK, JSON.stringify(o));
    } catch (e) { }
  }
  // 分享地址独立于「自己用的网关地址」：自己常用内网 IP，发给别人必须是公网域名。
  // 构建期可注入默认值（private/.env 的 TD_PRESET_SHARE_BASE），公开源码里不留真实域名。
  var SHARE_PRESET = '__PRESET_SHARE_BASE__';
  function shareBase() {
    if (CFG.shareBase) return trimBase(CFG.shareBase);
    if (presetOk(SHARE_PRESET)) return trimBase(SHARE_PRESET);
    return trimBase(CFG.newapiBase);
  }
  function modelLineOf(t) {
    var ml = (t && t.raw && t.raw.model_limits_enabled) ? String(t.raw.model_limits || '').trim() : '';
    return ml || '不限';
  }
  function shareTextFor(t, key, base) {
    var b = trimBase(base || shareBase());
    var k = 'sk-' + String(key || '').replace(/^sk-/, '');
    return '接口地址：' + b + '/v1\n' +
      '密钥：' + k + '\n' +
      '模型：' + modelLineOf(t) + '\n' +
      '自测：curl ' + b + '/v1/models -H "Authorization: Bearer ' + k + '"';
  }
  function copyToClip(text) {
    if (window.NativeBridge && window.NativeBridge.copy) window.NativeBridge.copy(text);
    else if (navigator.clipboard) navigator.clipboard.writeText(text);
  }

  function copyKey(id) {
    var t = findToken(id);
    if (!t) return;
    toast('读取密钥…');
    napiRaw('/api/token/' + t.id + '/key', 'POST', {}).then(function (d) {
      var key = d && d.key;
      if (!key) throw new Error('接口未返回密钥');
      if (!shareMarked(t.id)) {
        copyToClip(shareTextFor(t, key));
        markShared(t.id);
        toast('首次复制：已带上接口地址与模型', 'ok');
      } else {
        copyToClip('sk-' + String(key).replace(/^sk-/, ''));
        toast('密钥已复制（sk- 开头）', 'ok');
      }
    }).catch(function (e) { toast(e.message, 'err'); });
  }

  function modelChipsHtml(current, boxId, taSel) {
    if (!S.wb || !S.wb.models) return '<div class="hint">在「模型」页签加载一次后，这里会出现可点的模型快捷块</div>';
    var box = boxId || 'sh-models-chips';
    var picked = String(current || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
    var groups = [['cn', '国内版'], ['intl', '国际版']];
    var html = '';
    groups.forEach(function (g) {
      var list = (S.wb.models[g[0]] || []).slice().sort(function (a, b) { return String(a.id).localeCompare(String(b.id)); });
      if (!list.length) return;
      var prefix = g[0] === 'cn' ? 'cn:' : 'global:';
      html += '<div class="hint" style="margin:10px 0 4px">' + g[1] + '</div><div class="chips" data-chips="' + g[0] + '">';
      list.forEach(function (m) {
        var full = prefix + m.id;
        var on = picked.indexOf(full) >= 0 || picked.indexOf(m.id) >= 0;
        html += '<button class="chip pick' + (on ? ' on' : '') + '" data-model="' + esc(full) + '">' + esc(m.id) + '</button>';
      });
      html += '</div>';
    });
    return html ? '<div id="' + box + '">' + html + '</div>' : '';
  }

  // 快捷块 → 文本框：点击在「逗号分隔」的白名单里增删一项
  function bindModelChips(boxSel, taSel) {
    var box = $(boxSel);
    if (!box) return;
    box.onclick = function (e) {
      var b = e.target.closest('.chip');
      if (!b) return;
      var m = b.getAttribute('data-model');
      var ta = $(taSel);
      var arr = String(ta.value || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
      var i = arr.indexOf(m);
      if (i >= 0) { arr.splice(i, 1); b.classList.remove('on'); }
      else { arr.push(m); b.classList.add('on'); }
      ta.value = arr.join(',');
    };
  }

  // ── 新建令牌 ──────────────────────────────────────────────────
  // NewAPI 建令牌只回 {"success":true}（不返回 id），必须重拉列表按「名字 + 最新 created_time」找回，
  // 再 POST /api/token/<id>/key 拿密钥。这两步都实测过（0.1.x rc.45）。
  function createToken(name, opt) {
    var body = {
      name: name,
      remain_quota: opt.unlimited ? 0 : num(opt.quota),
      expired_time: num(opt.expired),
      unlimited_quota: !!opt.unlimited,
      model_limits_enabled: !!(opt.models && opt.models.length),
      model_limits: (opt.models || []).join(','),
      allow_ips: '',
      group: ''
    };
    toast('创建中…');
    return napiRaw('/api/token/', 'POST', body).then(function () {
      return loadOverview(true);
    }).then(function () {
      var t = null;
      (S.tokens || []).forEach(function (x) {
        if (x.name !== name) return;
        if (!t || num(x.raw.created_time) > num(t.raw.created_time)) t = x;
      });
      if (!t) throw new Error('已创建，但列表里没找到「' + name + '」，点右上角刷新一次');
      return napiRaw('/api/token/' + t.id + '/key', 'POST', {}).then(function (d) {
        if (!d || !d.key) throw new Error('已创建，但接口没返回密钥');
        return { t: t, key: d.key };
      });
    }).then(function (r) {
      hideSheet();
      openShareSheet(r.t, r.key);
    }).catch(function (e) { toast(e.message, 'err'); });
  }

  function newTokenSheet() {
    var html = '<div class="sheet-body">' +
      '<div class="sheet-title">新建令牌</div>' +
      '<div class="field"><label>名称</label><input id="nt-name" type="text" placeholder="给谁用就写谁"></div>' +
      '<div class="switch" style="margin-top:12px"><div><div class="lab">无限额度</div></div>' +
      '<div class="tgl" id="nt-unlimited"></div></div>' +
      '<div class="field" style="margin-top:14px"><label>额度（500000 ≈ $1）</label>' +
      '<input id="nt-quota" type="number" inputmode="numeric" value="500000"></div>' +
      '<div class="field"><label>过期时间</label><input id="nt-expired" type="text" value="-1" placeholder="-1 永不过期 / 2026-12-31"></div>' +
      '<div class="field"><label>模型白名单（留空=不限）</label><textarea id="nt-models" placeholder="cn:deepseek-v4.1-flash"></textarea>' +
      modelChipsHtml('', 'nt-models-chips', '#nt-models') + '</div>' +
      '<div class="sheet-acts"><button class="btn ghost" data-sheet="close">取消</button>' +
      '<button class="btn ok" data-sheet="create">创建</button></div></div>';
    showSheet(html);
    bindModelChips('#nt-models-chips', '#nt-models');

    var unlimitedEl = $('#nt-unlimited');
    unlimitedEl.onclick = function () {
      unlimitedEl.classList.toggle('on');
      $('#nt-quota').disabled = unlimitedEl.classList.contains('on');
    };

    $('[data-sheet="close"]').onclick = hideSheet;
    $('[data-sheet="create"]').onclick = function () {
      var name = String($('#nt-name').value || '').trim();
      if (!name) { toast('先填个名字', 'err'); return; }
      var unlimited = unlimitedEl.classList.contains('on');
      var quota = String($('#nt-quota').value || '').trim();
      if (!unlimited && (quota === '' || isNaN(parseInt(quota, 10)) || parseInt(quota, 10) < 0)) {
        toast('额度要填 0 或正整数（或用「无限额度」）', 'err'); return;
      }
      var exp = parseExpired(String($('#nt-expired').value || '').trim());
      if (exp === null) { toast('过期时间填 -1 或 YYYY-MM-DD', 'err'); return; }
      var models = String($('#nt-models').value || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
      createToken(name, { unlimited: unlimited, quota: quota, expired: exp, models: models });
    };
  }

  // 表单里的日期 → 秒；-1/留空 = 永不过期，非法返回 null
  function parseExpired(v) {
    var s = String(v || '').trim();
    if (!s || s === '-1') return -1;
    if (/^\d+$/.test(s)) return num(s);
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return null;
    var d = new Date(num(m[1]), num(m[2]) - 1, num(m[3]), 23, 59, 59);
    var t = Math.floor(d.getTime() / 1000);
    return isFinite(t) ? t : null;
  }

  // 建完/首次复制时的分享面板：地址可改（自己用内网、给别人用公网域名），文案可改
  function openShareSheet(t, key) {
    var html = '<div class="sheet-body">' +
      '<div class="sheet-title">' + pv(t.name) + ' · 分享</div>' +
      '<div class="field"><label>接口地址</label><input id="shs-base" type="url" value="' + esc(shareBase()) + '"></div>' +
      '<div class="field"><label>文案</label><textarea id="shs-text" style="min-height:118px"></textarea></div>' +
      '<div class="sheet-acts">' +
      '<button class="btn ghost" data-sheet="rawkey">只复制 Key</button>' +
      '<button class="btn ok" data-sheet="copy">复制文案</button></div></div>';
    showSheet(html);

    function paint() { $('#shs-text').value = shareTextFor(t, key, $('#shs-base').value); }
    paint();
    $('#shs-base').oninput = paint;
    $('#shs-base').onchange = function () {
      CFG.shareBase = trimBase($('#shs-base').value);
      saveCfg();
      paint();
    };
    $('[data-sheet="rawkey"]').onclick = function () {
      copyToClip('sk-' + String(key).replace(/^sk-/, ''));
      markShared(t.id);
      toast('已复制密钥（sk- 开头）', 'ok');
    };
    $('[data-sheet="copy"]').onclick = function () {
      copyToClip($('#shs-text').value);
      markShared(t.id);
      hideSheet();
      toast('分享文案已复制', 'ok');
    };
  }

  function openTokenSheet(id) {
    var t = findToken(id);
    if (!t) return;
    var modelsText = t.raw.model_limits || '';
    var html = '<div class="sheet-body">' +
      '<div class="sheet-title">' + pv(t.name) + '</div>' +
      '<div class="sheet-desc">修改会整对象回写到 NewAPI（含状态/额度/白名单），密钥不会被改动。</div>' +
      '<div class="switch"><div><div class="lab">无限额度</div><div class="desc">开启后忽略剩余额度限制</div></div>' +
      '<div class="tgl ' + (t.raw.unlimited_quota ? 'on' : '') + '" id="sh-unlimited"></div></div>' +
      '<div class="field" style="margin-top:14px"><label>剩余额度（quota 单位）</label>' +
      '<input id="sh-remain" type="number" inputmode="numeric" value="' + num(t.raw.remain_quota) + '" ' +
      (t.raw.unlimited_quota ? 'disabled' : '') + '></div>' +
      '<div class="field"><label>过期时间</label>' +
      '<input id="sh-expired" type="text" value="' + (t.expired < 0 ? '-1' : fmtDate(t.expired)) + '" placeholder="-1 表示永不过期 或 2026-12-31">' +
      '<div class="hint">留 -1 永不过期；也可填 YYYY-MM-DD</div></div>' +
      '<div class="field"><label>模型白名单（逗号分隔，留空=不限）</label>' +
      '<textarea id="sh-models" placeholder="cn:hy3,global:deepseek-v4.1-flash">' + esc(modelsText) + '</textarea>' +
      modelChipsHtml(modelsText) + '</div>' +
      '<div class="sheet-acts">' +
      '<button class="btn danger" data-sheet="delete">删除</button>' +
      '<button class="btn ghost" data-sheet="close">取消</button>' +
      '<button class="btn ok" data-sheet="save">保存</button>' +
      '</div></div>';

    showSheet(html);

    bindModelChips('#sh-models-chips', '#sh-models');

    var unlimitedEl = $('#sh-unlimited');
    unlimitedEl.onclick = function () {
      unlimitedEl.classList.toggle('on');
      $('#sh-remain').disabled = unlimitedEl.classList.contains('on');
    };

    $('[data-sheet="close"]').onclick = hideSheet;
    $('[data-sheet="save"]').onclick = function () {
      var unlimited = unlimitedEl.classList.contains('on');
      var remainRaw = String($('#sh-remain').value || '').trim();
      var remain = parseInt(remainRaw, 10);
      if (!unlimited) {
        if (!remainRaw || isNaN(remain) || remain < 0) { toast('剩余额度要填 0 或正整数（或用「无限额度」）', 'err'); return; }
        if (remain === 0 && num(t.raw.remain_quota) > 0) {
          confirmSheet('把额度改成 0？', '额度为 0 会让使用「' + t.name + '」的调用立刻被拒绝。', function () {
            $('#sh-remain').value = '0';
            doSave();
          });
          return;
        }
      }
      doSave();

      function doSave() {
        var expRaw = String($('#sh-expired').value || '').trim();
        var exp = -1;
        if (expRaw && expRaw !== '-1') {
          var ms = Date.parse(expRaw.replace(/\//g, '-') + (expRaw.length <= 10 ? 'T23:59:59' : ''));
          if (isNaN(ms)) { toast('过期时间格式不对', 'err'); return; }
          exp = Math.floor(ms / 1000);
        }
        var models = String($('#sh-models').value || '').replace(/\s+/g, '');
        var body = tokenBody(t, {
          unlimited_quota: unlimited,
          remain_quota: unlimited ? 0 : remain,
          expired_time: exp,
          model_limits_enabled: !!models,
          model_limits: models
        });
        toast('保存中…');
        putToken(body).then(function () {
          hideSheet();
          toast('已保存', 'ok');
          return loadOverview(true);
        }).catch(function (e) { toast(e.message, 'err'); });
      }
    };

    $('[data-sheet="delete"]').onclick = function () {
      confirmSheet('删除令牌', '「' + t.name + '」删除后不可恢复，使用该密钥的调用方会立即失效。', function () {
        napiRaw('/api/token/' + t.id, 'DELETE', {}).then(function () {
          hideSheet();
          toast('已删除', 'ok');
          return loadOverview(true);
        }).catch(function (e) { toast(e.message, 'err'); });
      });
    };
  }

  function renderUsage() {
    var el = viewEl('usage');
    var agg = S.usageLive || S.usage;
    var html = '';

    html += '<div class="seg">' +
      ['today', '24h', '7d'].map(function (r) {
        return '<button data-range="' + r + '" class="' + (CFG.range === r ? 'on' : '') + '">' + RANGE_NAME[r] + '</button>';
      }).join('') + '</div>';

    if (S.errors.usage) html += errBox(S.errors.usage);

    if (!agg) {
      html += '<div class="card"><div class="empty">还没有数据</div></div>';
      el.innerHTML = html;
      bindUsage();
      return;
    }

    html += '<div class="card">' +
      '<div class="card-h"><div class="card-t">' + esc(agg.label) +
      (agg.capped ? '（前 ' + agg.pages + ' 页）' : '') + '</div>' +
      '<span class="pill ' + (S.busy.usage ? 'warn' : (agg.partial ? 'warn' : 'mute')) + '" id="usage-state">' +
      (S.busy.usage ? '统计中' : (agg.filling ? '补齐中' : (agg.partial ? '部分数据' : (agg.capped ? '已截断' : (agg.local ? '本地' : '完成'))))) + '</span></div>' +
      '<div class="hero-grid" style="margin-top:2px">' +
      '<div class="mini"><div class="k">Token</div><div class="v mono">' + fmtTok(agg.total) + '</div></div>' +
      '<div class="mini"><div class="k">请求</div><div class="v mono">' + fmtInt(agg.req) + '</div></div>' +
      '<div class="mini"><div class="k">页数</div><div class="v mono" id="usage-pages">' + agg.pages + '</div></div>' +
      '</div>' +
      (S.busy.usage
        ? '<div class="prog" id="usage-prog"><span class="spin"></span><span id="usage-progtxt">已扫描 ' + agg.pages + ' 页 · ' + fmtInt(agg.req) + ' 请求</span>' +
          '<div class="track"><i style="width:' + progressPct(agg) + '%"></i></div>' +
          '<button class="btn ghost" style="flex:0 0 auto;height:28px;padding:0 10px;font-size:11px" id="usage-stop">停止</button></div>'
        : '<div class="note" id="usage-done">已扫描 ' + agg.pages + ' 页 · ' + fmtInt(agg.req) + ' 请求</div>') +
      (function () {
        var st2 = rawLoad();
        if (!st2.rows.length) return '';
        return '<div class="note" style="margin-top:6px">本机 <b class="mono" style="color:#e6edf3">' + fmtInt(st2.rows.length) +
          '</b> 条 · <span class="mono" style="color:#9fb3c8">' + fmtShort(st2.since) + ' → ' + fmtShort(st2.newest) +
          '</span>' + (rawDegraded ? ' <span class="pill warn">仅内存</span>' : '') + '</div>';
      })() +
      '<div class="note" style="margin-top:8px">输入 ' + fmtTok(agg.prompt) + ' · 输出 ' + fmtTok(agg.completion) +
      (agg.filling ? ' · 补齐中' : '') +
      (agg.capped ? ' · 已达翻页上限，去设置调大' : '') +
      (agg.partial ? ' · 第 ' + (agg.pages + 1) + ' 页失败（' + esc(agg.partial) + '）' : '') + '</div>' +
      '</div>';

    var keys = Object.keys(agg.byKey).map(function (k) { return { k: k, v: agg.byKey[k] }; })
      .sort(function (a, b) { return b.v.tokens - a.v.tokens; });
    html += '<div class="card"><div class="card-h"><div class="card-t">按令牌</div><span class="pill mute">' + keys.length + ' 个</span></div>';
    if (!keys.length) html += '<div class="empty">没有请求</div>';
    var maxK = keys.length ? (keys[0].v.tokens || 1) : 1;
    keys.forEach(function (x) {
      var pct = Math.max(2, Math.round(x.v.tokens / (agg.total || maxK) * 100));
      html += '<div class="row tap" data-key="' + esc(x.k) + '"><div class="grow">' +
        '<div class="name">' + pv(x.v.name || x.k) + '</div>' +
        '<div class="meta">' + fmtInt(x.v.req) + ' 次 · 输入 ' + fmtTok(x.v.prompt) + ' / 输出 ' + fmtTok(x.v.completion) +
        ' · 占比 ' + pctText(x.v.tokens, agg.total) + '</div>' +
        '<div class="bar" style="margin-top:6px"><i style="width:' + pct + '%"></i></div>' +
        '</div><div class="val mono" style="padding-left:10px">' + fmtTok(x.v.tokens) + '</div></div>';
    });
    html += '</div>';

    var models = Object.keys(agg.byModel).map(function (k) { return { k: k, v: agg.byModel[k] }; })
      .sort(function (a, b) { return b.v.tokens - a.v.tokens; });
    html += '<div class="card"><div class="card-h"><div class="card-t">按模型</div><span class="pill mute">' + models.length + ' 个</span></div>';
    if (!models.length) html += '<div class="empty">没有请求</div>';
    var maxM = models.length ? (models[0].v.tokens || 1) : 1;
    models.forEach(function (x) {
      var pct = Math.max(2, Math.round(x.v.tokens / (agg.total || maxM) * 100));
      html += '<div class="row"><div class="grow"><div class="name">' + esc(x.k) + '</div>' +
        '<div class="meta">' + fmtInt(x.v.req) + ' 次 · 占比 ' + pctText(x.v.tokens, agg.total) + '</div>' +
        '<div class="bar dim" style="margin-top:6px"><i style="width:' + pct + '%"></i></div></div>' +
        '<div class="val mono" style="padding-left:10px">' + fmtTok(x.v.tokens) + '</div></div>';
    });
    html += '</div>';

    el.innerHTML = html;
    bindUsage();
  }

  function bindUsage() {
    var el = viewEl('usage');
    $$('[data-range]', el).forEach(function (b) {
      b.onclick = function () {
        CFG.range = b.getAttribute('data-range');
        saveCfg();
        renderUsage();
        loadUsage(CFG.range, false);
      };
    });
    var stop = $('#usage-stop', el);
    if (stop) stop.onclick = function () { S.abort = true; toast('已停止统计'); };
    $$('[data-key]', el).forEach(function (row) {
      row.onclick = function () { openKeySheet(row.getAttribute('data-key')); };
    });
  }

  function updateUsageProgress(agg, maxPages) {
    var prog = $('#usage-prog');
    if (!prog) return;
    var txt = $('#usage-progtxt');
    if (txt) txt.textContent = '已扫描 ' + agg.pages + ' 页 · ' + fmtInt(agg.req) + ' 请求';
    var track = prog.querySelector('.track > i');
    if (track) track.style.width = Math.min(95, 8 + Math.min(80, agg.pages / Math.max(1, maxPages) * 90)) + '%';
    var tile = $('#usage-pages');
    if (tile) tile.textContent = fmtInt(agg.pages);
  }

  function openKeySheet(key) {
    var agg = S.usage;
    if (!agg || !agg.byKey[key]) return;
    var v = agg.byKey[key];
    var rows = Object.keys(v.models).map(function (m) { return { m: m, d: v.models[m] }; })
      .sort(function (a, b) { return b.d.tokens - a.d.tokens; });
    var html = '<div class="sheet-body">' +
      '<div class="sheet-title">' + esc(v.name || key) + '</div>' +
      '<div class="sheet-desc">' + esc(agg.label) + ' · ' + fmtInt(v.req) + ' 次请求 · ' + fmtTok(v.tokens) + ' token</div>' +
      '<table class="tbl"><thead><tr><th>模型</th><th>请求</th><th>Token</th></tr></thead><tbody>' +
      rows.map(function (r) {
        return '<tr><td>' + esc(r.m) + '</td><td class="mono">' + fmtInt(r.d.req) + '</td><td class="mono">' + fmtTok(r.d.tokens) + '</td></tr>';
      }).join('') + '</tbody></table>' +
      '<div class="sheet-acts"><button class="btn ok" data-sheet="close">关闭</button></div></div>';
    showSheet(html);
    $('[data-sheet="close"]').onclick = hideSheet;
  }

  function nameKey(n) {
    return String(n || '').toLowerCase().replace(/^(cn|global|intl):/, '').trim();
  }

  function usedModels24h(wb) {
    var exact = {}, stripped = {};
    [['cn', wb.analyticsCn], ['intl', wb.analyticsIntl]].forEach(function (pair) {
      var realm = pair[0];
      ((pair[1] && pair[1].models) || []).forEach(function (m) {
        var req = num((m.window || {}).requests);
        if (req <= 0) return;
        var raw = String(m.model || '').toLowerCase();
        var e = realm + '|' + raw;
        exact[e] = (exact[e] || 0) + req;
        var sk = realm + '|' + nameKey(raw);
        stripped[sk] = (stripped[sk] || 0) + req;
      });
    });
    return { exact: exact, stripped: stripped };
  }

  function usedReq24(used, model, realm) {
    var r = String(realm || 'cn').toLowerCase();
    var raw = String(model || '').toLowerCase();
    if (used.exact[r + '|' + raw] != null) return used.exact[r + '|' + raw];
    var sk = r + '|' + nameKey(raw);
    return used.stripped[sk] != null ? used.stripped[sk] : 0;
  }

  function creditMap(wb) {
    var today = {}, all = {};
    var src = wb && wb.credToday && wb.credToday.accounts ? wb.credToday.accounts : [];
    src.forEach(function (a) {
      if (!a || !a.uid || /unattributed/i.test(a.uid)) return;
      today[a.uid] = num((a.window || {}).credit);
    });
    var src2 = wb && wb.analytics && wb.analytics.accounts ? wb.analytics.accounts : [];
    src2.forEach(function (a) {
      if (!a || !a.uid || /unattributed/i.test(a.uid)) return;
      all[a.uid] = num((a.all_time || a.window || {}).credit);
    });
    return { today: today, all: all, ok: src.length > 0 };
  }

  function resetOf(wb, uid, model) {
    var ws = (wb && wb.sched && wb.sched.windows) || [];
    var mk = nameKey(model || '');
    for (var i = 0; i < ws.length; i++) {
      var w = ws[i] || {};
      if (w.uid !== uid) continue;
      if (nameKey(w.model || '') !== mk) continue;
      if (num(w.reset_at) > 0) return num(w.reset_at);
    }
    return 0;
  }

  function remKey(m) { return (m.realm || '') + '|' + (m.model || ''); }

  // 冷却的真相以 /accounts 的 modelCooldowns 为准。
  // /usage/remaining 里的 rows 是按日志推算的，出现过 used=0、窗口 start>end 却标 cooling 的脏数据
  // （2026-10-21 实测：177****9351 / deepseek-v4.1-flash，hub 账号记录里 modelCooldowns 为空）。
  function accCoolRows(wb, m) {
    var now = Math.floor(Date.now() / 1000);
    var accs = (wb && wb.accounts && wb.accounts.accounts) || [];
    var mk = nameKey(m.model || '');
    var out = [];
    accs.forEach(function (a) {
      if (!a) return;
      if ((a.realm || '') !== (m.realm || '')) return;   // 账号只算自己所属区域
      ((a.modelCooldowns) || []).forEach(function (c) {
        if (!c || !c.model) return;
        if (nameKey(c.model) !== mk) return;
        var exp = num(c.expiresAt);
        if (!exp || exp <= now) return;
        out.push({ nickname: a.nickname, uid: a.uid, reset_at: exp });
      });
    });
    return out.sort(function (x, y) { return num(x.reset_at) - num(y.reset_at); });
  }

  // 保底路径：/accounts 拉失败时退回 /usage/remaining 的 rows，
  // 但只认「窗口内真的用掉了额度」的行（used>0），否则同一份脏数据会再显示一次。
  function remCoolRows(wb, m) {
    var rows = (wb && wb.remain && wb.remain.rows) || [];
    var now = Math.floor(Date.now() / 1000);
    var mk = nameKey(m.model || '');
    return rows.filter(function (r) {
      if (!r || !r.cooling) return false;
      if (num(r.used) <= 0) return false;
      if (num(r.reset_at) <= now) return false;
      if ((r.realm || '') !== (m.realm || '')) return false;
      return r.model === m.model || nameKey(r.model || '') === mk;
    }).sort(function (a, b) { return num(a.reset_at) - num(b.reset_at); });
  }

  function untilText(sec) {
    var d = num(sec) - Math.floor(Date.now() / 1000);
    if (d <= 0) return '已恢复';
    if (d < 3600) return Math.ceil(d / 60) + ' 分钟';
    if (d < 86400) return (d / 3600).toFixed(d < 36000 ? 1 : 0) + ' 小时';
    return (d / 86400).toFixed(1) + ' 天';
  }

  function accIssues(a) {
    var out = [], seen = {};
    var now = Math.floor(Date.now() / 1000);
    ((a && a.modelCooldowns) || []).forEach(function (c) {
      if (!c || !c.model) return;
      var exp = num(c.expiresAt);
      if (exp && exp <= now) return;
      var k = nameKey(c.model);
      if (seen[k]) return;
      seen[k] = 1;
      out.push({ model: c.model, reset: exp, kind: 'cool' });
    });
    ((a && a.disabledModels) || []).forEach(function (m) {
      if (!m) return;
      var k = nameKey(m);
      if (seen[k]) return;
      seen[k] = 1;
      out.push({ model: m, reset: 0, kind: 'off' });
    });
    return out;
  }

  function renderWB() {
    var el = viewEl('wb');
    var wb = S.wb;
    var html = '';

    if (S.busy.wb && !wb) {
      html += '<div class="card"><div class="skel"></div><div class="skel" style="width:60%"></div><div class="skel" style="width:80%"></div></div>';
    }
    if (wb && wb.errors) {
      var errs = Object.keys(wb.errors);
      if (errs.length) {
        html += errBox(errs.map(function (k) { return k + ': ' + wb.errors[k]; }).join('\n'));
      }
    }
    if (!wb) {
      html += '<div class="card"><div class="empty">还没有数据<br>点右上角「刷新」读取 账号池面板</div></div>';
      el.innerHTML = html;
      return;
    }

    var accs0 = (wb.accounts && wb.accounts.accounts) || [];
    var h = wb.health || {};
    var cm = creditMap(wb);
    function credOf(a) { return a && cm.today[a.uid] != null ? cm.today[a.uid] : null; }
    var realmTab = CFG.accRealm || 'all';
    var ranked = accs0.slice().sort(function (a, b) {
      var d = num(credOf(b)) - num(credOf(a));
      if (d) return d;
      return num((b.credits || {}).used) - num((a.credits || {}).used);
    });

    var accs = realmTab === 'all' ? ranked : ranked.filter(function (a) { return (a.realm || '') === realmTab; });
    var sumTab = 0;
    accs.forEach(function (a) { sumTab += num(credOf(a)); });
    var tabs = [['all', '全部'], ['cn', '国内版'], ['intl', '国外版']];
    html += '<div class="card"><div class="card-h"><div class="card-t">账号池<span class="n">按今日积分消耗</span></div>' +
      '<span class="pill ' + (h.ok ? 'ok' : 'mute') + '">' + (h.accounts_ready || 0) + '/' + (h.accounts || ranked.length) + ' 可用</span></div>' +
      '<div class="seg sm">' + tabs.map(function (t) {
        var n = t[0] === 'all' ? ranked.length : ranked.filter(function (a) { return (a.realm || '') === t[0]; }).length;
        return '<button data-act="acc-realm" data-realm="' + t[0] + '" class="' + (realmTab === t[0] ? 'on' : '') + '">' +
          t[1] + '<span class="c">' + n + '</span></button>';
      }).join('') + '</div>';
    if (!accs.length) {
      html += '<div class="empty">' + (ranked.length ? '这个区域没有账号' : '没有账号，或接口读取失败') + '</div>';
    } else {
      html += '<div class="note" style="margin-bottom:10px">今日消耗合计 <b class="mono" style="color:#e6edf3">' + sumTab.toFixed(2) +
        '</b> · ' + accs.length + ' 个账号' + (cm.ok ? '' : '（面板没返回按账号积分，数值可能为 —）') + '</div>';
    }
    var maxToday = (accs.length ? num(credOf(accs[0])) : 0) || 1;
    // 签到状态：hub 的 lastCheckin 是「真实签到动作」记录，而 credits.checkin.today_checked_in
    // 只是「拉积分那一刻」的快照——各账号快照时间不同（昨天 20:46 / 今天 05:10 / 08:10 …），
    // hub 统一签到后快照没跟上的账号一律显示未签到，而面板读 lastCheckin 是全绿的。
    // 所以以 lastCheckin 为准，缺失时（如 intl 号没有签到功能）才回落到快照逻辑。
    // 今天串由 Date.now() 推出（与 harness 的冻结时钟一致，禁止依赖 new Date() 的实时值）。
    var TODAY10 = (function () {
      var d = new Date(Date.now());
      return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    })();
    function ckText(a, ck) {
      var lc = a && a.lastCheckin;
      if (typeof lc === 'string' && lc) {
        return {
          text: lc.slice(0, 10) === TODAY10 ? '已签到' : '未签到',
          title: '面板签到记录 ' + lc + '（今天 ' + TODAY10 + '，以真实记录为准）'
        };
      }
      return {
        text: ck.active ? (ck.today_checked_in ? '已签到' : '未签到') : '无签到',
        title: ck.active ? '面板没返回签到记录，按积分快照判定' : '该账号无需签到'
      };
    }
    accs.forEach(function (a) {
      var c = a.credits || {};
      var dm = accIssues(a);
      var open = !!(S.accOpen && S.accOpen[a.uid]);
      var badges = '';
      if (a.inCooldown) badges += '<span class="pill warn">冷却中</span>';
      if (a.tokenExpired || a.needRelogin) badges += '<span class="pill off">需重登</span>';
      if (a.dailyLimitBlocked || a.creditLimitReached) badges += '<span class="pill warn">限流</span>';
      var ck = c.checkin || {};
      var ckt = ckText(a, ck);
      var today = num(credOf(a));
      var w = Math.max(2, Math.round(today / maxToday * 100));
      html += '<div class="acc' + (a.enabled ? '' : ' off') + '">' +
        '<div class="acc-main">' +
        '<div class="name">' +
        (dm.length ? '<span class="caret-hit" data-act="acc-expand" data-uid="' + esc(a.uid) + '">' +
          '<i class="caret' + (open ? ' open' : '') + '"></i></span>' : '') +
        pv(a.nickname || a.uid.slice(0, 8), true) +
        '<span class="pill ' + (a.realm === 'cn' ? 'info' : 'mute') + '">' + esc(a.realm || '?') + '</span>' + badges + '</div>' +
        '<div class="bar"><i style="width:' + w + '%"></i></div>' +
        '<div class="meta">剩余 ' + fmtQty(c.remain) + ' · 到期 ' +
        (c.earliest_expiring && c.earliest_expiring.cycle_end_time ? esc(String(c.earliest_expiring.cycle_end_time).slice(5, 10)) : '—') +
        ' · <span title="' + esc(ckt.title) + '">' + ckt.text + '</span>' +
        '</div>' +
        (dm.length && open ? '<div class="acc-more"><div class="acc-more-h">' +
          (dm.filter(function (x) { return x.kind === 'cool'; }).length
            ? '限流冷却 ' + dm.filter(function (x) { return x.kind === 'cool'; }).length + ' 个模型' : '') +
          (dm.filter(function (x) { return x.kind === 'off'; }).length
            ? (dm.filter(function (x) { return x.kind === 'cool'; }).length ? ' · ' : '') +
              '手动禁用 ' + dm.filter(function (x) { return x.kind === 'off'; }).length + ' 个' : '') +
          '</div>' +
          dm.map(function (x) {
            var rt = x.reset || resetOf(wb, a.uid, x.model);
            return '<div class="dm-row"><span class="dm-name">' + esc(x.model) + '</span>' +
              (x.kind === 'cool' ? '<span class="dm-tag cool">冷却</span>' : '<span class="dm-tag off">禁用</span>') +
              '<span class="dm-time">' + (rt ? '恢复 <b>' + fmtShort(rt) + '</b>' : '恢复 —') + '</span></div>';
          }).join('') + '</div>' : '') +
        '</div>' +
        '<div class="acc-end">' +
        '<div class="val mono">' + (credOf(a) == null ? '—' : today.toFixed(2)) + '<small>今日消耗</small></div>' +
        '<div class="sw' + (a.enabled ? ' on' : '') + '" role="switch" aria-checked="' + (a.enabled ? 'true' : 'false') + '" ' +
        'data-act="acc-toggle" data-uid="' + esc(a.uid) + '" data-on="' + (a.enabled ? '1' : '0') + '" ' +
        'title="' + (a.enabled ? '点击停用' : '点击启用') + '"><i></i></div>' +
        '</div></div>';
    });
    html += '</div>';

    var remAll = wb.remain && wb.remain.models ? wb.remain.models : [];
    var used24 = usedModels24h(wb);
    var rem = remAll.filter(function (m) { return usedReq24(used24, m.model, m.realm) > 0; });
    var filtered = rem.length > 0;
    if (!filtered) rem = remAll;
    rem = rem.slice().sort(function (a, b) {
      return usedReq24(used24, b.model, b.realm) - usedReq24(used24, a.model, a.realm);
    });
    html += '<div class="card"><div class="card-h"><div class="card-t">模型可用性<span class="n">24 小时用过的</span></div>' +
      '<span class="pill ' + (filtered ? 'info' : 'mute') + '">' + rem.length + ' 个</span></div>';
    if (!remAll.length) html += '<div class="empty">未返回模型额度数据</div>';
    else {
      var TOPN = 3;
      var shown = S.modelsExpanded ? rem.slice(0, 40) : rem.slice(0, TOPN);
      var folded = Math.max(0, Math.min(rem.length, 40) - shown.length);
      html += '<table class="tbl tbl5"><thead><tr><th>模型</th><th>区域</th><th>请求</th><th>可用</th><th>剩余</th></tr></thead><tbody>';
      shown.forEach(function (m) {
        var ok = num(m.available) > 0;
        var hit = usedReq24(used24, m.model, m.realm);
        // accounts 拿到就用它（权威）；拿不到才退回 /usage/remaining 的推算行
        var hasAcc = !!(wb.accounts && wb.accounts.accounts && wb.accounts.accounts.length);
        var cools = hasAcc ? accCoolRows(wb, m) : remCoolRows(wb, m);
        var coolN = cools.length;
        var availN = num(m.pairs) > 0 ? Math.max(0, num(m.pairs) - coolN - num(m.unknown)) : num(m.available);
        var rk = remKey(m);
        var open = cools.length > 0 && !!(S.remOpen && S.remOpen[rk]);
        html += '<tr' + (cools.length ? ' class="rem-row' + (open ? ' open' : '') + '" data-act="rem-toggle" data-key="' + esc(rk) + '"' : '') +
          (ok ? '' : ' style="opacity:.55"') + '><td title="' + esc(m.model) + '">' + esc(m.model) +
          (cools.length ? '<span class="rem-caret">▸</span>' : '') + '</td>' +
          '<td><span class="pill ' + (m.realm === 'cn' ? 'info' : 'mute') + '">' + esc(m.realm || '?') + '</span></td>' +
          '<td class="mono" style="text-align:right">' + (hit > 0 ? fmtInt(hit) : '—') + '</td>' +
          '<td class="mono">' + (coolN ? '<span class="pill warn">' + availN + ' / 冷' + coolN + '</span>'
            : '<span class="pill ' + (ok ? 'ok' : 'off') + '">' + num(m.available) + '</span>') + '</td>' +
          '<td class="mono">' + (m.total_remaining == null || num(m.total_remaining) === 0 ? '—' : fmtTok(m.total_remaining)) + '</td></tr>';
        if (open) {
          html += '<tr class="rem-detail"><td colspan="5"><div class="rem-list">' +
            cools.map(function (r) {
              var rt = num(r.reset_at);
              return '<div class="rem-i"><span class="rem-n">' + pv(r.nickname || String(r.uid || '').slice(0, 8), true) + '</span>' +
                '<span class="rem-t">' + fmtShort(rt) + ' · 剩 ' + untilText(rt) + '</span></div>';
            }).join('') + '</div></td></tr>';
        }
      });
      html += '</tbody></table>';
      if (rem.length > TOPN) {
        html += '<div class="tok-acts" style="margin-top:10px">' +
          '<button class="btn ghost" style="height:38px;flex:0 0 auto;padding:0 16px;font-size:12px" data-act="models-more">' +
          (S.modelsExpanded ? '收起（只看前 ' + TOPN + ' 个）' : '展开其余 ' + folded + ' 个') +
          '</button></div>';
      }
    }
    html += '</div>';

    var an = wb.analytics;
    if (an && an.summary) {
      var su = an.summary.all_time || an.summary.window || an.summary;
      html += '<div class="card"><div class="card-h"><div class="card-t">面板用量<span class="n">累计</span></div>' +
        '<span class="pill mute">' + esc(an.realm || 'all') + '</span></div>' +
        '<div class="hero-grid" style="margin-top:0">' +
        '<div class="mini"><div class="k">Token</div><div class="v mono">' + fmtTok(su.total_tokens) + '</div></div>' +
        '<div class="mini"><div class="k">请求</div><div class="v mono">' + fmtInt(su.requests) + '</div></div>' +
        '<div class="mini"><div class="k">错误</div><div class="v mono">' + fmtInt(su.errors) + '</div></div>' +
        '</div>' +
        '<div class="kv" style="margin-top:8px"><span class="k">缓存命中</span><span class="v mono">' + num(su.cache_hit_pct).toFixed(1) + '%</span></div>' +
        '<div class="kv"><span class="k">平均首字 / 总耗时</span><span class="v mono">' + fmtInt(su.ttft_ms_avg) + 'ms / ' + (num(su.elapsed_ms_avg) / 1000).toFixed(1) + 's</span></div>' +
        '<div class="kv"><span class="k">平均速度</span><span class="v mono">' + num(su.speed_avg).toFixed(0) + ' tok/s</span></div>' +
        '</div>';
    }

    if (an && an.keys && an.keys.length) {
      html += '<div class="card"><div class="card-h"><div class="card-t">按 Key</div></div>';
      an.keys.forEach(function (k) {
        var w2 = k.all_time || k.window || {};
        html += '<div class="row"><div class="grow"><div class="name">' + esc(k.name || k.key) + ' <span class="pill ' + (k.realm === 'cn' ? 'info' : 'mute') + '">' + esc(k.realm || 'all') + '</span></div>' +
          '<div class="meta">' + fmtInt(w2.requests) + ' 次 · 缓存 ' + num(w2.cache_hit_pct).toFixed(1) + '%</div></div>' +
          '<div class="val mono">' + fmtTok(w2.total_tokens) + '</div></div>';
      });
      html += '</div>';
    }

    if (wb.models) {
      ['cn', 'intl'].forEach(function (realm) {
        var list = (wb.models[realm] || []).slice().sort(function (a, b) {
          return String(a.id).localeCompare(String(b.id));
        });
        html += '<div class="card"><div class="card-h"><div class="card-t">' +
          (realm === 'cn' ? '国内版模型' : '国际版模型') + '<span class="n">' + list.length + ' 个</span></div></div>';
        if (!list.length) { html += '<div class="empty">未返回模型</div>'; }
        html += '<div class="chips">';
        list.forEach(function (m) {
          var credits = String(m.credits == null ? '' : m.credits);
          var free = /(^|[^0-9.])0(\.0+)?x$|x0\.00|x0$/.test(credits) || credits === 'x0.00';
          html += '<span class="chip ' + (free ? 'free' : '') + '">' + esc(m.id) +
            ' <span class="c mono">' + esc(credits || '—') + '</span>' +
            (free ? ' <span class="c">免费</span>' : '') + '</span>';
        });
        html += '</div></div>';
      });
    }

    var keepTop = el.scrollTop;
    el.innerHTML = html;
    if (keepTop) el.scrollTop = keepTop;
  }

  function baseKind(u) {
    if (!u) return '未填';
    return /^https:/i.test(u) ? '公网域名' : '内网';
  }

  // 是否在 App 壳内跑（有原生桥 → 页面是 file://，跨源被关）。
  // 壳内浏览器内核直连只对显式返回 CORS 头的服务端可用，所以壳内绝不把 https 用户往 auto 引。
  function inShell() { return !!window.NativeBridge; }

  // ─────────────────────────────────────────── 应用内更新检查（只提示，不自动下载）
  // 行为约定：有新版本只在设置页显示一行 + 可复制下载地址；不弹窗、不自动下载、
  // 不走 errBox；网络失败静默（手动查失败才给一句 toast）。不改 Java、不跳浏览器。
  var UPD = { state: 'idle', cur: '', tag: '', url: '', apkUrl: '', notes: '', at: 0, dlBusy: false };

  function curVer() {
    var info = null;
    try {
      info = (window.NativeBridge && window.NativeBridge.appInfo) ? JSON.parse(window.NativeBridge.appInfo()) : null;
    } catch (e) { info = null; }
    var v = info && info.version ? String(info.version).replace(/^v/i, '').trim() : '';
    return v === 'web' ? '' : v;   // 纯浏览器里 version 是 'web'，没有可比的真版本
  }

  // 点分段补零逐段数字比（1.0.9 < 1.0.10 必须成立，所以绝不能按字符串比）。
  // 返回 -1（a 比 b 老）/ 0 / 1；任一侧取不到数字段就返回 0：不可比时宁可不提示有新版本。
  function verCmp(a, b) {
    function segs(v) {
      var m = String(v == null ? '' : v).match(/\d+(?:\.\d+)*/);
      return m ? m[0].split('.').map(function (x) { return parseInt(x, 10) || 0; }) : null;
    }
    var x = segs(a), y = segs(b);
    if (!x || !y) return 0;
    for (var i = 0, n = Math.max(x.length, y.length); i < n; i++) {
      var p = i < x.length ? x[i] : 0, q = i < y.length ? y[i] : 0;
      if (p !== q) return p < q ? -1 : 1;
    }
    return 0;
  }

  // 「今天」串一律由传进来的时间戳（Date.now 被 harness 冻结时即为冻结值）推出。
  // 直接 new Date() 会读真实时钟，冻结时钟就失效了 —— 与签到判定同一口径。
  function updDay(ts) {
    var d = new Date(ts == null ? Date.now() : ts);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function updLine() {
    if (UPD.state === 'checking') return '检查中…';
    if (UPD.state === 'new') return '发现新版本 v' + UPD.tag + '（当前 ' + UPD.cur + '）';
    if (UPD.state === 'latest') return '已是最新（v' + UPD.cur + '）';
    return '未检查';   // idle / fail 都是「没查到」：失败不写错，也不吓人
  }

  function updNotes() {
    if (UPD.state !== 'new') return '';
    var t = String(UPD.notes || '').split('\n')[0].trim();
    return t.length > 200 ? t.slice(0, 200) + '…' : t;
  }

  // 「今天 09:29 查过」：时间只从 UPD.at 这个时间戳算，不读当前时钟（时钟被冻结也说得准）
  function updAtText() {
    if (!UPD.at || (UPD.state !== 'latest' && UPD.state !== 'new')) return '';
    var d = new Date(UPD.at);
    return (updDay(UPD.at) === updDay(Date.now()) ? '今天 ' : updDay(UPD.at) + ' ') +
      pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ' 查过';
  }

  // 结论落盘：只在 latest/new 时写；checking/fail 一律不写回（失败不是结论，不许当结论存）
  function updSave() {
    if (UPD.state !== 'latest' && UPD.state !== 'new') return;
    try {
      localStorage.setItem(UPD_LAST, JSON.stringify({
        day: updDay(Date.now()), cur: UPD.cur, tag: UPD.tag, state: UPD.state,
        url: UPD.url, apkUrl: UPD.apkUrl, notes: updNotes(), at: UPD.at
      }));
    } catch (e) { }
  }

  // 取回上次结论。三条必须同时满足：同一天、同一版本、结论是 latest/new；
  // 任一不满足就整条丢弃、不写回 —— 不拿昨天的结论冒充今天，不拿旧版本的结论冒充当前版本。
  // 只在内存里没有结论（idle）时才认，免得把用户刚拿到的新结论顶掉。
  function updRestore() {
    if (UPD.state !== 'idle') return;
    var o = null;
    try { o = JSON.parse(localStorage.getItem(UPD_LAST) || 'null'); } catch (e) { o = null; }
    if (!o || typeof o !== 'object') return;
    var cur = curVer();
    if (!cur || String(o.cur) !== cur || o.day !== updDay(Date.now())) return;
    if (o.state !== 'latest' && o.state !== 'new') return;
    UPD = {
      state: o.state, cur: cur, tag: String(o.tag || ''), url: String(o.url || ''),
      apkUrl: String(o.apkUrl || ''), notes: String(o.notes || ''), at: Number(o.at) || 0,
      dlBusy: false
    };
  }

  // 应用内更新：有原生桥（壳内）才谈得上「下载并安装」；网页版没有下载能力，只能复制地址
  function canInstallApk() {
    return !!(window.NativeBridge && window.NativeBridge.downloadApk);
  }

  // Java 侧下完/失败后回调这里（见 MainActivity.startApkDownload）
  window.__onApk = function (r) {
    if (!r) return;
    UPD.dlBusy = false;
    if (r.ok) {
      toast(r.msg || '下载完成', 'ok');
    } else {
      toast(String(r.msg || '下载失败'), 'err');
    }
    // 结果写进 note 行（updNotes 只认 UPD.notes，别另开字段，否则界面看不到结果）
    UPD.notes = String(r.msg || (r.ok ? '下载完成' : '下载失败'));
    updPaint();
  };

  // 只贴这一小块 DOM，不整页重渲染：否则检查完会把用户正在填的输入和滚动位置冲掉
  function updPaint() {
    var line = $('#upd-line');
    if (!line) return;   // 不在设置页
    line.textContent = updLine();
    // 「今天 09:29 查过」单独一行：结论与时间分开，结论行文案不动（既有断言只看结论行）
    var at = $('#upd-at');
    if (at) { var s = updAtText(); at.textContent = s; at.style.display = s ? '' : 'none'; }
    var btn = $('#f-updcheck');
    if (btn) { btn.disabled = UPD.state === 'checking'; btn.textContent = UPD.state === 'checking' ? '检查中…' : '检查更新'; }
    var cp = $('#f-updcopy');
    if (cp) cp.style.display = (UPD.state === 'new' && UPD.url) ? '' : 'none';
    // 应用内更新：能下载就露「下载并安装」，网页版只能复制地址
    var dl = $('#f-upddl');
    if (dl) dl.style.display = (UPD.state === 'new' && UPD.apkUrl && canInstallApk()) ? '' : 'none';
    var note = $('#upd-note');
    if (note) {
      var t = updNotes();
      note.textContent = t;
      note.style.display = t ? '' : 'none';
    }
  }

  // 取一个端点：4s 超时；失败/超时/非 2xx/解析失败一律 reject，由调用方决定要不要换下一个
  function updFetch(url) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () { done = true; reject(new Error('timeout')); }, UPD_TIMEOUT_MS);
      function fail(e) { if (done) return; done = true; clearTimeout(timer); reject(e || new Error('fail')); }
      function ok(j) { if (done) return; done = true; clearTimeout(timer); resolve(j); }
      try {
        // 必须就地写 window.fetch(...)：裸 fetch 变量在浏览器里 this 不对会 Illegal invocation，
        // 就近取也让 preSeed 里的 fetch 桩拦得住（不被闭包提前固定成真 fetch）
        window.fetch(url, { cache: 'no-store' })
          .then(function (r) {
            if (!r || !r.ok) return fail(new Error('HTTP ' + (r && r.status)));
            return r.json();
          })
          .then(ok, fail);
      } catch (e) { fail(e); }
    });
  }

  function checkUpdate(opts) {
    opts = opts || {};
    var cur = opts.cur != null ? String(opts.cur) : curVer();
    var urls = (opts.urls && opts.urls.length) ? opts.urls : UPD_URLS;
    if (!cur) { updPaint(); return Promise.resolve(UPD); }   // 拿不到真实版本 → 静默不做
    if (UPD.state === 'checking') return Promise.resolve(UPD);
    var today = updDay(Date.now());
    // 同一自然日只查一次（手动点「检查更新」传 force:true 绕过）。
    // 失败也写标记：GitHub 未认证配额 60 次/小时/IP，弱网用户每次冷启都打一次会被打穿。
    if (!opts.force) {
      try { if (localStorage.getItem(UPD_DAY) === today) { updPaint(); return Promise.resolve(UPD); } } catch (e) { }
    }
    function mark() { try { localStorage.setItem(UPD_DAY, today); } catch (e) { } }
    UPD.state = 'checking'; UPD.cur = cur;
    updPaint();
    function tryAt(i) {
      if (i >= urls.length) return Promise.reject(new Error('all endpoints failed'));
      return updFetch(urls[i]).catch(function () { return tryAt(i + 1); });
    }
    return tryAt(0).then(function (j) {
      UPD.at = Date.now();
      UPD.tag = String((j && j.tag_name) || '').replace(/^v/i, '').trim();   // 预发布后缀忽略：我们不发预发布
      UPD.url = (j && j.html_url) || '';
      // 应用内更新要的是 APK 附件直链，不是 release 页面地址
      UPD.apkUrl = '';
      var assets = (j && j.assets) || [];
      for (var ai = 0; ai < assets.length; ai++) {
        var an = String((assets[ai] && assets[ai].name) || '');
        if (/\.apk$/i.test(an)) { UPD.apkUrl = String(assets[ai].browser_download_url || ''); break; }
      }
      UPD.notes = (j && j.body) || '';
      UPD.state = (UPD.tag && verCmp(cur, UPD.tag) < 0) ? 'new' : 'latest';
      mark();
      updSave();   // 结论落盘：当天再开 App 时设置页能接着显示，不用重查
      updPaint();
      return UPD;
    }, function (e) {
      UPD.state = 'fail';
      mark();
      updPaint();
      return UPD;
    });
  }

  function autoUpd() {
    // 三重门：真 App 壳内才发请求（有桥 + file://）、拿得到真实版本、同日没查过（后者在 checkUpdate 里）。
    // file:// 这一条不是多余：harness 和桌面调试页都用 http 打开本页，很多用例会桩 NativeBridge，
    // 只判 !!NativeBridge 会让每次冷启动都往 GitHub 打一次 —— 测试不该有真网出口。
    if (!inShell()) return Promise.resolve(UPD);
    if (typeof location !== 'undefined' && location.protocol !== 'file:') return Promise.resolve(UPD);
    return checkUpdate({});
  }

  function isConflicted() {
    return /^https:/i.test(CFG.newapiBase || '') && CFG.channel === 'native';
  }

  function channelLabel(ch) {
    if (ch === 'browser') return '浏览器内核直连（全部请求）';
    if (ch === 'native') return '原生请求（全部请求）';
    return '自动（https→浏览器内核 / http→原生）';
  }

  function renderSettings() {
    updRestore();   // 必须在任何能画出 #upd-line 的渲染之前：冷启动时内存里没结论，只能从盘上取
    var el = viewEl('settings');
    var info = (window.NativeBridge && window.NativeBridge.appInfo) ? JSON.parse(window.NativeBridge.appInfo()) : { version: 'web', sdk: 0, model: 'browser' };

    var html = '';
    if (CFG.tokenCleared) {
      html += '<div class="errbox" style="border-color:rgba(251,191,36,.45);background:rgba(251,191,36,.08);color:#fde68a">' +
        '<b>令牌栏里填的是网址</b>，已搬到地址栏。请重填 32 位管理令牌。</div>';
    }

    html += '<div class="card"><div class="card-h"><div class="card-t">连接方案</div>' +
      '<span class="pill ' + (CFG.channel === 'native' ? 'ok' : 'warn') + '">' +
      (CFG.channel === 'browser' ? '浏览器内核' : CFG.channel === 'native' ? '原生请求' : '自动') + '</span></div>' +
      '<div class="tok-acts" style="margin-top:2px">' +
      (presetReady('public') ? '<button class="btn ok" data-preset="public">公网地址</button>' : '') +
      (presetReady('lan') ? '<button class="btn" data-preset="lan">内网地址</button>' : '') +
      '<button class="btn ghost" id="f-adv">高级</button></div>' +
      '<div class="note" style="margin-top:10px">当前：NewAPI <b>' + baseKind(CFG.newapiBase) + '</b> · 账号池 <b>' + baseKind(CFG.hubBase) + '</b>' +
      (baseKind(CFG.newapiBase) !== baseKind(CFG.hubBase)
        ? ' <span style="color:#fcd34d">（地址不一致）</span>' : '') + '</div>' +
      (isConflicted() ? '<div class="errbox" style="margin:10px 0 0"><b>通道冲突</b> ' +
        '公网 https + 原生请求易被网关断连。' +
        (inShell() ? '改用内网地址。' : '') +
        (inShell()
          ? (presetReady('lan') ? '<div class="tok-acts"><button class="btn ok" id="f-fixconf" style="height:38px">改用内网地址</button></div>' : '')
          : '<div class="tok-acts"><button class="btn ok" id="f-fixconf" style="height:38px">一键改成「自动」</button></div>') +
        '</div>' : '') +
      '<div id="f-adv-box" style="display:none;margin-top:12px">' +
      '<div class="field"><label>请求通道</label><select id="f-channel">' +
      '<option value="native" ' + (CFG.channel === 'native' ? 'selected' : '') + '>原生请求（默认，仅内网 http）</option>' +
      '<option value="auto" ' + (CFG.channel === 'auto' ? 'selected' : '') + '>自动（https→浏览器内核 / http→原生）</option>' +
      '<option value="browser" ' + (CFG.channel === 'browser' ? 'selected' : '') + '>浏览器内核直连</option>' +
      '</select></div>' +
      '</div>';

    html += '<div class="card"><div class="card-h"><div class="card-t">NewAPI 网关</div></div>' +
      '<div class="field"><label>① 地址 <span style="color:#fca5a5">必填</span></label><input id="f-nabase" type="url" value="' + esc(CFG.newapiBase) + '" placeholder="http://网关地址:3000"></div>' +
      '<div class="field"><label>② 管理令牌 <span style="color:#fca5a5">必填</span>' +
      ' <a href="#" id="f-tokhelp" style="margin-left:6px">怎么拿？</a></label>' +
      '<input id="f-natok" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" value="' + esc(CFG.newapiToken) + '" placeholder="32 位字母数字"></div>' +
      '<div class="field"><label>③ 用户 ID</label><input id="f-nauid" type="number" inputmode="numeric" value="' + esc(CFG.newapiUid) + '" placeholder="1"></div>' +
      '<div class="tok-acts"><button class="btn" id="f-natest">测试连接</button>' +
      '<button class="btn ok" id="f-save">保存并连接</button></div>' +
      (SECURE_ERR ? '<div class="note" style="color:#fca5a5;margin-top:8px">⚠ ' + esc(SECURE_ERR) + '</div>' : '') +
      '</div>';

    html += '<div class="card"><div class="card-h"><div class="card-t">账号池面板</div></div>' +
      '<div class="field"><label>地址</label><input id="f-hub" type="url" value="' + esc(CFG.hubBase) + '" placeholder="https://hub 地址"></div>' +
      '<div class="field"><label>面板密码 <span style="color:var(--dim-2)">可选</span></label><input id="f-hubpass" type="password" value="' + esc(CFG.hubPass) + '"></div>' +
      '<div class="tok-acts"><button class="btn" id="f-hubtest">测试登录</button>' +
      '<button class="btn ok" id="f-save2">保存并连接</button></div></div>';

    html += '<div class="card"><div class="card-h"><div class="card-t">统计偏好</div></div>' +
      '<div class="field"><label>默认时间范围</label><select id="f-range">' +
      ['today', '24h', '7d'].map(function (r) {
        return '<option value="' + r + '" ' + (CFG.range === r ? 'selected' : '') + '>' + RANGE_NAME[r] + '</option>';
      }).join('') + '</select></div>' +
      '<div class="field"><label>最大翻页数</label><input id="f-maxpages" type="number" inputmode="numeric" value="' + esc(CFG.maxPages) + '"></div>' +
      '<div class="field"><label>自动刷新</label><select id="f-auto">' +
      [['0', '关闭'], ['30', '每 30 秒'], ['60', '每 1 分钟'], ['300', '每 5 分钟']].map(function (o) {
        return '<option value="' + o[0] + '" ' + (String(CFG.autoRefresh) === o[0] ? 'selected' : '') + '>' + o[1] + '</option>';
      }).join('') + '</select></div>' +
      '<div class="field"><label>后台预取 7 天</label><select id="f-prefetch">' +
      [['1', '开启'], ['0', '关闭']].map(function (o) {
        return '<option value="' + o[0] + '" ' + (String(CFG.prefetch) !== '0' && o[0] === '1' || String(CFG.prefetch) === '0' && o[0] === '0' ? 'selected' : '') + '>' + o[1] + '</option>';
      }).join('') + '</select></div>' +
      '</div>';

    html += '<div class="card"><div class="card-h"><div class="card-t">关于</div><span class="pill mute">v' + esc(info.version) + '</span></div>' +
      '<div class="kv"><span class="k">运行环境</span><span class="v">Android SDK ' + esc(info.sdk) + ' · ' + esc(info.model) + '</span></div>' +
      '<div class="kv"><span class="k">请求通道</span><span class="v">' + channelLabel(CFG.channel) + ' · ' +
      (window.NativeBridge && window.NativeBridge.http ? '原生桥可用' : '无原生桥（纯浏览器）') + '</span></div>' +
      '<div class="kv"><span class="k">当前 NewAPI</span><span class="v mono" style="font-size:11px">' + esc(CFG.newapiBase) + '</span></div>' +
      '<div class="kv"><span class="k">当前 账号池</span><span class="v mono" style="font-size:11px">' + esc(CFG.hubBase) + '</span></div>' +
      // 更新检查：状态一行 + 手动查一次 + 有新版才露出的「复制下载地址」。
      // 初始态由 updPaint() 在绑定处贴一次，三态（未检查/已是最新/发现新版本）只有一处真相。
      '<div class="kv"><span class="k">版本检查</span><span class="v" id="upd-line">' + esc(updLine()) + '</span></div>' +
      // 「今天 09:29 查过」：跟结论同一个时间戳，跨天/换版本就不显示（见 updRestore 的三条门槛）
      '<div class="note" id="upd-at" style="display:none;margin:-2px 0 8px;color:var(--dim-2)"></div>' +
      '<div class="tok-acts" style="margin:0 0 10px"><button class="btn ghost" id="f-updcheck" style="height:38px">检查更新</button>' +
      '<button class="btn ok" id="f-upddl" style="height:38px;display:none">下载并安装</button>' +
      '<button class="btn ghost" id="f-updcopy" style="height:38px;display:none">复制地址</button></div>' +
      '<div class="note" id="upd-note" style="display:none"></div>' +
      '<div class="hr"></div>' +
      '<div class="tok-acts"><button class="btn danger" id="f-clear">清除配置</button>' +
      '<button class="btn ghost" id="f-exit">退出应用</button></div></div>';

    html += '<div class="card"><div class="card-h"><div class="card-t">最近请求日志</div><span class="pill mute">' + S.reqlog.length + '</span></div>' +
      '<div class="tok-acts" style="margin:0 0 10px"><button class="btn ghost" id="f-diagcopy" style="height:38px">复制诊断信息</button></div>';
    if (!S.reqlog.length) html += '<div class="note">暂无</div>';
    else {
      html += '<div class="note mono" style="line-height:1.75">' + S.reqlog.slice(0, 12).map(function (r) {
        var t = new Date(r.at);
        return pad2(t.getHours()) + ':' + pad2(t.getMinutes()) + ':' + pad2(t.getSeconds()) +
          ' ' + esc(r.m) + ' ' + esc(String(r.u).replace(trimBase(CFG.newapiBase), '').replace(trimBase(CFG.hubBase), '')) +
          ' · ' + (r.via || 'NT') + ' → ' + r.s + (r.ms ? ' (' + r.ms + 'ms)' : '');
      }).join('<br>') + '</div>';
    }
    html += '</div>';

    el.innerHTML = html;

    function collect() {
      var baseIn = $('#f-nabase').value;
      var tokIn = $('#f-natok').value;

      if (looksUrl(tokIn) && !looksUrl(baseIn)) {
        var tmp = baseIn; baseIn = tokIn; tokIn = tmp;
        CFG.swappedAt = Date.now();
      } else if (looksToken(baseIn) && !looksToken(tokIn)) {
        var tmp2 = baseIn; baseIn = tokIn; tokIn = tmp2;
        CFG.swappedAt = Date.now();
      }

      CFG.newapiBase = normBase(baseIn, DEF.newapiBase);
      CFG.newapiToken = String(tokIn || '').trim();
      CFG.newapiUid = $('#f-nauid').value.trim() || '1';
      CFG.hubBase = normBase($('#f-hub').value, DEF.hubBase);
      CFG.hubPass = $('#f-hubpass').value;
      CFG.range = $('#f-range').value;
      CFG.maxPages = $('#f-maxpages').value.trim() || '80';
      var autoSel = $('#f-auto');
      if (autoSel) CFG.autoRefresh = autoSel.value;
      var pfSel = $('#f-prefetch');
      if (pfSel) CFG.prefetch = pfSel.value;
      CFG.channel = $('#f-channel').value;
      saveCfg();
    }

    if (isConflicted()) {
      var fixBtn = $('#f-fixconf');
      if (fixBtn) fixBtn.onclick = function () {
        if (inShell()) {
          // 壳内只推内网预设，绝不写 channel='auto'（https→自动 会落到跨源受限的浏览器内核，必失败）
          var gw0 = CFG.newapiBase;
          collect();
          if (presetOk(PRESETS.lan.newapiBase)) CFG.newapiBase = PRESETS.lan.newapiBase;
          if (presetOk(PRESETS.lan.hubBase)) CFG.hubBase = PRESETS.lan.hubBase;
          CFG.channel = 'native';
          saveCfg();
          // 换了网关才清 hubToken（面板令牌绑定在网关上）；没换成内网预设时网络一行没变，
          // 清掉只会让人白白重输一次面板密码。
          if (gw0 !== CFG.newapiBase) { rawReset(); S.hubToken = ''; }   // 换网关：日志仓整仓作废，不能让旧行冒充新网关
          renderSettings();
          toast('已改用内网地址（原生请求）', 'ok');
          refreshAll();
          return;
        }
        CFG.channel = 'auto';
        saveCfg();
        renderSettings();
        toast('已改成「自动」，再点保存并连接', 'ok');
      };
    }

    var advBtn = $('#f-adv');
    if (advBtn) advBtn.onclick = function () {
      var box = $('#f-adv-box');
      var on = box.style.display !== 'none';
      box.style.display = on ? 'none' : 'block';
      advBtn.textContent = on ? '高级' : '收起';
    };

    var helpBtn = $('#f-tokhelp');
    if (helpBtn) helpBtn.onclick = function (e) {
      if (e && e.preventDefault) e.preventDefault();   // CSP 下不允许 javascript: URI，用 # + preventDefault 接管
      showSheet('<div class="sheet-body">' +
        '<div class="sheet-title">怎么拿 NewAPI 管理令牌</div>' +
        '<div class="sheet-desc">这个令牌只用来读管理接口（列表/日志），不是对话用的 sk- 密钥。</div>' +
        '<div class="note" style="line-height:2">' +
        '1. 浏览器打开你的 NewAPI 站点并登录（地址就是上面「地址」那一栏）<br>' +
        '2. 右上角头像 → 个人设置<br>' +
        '3. 左侧「安全设置」→ 系统访问令牌 → 生成<br>' +
        '4. 复制整串粘贴到「管理令牌」，用户 ID 默认 1（Root）<br>' +
        '5. 回到这里点「保存并连接」</div>' +
        '<div class="sheet-acts"><button class="btn ok" data-sheet="close">知道了</button></div></div>');
      $('[data-sheet="close"]').onclick = hideSheet;
    };

    $$('[data-preset]', el).forEach(function (b) {
      b.onclick = function () {
        var p = PRESETS[b.getAttribute('data-preset')];
        if (!p) return;
        var gw0 = CFG.newapiBase;
        collect();
        if (presetOk(p.newapiBase)) CFG.newapiBase = p.newapiBase;   // 占位符未注入：保留用户已填的值，绝不写占位符
        if (presetOk(p.hubBase)) CFG.hubBase = p.hubBase;
        CFG.channel = 'auto';
        saveCfg();
        if (gw0 !== CFG.newapiBase) rawReset();   // 换了网关：日志仓整仓作废，不能让旧行冒充新网关
        S.hubToken = '';
        S.tokens = null; S.over = null; S.usage = null; S.wb = null;
        renderSettings();
        toast(/^https:/i.test(p.newapiBase) ? '已切到远程地址（浏览器内核通道）' : '已切到局域网直连', 'ok');
        refreshAll();
      };
    });

    function saveAndGo() {
      var gw0 = CFG.newapiBase;
      collect();
      if (!CFG.newapiBase) {
        toast('请先填 NewAPI 地址（如 http://你的网关地址:3000）', 'err');
        return;
      }
      if (looksUrl(CFG.newapiToken)) {
        toast('「管理令牌」里像是地址，请检查是否粘错框（地址框在它上面）', 'err');
        return;
      }
      // 壳内没有可用的「自动」通道（https→浏览器内核 受跨源限制必失败），拦着不让保存只会把人锁死：
      // 网页版保持原确认流程；壳内直接放行，只在保存提示里点明「被断连就改内网地址」。
      var conflictHint = '';
      if (isConflicted() && !inShell()) {
        confirmSheet('通道冲突，先改一下',
          '地址是公网域名（https），通道却是「原生请求」。这个组合常被网关断连（看起来像令牌失效）。改成「自动」吗？',
          function () {
            CFG.channel = 'auto';
            saveCfg();
            renderSettings();
            toast('已改成「自动」，请再点一次保存并连接', 'ok');
          });
        return;
      }
      if (isConflicted()) conflictHint = '（公网 https 走原生请求；若被网关断连，请改用内网地址）';
      if (!CFG.newapiToken && !CFG.hubPass) { toast('至少填一项凭证才能连接', 'err'); return; }
      CFG.tokenCleared = false;
      if (CFG.swappedAt && Date.now() - CFG.swappedAt < 3000) {
        toast('检测到「地址」和「令牌」填反了，已自动对调', 'ok');
        CFG.swappedAt = 0;
      } else {
        toast('已保存，正在连接…' + conflictHint, 'ok');
      }
      S.hubToken = '';
      cacheClearAll();
      if (gw0 !== CFG.newapiBase) rawReset();   // 换了网关：日志仓整仓作废，不能让旧行冒充新网关
      refreshAll();
      startAutoRefresh();
      setTimeout(function () { showTab('overview'); }, 400);
    }
    $('#f-save').onclick = saveAndGo;
    $('#f-save2').onclick = saveAndGo;

    // ── 统计偏好：改了立刻存，不等「保存并连接」 ────────────────────
    // 原来这四项只在 saveAndGo 的 collect() 里读一次，用户改完不点「保存并连接」就什么都不发生，
    // 切到别的页签再回来又被 renderSettings 的旧 CFG 值覆盖 —— 表现就是「改了不保存、没生效」。
    function prefSave() { saveCfg(); }
    var rangeSel = $('#f-range');
    if (rangeSel) rangeSel.onchange = function () {
      CFG.range = rangeSel.value;
      prefSave();
      toast('默认范围：' + (RANGE_NAME[CFG.range] || CFG.range), 'ok');
    };
    var pageIn = $('#f-maxpages');
    if (pageIn) pageIn.onchange = function () {
      CFG.maxPages = String(pageIn.value || '').trim() || '80';
      pageIn.value = CFG.maxPages;
      prefSave();
      toast('最大翻页数：' + CFG.maxPages, 'ok');
    };
    var autoSelEl = $('#f-auto');
    if (autoSelEl) autoSelEl.onchange = function () {
      CFG.autoRefresh = autoSelEl.value;
      prefSave();
      startAutoRefresh();          // 立刻按新间隔重排定时器（0 = 关掉）
      toast(String(CFG.autoRefresh) === '0' ? '自动刷新：已关闭'
        : '自动刷新：每 ' + (num(CFG.autoRefresh) >= 60 ? (num(CFG.autoRefresh) / 60) + ' 分钟' : CFG.autoRefresh + ' 秒'), 'ok');
    };
    var pfSelEl = $('#f-prefetch');
    if (pfSelEl) pfSelEl.onchange = function () {
      CFG.prefetch = pfSelEl.value;
      prefSave();
      if (CFG.prefetch === '0') {
        if (prefetchTimer) { clearTimeout(prefetchTimer); prefetchTimer = null; }
        toast('后台预取：已关闭', 'ok');
      } else {
        schedulePrefetch(800);     // 打开就立即补一次，不用等下次启动
        toast('后台预取：开启（正在补齐 7 天）', 'ok');
      }
    };
    $('#f-natest').onclick = function () {
      collect();
      toast('测试中…');
      S.hubToken = '';
      napiRaw('/api/user/self').then(function (u) {
        toast('NewAPI 连接正常：' + (u.username || '') + ' · 累计请求 ' + fmtInt(u.request_count), 'ok');
      }).catch(function (e) { toast(e.message, 'err'); });
    };
    $('#f-hubtest').onclick = function () {
      collect();
      S.hubToken = '';
      toast('登录中…');
      hubLogin().then(function () { return hubRaw('/health'); }).then(function (h) {
        toast('账号池面板 正常：' + h.accounts_ready + '/' + h.accounts + ' 可用', 'ok');
      }).catch(function (e) { toast(e.message, 'err'); });
    };

    var diagCopyBtn = $('#f-diagcopy');
    if (diagCopyBtn) diagCopyBtn.onclick = function () {
      collect();
      var info = (window.NativeBridge && window.NativeBridge.appInfo) ? JSON.parse(window.NativeBridge.appInfo()) : { version: 'web', sdk: 0, model: 'browser' };
      var lines = [
        'TokenDesk v' + info.version + ' · SDK ' + info.sdk + ' · ' + info.model,
        'NewAPI: ' + CFG.newapiBase,
        '账号池: ' + CFG.hubBase,
        '通道: ' + CFG.channel + ' · 原生桥: ' + (window.NativeBridge && window.NativeBridge.http ? '有' : '无'),
        '令牌: ' + (CFG.newapiToken ? (CFG.newapiToken.length + ' 位, 尾4=' + CFG.newapiToken.slice(-4)) : '未填') + ' · 用户ID: ' + CFG.newapiUid,
        '面板密码: ' + (CFG.hubPass ? '已填' : '未填'),
        '时间: ' + new Date().toString(),
        '--- 最近错误 ---',
        JSON.stringify(S.errors),
        '--- 最近请求 ---'
      ];
      S.reqlog.slice(0, 10).forEach(function (r) {
        lines.push(r.m + ' ' + r.u + ' -> ' + r.s + ' (' + r.ms + 'ms, ' + (r.via || '?') + ')');
      });
      var text = lines.join('\n');
      if (window.NativeBridge && window.NativeBridge.copy) window.NativeBridge.copy(text);
      else if (navigator.clipboard) navigator.clipboard.writeText(text);
      showSheet('<div class="sheet-body"><div class="sheet-title">诊断信息（已复制）</div>' +
        '<div class="note mono" style="white-space:pre-wrap;line-height:1.8">' + esc(text) + '</div>' +
        '<div class="sheet-acts"><button class="btn ok" data-sheet="close">关闭</button></div></div>');
      $('[data-sheet="close"]').onclick = hideSheet;
    };

    var updCheckBtn = $('#f-updcheck');
    if (updCheckBtn) updCheckBtn.onclick = function () {
      // 手动查走 force：不受「同日只查一次」限制；失败才给一句 toast（自动查失败完全静默）
      checkUpdate({ force: true }).then(function (u) {
        if (u.state === 'fail') toast('检查失败，请稍后再试', 'err');
      });
    };
    var updCopyBtn = $('#f-updcopy');
    if (updCopyBtn) updCopyBtn.onclick = function () {
      if (!UPD.url) return;
      // 只复制地址，绝不在 App 里打开浏览器（真机验收第 ⑤ 项：点帮助链接不弹浏览器）
      if (window.NativeBridge && window.NativeBridge.copy) window.NativeBridge.copy(UPD.url);
      else if (navigator.clipboard) navigator.clipboard.writeText(UPD.url);
      toast('下载地址已复制', 'ok');
    };
    var updDlBtn = $('#f-upddl');
    if (updDlBtn) updDlBtn.onclick = function () {
      if (!UPD.apkUrl || UPD.dlBusy) return;
      if (!canInstallApk()) { toast('当前环境不能直接安装，请复制地址', 'err'); return; }
      UPD.dlBusy = true;
      toast('开始下载更新…');
      try {
        window.NativeBridge.downloadApk(UPD.apkUrl, UPD.tag || '');
      } catch (e) {
        UPD.dlBusy = false;
        toast('调用下载失败：' + e.message, 'err');
      }
    };
    updPaint();   // 重渲染后把已有状态（检查中/已是最新/发现新版本）贴回新 DOM

    $('#f-clear').onclick = function () {
      confirmSheet('清除配置', '将删除本机保存的地址、令牌、面板密码，并清掉 WebView 缓存。', function () {
        try { localStorage.removeItem(LS_KEY); } catch (e) { }
        // Keystore 里的 4 个凭证也必须清，否则「清除配置」只清了明文那一半
        try {
          if (window.NativeBridge && window.NativeBridge.secureClear) window.NativeBridge.secureClear();
        } catch (e) { }
        SECURE_ERR = '';
        secureDead = false;
        cacheClearAll();
        rawReset();
        try {
          if (window.NativeBridge && window.NativeBridge.clearWebData) window.NativeBridge.clearWebData();
        } catch (e) { }
        CFG = loadCfg();
        S.tokens = null; S.over = null; S.usage = null; S.wb = null; S.hubToken = '';
        hideSheet();
        renderSettings();
        toast('已清除', 'ok');
      });
    };
    $('#f-exit').onclick = function () {
      if (window.NativeBridge && window.NativeBridge.finishApp) window.NativeBridge.finishApp();
      else toast('浏览器环境不能退出');
    };
  }

  var sheetStack = [];

  function showSheet(html) {
    var el = $('#sheet');
    el.innerHTML = html;
    el.className = '';
    el.onclick = function (e) { if (e.target === el) hideSheet(); };
    sheetStack.push(1);
  }
  function hideSheet() {
    var el = $('#sheet');
    el.onclick = null;
    el.className = 'hidden';
    el.innerHTML = '';
    sheetStack.pop();
  }
  function confirmSheet(title, desc, onOk) {
    hideSheet();
    showSheet('<div class="sheet-body">' +
      '<div class="sheet-title">' + esc(title) + '</div>' +
      '<div class="sheet-desc">' + esc(desc) + '</div>' +
      '<div class="sheet-acts"><button class="btn ghost" data-sheet="no">取消</button>' +
      '<button class="btn danger" data-sheet="yes">确认</button></div></div>');
    $('[data-sheet="no"]').onclick = hideSheet;
    $('[data-sheet="yes"]').onclick = function () {
      hideSheet();
      if (onOk) onOk();
    };
  }

  function showTab(name) {
    S.tab = name;
    $$('.view').forEach(function (v) { v.classList.toggle('on', v.getAttribute('data-view') === name); });
    $$('#tabs button').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-tab') === name); });
    if (name === 'overview') renderOverview();
    if (name === 'tokens') { renderTokens(); }
    if (name === 'usage') { renderUsage(); }
    if (name === 'wb') renderWB();
    if (name === 'settings') renderSettings();
    updateSub();
  }

  function updateSub() {
    var map = { overview: '概览 · NewAPI + 账号池面板', tokens: '令牌管理', usage: '用量统计', wb: '账号池面板 模型与账号', settings: '设置' };
    setSub(map[S.tab] || '');
  }

  function bindTabs() {
    $$('#tabs button').forEach(function (b) {
      b.onclick = function () { showTab(b.getAttribute('data-tab')); };
    });
  }

  function toggleOverviewRange() {
    var next = (CFG.range === 'today') ? '24h' : 'today';
    CFG.range = next;
    saveCfg();
    toast('已切到「' + RANGE_NAME[next] + '」' + (next === '24h' ? '（滚动 24 小时）' : '（今天 00:00 起）'), 'ok');
    renderOverview();
    loadUsage(next, false);
  }

  var autoTimer = null;
  var lastFullScan = 0;

  var scanChain = Promise.resolve();

  function queueScan(fn) {
    var r = scanChain.then(fn, function (e) { S.lastErr = 'chain:' + (e && e.message || e); return fn(); });
    scanChain = r.then(function () { }, function (e) { S.lastErr = String(e && e.message || e); });
    return r;
  }

  var prefetchTimer = null, prefetchQueued = false;

  function schedulePrefetch(delay) {
    if (prefetchTimer || CFG.prefetch === '0') return;
    prefetchTimer = setTimeout(function () { prefetchTimer = null; prefetchOlder(); }, delay || 1500);
  }

  function prefetchOlder() {
    if (prefetchQueued || CFG.prefetch === '0') return;
    var st = rawLoad();
    var w = rangeSince('7d');
    if (!st.rows.length || rawCovered(w.since)) return;
    prefetchQueued = true;
    ensureWindow('7d', w, false, true).then(function () {
      prefetchQueued = false;
      if (!rawCovered(w.since)) schedulePrefetch(20000);
    }, function () {
      prefetchQueued = false;
      if (!rawCovered(w.since)) schedulePrefetch(20000);
    });
  }

  function ensureWindow(wantRange, w, force, quiet) {
    return queueScan(function () {
      var st = rawLoad();
      if (!force && rawCovered(w.since)) return Promise.resolve();
      if (!quiet) {
        S.busy.usage = true;
        if (S.tab === 'usage') renderUsage();
      }
      var chain = Promise.resolve();
      if (st.rows.length) chain = chain.then(function () { return deltaStart(st, 6); });
      return chain.then(function () {
        if (!force && rawCovered(w.since)) return;
        return scanWindow(st, w, wantRange, force, quiet);
      });
    }).then(function () {
      if (quiet) return;
      S.busy.usage = false;
      S.usageLive = null;
      rawMeta();
      var cur = rawLoad();
      if (rawCovered(rangeSince(CFG.range).since)) {
        S.usage = rawAggFor(CFG.range);
        S.usage.filling = false;
      } else if (S.usage) {
        S.usage = rawAggFor(S.usage.range);
        S.usage.filling = true;
      }
      if (S.tab === 'usage') renderUsage();
      if (S.tab === 'overview') renderOverview();
      if (S.tab === 'tokens') renderTokens();
      schedulePrefetch(1200);
    });
  }

  function scanWindow(st, w, wantRange, force, quiet) {
    var endAll = Math.floor(Date.now() / 1000);
    var sc = st.scan;
    if (!sc || sc.since > w.since || (endAll - sc.end) > 1800) {
      sc = st.scan = { since: w.since, end: endAll, page: 0, got: 0, total: null };
    }
    if (sc.total != null && st.rows.length >= sc.total) {
      rawMarkCovered(sc.since);
      st.scan = null;
      rawMeta(); rawSave(true);
      return Promise.resolve(true);
    }
    var endTs = sc.end;
    var maxPages = Math.max(5, Math.min(400, Math.max(parseInt(CFG.maxPages, 10) || 80, (w.since <= endAll - 86400 ? 260 : 80))));
    var seen = {};
    for (var si = 0; si < st.rows.length; si++) seen[rokey(st.rows[si])] = 1;
    var idx = rowIdx(st, 400);

    function url(page) {
      return '/api/log/?p=' + page + '&page_size=100&type=2&start_timestamp=' + sc.since + '&end_timestamp=' + endTs;
    }

    function fetchPage(page, attempt) {
      attempt = attempt || 0;
      return napiRaw(url(page), 'GET', undefined, !!force).catch(function (e) {
        var msg = String(e && e.message || e);
        var limited = msg.indexOf('429') >= 0;
        if (attempt >= (limited ? 4 : 2) || S.abort || quietCancel) throw e;
        var wait = limited ? (2500 * (attempt + 1)) : (900 * (attempt + 1));
        return new Promise(function (res) { setTimeout(res, wait); })
          .then(function () { return fetchPage(page, attempt + 1); });
      });
    }

    var quietCancel = false;

    // 「已经够了」的判定：page 数捷径只在没有重叠时成立。offset 分页期间头部插入
    // 新行会让后续页重放前面的内容（added < items.length），此时 sc.page 不再代表
    // 覆盖进度，必须继续翻页直到「新增唯一行数 >= total」或翻到空页。
    function scEnough() {
      if (sc.total == null) return false;
      if (sc.got >= sc.total) return true;
      return !sc.dirty && sc.page >= Math.ceil(sc.total / 100);
    }

    function batch() {
      if (S.abort || sc.page >= maxPages) return Promise.resolve();
      if (scEnough()) return Promise.resolve();
      var pages = [];
      for (var i = 1; i <= 3 && (sc.page + i) <= maxPages; i++) pages.push(sc.page + i);
      return Promise.all(pages.map(function (pg) {
        return fetchPage(pg).then(function (d) { return { pg: pg, d: d }; },
          function (e) { return { pg: pg, e: e }; });
      })).then(function (rs) {
        for (var k = 0; k < rs.length; k++) {
          var r = rs[k];
          if (r.e) throw r.e;
          var d = r.d || {};
          // total 缺失 ≠ 0：NewAPI 少数版本/反代不返回 total，当成 0 会让
          // got>=total 立刻成立 → 只翻 3 页就 rawMarkCovered，把"没扫完"标成"已覆盖"
          // total 还会「变大」：翻页期间新请求不断落库，只认首页的 total 会以为够了
          if (d.total != null && isFinite(Number(d.total))) {
            var tv = Number(d.total);
            sc.total = (sc.total == null) ? tv : Math.max(sc.total, tv);
          }
          var items = d.items || [];
          var added = 0;
          for (var j = 0; j < items.length; j++) {
            var it = items[j];
            var row = logRow(it);
            var key = rokey(row);
            if (seen[key]) { fillTiming(idx, row); continue; }
            seen[key] = 1;
            st.rows.push(row);
            added++;
          }
          // 只计"新增的唯一行"：offset 分页期间头部插入新行会让 p2 重放 p1 的内容，
          // 按 items.length 计数会虚高 → 提前 got>=total → 静默少算（实测少 40%）
          if (added < items.length) sc.dirty = true;   // 本页有条目被去重 → 发生了 offset 重叠
          sc.got += added;
          sc.page = r.pg;
          if (!items.length) { sc.page = maxPages + 1; break; }
        }
        rawMeta();
        rawSave();
        if (!quiet) {
          var la = rawAggFor(wantRange);
          la.pages = Math.max(la.pages, sc.page);
          S.usageLive = la;
          if (S.tab === 'usage') renderUsage();
        }
        if (scEnough()) return;
        if (sc.page >= maxPages) return;
        if (quiet) return new Promise(function (r2) { setTimeout(r2, 150); }).then(batch);
        return batch();
      });
    }

    return batch().then(function () {
      var full = scEnough();
      if (full) {
        rawMarkCovered(sc.since);
        st.scan = null;
      } else if (sc.page >= maxPages) {
        // 翻到页数上限还没扫完：标 capped 并收尾（原实现把 sc 留在 st.scan 里，
        // 每次 autoTick 都会重新进来、batch() 首行直接 return，零请求空转到天荒地老）
        st.capped = true;
        st.scan = null;
      }
      rawMeta();
      rawSave(true);
      return full;
    }).catch(function (e) {
      rawMeta(); rawSave(true);
      if (!quiet && S.busy.usage) {
        S.errors.usage = withNetHint(String(e && e.message || e));
      }
      throw e;
    });
  }

  function deltaFetch(st, myRun, maxPages) {
    var cutoff = st.newest || 0;
    // 服务端按秒截断，同一秒内晚落库的行会被 start_timestamp=cutoff 挡在窗口外，
    // 所以窗口往前多要 2 秒，再在客户端用 ts < cutoff 精确过滤（同秒行全部收下）
    var winFrom = cutoff > 2 ? cutoff - 2 : 0;
    var endTs = Math.floor(Date.now() / 1000);
    var acc = [], seen = {}, p = 1, total = null, got = 0, done = false, cap = maxPages || 6, patched = 0;
    var headN = Math.min(300, st.rows.length);
    for (var i = 0; i < headN; i++) seen[rokey(st.rows[i])] = 1;
    var idx = rowIdx(st, 300);

    function one(pg) {
      if (pg > cap || done || myRun !== S.usageRun) return Promise.resolve();
      var u = '/api/log/?p=' + pg + '&page_size=100&type=2&start_timestamp=' + winFrom + '&end_timestamp=' + endTs;
      return napiRaw(u).then(function (d) {
        if (myRun !== S.usageRun) return;
        var items = (d && d.items) || [];
        if (total == null) {
          total = num(d && d.total);
          cap = Math.min(400, Math.max(cap, Math.ceil(total / 100) + 1));
        }
        if (!items.length) { done = true; return; }
        for (var j = 0; j < items.length; j++) {
          var it = items[j], ts = num(it.created_at);
          var r = logRow(it);
          var k = rokey(r);
          if (seen[k]) { if (fillTiming(idx, r)) patched++; continue; }
          if (ts < cutoff) continue;
          seen[k] = 1;
          acc.push(r);
        }
        got += items.length;
        if (total != null && got >= total) { done = true; return; }
        return one(pg + 1);
      });
    }

    return one(1).then(function () {
      if (myRun !== S.usageRun) return 0;
      if (acc.length) {
        st.rows = acc.concat(st.rows);
        rawMeta();
      } else if (patched) {
        rawMeta();
        rawSave(true);
      }
      return acc.length;
    });
  }

  // 在飞 delta 共享：refreshUsageDelta 与 ensureWindow 可能在同一时刻要拉同一个窗口，
  // 各发一轮既重复请求，又会两笔并发写 raw 仓（`acc.concat(st.rows)` 无去重，
  // 谁后写谁把对方刚拉到的行当成旧行再拼一遍）
  var deltaP = null;
  function deltaStart(st, maxPages) {
    if (deltaP) return deltaP;
    var myRun = (S.usageRun = (S.usageRun || 0) + 1);
    deltaP = deltaFetch(st, myRun, maxPages).then(function (added) {
      deltaP = null;
      return { run: myRun, added: added };
    }, function (e) {
      deltaP = null;
      throw e;
    });
    return deltaP;
  }

  function refreshUsageDelta() {
    var st = rawLoad();
    var range = CFG.range;
    if (!st.rows.length) { return loadUsage(range, true); }
    if (S.busy.usage || S.abort || S.usageP) return Promise.resolve();

    return deltaStart(st, 6).then(function (r) {
      if (r.run !== S.usageRun) return;
      rawMeta();
      rawSave(true);
      S.usage = rawAggFor(range);
      if (r.added) setSub('已更新 ' + hhmmss() + '（+' + r.added + ' 条）');
      delete S.errors.usage;
    }).catch(function () {
    }).then(function () {
      // busy 只由置位者清。delta 全程不置 busy.usage（上面 busy=true 就直接返回了），
      // 在这里写 false 只会清掉别人的标记：并发的全量扫描（loadUsage/ensureWindow
      // 置的「统计中」）会被提前抹掉，UI 报已完成而扫描其实还在跑
      if (S.tab === 'overview') renderOverview();
      if (S.tab === 'usage') renderUsage();
      if (S.tab === 'tokens') renderTokens();
    });
  }

  var timingBackfilled = false;

  function backfillTiming() {
    if (timingBackfilled) return Promise.resolve(0);
    timingBackfilled = true;
    var st = rawLoad();
    if (!st.rows.length) return Promise.resolve(0);
    var need = 0, lim = Math.min(100, st.rows.length);
    for (var i = 0; i < lim; i++) if (!st.rows[i][7] || st.rows[i][9] === undefined || st.rows[i][10] === undefined) need++;
    if (!need) return Promise.resolve(0);
    var idx = rowIdx(st, 800);
    return napiRaw('/api/log/?p=1&page_size=100&type=2', 'GET', undefined, true).then(function (d) {
      var items = (d && d.items) || [];
      var patched = 0;
      for (var j = 0; j < items.length; j++) if (fillTiming(idx, logRow(items[j]))) patched++;
      if (!patched) return 0;
      rawMeta();
      rawSave(true);
      S.usage = rawAggFor(CFG.range);
      if (S.tab === 'usage') renderUsage();
      if (S.tab === 'overview') renderOverview();
      return patched;
    }).catch(function () { return 0; });
  }

  function autoTick() {
    if (document.hidden) return;
    var sheet = $('#sheet');
    if (sheet && sheet.className !== 'hidden') return;
    if (S.busy.usage || S.busy.over || S.busy.wb) return;
    if (!CFG.newapiToken && !CFG.hubPass) return;
    if (CFG.newapiToken) {
      loadOverview(false);
      refreshUsageDelta();
    }
    if (CFG.hubPass) loadWB(false);
  }

  function startAutoRefresh() {
    if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
    var sec = parseInt(CFG.autoRefresh, 10);
    if (!sec || sec < 15) return;
    autoTimer = setInterval(autoTick, sec * 1000);
  }

  function refreshAll() {
    if (!CFG.newapiToken && !CFG.hubPass) { toast('先在设置里填写凭证', 'err'); return; }
    if (CFG.newapiToken) {
      loadOverview(true);
      loadUsage(CFG.range, !S.busy.usage);
    }
    if (CFG.hubPass) loadWB(true);
  }

  function refreshCurrent() {
    if (S.tab === 'overview') { loadOverview(true); loadUsage(CFG.range, false); loadWB(false); }
    else if (S.tab === 'tokens') { loadOverview(true); loadUsage(CFG.range, false); }
    else if (S.tab === 'usage') { loadUsage(CFG.range, true); }
    else if (S.tab === 'wb') { S.hubToken = ''; loadWB(true); }
    else if (S.tab === 'settings') renderSettings();
  }

  window.__onBack = function () {
    var sheet = $('#sheet');
    if (sheet && sheet.className !== 'hidden') { hideSheet(); return true; }
    if (S.tab !== 'overview') { showTab('overview'); return true; }
    return false;
  };

  function syncEye() {
    var b = $('#btn-eye');
    if (!b) return;
    b.classList.toggle('on', !!CFG.privacy);
    b.setAttribute('aria-label', CFG.privacy ? '显示名称' : '隐藏名称');
    b.setAttribute('title', CFG.privacy ? '显示令牌名 / 账号名' : '隐藏令牌名 / 账号名');
  }

  function boot() {
    purgeLegacyCache();
    if (!CFG.channel) CFG.channel = 'native';
    // 冲突 = https 地址 + 原生通道：网页版回落「自动」（https→浏览器内核 / http→原生），
    // 比直接压成「浏览器内核」更好——用户换回内网地址时自动恢复原生，不必再手动改。
    // 壳内例外：壳内「自动」的 https 分支必落到跨源受限的浏览器内核（必失败），保持原生，
    // 由设置页的冲突卡如实提示「改用内网地址 / 服务端开 CORS」。
    if (isConflicted() && !inShell()) CFG.channel = 'auto';

    if (looksUrl(CFG.newapiToken)) {
      var misplaced = CFG.newapiToken;
      if (!looksUrl(CFG.newapiBase) || CFG.newapiBase === DEF.newapiBase) {
        CFG.newapiBase = normBase(misplaced);
      }
      CFG.newapiToken = '';
      CFG.tokenCleared = true;
    }
    saveCfg();
    // 启动先接管 IDB 里更全的仓：localStorage 镜像可能因配额被砍过（老版本会砍到 4000–12000 行）
    rawIdbAdopt().then(function (adopted) {
      if (!adopted) return;
      rawAggMem = {};
      rawVer++;
      if (S.tab === 'usage') renderUsage();
      if (S.tab === 'overview') renderOverview();
    });
    bindTabs();
    $('#btn-refresh').onclick = refreshCurrent;
    syncEye();
    $('#btn-eye').onclick = function () {
      CFG.privacy = !CFG.privacy;
      saveCfg();
      syncEye();
      renderOverview(); renderTokens(); renderUsage(); renderWB();
      setSub(CFG.privacy ? '已隐藏名称' : '已显示名称');
    };
    startAutoRefresh();
    // 启动后在后台静默查一次更新（延迟 3s，避开冷启动抢资源）。
    // autoUpd 自己有三重门（壳内/file://、有真实版本、同日没查过），网页版与 harness 里是空转。
    setTimeout(autoUpd, 3000);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && parseInt(CFG.autoRefresh, 10) > 0) {
        if (CFG.newapiToken) { loadOverview(false); loadUsage(CFG.range, false); }
        if (CFG.hubPass) loadWB(false);
      }
    });

    $('#views').addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
      if (!btn) return;
      var act = btn.getAttribute('data-act');
      var id = btn.getAttribute('data-id');
      if (act === 'ov-range') { toggleOverviewRange(); return; }
      if (act === 'tok-range') { setRange(btn.getAttribute('data-range')); return; }
      if (act === 'models-more') {
        S.modelsExpanded = !S.modelsExpanded;
        renderWB();
        return;
      }
      if (act === 'rem-toggle') {
        var rk2 = btn.getAttribute('data-key') || '';
        if (!S.remOpen) S.remOpen = {};
        if (S.remOpen[rk2]) delete S.remOpen[rk2]; else S.remOpen[rk2] = 1;
        renderWB();
        return;
      }
      if (act === 'acc-realm') {
        CFG.accRealm = btn.getAttribute('data-realm') || 'all';
        saveCfg();
        renderWB();
        return;
      }
      if (act === 'acc-expand') {
        var uidE = btn.getAttribute('data-uid');
        S.accOpen = S.accOpen || {};
        S.accOpen[uidE] = !S.accOpen[uidE];
        renderWB();
        return;
      }
      if (act === 'acc-toggle') {
        var uid = btn.getAttribute('data-uid');
        toggleAccount(uid, btn.getAttribute('data-on') !== '1');
        return;
      }
      if (act === 'toggle') toggleToken(id);
      else if (act === 'edit') openTokenSheet(id);
      else if (act === 'key') copyKey(id);
      if (act === 'tok-new') newTokenSheet();
      else if (act === 'tok-filter') {
        CFG.tokFilter = btn.getAttribute('data-f') || 'all';
        saveCfg();
        renderTokens();
      }
    });

    document.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('[data-err]') : null;
      if (!b) return;
      var act = b.getAttribute('data-err');
      if (act === 'settings') { showTab('settings'); return; }
      if (act === 'native') {
        // 壳内直连失败的一键退路：只切通道，不换网关 → 面板令牌仍然有效，不许清 S.hubToken
        CFG.channel = 'native';
        saveCfg();
        toast('已切回「原生请求」，正在重试…', 'ok');
        refreshAll();
        renderSettings();
        return;
      }
      if (act === 'lan') {
        if (presetOk(PRESETS.lan.newapiBase)) CFG.newapiBase = PRESETS.lan.newapiBase;
        if (presetOk(PRESETS.lan.hubBase)) CFG.hubBase = PRESETS.lan.hubBase;
        CFG.channel = 'auto';
        saveCfg();
        S.hubToken = '';
        toast('已切到内网地址，正在重试…', 'ok');
        refreshAll();
        renderSettings();
        return;
      }
      refreshCurrent();
    });

    showTab('overview');
    if (!CFG.newapiToken && !CFG.hubPass) {
      showTab('settings');
      toast('先填 NewAPI 令牌与 账号池面板密码', 'ok');
      return;
    }
    refreshAll();
    backfillTiming();
  }

  window.__app = {
    state: S, cfg: function () { return CFG; }, showTab: showTab, refreshAll: refreshAll,
    loadOverview: loadOverview, loadUsage: loadUsage, loadWB: loadWB,
    refreshUsageDelta: refreshUsageDelta, autoTick: autoTick, startAutoRefresh: startAutoRefresh,
    raw: function () { var st = rawLoad(); return { at: st.at, since: st.since, newest: st.newest, pages: st.pages, complete: st.complete, coverFrom: st.coverFrom == null ? null : st.coverFrom, rows: st.rows.length, degraded: rawDegraded, idb: idbOK }; },
    pf: function () { return { queued: prefetchQueued, timer: !!prefetchTimer, scan: (rawLoad().scan || null) }; },
    meta: function () { rawMeta(); rawSave(true); return this.raw(); },
    probe: function () {
      return Promise.race([
        queueScan(function () { return 'alive'; }),
        new Promise(function (r) { setTimeout(function () { r('BLOCKED'); }, 3000); })
      ]);
    },
    lastErr: function () { return S.lastErr || null; },
    lastScan: function () { return rawLoad().scan || null; },
    rawAgg: rawAggFor, rawClear: function () { try { localStorage.removeItem(RAW_KEY); } catch (e) {} idbDel(); rawStore = null; rawAggMem = {}; rawVer++; rawDegraded = false; },
    backfillTiming: backfillTiming, speedText: speedText,
    reqlog: function () { return (S.reqlog || []).length; },
    /* ── 测试钩子（P0-0 harness 用，无副作用，不参与业务逻辑）── */
    cacheSize: function () { return Object.keys(cacheMem).length; },
    cacheClear: function () { cacheMem = {}; try { for (var i = localStorage.length - 1; i >= 0; i--) { var k = localStorage.key(i); if (k && k.indexOf(CACHE_PREFIX) === 0) localStorage.removeItem(k); } } catch (e) { } },
    __setNow: function (sec) { var t = sec * 1000; Date.now = function () { return t; }; },
    // 缩放日志仓容量上限：F4b 要「少量行就够触发截断」，否则只能手写 40100 行数据。
    // 传正数生效并返回生效值，传非法值仅返回当前值（不静默改坏）。恢复用 __setRawCap(40000)。
    __setRawCap: function (n) { var v = Math.floor(num(n)); if (v > 0) RAW_CAP = v; return RAW_CAP; },
    __http: http,
    __pending: function () { return Object.keys(pending).length; },
    rawKey: function () { return RAW_KEY; },
    // 日志仓所属网关的规范值（只读）：harness 的 seedRaw 要按当前网关打指纹，
    // 否则「无 base 的老仓一律作废」会把每个 fixture 的 seed 都当成待清仓
    gatewayBase: function () { return rawBase(); },
    // 日志仓持久层（IndexedDB）显式接口：F29 用它证明「配额写满也不砍行、重启能从 IDB 接上」
    rawAdopt: function () { return rawIdbAdopt(); },
    rawDropMem: function () { rawDropMem(); },
    // 自动刷新状态（只读）：定时器在不在 + 当前间隔。F27 用它证明「改完立刻生效」不是只写了配置。
    autoState: function () { return { on: !!autoTimer, sec: num(CFG.autoRefresh) }; },
    // 本页第一次 rawLoad() 看到的网关值（只读）：凭证通道若被改成异步/延后加载，
    // 这里会变成 ''，等于把「每次冷启动整仓清空重扫」摆到断言里
    rawFirstBase: function () { return rawFirstBase; },
    // 凭证通道状态（只读）+ 落盘入口，供 harness 断言「无桥时 4 键必须回退明文」
    secureState: function () { return { available: secureAvailable(), dead: secureDead, err: SECURE_ERR, keys: SECURE_KEYS.slice() }; },
    // 构建期预设对象（引用，harness 可改）：正式包由 build.sh 注入真地址，
    // 源码里是 __PRESET_*__ 占位 → presetReady() 恒假，「改用内网地址」这类分支在测试里
    // 永远渲染不出来。给个可写引用，才能把「预设就绪」这条路径钉进回归。
    presets: function () { return PRESETS; },
    // 更新检查（只提示、不自动下载）。checkUpdate 可传 {force:true, cur, urls} 供 harness 定住
    // 版本号/端点，避免用例依赖真网与真机版本；autoUpd 是启动时那次（三重门在函数内）。
    checkUpdate: checkUpdate, autoUpd: autoUpd, verCmp: verCmp,
    // 结论落盘/取回：供 harness 断言「重开 App 仍显示上次结论」与三条作废门槛
    updRestore: updRestore, updForget: function () { UPD = { state: 'idle', cur: '', tag: '', url: '', notes: '', at: 0 }; },
    updStore: function () { try { return JSON.parse(localStorage.getItem(UPD_LAST) || 'null'); } catch (e) { return null; } },
    upd: function () { return { state: UPD.state, cur: UPD.cur, tag: UPD.tag, url: UPD.url, notes: updNotes(), at: UPD.at, atText: updAtText() }; },
    saveCfg: saveCfg
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

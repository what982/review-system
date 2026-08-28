// 智慧课评系统 · Cloudflare Pages Functions API
// 所有 /api/* 请求在此统一处理，后端对接 Cloudflare D1（绑定名 REVIEW_DB）。
// 前端不再直连任何第三方数据库，改为同源 fetch('/api/...')，跨设备天然共享同一份 D1 数据。
//
// 鉴权说明：
//  - 除 ping / login / logout / me / setup 外，所有数据接口强制校验登录态（HttpOnly Cookie 会话）。
//  - 密码以 PBKDF2-HMAC-SHA256 加盐哈希存储，库内无明文。
//  - 登录失败连续 5 次锁定该用户名 15 分钟（基础防暴破）。

// 表名 → D1 真实表名 + 允许写入的列白名单（防止客户端注入未知列）
const TABLES = {
  classes:  { db: 'review_classes',  cols: ['id', 'name'] },
  students: { db: 'review_students', cols: ['id', 'stuId', 'name', 'classId'] },
  records:  { db: 'review_records',  cols: ['id', 'studentId', 'studentName', 'classId', 'classContent', 'classTopic', 'reviewText', 'recorddate'] },
};

const H = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(body, status) {
  return new Response(JSON.stringify(body), { status: status || 200, headers: H });
}
function fail(msg, status) {
  return new Response(JSON.stringify({ error: msg }), { status: status || 400, headers: H });
}

function toInt(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}
function toStr(v) {
  if (v === null || v === undefined) return '';
  return String(v);
}

// ── 密码哈希与令牌工具（Web Crypto 原生，无第三方依赖）──
const PBKDF2_ITER = 100000;          // 迭代次数，足够抗暴力
const SESSION_TTL = 365 * 24 * 60 * 60 * 1000; // 会话有效期 1 年（登录后不自动退出）

function bufToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function base64ToBuf(b64) {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}
function bufToHex(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}
async function pbkdf2(password, saltBytes) {
  const enc = new TextEncoder();
  const keyMat = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations: PBKDF2_ITER, hash: 'SHA-256' },
    keyMat, 256
  );
  return new Uint8Array(bits);
}
// 生成 "盐:派生值"，盐与派生值均 base64 编码
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const derived = await pbkdf2(password, salt);
  return bufToBase64(salt) + ':' + bufToBase64(derived);
}
// 校验密码，常量时间比较防时序攻击
async function verifyPassword(password, stored) {
  if (!stored || stored.indexOf(':') < 0) return false;
  const [saltB64, derivedB64] = stored.split(':');
  const derived = await pbkdf2(password, base64ToBuf(saltB64));
  const a = base64ToBuf(derivedB64);
  const b = derived;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ^ b[i]);
  return diff === 0;
}
async function sha256Hex(str) {
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(str));
  return bufToHex(new Uint8Array(digest));
}
function randomTokenHex() {
  return bufToHex(crypto.getRandomValues(new Uint8Array(32)));
}
// 会话 Cookie：HttpOnly + Secure + SameSite，前端脚本偷不到、跨站不携带
function sessionCookie(token) {
  const value = token ? encodeURIComponent(token) : '';
  const maxAge = token ? Math.floor(SESSION_TTL / 1000) : 0;
  return `session=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}
function getCookie(request, name) {
  const c = request.headers.get('Cookie');
  if (!c) return null;
  for (const part of c.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    if (k === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}
// 从 Cookie 中取出会话，校验是否存在且未过期；返回 {id, username} 或 null
async function getSessionUser(request, db) {
  const token = getCookie(request, 'session');
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const row = await db.prepare(
    'SELECT s.user_id AS uid, s.expire_at AS expire_at, u.username AS username '
    + 'FROM review_sessions s JOIN review_users u ON u.id = s.user_id '
    + 'WHERE s.token_hash = ?'
  ).bind(tokenHash).first();
  if (!row) return null;
  if (row.expire_at && Date.now() > row.expire_at) return null;
  return { id: row.uid, username: row.username };
}

// ── 各登录接口处理 ──
async function handleSetup(request, db) {
  if (request.method.toUpperCase() !== 'POST') return fail('method not allowed', 405);
  const existing = await db.prepare('SELECT COUNT(*) AS c FROM review_users').first();
  if (existing && existing.c > 0) return fail('管理员已存在，无法重复初始化', 403);
  const body = await request.json().catch(() => ({}));
  const username = (body.username || '').toString().trim();
  const password = (body.password || '').toString();
  if (!username) return fail('用户名不能为空');
  if (password.length < 6) return fail('密码至少 6 位');
  const passHash = await hashPassword(password);
  await db.prepare('INSERT INTO review_users (username, pass_hash, created_at) VALUES (?, ?, ?)')
    .bind(username, passHash, Date.now()).run();
  return json({ ok: true, username });
}
async function handleLogin(request, db) {
  if (request.method.toUpperCase() !== 'POST') return fail('method not allowed', 405);
  const body = await request.json().catch(() => ({}));
  const username = (body.username || '').toString().trim();
  const password = (body.password || '').toString();
  const now = Date.now();

  // 限流：该用户名已锁定且未到期 → 直接拒绝
  const at = await db.prepare('SELECT fails, locked_until FROM login_attempts WHERE key = ?').bind(username).first();
  if (at && at.locked_until && at.locked_until > now) {
    const waitMin = Math.ceil((at.locked_until - now) / 60000);
    return fail(`尝试次数过多，请 ${waitMin} 分钟后再试`, 429);
  }

  const user = await db.prepare('SELECT id, username, pass_hash FROM review_users WHERE username = ?').bind(username).first();
  // 统一错误文案，避免用户名枚举
  if (!user || !(await verifyPassword(password, user.pass_hash))) {
    const fails = (at ? at.fails : 0) + 1;
    const lockedUntil = fails >= 5 ? now + 15 * 60 * 1000 : 0;
    await db.prepare(
      'INSERT INTO login_attempts (key, fails, locked_until) VALUES (?, ?, ?) '
      + 'ON CONFLICT(key) DO UPDATE SET fails = ?, locked_until = ?'
    ).bind(username, fails, lockedUntil, fails, lockedUntil).run();
    return fail('用户名或密码错误', 401);
  }

  // 成功：清除失败计数，建立会话
  await db.prepare('DELETE FROM login_attempts WHERE key = ?').bind(username).run();
  const token = randomTokenHex();
  const tokenHash = await sha256Hex(token);
  await db.prepare(
    'INSERT INTO review_sessions (id, token_hash, user_id, created_at, expire_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(randomTokenHex(), tokenHash, user.id, now, now + SESSION_TTL).run();
  const res = json({ ok: true, username: user.username });
  res.headers.append('Set-Cookie', sessionCookie(token));
  return res;
}
async function handleLogout(request, db) {
  if (request.method.toUpperCase() !== 'POST') return fail('method not allowed', 405);
  const token = getCookie(request, 'session');
  if (token) {
    const tokenHash = await sha256Hex(token);
    await db.prepare('DELETE FROM review_sessions WHERE token_hash = ?').bind(tokenHash).run();
  }
  const res = json({ ok: true });
  res.headers.append('Set-Cookie', sessionCookie(null));
  return res;
}
async function handleMe(request, db) {
  const token = getCookie(request, 'session');
  if (!token) return json({ loggedIn: false });
  const tokenHash = await sha256Hex(token);
  const row = await db.prepare(
    'SELECT s.expire_at AS expire_at, u.username AS username '
    + 'FROM review_sessions s JOIN review_users u ON u.id = s.user_id '
    + 'WHERE s.token_hash = ?'
  ).bind(tokenHash).first();
  if (!row || (row.expire_at && Date.now() > row.expire_at)) return json({ loggedIn: false });
  return json({ loggedIn: true, username: row.username });
}

// 写入成功后通知 SyncHub 广播：让其它在线设备立即拉取最新数据（近实时跨设备同步）。
// 通过 Pages 的 script_name Durable Object 绑定直接调用 SyncHub DO（DO 由 sync-hub-worker 持有）。
// 浏览器 WebSocket 也由该 Worker 直接终止，且同样落在 idFromName('global') 这一个 DO 实例上，
// 因此这里的广播必定推送到所有已连接设备。
// 注意：
//  - 不能用「同源 HTTP 自调用 /api/sync/broadcast」——Pages Function 内部同域请求会回环到 Pages 自身，
//    永远命中不了 Worker 路由，广播丢失（已实测验证）。
//  - 也不能用 workers.dev 地址广播——workers.dev 与自定义域名路由会解析到不同的 DO 实例，
//    而 WebSocket 只能走自定义域名（workers.dev 不支持 WS 升级），导致推送错实例。
// 因此 script_name DO 引用是唯一可靠的同源同实例广播方式。
async function broadcastChange(env) {
  try {
    if (!env.SYNC_HUB) return;
    const hub = env.SYNC_HUB.get(env.SYNC_HUB.idFromName('global'));
    await hub.fetch('https://internal/broadcast', { method: 'POST' });
  } catch (e) {
    console.error('broadcast failed', e);
  }
}

// ── 全局版本号（边缘缓存失效用）──
// meta.global_version 任一表写入后 +1，GET 缓存键随版本变化自动失效，列表读取边缘加速且数据新鲜。
async function getCanonicalVersion(db) {
  try {
    const r = await db.prepare("SELECT val FROM meta WHERE key='global_version'").first();
    return (r && typeof r.val === 'number') ? r.val : 1;
  } catch (e) {
    return 1; // meta 表尚未建立时退化为 1，读取仍可工作（只是不缓存）
  }
}
async function bumpGlobalVersion(db) {
  try {
    await db.prepare("UPDATE meta SET val = val + 1 WHERE key='global_version'").run();
  } catch (e) { /* 版本表缺失不影响主流程 */ }
}

export async function onRequest(context) {
  const { request, env } = context;
  const method = request.method.toUpperCase();

  // CORS 预检
  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: H });

  const db = env.REVIEW_DB;
  if (!db) return fail('D1 绑定 REVIEW_DB 未配置', 500);

  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/?/, '').replace(/\/+$/, '');

  // 健康检查（公开）
  if (path === '' || path === 'ping') {
    if (method === 'GET' || method === 'HEAD') return json({ ok: true, time: Date.now() });
    return fail('method not allowed', 405);
  }

  // 登录相关接口（公开，不需要登录态）
  if (path === 'setup')  return handleSetup(request, db);
  if (path === 'login')  return handleLogin(request, db);
  if (path === 'logout') return handleLogout(request, db);
  if (path === 'me')     return handleMe(request, db);

  // 以下数据接口强制登录
  const user = await getSessionUser(request, db);
  if (!user) return fail('未登录或登录已失效', 401);

  const table = TABLES[path];
  if (!table) return fail('未知表: ' + path, 404);
  const tname = table.db;
  const cols = table.cols;

  try {
    // ── 列表 ──
    if (method === 'GET') {
      let sql = 'SELECT * FROM ' + tname;
      sql += (path === 'records') ? ' ORDER BY recorddate DESC' : ' ORDER BY id ASC';
      // 边缘缓存：缓存键随全局版本号变化失效，TTL 10s 兜底
      const ver = await getCanonicalVersion(db);
      const cacheUrl = 'https://edge-cache.local/' + path + ':v' + ver + ':u' + user.id;
      const cached = await caches.default.match(cacheUrl);
      if (cached) {
        const h = new Headers(cached.headers);
        h.set('X-Cache', 'HIT');
        return new Response(cached.body, { status: cached.status, headers: h });
      }
      const res = await db.prepare(sql).all();
      const rows = (res && res.results !== undefined) ? res.results : (res || []);
      const headers = new Headers(H);
      headers.set('Cache-Control', 'max-age=10');
      headers.set('X-Cache', 'MISS');
      const resp = new Response(JSON.stringify({ data: rows }), { status: 200, headers });
      await caches.default.put(cacheUrl, resp.clone());
      return resp;
    }

    // ── 写入（upsert，按 id 幂等）──
    if (method === 'POST') {
      const body = await request.json().catch(() => ({}));
      let items = Array.isArray(body) ? body
                : (body.items && Array.isArray(body.items)) ? body.items
                : (body.id !== undefined ? [body] : []);
      if (!items.length) return fail('缺少待保存数据');

      for (const it of items) {
        const clean = cols.map((c) => {
          const v = it[c];
          return (c === 'id' || c === 'classId' || c === 'studentId') ? toInt(v) : toStr(v);
        });
        const placeholders = cols.map(() => '?').join(',');
        const setClause = cols.filter((c) => c !== 'id').map((c) => c + '=excluded.' + c).join(',');
        const sql = 'INSERT INTO ' + tname + ' (' + cols.join(',') + ') VALUES (' + placeholders + ') '
                  + 'ON CONFLICT(id) DO UPDATE SET ' + setClause;
        await db.prepare(sql).bind(...clean).run();
      }
      await broadcastChange(env);
      await bumpGlobalVersion(db);
      return json({ ok: true, count: items.length });
    }

    // ── 删除 ──
    if (method === 'DELETE') {
      const body = await request.json().catch(() => ({}));
      const ids = (body.ids && Array.isArray(body.ids)) ? body.ids
                : (body.id !== undefined ? [body.id] : []);
      if (!ids.length) return fail('缺少 id');
      for (const id of ids) {
        await db.prepare('DELETE FROM ' + tname + ' WHERE id=?').bind(toInt(id)).run();
      }
      await broadcastChange(env);
      await bumpGlobalVersion(db);
      return json({ ok: true, count: ids.length });
    }

    return fail('method not allowed', 405);
  } catch (e) {
    return fail('服务端错误: ' + (e && e.message ? e.message : String(e)), 500);
  }
}

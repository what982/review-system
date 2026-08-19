// 智慧课评系统 · Cloudflare Pages Functions API
// 所有 /api/* 请求在此统一处理，后端对接 Cloudflare D1（绑定名 REVIEW_DB）。
// 前端不再直连任何第三方数据库，改为同源 fetch('/api/...')，跨设备天然共享同一份 D1 数据。

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

export async function onRequest(context) {
  const { request, env } = context;
  const method = request.method.toUpperCase();

  // CORS 预检
  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: H });

  const db = env.REVIEW_DB;
  if (!db) return fail('D1 绑定 REVIEW_DB 未配置', 500);

  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/?/, '').replace(/\/+$/, '');

  // 健康检查
  if (path === '' || path === 'ping') {
    if (method === 'GET' || method === 'HEAD') return json({ ok: true, time: Date.now() });
    return fail('method not allowed', 405);
  }

  const table = TABLES[path];
  if (!table) return fail('未知表: ' + path, 404);
  const tname = table.db;
  const cols = table.cols;

  try {
    // ── 列表 ──
    if (method === 'GET') {
      let sql = 'SELECT * FROM ' + tname;
      sql += (path === 'records') ? ' ORDER BY recorddate DESC' : ' ORDER BY id ASC';
      const res = await db.prepare(sql).all();
      const rows = (res && res.results !== undefined) ? res.results : (res || []);
      return json({ data: rows });
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
      return json({ ok: true, count: ids.length });
    }

    return fail('method not allowed', 405);
  } catch (e) {
    return fail('服务端错误: ' + (e && e.message ? e.message : String(e)), 500);
  }
}

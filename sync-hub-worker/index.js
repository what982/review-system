// 智慧课评系统 · 实时同步中枢 Durable Object（独立 Worker 承载）
// 本 Worker 同时负责：
//   1) 终止浏览器 WebSocket（wss://<host>/api/sync/events）并交由 SyncHub DO 托管
//   2) 接收来自 Pages API 的 /api/sync/broadcast HTTP 调用，向全部在线设备广播 "changed"
// 关键：WebSocket 与广播都落在同一个 DO 实例（idFromName('global')），保证写入后立即推送到所有连接。
// 注意：WebSocket 必须由 Worker 直接终止（Pages Functions 无法稳定持有 DO 的 WebSocket 长连接）。

export class SyncHub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    // ── 内部广播入口：由 Pages API 写入成功后调用，向所有已连接 WebSocket 推送变更通知 ──
    if (url.pathname.endsWith('/broadcast')) {
      const payload = JSON.stringify({ type: 'changed', ts: Date.now() });
      let delivered = 0;
      for (const ws of this.state.getWebSockets()) {
        try { ws.send(payload); delivered++; } catch (e) { /* 已断开，忽略 */ }
      }
      return new Response(JSON.stringify({ ok: true, delivered }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // ── 调试入口：返回当前在线连接数 ──
    if (url.pathname.endsWith('/count')) {
      return new Response(JSON.stringify({ connections: this.state.getWebSockets().length }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // ── WebSocket 升级（浏览器连接 /api/sync/events 时进入）──
    const upgrade = request.headers.get('Upgrade');
    if (upgrade !== 'websocket') {
      return new Response('expected websocket', { status: 400 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  // ── WebSocket Hibernation 事件 ──
  async webSocketMessage(ws, message) {
    // 应用层保活：前端定期发 {type:'ping'}，此处回显 pong 以确认链路存活
    try {
      const text = typeof message === 'string' ? message : (message && message.text ? message.text() : '');
      let obj = null;
      try { obj = text ? JSON.parse(text) : null; } catch (_) {}
      if (obj && obj.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
      }
    } catch (e) { /* 忽略 */ }
  }
  async webSocketClose(ws) { try { ws.close(); } catch (e) {} }
  async webSocketError(ws) { try { ws.close(); } catch (e) {} }
}

export default {
  async fetch(request, env) {
    // 所有请求统一转发到全局 SyncHub DO 实例（WebSocket 升级 / 广播 / 调试 都在 DO 内处理）
    const id = env.SYNC_HUB.idFromName('global');
    const hub = env.SYNC_HUB.get(id);
    return hub.fetch(request);
  }
};

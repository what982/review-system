// 实时同步端到端验证：连接 WebSocket → 触发一次写入 → 断言收到 "changed" 广播 → 清理测试数据
const WS = globalThis.WebSocket;
const BASE = 'https://keping.whatis.dpdns.org';
const WSURL = 'wss://keping.whatis.dpdns.org/api/sync/events';
const TEST_ID = 888888000123;

const ws = new WS(WSURL);
let got = false;

ws.onopen = () => {
  console.log('✅ WS 已连接 (' + WSURL + ')');
  // 发一个应用层 ping，验证链路存活（DO 应回 pong）
  try { ws.send(JSON.stringify({ type: 'ping' })); } catch (e) {}
  setTimeout(triggerWrite, 800);
};
ws.onmessage = (e) => {
  console.log('📨 收到消息:', e.data);
  try {
    const m = JSON.parse(e.data);
    if (m && m.type === 'pong') console.log('✅ 链路存活(pong)');
    if (m && m.type === 'changed') { got = true; cleanup(); }
  } catch (_) {}
};
ws.onerror = (e) => { console.error('❌ WS error', e && e.message); process.exit(2); };
ws.onclose = () => { console.log('WS 关闭'); };

function triggerWrite() {
  fetch(BASE + '/api/records', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ id: TEST_ID, studentId: 1, studentName: 'rt-test', classId: 1, classContent: 'rt', classTopic: '', reviewText: 'rt-test', recorddate: '2026-08-16 18:00:00' }] })
  }).then(r => r.json()).then(j => console.log('✅ 写入完成:', JSON.stringify(j))).catch(e => console.error('❌ 写入失败', e));
}

function cleanup() {
  fetch(BASE + '/api/records', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: TEST_ID })
  }).then(r => r.json()).then(j => { console.log('🧹 测试数据已清理:', JSON.stringify(j)); setTimeout(() => process.exit(got ? 0 : 1), 300); }).catch(e => { console.error('清理失败', e); process.exit(got ? 0 : 1); });
}

setTimeout(() => {
  console.log(got ? '✅ 实时广播验证通过' : '❌ 超时未收到广播');
  process.exit(got ? 0 : 1);
}, 9000);

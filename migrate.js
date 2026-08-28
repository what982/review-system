// 一次性迁移：把 Supabase 现有数据写入新 Cloudflare D1（保留原 id，upsert 幂等）
const SUP = 'https://jquoooxqmwlqnqkpfxrm.supabase.co/rest/v1';
const KEY = 'sb_publishable_bkQDJ3_R0zStq2yia6zotw_tPh_ePvV';
const API = 'https://review-system-xru.pages.dev/api';
const H = { 'apikey': KEY, 'Authorization': 'Bearer ' + KEY };

async function get(table) {
  const res = await fetch(`${SUP}/${table}?select=*&limit=200000`, { headers: H });
  if (!res.ok) throw new Error(`${table} fetch ${res.status}`);
  return await res.json();
}
async function post(ep, items) {
  const res = await fetch(`${API}/${ep}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items })
  });
  return { status: res.status, body: await res.text() };
}

(async () => {
  for (const t of ['review_classes', 'review_students', 'review_records']) {
    const data = await get(t);
    const ep = t.replace('review_', '');
    console.log(`\n[${t}] 拉取 ${data.length} 行 → 写入 /api/${ep}`);
    let ok = 0, fail = 0;
    for (let i = 0; i < data.length; i += 200) {
      const chunk = data.slice(i, i + 200);
      const r = await post(ep, chunk);
      if (r.status >= 200 && r.status < 300) ok += chunk.length;
      else { fail += chunk.length; console.error('  chunk失败:', r.status, r.body.slice(0, 200)); }
    }
    console.log(`  成功 ${ok} / 失败 ${fail}`);
  }
  console.log('\n迁移完成');
})().catch(e => { console.error('迁移出错:', e); process.exit(1); });

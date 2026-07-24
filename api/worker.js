// NutriFlow 云同步 Worker（Cloudflare Workers + D1）。
//
// 一个极简的「文档」键值存储：每个 key 存一段 JSON（value）。NutriFlow 网页把
// 手动补记的餐食（localStorage 里的 nutriflow_diet_entries_v1）整段存进来，
// 换设备打开时再整段拉回，实现跨设备同步。单用户自用，够用且好维护。
//
// 鉴权：所有 /doc 请求都要带 `Authorization: Bearer <SYNC_TOKEN>`，SYNC_TOKEN 是
// 部署时用 `wrangler secret put SYNC_TOKEN` 设的密钥，只有你自己知道，别人写不了。
//
// 路由：
//   GET  /            健康检查
//   GET  /doc/:key    读一段文档  -> {value, updatedAt} 或 {value:null}
//   PUT  /doc/:key    写一段文档，body {value}  -> {ok:true, updatedAt}
//
// 表在第一次请求时惰性建好（CREATE TABLE IF NOT EXISTS），不用单独跑迁移。

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

async function ensureTable(env) {
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS documents (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)"
  ).run();
}

function authorized(request, env) {
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  // env.SYNC_TOKEN 没设时一律拒绝，避免忘配密钥就裸奔。
  return env.SYNC_TOKEN && token && token === env.SYNC_TOKEN;
}

// key 只允许字母数字下划线，避免奇怪输入。
function cleanKey(key) {
  return /^[A-Za-z0-9_]{1,64}$/.test(key) ? key : null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (url.pathname === "/" || url.pathname === "") {
      return json({ ok: true, service: "nutriflow-sync" });
    }

    const match = url.pathname.match(/^\/doc\/([^/]+)$/);
    if (!match) return json({ error: "not found" }, 404);

    if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);

    const key = cleanKey(decodeURIComponent(match[1]));
    if (!key) return json({ error: "bad key" }, 400);

    try {
      await ensureTable(env);

      if (request.method === "GET") {
        const row = await env.DB.prepare("SELECT value, updated_at FROM documents WHERE key = ?")
          .bind(key)
          .first();
        if (!row) return json({ value: null, updatedAt: null });
        return json({ value: JSON.parse(row.value), updatedAt: row.updated_at });
      }

      if (request.method === "PUT") {
        const body = await request.json().catch(() => null);
        if (!body || !("value" in body)) return json({ error: "missing value" }, 400);
        const updatedAt = new Date().toISOString();
        await env.DB.prepare(
          "INSERT INTO documents (key, value, updated_at) VALUES (?, ?, ?) " +
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
        )
          .bind(key, JSON.stringify(body.value), updatedAt)
          .run();
        return json({ ok: true, updatedAt });
      }

      return json({ error: "method not allowed" }, 405);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "server error" }, 500);
    }
  },
};

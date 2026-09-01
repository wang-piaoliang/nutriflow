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
//   POST /recognize   代替手机去调模型认小票（可选，见下）
//
// 表在第一次请求时惰性建好（CREATE TABLE IF NOT EXISTS），不用单独跑迁移。
//
// ---- 为什么要有 /recognize ----
// iOS 一旦把网页挂到后台就会掐断正在跑的请求，而识别一张小票要十几秒。用户经常是
// 「拍完照片就切走」，回来发现什么都没记上。网页这边已经做了落盘 + 队列 + 回到前台
// 自动补跑，但那治标——真正的问题是**活儿在手机上干**。
//
// 挪到这里就没这个问题了：手机只负责把照片发过来（几百 KB，一两秒），剩下的十几秒
// 由 Worker 用 ctx.waitUntil() 接着干完，**手机就算马上锁屏也不影响**。结果写进
// documents 表，key 是 job_<id>，手机下次打开用现成的 GET /doc/job_<id> 取回来。
//
// 照片本身不落库，只在这一次请求的内存里过一道。要用这个功能得另外设一个密钥：
//   npx wrangler secret put GEMINI_KEY
// 不设的话这个端点直接返回 501，网页会自己退回「在手机上识别」的老路。

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
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

// 挑模型的规矩和网页那边一样：免费额度按模型分开算，lite 档最宽松，pro 一天只有
// 个位数、绝不能选。这里不再问 ListModels——Worker 是长期跑的，写死一个浮动别名
// 更省事，真过期了改这一行重新 deploy 即可。
const GEMINI_MODEL = "gemini-flash-lite-latest";

async function callGemini(key, photos, prompt) {
  // 一单可能是好几张截图，逐张认、把商品并起来——和网页里 recognizeReceipts 一个思路。
  const texts = [];
  for (const photo of photos) {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(key)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ inline_data: { mime_type: photo.mime || "image/jpeg", data: photo.data } }, { text: prompt }] }],
          generationConfig: { responseMimeType: "application/json" },
        }),
      }
    );
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Gemini HTTP ${response.status}: ${detail.slice(0, 200)}`);
    }
    const data = await response.json();
    texts.push((data?.candidates?.[0]?.content?.parts || []).map((part) => part.text || "").join(""));
  }
  return texts;
}

async function writeDoc(env, key, value) {
  await ensureTable(env);
  await env.DB.prepare(
    "INSERT INTO documents (key, value, updated_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  )
    .bind(key, JSON.stringify(value), new Date().toISOString())
    .run();
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (url.pathname === "/" || url.pathname === "") {
      // 网页靠 recognize 这个字段判断要不要走云端识别，所以健康检查要报出来。
      return json({ ok: true, service: "nutriflow-sync", recognize: Boolean(env.GEMINI_KEY) });
    }

    if (url.pathname === "/recognize") {
      if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
      if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);
      if (!env.GEMINI_KEY) return json({ error: "GEMINI_KEY not configured" }, 501);
      const body = await request.json().catch(() => null);
      const photos = Array.isArray(body?.photos) ? body.photos.filter((p) => p && p.data) : [];
      const jobId = cleanKey(String(body?.jobId || ""));
      if (!jobId || !photos.length) return json({ error: "need jobId and photos" }, 400);
      if (typeof body?.prompt !== "string" || !body.prompt) return json({ error: "need prompt" }, 400);

      // 先写一条 pending，这样手机哪怕立刻断了，回来也能查到"这单在跑"。
      await writeDoc(env, `job_${jobId}`, { status: "pending", at: new Date().toISOString() });

      // 关键在这里：把模型调用挂到 waitUntil 上。**手机断开连接也会跑完**，
      // 这正是把活儿从手机挪到这儿的全部意义。
      const work = callGemini(env.GEMINI_KEY, photos, body.prompt)
        .then((texts) => writeDoc(env, `job_${jobId}`, { status: "done", texts, at: new Date().toISOString() }))
        .catch((error) =>
          writeDoc(env, `job_${jobId}`, { status: "error", error: String(error && error.message), at: new Date().toISOString() })
        );
      ctx.waitUntil(work);

      // 手机还连着就顺便把结果直接给它，省一次轮询；断了也没关系，上面那份已经落库。
      try {
        await work;
        const row = await env.DB.prepare("SELECT value FROM documents WHERE key = ?").bind(`job_${jobId}`).first();
        return json(row ? JSON.parse(row.value) : { status: "pending" });
      } catch {
        return json({ status: "pending" });
      }
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

import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { syncDocs } from "../../../../db/schema";
import { getChatGPTUser } from "../../../chatgpt-auth";

// 账号制同步端点。和 api/worker.js 的 /doc/:key 是同一套语义（整份 JSON 存取），
// 唯一的区别是**身份从哪来**：那边靠设备上填的 SYNC_TOKEN，这边靠 ChatGPT 登录态。
// 所以这边换台设备打开就能用，不用配任何东西——这正是用户要的"和 PRETTIER 一样"。
//
//   GET  /api/sync/:key -> {value, updatedAt} 或 {value:null}
//   PUT  /api/sync/:key   body {value} -> {ok:true, updatedAt}

// key 只允许字母数字下划线，和 Worker 那边保持一致。
const KEY_PATTERN = /^[A-Za-z0-9_]{1,64}$/;

function toRouteErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected error";
  const detail =
    error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
  const combined = `${message}\n${detail}`;

  if (combined.includes("no such table") || combined.includes("sync_docs")) {
    return "sync_docs 表还没建好。本地跑 `npm run db:generate` 生成迁移，再部署一次让平台把 SQL 应用到真正的 D1 上。";
  }

  return message;
}

async function requireUser() {
  const user = await getChatGPTUser();
  // 这里**不能 redirect**：这是给网页 fetch 用的接口，重定向到登录页只会让
  // 前端拿到一坨 HTML 而不是 401，报错完全看不懂。
  return user?.email ?? null;
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ key: string }> }
) {
  try {
    const email = await requireUser();
    if (!email) return Response.json({ error: "unauthorized" }, { status: 401 });

    const { key } = await context.params;
    if (!KEY_PATTERN.test(key)) return Response.json({ error: "bad key" }, { status: 400 });

    const db = await getDb();
    const [row] = await db
      .select()
      .from(syncDocs)
      .where(and(eq(syncDocs.userEmail, email), eq(syncDocs.docKey, key)))
      .limit(1);

    if (!row) return Response.json({ value: null, updatedAt: null });
    return Response.json({ value: JSON.parse(row.value), updatedAt: row.updatedAt });
  } catch (error) {
    return Response.json({ error: toRouteErrorMessage(error) }, { status: 500 });
  }
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ key: string }> }
) {
  try {
    const email = await requireUser();
    if (!email) return Response.json({ error: "unauthorized" }, { status: 401 });

    const { key } = await context.params;
    if (!KEY_PATTERN.test(key)) return Response.json({ error: "bad key" }, { status: 400 });

    const body = (await request.json().catch(() => null)) as { value?: unknown } | null;
    if (!body || !("value" in body)) {
      return Response.json({ error: "missing value" }, { status: 400 });
    }

    const updatedAt = new Date().toISOString();
    const db = await getDb();
    await db
      .insert(syncDocs)
      .values({ userEmail: email, docKey: key, value: JSON.stringify(body.value), updatedAt })
      .onConflictDoUpdate({
        target: [syncDocs.userEmail, syncDocs.docKey],
        set: { value: JSON.stringify(body.value), updatedAt },
      });

    return Response.json({ ok: true, updatedAt });
  } catch (error) {
    return Response.json({ error: toRouteErrorMessage(error) }, { status: 500 });
  }
}

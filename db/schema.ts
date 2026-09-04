import { sql } from "drizzle-orm";
import { primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

// 账号制同步：一行 = 某个人的某一份文档。
// 主键是「谁 + 哪份文档」——身份来自 ChatGPT 登录态（app/chatgpt-auth.ts 从请求头
// 读 email），所以设备上不用配任何口令，换台机器打开就是自己的数据。
// 这和 api/worker.js 那套（全局共享一个 SYNC_TOKEN）是两条路：那边靠"知道口令"
// 证明身份，每台设备都得先填一次；这边靠登录态，零配置。
export const syncDocs = sqliteTable(
  "sync_docs",
  {
    userEmail: text("user_email").notNull(),
    docKey: text("doc_key").notNull(),
    // 整份文档的 JSON。和 Worker 那边一样按整份存取，单用户自用够了，
    // 也省得为每种记录各建一张表、各写一套合并。
    value: text("value").notNull(),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [primaryKey({ columns: [table.userEmail, table.docKey] })]
);

import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

// `cloudflare:workers` 只有在 Workers 运行时里才存在。**必须用动态 import**：
// 写成顶层 `import { env } from "cloudflare:workers"` 的话，任何 import 到这个文件的
// 路由都会把它带进构建产物的模块图里，于是拿 node 直接加载 dist/ 就会挂在
// ERR_UNSUPPORTED_ESM_URL_SCHEME 上——测试连页面都渲染不了。
// 改成用到才加载，模块图就干净了。
export async function getDb() {
  const { env } = (await import("cloudflare:workers")) as {
    env: { DB?: D1Database };
  };

  if (!env.DB) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable. Set the `d1` field in .openai/hosting.json to `DB` or let your control plane inject the real binding values before using the database."
    );
  }

  return drizzle(env.DB, { schema });
}

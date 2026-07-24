# NutriFlow 云同步后端（Cloudflare Worker + D1）

把 NutriFlow 网页上**手动补记的餐食**同步到你自己的云端，换设备也能看到。
单用户自用，跑在 Cloudflare 免费额度里，基本 0 成本。

## 它做什么

一个极简的键值文档存储。网页把 `nutriflow_diet_entries_v1`（你在页面上用 ＋ 加的餐食）
整段存进 D1，换设备打开时整段拉回。照片和「吃完」勾选**不**走这里，仍只存本机。

- `GET /doc/diet_entries` → `{value, updatedAt}`
- `PUT /doc/diet_entries` （body `{value}`）→ `{ok:true, updatedAt}`
- 所有请求要带 `Authorization: Bearer <SYNC_TOKEN>`，只有你知道这个口令，别人写不了。

## 一次性部署（约 5 分钟）

前提：一个免费 Cloudflare 账号。命令在本 `api/` 目录下跑。

```bash
cd api

# 1) 登录你的 Cloudflare 账号（浏览器弹窗授权）
npx wrangler login

# 2) 建一个免费 D1 数据库，名字叫 nutriflow
npx wrangler d1 create nutriflow
#    命令会打印一段 database_id，把它填到 wrangler.toml 里 database_id 那行

# 3) 设置同步口令（自己想一个足够长的随机串，记下来，网页里要填同一个）
npx wrangler secret put SYNC_TOKEN
#    粘贴你的口令后回车

# 4) 部署
npx wrangler deploy
#    部署成功后会打印 Worker 网址，形如：
#    https://nutriflow-sync.<你的子域>.workers.dev
```

> 建表不用手动做——Worker 第一次收到请求会自动 `CREATE TABLE IF NOT EXISTS`。
> 如果想手动初始化：`npx wrangler d1 execute nutriflow --remote --file=schema.sql`

## 在网页里启用

打开 NutriFlow → 底部「目标」标签 → 最下面「☁️ 云同步」卡片：

1. **Worker 地址**：填第 4 步打印的 `https://nutriflow-sync.<子域>.workers.dev`
2. **同步口令**：填第 3 步设的 `SYNC_TOKEN`
3. 点「保存并同步」

之后：打开页面会自动拉取，页面上加/删餐食会自动推送。每台设备各填一次即可。
不填就完全不影响，所有编辑照旧只存本机。

## 费用

Cloudflare 免费额度：Workers 每天 10 万次请求、D1 5GB 存储 + 每天数百万行读。
单人用远用不到，免费。唯一可选的花钱项是自定义域名（不做也行，用送的 workers.dev 网址）。

## 安全

- 口令用 `wrangler secret` 存在 Cloudflare，不写进代码、不进 Git。
- 网页把口令存在该设备的 localStorage，并随请求以 Bearer 头发送。
- 想换口令：重跑 `npx wrangler secret put SYNC_TOKEN` 再 `deploy`，然后在各设备重新填一次。

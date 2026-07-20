# NutriFlow 项目上下文

> 最后更新：2026-07-20
>
> 用途：让新的 Codex 任务无需依赖旧聊天记录，也能继续维护本项目。开始工作前同时阅读根目录 `AGENTS.md`。

## 1. 项目目标

NutriFlow 是用户自用的中文手机 PWA，用来完成三件事：

1. 首页查看每天和每顿的摄入参考。
2. 食材页查看每周采购总量、食材轮换和个人优先级。
3. 采购页维护当前正在吃的食品、已吃完历史和逐次采购小票。

用户会在单独的手机 ChatGPT 对话里持续发送小票和每日饮食，再把结构化同步包交给 Codex 更新本仓库。

## 2. 当前产品状态

- 主应用：`public/nutriflow.html`
- PWA：`public/manifest.webmanifest`、`public/sw.js`
- 根路径：`app/page.tsx` 和 `public/index.html` 均转到 `/nutriflow.html`
- 图标：根 `public/` 下的 `apple-touch-icon.png`、`icon-192.png`、`icon-512.png`、`maskable-512.png`
- 当前离线缓存：`nutriflow-pwa-v11`
- 底部导航顺序：`首页`、`食材`、`采购`
- 数据尚未拆成 JSON，食材和采购记录仍写在 `public/nutriflow.html` 的 JavaScript 数组中。
- “吃完”状态保存在当前设备和当前网址的 `localStorage`，键为 `nutriflow_consumed_v1`；它不会自动跨手机、电脑或不同域名同步。

### 首页

- 先显示每天核心总量，再显示每顿目标和完整每日目标。
- 已加入《中国居民平衡膳食宝塔（2022）》图片参考。
- 手机端正文尺寸已经压低，长内容应自然换行，禁止横向滚动。

### 食材

- 周采购分类：鱼禽瘦肉、蛋奶豆、蔬菜、主食、水果坚果。
- 动物性食物采用合并额度：鱼每周 300-500g；畜禽肉合计每周 300-500g，不把红肉和禽肉额度重复相加。
- 每日鱼禽肉蛋合计 120-200g。
- 牛肉排在瘦猪肉前；“猪小里脊/通脊”明确属于猪肉。
- 鸡腿、鸡小胸、鸡胸合并为“鸡肉”一组；不列火鸡。
- 富脂鱼优先于白肉鱼，虾贝可增加多样性但不能完全替代富脂鱼的长链 Omega-3。
- 分数表示结合营养密度和个人需求的“个人优先级”，不是通用健康分或诊断结论。

### 采购

- 当前示例来自 2026-07-17 的 fudi 超市五道口店小票：7 件，合计 65.73 元。
- 小票以一次采购为一个默认折叠区块；店名、时间、件数、分类重量和总价只在小票级别显示一次。
- 当前食品包括鸡小胸、梅花肉、毛豆米、西红柿、松花菜和胡萝卜；购物袋只进入采购历史，不进入待吃清单。
- 勾选吃完后，食品移入“已吃完历史”；默认只显示最近 1 件，其余折叠。每件显示购买日期。

## 3. 个性化与隐私

- 公开仓库只记录实现所需的高层营养方向，不提交用户的生日、体检数值、完整诊断或医疗报告。
- 本机存在时，具体个性化依据存放在 `.nutriflow-private-context.md`；该文件已被 Git 忽略。
- 当前高层方向：规律吃够、适度增重、保证蛋白质和铁、不过度压低主食、避免依靠高油食物增重。
- 用户已明确同意公开展示采购和饮食记录。
- 即使如此，也不要公开付款信息、手机号、会员号、条码、精确住址或医疗原文。

## 4. 营养依据

当前总量以权威指南为底线，再按个人目标调整优先顺序：

- [中国居民膳食指南（2022）：鱼、禽、蛋类和瘦肉平均每天 120-200g，水产品每周 300-500g，畜禽肉每周 300-500g](https://dg.cnsoc.org/article/04/3tyM8WoTTUmc_oFHMymk3Q.html)
- [World Cancer Research Fund：限制红肉并尽量少吃加工肉](https://www.wcrf.org/research-policy/evidence-for-our-recommendations/limit-red-processed-meat/)
- [NIH Office of Dietary Supplements：Iron Fact Sheet](https://ods.od.nih.gov/factsheets/iron-consumer/)
- [NIDDK：Gallstones Eating, Diet, & Nutrition](https://www.niddk.nih.gov/health-information/digestive-diseases/gallstones/eating-diet-nutrition)

如要改总量或评分，先核对权威来源，并说明这是通用指南还是个人优先级调整。

## 5. 手机记录到代码更新的链路

### 手机 ChatGPT 对话

手机端单独开一个长期对话，只负责收集和整理，不直接改代码。每次可发送：

- 小票照片、商品照片或手工采购信息
- 当天吃了什么、时间、估算克数/毫升数
- 哪件库存已经吃完
- 对识别结果的更正

让该对话输出下面格式的 `NutriFlow 同步包`：

```text
NutriFlow 同步包
生成时间：YYYY-MM-DD HH:mm

新增采购：
- receipt_id：YYYY-MM-DD-store
  商店：
  时间：
  合计：
  商品：
  - item_id：receipt_id-01
    名称：
    数量/重量：
    总价：
    单价：
    分类：
    备注：

新增饮食：
- 时间：
  餐次：
  食物与估算量：

库存变化：
- item_id：
  状态：已吃完
  时间：

待确认：
- 无法辨认或需要用户确认的字段
```

### Codex 更新任务

把同步包粘贴到指向本项目文件夹的新 Codex 任务，并写“按同步包更新 NutriFlow”。Codex 应：

1. 先读 `AGENTS.md`、本文件和本地私密上下文（若存在）。
2. 去重并更新采购、库存和饮食数据；不猜测模糊字段。
3. 更新界面、测试和离线缓存版本（若应用壳变化）。
4. 验证后同步更新本文件的当前状态与变更日志。
5. 提交并发布到实际使用的托管地址。

普通手机 ChatGPT 对话不能自动读取电脑本地仓库或本文件，因此两个对话之间必须通过同步包交接。新开的本地 Codex 任务只要工作目录仍是本项目，就能自动读取 `AGENTS.md` 并恢复上下文。

## 6. 开发与验证

安装与完整验证：

```bash
npm install
npm test
git diff --check
```

轻量静态预览：

```bash
python3 -m http.server 8000 -d public
```

打开 `http://127.0.0.1:8000/nutriflow.html`。手机主屏安装必须从 HTTPS 地址打开。

## 7. 发布状态

- 计划使用的公开 GitHub 仓库：<https://github.com/wang-piaoliang/nutriflow>
- 计划使用的 GitHub Pages 地址：<https://wang-piaoliang.github.io/nutriflow/>
- 当前本地 `github` remote 指向公开仓库，`origin` 仍保留旧 ChatGPT Sites 源仓库作为历史，不作为发布目标。
- 已在本机安装 GitHub CLI 并以 `wang-piaoliang` 登录；Git 凭据保存在系统钥匙串。
- GitHub Pages 使用 `gh-pages` 分支的根目录，只保存从 `public/` 导出的静态 PWA 文件；源码仍保留在 `main`。
- 正式发布命令为 `npm run publish:pages`。它会运行测试、推送 `main`，再将 `public/` 发布到 `gh-pages` 并请求 Pages 重建；随后检查 <https://wang-piaoliang.github.io/nutriflow/>。
- 2026-07-20 已完成首发并在线验证：页面包含“居民膳食宝塔”“鱼禽瘦肉”“已吃完历史”，离线缓存为 `nutriflow-pwa-v11`。
- 部署约定：每次修改代码、页面文案、采购/饮食数据或 PWA 文件后，都要在同一个 Codex 任务内更新本文件、提交并直接运行 `npm run publish:pages`；不等待下一批修改。通常本地验证需几十秒，GitHub Pages 构建约 30 秒到 2 分钟；排队或网络波动时可能达到约 5 分钟。交付前要确认线上地址可打开。
- `.openai/hosting.json` 仍保留旧 Sites 项目配置。用户此前因该地址在手机和 Chrome 中不稳定，已决定迁移到 GitHub Pages；不要把旧 Sites 地址当作可靠的正式入口。

## 8. 已知限制与下一步

1. 把硬编码数据拆到独立 JSON，降低每次新增记录时改大段 HTML 的风险。
2. 为每日饮食增加正式数据结构和按日历史；当前页面主要展示目标，还没有持久的饮食日志。
3. “已吃完”只存在设备本地。若要跨设备同步，需要把状态进入版本化数据或增加后端存储。
4. 每次大修改后运行 `npm run publish:pages`，并确保手机 Safari、主屏 PWA、电脑 Safari 和 Chrome 使用同一稳定地址。
5. 新增小票时继续使用稳定 `receipt_id` 和 `item_id`，避免重复导入。

## 9. 最近变更

- 2026-07-20：完成 GitHub Pages 首发并在线验证；发布脚本会请求 Pages 重建，保证 `gh-pages` 更新后及时上线。
- 2026-07-20：将“每次修改后直接部署”设为项目固定约定，并记录典型部署时长。
- 2026-07-20：接通 GitHub CLI 和 `github` remote；新增 `npm run publish:pages`，将 `public/` 发布到 GitHub Pages 的 `gh-pages` 分支，并修正首次创建部署分支的完整 ref 路径。
- 2026-07-20：建立持久项目上下文、私密上下文和强制更新规则；修正 README；同步离线缓存测试到 v11。
- 2026-07-20：首页配色调整为与应用图标一致，离线缓存升至 v11。
- 2026-07-20：加入膳食宝塔每日参考图，缩小首页正文层级，离线缓存升至 v10。
- 2026-07-20：合并动物性食物采购额度；重排个性化食材优先级；合并鸡肉；优化采购和已吃完折叠逻辑。
- 2026-07-19：修复 PWA 图标路径和移动端布局，采购历史改为按小票分组。

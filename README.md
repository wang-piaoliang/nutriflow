# NutriFlow PWA

这是独立的 NutriFlow 手机 PWA 项目，用于查看每日摄入目标、食材优先级和采购记录。

新开 Codex 任务时，先阅读：

- `AGENTS.md`：仓库维护规则
- `NUTRIFLOW_PROJECT_CONTEXT.md`：产品现状、数据链路和发布状态

## 文件

- `public/nutriflow.html`：当前应用和数据入口
- `public/manifest.webmanifest`：PWA 安装信息
- `public/sw.js`：离线缓存
- `public/offline.html`：离线兜底页
- `public/icon-*.png`、`public/apple-touch-icon.png`：主屏幕图标
- `tests/rendered-html.test.mjs`：构建、内容和缓存版本测试

## 本地预览

```bash
python3 -m http.server 8000 -d public
```

打开：

```text
http://127.0.0.1:8000/nutriflow.html
```

注意：iPhone 上要添加到主屏幕，需要使用 HTTPS 地址打开。`file://` 直接打开不能安装 PWA。

## 验证

```bash
npm test
git diff --check
```

## 发布

```bash
npm run publish:pages
```

该命令会验证项目，推送源码到 `main`，并将 `public/` 发布到 GitHub Pages 使用的 `gh-pages` 分支。

公开仓库：<https://github.com/wang-piaoliang/nutriflow>

GitHub Pages：<https://wang-piaoliang.github.io/nutriflow/>

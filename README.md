# NutriFlow PWA

这是独立的 NutriFlow 手机 PWA 项目。

## 文件

- `nutriflow.html`：应用入口
- `manifest.webmanifest`：PWA 安装信息
- `sw.js`：离线缓存
- `offline.html`：离线兜底页
- `icons/`：主屏幕图标

## 本地预览

```bash
cd nutriflow-pwa
python3 -m http.server 8000
```

然后在电脑浏览器打开：

```text
http://127.0.0.1:8000/nutriflow.html
```

注意：iPhone 上要添加到主屏幕，需要使用 HTTPS 地址打开。`file://` 直接打开不能安装 PWA。

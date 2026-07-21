import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function renderRoot() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("redirects the app root to NutriFlow", async () => {
  const response = await renderRoot();
  assert.equal(response.status, 307);
  assert.equal(response.headers.get("location"), "http://localhost/nutriflow.html");
});

test("ships the personalized nutrition and purchase views", async () => {
  const html = await readFile(
    new URL("../public/nutriflow.html", import.meta.url),
    "utf8",
  );

  assert.match(html, /鱼禽肉合计 600-1000g（其中水产 300-500g）/);
  assert.match(html, /鱼禽肉蛋", amount:"120-200g/);
  assert.match(html, /每周 1 次（占水产 2 次中的 1 次）/);
  assert.match(html, /name:"牛肉"[\s\S]*name:"瘦猪肉"/);
  assert.match(html, /name:"鸡肉"/);
  assert.doesNotMatch(html, /name:"火鸡/);
  assert.match(html, /<details class="history-details">/);
  assert.match(html, /<details class="receipt-card">/);
  assert.match(html, /summarizeReceipt/);
  assert.match(html, /indexedDB/);
  assert.match(html, /仅保存在这台设备，不上传 GitHub/);
  assert.match(html, /data-open-receipt-photo/);
  assert.match(html, /id="photoViewer"/);
  assert.ok(html.indexOf('data-view="foods"') < html.indexOf('data-view="dietLog"'));
});

test("bumps the offline cache when the app shell changes", async () => {
  const serviceWorker = await readFile(
    new URL("../public/sw.js", import.meta.url),
    "utf8",
  );

  assert.match(serviceWorker, /CACHE_NAME = "nutriflow-pwa-v16"/);
  assert.match(serviceWorker, /\.\/nutriflow\.html/);
  assert.match(serviceWorker, /isAppShell/);
});

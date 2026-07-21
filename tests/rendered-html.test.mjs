import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

// Runs the app's own script in a stubbed DOM so runtime errors surface here.
// Source-only regex assertions cannot catch them: `render` fires
// `void renderShopping()`, so a throw becomes a silent rejected promise and the
// affected section is simply left blank in the browser.
async function runAppScript() {
  const html = await readFile(
    new URL("../public/nutriflow.html", import.meta.url),
    "utf8",
  );
  const source = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(source, "nutriflow.html must contain an inline app script");

  const elements = new Map();
  const createElement = () => ({
    innerHTML: "",
    textContent: "",
    hidden: false,
    dataset: {},
    classList: { add() {}, remove() {} },
    addEventListener() {},
    removeAttribute() {},
    focus() {},
    querySelector: () => createElement(),
    querySelectorAll: () => [],
  });

  const context = {
    window: {},
    navigator: {},
    location: { protocol: "http:" },
    console: { log() {}, warn() {}, error() {} },
    localStorage: { getItem: () => null, setItem() {} },
    document: {
      addEventListener() {},
      querySelectorAll: () => [],
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, createElement());
        return elements.get(id);
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context);

  // `render()` already fired these without awaiting; await them so a rejection
  // fails the test instead of disappearing.
  await context.renderShopping();
  await context.renderDietLog();

  // Top-level `const` stays in the context's lexical scope rather than becoming
  // a property of `context`, so reach the data through an expression.
  const evaluate = (expression) => vm.runInContext(expression, context);
  return { context, elements, evaluate };
}

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
  assert.match(html, /国产谷饲黄牛牛腱肉/);
  assert.match(html, /indexedDB/);
  assert.match(html, /仅保存在这台设备，不上传 GitHub/);
  assert.match(html, /data-open-photo/);

  // Deleting is a long press on the photo itself. The old always-visible ×
  // sat on top of a small thumbnail and was easy to hit by accident.
  assert.doesNotMatch(html, /class="photo-remove"/);
  assert.match(html, /长按可删除/);
  assert.match(html, /-webkit-touch-callout:none/);
  assert.match(html, /id="photoViewer"/);
  assert.match(html, /photoViewerImage"\)\.addEventListener\("click", closePhotoViewer\)/);
  assert.ok(html.indexOf('data-view="foods"') < html.indexOf('data-view="dietLog"'));
});

test("groups purchases into one card per receipt at runtime", async () => {
  const { elements } = await runAppScript();

  const meta = elements.get("purchaseMeta").textContent;
  const history = elements.get("purchaseHistory").innerHTML;

  // Two receipts, eight line items. A receipt count above the number of
  // distinct receipt IDs means the grouping accumulator leaked extra keys.
  assert.match(meta, /^2 次 · 8 件 /);
  assert.equal(history.match(/<details class="receipt-card">/g).length, 2);
  assert.match(history, /fudi 超市五道口店/);
  assert.match(history, /盒马鲜生/);
  assert.doesNotMatch(history, /undefined/);

  // Receipt totals are shown as a plain amount, with no 已记 prefix.
  assert.match(history, /¥24\.90/);
  assert.doesNotMatch(history, /已记/);
  assert.doesNotMatch(meta, /已记/);

  // The privacy sentence sits once above the list, not inside every receipt.
  assert.equal(history.match(/data-photo-owner=/g).length, 2);
  assert.doesNotMatch(history, /仅保存在这台设备/);
});

test("renders the confirmed diet log by day", async () => {
  const { elements } = await runAppScript();

  assert.equal(elements.get("dietLogMeta").textContent, "2 天");

  const list = elements.get("dietLogList").innerHTML;
  assert.match(list, /2026-07-20/);

  // Items are displayed grouped by category, not in the order they arrived,
  // and the staple lands after the vegetables.
  assert.match(list, /虾 · 猪肉 · 牛肉 · 毛豆 · 花菜 · 胡萝卜 · 藜麦米饭/);
  assert.match(list, /牛肉 · 虾 · 毛豆 · 花菜 · 胡萝卜 · 藜麦米饭/);
  assert.match(list, /虾 · 肉丸 · 鸡肉 · 毛豆 · 番茄 · 花菜 · 胡萝卜 · 藜麦米饭/);

  // Newest day first, regardless of the order inside the source array.
  assert.ok(list.indexOf("2026-07-21") < list.indexOf("2026-07-20"));

  // Days fall back to a plain meal count; no 未提供估算量 wording anywhere.
  assert.match(list, /1 餐/);
  assert.match(list, /2 餐/);
  assert.doesNotMatch(list, /未提供估算量/);
  assert.doesNotMatch(list, /还没有实际饮食记录/);

  // Each day offers the same device-local photo controls the receipts have,
  // but the privacy sentence is stated once per section, never per day.
  assert.equal(list.match(/data-photo-owner="diet:2026-07-2[01]"/g).length, 2);
  assert.doesNotMatch(list, /仅保存在这台设备/);
});

test("summarises how many foods per category the week covered", async () => {
  const { context, elements } = await runAppScript();

  // Both records fall in the same week as the fixed reference date below.
  const summary = elements.get("weekSummary").innerHTML;

  // One compact line, not a row per category: 5 + 1 + 3 + 1 distinct foods.
  // 藜麦米饭 eaten at three meals counts once, not three times.
  assert.match(summary, /共 10 种食物/);
  assert.match(summary, /🥩 鱼禽瘦肉 5/);
  assert.match(summary, /🥛 蛋奶豆 1/);
  assert.match(summary, /🥦 蔬菜 3/);
  assert.match(summary, /🍚 主食 1/);

  // The week is still running, so an untouched category is simply left out
  // rather than called out as missing.
  assert.doesNotMatch(summary, /水果坚果/);
  assert.doesNotMatch(summary, /本周还没吃到/);
  assert.match(elements.get("weekMeta").textContent, /\d+\/\d+–\d+\/\d+ · 2 天有记录/);

  // Local parsing: a Monday record must not fall into the previous week.
  const monday = context.currentWeek().monday;
  const iso = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, "0")}-${String(monday.getDate()).padStart(2, "0")}`;
  assert.equal(context.sameWeek(iso), true);
});

test("orders meal items by food category", async () => {
  const { context } = await runAppScript();
  const sort = context.sortMealItems;

  assert.deepEqual(
    sort(["米饭", "苹果", "菠菜", "牛肉", "鸡蛋"]),
    ["牛肉", "鸡蛋", "菠菜", "米饭", "苹果"],
  );

  // 蔬菜 is matched before 水果坚果 so a gourd vegetable is not read as fruit.
  assert.deepEqual(sort(["西瓜", "冬瓜"]), ["冬瓜", "西瓜"]);

  // 毛豆米 must stay a soy food rather than matching 米 as a staple.
  assert.deepEqual(sort(["毛豆米", "米饭"]), ["毛豆米", "米饭"]);
  assert.deepEqual(sort(["米饭", "毛豆米"]), ["毛豆米", "米饭"]);

  // Unrecognised names sort last and keep their relative order.
  assert.deepEqual(sort(["某种新食物", "牛肉", "另一种"]), ["牛肉", "某种新食物", "另一种"]);

  // Equal-category items keep the order they were reported in.
  assert.deepEqual(sort(["胡萝卜", "菠菜"]), ["胡萝卜", "菠菜"]);
});

test("folds receipt-level fields across every line item", async () => {
  const { context, elements, evaluate } = await runAppScript();

  // A receipt note attached to a later line item must still reach the receipt
  // header; reading only the first item would miss it.
  evaluate("purchases").push(
    { receiptId: "test-receipt", date: "2026-07-19 10:00", store: "测试店", item: "甲", amount: "100g", totalPrice: 1, bought: true },
    { receiptId: "test-receipt", date: "2026-07-19 10:00", store: "测试店", item: "乙", amount: "100g", totalPrice: 2, bought: true, receiptNote: "总价待确认" },
  );
  await context.renderShopping();

  const history = elements.get("purchaseHistory").innerHTML;
  assert.equal(history.match(/<details class="receipt-card">/g).length, 3);
  assert.match(history, /¥3\.00/);
  assert.match(history, /总价待确认/);
});

test("compares unit prices per food", async () => {
  const { context, elements, evaluate } = await runAppScript();

  const compare = elements.get("priceCompare").innerHTML;

  // Seven weighed items. The shopping bag is sold per piece, so converting it
  // to 元/kg would be meaningless and it must stay out.
  assert.equal(elements.get("priceMeta").textContent, "7 种");
  assert.doesNotMatch(compare, /购物袋/);

  // 24.90 for 400g is 62.2 元/kg, the dearest, so that food leads the list.
  assert.match(compare, /62\.2 元\/kg/);
  assert.ok(compare.indexOf("牛腱肉") < compare.indexOf("胡萝卜"));

  // The printed 元/kg tracks the unit price on the receipt itself.
  assert.match(compare, /27\.6 元\/kg/);
  assert.match(compare, /4\.0 元\/kg/);

  // Buying the same food again groups both purchases and spans their range.
  evaluate("purchases").push(
    { receiptId: "cheaper", date: "2026-07-22 10:00", store: "便宜店", foodId: "beef", item: "牛腱肉", amount: "500g", totalPrice: 20, bought: true },
  );
  context.renderPriceComparison();

  const regrouped = elements.get("priceCompare").innerHTML;
  assert.equal(elements.get("priceMeta").textContent, "7 种");
  assert.match(regrouped, /2 次 · 40\.0–62\.2/);
  assert.match(regrouped, /class="fill hot"/);
});

test("bumps the offline cache when the app shell changes", async () => {
  const serviceWorker = await readFile(
    new URL("../public/sw.js", import.meta.url),
    "utf8",
  );

  assert.match(serviceWorker, /CACHE_NAME = "nutriflow-pwa-v29"/);
  assert.match(serviceWorker, /\.\/nutriflow\.html/);
  assert.match(serviceWorker, /isAppShell/);
});

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

  const store = new Map();
  const context = {
    window: {},
    navigator: {},
    location: { protocol: "http:" },
    console: { log() {}, warn() {}, error() {} },
    crypto: { randomUUID: () => `id-${store.size}-${Math.random().toString(36).slice(2)}` },
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, value),
    },
    document: {
      addEventListener() {},
      querySelectorAll: () => [],
      createElement: () => createElement(),
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

  // The 食材 category filter bar pins to the top while the list scrolls, so it
  // stays reachable; sticky only holds when its overflow ancestors use clip
  // rather than hidden, which would silently turn them into scroll containers.
  assert.match(html, /\.tabs\{[^}]*position:sticky/);
  assert.match(html, /\.card\{[^}]*overflow:clip/);

  // Every card's section title pins the same way, so the current section stays
  // labelled while its list scrolls. The 食材 nutrition card opts out because
  // its sticky filter chips sit directly below and would otherwise double-stick.
  assert.match(html, /\.section-title\{[^}]*position:sticky/);
  assert.match(html, /<div class="section-title has-sticky-tabs">/);
  // The green home hero has white title text, so its section title must opt out
  // of the white sticky background or it becomes a blank white box over the card.
  assert.match(html, /\.hero \.section-title\{[^}]*background:transparent/);

  // Deleting is a long press on the photo itself. The old always-visible ×
  // sat on top of a small thumbnail and was easy to hit by accident.
  assert.doesNotMatch(html, /class="photo-remove"/);
  assert.match(html, /长按可删除/);
  assert.match(html, /-webkit-touch-callout:none/);
  assert.match(html, /id="photoViewer"/);
  assert.match(html, /photoViewerImage"\)\.addEventListener\("click", closePhotoViewer\)/);
  // Bottom-nav order is 饮食 → 采购 → 食材 → 目标, with 饮食 the default view.
  assert.ok(html.indexOf('data-view="dietLog"') < html.indexOf('data-view="shopping"'));
  assert.ok(html.indexOf('data-view="shopping"') < html.indexOf('data-view="foods"'));
  assert.ok(html.indexOf('data-view="foods"') < html.indexOf('data-view="home"'));
  assert.match(html, /<section class="view active" id="dietLog">/);
  assert.match(html, /data-view="home"><b>◎<\/b><span>目标<\/span>/);

  // A standalone/dock app can sit on the old cached shell, so the page reloads
  // once when a new service worker takes control and re-checks on foreground.
  assert.match(html, /addEventListener\("controllerchange"/);
  assert.match(html, /window\.location\.reload\(\)/);
  assert.match(html, /visibilityState === "visible"/);
});

test("groups purchases into one card per receipt at runtime", async () => {
  const { elements } = await runAppScript();

  const meta = elements.get("purchaseMeta").textContent;
  const history = elements.get("purchaseHistory").innerHTML;

  // Three receipts, thirteen line items. A receipt count above the number of
  // distinct receipt IDs means the grouping accumulator leaked extra keys.
  assert.match(meta, /^3 次 · 13 件 /);
  assert.equal(history.match(/<details class="receipt-card">/g).length, 3);
  assert.match(history, /fudi 超市五道口店/);
  assert.match(history, /盒马鲜生/);

  // The receipt record is complete: the udon staple is logged here even though
  // it is a pantry item kept out of the 现有食材 checklist below.
  assert.match(history, /乌冬面/);
  assert.doesNotMatch(elements.get("boughtFoods").innerHTML, /乌冬面/);
  assert.doesNotMatch(history, /undefined/);

  // Receipt totals are shown as a plain amount, with no 已记 prefix.
  assert.match(history, /¥24\.90/);
  assert.doesNotMatch(history, /已记/);
  assert.doesNotMatch(meta, /已记/);

  // The privacy sentence sits once above the list, not inside every receipt.
  assert.equal(history.match(/data-photo-owner=/g).length, 3);
  assert.doesNotMatch(history, /仅保存在这台设备/);
});

test("renders the confirmed diet log by day", async () => {
  const { elements } = await runAppScript();

  assert.equal(elements.get("dietLogMeta").textContent, "5 天");

  const list = elements.get("dietLogList").innerHTML;
  assert.match(list, /2026-07-20/);
  assert.match(list, /2026-07-22/);

  // Items are displayed grouped by category in the order 鱼禽瘦肉 → 蔬菜 →
  // 蛋奶豆 → 主食 → 水果坚果 (vegetables before soy/egg/dairy, per the user),
  // not in the order they arrived, and the staple lands after the vegetables.
  assert.match(list, /虾 · 猪肉 · 牛肉 · 花菜 · 胡萝卜 · 毛豆 · 藜麦米饭/);
  assert.match(list, /牛肉 · 虾 · 花菜 · 胡萝卜 · 毛豆 · 藜麦米饭/);
  assert.match(list, /虾 · 肉丸 · 鸡肉 · 番茄 · 花菜 · 胡萝卜 · 毛豆 · 藜麦米饭/);

  // Newest day first, regardless of the order inside the source array.
  assert.ok(list.indexOf("2026-07-22") < list.indexOf("2026-07-21"));
  assert.ok(list.indexOf("2026-07-21") < list.indexOf("2026-07-20"));

  // Days fall back to a plain meal count; no 未提供估算量 wording anywhere.
  assert.match(list, /2 餐/);
  assert.doesNotMatch(list, /未提供估算量/);
  assert.doesNotMatch(list, /还没有实际饮食记录/);

  // Egg is recorded as 蛋 (not 鸡蛋) so the 鸡 keyword does not pull it into
  // 鱼禽瘦肉; it groups under 蛋奶豆 with 毛豆, after the meats and vegetables.
  assert.match(list, /肉丸 · 番茄 · 胡萝卜 · 花菜 · 蛋 · 毛豆/);

  // Every meal carries its own ＋ so food can be appended to that exact meal
  // without going back to a form and re-picking the date.
  assert.equal(list.match(/data-add-item="2026-07-2\d\|(午餐|晚餐)"/g).length, 10);
  assert.equal(list.match(/data-inline-for=/g).length, 10);

  // Each day offers the same device-local photo controls the receipts have,
  // but the privacy sentence is stated once per section, never per day.
  assert.equal(list.match(/data-photo-owner="diet:2026-07-2[01234]"/g).length, 5);
  assert.doesNotMatch(list, /仅保存在这台设备/);
});

test("summarises how many foods per category the week covered", async () => {
  const { context, elements } = await runAppScript();

  // Both records fall in the same week as the fixed reference date below.
  const summary = elements.get("weekSummary").innerHTML;

  // One compact line, not a row per category: 11 + 6 + 8 + 5 + 1 distinct foods.
  // A food eaten at several meals counts once, not once per meal.
  // 豆皮 is one of the six soy foods: anything eaten but not yet covered by a
  // category keyword gets added, otherwise it silently drops out of the tally.
  // 鱼禽瘦肉 gains 07-24 晚餐's Sushiro fish (金枪鱼, 三文鱼, 鳗鱼); 虾 was already
  // counted. 蔬菜 gains 南瓜. 主食 now has five distinct staples: 藜麦米饭, 米线,
  // 乌冬面, 杂粮饭, and the sushi 寿司饭.
  // One metric tile per category (same visual as the home hero), plus a caption
  // with the total.
  // The total moved to weekMeta (prominent, top of the green hero); the tiles
  // come in category order 鱼禽瘦肉 → 蔬菜 → 蛋奶豆 → 主食 → 水果坚果.
  assert.match(elements.get("weekMeta").textContent, /共 31 种 · 5 天/);
  assert.match(summary, /<b>🥩 11<\/b><span>鱼禽瘦肉<\/span>/);
  assert.match(summary, /<b>🥦 8<\/b><span>蔬菜<\/span>/);
  assert.match(summary, /<b>🥛 6<\/b><span>蛋奶豆<\/span>/);
  assert.match(summary, /<b>🍚 5<\/b><span>主食<\/span>/);
  assert.match(summary, /<b>🍎 1<\/b><span>水果坚果<\/span>/);
  assert.match(summary, /看看这几类是不是都吃到了/);

  // A category with no foods this week is dropped rather than called out.
  assert.doesNotMatch(summary, /本周还没吃到/);
  // The week's date range now lives in the caption under the tiles.
  assert.match(summary, /\d+\/\d+–\d+\/\d+/);

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

test("shows the real dish name but categorises by its hidden tag", async () => {
  const { context, elements } = await runAppScript();

  // 烤鸭 carries as:"鸭肉". The dish name is what gets displayed...
  assert.deepEqual(
    context.sortMealItems([{ name: "烤鸭", as: "鸭肉" }, "米饭"]),
    ["烤鸭", "米饭"],
  );
  assert.match(elements.get("dietLogList").innerHTML, /烤鸭/);

  // ...while the tag decides the category, so it still sorts as meat.
  assert.equal(context.dietItemRank({ name: "烤鸭", as: "鸭肉" }), 0);

  // A dish name carrying no keyword of its own would otherwise fall through
  // to the uncategorised bucket and drop out of the weekly counts.
  const uncategorised = context.dietItemRank("说不上来的东西");
  assert.equal(context.dietItemRank("罗宋汤"), uncategorised);
  assert.equal(context.dietItemRank({ name: "罗宋汤", as: "牛肉" }), 0);
});

test("merges manually added meals into the day", async () => {
  const { context, elements, evaluate } = await runAppScript();

  const before = evaluate("allDietRecords()").find((record) => record.date === "2026-07-20");
  assert.equal(before.meals.filter((meal) => meal.name === "早餐").length, 0);

  context.addDietEntry("2026-07-20", "早餐", ["牛奶", "鸡蛋"]);
  context.addDietEntry("2026-07-20", "午餐", ["酸奶"]);

  const after = evaluate("allDietRecords()").find((record) => record.date === "2026-07-20");

  // Arrays built inside the vm realm are not reference-equal to host arrays,
  // so compare joined strings rather than using deepEqual on them.
  // A new meal appears, and meals stay in 早餐/午餐/晚餐/加餐 order.
  assert.equal(after.meals.map((meal) => meal.name).join("/"), "早餐/午餐/晚餐");

  // An entry for an existing meal joins that meal instead of duplicating it.
  const lunch = after.meals.find((meal) => meal.name === "午餐");
  assert.ok(lunch.items.includes("酸奶"));
  assert.equal(lunch.added.length, 1);

  // Only the manual part is removable; the synced items carry no entry id.
  const breakfast = after.meals.find((meal) => meal.name === "早餐");
  assert.equal(breakfast.added[0].items.join("/"), "牛奶/鸡蛋");
  context.removeDietEntry(breakfast.added[0].id);
  const reverted = evaluate("allDietRecords()").find((record) => record.date === "2026-07-20");
  assert.equal(reverted.meals.map((meal) => meal.name).join("/"), "午餐/晚餐");
});

test("marks manual foods inline and hides their delete control until editing", async () => {
  const { context, elements } = await runAppScript();

  context.addDietEntry("2026-07-20", "早餐", ["牛奶"]);
  await context.renderDietLog();
  const html = elements.get("dietLogList").innerHTML;

  // The manually added food joins the meal's food list with a subtle accent,
  // not as a separate bordered ✕ pill on its own row.
  assert.match(html, /<span class="added-item">牛奶<\/span>/);

  // Its delete control lives inside that meal's hidden inline editor, so no ✕
  // shows on the card until the ＋ is opened.
  assert.match(html, /class="inline-add" data-inline-for="2026-07-20\|早餐" hidden/);
  assert.ok(
    html.indexOf('data-inline-for="2026-07-20|早餐"') < html.indexOf("data-remove-entry"),
    "the remove control sits inside the editor, after the inline-add opens",
  );
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
  assert.equal(history.match(/<details class="receipt-card">/g).length, 4);
  assert.match(history, /¥3\.00/);
  assert.match(history, /总价待确认/);
});

test("compares unit prices per food", async () => {
  const { context, elements, evaluate } = await runAppScript();

  const compare = elements.get("priceCompare").innerHTML;

  // Twelve weighed items (incl. the udon staple). The shopping bag is sold per
  // piece, so converting it to 元/kg would be meaningless and it must stay out.
  assert.equal(elements.get("priceMeta").textContent, "12 种");
  assert.doesNotMatch(compare, /购物袋/);

  // 24.28 for 300g of 虾滑 is 80.9 元/kg, now the dearest; 24.90 for 400g of
  // beef is 62.2 元/kg and both are printed. Beef still outranks 胡萝卜.
  assert.match(compare, /80\.9 元\/kg/);
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
  assert.equal(elements.get("priceMeta").textContent, "12 种");
  assert.match(regrouped, /2 次 · 40\.0–62\.2/);
  assert.match(regrouped, /class="fill hot"/);
});

test("bumps the offline cache when the app shell changes", async () => {
  const serviceWorker = await readFile(
    new URL("../public/sw.js", import.meta.url),
    "utf8",
  );

  assert.match(serviceWorker, /CACHE_NAME = "nutriflow-pwa-v53"/);
  assert.match(serviceWorker, /\.\/nutriflow\.html/);
  assert.match(serviceWorker, /isAppShell/);
});

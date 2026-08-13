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
  // Anchor "now" to a date inside the fixtures' week (2026-07-20..26) so the
  // weekly-summary assertions are deterministic no matter when the suite runs.
  // Without this, once the real clock rolls past that Sunday, 本周吃到 goes to
  // 0 天 and the counts drift. Args still delegate to the real Date.
  const FIXED_NOW = Date.parse("2026-07-23T12:00:00");
  class FixedDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(FIXED_NOW);
      else super(...args);
    }
    static now() { return FIXED_NOW; }
  }
  const context = {
    // The sync module registers a `pagehide` flush on window, so the stub needs
    // addEventListener — without it the whole script throws at load time.
    window: { addEventListener() {} },
    navigator: {},
    location: { protocol: "http:" },
    console: { log() {}, warn() {}, error() {} },
    Date: FixedDate,
    crypto: { randomUUID: () => `id-${store.size}-${Math.random().toString(36).slice(2)}` },
    // The sync module debounces pushes; the vm realm has no timers of its own.
    setTimeout, clearTimeout,
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, value),
    },
    document: {
      addEventListener() {},
      // syncTopbarButtons() 现在在脚本加载时就跑一次（首屏要立刻决定顶栏放 🔍 还是 ⚙），
      // 它会 document.querySelector(".nav-btn.active")——桩里缺这个方法脚本会直接抛。
      querySelector: () => null,
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
  assert.match(html, /<details class="receipt-card"/);
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

  // The hidden native file input is position:absolute. iOS Safari refuses to
  // shrink input[type=file] to width:1px and lays it out at its intrinsic ~166px,
  // and an absolutely positioned box is only clipped by ancestors on its
  // containing-block chain — so without a positioned wrapper it escapes every
  // overflow:clip on .card/.view/.app/body and drags the whole page sideways.
  // The 饮食 tab put that 📷 at the right edge of each day header, which is why
  // only that tab could be swiped horizontally. Both wrapper labels must stay
  // positioned so the input's containing block is the label, not the viewport.
  assert.match(html, /\.photo-add,\.photo-add-mini\{[^}]*position:relative/);
  assert.match(html, /\.photo-input\{[^}]*position:absolute/);
  assert.match(html, /\.photo-input\{[^}]*clip-path:inset\(50%\)/);

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

  // Seven receipts, thirty-seven line items. A receipt count above the number of
  // distinct receipt IDs means the grouping accumulator leaked extra keys.
  assert.match(meta, /^7 次 · 37 件 /);
  assert.equal(history.match(/<details class="receipt-card"/g).length, 7);
  assert.match(history, /fudi 超市五道口店/);
  assert.match(history, /盒马鲜生/);

  // The receipt record is complete: the udon staple is logged here even though
  // it is a pantry item kept out of the 现有食材 checklist below.
  assert.match(history, /乌冬面/);
  assert.doesNotMatch(elements.get("boughtFoods").innerHTML, /乌冬面/);
  // 现有食材是一眼扫库存的清单，不显示小票上的“约”；采购历史保留原文。
  assert.doesNotMatch(elements.get("boughtFoods").innerHTML, /约/);
  assert.match(history, /约/);
  assert.doesNotMatch(history, /undefined/);

  // Receipt totals are shown as a plain amount, with no 已记 prefix.
  assert.match(history, /¥24\.90/);
  assert.doesNotMatch(history, /已记/);
  assert.doesNotMatch(meta, /已记/);

  // The privacy sentence sits once above the list, not inside every receipt.
  assert.equal(history.match(/data-photo-owner=/g).length, 7);
  assert.doesNotMatch(history, /仅保存在这台设备/);
});

test("renders the confirmed diet log by day", async () => {
  const { elements } = await runAppScript();

  assert.equal(elements.get("dietLogMeta").textContent, "11 天");

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
  assert.equal(list.match(/data-add-item="2026-07-\d\d\|(午餐|晚餐)"/g).length, 22);
  assert.equal(list.match(/data-inline-for=/g).length, 23);

  // Each day offers the same device-local photo controls the receipts have,
  // but the privacy sentence is stated once per section, never per day.
  assert.equal(list.match(/data-photo-owner="diet:2026-07-2[01234567]"/g).length, 8);
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
  // 数的是「吃到几种食材」不是「几道菜」：牛排和牛肉、煎蛋和蛋归到同一种，
  // 所以从 40 降到 31。
  assert.match(elements.get("weekMeta").textContent, /31 种 · 7 天/);
  assert.match(summary, /<b>🥩 11<\/b><span>鱼禽瘦肉<\/span>/);
  assert.match(summary, /<b>🥦 9<\/b><span>蔬菜<\/span>/);
  assert.match(summary, /<b>🥛 5<\/b><span>蛋奶豆<\/span>/);
  assert.match(summary, /<b>🍚 4<\/b><span>主食<\/span>/);
  assert.match(summary, /<b>🍎 2<\/b><span>水果坚果<\/span>/);
  // The trailing caption line is gone — the user asked for the tiles alone.
  assert.doesNotMatch(summary, /看看这几类是不是都吃到了/);
  assert.doesNotMatch(summary, /week-caption/);

  // A category with no foods this week is dropped rather than called out.
  assert.doesNotMatch(summary, /本周还没吃到/);
  // The date range went with the caption. "本周" says it already, and the hero
  // is meant to be tiles only now.
  assert.doesNotMatch(summary, /\d+\/\d+–\d+\/\d+/);

  // Local parsing: a Monday record must not fall into the previous week.
  const monday = context.currentWeek().monday;
  const iso = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, "0")}-${String(monday.getDate()).padStart(2, "0")}`;
  assert.equal(context.sameWeek(iso), true);
});

test("summarises past weeks in the timeline but never the current one twice", async () => {
  const { elements, evaluate } = await runAppScript();

  // Records span two natural weeks (Monday-start); both get their own block.
  const weeks = evaluate("weeksFromRecords()");
  assert.equal(weeks.length, 2);

  const list = elements.get("dietLogList").innerHTML;
  // A finished week is a collapsible <details open>; the current one is a plain
  // <section> because the green hero above already is its summary.
  assert.equal(list.match(/<details class="week-block" open>/g).length, 1);
  assert.equal(list.match(/<section class="week-block">/g).length, 1);

  // A week that is over gets its summary right above its own days.
  assert.match(list, /7\/27–8\/2/);
  assert.ok(list.indexOf("7/27–8/2") < list.indexOf("2026-07-30"));

  // The current week (the fixed clock sits in 7/20–7/26) does NOT — the green
  // hero above already shows it, and printing it here said the same thing twice.
  // It reappears here on its own once the week is over and it becomes a past week.
  assert.doesNotMatch(list, /7\/20–7\/26/);
  assert.ok(list.indexOf("2026-07-27") < list.indexOf("2026-07-26"));

  // Shown exactly once, in the hero.
  // 数的是「吃到几种食材」不是「几道菜」：牛排和牛肉、煎蛋和蛋归到同一种，
  // 所以从 40 降到 31。
  assert.match(elements.get("weekMeta").textContent, /31 种 · 7 天/);
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

test("parses a recognition reply into diet-log items", async () => {
  const { context } = await runAppScript();
  const parse = context.parseRecognition;

  // Plain JSON, plus the tagged-dish form the prompt asks for.
  const clean = parse('{"meal":"晚餐","items":["虾","烤鸭",{"name":"罗宋汤","as":"牛肉"}]}');
  assert.equal(clean.meal, "晚餐");
  assert.equal(clean.items.map(context.itemLabel).join("/"), "虾/烤鸭/罗宋汤");
  assert.equal(context.itemTag(clean.items[2]), "牛肉");

  // Models wrap JSON in markdown fences or add a sentence around it.
  const fenced = parse('这是识别结果：\n```json\n{"meal":"早餐","items":["牛奶","蛋"]}\n```\n希望有用');
  assert.equal(fenced.meal, "早餐");
  assert.equal(fenced.items.join("/"), "牛奶/蛋");

  // A tag equal to the name carries no information — collapse it to a string.
  assert.equal(parse('{"meal":"午餐","items":[{"name":"牛肉","as":"牛肉"}]}').items[0], "牛肉");

  // Junk entries are dropped rather than rendered as [object Object] / empty chips.
  assert.equal(parse('{"meal":"午餐","items":["米饭",null,"",{"as":"x"},42]}').items.join("/"), "米饭");

  // An unknown meal name falls back rather than creating a fifth meal slot.
  assert.equal(parse('{"meal":"夜宵","items":["面"]}').meal, "午餐");
  assert.throws(() => parse("模型今天不想返回 JSON"), /没有返回 JSON/);
});

test("remembers which photos were already recognized", async () => {
  const { context } = await runAppScript();

  // Tapping 识别 twice on one photo logged the meal twice during testing.
  // The button still allows a redo, but only after saying so.
  assert.equal(context.recognizedIds().join(","), "");
  context.markRecognized("photo-1");
  context.markRecognized("photo-1");
  context.markRecognized("photo-2");
  assert.equal(context.recognizedIds().join(","), "photo-1,photo-2");
});

test("shows what was eaten on an eating-out record", async () => {
  const { context, evaluate } = await runAppScript();

  // 在外就餐 only stored {date, place, price, note} — a 寿司郎 row said nothing
  // about the food, and its photos had no recognise button at all because the
  // viewer only accepted diet: owners. Both were the same gap.
  context.addDining({ date: "2026-08-02", place: "寿司郎", price: 168 });
  // `let diningEntries` stays in the vm's lexical scope, not on `context`.
  const dining = evaluate("diningEntries[diningEntries.length - 1]");
  assert.equal(context.diningItems(dining).join(" · "), "");

  context.addDietEntry("2026-08-02", "晚餐", ["三文鱼", { name: "味噌汤", as: "豆腐" }], "寿司郎", dining.id);
  assert.equal(context.diningItems(dining).join(" · "), "三文鱼 · 味噌汤");

  // The same entry carries the restaurant into the diet log, and the hidden tag
  // still drives the category so 味噌汤 counts as 蛋奶豆, not uncategorised.
  const day = context.allDietRecords().find(r => r.date === "2026-08-02");
  const dinner = day.meals.find(m => m.name === "晚餐");
  assert.equal(dinner.place, "寿司郎");
  const rank = context.dietItemRank({ name: "味噌汤", as: "豆腐" });
  assert.equal(evaluate(`dietItemCategoryRules[${rank}].name`), "蛋奶豆");

  // Linking by id, not by restaurant name — an eating-out row need not have one.
  const anon = { id: "no-place", date: "2026-08-02" };
  assert.equal(context.diningItems(anon).join(" · "), "");
});

test("never lets a pull overwrite local edits that have not been pushed", async () => {
  const { context, evaluate } = await runAppScript();

  // Adding an eating-out record and refreshing right away used to lose it:
  // the push is debounced 600ms, so the reload's syncPull() fetched the older
  // server copy and wrote it straight over the local one.
  const requests = [];
  const server = { diet_entries: [], dining: [], remaining: {} };
  context.fetch = async (url, options) => {
    const key = String(url).split("/doc/")[1];
    requests.push(`${options?.method || "GET"} ${key}`);
    if (options?.method === "PUT") {
      server[key] = JSON.parse(options.body).value;
      return { ok: true, status: 200, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => ({ value: server[key] }) };
  };
  context.localStorage.setItem("nutriflow_sync_token", "t");

  context.addDining({ date: "2026-08-03", place: "寿司郎", price: 168 });
  assert.equal(evaluate("dirtyDocs()").includes("dining"), true, "改动后要立刻标脏");

  await context.syncPull();

  assert.equal(evaluate("diningEntries.length"), 1, "本地这条不能被服务端旧数据覆盖");
  assert.equal(server.dining.length, 1, "反过来要把本地推上去");
  assert.ok(requests.includes("PUT dining"));

  // The stronger invariant: a pull merges by id, so records the server has not
  // heard of yet survive it. Losing a just-typed entry bit the user three times.
  server.dining = [{ id: "other-device", date: "2026-08-01", place: "别家", price: 50 }];
  await context.syncPull();
  const places = evaluate("diningEntries.map(e => e.place)").sort();
  assert.deepEqual([...places], ["别家", "寿司郎"], "两边的记录都要留下，不是二选一");

  // Deleting is explicit: the id goes on a tombstone list that syncs too, so the
  // record stays deleted instead of being resurrected by the next merge.
  const doomed = evaluate("diningEntries.find(e => e.place === '别家').id");
  context.removeDining(doomed);
  await context.syncPull();
  assert.deepEqual([...evaluate("diningEntries.map(e => e.place)")], ["寿司郎"]);
  assert.ok(evaluate("tombstones").includes(doomed), "删掉的 id 要记进墓碑");
});

test("records a purchase you typed in yourself", async () => {
  const { context, elements, evaluate } = await runAppScript();

  // The user asked to stop mailing sync packages: "我要自己加，当成一个正常的
  // app 来使用". Manual rows share the hardcoded shape so every renderer keeps
  // working off allPurchases() without special cases.
  const before = evaluate("allPurchases().length");
  const { receiptId } = context.addPurchaseReceipt({
    date: "2026-08-03",
    store: "盒马鲜生（大钟寺店）",
    items: [
      { name: "牛肉", amount: "400g", price: 29.9 },
      { name: "酸奶", amount: "", price: 12 },
    ],
  });
  assert.equal(evaluate("allPurchases().length"), before + 2);

  // A name matching the catalog reuses its foodId, so it groups with earlier
  // buys of the same food instead of starting a lonely one-entry group.
  const rows = evaluate("manualPurchases");
  assert.equal(rows[0].foodId, "beef");
  assert.match(rows[0].unitPrice, /74\.75 元\/kg/);

  // No weight means no unit price — it still lands in the history, it just
  // cannot join the price comparison.
  assert.equal(rows[1].unitPrice, "");
  const beef = context.comparablePurchases().filter((p) => p.key === "beef");
  assert.ok(beef.some((p) => p.date === "2026-08-03"));
  assert.ok(!context.comparablePurchases().some((p) => p.item === "酸奶"));

  await context.renderShopping();
  assert.match(elements.get("purchaseHistory").innerHTML, /删掉这次采购/);

  // Only manual receipts are deletable; the hardcoded ones would come back on
  // the next deploy, which would just confuse.
  context.removeManualReceipt(receiptId);
  assert.equal(evaluate("allPurchases().length"), before);
});

test("saves a receipt that is only a photo", async () => {
  const { context, evaluate } = await runAppScript();

  // "上传了图片还是没法保存，一定要我填内容" — with no API key configured,
  // nothing gets auto-filled, and the form used to refuse to save at all, so
  // the receipt photo had nowhere to live.
  const before = evaluate("allPurchases().length");
  context.addPurchaseReceipt({
    date: "2026-08-03",
    store: "未记录地点",
    items: [{ name: "待补充", amount: "", price: null, placeholder: true }],
  });
  assert.equal(evaluate("allPurchases().length"), before + 1);

  // The placeholder must not turn into a食材 you supposedly have in the fridge.
  const row = evaluate("manualPurchases[0]");
  assert.equal(row.bought, false);
  await context.renderShopping();
  assert.doesNotMatch(context.document.getElementById("boughtFoods").innerHTML, /待补充/);
});

test("files bone-in cuts as meat, not as whatever else is in the dish name", async () => {
  const { context, evaluate } = await runAppScript();
  const nameOf = (item) => evaluate(`dietItemCategoryRules[${context.dietItemRank(item)}].name`);

  // 玉米排骨汤 has no 肉 character, but it does contain 玉米 — so it used to be
  // filed under 主食 and the week showed 鱼禽瘦肉 = 1 after a rib soup.
  assert.equal(nameOf("玉米排骨汤"), "鱼禽瘦肉");
  assert.equal(nameOf("排骨"), "鱼禽瘦肉");
  assert.equal(nameOf("牛排"), "鱼禽瘦肉");
  assert.equal(nameOf("猪蹄"), "鱼禽瘦肉");

  // 牛奶 must stay in 蛋奶豆 — the fix adds specific cuts, not a bare 牛.
  assert.equal(nameOf("牛奶"), "蛋奶豆");
  // Plain corn is still a staple.
  assert.equal(nameOf("玉米"), "主食");
});

test("counts the foods behind each weekly tile", async () => {
  const { context, evaluate } = await runAppScript();
  const week = context.tallyByCategory([
    { date: "2026-08-04", meals: [{ name: "晚餐", items: ["玉米排骨汤", "干煸四季豆", "米饭", "排骨"] }] },
  ]);
  // 玉米排骨汤 spans two categories, so it is counted in both — the corn used to
  // vanish entirely. And a tap lists the INGREDIENT, not the dish: 排骨 / 玉米.
  const meat = week.counts.find((entry) => entry.rule.name === "鱼禽瘦肉");
  assert.equal(meat.names.join(" · "), "排骨");
  assert.equal(meat.count, 1);
  const staple = week.counts.find((entry) => entry.rule.name === "主食");
  assert.equal(staple.names.join(" · "), "玉米 · 米饭", "汤里的玉米也要算进主食");

  // A name matching one category only still shows the whole name, and 黄瓜 must
  // not leak into 水果坚果 via the bare 瓜 keyword.
  assert.deepEqual([...evaluate('itemTags("拍黄瓜")')], ["拍黄瓜"]);
  assert.deepEqual([...evaluate('itemTags("番茄炒蛋")')], ["番茄", "蛋"]);
  assert.deepEqual([...evaluate('itemTags("鸡蛋")')], ["鸡蛋"]);
});

test("keeps the recognition prompt's hard-won rules", async () => {
  const html = await readFile(
    new URL("../public/nutriflow.html", import.meta.url),
    "utf8",
  );

  // These four rules are project scar tissue, not generic prompt advice:
  // 蛋 vs 鸡蛋 (the 鸡 keyword misfiles it), staples went missing for three
  // meals, dish names must stay specific, and grams must never be invented.
  assert.match(html, /绝对不要写"鸡蛋"/);
  assert.match(html, /主食必须写全/);
  assert.match(html, /不要写"鸭肉"/);
  assert.match(html, /不要编造重量或克数/);

  // The key lives only in this device's localStorage — never committed.
  assert.match(html, /nutriflow_ai_key/);
  assert.doesNotMatch(html, /sk-[a-zA-Z0-9]{16}/);

  // Uploading a meal photo now transmits it (the user asked for that), so the
  // settings card must not keep claiming otherwise — a stale privacy promise is
  // worse than none. What still holds: nothing goes out without a key.
  assert.doesNotMatch(html, /只有你在某张照片上主动点「识别」/);
  assert.match(html, /只有你自己传进来的这些照片会发给模型/);
  assert.match(html, /不填 key 就一张也不发/);

  // Gemini retires dated model ids — the pinned gemini-2.5-flash began
  // returning 404 "no longer available to new users" for keys made in 2026-08.
  // So the newest model is tried first but a moving alias must back it up,
  // otherwise this app breaks silently the next time Google retires one.
  assert.match(html, /const GEMINI_MODELS = \[(.*)\]/);
  const chain = html.match(/const GEMINI_MODELS = \[(.*)\]/)[1];
  assert.match(chain, /latest/, "Gemini 模型链最后要有 -latest 兜底");
  assert.ok(chain.split(",").length >= 2, "至少要有最新版 + 别名两个");
  assert.match(html, /response\.status !== 404/, "只在 404 时才回落到下一个模型");
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
  assert.equal(history.match(/<details class="receipt-card"/g).length, 8);
  assert.match(history, /¥3\.00/);
  assert.match(history, /总价待确认/);
});

test("compares unit prices per food", async () => {
  const { context, elements, evaluate } = await runAppScript();
  const html2 = await readFile(new URL("../public/nutriflow.html", import.meta.url), "utf8");

  const compare = elements.get("priceCompare").innerHTML;

  // Twenty-three weighed items. The shopping bag is sold per piece, and the free
  // garlic costs 0, so converting either to 元/kg is meaningless — both stay out.
  assert.equal(elements.get("priceMeta").textContent, "23 种");
  assert.doesNotMatch(compare, /购物袋/);

  // 24.28 for 300g of 虾滑 is 80.9 元/kg, now the dearest; 24.90 for 400g of
  // beef is 62.2 元/kg and both are printed. Beef still outranks 胡萝卜.
  assert.match(compare, /80\.9 元\/kg/);
  assert.match(compare, /62\.2 元\/kg/);

  // 牛腱肉 and 牛嫩肉 are both 国产谷饲黄牛, just different cuts, so they share the
  // beef key and compare as one food instead of two near-identical rows. The group
  // is titled by its most recent purchase, so only that name is printed.
  assert.match(compare, /2 次 · 62\.2–74\.7/);

  // 分组标题只写食材本名，品牌和修饰词挪到明细行的门店后面，整行不换行。
  assert.match(compare, /<strong>🥩 牛肉<\/strong>/);
  assert.doesNotMatch(compare, /<strong>[^<]*盒马[^<]*<\/strong>/);
  assert.match(compare, /07-28 盒马 · 国产谷饲黄牛牛嫩肉/);
  assert.match(html2, /\.bar-head span\{[^}]*white-space:nowrap/);
  assert.ok(compare.indexOf("牛嫩肉") < compare.indexOf("胡萝卜"));

  // The printed 元/kg tracks the unit price on the receipt itself.
  assert.match(compare, /27\.6 元\/kg/);
  assert.match(compare, /4\.0 元\/kg/);

  // Buying the same food again groups both purchases and spans their range.
  evaluate("purchases").push(
    { receiptId: "cheaper", date: "2026-07-22 10:00", store: "便宜店", foodId: "beef", item: "牛腱肉", amount: "500g", totalPrice: 20, bought: true },
  );
  context.renderPriceComparison();

  const regrouped = elements.get("priceCompare").innerHTML;
  assert.equal(elements.get("priceMeta").textContent, "23 种");
  assert.match(regrouped, /3 次 · 40\.0–74\.7/);
  assert.match(regrouped, /class="fill hot"/);
});

test("filters the unit-price comparison by purchase category", async () => {
  const { context, elements, evaluate } = await runAppScript();

  // 只列真有数据的分类，外加「全部」。
  const chips = elements.get("priceTabs").innerHTML;
  assert.match(chips, /data-price-cat="all"/);
  assert.match(chips, /data-price-cat="肉类"/);
  assert.equal(elements.get("priceMeta").textContent, "23 种");

  evaluate('activePriceCategory = "肉类"');
  context.renderPriceComparison();
  const meat = elements.get("priceCompare").innerHTML;
  assert.equal(meat.match(/<div class="price-group">/g).length, 4);
  assert.equal(elements.get("priceMeta").textContent, "4 种");
  assert.match(meat, /🥩 牛肉/);
  assert.doesNotMatch(meat, /白萝卜/);

  // 选中的分类若没有数据了，退回「全部」而不是留在空列表上。
  evaluate('activePriceCategory = "不存在的分类"');
  context.renderPriceComparison();
  assert.equal(evaluate("activePriceCategory"), "all");
  assert.equal(elements.get("priceMeta").textContent, "23 种");
});

test("keeps one bill per meal and never shares it across meals", async () => {
  const { evaluate } = await runAppScript();

  evaluate('dietEntries.length = 0; diningEntries.length = 0;');
  evaluate('const d = addDining({date:"2026-08-05", place:"川成元", price:37.8, note:""}); addDietEntry("2026-08-05","晚餐",["牛肉片"],"川成元",d.id);');

  // 一天里午饭和晚饭的照片常常混在一起识别。账单必须按「这张照片是哪一餐」去找，
  // 否则同一笔钱会同时显示在午餐和晚餐后面（用户看到两顿都是 ¥37.80）。
  assert.equal(evaluate('diningIdFor("2026-08-05","午餐")'), "");
  assert.equal(evaluate('diningIdFor("2026-08-05","晚餐")'), evaluate("diningEntries[0].id"));

  // 同一顿再传一张照片时要认出账单已经有了，不能再建一条——否则价格成倍。
  assert.equal(evaluate("diningEntries.length"), 1);

  // 同一笔账单被这一餐的多条记录引用时只算一次，不是叠加。
  evaluate('globalThis.__meal = {added:[{diningId:diningEntries[0].id},{diningId:diningEntries[0].id},{diningId:diningEntries[0].id}]}');
  assert.match(evaluate("mealPriceMark(globalThis.__meal)"), /¥37\.80/);
  assert.doesNotMatch(evaluate("mealPriceMark(globalThis.__meal)"), /113/);
});

test("merges every receipt photo instead of only the first", async () => {
  const html = await readFile(new URL("../public/nutriflow.html", import.meta.url), "utf8");

  // 一单小票要滚好几屏才截得完，三张图是一单的三段。只发第一张会丢掉后面所有商品
  // （用户："上传三张照片，但只识别了四样东西"）。
  assert.match(html, /async function recognizeReceipts\(blobs/);
  assert.doesNotMatch(html, /recognizeReceipt\(pendingPhotos\[0\]\)/);
  assert.match(html, /recognizeReceipts\(pendingPhotos/);
  // 相邻截图会重叠，按「名称 + 规格」去重。
  assert.match(html, /\$\{item\.name\}\|\$\{item\.amount\}/);

  // 外卖单上同时有总价/优惠/打包费，必须明确只取实付，否则会挑错数或相加。
  assert.match(html, /实付合计.*实付款|只填\*\*这一单最后实际付掉的钱\*\*/);
  assert.match(html, /不要把它们相加/);
});

test("auto-saves a recognised receipt and keeps every line editable", async () => {
  const { context, elements, evaluate } = await runAppScript();
  const html = await readFile(new URL("../public/nutriflow.html", import.meta.url), "utf8");

  // 识别完直接入账，不再等人点保存。
  assert.match(html, /const saved = await commitPurchase\(\);/);
  assert.match(html, /已自动记下 \$\{saved\} 件/);

  evaluate('addPurchaseReceipt({date:"2026-08-06 15:03", store:"盒马鲜生", items:[{name:"丘比 沙拉酱", amount:"150g", price:13.11}]})');
  await context.renderShopping();

  // 平时保持只读，和写死在代码里那批长得一样，每次采购只多一个小 ✏️
  // （用户："这个太奇怪了，改回原来的格式吧，只是加一个小的编辑的 icon"）。
  const idle = elements.get("purchaseHistory").innerHTML;
  assert.doesNotMatch(idle, /receipt-line editable/);
  assert.match(idle, /data-edit-receipt="/);

  // 点 ✏️ 才切成输入框，一次只编辑一张采购。
  evaluate("editingReceipt = manualPurchases[0].receiptId");
  await context.renderShopping();
  const history = elements.get("purchaseHistory").innerHTML;
  assert.match(history, /receipt-line editable/);
  assert.equal(history.match(/data-line="/g).length, 3);
  assert.match(history, /data-line-del="/);

  // 改名要连带重算分类和单价，否则图标和单价对比还停在旧值上。
  const rowId = evaluate("manualPurchases[0].id");
  evaluate(`updateManualLine(${JSON.stringify(rowId)}, "price", "9.9")`);
  assert.equal(evaluate("manualPurchases[0].totalPrice"), 9.9);
  assert.match(evaluate("manualPurchases[0].unitPrice"), /9\.9 元/);

  // 商品名来自模型，可能带引号，直接塞进 value="" 会撑破属性。
  assert.match(html, /function escapeAttribute\(value\)/);
  assert.match(html, /replace\(\/"\/g, "&quot;"\)/);

  evaluate(`removeManualLine(${JSON.stringify(rowId)})`);
  assert.equal(evaluate("manualPurchases.length"), 0);
});

test("classifies supermarket product names, not just catalogue names", async () => {
  const { evaluate } = await runAppScript();
  const id = name => evaluate(`foodIdForItem(${JSON.stringify(name)})`);

  // 食材目录里是「小青菜类」「豆腐/豆干」「瓜果类」这种概念名，小票上永远不会
  // 这么写，靠 includes 一个都匹配不上，于是全落成 custom:（用户："这个记录不对"）。
  assert.equal(id("盒马 三色藜麦轻享鸡排"), "chickenTender");
  assert.equal(id("盒马日日鲜 内酯豆腐"), "tofu");
  assert.equal(id("盒马 原味酸奶"), "greekYogurt");
  assert.equal(id("麒麟奶油西瓜"), "melon");
  assert.equal(id("盒马日日鲜 油菜 (上海青)"), "bokChoy");

  // 包装费/购物袋只是账单行，归 bag 后不进「现有食材」也不进单价对比。
  assert.equal(id("环保包装费"), "bag");

  // 顺序陷阱：「鸡蛋」含「鸡」、「牛奶」含「牛」、「牛油果」含「牛」、
  // 「菠萝」含「萝」、「米线」含「米」——具体的必须先命中。
  assert.equal(id("土鸡蛋 10枚"), "egg");
  assert.equal(id("盒马 纯牛奶 1L"), "milk");
  assert.equal(id("牛油果"), "avocado");
  assert.equal(id("菠萝"), "tropical");
  assert.equal(id("米线"), "noodle");
  assert.equal(id("金针菇 150g"), "enoki");

  // 蛋奶得自己成一组，否则酸奶/牛奶在小票的分类汇总里根本不出现。
  assert.match(evaluate('summarizeReceipt([{foodId:"greekYogurt", amount:"1.5kg"}])'), /蛋奶 1\.5kg/);
});

test("re-classifies purchases that were stored before the alias table existed", async () => {
  const html = await readFile(new URL("../public/nutriflow.html", import.meta.url), "utf8");

  // 别名表是后加的，早先存下来的行全是 custom:。启动时重新认一遍并落盘，
  // 已经记错的采购不用手动重录；用户自己改过名字的（非 custom:）不碰。
  assert.match(html, /function healManualFoodIds\(\)/);
  // 对所有手动行重新推导，而不只是没归类的——否则「已经归错类」的行永远轮不到。
  assert.doesNotMatch(html, /!row\.foodId\.startsWith\("custom:"\)\) return;/);
  assert.match(html, /if \(fresh === "bag"\) row\.bought = false;/);
  assert.ok(html.includes("healManualFoodIds();") && html.indexOf("healManualFoodIds();") < html.lastIndexOf("render();"));
});

test("never records the same receipt twice", async () => {
  const { evaluate } = await runAppScript();
  const html = await readFile(new URL("../public/nutriflow.html", import.meta.url), "utf8");

  // 识别三张图要好几秒，期间 iOS 会再发一次 change 或人又选了一遍，两条 async
  // 流程并发跑完 commitPurchase()，同一单被记两遍（用户："识别重复了"）。
  assert.match(html, /let recognizing = false;/);
  assert.match(html, /if \(recognizing\) return;/);
  assert.match(html, /recognizing = false;/);

  // 保存前再挡一道：指纹一样就不新建，不管重复来自哪儿。
  assert.match(html, /const signature = receiptSignature\(store, date, rows\);/);
  assert.match(html, /这单刚记过了/);

  evaluate("manualPurchases.length = 0;");
  const line = (rid, price) => `{receiptId:"${rid}",id:"${rid}-01",date:"2026-08-06 23:10",foodId:"duck",item:"卤鸭翅中",amount:"160g",totalPrice:${price},unitPrice:"",store:"大钟寺店",bought:true,manual:true}`;
  evaluate(`manualPurchases.push(${line("A", 19.9)}, ${line("B", 19.9)})`);

  // 同店、同一天、商品名规格金额全一致 —— 现实里不可能，判为同一单记了两遍。
  assert.equal(evaluate("dedupeManualReceipts()"), 1);
  assert.equal(evaluate("manualPurchases.length"), 1);
  assert.equal(evaluate("manualPurchases[0].receiptId"), "A");

  // 金额不同就是真的两单，不能误删。
  evaluate(`manualPurchases.push(${line("C", 21.9)})`);
  assert.equal(evaluate("dedupeManualReceipts()"), 0);
  assert.equal(evaluate("manualPurchases.length"), 2);
});

test("lets the person pick which meal a photo belongs to", async () => {
  const { evaluate } = await runAppScript();

  // 照片里看不出这是第几餐——一盘番茄炒蛋中午晚上都可能吃。之前全靠模型猜，
  // 晚餐就被并进了午餐（用户："我刚上传了晚餐的番茄炒蛋，他就直接追加在午餐的后面了"）。
  assert.equal(evaluate("guessMealByClock(new Date(2026,7,6,7,0))"), "早餐");
  assert.equal(evaluate("guessMealByClock(new Date(2026,7,6,12,0))"), "午餐");
  assert.equal(evaluate("guessMealByClock(new Date(2026,7,6,19,0))"), "晚餐");
  assert.equal(evaluate("guessMealByClock(new Date(2026,7,6,23,0))"), "加餐");

  const form = evaluate("dietDayFormMarkup()");
  // 四个餐次做成一排 chip，排在「或者手动填」之前——之前它是埋在折叠区里的 select。
  assert.equal(form.match(/data-meal-pick=/g).length, 4);
  assert.ok(form.indexOf("data-meal-pick") < form.indexOf("或者手动填"));
  assert.doesNotMatch(form, /id="dietFormMeal"/);

  // 识别时以人选的餐次为准，模型的判断只在没得选时用。
  const html = await readFile(new URL("../public/nutriflow.html", import.meta.url), "utf8");
  assert.match(html, /const meal = forcedMeal \|\| result\.meal;/);
  assert.match(html, /autoRecognize\(owner, saved, \{meal: pickedMeal\(container\)\}\)/);
});

test("classifies tricky product names and normalises store names", async () => {
  const { evaluate } = await runAppScript();
  const id = name => evaluate(`foodIdForItem(${JSON.stringify(name)})`);
  const store = name => evaluate(`shortStore(${JSON.stringify(name)})`);

  // 鲑鱼就是三文鱼，之前落进了「白肉鱼」（whiteFish 的关键词里有个笼统的「鱼」）。
  assert.equal(id("Member's Mark 智利大西洋鲑鱼"), "salmon");
  // 「蛋糕卷」「沙拉酱 蛋黄口味」都含「蛋」但不是蛋，要排在 egg 前面截住。
  assert.equal(id("盒马烘焙 双拼蛋糕卷 (芝士)"), "dessert");
  assert.equal(id("丘比 沙拉酱 蛋黄口味"), "sauce");
  assert.equal(id("Member's Mark 精选鲜鸡蛋"), "egg");
  // 「蒜苔炒肉」是一道炒肉，不是葱蒜。
  assert.equal(id("盒马工坊 日日鲜 蒜苔炒肉"), "leanPork");

  // 同一家店被识别成好几种写法，对比时看着像不同的店。
  assert.equal(store("北京石景山山姆会员商店"), "山姆");
  assert.equal(store("盒马鲜生（大钟寺店）"), "盒马");
  assert.equal(store("大钟寺店"), "盒马");
  assert.equal(store("盒马鲜生"), "盒马");

  // 葱蒜按用户要求不归类，不再出现在「蔬菜」汇总里。
  assert.equal(evaluate('summarizeReceipt([{foodId:"allium", amount:"260g"}])'), "");

  // 柱子溢出：grid item 默认 min-width:auto，会被 nowrap 的店名撑住。
  const html = await readFile(new URL("../public/nutriflow.html", import.meta.url), "utf8");
  assert.match(html, /\.price-group\{[^}]*min-width:0/);
  assert.match(html, /\.bar-row\{[^}]*min-width:0/);
});

test("searches globally on the landing page and per-page elsewhere", async () => {
  const { evaluate } = await runAppScript();
  const names = (kw, scopes) => evaluate(`searchAll(${JSON.stringify(kw)}, ${JSON.stringify(scopes)})`).map(g => g.name);

  // 饮食页搜全 app，采购/食材页只搜本页；目标页不放搜索、保留 ⚙。
  // vm realm 里的数组原型和这里不同，deepEqual 会因非同一引用而失败，比 JSON 更稳。
  assert.equal(evaluate("JSON.stringify(SEARCH_SCOPES.dietLog)"), '["diet","purchase","dining","food"]');
  assert.equal(evaluate("JSON.stringify(SEARCH_SCOPES.shopping)"), '["purchase","dining"]');
  assert.equal(evaluate("JSON.stringify(SEARCH_SCOPES.foods)"), '["food"]');
  assert.equal(evaluate("SEARCH_SCOPES.home"), undefined);

  assert.ok(names("南瓜", ["diet", "purchase", "dining", "food"]).length >= 2);
  assert.equal(names("南瓜", ["food"]).length, 1);
  assert.equal(names("查无此物", ["diet", "purchase", "dining", "food"]).length, 0);
  // 空关键词不该把全部内容倒出来。
  assert.equal(names("   ", ["diet", "purchase", "dining", "food"]).length, 0);

  const html = await readFile(new URL("../public/nutriflow.html", import.meta.url), "utf8");
  assert.match(html, /id="searchBtn"/);
  assert.match(html, /searchBtn.hidden = view === "home"/);
  assert.match(html, /settingsBtn.hidden = view !== "home"/);
  // 首屏必须立刻同步一次，否则 🔍 和 ⚙ 会同时挂在顶栏上，看着像凭空多了个按钮，
  // 而不是把设置换成了搜索。之前这句错插在了 nav 点击回调里，页面加载时根本不执行。
  assert.match(html, /\n\/\/ 首屏也要立刻同步一次[\s\S]*?\nsyncTopbarButtons\(\);/);

  // 在外就餐不再常驻可编辑，点 ✏️ 才切成可填，且店名/日期/价格都能改。
  assert.match(html, /let editingDining = "";/);
  assert.match(html, /data-dining-edit="/);
  assert.match(html, /data-dining-field="place"/);
  assert.match(html, /data-dining-field="date"/);
  assert.match(html, /class="dining-price-read/);
});

test("keeps the quantity when a receipt line has more than one unit", async () => {
  const { evaluate } = await runAppScript();
  const fold = (amount, count) => evaluate(`foldCount(${JSON.stringify(amount)}, ${count})`);

  // 买两盒和买一盒，小票上的规格写的是同一个（都是「300g/盒」），只看规格分不出来
  // （用户："昨天的猪骨买了两盒，但好像没识别出来"）。
  assert.equal(fold("300g", 2), "600g（2×300g）");
  assert.equal(fold("300g", 1), "300g");
  assert.equal(fold("1kg", 3), "3kg（3×1kg）");
  // 折算后 parseAmount 要能读出总量，否则单价对比会按一件的重量算，单价翻倍。
  assert.equal(evaluate(`parseAmount(${JSON.stringify(fold("300g", 2))})`), 600);
  // 不是纯重量的挂个 ×N，至少看得出买了几件。
  assert.equal(fold("1 盒", 2), "1 盒 ×2");
  assert.equal(fold("", 2), "2 件");

  const parsed = evaluate('parseReceipt(JSON.stringify({store:"盒马",date:"2026-08-10 17:42",items:[{name:"猪汤骨",amount:"300g",count:2,price:15.96}]}))');
  assert.equal(parsed.items[0].amount, "600g（2×300g）");

  // 缺 count 的老回复要当成 1 件，不能变成 0 或 NaN。
  const single = evaluate('parseReceipt(JSON.stringify({items:[{name:"生菜",amount:"500g",price:2.97}]}))');
  assert.equal(single.items[0].amount, "500g");

  const html = await readFile(new URL("../public/nutriflow.html", import.meta.url), "utf8");
  assert.match(html, /count 写这一行买了\*\*几件\*\*/);
});

test("counts ingredients, not dish names, and re-fixes stale classifications", async () => {
  const { evaluate } = await runAppScript();
  const html = await readFile(new URL("../public/nutriflow.html", import.meta.url), "utf8");

  // 「本周吃到」数的是吃到几种食材，不是几道菜：蛋/卤蛋/煎蛋是同一种。
  const tally = evaluate('tallyByCategory([{date:"2026-08-10",meals:[{name:"午餐",items:["蛋","卤蛋","煎蛋","牛肉","牛排","生菜","油麦菜"]}]}])');
  assert.equal(tally.total, 3);
  const byName = Object.fromEntries(tally.counts.map(c => [c.rule.name, c.count]));
  assert.equal(byName["蛋奶豆"], 1);
  assert.equal(byName["鱼禽瘦肉"], 1);
  assert.equal(byName["蔬菜"], 1);
  // 展示名取最短的那个——「蛋」比「卤蛋」更像食材本身。
  assert.ok(tally.counts.find(c => c.rule.name === "蛋奶豆").names.includes("蛋"));

  // 自愈原来只补 custom: 开头的，「已经归错类」的行永远轮不到——鲑鱼早被存成
  // whiteFish，别名表加了「鲑鱼」也纹丝不动。
evaluate('manualPurchases.length = 0');
  evaluate('manualPurchases.push({receiptId:"S",id:"S-01",date:"2026-08-10",foodId:"whiteFish",item:"智利大西洋鲑鱼",amount:"1kg",totalPrice:125.9,store:"山姆",bought:true,manual:true})');
  evaluate("healManualFoodIds()");
  assert.equal(evaluate("manualPurchases[0].foodId"), "salmon");

  // 单价对比可折叠，状态存本机。
  assert.match(html, /id="priceFold"/);
  assert.match(html, /const PRICE_FOLD_KEY/);
});

test("bumps the offline cache when the app shell changes", async () => {
  const serviceWorker = await readFile(
    new URL("../public/sw.js", import.meta.url),
    "utf8",
  );

  assert.match(serviceWorker, /CACHE_NAME = "nutriflow-pwa-v100"/);
  assert.match(serviceWorker, /\.\/nutriflow\.html/);
  assert.match(serviceWorker, /isAppShell/);

  // The footer version is how you tell from the phone which build you're on, so
  // it has to track the cache name. Bumping only sw.js left the footer showing
  // v71 while the cache said v72 — the page looked stale when it wasn't.
  const html = await readFile(
    new URL("../public/nutriflow.html", import.meta.url),
    "utf8",
  );
  const cache = serviceWorker.match(/CACHE_NAME = "nutriflow-pwa-(v\d+)"/)?.[1];
  const footer = html.match(/id="appVersion">NutriFlow (v\d+)</)?.[1];
  assert.equal(footer, cache, "页脚版本号要和 sw.js 的缓存号一致");
});

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
  assert.equal(history.match(/<details class="receipt-card">/g).length, 7);
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
  assert.match(elements.get("weekMeta").textContent, /40 种 · 7 天/);
  assert.match(summary, /<b>🥩 15<\/b><span>鱼禽瘦肉<\/span>/);
  assert.match(summary, /<b>🥦 10<\/b><span>蔬菜<\/span>/);
  assert.match(summary, /<b>🥛 7<\/b><span>蛋奶豆<\/span>/);
  assert.match(summary, /<b>🍚 6<\/b><span>主食<\/span>/);
  assert.match(summary, /<b>🍎 2<\/b><span>水果坚果<\/span>/);
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

test("summarises every recorded week, not just the current one", async () => {
  const { elements, evaluate } = await runAppScript();

  // Records span two natural weeks (Monday-start), and every one of them gets a
  // summary — not just the latest.
  const weeks = evaluate("weeksFromRecords()");
  assert.equal(weeks.length, 2);

  // The summary sits inside the day list, immediately above that week's own
  // days, rather than in a separate block stacked at the top of the page.
  const list = elements.get("dietLogList").innerHTML;
  assert.equal(list.match(/<section class="week-block">/g).length, 2);
  assert.match(list, /7\/27–8\/2/);
  assert.match(list, /7\/20–7\/26/);
  assert.match(list, /40 种 · 7 天/);

  // Each week's heading comes before its own days and after the previous week's.
  const laterWeek = list.indexOf("7/27–8/2");
  const earlierWeek = list.indexOf("7/20–7/26");
  assert.ok(laterWeek < list.indexOf("2026-07-30"));
  assert.ok(list.indexOf("2026-07-27") < earlierWeek);
  assert.ok(earlierWeek < list.indexOf("2026-07-26"));
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
  assert.ok(!requests.includes("GET dining"), "脏文档根本不该去拉");
  assert.equal(evaluate("dirtyDocs()").length, 0, "推成功后清标记");

  // A device that has nothing local still pulls normally.
  server.dining = [{ id: "x", date: "2026-08-01", place: "别家", price: 50 }];
  evaluate("diningEntries.length = 0");
  await context.syncPull();
  assert.equal(evaluate("diningEntries[0].place"), "别家");
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

  // Recognition is opt-in per photo. Uploading still never transmits anything.
  assert.match(html, /只有你在某张照片上主动点「识别」/);

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
  assert.equal(history.match(/<details class="receipt-card">/g).length, 8);
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

test("bumps the offline cache when the app shell changes", async () => {
  const serviceWorker = await readFile(
    new URL("../public/sw.js", import.meta.url),
    "utf8",
  );

  assert.match(serviceWorker, /CACHE_NAME = "nutriflow-pwa-v76"/);
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

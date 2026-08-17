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
    // 折叠按钮要往上找它所在的标题行（点整行都能折叠），桩里缺 closest 脚本会直接抛。
    closest: () => null,
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
  // 蛋并进肉那一栏，从奶那栏拿掉（用户："蛋放到肉里，从奶去掉"）。
  assert.match(html, /鱼禽肉 \+ 1个蛋", amount:"120-200g/);
  assert.match(html, /name:"奶\/酸奶", amount:"300-500ml"/);
  assert.doesNotMatch(html, /鱼\/瘦肉/);
  assert.match(html, /每周 1 次（占水产 2 次中的 1 次）/);
  assert.match(html, /name:"牛肉"[\s\S]*name:"瘦猪肉"/);
  assert.match(html, /name:"鸡肉"/);
  assert.doesNotMatch(html, /name:"火鸡/);
  assert.match(html, /<details class="history-details">/);
  assert.match(html, /<details class="receipt-card"/);
  assert.match(html, /summarizeReceipt/);
  assert.match(html, /国产谷饲黄牛牛腱肉/);
  assert.match(html, /indexedDB/);
  // 隐私说明在饮食页写一次就够了；在外就餐那张卡按用户要求把小字都删了。
  assert.match(html, /照片存本地不传 GitHub/);
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
  // 底栏顺序：饮食 → 采购 → 食材 → 营养 → 计划（用户定的），饮食是落地页。
  const navAt = view => html.indexOf(`data-view="${view}"`);
  assert.ok(navAt("dietLog") < navAt("buying"));
  assert.ok(navAt("buying") < navAt("shopping"));
  assert.ok(navAt("shopping") < navAt("foods"));
  assert.ok(navAt("foods") < navAt("home"));
  assert.match(html, /<section class="view active" id="dietLog">/);
  assert.match(html, /data-view="home"><b>◎<\/b><span>计划<\/span>/);
  assert.match(html, /grid-template-columns:repeat\(5,1fr\)/);
  // 五个 tab 的图标都用单色字形，别混彩色 emoji 进去（用户："icon 和别的风格
  // 明显不一致"）。emoji 会被系统渲染成彩色，和 ▤ ＋ ★ ◎ 完全两种质感。
  const navBlock = html.slice(html.indexOf('<nav class="bottom-nav"'), html.indexOf("</nav>"));
  const navIcons = [...navBlock.matchAll(/<b>([^<]+)<\/b><span>[^<]+<\/span>/g)].map(m => m[1]);
  assert.equal(navIcons.length, 5);
  assert.ok(navIcons.every(icon => !/\p{Extended_Pictographic}/u.test(icon)), `底栏出现彩色 emoji：${navIcons.join(" ")}`);

  // 采购记录单独成页，食材页只留现有食材和单价对比。
  const viewOf = name => {
    const start = html.indexOf(`id="${name}">`);
    return html.slice(start, html.indexOf("</section>", start));
  };
  assert.match(viewOf("shopping"), /<h2>现有食材<\/h2>/);
  assert.match(viewOf("shopping"), /<h2>食材单价对比<\/h2>/);
  assert.doesNotMatch(viewOf("shopping"), /<h2>采购历史<\/h2>/);
  assert.match(viewOf("buying"), /<h2>采购历史<\/h2>/);
  assert.match(viewOf("buying"), /<h2>采购统计<\/h2>/);
  assert.match(viewOf("buying"), /<h2>在外就餐<\/h2>/);

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
  // 查天块自己的锚点，不要查裸日期——表单顶部的日期 chip 也含日期字符串，
  // 会先被 indexOf 匹配到，测的就不是列表顺序了。
  const dayAt = day => list.indexOf(`data-day="${day}"`);
  assert.ok(dayAt("2026-07-22") < dayAt("2026-07-21"));
  assert.ok(dayAt("2026-07-21") < dayAt("2026-07-20"));

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
  assert.ok(list.indexOf('data-day="2026-07-27"') < list.indexOf('data-day="2026-07-26"'));

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
  // 识别在后台跑，照片先从表单端走再送去识别。
  assert.match(html, /const files = pendingPhotos;/);
  assert.match(html, /await recognizeReceipts\(files\)/);
  // 相邻截图会重叠，按「名称 + 规格」去重。
  // 相邻截图重叠时同一行常被读成两种写法（带不带规格），按原文去重抓不住，
  // 所以合并时也走归一化。
  assert.match(html, /normalizeItemName\(item.name\)\}\|\$\{parseAmount\(item.amount\)/);

  // 外卖单上同时有总价/优惠/打包费，必须明确只取实付，否则会挑错数或相加。
  assert.match(html, /实付合计.*实付款|只填\*\*这一单最后实际付掉的钱\*\*/);
  assert.match(html, /不要把它们相加/);
});

test("auto-saves a recognised receipt and keeps every line editable", async () => {
  const { context, elements, evaluate } = await runAppScript();
  const html = await readFile(new URL("../public/nutriflow.html", import.meta.url), "utf8");

  // 识别完直接写进采购历史，不再回填表单、也不等人点保存。
  assert.match(html, /const \{receiptId\} = addPurchaseReceipt\(\{date, store, items: rows\}\);/);
  assert.match(html, /已记下 \$\{items.length\} 件/);

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
  assert.match(evaluate('summarizeReceipt([{foodId:"greekYogurt", amount:"1.5kg"}])'), /蛋奶豆 1\.5kg/);
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
  // 连拍每张都触发 change，防抖到没有新照片才开始，四张算一单而不是四单。
  assert.match(html, /clearTimeout\(recognizeTimer\);/);
  // 照片一被端走 pendingPhotos 就清空，同一批不会被第二次送去识别。
  assert.match(html, /const files = pendingPhotos;\n    pendingPhotos = \[\];/);

  // 入账前再挡一道：指纹一样就不新建，不管重复来自哪儿。
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
  assert.match(html, /const shotMeal = pickedMeal\(container\);/);
  assert.match(html, /autoRecognize\(owner, saved, \{meal: shotMeal\}\)/);
  // 餐次还要写进照片记录本身，事后没有任何办法反推一张图是午饭还是晚饭。
  assert.match(html, /savePrivatePhoto\(owner, file, shotMeal\)/);
  assert.match(html, /\.\.\.\(meal \? \{meal\} : \{\}\)/);
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
  assert.equal(evaluate("JSON.stringify(SEARCH_SCOPES.shopping)"), '["purchase"]');
  assert.equal(evaluate("JSON.stringify(SEARCH_SCOPES.buying)"), '["purchase","dining"]');
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
  // 「待补价」按用户要求去掉：没写金额本身就看得出来。
  assert.match(html, /\$\{priceVal === "" \? "" : `<span class="price">¥\$\{priceVal\}<\/span>`\}/);
  assert.ok(!/待补价/.test(html), "「待补价」该删掉");
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

test("resumes recognition that iOS cut off when the app went to the background", async () => {
  const { evaluate } = await runAppScript();
  const html = await readFile(new URL("../public/nutriflow.html", import.meta.url), "utf8");

  // iOS 挂起后台网页会掐断正在跑的请求，网页没法真在后台跑。所以待识别的照片排队
  // 存本机，回到前台接着跑完（用户："切到别的应用程序，就退出识别了"）。
  evaluate('enqueueRecognition("p1","diet:2026-08-11","晚餐")');
  evaluate('enqueueRecognition("p2","diet:2026-08-11","晚餐")');
  // 同一张重复入队只留一条，否则回来会把同一顿记两遍。
  evaluate('enqueueRecognition("p1","diet:2026-08-11","晚餐")');
  assert.equal(evaluate("aiQueue().length"), 2);
  evaluate('dequeueRecognition("p1")');
  assert.equal(evaluate("JSON.stringify(aiQueue().map(j => j.photoId))"), '["p2"]');

  // 先入队再发请求，识别成功才出队——顺序反了就等于没排队。
  assert.ok(html.indexOf("enqueueRecognition(photo.id, owner, forcedMeal)") < html.indexOf("dequeueRecognition(photo.id)"));
  assert.match(html, /drainRecognitionQueue/);
  assert.match(html, /if \(drainingQueue \|\| !aiConfig\(\).key\) return 0;/);

  // 调料、油、饮用水是备货，不该出现在「现有食材」里。
  assert.match(evaluate("JSON.stringify(NOT_INGREDIENT)"), /seasoning/);
  assert.equal(evaluate('foodIdForItem("盒马 小米辣 50g")'), "seasoning");
  assert.equal(evaluate('foodIdForItem("金龙鱼 食用调和油 5L")'), "oil");
  assert.equal(evaluate('foodIdForItem("农夫山泉 矿泉水")'), "water");
  // 尖椒是菜，不能被调料规则误伤。
  assert.equal(evaluate('foodIdForItem("盒马日日鲜 尖椒")'), "pepper");

  // 现有食材也能折叠。
  assert.match(html, /id="stockFold"/);
  assert.match(html, /const STOCK_FOLD_KEY/);
});

test("summarises spending by week or month and breaks it down by category", async () => {
  const { evaluate } = await runAppScript();
  const html = await readFile(new URL("../public/nutriflow.html", import.meta.url), "utf8");

  const weeks = evaluate('spendByPeriod("week")');
  const months = evaluate('spendByPeriod("month")');
  assert.ok(weeks.length > months.length);
  // 新到旧排序，方便一眼看最近花了多少。
  assert.ok(weeks[0].key >= weeks[weeks.length - 1].key);
  // 两种口径的总额必须一致，否则是分桶把记录漏了或重复计了。
  const sum = list => Math.round(list.reduce((total, bucket) => total + bucket.total, 0) * 100);
  assert.equal(sum(weeks), sum(months));

  const cats = evaluate("categoryTotals()");
  assert.ok(cats.length >= 3);
  // 按花费从多到少，且每类都能点开看具体买了啥。
  assert.ok(cats[0].spend >= cats[cats.length - 1].spend);
  assert.ok(cats[0].items.length >= 1);
  // 调料、油、饮用水不计进统计。
  assert.ok(!cats.some(group => group.items.some(item => /矿泉水|调和油|小米辣/.test(item.name))));

  // 这两个属性是模板里拼出来的，源码里查模板本身。
  assert.match(html, /data-spend-mode="\$\{mode\}"/);
  assert.match(html, /data-cat="\$\{group\.name\}"/);
});

test("search results jump to the record they point at", async () => {
  const html = await readFile(new URL("../public/nutriflow.html", import.meta.url), "utf8");

  // 每条命中都是按钮并带上「去哪儿」，容器上做事件委托（结果是 innerHTML 重建的）。
  assert.match(html, /class="search-hit" data-goto="dietLog"/);
  assert.match(html, /class="search-hit" data-goto="shopping"/);
  assert.match(html, /class="search-hit" data-goto="foods"/);
  assert.match(html, /data-anchor=/);
  assert.match(html, /results.addEventListener\("click"/);
  assert.match(html, /function gotoSearchHit\(view, anchor\)/);

  // 跳转目标需要锚点，三处列表都得有。
  assert.match(html, /<div class="diet-day" data-day=/);
  assert.match(html, /<div class="dining-entry" data-dining-entry=/);
  assert.match(html, /<div class="item tall" data-food=/);

  // 目标可能藏在折叠的小票里，得先展开，否则滚过去是空的。
  assert.match(html, /const box = target.closest\("details"\);/);
  assert.match(html, /box.open = true;/);
});

test("picks the day from a strip of recent days, with the calendar behind a tap", async () => {
  const { evaluate } = await runAppScript();
  const html = await readFile(new URL("../public/nutriflow.html", import.meta.url), "utf8");

  // 记的基本都是今天或往前一两天，整个日历太重（用户："日期是滚轮的形式，不要一整个
  // 日历选…如果是太多天以前，可以加一个展开，再看整个日历"）。
  const label = (offset) => evaluate(`(() => { const d = new Date(2026, 7, 15); d.setDate(d.getDate() - ${offset}); return dayChipLabel(d, ${offset}); })()`);
  assert.equal(label(0), "今天");
  assert.equal(label(1), "昨天");
  assert.equal(label(2), "前天");
  // 再往前就写日期加星期，光写「大前天」数不清。
  assert.match(label(3), /^\d+\/\d+ 周[日一二三四五六]$/);

  const chips = evaluate('recentDayChips(new Date(2026, 7, 15), "2026-08-15")');
  assert.equal(chips.match(/data-day-pick=/g).length, 7);
  // 从旧到新排，今天在最右——和日历、和"时间往右走"的直觉一致
  // （用户："昨天不应该在今天的前面吗"）。
  assert.ok(chips.indexOf("2026-08-09") < chips.indexOf("2026-08-14"));
  assert.ok(chips.indexOf("2026-08-14") < chips.indexOf("2026-08-15"));
  // 当天默认选中。
  assert.match(chips, /class="day-chip active" data-day-pick="2026-08-15"/);

  // 原生日历默认收起，点 📅 才放出来；它仍是唯一的日期来源，读日期的地方不用改。
  assert.match(html, /id="dietFormDate" class="diet-form-date" value="\$\{value\}" aria-label="日期" hidden/);
  assert.match(html, /id="dietFormMoreDays"/);
  assert.match(html, /dateInput.hidden = false;/);
  // 这一行要能横滑，且不能把外层撑破。
  assert.match(html, /\.diet-form-days\{[^}]*overflow-x:auto/);
  assert.match(html, /\.diet-form-days\{[^}]*min-width:0/);
});

test("folds the weekly shopping goal and merges the two target cards", async () => {
  const { elements } = await runAppScript();
  const html = await readFile(new URL("../public/nutriflow.html", import.meta.url), "utf8");

  // 「每顿目标」和「每天目标」并成一张卡，和上面的「今天吃到这些」不再三卡重复
  // （用户："感觉有点重复"）。两份清单都还在，只是各自带个小标题。
  // 「每天目标」和上面的「今天吃到这些」讲的是同一件事，整段删掉，类别全部补到
  // 上面的磁贴里；只留「每顿目标」（用户："下面的每天总量是不是不要了"）。
  assert.doesNotMatch(html, /<h2>每天目标<\/h2>/);
  assert.doesNotMatch(html, /id="dailyList"/);
  assert.match(html, /<h2>每顿目标<\/h2>/);
  assert.match(html, /id="mealList"/);

  // 「每周采购目标」默认收起：它是长期参考，不像别的卡天天要看。
  // 默认值和别处相反——没存过就是折叠，所以判的是 !== "0"。
  assert.match(html, /localStorage.getItem\(WEEKLY_FOLD_KEY\) !== "0"/);
  assert.match(html, /id="weeklyFold"/);

  // 「库内 N 组食材可轮换」按要求删掉。
  assert.doesNotMatch(html, /组食材可轮换/);
  assert.doesNotMatch(elements.get("weeklySummary").innerHTML, /库内/);
});

test("keeps a weekly meal-plan notepad with tappable ingredients", async () => {
  const { evaluate } = await runAppScript();
  const html = await readFile(new URL("../public/nutriflow.html", import.meta.url), "utf8");

  // 按日期存纯文本，展示时再按自然周分组——加一天/跨周都不用迁移数据结构。
  evaluate('setMealPlan("2026-09-12", "番茄炒蛋")');
  assert.equal(evaluate('mealPlans["2026-09-12"]'), "番茄炒蛋");
  // 清空就删掉，别留一堆空串。
  evaluate('setMealPlan("2026-09-12", "   ")');
  assert.equal(evaluate('mealPlans["2026-09-12"]'), undefined);

  // 用户备忘录里那两周的计划写成底稿：没存过的那天读底稿，存过的以存的为准。
  // 底稿不写进 localStorage——云同步是整份替换，写进去下一次拉取就没了。
  assert.equal(evaluate('planTextFor("2026-08-11")'), "番茄炒蛋\n冬瓜排骨汤 煎三文鱼");
  assert.equal(evaluate('planTextFor("2026-08-05")'), "牛肉牛肉丸生菜鸡蛋面");
  assert.equal(evaluate('planTextFor("2026-08-06")'), "");
  // 有底稿的那天被清空，要留一个空串把底稿压住，否则删完又冒出来。
  evaluate('setMealPlan("2026-08-11", "")');
  assert.equal(evaluate('mealPlans["2026-08-11"]'), "");
  assert.equal(evaluate('planTextFor("2026-08-11")'), "");
  evaluate('delete mealPlans["2026-08-11"]');

  // 空白的过去周不显示（用户："再往前的那周就删掉吧，没有计划"）。
  assert.equal(evaluate('weekPlanCount(new Date(2026, 7, 10))'), 5);
  assert.equal(evaluate('weekPlanCount(new Date(2026, 7, 3))'), 4);
  assert.equal(evaluate('weekPlanCount(new Date(2026, 6, 27))'), 0);
  assert.match(html, /\.filter\(week => week.current \|\| week.filled\)/);

  // 计划是手动录入的，按既定规则接入云同步。
  assert.match(html, /key: "meal_plan"/);

  // 本周展开、过去的折叠（用户："过去了的周就折叠"）。
  assert.match(html, /<section class="plan-week">/);
  assert.match(html, /<details class="plan-week">/);

  // 可点添加的食材和「现有食材」同一个口径：调料油水不算，吃完勾掉的不再出现。
  assert.match(html, /NOT_INGREDIENT.includes\(row.foodId\)\) return;/);
  assert.match(html, /if \(consumed\[row.id\]\) return;/);
  // 用 mousedown 而不是 click：click 之前 textarea 已经 blur，插入位置会丢。
  assert.match(html, /button.addEventListener\("mousedown", event => \{/);
  // 输入即存但不重渲染，否则正在打字的框会被换掉。
  assert.match(html, /area.addEventListener\("input", \(\) => \{ setMealPlan\(area.dataset.planDay, area.value\); grow\(\); \}\);/);
  // 高度跟着内容走：固定行数会让空白的天和写满的天一样高。
  assert.match(html, /area.style.height = `\$\{area.scrollHeight\}px`;/);
  // 做法插的是完整的「（炒）」，不让人自己补括号——否则满屏都是没闭合的左括号。
  assert.match(html, /data-plan-add="（\$\{name\}）"/);
});

test("never lets iOS zoom the page when a field gets focus", async () => {
  const html = await readFile(new URL("../public/nutriflow.html", import.meta.url), "utf8");
  const css = html.split("<style>")[1].split("</style>")[0];

  // iOS 对 font-size < 16px 的输入框，一聚焦就把整页放大（用户："现在点编辑，
  // 整个页面会放大，有点奇怪"）。所有可输入控件必须 ≥ 16px。
  const offenders = [];
  for (const match of css.matchAll(/([^{}\n]*)\{([^}]*font-size:(\d+)px[^}]*)\}/g)){
    const [, selector, , size] = match;
    const sel = selector.trim();
    // 平时小、:focus 升到 16px 是允许的——iOS 只在聚焦那一刻判断字号。
    const hasFocusBump = new RegExp(`\\${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:focus\\{[^}]*font-size:1[6-9]px`).test(css)
      || css.includes(`${sel}:focus{font-size:16px}`);
    if (Number(size) < 16 && /input|textarea|\.plan-text|receipt-field|dining-field/i.test(sel) && !hasFocusBump){
      offenders.push(`${sel} @ ${size}px`);
    }
  }
  assert.deepEqual(offenders, []);

  // 每周计划归在「目标」页，不在饮食页。
  const homeStart = html.indexOf('id="home"');
  const homeEnd = html.indexOf("</section>", homeStart);
  const plan = html.indexOf("<h2>每周计划</h2>");
  assert.ok(plan > homeStart && plan < homeEnd);
});

test("accumulates receipt photos across camera shots and shows them", async () => {
  const html = await readFile(new URL("../public/nutriflow.html", import.meta.url), "utf8");

  // 用相机时一次只回来一张，再拍一张又触发一次 change。原来直接整体覆盖，
  // 所以「拍第二张就把第一张顶掉了」（用户反馈）。必须累加而不是赋值。
  // 采购表单的那段（在外就餐仍是整体赋值，那边一次只传一张、没这个问题）。
  const buyForm = html.slice(html.indexOf('document.getElementById("buyPhotoInput")'));
  assert.match(buyForm, /pendingPhotos.push\(file\);/);
  assert.ok(buyForm.indexOf("pendingPhotos.push(file);") < buyForm.indexOf("startRecognize"));
  // 同一张选两次不该记两遍。
  assert.match(html, /\$\{file.name\}\|\$\{file.size\}\|\$\{file.lastModified\}/);
  // 清空 input，否则下次选同一张不会触发 change。
  assert.match(html, /photoEl.value = "";\n  \};/);

  // 连拍时每张都触发 change，要等没有新照片了再一起识别，否则各自记成一单。
  assert.match(html, /clearTimeout\(recognizeTimer\);/);
  assert.match(html, /setTimeout\(\(\) => void startRecognize\(\), 1600\);/);

  // 只显示张数看不出传了什么，要有缩略图，且能单张去掉。
  assert.match(html, /id="buyPendingThumbs"/);
  assert.match(html, /class="pending-tile"/);
  assert.match(html, /data-pending-del=/);
  // objectURL 每次重画都要释放，否则连拍几张会攒一堆内存。
  assert.match(html, /pendingUrls.forEach\(url => URL.revokeObjectURL\(url\)\);/);
});

test("recognises receipts in the background so the form frees up at once", async () => {
  const html = await readFile(new URL("../public/nutriflow.html", import.meta.url), "utf8");

  // 上传完就腾空表单让人接着记下一单，识别放后台（用户："别我上传完照片就卡在
  // 这里不动了，我还得继续记录下一个"）。照片先端走再 await，否则还是卡着。
  const job = html.slice(html.indexOf("async function startRecognize()"));
  assert.ok(job.indexOf("const files = pendingPhotos;") < job.indexOf("await recognizeReceipts(files)"));
  assert.ok(job.indexOf("showPending();") < job.indexOf("await recognizeReceipts(files)"));
  // 可以同时跑好几单，提示里带上还有几单在跑。
  assert.match(html, /let backgroundJobs = 0;/);
  assert.match(html, /还有 \$\{backgroundJobs\} 单在跑/);

  // 饮食页那条路同样不能干等：照片存好先 render() 放开入口，识别不 await。
  const dietJob = html.slice(html.indexOf('const owner = dietPhotoOwner(date);'));
  assert.match(dietJob.slice(0, 1400), /后台识别中…可以接着记/);
  assert.match(dietJob.slice(0, 1400), /void autoRecognize\(owner, saved/);
  assert.ok(dietJob.indexOf("render();") < dietJob.indexOf("void autoRecognize"));

  // 识别失败也别让照片白传：存成一条待补充的采购，照片挂上去。
  assert.match(html, /照片已存成一条待补充的采购/);
  assert.match(job.slice(job.indexOf("catch")), /savePrivatePhoto\(receiptId, file\)/);
});

test("shows every daily category once, with notes behind a tap", async () => {
  const { elements, evaluate } = await runAppScript();
  const html = await readFile(new URL("../public/nutriflow.html", import.meta.url), "utf8");

  // 原来 hero 只放前 3 类、下面再用「每天目标」把全部重列一遍，两处讲同一件事。
  // 现在全部类别只在 hero 出现一次。
  const core = elements.get("homeCore").innerHTML;
  const total = evaluate("dailyTargets.length");
  assert.ok(total > 3);
  assert.equal(core.match(/data-daily-note=/g).length, total);
  assert.doesNotMatch(html, /dailyTargets.slice\(0,3\)/);

  // 说明文字不常驻，点磁贴才出来。
  assert.match(core, /id="dailyNote"/);
  assert.match(html, /noteBox.hidden = false;/);
  // 磁贴变成了按钮，得有按钮的基础样式，否则会带上浏览器默认外观。
  assert.match(html, /button.metric\{[^}]*border:0/);

  // 每顿目标只留类别和克数，那行小字去掉。
  const mealMarkup = html.slice(html.indexOf('document.getElementById("mealList")'));
  assert.doesNotMatch(mealMarkup.slice(0, 400), /<small>\$\{target.note\}<\/small>/);

  // 膳食宝塔是长期参考，默认折叠。
  assert.match(html, /<details class="pagoda">/);
  assert.doesNotMatch(html, /<details class="pagoda" open>/);
});

test("ties the category breakdown to the period picked above it", async () => {
  const { evaluate } = await runAppScript();
  const html = await readFile(new URL("../public/nutriflow.html", import.meta.url), "utf8");

  // 之前不管上面选了哪一期，下面永远统计全部，点开的明细和上面的金额对不上
  // （用户："下面的展开不跟随上面选的时间区域变"）。
  const all = evaluate('categoryTotals("week", "")');
  const weeks = evaluate('spendByPeriod("week")');
  const one = evaluate(`categoryTotals("week", ${JSON.stringify(weeks[0].key)})`);
  const sum = list => Math.round(list.reduce((total, group) => total + group.spend, 0) * 100);
  assert.ok(sum(one) < sum(all));
  // 分桶口径必须和金额条一致，否则两处数字对不上。
  assert.match(html, /function periodOf\(date, mode\)/);

  // 周期条可点选，再点一次取消。
  assert.match(html, /data-period="\$\{bucket.key\}"/);
  assert.match(html, /selectedPeriod = selectedPeriod === button.dataset.period \? "" : button.dataset.period;/);
  // 切周/月时要清掉选择——两种口径的 key 不通用，留着会指向不存在的一期。
  assert.match(html, /spendMode = button.dataset.spendMode; selectedPeriod = "";/);
});

test("shows the meal photos on the matching eating-out record", async () => {
  const html = await readFile(new URL("../public/nutriflow.html", import.meta.url), "utf8");

  // 餐食照片挂在饮食页那一天（owner 是 diet:日期），在外就餐这边原来一张也看不到
  // （用户："在外就餐的图片要从饮食那边拉过来，不然我也不知道具体吃了啥"）。
  assert.match(html, /const dayPhotos = photosByOwner\[dietPhotoOwner\(String\(entry.date \|\| ""\).slice\(0, 10\)\)\] \|\| \[\];/);
  // 但不能整天一起借：中午在外面吃、晚上在家做，晚饭那几张也会被拉过来
  // （用户："把不是在外就餐的那张图也拉过来了"）。按餐次挑。
  assert.match(html, /const borrowed = dayPhotos.filter\(photo => diningMeal \? photo.meal === diningMeal : !photo.meal\);/);
  // 第一版留了个"这一天没有任何标记就全借"的退路，等于没改——老照片全都没标记。
  assert.ok(!/dayHasMealTags/.test(html), "不该再有整天全借的退路");
  // 识别的时候也要把餐次补回照片，不然只有新拍的才有标记。
  assert.match(html, /void stampPhotoMeal\(photo.id, meal\);/);
  // 自己挂的排前面，借来的去重后接上。
  assert.match(html, /borrowed.filter\(photo => !seenPhotos.has\(photo.id\)\)/);
  // 借来的只是显示，不能带删除属性——它归属别处，在这里删会把原处那张一起删掉。
  assert.match(html, /photo.borrowed\n      \? ""/);
  assert.match(html, /\{\.\.\.photo, borrowed: true\}/);
});

test("draws the spending split as donuts and drops cross-receipt duplicates", async () => {
  const { evaluate } = await runAppScript();
  const html = await readFile(new URL("../public/nutriflow.html", import.meta.url), "utf8");

  // 环形图用 stroke-dasharray 一段段绕圈，不引库、不上 canvas。
  const svg = evaluate('donutSvg([{label:"a",value:3},{label:"b",value:1}], 100)');
  assert.equal(svg.match(/<circle/g).length, 2);
  assert.match(svg, /stroke-dasharray=/);
  // 空数据不该画出一张空图。
  assert.equal(evaluate("donutSvg([], 100)"), "");
  // 默认全展开：记的是「收起了哪几类」，新分类才会是展开的。
  assert.match(html, /const closedSpendCategories = new Set\(\);/);
  assert.match(html, /closedSpendCategories.has\(group.name\)/);

  // 整单指纹只抓「一模一样的两单」；同一样东西被拆进两张单里就漏了，
  // 统计会翻倍（用户："统计买了两次山姆的鸡蛋，实际只买过一次"）。
  evaluate("manualPurchases.length = 0");
  const line = (rid, id) => `{receiptId:"${rid}",id:"${id}",date:"2026-08-10 10:00",foodId:"egg",item:"精选鲜鸡蛋",amount:"1.59kg",totalPrice:18.9,store:"山姆",bought:true,manual:true}`;
  // 同一样东西两次记录的写法常差一点：名字带不带规格、规格写不写单位后缀。
  // 按原文比对抓不住（用户截图：牛奶出现两次，实际只买过一笔）。
  assert.equal(evaluate('normalizeItemName("悦鲜活 鲜牛奶 950ml")'), evaluate('normalizeItemName("悦鲜活 鲜牛奶")'));
  assert.notEqual(evaluate('normalizeItemName("盒马日日鲜 生菜")'), evaluate('normalizeItemName("盒马日日鲜 油菜 (上海青)")'));
  evaluate(`manualPurchases.push(${line("A", "A-01")}, ${line("B", "B-01")})`);
  assert.equal(evaluate("dedupeManualLines()"), 1);
  assert.equal(evaluate("manualPurchases.length"), 1);
  // 同一张单里也会重复——一单要滚好几屏截图，重叠部分被读了两遍，而且两遍的
  // 写法常常差一点（带不带规格），识别合并那层的原文去重抓不住。
  // 真买两份现在是同一行 count:2（v99 起），不会写成两行一模一样的。
  evaluate(`manualPurchases.push(${line("A", "A-02")})`);
  assert.equal(evaluate("dedupeManualLines()"), 1);
  // 合并多张照片时也要按归一化后的名字去重，否则重复在入账前就已经产生了。
  assert.match(html, /const key = `\$\{normalizeItemName\(item.name\)\}\|\$\{parseAmount\(item.amount\)\}`;/);
});

test("offers the three cooking methods while editing a plan day", async () => {
  const html = await readFile(new URL("../public/nutriflow.html", import.meta.url), "utf8");

  // 只有这三种（用户明确要求），排在食材前面：一般先想怎么做再挑料，
  // 而且它固定三个、位置稳定，好按。
  assert.match(html, /\["空气炸锅", "炒", "蒸"\]/);
  const chipFn = html.slice(html.indexOf("function showPlanChips"));
  assert.ok(chipFn.indexOf("methods +") > 0);
  // 现有食材为空时也得能选做法，不能因为没食材就整行不显示。
  assert.doesNotMatch(chipFn.slice(0, 600), /if \(!chips.length\) return;/);
});

test("splits the stock list into meat and vegetables only", async () => {
  const { elements } = await runAppScript();
  const html = await readFile(new URL("../public/nutriflow.html", import.meta.url), "utf8");
  const stock = elements.get("boughtFoods").innerHTML;

  // 用户明确"只分这两类"，分太细每块只剩一两样，反而不如不分。
  const heads = [...stock.matchAll(/data-stock-group="([^"]+)"/g)].map(m => m[1]);
  assert.ok(heads.length <= 3);
  assert.ok(heads.every(head => /肉|蔬菜|其他/.test(head)));
  // 先菜后肉，和计划里的食材 chip 一个顺序，别一个页面一个样。
  const order = heads.map(head => head.replace(/[^\u4e00-\u9fa5]/g, ""));
  assert.deepEqual(order, ["蔬菜", "肉", "其他"].filter(name => order.includes(name)));
  // 肉和水产合成一块「肉」。
  assert.match(html, /rule.name === "肉类" \|\| rule.name === "水产"/);
  // 空的那块不出小标题。
  assert.match(html, /\.filter\(group => group.rows.length\)/);

  // 每块自己也能收起来（用户："蔬菜，肉，也可以折叠"）。记的是"收起了哪几块"，
  // 新冒出来的分块默认展开。
  assert.match(html, /const STOCK_GROUP_KEY = "nutriflow_stock_groups_closed";/);
  assert.match(stock, /aria-expanded="true"/);
  assert.match(stock, /<i class="fold-caret">▾<\/i>🥦 蔬菜/);
  assert.match(html, /localStorage.setItem\(STOCK_GROUP_KEY, JSON.stringify\(\[...closedStockGroups\]\)\)/);
  // 小标题变成了 <button>，iOS 会给它一套自己的蓝字和居中，必须显式压掉。
  const css = html.split("<style>")[1].split("</style>")[0];
  assert.match(css, /\.stock-sub\{[^}]*color:var\(--muted\)/);
  assert.match(css, /\.stock-sub\{[^}]*text-align:left/);
});

test("inserts plan chips at the caret and measures height once visible", async () => {
  const html = await readFile(new URL("../public/nutriflow.html", import.meta.url), "utf8");

  // 点 chip 要插在光标处，不是甩到末尾（用户："我点的是某一个中间的字，但是点
  // 下面的菜会追加在最后"）。mousedown 里 textarea 还没 blur，selectionStart
  // 仍是刚才点的位置——这正是当初选 mousedown 而不是 click 的原因。
  assert.match(html, /area.selectionStart/);
  assert.match(html, /const before = text.slice\(0, at\);/);
  // 词之间补空格但不叠、行首不加。
  assert.match(html, /const lead = before && !\/\[\\s\]\$\/.test\(before\) \? " " : "";/);
  // 插完把光标停在新词后面，接着点下一样位置才对。
  assert.match(html, /area.setSelectionRange\?\.\(caret, caret\)/);

  // 隐藏元素的 scrollHeight 是 0——渲染时「计划」页还没显示，高度会被钉在最小值，
  // 写了两行只露出一行。切到这一页、展开这张卡时都要重新量。
  assert.match(html, /function growAllPlanTexts\(\)/);
  assert.match(html, /if \(!area.scrollHeight\) return;/);
  assert.match(html, /if \(!folded\) growAllPlanTexts\(\);/);
});

test("keeps the plan font the same size before and after focus", async () => {
  const html = await readFile(new URL("../public/nutriflow.html", import.meta.url), "utf8");
  const css = html.split("<style>")[1].split("</style>")[0];

  // 之前靠 :focus 把字号从 13px 顶到 16px 来躲开 iOS 的聚焦缩放，代价是字会
  // "一点就变大"（用户："我一点开又变得很奇怪，字又放大了"）。现在字号恒定
  // 16px，整个框 transform 缩小——iOS 不放大，视觉上也不跳。
  assert.ok(!/\.plan-text:focus\{[^}]*font-size/.test(css), "计划框不该再靠 :focus 改字号");
  assert.match(css, /\.plan-text\{[^}]*font-size:16px/);
  assert.match(css, /\.plan-text\{[^}]*transform:scale\(\.82\)/);
  // 缩放不改布局高度，得靠外壳按同样比例占位，否则框下面空一截。
  assert.match(css, /\.plan-text-wrap\{[^}]*overflow:hidden/);
  assert.match(html, /const PLAN_TEXT_SCALE = 0\.82;/);
  assert.match(html, /wrap.style.height = `\$\{Math.round\(area.scrollHeight \* PLAN_TEXT_SCALE\)\}px`/);
  // chip 那排要挂在外壳后面，塞进外壳会被 overflow:hidden 切掉。
  assert.match(html, /\(area.closest\("\.plan-text-wrap"\) \|\| area\).insertAdjacentElement\("afterend", row\)/);
  // 和下面的 chip 之间要留缝（用户："和下面也贴的太近"）。
  assert.match(css, /\.plan-chips\{[^}]*margin-top:6px/);
});

test("strips the plan icons that v123 left behind", async () => {
  const { evaluate } = await runAppScript();

  // v123 试过自动补 emoji，用户看完说"有点乱"，撤了。代码删掉不够——那一版已经把
  // 带图标的文本存进了 mealPlans 并同步上云，得在渲染前把存量剥干净。
  assert.equal(evaluate('stripPlanIcons("🍣三文鱼 🍄香菇 🥔土豆 🥬生菜")'), "三文鱼 香菇 土豆 生菜");
  assert.equal(evaluate('stripPlanIcons("🥬萝卜🥩排骨汤 🌽玉米烙 （炒）")'), "萝卜排骨汤 玉米烙 （炒）");
  // 没图标的原样返回，不能顺手改动用户自己打的字。
  assert.equal(evaluate('stripPlanIcons("番茄炒蛋 （炒）")'), "番茄炒蛋 （炒）");
  // 多行要保住换行，只压行内的多余空格。
  assert.equal(evaluate('stripPlanIcons("🍣三文鱼\\n🌽玉米")'), "三文鱼\n玉米");
  // 三文鱼那个图标本身是用户单独要求改的，别跟着一起撤。
  assert.equal(evaluate('iconForFood("salmon")'), "🍣");

  const html = await readFile(new URL("../public/nutriflow.html", import.meta.url), "utf8");
  assert.ok(!/decoratePlanText/.test(html), "自动补图标的代码应该已经撤掉");
  assert.match(html, /cleanStoredPlanIcons\(\);/);
});

test("keeps chillies out of the rice bucket", async () => {
  const { evaluate } = await runAppScript();

  // 「小米椒」既不含「小米辣」也不含「辣椒」，前面两条规则都拦不住，一路掉到
  // rice 的「小米」上（用户："小米椒被归到大米类别了"）。
  assert.equal(evaluate('foodIdForItem("小米椒")'), "seasoning");
  assert.equal(evaluate('foodIdForItem("朝天椒")'), "seasoning");
  assert.equal(evaluate('foodIdForItem("小米辣")'), "seasoning");
  // 真的米别被误伤。
  assert.equal(evaluate('foodIdForItem("五常大米")'), "rice");
  assert.equal(evaluate('foodIdForItem("泰国香米")'), "rice");
  assert.equal(evaluate('foodIdForItem("小米")'), "rice");
  // 调料不进「现有食材」，也不进单价对比。
  assert.equal(evaluate('NOT_INGREDIENT.includes("seasoning")'), true);
  // 存量里已经归错的行靠启动时的重推导修正，不用用户手工改。
  const html = await readFile(new URL("../public/nutriflow.html", import.meta.url), "utf8");
  assert.match(html, /const fresh = foodIdForItem\(row.item\);/);
});

test("writes Member's Mark as 山姆 and always shows the buy count", async () => {
  const { evaluate } = await runAppScript();
  const html = await readFile(new URL("../public/nutriflow.html", import.meta.url), "utf8");

  // 山姆自有品牌在小票上是「Member's Mark」，一行里光牌子就占掉小半行，品名被挤到
  // 第二行（用户："太长了，搞得每次都要换行"）。撇号有直的和弯的两种，都要认。
  assert.equal(evaluate(`shortBrand("Member's Mark 智利大西洋鲑鱼")`), "山姆 智利大西洋鲑鱼");
  assert.equal(evaluate('shortBrand("Member’s Mark 有机鸡蛋")'), "山姆 有机鸡蛋");
  assert.equal(evaluate('shortBrand("MEMBERS MARK 牛肉")'), "山姆 牛肉");
  assert.equal(evaluate('shortBrand("盒马日日鲜 冰鲜鸡小胸")'), "盒马日日鲜 冰鲜鸡小胸");
  // 存量也要换：只在录入时处理的话，已经记下的那些永远不变。
  assert.match(html, /const short = shortBrand\(row.item\);/);
  assert.match(html, /item: shortBrand\(item.name\),/);

  // 买过一次的也写「1 次」，省略掉右边那列就对不齐（用户："只买了一次的就写1次"）。
  const times = evaluate('categoryTotals("month", "").flatMap(group => group.items.map(item => item.times))');
  assert.ok(times.includes(1), "样本里应该有只买过一次的东西");
  assert.ok(!/item.times > 1/.test(html), "不该再按次数决定要不要显示「N 次」");
  assert.match(html, /\$\{item.spend.toFixed\(2\).replace\(\/\\.00\$\/, ""\)\} · \$\{item.times\} 次/);
});

test("folds the purchase history but leaves the add form open", async () => {
  const html = await readFile(new URL("../public/nutriflow.html", import.meta.url), "utf8");

  // 用户："采购历史没法折叠，其他都可以好像"。
  assert.match(html, /id="purchaseFold"/);
  assert.match(html, /const PURCHASE_FOLD_KEY = "nutriflow_purchase_folded";/);
  assert.match(html, /const box = document.getElementById\("purchaseHistory"\);\n  if \(box\) box.hidden = folded;/);
  // 记一次采购是最常用的入口，不再折叠（用户："直接展开采购的功能，不用折叠"）。
  assert.ok(!/<details class="buy-add"/.test(html), "记一次采购不该再是折叠的");
  assert.match(html, /<div class="buy-add" id="buyAddBox">/);
  // 说明小字删掉，元素留着当识别进度条用。
  assert.ok(!/可以一次多选，也可以连拍几张/.test(html), "说明小字该删掉");
  assert.ok(!/小票照片仅保存在这台设备/.test(html), "说明小字该删掉");
  assert.match(html, /<p class="buy-add-hint" hidden><\/p>/);
  assert.match(html, /hintEl.hidden = !text;/);
  // 折起来的时候搜索跳转要先展开，否则滚过去是一片空白。
  assert.match(html, /target.closest\("#purchaseHistory"\) && purchaseFolded\(\)/);

  // 整条标题行都能点开（用户："点区域任何一个地方都可以展开"）。监听必须挂在标题
  // 行上、不能同时挂按钮——按钮的点击会冒泡上来，挂两处会连点两次互相抵消。
  assert.match(html, /const head = btn.closest\("\.section-title"\) \|\| btn;/);
  assert.match(html, /head.addEventListener\("click"/);
  assert.ok(!/btn.addEventListener\("click", \(\) => \{\n    localStorage.setItem\(PURCHASE_FOLD_KEY/.test(html), "别在按钮上再挂一次");
  const css = html.split("<style>")[1].split("</style>")[0];
  assert.match(css, /\.section-title\.tappable\{[^}]*cursor:pointer/);
});

test("averages the unit price per category", async () => {
  const { evaluate, elements } = await runAppScript();
  const html = await readFile(new URL("../public/nutriflow.html", import.meta.url), "utf8");

  // 用户："对比下肉类、水产，等的平均单价，就是说这类别的均价"。
  const rows = evaluate("categoryUnitPrices()");
  assert.ok(rows.length > 1, "至少要能比出两类来");
  // 均价是「总金额 ÷ 总重量」，不是各食材单价的算术平均——后者会让 150g 的金针菇
  // 和 5kg 的米一样重，算出来没法判断这一类贵不贵。
  const meat = rows.find(row => row.name === "肉类");
  assert.ok(meat, `应该有肉类：${rows.map(row => row.name).join(" ")}`);
  const byHand = evaluate(`(() => {
    const rows = comparablePurchases().filter(entry => priceCategoryOf(entry.foodId) === "肉类");
    const spend = rows.reduce((sum, entry) => sum + entry.totalPrice, 0);
    const grams = rows.reduce((sum, entry) => sum + entry.grams, 0);
    return spend / (grams / 1000);
  })()`);
  assert.equal(Math.round(meat.perKilo * 100), Math.round(byHand * 100));
  // 贵的排前面。
  const prices = rows.map(row => row.perKilo);
  assert.deepEqual(prices, prices.slice().sort((a, b) => b - a));
  // 排在分类筛选之上，而且不跟着筛选走——横向比几类之间的贵贱才是它存在的意义。
  const avg = elements.get("priceCategoryAvg").innerHTML;
  assert.match(avg, /各类均价/);
  assert.match(avg, /元\/kg/);
  assert.ok(html.indexOf('id="priceCategoryAvg"') < html.indexOf('id="priceTabs"'));
  // 跟着单价对比一起折叠，否则收起来还剩半张卡片。
  assert.match(html, /\["priceNote", "priceCategoryAvg", "priceTabs", "priceCompare"\]/);
});

test("breaks the spend down by store and titles the overall donut", async () => {
  const { evaluate } = await runAppScript();
  const html = await readFile(new URL("../public/nutriflow.html", import.meta.url), "utf8");

  // 用户："采购统计也加一个在不同渠道的统计，fudi、盒马、山姆"。
  const stores = evaluate('storeTotals("month", "").map(entry => entry.name)');
  assert.ok(stores.length > 0);
  // 店名要收敛：同一家店有「盒马鲜生（大钟寺店）」「大钟寺店」好几种写法，不收敛
  // 一家店会摊成三家。
  assert.ok(stores.every(name => !/[（(]/.test(name)), `店名没收敛：${stores.join(" ")}`);
  assert.ok(stores.includes("盒马"), `应该有盒马：${stores.join(" ")}`);
  // 「趟」按「店 + 当天」算，一次买十样只算去了一趟，不能等于商品行数。
  const one = evaluate('storeTotals("month", "").find(entry => entry.name === "盒马")');
  assert.ok(one.trips > 0 && one.trips <= one.count);
  // 口径和分类统计一致：账单行和冰淇淋都不算，否则两处总额对不上。
  const byStore = evaluate('storeTotals("month", "").reduce((sum, entry) => sum + entry.spend, 0)');
  const byCat = evaluate('categoryTotals("month", "").reduce((sum, group) => sum + group.spend, 0)');
  assert.equal(Math.round(byStore * 100), Math.round(byCat * 100));
  // 跟着上面选的时间区间走。
  assert.match(html, /storeTotals\(spendMode, selectedPeriod\)/);
  // 折叠状态和分类共用一个 Set，key 用 __stores 免得和店名/类名撞。
  assert.match(html, /data-cat="__stores"/);

  // 第一张饼图要有标题（用户："第一张饼图上面加一个标题，TOTAL，之类的"）。
  assert.match(html, /<div class="cat-head static">/);
  assert.match(html, /📊 合计\$\{scopeLabel \? ` · \$\{scopeLabel\}` : ""\}/);
  assert.match(html, /box.innerHTML = overview \+ storeBlock \+ sections;/);
});

test("strips the brand even when it trails in half-width brackets", async () => {
  const { evaluate } = await runAppScript();

  // 「冰鲜 猪汤骨 (盒马日日鲜)」的品牌写在**末尾的半角括号**里。原来只剥全角括号，
  // 品牌留了下来，再取后 6 字正好把它截出来——chip 上只剩「盒马日日鲜)」，
  // 看不出买的是什么（用户："有一个只显示了盒马日日鲜，具体的菜是啥不知道"）。
  assert.equal(evaluate('shortItem("冰鲜 猪汤骨 (盒马日日鲜)")'), "冰鲜 猪汤骨");
  assert.equal(evaluate('shortItem("盒马日日鲜 油菜 (上海青)")'), "油菜");

  // 计划里的 chip 一个都不该带括号或品牌尾巴。
  // 牛奶酸奶是每天固定喝的，不用在计划里选（用户要求）。
  assert.ok(!evaluate("planIngredients().some(chip => /牛奶|酸奶/.test(chip.name))"));
  // 先菜后肉再其他——rank 必须是不降的，否则分区标签会重复出现。
  const ranks = evaluate("planIngredients().map(chip => chip.rank)");
  assert.deepEqual(ranks, ranks.slice().sort((a, b) => a - b));

  const names = evaluate("planIngredients().map(chip => chip.name)");
  assert.ok(names.length > 0);
  assert.ok(names.every(name => !/[（()）]/.test(name)), `chip 带括号：${names.join(" ")}`);
  assert.ok(names.every(name => !name.includes("盒马")), `chip 带品牌：${names.join(" ")}`);
});

test("bumps the offline cache when the app shell changes", async () => {
  const serviceWorker = await readFile(
    new URL("../public/sw.js", import.meta.url),
    "utf8",
  );

  assert.match(serviceWorker, /CACHE_NAME = "nutriflow-pwa-v131"/);
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

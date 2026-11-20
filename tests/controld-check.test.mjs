// ControlD Check 核心回歸測試（不需安裝套件）
// 執行：在 repo 根目錄 `node --test tests/*.mjs`（需 Node 22.18+，原生支援 import .ts）
// 這個資料夾不在 ControlDCheck/ 內，不會被 Scripting 遠端來源同步到 iPhone。
import { test, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { registerHooks } from "node:module"

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context)
    } catch (error) {
      if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) return next(`${specifier}.ts`, context)
      throw error
    }
  },
})
const cd = await import("../ControlDCheck/src/controld.ts")

// ── 模擬平台：Keychain、Storage、fetch ──

let keychain
let storage
let calls
let routes
let realFetch

const json = (status, body) => ({ status, text: async () => JSON.stringify(body) })

beforeEach(() => {
  keychain = new Map()
  storage = new Map()
  calls = []
  routes = []
  globalThis.Keychain = {
    get: (k) => (keychain.has(k) ? keychain.get(k) : null),
    set: (k, v) => { keychain.set(k, v); return true },
    remove: (k) => keychain.delete(k),
  }
  globalThis.Storage = {
    get: (k) => (storage.has(k) ? storage.get(k) : null),
    set: (k, v) => { storage.set(k, v); return true },
    remove: (k) => { storage.delete(k) },
  }
  realFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, headers: init.headers ?? {} })
    for (const [match, handler] of routes) {
      if (typeof match === "string" ? url.includes(match) : match.test(url)) return handler(url, init)
    }
    throw new Error(`沒有設定的網址：${url}`)
  }
})

afterEach(() => {
  globalThis.fetch = realFetch
  delete globalThis.Keychain
  delete globalThis.Storage
})

const TOKEN = "api.abcdefghijklmnop1234"
const NOW = Date.parse("2026-11-20T14:30:00Z") // 台灣 22:30

const DEVICES = {
  success: true,
  body: {
    devices: [
      { PK: "1", device_id: "router1", name: "家裡路由器", status: 1, stats: 2, last_activity: NOW / 1000 - 120,
        profile: { PK: "p1", name: "家庭" } },
      { PK: "2", device_id: "ipad1", name: "iPad", status: 1, stats: 2, last_activity: NOW / 1000 - 3 * 3600,
        profile: { PK: "p2", name: "小孩" }, profile2: { PK: "p1", name: "家庭" } },
      { PK: "3", device_id: "tv1", name: "電視", status: 2, stats: 0, last_activity: NOW / 1000 - 60,
        profile: { PK: "p1", name: "家庭" } },
      { PK: "4", device_id: "new1", name: "新端點", status: 0, stats: 1 },
    ],
  },
}

// 每種 action 的筆數：目前區間與前一期
const COUNTS = { 0: 1200, 1: 8600, 2: 150, 3: 50 }
const PREV = { 0: 1000, 1: 7000, 2: 0, 3: 0 }

function setupHappyPath({ verify = "ok" } = {}) {
  keychain.set("controld_token", TOKEN)
  routes.push(["api.controld.com/users", () => json(200, { success: true, body: { PK: "u1", stats_endpoint: "asia-southeast1-usr01" } })])
  routes.push(["api.controld.com/devices", () => json(200, DEVICES)])
  routes.push(["/v2/statistic/count/question", () => json(200, {
    success: true,
    body: { counts: [{ value: "ads.example.com", count: 300 }, { value: "track.example.net", count: 520 }, { value: "", count: 9 }] },
  })])
  routes.push(["/v2/statistic/count?", (url) => {
    const params = new URL(url).searchParams
    const action = Number(params.get("action[]"))
    const start = Date.parse(params.get("startTime"))
    const prev = start < cd.startOfTaipeiDay(NOW)
    return json(200, { success: true, body: { count: (prev ? PREV : COUNTS)[action], startTime: params.get("startTime") } })
  }])
  routes.push(["verify.controld.com", () => {
    if (verify === "ok") return json(404, { success: false })
    if (verify === "dns") throw new Error("A server with the specified hostname could not be found.")
    if (verify === "dns-zh") throw new Error("找不到具有所指定主機名稱的伺服器。")
    if (verify === "tls") throw new Error("An SSL error has occurred and a secure connection to the server cannot be made.")
    return new Promise(() => {}) // 永遠不回應 → 逾時
  }])
}

// ── 工具函式 ──

test("查詢字串：陣列展開、方括號與時間都會編碼", () => {
  assert.equal(cd.query({ "action[]": 0, startTime: "2026-11-20T00:00:00.000Z" }), "?action%5B%5D=0&startTime=2026-11-20T00%3A00%3A00.000Z")
  assert.equal(cd.query({ "endpointId[]": ["a", "b"], skip: undefined }), "?endpointId%5B%5D=a&endpointId%5B%5D=b")
  assert.equal(cd.query({}), "")
})

test("Token 去掉空白與 Bearer 前綴，格式不對回傳空字串", () => {
  assert.equal(cd.normalizeToken("  Bearer api.abcdefghijk  \n"), "api.abcdefghijk")
  assert.equal(cd.normalizeToken("abc"), "")
  assert.equal(cd.normalizeToken("has space inside token"), "")
  assert.equal(cd.normalizeToken(""), "")
})

test("統計區間：今天從台灣午夜起算，前一期對照昨天同時段", () => {
  const midnight = Date.parse("2026-11-20T16:00:00Z") // 台灣 11/21 00:00
  assert.equal(cd.startOfTaipeiDay(midnight - 1), Date.parse("2026-11-19T16:00:00Z"))
  assert.equal(cd.startOfTaipeiDay(midnight), midnight)

  const today = cd.rangeWindow("today", NOW)
  assert.equal(today.start, Date.parse("2026-11-19T16:00:00Z"))
  assert.equal(today.end, NOW)
  assert.deepEqual(cd.previousWindow("today", today), { start: today.start - cd.DAY, end: NOW - cd.DAY })

  const week = cd.rangeWindow("7d", NOW)
  assert.equal(week.end - week.start, 7 * cd.DAY)
  assert.deepEqual(cd.previousWindow("7d", week), { start: NOW - 14 * cd.DAY, end: NOW - 7 * cd.DAY })
})

test("小工具參數可用英文或中文指定區間", () => {
  assert.equal(cd.parseRange("today"), "today")
  assert.equal(cd.parseRange(" 今天 "), "today")
  assert.equal(cd.parseRange("24H"), "24h")
  assert.equal(cd.parseRange("7 天"), "7d")
  assert.equal(cd.parseRange("30d"), "30d")
  assert.equal(cd.parseRange(""), null)
  assert.equal(cd.parseRange(undefined), null)
  assert.equal(cd.parseRange("year"), null)
})

test("數字、比例、趨勢、相對時間的顯示格式", () => {
  assert.equal(cd.fmtCount(0), "0")
  assert.equal(cd.fmtCount(9999), "9,999")
  assert.equal(cd.fmtCount(10_000), "1 萬")
  assert.equal(cd.fmtCount(12_345), "1.2 萬")
  assert.equal(cd.fmtCount(1_234_567), "123 萬")
  assert.equal(cd.fmtCount(250_000_000), "2.5 億")

  assert.equal(cd.fmtPct(123, 1000), "12.3%")
  assert.equal(cd.fmtPct(1, 100_000), "<0.1%")
  assert.equal(cd.fmtPct(0, 0), "—")

  const c = (total) => ({ total, blocked: 0, bypassed: total, redirected: 0 })
  assert.deepEqual(cd.trendOf(c(1120), c(1000)), { text: "↑12%", dir: "up" })
  assert.deepEqual(cd.trendOf(c(950), c(1000)), { text: "↓5%", dir: "down" })
  assert.deepEqual(cd.trendOf(c(1002), c(1000)), { text: "持平", dir: "flat" })
  assert.equal(cd.trendOf(c(10), c(0)), null)
  assert.equal(cd.trendOf(null, c(10)), null)

  assert.equal(cd.fmtAgo(0, NOW), "沒有紀錄")
  assert.equal(cd.fmtAgo(NOW - 30_000, NOW), "剛剛")
  assert.equal(cd.fmtAgo(NOW - 5 * cd.MIN, NOW), "5 分鐘前")
  assert.equal(cd.fmtAgo(NOW - 3 * cd.HOUR, NOW), "3 小時前")
  assert.equal(cd.fmtAgo(NOW - 2 * cd.DAY, NOW), "2 天前")

  assert.equal(cd.fmtTime(NOW, NOW), "22:30")
  assert.equal(cd.fmtTime(NOW - cd.DAY, NOW), "11/19 22:30")
})

test("最後查詢時間支援 Unix 秒、毫秒、數字字串與 ISO", () => {
  const ms = Date.parse("2026-11-20T14:00:00Z")
  assert.equal(cd.toMillis(ms / 1000), ms)
  assert.equal(cd.toMillis(ms), ms)
  assert.equal(cd.toMillis(String(ms / 1000)), ms)
  assert.equal(cd.toMillis("2026-11-20T14:00:00Z"), ms)
  assert.equal(cd.toMillis(""), 0)
  assert.equal(cd.toMillis(null), 0)
  assert.equal(cd.toMillis("not a date"), 0)
})

test("端點解析、在線判斷與排序", () => {
  const devices = cd.parseDevices(DEVICES.body)
  assert.equal(devices.length, 4)
  const router = devices.find((d) => d.id === "router1")
  assert.equal(router.name, "家裡路由器")
  assert.equal(router.profile, "家庭")
  assert.equal(router.logging, 2)
  assert.equal(cd.isOnline(router, NOW), true)
  const ipad = devices.find((d) => d.id === "ipad1")
  assert.equal(ipad.profile2, "家庭")
  assert.equal(cd.isOnline(ipad, NOW), false)
  // 軟停用的端點即使剛有查詢也不算在線
  assert.equal(cd.isOnline(devices.find((d) => d.id === "tv1"), NOW), false)
  assert.equal(devices.find((d) => d.id === "new1").lastActivity, 0)

  assert.deepEqual(cd.sortDevices(devices, NOW).map((d) => d.id), ["router1", "tv1", "ipad1", "new1"])
  assert.deepEqual(cd.onlineCount(devices, NOW), { online: 1, total: 4 })
  assert.equal(cd.statusLabel(2), "軟停用")
  assert.equal(cd.statusLabel(1), "")
  assert.equal(cd.loggingLabel(0), "不記錄")
  assert.deepEqual(cd.parseDevices({}), [])
  assert.deepEqual(cd.parseDevices({ devices: [null, { name: "沒有 id" }] }), [])
})

test("統計主機：個人在 stats_endpoint，組織在 org.stats_endpoint", () => {
  assert.equal(cd.statsEndpointOf({ stats_endpoint: " us-east1-usr01 " }), "us-east1-usr01")
  assert.equal(cd.statsEndpointOf({ org: { stats_endpoint: "us-east1-org01" } }), "us-east1-org01")
  assert.equal(cd.statsEndpointOf({}), "")
  assert.equal(cd.analyticsBase("asia-southeast1-usr01"), "https://asia-southeast1-usr01.analytics.controld.com")
  assert.equal(cd.analyticsBase("europe.analytics.controld.com/"), "https://europe.analytics.controld.com")
  assert.equal(cd.analyticsBase("https://custom.example/"), "https://custom.example")
})

test("DNS 驗證：解析得到或憑證錯誤＝走 Control D；解析不到且 API 通＝沒走", () => {
  assert.equal(cd.classifyProbeError("timeout"), "failed")
  assert.equal(cd.classifyProbeError("An SSL error has occurred"), "tls")
  assert.equal(cd.classifyProbeError("此伺服器的憑證無效"), "tls")
  assert.equal(cd.classifyProbeError("找不到具有所指定主機名稱的伺服器。"), "dns")
  assert.equal(cd.verdictOf("responded", false), "yes")
  assert.equal(cd.verdictOf("tls", true), "yes")
  assert.equal(cd.verdictOf("dns", true), "no")
  assert.equal(cd.verdictOf("dns", false), "unknown")
  assert.equal(cd.verdictOf("failed", true), "unknown")
})

test("網域排行依筆數排序並略過空白值", () => {
  assert.deepEqual(cd.parseRank({ counts: [{ value: "a.com", count: 1 }, { value: "b.com", count: 5 }, { value: "", count: 9 }] }),
    [{ value: "b.com", count: 5 }, { value: "a.com", count: 1 }])
  assert.deepEqual(cd.parseRank({ items: [{ question: "c.com", count: "3" }] }), [{ value: "c.com", count: 3 }])
  assert.deepEqual(cd.parseRank(null), [])
})

// ── 讀取流程 ──

test("沒有 Token 時不送出任何請求", async () => {
  const snap = await cd.loadSnapshot({ now: NOW })
  assert.equal(snap.errorCode, "NO_TOKEN")
  assert.equal(calls.length, 0)
})

test("完整讀取：統計、前期比較、端點、網域排行、DNS 驗證", async () => {
  setupHappyPath()
  const snap = await cd.loadSnapshot({ now: NOW, top: true })
  assert.equal(snap.error, "")
  assert.deepEqual(snap.stats, { total: 10_000, blocked: 1200, bypassed: 8600, redirected: 200 })
  assert.deepEqual(snap.prev, { total: 8000, blocked: 1000, bypassed: 7000, redirected: 0 })
  assert.deepEqual(cd.trendOf(snap.stats, snap.prev), { text: "↑25%", dir: "up" })
  assert.deepEqual(snap.top.map((r) => r.value), ["track.example.net", "ads.example.com"])
  assert.equal(snap.devices.length, 4)
  assert.equal(snap.verify, "yes")
  assert.equal(snap.stale, false)

  // 統計請求：帶 Bearer Token、打到帳號的統計主機、四種 action 各一次（目前＋前一期）
  const countCalls = calls.filter((c) => c.url.includes("/v2/statistic/count?"))
  assert.equal(countCalls.length, 8)
  for (const c of countCalls) {
    assert.ok(c.url.startsWith("https://asia-southeast1-usr01.analytics.controld.com/v2/statistic/count?"))
    assert.equal(c.headers.Authorization, `Bearer ${TOKEN}`)
  }
  assert.deepEqual([...new Set(countCalls.map((c) => new URL(c.url).searchParams.get("action[]")))].sort(), ["0", "1", "2", "3"])
  const deviceCall = calls.find((c) => c.url.includes("/devices"))
  assert.equal(deviceCall.url, "https://api.controld.com/devices?last_activity=1")
  // verify 探測不帶 Token
  for (const c of calls.filter((c) => c.url.includes("verify.controld.com"))) assert.equal(c.headers.Authorization, undefined)

  // 第二次：統計主機與前一期都用快取，不再查 /users 也不重查前一期
  calls = []
  await cd.loadSnapshot({ now: NOW + 5 * cd.MIN, top: false })
  assert.equal(calls.filter((c) => c.url.includes("/users")).length, 0)
  assert.equal(calls.filter((c) => c.url.includes("/v2/statistic/count?")).length, 4)
  assert.equal(calls.filter((c) => c.url.includes("count/question")).length, 0)
})

test("DNS 解析不到 verify 網域（英文或中文錯誤訊息）＝沒走 Control D", async () => {
  for (const verify of ["dns", "dns-zh"]) {
    keychain.clear(); storage.clear(); routes = []
    setupHappyPath({ verify })
    const snap = await cd.loadSnapshot({ now: NOW })
    assert.equal(snap.verify, "no", verify)
  }
})

test("verify 網域憑證錯誤仍代表 DNS 走 Control D", async () => {
  setupHappyPath({ verify: "tls" })
  const snap = await cd.loadSnapshot({ now: NOW })
  assert.equal(snap.verify, "yes")
})

test("Token 無效：端點回 401 時顯示錯誤", async () => {
  keychain.set("controld_token", TOKEN)
  routes.push(["api.controld.com", () => json(401, { success: false, error: { message: "Unauthorized" } })])
  routes.push(["verify.controld.com", () => json(200, {})])
  const snap = await cd.loadSnapshot({ now: NOW })
  assert.equal(snap.errorCode, "AUTH")
  assert.equal(snap.error, "API Token 無效或權限不足")
})

test("統計主機拒絕 Token 時，端點照常顯示並說明原因", async () => {
  setupHappyPath()
  routes.unshift(["analytics.controld.com", () => json(401, { success: false })])
  const snap = await cd.loadSnapshot({ now: NOW })
  assert.equal(snap.error, "")
  assert.equal(snap.stats, null)
  assert.equal(snap.statsError, "這把 API Token 無法讀取統計")
  assert.equal(snap.devices.length, 4)
})

test("API 錯誤訊息會帶進說明", async () => {
  setupHappyPath()
  routes.unshift(["api.controld.com/devices", () => json(500, { success: false, error: { message: "Maintenance" } })])
  const snap = await cd.loadSnapshot({ now: NOW })
  assert.equal(snap.devices, null)
  assert.equal(snap.devicesError, "讀取端點失敗：Maintenance")
  assert.ok(snap.stats)
})

test("斷線時沿用同區間的快取並標示離線資料", async () => {
  setupHappyPath()
  const first = await cd.loadSnapshot({ now: NOW, top: true })
  assert.ok(first.stats)

  routes = [[/./, () => { throw new Error("The Internet connection appears to be offline.") }]]
  const later = NOW + 10 * cd.MIN
  const snap = await cd.loadSnapshot({ now: later, top: true })
  assert.equal(snap.error, "")
  assert.equal(snap.stale, true)
  assert.deepEqual(snap.stats, first.stats)
  assert.equal(snap.devices.length, 4)
  assert.equal(snap.fetchedAt, NOW)
  assert.equal(snap.verify, "unknown")

  // 換日後「今天」的舊統計不沿用
  const tomorrow = await cd.loadSnapshot({ now: NOW + cd.DAY, top: true })
  assert.equal(tomorrow.stats, null)
  assert.equal(tomorrow.stale, true) // 端點仍沿用快取
})

test("完全沒有快取又斷線：顯示網路錯誤", async () => {
  keychain.set("controld_token", TOKEN)
  routes = [[/./, () => { throw new Error("offline") }]]
  const snap = await cd.loadSnapshot({ now: NOW })
  assert.equal(snap.errorCode, "NETWORK")
  assert.equal(snap.error, "網路連線失敗")
})

test("小工具逾時：有快取顯示快取，沒有就顯示錯誤", async () => {
  keychain.set("controld_token", TOKEN)
  const empty = cd.fallbackSnapshot(undefined, NOW)
  assert.equal(empty.error, "連線逾時")

  setupHappyPath()
  await cd.loadSnapshot({ now: NOW })
  const snap = cd.fallbackSnapshot("today", NOW + cd.MIN)
  assert.equal(snap.stale, true)
  assert.ok(snap.stats)
})

test("換 Token 會清掉舊帳號的快取；清除全部會刪掉 Token 與設定", async () => {
  setupHappyPath()
  cd.saveSettings({ range: "7d" })
  await cd.loadSnapshot({ now: NOW })
  assert.ok(storage.has("controld_snapshot_v1"))
  assert.ok(storage.has("controld_user_v1"))

  assert.equal(cd.saveToken("bad"), false)
  assert.ok(storage.has("controld_snapshot_v1"))
  assert.equal(cd.saveToken("Bearer api.newtoken123456"), true)
  assert.equal(keychain.get("controld_token"), "api.newtoken123456")
  assert.ok(!storage.has("controld_snapshot_v1"))
  assert.ok(!storage.has("controld_user_v1"))
  assert.equal(cd.getSettings().range, "7d")

  cd.clearAll()
  assert.equal(cd.hasToken(), false)
  assert.equal(cd.getSettings().range, "today")
})

test("所有端點都不記錄時提示開啟分析紀錄", () => {
  const snap = { devices: cd.parseDevices({ devices: [{ device_id: "a", stats: 0 }, { device_id: "b", stats: 0 }] }) }
  assert.equal(cd.loggingDisabled(snap), true)
  assert.equal(cd.loggingDisabled({ devices: cd.parseDevices(DEVICES.body) }), false)
  assert.equal(cd.loggingDisabled({ devices: [] }), false)
})

test("更新排程：沒 Token 或 Token 無效時拉長間隔", () => {
  assert.equal(cd.nextReload({ errorCode: "" }, NOW), NOW + cd.RELOAD_EVERY)
  assert.equal(cd.nextReload({ errorCode: "NO_TOKEN" }, NOW), NOW + 6 * cd.HOUR)
  assert.equal(cd.nextReload({ errorCode: "NETWORK" }, NOW), NOW + cd.RELOAD_EVERY)
})

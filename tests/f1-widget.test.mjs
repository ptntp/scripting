// F1 Widget 資料層回歸測試（只測行為，不需安裝任何套件）
// 執行：在 repo 根目錄 `node --test tests/`（需 Node 22.18+，原生支援 import .ts）
// 這個資料夾不在 f1-widget/ 內，不會被 Scripting 遠端來源同步到 iPhone。
import { test, afterEach } from "node:test"
import assert from "node:assert/strict"
import * as f1 from "../f1-widget/f1.ts"

const H = 3600e3
const T = iso => Date.parse(iso)

// ── 隔離的平台環境：固定時鐘、記憶體 Storage、記錄請求的 fetch ──
// 替換前先保存原本的屬性描述（含「原本不存在」），每個案例結束後（不論成敗）原樣還原。
const NATIVE_FETCH = globalThis.fetch // 用來驗證還原的是同一個函式
const NATIVE_NOW = Date.now
let snapshot = null

function snapshotGlobals() {
  if (snapshot) return
  snapshot = [
    [Date, "now", Object.getOwnPropertyDescriptor(Date, "now")],
    [globalThis, "Storage", Object.getOwnPropertyDescriptor(globalThis, "Storage")],
    [globalThis, "fetch", Object.getOwnPropertyDescriptor(globalThis, "fetch")],
  ]
}

function restoreGlobals() {
  if (!snapshot) return
  for (const [obj, key, desc] of snapshot) {
    if (desc) Object.defineProperty(obj, key, desc)
    else delete obj[key] // 原本不存在的屬性才刪除
  }
  snapshot = null
}

const stub = (obj, key, value) => Object.defineProperty(obj, key, { value, writable: true, configurable: true, enumerable: true })

let calls = []
function setup({ now, route = () => { throw new TypeError("offline") } }) {
  snapshotGlobals()
  const clock = { t: T(now) }
  stub(Date, "now", () => clock.t)
  const store = new Map() // 每個案例都是全新的記憶體 Storage
  stub(globalThis, "Storage", {
    get: k => (store.has(k) ? structuredClone(store.get(k)) : null),
    set: (k, v) => (store.set(k, structuredClone(v)), true),
    remove: k => store.delete(k),
    contains: k => store.has(k),
    keys: () => [...store.keys()],
  })
  calls = []
  stub(globalThis, "fetch", async url => {
    calls.push(url)
    const body = route(url)
    return { ok: true, status: 200, json: async () => body }
  })
  return {
    clock,
    setRoute: r => (route = r),
    advance: ms => (clock.t += ms),
  }
}
afterEach(restoreGlobals)

const circuit = { circuitId: "albert_park", circuitName: "Albert Park", Location: { locality: "Melbourne", country: "Australia", lat: "-37.8", long: "144.9" } }

/** 只有日期、沒有時間的正賽（API 尚未公布開跑時間） */
const tbcRace = () => f1.parseRace({ season: "2027", round: "1", raceName: "Australian Grand Prix", date: "2027-03-07", Circuit: circuit })

/** 一般週末：FP1 週五 01:30Z、排位週六 05:00Z、正賽週日 04:00Z */
const timedRace = () =>
  f1.parseRace({
    season: "2027", round: "1", raceName: "Australian Grand Prix", date: "2027-03-07", time: "04:00:00Z", Circuit: circuit,
    FirstPractice: { date: "2027-03-05", time: "01:30:00Z" },
    Qualifying: { date: "2027-03-06", time: "05:00:00Z" },
  })

// ─────────────────────────────────────────────
// 時間待定
// ─────────────────────────────────────────────

test("時間待定的正賽：不會被判成進行中，也不會觸發正賽結果", () => {
  const race = tbcRace()
  const rs = race.sessions.find(s => s.key === "race")
  assert.equal(rs.hasTime, false)
  // parseRace 內部的暫代結束時間仍是 14:00（舊快取也是），有效截止要以 UTC 日期結束為準
  assert.equal(rs.end, T("2027-03-07T14:00:00Z"))
  assert.equal(f1.sessionEnd(rs), T("2027-03-08T00:00:00Z"))
  for (const iso of ["2027-03-07T12:15:00Z", "2027-03-07T14:01:00Z"]) {
    const st = f1.computeState([race], T(iso))
    assert.ok(st.race && st.next, iso)
    assert.equal(st.live, false, iso)
    assert.equal(st.lastRace, null, iso)
    assert.equal(st.showResult, false, iso)
  }
})

test("時間待定的正賽：過了 UTC 日期結束才換下一站，重新整理排在有效截止", () => {
  const race = tbcRace()
  const st = f1.computeState([race], T("2027-03-08T00:00:00Z"))
  assert.equal(st.race, null)
  assert.equal(st.showResult, false)
  const before = T("2027-03-07T23:50:00Z")
  const reload = f1.nextReloadDate(f1.computeState([race], before), before, false)
  assert.equal(reload.toISOString(), "2027-03-08T00:00:05.000Z")
})

/** 同一天：FP1 時間待定、FP2 13:00Z 已知時間；正賽 3/7 04:00Z */
const mixedRace = () =>
  f1.parseRace({
    season: "2027", round: "1", raceName: "Australian Grand Prix", date: "2027-03-07", time: "04:00:00Z", Circuit: circuit,
    FirstPractice: { date: "2027-03-05" },
    SecondPractice: { date: "2027-03-05", time: "13:00:00Z" },
  })

test("混合節次：待定的 FP1 不會遮住同一天正在進行的 FP2", () => {
  const race = mixedRace()
  let st = f1.computeState([race], T("2027-03-05T12:15:00Z"))
  assert.equal(st.next.key, "fp1", "FP2 開跑前仍是待定的 FP1")
  assert.equal(st.live, false)
  st = f1.computeState([race], T("2027-03-05T13:30:00Z"))
  assert.equal(st.next.key, "fp2")
  assert.equal(st.live, true)
})

test("混合節次：FP2 結束後前進到正賽，不回到待定的 FP1", () => {
  const race = mixedRace()
  const st = f1.computeState([race], T("2027-03-05T14:30:00Z"))
  assert.equal(st.next.key, "race")
  assert.equal(st.live, false)
  // 待定 FP1 的截止提早到 FP2 開跑
  const fp1 = race.sessions.find(s => s.key === "fp1")
  assert.equal(f1.sessionCutoff(race, fp1), T("2027-03-05T13:00:00Z"))
  // 重新整理：FP2 開跑前排在開跑那一刻；也不會為待定 FP1 暫代的中午排程（否則會是 12:00:05）
  const reloadAt = iso => f1.nextReloadDate(f1.computeState([race], T(iso)), T(iso), false).toISOString()
  assert.equal(reloadAt("2027-03-05T12:50:00Z"), "2027-03-05T13:00:05.000Z")
  assert.equal(reloadAt("2027-03-05T11:55:00Z"), "2027-03-05T12:10:05.000Z")
})

test("時間待定的節次顯示「待定」", () => {
  const rs = tbcRace().sessions[0]
  assert.equal(f1.fmtSessionTime(rs, "zh"), "待定")
  assert.equal(f1.fmtSessionTime(rs, "en"), "TBC")
})

// ─────────────────────────────────────────────
// 已知時間的節次
// ─────────────────────────────────────────────

test("已知時間的節次：開始前不算、開始瞬間算、結束瞬間不算", () => {
  const fp1 = timedRace().sessions[0]
  assert.equal(f1.isSessionLive(fp1, fp1.start - 1), false)
  assert.equal(f1.isSessionLive(fp1, fp1.start), true)
  assert.equal(f1.isSessionLive(fp1, fp1.end - 1), true)
  assert.equal(f1.isSessionLive(fp1, fp1.end), false)
})

test("一般週末的下一節轉換不變", () => {
  const race = timedRace()
  const [fp1, quali] = race.sessions
  assert.equal(f1.computeState([race], fp1.start - H).next.key, "fp1")
  assert.equal(f1.computeState([race], fp1.start + 10 * 60e3).live, true)
  assert.equal(f1.computeState([race], fp1.end).next.key, "quali")
  assert.equal(f1.computeState([race], quali.end).next.key, "race")
})

test("正賽結果視窗：開跑 +2 小時進入、+30 小時仍在、超過離開", () => {
  const race = timedRace()
  assert.equal(f1.computeState([race], race.raceStart + 2 * H - 1).showResult, false)
  assert.equal(f1.computeState([race], race.raceStart + 2 * H).showResult, true)
  assert.equal(f1.computeState([race], race.raceStart + 30 * H).showResult, true)
  assert.equal(f1.computeState([race], race.raceStart + 30 * H + 1).showResult, false)
})

test("衝刺排位：SprintQualifying / SprintShootout 各解析成一個 sq，同時存在也不重複", () => {
  const base = { season: "2024", round: "5", raceName: "Chinese Grand Prix", date: "2024-04-21", time: "07:00:00Z", Circuit: circuit }
  const sq = { date: "2024-04-19", time: "07:30:00Z" }
  const count = r => f1.parseRace(r).sessions.filter(s => s.key === "sq").length
  assert.equal(count({ ...base, SprintQualifying: sq }), 1)
  assert.equal(count({ ...base, SprintShootout: sq }), 1)
  assert.equal(count({ ...base, SprintQualifying: sq, SprintShootout: sq }), 1)
})

// ─────────────────────────────────────────────
// 季末判斷
// ─────────────────────────────────────────────

test("季末：空賽程、仍有時間待定的正賽都不算季末", () => {
  const race = timedRace()
  const after = race.raceStart + 3 * H
  assert.equal(f1.isSeasonOver([], after), false)
  assert.equal(f1.isSeasonOver([race], race.raceStart), false)
  assert.equal(f1.isSeasonOver([race], after), true)
  assert.equal(f1.isSeasonOver([race, tbcRace()], T("2027-03-07T23:00:00Z")), false)
})

// ─────────────────────────────────────────────
// 正賽結果快取
// ─────────────────────────────────────────────

const resultsBody = (round, rows) => ({
  MRData: {
    RaceTable: {
      Races: [{
        season: "2026", round: String(round), raceName: "São Paulo Grand Prix",
        Circuit: { Location: { country: "Brazil" } },
        Results: rows.map((code, i) => ({
          position: String(i + 1), positionText: String(i + 1), status: "Finished",
          Driver: { code, familyName: code }, Constructor: { constructorId: "ferrari", name: "Ferrari" },
          Time: { time: "1:32:47.318" },
        })),
      }],
    },
  },
})

test("正賽結果：同一站但名次還是空的，每 10 分鐘重試，出爐後快取 12 小時", async () => {
  const env = setup({ now: "2026-11-09T02:00:00Z", route: () => resultsBody(21, []) })
  const expected = { season: 2026, round: 21 }

  let r = await f1.loadLastResult(expected)
  assert.equal(r.data.rows.length, 0)
  assert.equal(calls.length, 1)

  env.advance(9 * 60e3)
  await f1.loadLastResult(expected)
  assert.equal(calls.length, 1, "10 分鐘內不重抓")

  env.setRoute(() => resultsBody(21, ["ANT"]))
  env.advance(2 * 60e3) // 第 11 分鐘
  r = await f1.loadLastResult(expected)
  assert.equal(calls.length, 2)
  assert.equal(r.data.rows.length, 1)

  env.advance(11 * 60e3)
  r = await f1.loadLastResult(expected)
  assert.equal(calls.length, 2, "出爐後沿用快取")
  assert.equal(r.data.rows[0].code, "ANT")

  env.advance(12 * H)
  await f1.loadLastResult(expected)
  assert.equal(calls.length, 3, "12 小時後重抓")
})

test("正賽結果：上一站的結果只享有 10 分鐘快取", async () => {
  const env = setup({ now: "2026-11-09T02:00:00Z", route: () => resultsBody(20, ["VER"]) })
  const expected = { season: 2026, round: 21 }
  await f1.loadLastResult(expected)
  env.advance(9 * 60e3)
  await f1.loadLastResult(expected)
  assert.equal(calls.length, 1)
  env.advance(2 * 60e3)
  await f1.loadLastResult(expected)
  assert.equal(calls.length, 2)
})

test("正賽結果：斷網時沿用舊快取並標示離線", async () => {
  const env = setup({ now: "2026-11-09T02:00:00Z", route: () => resultsBody(21, ["ANT"]) })
  const expected = { season: 2026, round: 21 }
  await f1.loadLastResult(expected)
  env.advance(13 * H)
  env.setRoute(() => { throw new TypeError("offline") })
  const r = await f1.loadLastResult(expected)
  assert.equal(r.stale, true)
  assert.equal(r.data.rows[0].code, "ANT")
})

// ─────────────────────────────────────────────
// 天氣
// ─────────────────────────────────────────────

test("天氣：時間待定的節次不配對預報", async () => {
  const race = tbcRace()
  setup({
    now: "2027-03-01T00:00:00Z",
    route: () => ({
      hourly: {
        time: Array.from({ length: 48 }, (_, i) => T("2027-03-06T00:00:00Z") / 1000 + i * 3600),
        temperature_2m: Array(48).fill(20),
        precipitation_probability: Array(48).fill(10),
        weather_code: Array(48).fill(0),
        is_day: Array(48).fill(1),
      },
    }),
  })
  const w = await f1.loadWeather(race, 3 * H)
  assert.equal(w.data.sessions.length, 0)
})

// ─────────────────────────────────────────────
// 參數
// ─────────────────────────────────────────────

test("Widget 參數：關鍵字、JSON、加引號的字串", () => {
  assert.deepEqual(f1.parseConfig(""), { mode: "auto", lang: "zh" })
  assert.deepEqual(f1.parseConfig("teams en"), { mode: "teams", lang: "en" })
  assert.deepEqual(f1.parseConfig("賽程"), { mode: "schedule", lang: "zh" })
  assert.deepEqual(f1.parseConfig('{"mode":"drivers","lang":"en"}'), { mode: "drivers", lang: "en" })
  assert.deepEqual(f1.parseConfig('"teams"'), { mode: "teams", lang: "zh" })
  assert.deepEqual(f1.parseConfig("{bad"), { mode: "auto", lang: "zh" })
})

// ─────────────────────────────────────────────
// 測試隔離
// ─────────────────────────────────────────────

test("測試隔離：原本存在的 fetch / Storage 與時鐘還原成同一個物件", () => {
  const original = { marker: "user storage" }
  stub(globalThis, "Storage", original) // 模擬原本就存在的 Storage
  try {
    setup({ now: "2027-01-01T00:00:00Z" })
    assert.notEqual(globalThis.fetch, NATIVE_FETCH)
    assert.notEqual(globalThis.Storage, original)
    restoreGlobals()
    assert.equal(globalThis.Storage, original)
    assert.equal(globalThis.fetch, NATIVE_FETCH)
    assert.equal(Date.now, NATIVE_NOW)
  } finally {
    delete globalThis.Storage
  }
})

test("測試隔離：原本不存在的 Storage 清理後不殘留", () => {
  assert.equal("Storage" in globalThis, false)
  setup({ now: "2027-01-01T00:00:00Z" })
  assert.equal("Storage" in globalThis, true)
  restoreGlobals()
  assert.equal("Storage" in globalThis, false)
})

test("測試隔離：前一個案例的替身不會留到下一個案例（由 afterEach 還原）", () => {
  // 上一個案例與更早的案例都呼叫過 setup，這裡應看到原生環境
  assert.equal(globalThis.fetch, NATIVE_FETCH)
  assert.equal(Date.now, NATIVE_NOW)
  assert.equal("Storage" in globalThis, false)
})

test("測試隔離：案例失敗時 afterEach 仍會還原（此案例先替換再驗證）", () => {
  setup({ now: "2027-01-01T00:00:00Z" })
  assert.equal(typeof globalThis.Storage.get, "function")
  // 不手動還原，交給 afterEach；下一個案例驗證
})

test("測試隔離：上一個案例未手動還原，這裡仍是原生環境", () => {
  assert.equal(globalThis.fetch, NATIVE_FETCH)
  assert.equal(Date.now, NATIVE_NOW)
  assert.equal("Storage" in globalThis, false)
})

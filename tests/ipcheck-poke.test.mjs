// IPCheck Poke 通知回歸測試（只測行為，不需安裝任何套件）
// 執行：在 repo 根目錄 `node --test tests/*.test.mjs`（需 Node 22.18+，原生支援 import .ts）
// 這個資料夾不在 IPCheck/ 內，不會被 Scripting 遠端來源同步到 iPhone。
import { test, afterEach } from "node:test"
import assert from "node:assert/strict"
import * as poke from "../IPCheck/utils/poke.ts"

const KEY = "sk-test-SECRET-1234567890"
const NAMES = ["Keychain", "Storage", "fetch"]
let saved = null
let calls = []
let logs = []
const nativeLog = console.log

function setup({ key = null, lastIP = null, respond = () => ({ status: 200, body: { success: true, message: "Message sent successfully" } }) } = {}) {
  saved = NAMES.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)])
  const keychain = new Map(key ? [[poke.POKE_KEY_KEYCHAIN, key]] : [])
  const storage = new Map(lastIP ? [[poke.POKE_LAST_IP_KEY, lastIP]] : [])
  const define = (name, value) => Object.defineProperty(globalThis, name, { value, writable: true, configurable: true })
  define("Keychain", {
    get: k => keychain.get(k) ?? null,
    set: (k, v, options) => { keychain.set(k, v); keychain.options = options; return true },
    remove: k => keychain.delete(k),
    _map: keychain,
  })
  define("Storage", {
    get: (k, options) => { assert.equal(options?.shared, true); return storage.get(k) ?? null },
    set: (k, v, options) => { assert.equal(options?.shared, true); storage.set(k, v); return true },
    _map: storage,
  })
  calls = []
  define("fetch", async (url, init) => {
    calls.push({ url, init })
    const { status, body } = respond(url, init)
    return { status, ok: status >= 200 && status < 300, json: async () => body }
  })
  logs = []
  console.log = (...args) => logs.push(args.map(String).join(" "))
  return { keychain, storage }
}

afterEach(() => {
  console.log = nativeLog
  if (!saved) return
  for (const [name, desc] of saved) {
    if (desc) Object.defineProperty(globalThis, name, desc)
    else delete globalThis[name]
  }
  saved = null
})

const SNAP = {
  version: 1, savedAt: 0, ip: "203.0.113.9", country: "台灣", countryCode: "TW", regionName: "台北市", city: "台北市",
  isp: "Chunghwa Telecom", org: "HiNet", as: "AS3462 Chunghwa Telecom", lat: 25.03, lon: 121.56,
  risk: 12, riskSource: "proxycheck", accessType: "家寬", vpnStatus: "未標記",
}

test("decidePoke：基準、未變更、未設定 Key、需要通知", () => {
  assert.equal(poke.decidePoke(true, null, ""), "skip")
  assert.equal(poke.decidePoke(true, null, "1.1.1.1"), "baseline")
  assert.equal(poke.decidePoke(true, "2001:db8::1", "2001:DB8::1"), "same")
  assert.equal(poke.decidePoke(false, "1.1.1.1", "8.8.8.8"), "no-key")
  assert.equal(poke.decidePoke(true, "1.1.1.1", "8.8.8.8"), "send")
})

test("訊息：舊新 IP、去重的位置、網路、風險，且不含經緯度", () => {
  const at = Date.UTC(2026, 10, 11, 3, 20)
  const message = poke.buildPokeMessage("198.51.100.1", SNAP, "shortcut", at)
  assert.match(message, /^\[IP 檢測\] 出口 IP 已變更/)
  assert.match(message, /舊：198\.51\.100\.1/)
  assert.match(message, /新：203\.0\.113\.9/)
  assert.match(message, /位置：台灣 · 台北市\n/) // 地區與城市相同只顯示一次
  assert.match(message, /網路：Chunghwa Telecom（AS3462）/)
  assert.match(message, /屬性：家寬 · 風險 12%（proxycheck）/)
  assert.match(message, /捷徑背景檢測/)
  const payload = poke.buildPokePayload("198.51.100.1", SNAP, "app", at)
  assert.equal(payload.event, "ip_changed")
  assert.equal(payload.current.ip, "203.0.113.9")
  assert.ok(!JSON.stringify(payload).includes("121.56"), "不應帶出經緯度")
})

test("訊息：缺欄位時不留空行或空標籤", () => {
  const bare = { ...SNAP, country: "", regionName: "", city: "", isp: "", org: "", as: "", risk: null, riskSource: null, accessType: "", vpnStatus: "未知" }
  const message = poke.buildPokeMessage("198.51.100.1", bare, "app", 0)
  assert.ok(!/位置|網路|屬性|標記/.test(message))
  assert.ok(!message.includes("\n\n"))
})

test("第一次執行只記錄基準，不傳送", async () => {
  const { storage } = setup({ key: KEY })
  const result = await poke.notifyPokeIfChanged(SNAP, "app")
  assert.equal(result.decision, "baseline")
  assert.equal(calls.length, 0)
  assert.equal(storage.get(poke.POKE_LAST_IP_KEY), SNAP.ip)
})

test("IP 變更時傳送一次 Bearer 請求，成功後更新基準", async () => {
  const { storage } = setup({ key: KEY, lastIP: "198.51.100.1" })
  const result = await poke.notifyPokeIfChanged(SNAP, "shortcut")
  assert.equal(result.sent, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, poke.POKE_ENDPOINT)
  assert.equal(calls[0].init.method, "POST")
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${KEY}`)
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.previousIP, "198.51.100.1")
  assert.ok(!calls[0].init.body.includes(KEY), "Key 不應出現在 body")
  assert.equal(storage.get(poke.POKE_LAST_IP_KEY), SNAP.ip)
})

test("IP 未變更時不傳送", async () => {
  setup({ key: KEY, lastIP: SNAP.ip })
  const result = await poke.notifyPokeIfChanged(SNAP, "app")
  assert.equal(result.decision, "same")
  assert.equal(calls.length, 0)
})

test("未設定 Key：不傳送但更新基準，之後設定 Key 不會補發過時通知", async () => {
  const { storage } = setup({ lastIP: "198.51.100.1" })
  const result = await poke.notifyPokeIfChanged(SNAP, "app")
  assert.equal(result.decision, "no-key")
  assert.equal(calls.length, 0)
  assert.equal(storage.get(poke.POKE_LAST_IP_KEY), SNAP.ip)
})

test("401 / 網路錯誤：保留舊基準下次重試，且日誌與摘要不含 Key", async () => {
  const { storage } = setup({ key: KEY, lastIP: "198.51.100.1", respond: () => ({ status: 401, body: {} }) })
  const result = await poke.notifyPokeIfChanged(SNAP, "app")
  assert.equal(result.sent, false)
  assert.match(result.summary, /API Key 無效/)
  assert.equal(storage.get(poke.POKE_LAST_IP_KEY), "198.51.100.1")
  assert.ok(![result.summary, ...logs].some(line => line.includes(KEY)))

  globalThis.fetch = async () => { throw new Error(`boom Bearer ${KEY}`) }
  const offline = await poke.notifyPokeIfChanged(SNAP, "app")
  assert.equal(offline.sent, false)
  assert.ok(![offline.summary, ...logs].some(line => line.includes(KEY)))
})

test("success 不是 true 時視為失敗", async () => {
  setup({ key: KEY, lastIP: "198.51.100.1", respond: () => ({ status: 200, body: { success: false } }) })
  const result = await poke.notifyPokeIfChanged(SNAP, "app")
  assert.equal(result.sent, false)
})

test("Key 存入鑰匙圈：去掉 Bearer 前綴與空白、背景可讀，空字串等於移除", () => {
  const { keychain } = setup()
  assert.equal(poke.hasPokeKey(), false)
  assert.equal(poke.setPokeKey(`  Bearer ${KEY}\n`), true)
  assert.equal(poke.getPokeKey(), KEY)
  assert.equal(keychain.options.accessibility, "first_unlock")
  poke.setPokeKey("   ")
  assert.equal(poke.hasPokeKey(), false)
})

test("sendPokeTest：沒有 Key 時不發請求", async () => {
  setup()
  const result = await poke.sendPokeTest()
  assert.equal(result.ok, false)
  assert.equal(calls.length, 0)
})

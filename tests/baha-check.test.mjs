// Baha Check 核心回歸測試（不需安裝套件）
// 執行：在 repo 根目錄 `node --test tests/`（需 Node 22.18+，原生支援 import .ts）
// 這個資料夾不在 BahaCheck/ 內，不會被 Scripting 遠端來源同步到 iPhone。
import { test, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { createHash, createHmac } from "node:crypto"
import { registerHooks } from "node:module"

// Scripting 的 import 不寫副檔名（./baha），Node 需要補上 .ts 才找得到。
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
const baha = await import("../BahaCheck/src/baha.ts")
const extras = await import("../BahaCheck/src/extras.ts")

const enc = (s) => new TextEncoder().encode(s)
const hex = (bytes) => Buffer.from(bytes).toString("hex")

// ── 演算法 ──

test("SHA-1 與 HMAC-SHA1 符合標準向量", () => {
  assert.equal(hex(baha.sha1(enc("abc"))), "a9993e364706816aba3e25717850c26c9cd0d89d")
  assert.equal(hex(baha.sha1(enc(""))), "da39a3ee5e6b4b0d3255bfef95601890afd80709")
  // 各種長度（含 55、56、64 的補位邊界）與 node:crypto 對照
  for (let n = 0; n <= 200; n++) {
    const msg = Uint8Array.from({ length: n }, (_, i) => (i * 31 + n) & 0xff)
    assert.equal(hex(baha.sha1(msg)), createHash("sha1").update(msg).digest("hex"), `sha1 長度 ${n}`)
    const key = msg.slice(0, n % 90)
    assert.equal(hex(baha.hmacSha1(key, msg)), createHmac("sha1", key).update(msg).digest("hex"), `hmac 長度 ${n}`)
  }
  // RFC 2202 test case 2
  assert.equal(hex(baha.hmacSha1(enc("Jefe"), enc("what do ya want for nothing?"))), "effcdf6ae5eb2fa2d27416d5f184df9c259a7c79")
  // 金鑰超過 64 bytes（RFC 2202 test case 6）
  assert.equal(
    hex(baha.hmacSha1(new Uint8Array(80).fill(0xaa), enc("Test Using Larger Than Block-Size Key - Hash Key First"))),
    "aa4ae5e15272d00e95705637ce8a3b55ed402112",
  )
})

test("TOTP 符合 RFC 6238 向量（取 6 位數，保留前導 0）", () => {
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" // "12345678901234567890"
  assert.equal(baha.totp(secret, 59_000), "287082")
  assert.equal(baha.totp(secret, 1111111109_000), "081804")
  assert.equal(baha.totp(secret, 1111111111_000), "050471")
  assert.equal(baha.totp(secret, 1234567890_000), "005924")
  assert.equal(baha.totp(secret, 2000000000_000), "279037")
  assert.equal(baha.totp(secret, 20000000000_000), "353130")
  assert.equal(baha.totpRemaining(59_000), 1)
  assert.equal(baha.totpRemaining(60_000), 30)
})

test("兩步驟驗證金鑰可貼空白、小寫或 otpauth 網址", () => {
  assert.equal(baha.normalizeSecret("gezd gnbv gy3t qojq"), "GEZDGNBVGY3TQOJQ")
  assert.equal(baha.normalizeSecret(" GEZD-GNBV-GY3T-QOJQ== "), "GEZDGNBVGY3TQOJQ")
  assert.equal(baha.normalizeSecret("otpauth://totp/Bahamut:me?secret=gezdgnbvgy3tqojq&issuer=Bahamut"), "GEZDGNBVGY3TQOJQ")
  assert.equal(baha.normalizeSecret("12345678"), "") // 0、1、8、9 不是 Base32
  assert.equal(baha.normalizeSecret("ABC"), "")
  assert.equal(baha.normalizeSecret(""), "")
})

test("台灣日期以 UTC+8 午夜換日", () => {
  const before = Date.parse("2026-11-13T15:59:00Z") // 台灣 23:59
  const after = Date.parse("2026-11-13T16:00:00Z") // 台灣隔天 00:00
  assert.equal(baha.taipeiDate(before), "2026-11-13")
  assert.equal(baha.taipeiDate(after), "2026-11-14")
  assert.equal(baha.nextTaipeiMidnight(before), after)
  assert.equal(baha.nextTaipeiMidnight(after), Date.parse("2026-11-14T16:00:00Z"))
})

test("Cookie 合併、刪除與 Set-Cookie 解析", () => {
  assert.equal(baha.mergeCookies("a=1; b=2", "b=3; c=4"), "a=1; b=3; c=4")
  assert.equal(baha.mergeCookies("a=1; b=2", "a=deleted; b="), "")
  assert.equal(
    baha.setCookiePairs("BAHARUNE=xyz; expires=Fri, 13-Nov-2027 10:00:00 GMT; path=/, BAHAID=me; path=/"),
    "BAHARUNE=xyz; BAHAID=me",
  )
  assert.equal(baha.cookieValue("a=1; BAHARUNE=r=1", "BAHARUNE"), "r=1")
})

// ── 模擬平台：Keychain、Storage、fetch ──

let keychain, storage, calls, routes, realFetch, realNow, clock

function response({ status = 200, body = "", cookies = [], setCookie = "" } = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body)
  return {
    status,
    cookies,
    headers: { get: (name) => (name.toLowerCase() === "set-cookie" ? setCookie || null : null) },
    text: async () => text,
  }
}

beforeEach(() => {
  keychain = new Map()
  storage = new Map()
  calls = []
  routes = []
  clock = Date.parse("2026-11-13T02:00:00Z") // 台灣 10:00，驗證碼還剩 30 秒
  realNow = Date.now
  Date.now = () => clock
  globalThis.Keychain = {
    get: (k) => (keychain.has(k) ? keychain.get(k) : null),
    set: (k, v) => (keychain.set(k, v), true),
    remove: (k) => keychain.delete(k),
  }
  globalThis.Storage = {
    get: (k) => (storage.has(k) ? storage.get(k) : null),
    set: (k, v) => (storage.set(k, v), true),
    remove: (k) => storage.delete(k),
  }
  realFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method, body: init.body, cookie: init.headers?.Cookie ?? "", headers: init.headers ?? {} })
    const route = routes.shift()
    if (!route) throw new Error(`未預期的請求：${url}`)
    assert.ok(url.includes(route.match), `請求 ${url} 應包含 ${route.match}`)
    if (route.fail) throw new TypeError("offline")
    return response(route)
  }
})

afterEach(() => {
  globalThis.fetch = realFetch
  Date.now = realNow
  delete globalThis.Keychain
  delete globalThis.Storage
})

const LOGIN_OK = {
  match: "do_login.php",
  body: { success: true, userid: "me", nickname: "我" },
  cookies: [{ name: "BAHARUNE", value: "rune1" }, { name: "BAHAID", value: "me" }],
}
const status = (signin, days) => ({ match: "signin.php", body: { data: { signin, days } } })
const NO_LOGIN = { match: "signin.php", body: { error: { code: 401, message: "尚未登入", status: "NO_LOGIN" } } }

function configure(extra = {}) {
  baha.saveCredentials({ uid: "me", pwd: "p@ss&word", ...extra })
}

test("首次使用：登入 → 未簽到 → 取得令牌 → 簽到成功", async () => {
  configure({ totp: "gezd gnbv gy3t qojq" })
  routes.push(
    LOGIN_OK,
    status(0, 5),
    { match: "get_csrf_token.php", body: "0123456789abcdefXYZ" },
    { match: "signin.php", body: { data: { days: 6, dialog: "", prjSigninDays: 0 } } },
  )
  const state = await baha.runCheck(true)
  assert.deepEqual(
    { date: state.date, signed: state.signed, days: state.days, nickname: state.nickname, error: state.error },
    { date: "2026-11-13", signed: true, days: 6, nickname: "我", error: undefined },
  )
  assert.equal(routes.length, 0)

  const [login, check, token, sign] = calls
  assert.equal(login.cookie, "ckAPP_VCODE=6666")
  assert.match(login.body, /^uid=me&passwd=p%40ss%26word&vcode=6666&twoStepAuth=\d{6}$/)
  assert.equal(login.body.split("twoStepAuth=")[1], baha.totp("GEZDGNBVGY3TQOJQ", clock))
  assert.equal(check.body, "action=2")
  assert.match(check.cookie, /BAHARUNE=rune1/)
  assert.match(token.cookie, /BAHARUNE=rune1/)
  assert.equal(sign.body, "action=1&token=0123456789abcdefXYZ")
  assert.match(sign.cookie, /ckBahamutCsrfToken=0123456789abcdef(;|$)/)

  // cookie 存在 Keychain，但不保存 CSRF cookie；狀態存在 Storage
  assert.equal(keychain.get("baha_cookie"), "BAHARUNE=rune1; BAHAID=me")
  assert.equal(baha.getState().signed, true)
  assert.equal(baha.needsRefresh(baha.getState()), false)
  assert.deepEqual(baha.widgetStateOf(baha.getState(), true), { kind: "signed", days: 6 })
})

test("伺服器有帶回 CSRF cookie 時沿用伺服器的值", async () => {
  configure()
  keychain.set("baha_cookie", "BAHARUNE=rune1")
  routes.push(
    status(0, 1),
    { match: "get_csrf_token.php", body: "tokenvalue1234567890", setCookie: "ckBahamutCsrfToken=fromServer; path=/; secure" },
    { match: "signin.php", body: { data: { days: 2 } } },
  )
  await baha.runCheck(true)
  assert.match(calls[2].cookie, /ckBahamutCsrfToken=fromServer/)
  assert.doesNotMatch(calls[2].cookie, /tokenvalue123456/)
})

test("已存的 cookie 失效時自動重新登入一次", async () => {
  configure()
  keychain.set("baha_cookie", "BAHARUNE=old")
  routes.push(NO_LOGIN, LOGIN_OK, status(1, 30))
  const state = await baha.runCheck(false)
  assert.equal(state.signed, true)
  assert.equal(state.days, 30)
  assert.match(calls[0].cookie, /BAHARUNE=old/)
  assert.match(calls[2].cookie, /BAHARUNE=rune1/)
  assert.equal(keychain.get("baha_cookie"), "BAHARUNE=rune1; BAHAID=me")
})

test("只檢查狀態時不會簽到", async () => {
  configure()
  keychain.set("baha_cookie", "BAHARUNE=r")
  routes.push(status(0, 9))
  const state = await baha.runCheck(false)
  assert.equal(calls.length, 1)
  assert.equal(state.signed, false)
  assert.deepEqual(baha.widgetStateOf(state, true), { kind: "unsigned" })
  // 5 分鐘內不重查，之後才重查
  assert.equal(baha.needsRefresh(state), false)
  clock += 6 * 60_000
  assert.equal(baha.needsRefresh(state), true)
})

test("今天已經簽到過的回應：重新查詢天數", async () => {
  configure()
  keychain.set("baha_cookie", "BAHARUNE=r")
  routes.push(
    status(0, 3),
    { match: "get_csrf_token.php", body: "abcdefghijklmnopqr" },
    { match: "signin.php", body: { error: { code: 0, message: "今天您已經簽到過了喔", status: "", details: [] } } },
    status(1, 4),
  )
  const state = await baha.runCheck(true)
  assert.equal(state.signed, true)
  assert.equal(state.days, 4)
})

test("令牌過期會重拿一次令牌", async () => {
  configure()
  keychain.set("baha_cookie", "BAHARUNE=r")
  routes.push(
    status(0, 3),
    { match: "get_csrf_token.php", body: "firsttoken000000aa" },
    { match: "signin.php", body: { error: { code: 403, message: "網頁已過期", status: "CSRF_TOKEN_ERROR" } } },
    { match: "get_csrf_token.php", body: "secondtoken00000bb" },
    { match: "signin.php", body: { data: { days: 4 } } },
  )
  const state = await baha.runCheck(true)
  assert.equal(state.days, 4)
  assert.equal(calls[4].body, "action=1&token=secondtoken00000bb")
})

test("帳密錯誤：不重試，小工具當天不在背景重試登入", async () => {
  configure()
  routes.push({ match: "do_login.php", body: { code: 0, message: "帳號、密碼或驗證碼錯誤！" } })
  const state = await baha.runCheck(true)
  assert.equal(calls.length, 1)
  assert.equal(state.error, "帳號、密碼或驗證碼錯誤！")
  assert.equal(state.errorCode, "LOGIN")
  assert.deepEqual(baha.widgetStateOf(state, true), { kind: "error", message: "帳號、密碼或驗證碼錯誤！" })
  clock += 3 * 3600_000
  assert.equal(baha.needsRefresh(baha.getState()), false)
  // 隔天才會再試
  clock = Date.parse("2026-11-13T16:01:00Z")
  assert.equal(baha.needsRefresh(baha.getState()), true)
})

test("登入成功但沒拿到 BAHARUNE 會明確報錯", async () => {
  configure()
  routes.push({ match: "do_login.php", body: { success: true, userid: "me" } })
  const state = await baha.runCheck(false)
  assert.equal(state.error, "登入成功但沒有取得登入 cookie")
})

test("網路失敗時保留今天已簽到的結果", async () => {
  configure()
  keychain.set("baha_cookie", "BAHARUNE=r")
  routes.push(status(1, 12))
  await baha.runCheck(false)
  routes.push({ match: "signin.php", fail: true })
  const state = await baha.runCheck(false)
  assert.equal(state.signed, true)
  assert.equal(state.days, 12)
  assert.equal(state.error, "網路連線失敗")
  assert.deepEqual(baha.widgetStateOf(state, true), { kind: "signed", days: 12 })
})

test("非 JSON 回應（例如被擋的 HTML）顯示 HTTP 狀態", async () => {
  configure()
  keychain.set("baha_cookie", "BAHARUNE=r")
  routes.push({ match: "signin.php", status: 503, body: "<html>busy</html>" })
  const state = await baha.runCheck(false)
  assert.equal(state.error, "查詢簽到狀態失敗（HTTP 503）")
  assert.equal(state.errorCode, "API")
})

test("昨天的狀態不算今天", () => {
  const yesterday = { date: "2026-11-12", signed: true, days: 8, checkedAt: clock - 86400_000 }
  assert.deepEqual(baha.widgetStateOf(yesterday, true), { kind: "unsigned" })
  assert.equal(baha.needsRefresh(yesterday), true)
  assert.deepEqual(baha.widgetStateOf(null, false), { kind: "setup" })
})

test("帳號設定：驗證、沿用密碼、換帳號清掉舊登入", () => {
  assert.throws(() => baha.saveCredentials({ uid: " " }), /請輸入帳號/)
  assert.throws(() => baha.saveCredentials({ uid: "me" }), /請輸入密碼/)
  assert.throws(() => baha.saveCredentials({ uid: "me", pwd: "x", totp: "not-base32-1" }), /金鑰格式不正確/)

  baha.saveCredentials({ uid: " me ", pwd: "x", totp: "gezd gnbv gy3t qojq" })
  assert.deepEqual(baha.getCredentials(), { uid: "me", pwd: "x", totp: "GEZDGNBVGY3TQOJQ" })
  keychain.set("baha_cookie", "BAHARUNE=r")

  // 同帳號只改金鑰：密碼沿用、cookie 保留
  baha.saveCredentials({ uid: "ME", totp: "" })
  assert.deepEqual(baha.getCredentials(), { uid: "ME", pwd: "x", totp: "" })
  assert.equal(keychain.get("baha_cookie"), "BAHARUNE=r")

  // 換帳號：清掉舊 cookie
  baha.saveCredentials({ uid: "other", pwd: "y" })
  assert.equal(keychain.has("baha_cookie"), false)

  baha.clearAll()
  assert.equal(baha.getCredentials(), null)
  assert.equal(keychain.size, 0)
})

// ── 公會、動畫瘋答題、廣告雙倍 ──

test("解析公會列表（重複連結只算一次、名稱去標籤）", () => {
  const html = `
    <a href="https://guild.gamer.com.tw/guild.php?gsn=123"><img src="x.png"><p>巴哈&amp;朋友</p></a>
    <a href="https://guild.gamer.com.tw/guild.php?gsn=123">再一次</a>
    <a href="https://guild.gamer.com.tw/guild.php?sn=456"><p><b>第二</b>公會</p></a>`
  assert.deepEqual(extras.parseGuilds(html), [
    { sn: "123", name: "巴哈&朋友" },
    { sn: "456", name: "第二公會" },
  ])
  assert.deepEqual(extras.parseGuilds("<div>沒有公會</div>"), [])
})

test("找今天的答案文章與答案", () => {
  const list = [
    { title: "動畫瘋 11/30 答案", sn: 1 },
    { title: "動畫瘋 11/03 答案", sn: 2 },
    { title: "動畫瘋 11/13 答案", sn: 3 },
  ]
  assert.equal(extras.findAnswerPost(list, "2026-11-03"), "2")
  assert.equal(extras.findAnswerPost(list, "2026-11-13"), "3")
  assert.equal(extras.findAnswerPost([{ title: "11/3 答案", sn: 9 }], "2026-11-03"), "9")
  assert.equal(extras.findAnswerPost(list, "2026-11-14"), "")
  assert.equal(extras.findAnswerPost(null, "2026-11-14"), "")
  assert.equal(extras.answerFrom("題目……<br>A:3<br>"), "3")
  assert.equal(extras.answerFrom("答案 A：2"), "2")
  assert.equal(extras.answerFrom("沒有"), "")
  assert.equal(extras.giftText("恭喜您得到：300 巴幣"), "+300 巴幣")
  assert.equal(extras.giftText(""), "答對了")
})

const GUILD_HTML = `<a href="guild.php?gsn=11"><p>甲</p></a><a href="guild.php?gsn=22"><p>乙</p></a>`

test("全部執行：簽到 → 開始廣告 → 公會 → 答題 → 等 30 秒領廣告", async () => {
  configure()
  keychain.set("baha_cookie", "BAHARUNE=r")
  routes.push(
    status(0, 9),
    { match: "get_csrf_token.php", body: "signtoken000000000" },
    { match: "signin.php", body: { data: { days: 10 } } },
    { match: "get_csrf_token.php", body: "adtoken123456789XYZ" },
    { match: "sign_in_ad_start.php", body: { data: { finished: 0 } } },
    { match: "topBar.php", body: GUILD_HTML },
    { match: "guildSign.php", body: { ok: 1, msg: "本日簽到成功！獲得5貢獻度" } },
    { match: "guildSign.php", body: { error: 1, msg: "您今天已經簽到過了！" } },
    { match: "animeGetQuestion.php", body: { game: "G", question: "Q", a1: "1", a2: "2", a3: "3", a4: "4", token: "qtok" } },
    { match: "owner=blackXblue", body: { creation: [{ title: "11/12 答案", sn: 1 }, { title: "11/13 答案", sn: 555 }] } },
    { match: "home_creation_detail.php?sn=555", body: { content: "今天的答案<br>A:3<br>" } },
    { match: "animeAnsQuestion.php", body: { ok: 1, gift: "恭喜您得到：300 巴幣" } },
    { match: "sign_in_ad_finished.php", body: { data: { finished: 1 } } },
  )
  const waits = []
  const progress = []
  const state = await extras.runAll({
    wait: async (ms) => { waits.push(ms); clock += ms },
    onProgress: (s) => progress.push(s.ads?.state),
  })
  assert.equal(routes.length, 0)
  assert.equal(state.signed, true)
  assert.equal(state.days, 10)
  assert.deepEqual([state.guild.state, state.guild.text], ["done", "2 個公會"])
  assert.deepEqual([state.quiz.state, state.quiz.text], ["done", "+300 巴幣"])
  assert.deepEqual([state.ads.state, state.ads.text], ["done", "已領取"])
  assert.equal(extras.allDone(state), true)
  assert.deepEqual(waits, [31_000])
  assert.ok(progress.includes("running"))

  const adStart = calls.find((c) => c.url.includes("sign_in_ad_start"))
  assert.match(adStart.url, /bahamutCsrfToken=adtoken123456789$/)
  assert.match(adStart.cookie, /ckBahamutCsrfToken=adtoken123456789/)
  assert.match(adStart.cookie, /BAHARUNE=r/)
  assert.equal(adStart.headers["X-Bahamut-Csrf-Token"], "adtoken123456789")
  assert.match(calls.find((c) => c.url.includes("ad_finished")).url, /bahamutCsrfToken=adtoken123456789$/)
  assert.deepEqual(calls.filter((c) => c.url.includes("guildSign")).map((c) => c.body), ["sn=11", "sn=22"])
  assert.match(calls.find((c) => c.url.includes("animeAnsQuestion")).body, /^token=qtok&ans=3&t=\d+$/)
  assert.equal(keychain.has("baha_ad_token"), false)

  // 同一天再執行：只查主站狀態，其他項目不重做
  calls = []
  routes.push(status(1, 10))
  await extras.runAll({ wait: async () => assert.fail("不應該等待") })
  assert.equal(calls.length, 1)
})

test("廣告被中斷：下次直接領，不重新開始", async () => {
  configure()
  keychain.set("baha_cookie", "BAHARUNE=r")
  keychain.set("baha_ad_token", "adtoken123456789")
  baha.patchState({
    signed: true, days: 5, checkedAt: clock,
    guild: baha.makeExtra("done", "1 個公會"),
    quiz: baha.makeExtra("miss", "答錯了"),
    ads: { ...baha.makeExtra("running", "領取中…"), startedAt: clock - 3 * 60_000 },
  })
  assert.deepEqual(extras.describeExtra(baha.getState().ads), { text: "未完成", tone: "warn" })
  assert.equal(extras.adRunning(baha.getState()), false)
  routes.push(status(1, 5), { match: "sign_in_ad_finished.php", body: { data: { finished: 1 } } })
  const state = await extras.runAll({ wait: async () => assert.fail("已超過 30 秒，不用等") })
  assert.equal(state.ads.state, "done")
  assert.equal(extras.allDone(state), true)
})

test("答題：答案未公布、已作答、答錯", async () => {
  routes.push(
    { match: "animeGetQuestion.php", body: { token: "t" } },
    { match: "owner=blackXblue", body: { creation: [{ title: "11/12 答案", sn: 1 }] } },
  )
  let r = await extras.animeQuiz("BAHARUNE=r")
  assert.deepEqual([r.extra.state, r.extra.text], ["wait", "答案未公布"])

  routes.push({ match: "animeGetQuestion.php", body: { error: 1, msg: "今日已經答過題目了，一天僅限一次機會" } })
  r = await extras.animeQuiz("BAHARUNE=r")
  assert.deepEqual([r.extra.state, r.extra.text], ["done", "已作答"])

  routes.push(
    { match: "animeGetQuestion.php", body: { token: "t" } },
    { match: "owner=blackXblue", body: { creation: [{ title: "11/13 答案", sn: 7 }] } },
    { match: "sn=7", body: { content: "A:1" } },
    { match: "animeAnsQuestion.php", body: { error: 1, msg: "答題錯誤" } },
  )
  r = await extras.animeQuiz("BAHARUNE=r")
  assert.deepEqual([r.extra.state, r.extra.text], ["miss", "答錯了"])
  assert.equal(baha.isFinal(r.extra), true)

  routes.push({ match: "animeGetQuestion.php", body: { error: 1, nologin: 1, msg: "請先登入" } })
  await assert.rejects(extras.animeQuiz("BAHARUNE=r"), (e) => e.code === "NO_LOGIN")
})

test("公會：沒有公會、部分失敗", async () => {
  routes.push({ match: "topBar.php", body: "<div></div>" })
  let r = await extras.guildSign("BAHARUNE=r")
  assert.deepEqual([r.extra.state, r.extra.text], ["skip", "未加入公會"])

  routes.push(
    { match: "topBar.php", body: GUILD_HTML },
    { match: "guildSign.php", body: { ok: 1, msg: "成功" } },
    { match: "guildSign.php", body: { error: 1, msg: "系統忙碌" } },
  )
  r = await extras.guildSign("BAHARUNE=r")
  assert.deepEqual([r.extra.state, r.extra.text, r.extra.detail], ["fail", "1 個失敗", "乙：系統忙碌"])
  assert.equal(baha.isFinal(r.extra), false)
})

test("廣告：已領過、令牌錯誤", async () => {
  routes.push(
    { match: "get_csrf_token.php", body: "adtoken123456789" },
    { match: "sign_in_ad_start.php", body: { data: { finished: 1 } } },
  )
  let r = await extras.adStart("BAHARUNE=r")
  assert.deepEqual([r.extra.state, r.extra.text], ["done", "已領取"])

  routes.push(
    { match: "get_csrf_token.php", body: "adtoken123456789" },
    { match: "sign_in_ad_start.php", body: { error: { code: 403, message: "網頁已過期", status: "CSRF_TOKEN_ERROR" } } },
  )
  r = await extras.adStart("BAHARUNE=r")
  assert.deepEqual([r.extra.state, r.extra.detail], ["fail", "網頁已過期"])
})

test("全部執行：帳密錯誤時其他項目不執行", async () => {
  configure()
  routes.push({ match: "do_login.php", body: { code: 0, message: "帳號、密碼或驗證碼錯誤！" } })
  const state = await extras.runAll({ wait: async () => assert.fail("不應該等待") })
  assert.equal(calls.length, 1)
  assert.equal(state.errorCode, "LOGIN")
  assert.equal(state.guild, undefined)
  assert.deepEqual(extras.describeExtra(state.guild), { text: "尚未執行", tone: "muted" })
})

test("換日後其他項目重置，暱稱沿用", () => {
  baha.patchState({ signed: true, days: 3, checkedAt: clock, nickname: "我", guild: baha.makeExtra("done", "1 個公會") })
  clock = Date.parse("2026-11-13T16:05:00Z")
  assert.deepEqual(extras.todayExtras(baha.getState()), {})
  const next = baha.patchState({ checkedAt: clock })
  assert.deepEqual(next, { date: "2026-11-14", signed: false, days: 0, checkedAt: clock, nickname: "我" })
})

// 巴哈姆特每日簽到核心：登入、查詢今日是否已簽到、簽到、兩步驟驗證碼（TOTP）。
// 流程參考 jkgtw/Surge 的 BahamutDailyBonus.js（NobyDa 原作）。
// 帳號、密碼、兩步驟驗證金鑰與登入 cookie 只存在本機 Keychain，不會寫入 repo。
// 這個檔案不 import "scripting"，方便在 Node 直接測試。

declare const Keychain: {
  get(key: string, options?: unknown): string | null
  set(key: string, value: string, options?: unknown): boolean
  remove(key: string, options?: unknown): boolean
}

declare const Storage: {
  get<T = unknown>(key: string): T | null
  set<T = unknown>(key: string, value: T): boolean
  remove(key: string): void
}

const LOGIN_URL = "https://api.gamer.com.tw/mobile_app/user/v3/do_login.php"
const CSRF_URL = "https://www.gamer.com.tw/ajax/get_csrf_token.php"
const SIGNIN_URL = "https://www.gamer.com.tw/ajax/signin.php"
export const HOME = "https://www.gamer.com.tw/"
const UA = "Anime/2.13.9 (tw.com.gamer.anime;build:437;iOS 14.5.0) Alamofire/5.4.1"

const K_UID = "baha_uid"
const K_PWD = "baha_pwd"
const K_TOTP = "baha_totp"
const K_COOKIE = "baha_cookie"
const K_AD_TOKEN = "baha_ad_token"
const STATE_KEY = "baha_state_v1"

export const MIN = 60_000
const TAIPEI_OFFSET = 8 * 3600_000
const DAY = 24 * 3600_000

// ── 錯誤 ─────────────────────────────────────────────────────

export type ErrorCode = "NO_CREDENTIALS" | "LOGIN" | "NO_LOGIN" | "NETWORK" | "API"

export class BahaError extends Error {
  code: ErrorCode
  constructor(code: ErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

export function messageOf(error: unknown): string {
  if (error instanceof BahaError) return error.message
  if (error instanceof Error && error.message) return error.message
  return String(error || "未知錯誤")
}

// ── 日期（巴哈的簽到以台灣時間午夜換日）───────────────────────────

/** 台灣日期 YYYY-MM-DD */
export function taipeiDate(ts: number = Date.now()): string {
  return new Date(ts + TAIPEI_OFFSET).toISOString().slice(0, 10)
}

/** 下一個台灣午夜的時間戳 */
export function nextTaipeiMidnight(ts: number = Date.now()): number {
  return (Math.floor((ts + TAIPEI_OFFSET) / DAY) + 1) * DAY - TAIPEI_OFFSET
}

// ── 兩步驟驗證（RFC 6238 TOTP，HMAC-SHA1、6 位數、30 秒）──────────────

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

/** 接受 Base32 金鑰（可含空白、連字號）或 otpauth:// 網址，回傳大寫 Base32；格式不對回傳空字串。 */
export function normalizeSecret(input: string): string {
  let raw = String(input || "").trim()
  if (/^otpauth:\/\//i.test(raw)) {
    const match = raw.match(/[?&]secret=([^&#]+)/i)
    raw = match ? decodeURIComponent(match[1]) : ""
  }
  const secret = raw.replace(/[\s\-=]/g, "").toUpperCase()
  return /^[A-Z2-7]{8,}$/.test(secret) ? secret : ""
}

export function base32Decode(secret: string): Uint8Array {
  const out: number[] = []
  let buffer = 0
  let bits = 0
  for (const ch of secret) {
    const value = BASE32.indexOf(ch)
    if (value < 0) throw new BahaError("LOGIN", "兩步驟驗證金鑰格式不正確")
    buffer = (buffer << 5) | value
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out.push((buffer >>> bits) & 0xff)
    }
  }
  return Uint8Array.from(out)
}

const rotl = (x: number, n: number) => ((x << n) | (x >>> (32 - n))) >>> 0

export function sha1(message: Uint8Array): Uint8Array {
  const length = message.length
  const total = (((length + 9 + 63) >> 6) << 6)
  const buf = new Uint8Array(total)
  buf.set(message)
  buf[length] = 0x80
  const view = new DataView(buf.buffer)
  const bitLength = length * 8
  view.setUint32(total - 8, Math.floor(bitLength / 0x100000000))
  view.setUint32(total - 4, bitLength >>> 0)

  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0
  const w = new Uint32Array(80)
  for (let offset = 0; offset < total; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4)
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1)
    let a = h0, b = h1, c = h2, d = h3, e = h4
    for (let i = 0; i < 80; i++) {
      let f: number
      let k: number
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999 }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1 }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc }
      else { f = b ^ c ^ d; k = 0xca62c1d6 }
      const t = (rotl(a, 5) + f + e + k + w[i]) >>> 0
      e = d; d = c; c = rotl(b, 30); b = a; a = t
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0
  }
  const out = new Uint8Array(20)
  const outView = new DataView(out.buffer)
  ;[h0, h1, h2, h3, h4].forEach((h, i) => outView.setUint32(i * 4, h))
  return out
}

export function hmacSha1(key: Uint8Array, message: Uint8Array): Uint8Array {
  const k = key.length > 64 ? sha1(key) : key
  const block = new Uint8Array(64)
  block.set(k)
  const inner = new Uint8Array(64 + message.length)
  const outer = new Uint8Array(64 + 20)
  for (let i = 0; i < 64; i++) {
    inner[i] = block[i] ^ 0x36
    outer[i] = block[i] ^ 0x5c
  }
  inner.set(message, 64)
  outer.set(sha1(inner), 64)
  return sha1(outer)
}

/** 產生 TOTP 驗證碼；secret 為 Base32。 */
export function totp(secret: string, now: number = Date.now(), digits = 6, step = 30): string {
  const key = base32Decode(normalizeSecret(secret) || secret)
  const counter = Math.floor(now / 1000 / step)
  const msg = new Uint8Array(8)
  const view = new DataView(msg.buffer)
  view.setUint32(0, Math.floor(counter / 0x100000000))
  view.setUint32(4, counter >>> 0)
  const hash = hmacSha1(key, msg)
  const offset = hash[hash.length - 1] & 0x0f
  const code = ((hash[offset] & 0x7f) << 24) | (hash[offset + 1] << 16) | (hash[offset + 2] << 8) | hash[offset + 3]
  return String(code % 10 ** digits).padStart(digits, "0")
}

/** 目前驗證碼還剩幾秒 */
export function totpRemaining(now: number = Date.now(), step = 30): number {
  return step - (Math.floor(now / 1000) % step)
}

// ── Cookie（Scripting 的 fetch 不會自動保存或送出 cookie）──────────────

function cookieList(cookies: unknown): string {
  if (!Array.isArray(cookies)) return ""
  return cookies
    .filter((item: any) => item && typeof item.name === "string" && item.name)
    .map((item: any) => `${item.name}=${item.value ?? ""}`)
    .join("; ")
}

/** 解析 Set-Cookie 標頭（多個 cookie 可能被合併成以逗號分隔的一行；Expires 裡的逗號不會被誤切）。 */
export function setCookiePairs(raw: string): string {
  return String(raw || "")
    .split(/,(?=\s*[A-Za-z0-9_.\-]+=)/)
    .map((part) => part.split(";")[0].trim())
    .filter((pair) => /^[^=\s]+=/.test(pair))
    .join("; ")
}

/** 合併多段 Cookie 字串，同名以後者為準；值為空或 deleted 代表伺服器要刪除。 */
export function mergeCookies(...parts: string[]): string {
  const jar = new Map<string, string>()
  for (const part of parts) {
    for (const pair of String(part || "").split(";")) {
      const index = pair.indexOf("=")
      if (index <= 0) continue
      const name = pair.slice(0, index).trim()
      const value = pair.slice(index + 1).trim()
      if (!value || value === "deleted") jar.delete(name)
      else jar.set(name, value)
    }
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ")
}

export function cookieValue(cookie: string, name: string): string {
  for (const pair of String(cookie || "").split(";")) {
    const index = pair.indexOf("=")
    if (index > 0 && pair.slice(0, index).trim() === name) return pair.slice(index + 1).trim()
  }
  return ""
}

export const hasSession = (cookie: string) => !!cookieValue(cookie, "BAHARUNE")

// ── HTTP ─────────────────────────────────────────────────────

export type HttpResult = { status: number; text: string; cookie: string }

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: any
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(onTimeout()), ms) }),
  ]).finally(() => clearTimeout(timer))
}

export async function http(url: string, init: {
  method?: "GET" | "POST"; body?: string; cookie?: string; referer?: string; timeout?: number
  headers?: Record<string, string>
} = {}): Promise<HttpResult> {
  const seconds = init.timeout ?? 15
  const headers: Record<string, string> = {
    "User-Agent": UA,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-TW,zh-Hant;q=0.9",
  }
  if (init.body !== undefined) headers["Content-Type"] = "application/x-www-form-urlencoded"
  if (init.cookie) headers.Cookie = init.cookie
  if (init.referer) headers.Referer = init.referer
  if (init.headers) Object.assign(headers, init.headers)

  let response: any
  let text: string
  try {
    response = await withTimeout(
      fetch(url, { method: init.method ?? "GET", headers, body: init.body, timeout: seconds } as any),
      seconds * 1000 + 1000,
      () => new BahaError("NETWORK", "連線逾時"),
    )
    text = await response.text()
  } catch (error) {
    if (error instanceof BahaError) throw error
    throw new BahaError("NETWORK", "網路連線失敗")
  }
  let fromList = ""
  try { fromList = cookieList(response.cookies) } catch (_) { /* 舊版沒有 cookies 屬性 */ }
  let fromHeader = ""
  try { fromHeader = setCookiePairs(response.headers?.get?.("set-cookie") ?? "") } catch (_) { /* 取不到標頭 */ }
  return { status: Number(response.status) || 0, text: String(text ?? ""), cookie: mergeCookies(fromHeader, fromList) }
}

export function parseJSON(text: string): any {
  try { return JSON.parse(text) } catch (_) { return null }
}

export function apiMessage(json: any): string {
  if (!json || typeof json !== "object") return ""
  const message = json.error?.message ?? json.message ?? json.msg
  return typeof message === "string" ? message.trim() : ""
}

export function assertLoggedIn(json: any, status: number): void {
  const error = json?.error
  if (status === 401 || error?.code === 401 || error?.status === "NO_LOGIN") {
    throw new BahaError("NO_LOGIN", "登入狀態失效")
  }
}

const toDays = (value: unknown) => {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// ── 巴哈 API ──────────────────────────────────────────────────

export type Credentials = { uid: string; pwd: string; totp: string }

/** 以手機 App 的登入介面登入，回傳登入後的 cookie。帳密錯誤不重試，避免帳號被鎖。 */
export async function login(creds: Credentials): Promise<{ cookie: string; nickname: string }> {
  const params = [`uid=${encodeURIComponent(creds.uid)}`, `passwd=${encodeURIComponent(creds.pwd)}`, "vcode=6666"]
  if (creds.totp) {
    // 驗證碼快過期就等下一組，避免送出去時剛好失效。
    const remain = totpRemaining()
    if (remain < 4) await sleep(remain * 1000 + 500)
    params.push(`twoStepAuth=${totp(creds.totp)}`)
  }
  const res = await http(LOGIN_URL, { method: "POST", body: params.join("&"), cookie: "ckAPP_VCODE=6666" })
  const json = parseJSON(res.text)
  if (json && json.userid) {
    if (!hasSession(res.cookie)) throw new BahaError("LOGIN", "登入成功但沒有取得登入 cookie")
    return { cookie: res.cookie, nickname: String(json.nickname || json.userid) }
  }
  throw new BahaError("LOGIN", apiMessage(json) || `登入失敗（HTTP ${res.status}）`)
}

/** 查詢今日簽到狀態（action=2，不會簽到）。 */
export async function fetchStatus(cookie: string): Promise<{ signed: boolean; days: number; cookie: string }> {
  const res = await http(SIGNIN_URL, { method: "POST", body: "action=2", cookie, referer: HOME })
  const json = parseJSON(res.text)
  assertLoggedIn(json, res.status)
  const data = json?.data
  if (data && typeof data === "object") {
    return { signed: Number(data.signin) === 1, days: toDays(data.days), cookie: mergeCookies(cookie, res.cookie) }
  }
  throw new BahaError("API", apiMessage(json) || `查詢簽到狀態失敗（HTTP ${res.status}）`)
}

/** 取得 CSRF 令牌；回傳的 cookie 已含對應的 ckBahamutCsrfToken。 */
export async function fetchCsrfToken(cookie: string): Promise<{ token: string; cookie: string }> {
  const res = await http(`${CSRF_URL}?_=${Date.now()}`, { cookie, referer: HOME })
  assertLoggedIn(parseJSON(res.text), res.status)
  const token = res.text.trim()
  if (!token || token.length > 256 || /[\s<>{}"]/.test(token)) {
    throw new BahaError("API", `取得簽到令牌失敗（HTTP ${res.status}）`)
  }
  let jar = mergeCookies(cookie, res.cookie)
  // 令牌對應的 cookie 若沒被帶回來，就照網頁的規則自己補上（令牌前 16 碼）。
  if (!cookieValue(res.cookie, "ckBahamutCsrfToken")) {
    jar = mergeCookies(jar, `ckBahamutCsrfToken=${token.slice(0, 16)}`)
  }
  return { token, cookie: jar }
}

/** 取得 CSRF 令牌後簽到（action=1）。已簽過會回傳 already。 */
export async function signIn(cookie: string): Promise<{ already: boolean; days: number; cookie: string }> {
  let jar = cookie
  for (let attempt = 0; attempt < 2; attempt++) {
    const csrf = await fetchCsrfToken(jar)
    const token = csrf.token
    jar = csrf.cookie

    const res = await http(SIGNIN_URL, {
      method: "POST", body: `action=1&token=${encodeURIComponent(token)}`, cookie: jar, referer: HOME,
    })
    jar = mergeCookies(jar, res.cookie)
    const json = parseJSON(res.text)
    assertLoggedIn(json, res.status)
    if (json?.data && typeof json.data === "object") {
      return { already: false, days: toDays(json.data.days), cookie: jar }
    }
    const message = apiMessage(json)
    if (/已經簽到|簽到過/.test(message)) return { already: true, days: 0, cookie: jar }
    // 令牌過期（網頁已過期）就重拿一次
    if (attempt === 0 && json?.error?.status === "CSRF_TOKEN_ERROR") continue
    throw new BahaError("API", message || `簽到失敗（HTTP ${res.status}）`)
  }
  throw new BahaError("API", "簽到失敗")
}

// ── 本機資料 ──────────────────────────────────────────────────

const keychainGet = (key: string) => {
  try { return Keychain.get(key) || "" } catch (_) { return "" }
}

export function getCredentials(): Credentials | null {
  const uid = keychainGet(K_UID).trim()
  const pwd = keychainGet(K_PWD)
  if (!uid || !pwd) return null
  return { uid, pwd, totp: normalizeSecret(keychainGet(K_TOTP)) }
}

export function hasCredentials(): boolean {
  return getCredentials() !== null
}

/** 讀出已儲存的帳號（不含密碼），給設定頁顯示用。 */
export function getSavedAccount(): { uid: string; hasPassword: boolean; hasTotp: boolean } {
  return { uid: keychainGet(K_UID), hasPassword: !!keychainGet(K_PWD), hasTotp: !!normalizeSecret(keychainGet(K_TOTP)) }
}

/**
 * 儲存帳號；password、totp 傳 undefined 代表沿用原值。totp 傳空字串代表關閉兩步驟驗證。
 * 換帳號時會清掉舊的登入 cookie 與狀態。
 */
export function saveCredentials(input: { uid: string; pwd?: string; totp?: string }): void {
  const uid = input.uid.trim()
  if (!uid) throw new BahaError("NO_CREDENTIALS", "請輸入帳號")
  const old = keychainGet(K_UID)
  if (input.pwd !== undefined && input.pwd !== "") Keychain.set(K_PWD, input.pwd)
  if (!keychainGet(K_PWD)) throw new BahaError("NO_CREDENTIALS", "請輸入密碼")
  if (input.totp !== undefined) {
    if (input.totp.trim() === "") Keychain.remove(K_TOTP)
    else {
      const secret = normalizeSecret(input.totp)
      if (!secret) throw new BahaError("NO_CREDENTIALS", "兩步驟驗證金鑰格式不正確（應為英文字母 A–Z 與數字 2–7）")
      Keychain.set(K_TOTP, secret)
    }
  }
  Keychain.set(K_UID, uid)
  if (old.toLowerCase() !== uid.toLowerCase()) clearSession()
}

/** 只清掉登入 cookie 與今日狀態（下次會重新登入）。 */
export function clearSession(): void {
  for (const key of [K_COOKIE, K_AD_TOKEN]) {
    try { Keychain.remove(key) } catch (_) {}
  }
  try { Storage.remove(STATE_KEY) } catch (_) {}
}

/** 清除所有本機資料（帳號、密碼、金鑰、cookie、狀態）。 */
export function clearAll(): void {
  for (const key of [K_UID, K_PWD, K_TOTP]) {
    try { Keychain.remove(key) } catch (_) {}
  }
  clearSession()
}

function loadCookie(): string {
  return keychainGet(K_COOKIE)
}

function saveCookie(cookie: string): void {
  // CSRF cookie 每次簽到都會重拿，不保存，避免下次帶到過期的值。
  const clean = String(cookie || "")
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => pair && !pair.startsWith("ckBahamutCsrfToken="))
    .join("; ")
  try { Keychain.set(K_COOKIE, clean) } catch (_) {}
}

/** 廣告雙倍：開始與領取要用同一組令牌，中途被系統中斷時下次接著領。 */
export function getAdToken(): string {
  return keychainGet(K_AD_TOKEN)
}

export function setAdToken(token: string): void {
  try {
    if (token) Keychain.set(K_AD_TOKEN, token)
    else Keychain.remove(K_AD_TOKEN)
  } catch (_) {}
}

// ── 每日狀態（存在 Storage，小工具與 App 共用）──────────────────────

/**
 * 其他項目（公會、動畫瘋答題、廣告雙倍）的結果。
 * done 完成、miss 今日機會已用掉（答錯）、skip 不適用（未加入公會）：今天不用再執行。
 * wait 稍後再試（答案未公布）、fail 失敗、running 廣告領取中：點擊後會再執行。
 */
export type ExtraState = "done" | "miss" | "skip" | "wait" | "fail" | "running"
export type Extra = {
  state: ExtraState
  /** 小工具顯示的短字 */
  text: string
  /** App 內顯示的詳細原因 */
  detail?: string
  at: number
  /** 廣告開始觀看的時間 */
  startedAt?: number
}

const EXTRA_STATES: ExtraState[] = ["done", "miss", "skip", "wait", "fail", "running"]

export function makeExtra(state: ExtraState, text: string, detail?: string, now: number = Date.now()): Extra {
  const extra: Extra = { state, text, at: now }
  if (detail && detail !== text) extra.detail = detail
  return extra
}

/** 今天不需要再執行 */
export function isFinal(extra: Extra | undefined): boolean {
  return !!extra && (extra.state === "done" || extra.state === "miss" || extra.state === "skip")
}

function parseExtra(value: any): Extra | undefined {
  if (!value || typeof value !== "object" || !EXTRA_STATES.includes(value.state) || typeof value.text !== "string") return undefined
  const extra: Extra = { state: value.state, text: value.text, at: Number(value.at) || 0 }
  if (typeof value.detail === "string" && value.detail) extra.detail = value.detail
  if (Number(value.startedAt) > 0) extra.startedAt = Number(value.startedAt)
  return extra
}

export type DayState = {
  /** 台灣日期 YYYY-MM-DD */
  date: string
  signed: boolean
  /** 連續簽到天數 */
  days: number
  /** 最後一次檢查（成功或失敗）的時間 */
  checkedAt: number
  nickname?: string
  /** 最後一次檢查失敗的原因 */
  error?: string
  errorCode?: ErrorCode
  guild?: Extra
  quiz?: Extra
  ads?: Extra
}

export function getState(): DayState | null {
  try {
    const raw = Storage.get<any>(STATE_KEY)
    const value = typeof raw === "string" ? parseJSON(raw) : raw
    if (!value || typeof value !== "object" || typeof value.date !== "string") return null
    const state: DayState = {
      date: value.date,
      signed: value.signed === true,
      days: toDays(value.days),
      checkedAt: Number(value.checkedAt) || 0,
    }
    if (typeof value.nickname === "string" && value.nickname) state.nickname = value.nickname
    if (typeof value.error === "string" && value.error) state.error = value.error
    if (typeof value.errorCode === "string") state.errorCode = value.errorCode as ErrorCode
    for (const key of ["guild", "quiz", "ads"] as const) {
      const extra = parseExtra(value[key])
      if (extra) state[key] = extra
    }
    return state
  } catch (_) {
    return null
  }
}

/**
 * 合併寫入今天的狀態（寫入前重新讀一次，避免 App、小工具、按鈕同時執行時互相覆蓋）。
 * 換日時只沿用暱稱。值為 undefined 的欄位代表清除。
 */
export function patchState(patch: Partial<DayState>, now: number = Date.now()): DayState {
  const today = taipeiDate(now)
  const current = getState()
  const base: DayState = current && current.date === today
    ? current
    : { date: today, signed: false, days: 0, checkedAt: 0, ...(current?.nickname ? { nickname: current.nickname } : {}) }
  const next: any = { ...base, ...patch, date: today }
  for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key]
  try { Storage.set(STATE_KEY, JSON.stringify(next)) } catch (_) {}
  return next as DayState
}

/**
 * 小工具是否需要重新查詢：今天已簽到就不用；未簽到則 5 分鐘內不重查。
 * 帳密被拒絕時當天不在背景重試，等使用者點小工具或開 App，避免一直重試把帳號鎖住。
 */
export function needsRefresh(state: DayState | null, now: number = Date.now()): boolean {
  if (!state || state.date !== taipeiDate(now)) return true
  if (state.signed) return false
  if (state.errorCode === "LOGIN") return false
  return now - state.checkedAt > 5 * MIN
}

export type WidgetState =
  | { kind: "setup" }
  | { kind: "signed"; days: number }
  | { kind: "unsigned" }
  | { kind: "error"; message: string }

export function widgetStateOf(state: DayState | null, configured: boolean, now: number = Date.now()): WidgetState {
  if (!configured) return { kind: "setup" }
  if (!state || state.date !== taipeiDate(now)) return { kind: "unsigned" }
  if (state.signed) return { kind: "signed", days: state.days }
  if (state.error) return { kind: "error", message: state.error }
  return { kind: "unsigned" }
}

// ── 登入工作階段 ──────────────────────────────────────────────

export function requireCredentials(): Credentials {
  const creds = getCredentials()
  if (!creds) throw new BahaError("NO_CREDENTIALS", "尚未設定帳號密碼")
  return creds
}

/**
 * 沿用 Keychain 裡的登入 cookie；沒有或失效（NO_LOGIN）時用帳密重新登入，每次執行最多登入一次。
 * 每個請求後都把伺服器更新的 cookie 存回 Keychain。
 */
export class Session {
  creds: Credentials
  cookie: string
  nickname: string | undefined
  loggedIn = false

  constructor(creds: Credentials) {
    this.creds = creds
    this.cookie = loadCookie()
  }

  async relogin(): Promise<void> {
    if (this.loggedIn) throw new BahaError("NO_LOGIN", "登入狀態失效")
    this.loggedIn = true
    const result = await login(this.creds)
    this.nickname = result.nickname
    this.update(result.cookie)
  }

  update(cookie: string): void {
    this.cookie = cookie
    saveCookie(cookie)
  }

  async run<R extends { cookie: string }>(task: (cookie: string) => Promise<R>): Promise<R> {
    if (!hasSession(this.cookie)) await this.relogin()
    let result: R
    try {
      result = await task(this.cookie)
    } catch (error) {
      if (this.loggedIn || !(error instanceof BahaError) || error.code !== "NO_LOGIN") throw error
      await this.relogin()
      result = await task(this.cookie)
    }
    this.update(result.cookie)
    return result
  }
}

/** 主站簽到：查詢狀態，需要時簽到。 */
export function mainStep(session: Session, signInIfNeeded: boolean): Promise<{ signed: boolean; days: number; cookie: string }> {
  return session.run(async (cookie) => {
    const status = await fetchStatus(cookie)
    if (status.signed || !signInIfNeeded) return status
    const result = await signIn(status.cookie)
    if (!result.already && result.days > 0) return { signed: true, days: result.days, cookie: result.cookie }
    const after = await fetchStatus(result.cookie)
    return { ...after, signed: after.signed || result.already }
  })
}

export function errorPatch(error: unknown): { error: string; errorCode: ErrorCode } {
  const code: ErrorCode = error instanceof BahaError ? error.code : "API"
  const message = code === "NO_LOGIN" ? "登入失效，請確認帳號密碼" : messageOf(error)
  return { error: message, errorCode: code }
}

export function mainPatch(session: Session, result: { signed: boolean; days: number }): Partial<DayState> {
  return {
    signed: result.signed,
    days: result.days,
    checkedAt: Date.now(),
    error: undefined,
    errorCode: undefined,
    ...(session.nickname ? { nickname: session.nickname } : {}),
  }
}

/**
 * 只處理主站簽到：查詢今日狀態；signIn 為 true 且尚未簽到時會順便簽到。
 * 不會丟出例外：失敗原因寫在回傳狀態的 error。
 */
export async function runCheck(signInIfNeeded: boolean): Promise<DayState> {
  let session: Session | null = null
  try {
    session = new Session(requireCredentials())
    const result = await mainStep(session, signInIfNeeded)
    return patchState(mainPatch(session, result))
  } catch (error) {
    return patchState({
      checkedAt: Date.now(),
      ...errorPatch(error),
      ...(session?.nickname ? { nickname: session.nickname } : {}),
    })
  }
}

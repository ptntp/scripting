// Control D 核心：API 請求、統計、端點、DNS 驗證、快取與格式化。
// API Token 只存在本機 Keychain，不會寫入 repo。
// 這個檔案不 import "scripting"，方便在 Node 直接測試。
//
// 端點與欄位參考：
// - Control D API（https://docs.controld.com）：/users、/devices
// - 統計主機 <stats_endpoint>.analytics.controld.com 的 /v2/statistic/count 系列，
//   做法參考 ccpk1/controld-manager-ha 的實測紀錄

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

export const API_BASE = "https://api.controld.com"
export const VERIFY_HOST = "verify.controld.com"

const K_TOKEN = "controld_token"
const SETTINGS_KEY = "controld_settings_v1"
const SNAPSHOT_KEY = "controld_snapshot_v1"
const USER_KEY = "controld_user_v1"
const PREV_KEY = "controld_prev_v1"

export const MIN = 60_000
export const HOUR = 60 * MIN
export const DAY = 24 * HOUR
const TAIPEI_OFFSET = 8 * HOUR

/** 最後一次查詢在這段時間內就算「在線」 */
export const ONLINE_WINDOW = 15 * MIN
/** 小工具更新間隔（實際時間由 iOS 安排） */
export const RELOAD_EVERY = 15 * MIN

// ── 錯誤 ─────────────────────────────────────────────────────

export type ErrorCode = "NO_TOKEN" | "AUTH" | "NETWORK" | "RATE" | "API"

export class ControlDError extends Error {
  code: ErrorCode
  status: number
  /** 原始錯誤訊息（判斷 DNS／TLS 失敗用） */
  detail: string
  constructor(code: ErrorCode, message: string, status = 0, detail = "") {
    super(message)
    this.code = code
    this.status = status
    this.detail = detail
  }
}

export function messageOf(error: unknown): string {
  if (error instanceof ControlDError) return error.message
  if (error instanceof Error && error.message) return error.message
  return String(error || "未知錯誤")
}

const codeOf = (error: unknown): ErrorCode | "" => (error instanceof ControlDError ? error.code : "")

// ── HTTP ─────────────────────────────────────────────────────

export interface HttpResult {
  status: number
  text: string
  json: any
}

export function parseJSON(text: string): any {
  try { return JSON.parse(text) } catch (_) { return null }
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: any
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(onTimeout()), ms) }),
  ]).finally(() => clearTimeout(timer))
}

export async function http(url: string, headers: Record<string, string> = {}, seconds = 10): Promise<HttpResult> {
  let response: any
  let text: string
  try {
    response = await withTimeout(
      fetch(url, { method: "GET", headers, timeout: seconds } as any),
      seconds * 1000 + 1000,
      () => new ControlDError("NETWORK", "連線逾時", 0, "timeout"),
    )
    text = String((await response.text()) ?? "")
  } catch (error) {
    if (error instanceof ControlDError) throw error
    throw new ControlDError("NETWORK", "網路連線失敗", 0, messageOf(error))
  }
  return { status: Number(response.status) || 0, text, json: parseJSON(text) }
}

/** 組查詢字串；陣列會展開成同名參數（例如 action[]=0），鍵與值都做百分比編碼。 */
export function query(params: Record<string, string | number | Array<string | number> | undefined>): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue
    for (const item of Array.isArray(value) ? value : [value]) {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(item))}`)
    }
  }
  return parts.length ? `?${parts.join("&")}` : ""
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: "application/json" }
}

/** 把 HTTP 結果轉成錯誤；成功回傳 null。 */
export function apiError(res: HttpResult, what: string, authMessage = "API Token 無效或權限不足"): ControlDError | null {
  if (res.status === 401 || res.status === 403) return new ControlDError("AUTH", authMessage, res.status)
  if (res.status === 429) return new ControlDError("RATE", "請求太頻繁，請稍後再試", 429)
  const json = res.json
  const raw = json?.error?.message ?? json?.message
  const message = typeof raw === "string" ? raw.trim() : ""
  if (res.status >= 400 || json?.success === false) {
    return new ControlDError("API", message ? `${what}失敗：${message}` : `${what}失敗（HTTP ${res.status}）`, res.status)
  }
  if (!json || typeof json !== "object") return new ControlDError("API", `${what}失敗：回應格式不符`, res.status)
  return null
}

async function getBody(url: string, token: string, what: string, authMessage?: string): Promise<any> {
  const res = await http(url, authHeaders(token))
  const error = apiError(res, what, authMessage)
  if (error) throw error
  const body = res.json.body
  return body && typeof body === "object" ? body : {}
}

// ── 本機資料 ──────────────────────────────────────────────────

function storageGet(key: string): any {
  try {
    const raw = Storage.get<any>(key)
    return typeof raw === "string" ? parseJSON(raw) : raw
  } catch (_) {
    return null
  }
}

function storageSet(key: string, value: unknown): void {
  try { Storage.set(key, JSON.stringify(value)) } catch (_) {}
}

function storageRemove(key: string): void {
  try { Storage.remove(key) } catch (_) {}
}

export function getToken(): string {
  try { return (Keychain.get(K_TOKEN) || "").trim() } catch (_) { return "" }
}

export function hasToken(): boolean {
  return getToken() !== ""
}

/** 只接受 API Token 常見字元，貼上時多出的空白、換行、Bearer 前綴會被去掉。 */
export function normalizeToken(input: string): string {
  const token = String(input || "").trim().replace(/^bearer\s+/i, "").trim()
  return /^[A-Za-z0-9._~+/=-]{8,512}$/.test(token) ? token : ""
}

/** 儲存新 Token；換 Token 時清掉舊帳號的快取。回傳 false 代表格式不對。 */
export function saveToken(input: string): boolean {
  const token = normalizeToken(input)
  if (!token) return false
  Keychain.set(K_TOKEN, token)
  clearCache()
  return true
}

export function clearCache(): void {
  for (const key of [SNAPSHOT_KEY, USER_KEY, PREV_KEY]) storageRemove(key)
}

export function clearAll(): void {
  try { Keychain.remove(K_TOKEN) } catch (_) {}
  clearCache()
  storageRemove(SETTINGS_KEY)
}

// ── 統計區間 ──────────────────────────────────────────────────

export type RangeKey = "today" | "24h" | "7d" | "30d"

export const RANGES: Array<{ key: RangeKey; label: string; short: string }> = [
  { key: "today", label: "今天", short: "今日" },
  { key: "24h", label: "過去 24 小時", short: "24 小時" },
  { key: "7d", label: "過去 7 天", short: "7 天" },
  { key: "30d", label: "過去 30 天", short: "30 天" },
]

export function rangeInfo(key: RangeKey) {
  return RANGES.find((r) => r.key === key) ?? RANGES[0]
}

/** 小工具參數：today／24h／7d／30d（也接受「今天」「7天」等寫法），不認得回傳 null。 */
export function parseRange(param: unknown): RangeKey | null {
  const raw = String(param ?? "").trim().toLowerCase().replace(/\s+/g, "")
  if (!raw) return null
  if (["today", "今天", "今日", "day"].includes(raw)) return "today"
  if (["24h", "1d", "24小時"].includes(raw)) return "24h"
  if (["7d", "week", "7天", "一週", "一周"].includes(raw)) return "7d"
  if (["30d", "month", "30天", "一個月"].includes(raw)) return "30d"
  return null
}

export interface Settings {
  range: RangeKey
}

export function getSettings(): Settings {
  const value = storageGet(SETTINGS_KEY)
  const range = parseRange(value?.range) ?? "today"
  return { range }
}

export function saveSettings(settings: Settings): void {
  storageSet(SETTINGS_KEY, { range: settings.range })
}

/** 台灣時間當天 00:00 */
export function startOfTaipeiDay(ts: number): number {
  return Math.floor((ts + TAIPEI_OFFSET) / DAY) * DAY - TAIPEI_OFFSET
}

export interface Window {
  start: number
  end: number
}

export function rangeWindow(range: RangeKey, now: number): Window {
  switch (range) {
    case "24h": return { start: now - DAY, end: now }
    case "7d": return { start: now - 7 * DAY, end: now }
    case "30d": return { start: now - 30 * DAY, end: now }
    default: return { start: startOfTaipeiDay(now), end: now }
  }
}

/** 前一期同長度區間；「今天」對照昨天同一時段。 */
export function previousWindow(range: RangeKey, w: Window): Window {
  const shift = range === "today" ? DAY : w.end - w.start
  return { start: w.start - shift, end: w.end - shift }
}

const iso = (ts: number) => new Date(ts).toISOString()

// ── 統計 ─────────────────────────────────────────────────────

/** 統計的 action：0 封鎖、1 放行、2 依 IP 導向、3 依地區導向 */
export const ACTION = { blocked: 0, bypassed: 1, redirectIp: 2, redirectLocation: 3 } as const

export interface Counts {
  total: number
  blocked: number
  bypassed: number
  redirected: number
}

const ANALYTICS_AUTH = "這把 API Token 無法讀取統計"

/** 帳號的統計主機代號：個人在 body.stats_endpoint，組織在 body.org.stats_endpoint */
export function statsEndpointOf(user: any): string {
  const value = user?.stats_endpoint ?? user?.org?.stats_endpoint
  return typeof value === "string" ? value.trim() : ""
}

export function analyticsBase(endpoint: string): string {
  const name = endpoint.trim().replace(/\/+$/, "")
  if (/^https?:\/\//i.test(name)) return name
  if (name.endsWith(".analytics.controld.com")) return `https://${name}`
  return `https://${name}.analytics.controld.com`
}

/** 從 /users 取得統計主機，快取一天（換 Token 時清除）。 */
export async function resolveStatsEndpoint(token: string, now: number): Promise<string> {
  const cached = storageGet(USER_KEY)
  if (cached && typeof cached.endpoint === "string" && cached.endpoint && now - Number(cached.fetchedAt) < DAY) {
    return cached.endpoint
  }
  const user = await getBody(`${API_BASE}/users`, token, "讀取帳號")
  const endpoint = statsEndpointOf(user)
  if (endpoint) storageSet(USER_KEY, { endpoint, fetchedAt: now })
  return endpoint
}

function countOf(body: any): number {
  const count = Number(body?.count)
  if (!Number.isFinite(count) || count < 0) throw new ControlDError("API", "讀取統計失敗：回應格式不符")
  return count
}

/** 分別查四種 action 的筆數再加總（總數＝封鎖＋放行＋導向）。 */
export async function fetchCounts(base: string, token: string, w: Window): Promise<Counts> {
  const time = { startTime: iso(w.start), endTime: iso(w.end) }
  const actions = [ACTION.blocked, ACTION.bypassed, ACTION.redirectIp, ACTION.redirectLocation]
  const [blocked, bypassed, redirectIp, redirectLocation] = await Promise.all(
    actions.map((action) =>
      getBody(`${base}/v2/statistic/count${query({ ...time, "action[]": action })}`, token, "讀取統計", ANALYTICS_AUTH)
        .then(countOf),
    ),
  )
  const redirected = redirectIp + redirectLocation
  return { total: blocked + bypassed + redirected, blocked, bypassed, redirected }
}

/** 前一期統計變動慢，快取一小時。 */
async function fetchPrevious(base: string, token: string, range: RangeKey, w: Window, now: number): Promise<Counts> {
  const prev = previousWindow(range, w)
  const cached = storageGet(PREV_KEY)
  if (
    cached && cached.range === range && cached.counts &&
    now - Number(cached.fetchedAt) < HOUR && Math.abs(Number(cached.start) - prev.start) < HOUR
  ) {
    return parseCounts(cached.counts) ?? fetchCounts(base, token, prev)
  }
  const counts = await fetchCounts(base, token, prev)
  storageSet(PREV_KEY, { range, start: prev.start, counts, fetchedAt: now })
  return counts
}

export interface RankRow {
  value: string
  count: number
}

/** 最常被封鎖的網域（count/question，依筆數由多到少）。 */
export async function fetchTopBlocked(base: string, token: string, w: Window, limit = 5): Promise<RankRow[]> {
  const url = `${base}/v2/statistic/count/question${query({
    startTime: iso(w.start), endTime: iso(w.end), action: ACTION.blocked, sortOrder: "desc",
  })}`
  const body = await getBody(url, token, "讀取網域排行", ANALYTICS_AUTH)
  return parseRank(body).slice(0, limit)
}

export function parseRank(body: any): RankRow[] {
  const rows = Array.isArray(body?.counts) ? body.counts : Array.isArray(body?.items) ? body.items : []
  const out: RankRow[] = []
  for (const row of rows) {
    const value = String(row?.value ?? row?.question ?? "").trim()
    const count = Number(row?.count)
    if (value && Number.isFinite(count)) out.push({ value, count })
  }
  return out.sort((a, b) => b.count - a.count)
}

// ── 端點 ─────────────────────────────────────────────────────

export interface Device {
  id: string
  name: string
  /** 0 等待啟用、1 啟用、2 軟停用、3 硬停用 */
  status: number
  profile: string
  profile2: string
  /** 最後一次查詢（毫秒），0＝沒有紀錄 */
  lastActivity: number
  /** 分析紀錄等級：0 關閉、1 部分、2 完整、-1 不明 */
  logging: number
}

/** 支援 Unix 秒、毫秒、數字字串與 ISO 時間；認不得回傳 0。 */
export function toMillis(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value < 1e12 ? value * 1000 : value
  if (typeof value === "string" && value.trim()) {
    const text = value.trim()
    if (/^\d+(\.\d+)?$/.test(text)) return toMillis(Number(text))
    const parsed = Date.parse(text)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

const intOr = (value: unknown, fallback: number) => {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value
  return typeof n === "number" && Number.isInteger(n) ? n : fallback
}

export function parseDevices(body: any): Device[] {
  const rows = Array.isArray(body?.devices) ? body.devices : []
  const out: Device[] = []
  for (const row of rows) {
    if (!row || typeof row !== "object") continue
    const id = String(row.device_id ?? row.PK ?? "").trim()
    if (!id) continue
    out.push({
      id,
      name: String(row.name ?? "").trim() || id,
      status: intOr(row.status, 1),
      profile: String(row.profile?.name ?? "").trim(),
      profile2: String(row.profile2?.name ?? "").trim(),
      lastActivity: toMillis(row.last_activity ?? row.last_active),
      logging: intOr(row.stats, -1),
    })
  }
  return out
}

export function isOnline(device: Device, now: number, window = ONLINE_WINDOW): boolean {
  return device.status === 1 && device.lastActivity > 0 && now - device.lastActivity <= window
}

/** 在線的排前面，其餘依最後查詢時間由近到遠。 */
export function sortDevices(devices: Device[], now: number): Device[] {
  return [...devices].sort((a, b) => {
    const online = Number(isOnline(b, now)) - Number(isOnline(a, now))
    if (online) return online
    if (b.lastActivity !== a.lastActivity) return b.lastActivity - a.lastActivity
    return a.name.localeCompare(b.name)
  })
}

export function statusLabel(status: number): string {
  switch (status) {
    case 0: return "等待啟用"
    case 2: return "軟停用"
    case 3: return "硬停用"
    default: return ""
  }
}

export function loggingLabel(level: number): string {
  return level === 0 ? "不記錄" : level === 1 ? "部分記錄" : level === 2 ? "完整記錄" : ""
}

export async function fetchDevices(token: string): Promise<Device[]> {
  const body = await getBody(`${API_BASE}/devices?last_activity=1`, token, "讀取端點")
  return parseDevices(body)
}

// ── 這支 iPhone 是否走 Control D ─────────────────────────────

/**
 * verify.controld.com 只有經過 Control D 的 DNS 才解析得到（ctrld 文件的檢查方式）。
 * - responded：有收到 HTTP 回應（DNS 解析成功）
 * - tls：DNS 解析成功但憑證不符，同樣代表走 Control D
 * - dns：連線失敗（主機解析不到；系統錯誤訊息會依語系翻譯，所以逾時以外的失敗都歸在這裡）
 * - failed：逾時，可能只是網路慢
 */
export type VerifyProbe = "responded" | "tls" | "dns" | "failed"
export type Verify = "yes" | "no" | "unknown"

const TLS_HINT = /ssl|tls|certificate|憑證|安全連線|-120[0-6]/i

export function classifyProbeError(detail: string): VerifyProbe {
  if (detail === "timeout") return "failed"
  if (TLS_HINT.test(detail)) return "tls"
  return "dns"
}

async function probe(url: string): Promise<VerifyProbe> {
  try {
    await http(url, { Accept: "application/json" }, 6)
    return "responded"
  } catch (error) {
    return classifyProbeError(error instanceof ControlDError ? error.detail : messageOf(error))
  }
}

/** 同時測主網域與隨機子網域（避免 DNS 快取），任一解析成功就算走 Control D。 */
export async function probeVerify(): Promise<VerifyProbe> {
  const label = Math.random().toString(36).slice(2, 10) || "check"
  const results = await Promise.all([probe(`https://${VERIFY_HOST}/`), probe(`https://${label}.${VERIFY_HOST}/`)])
  if (results.includes("responded")) return "responded"
  if (results.includes("tls")) return "tls"
  if (results.includes("dns")) return "dns"
  return "failed"
}

/** 搭配 API 是否連得上判斷：API 通、verify 解析不到才確定「沒走」。 */
export function verdictOf(result: VerifyProbe, apiReachable: boolean): Verify {
  if (result === "responded" || result === "tls") return "yes"
  if (result === "dns" && apiReachable) return "no"
  return "unknown"
}

// ── 快照（App 與小工具共用）──────────────────────────────────

export interface Snapshot {
  fetchedAt: number
  range: RangeKey
  start: number
  end: number
  stats: Counts | null
  prev: Counts | null
  statsError: string
  devices: Device[] | null
  devicesError: string
  top: RankRow[] | null
  verify: Verify
  /** 致命錯誤（沒有 Token、Token 無效、完全連不上） */
  error: string
  errorCode: ErrorCode | ""
  /** 有部分資料來自先前的快取 */
  stale: boolean
}

function emptySnapshot(range: RangeKey, now: number): Snapshot {
  const w = rangeWindow(range, now)
  return {
    fetchedAt: now, range, start: w.start, end: w.end,
    stats: null, prev: null, statsError: "", devices: null, devicesError: "", top: null,
    verify: "unknown", error: "", errorCode: "", stale: false,
  }
}

export function parseCounts(value: any): Counts | null {
  if (!value || typeof value !== "object") return null
  const keys = ["total", "blocked", "bypassed", "redirected"] as const
  const out: any = {}
  for (const key of keys) {
    const n = Number(value[key])
    if (!Number.isFinite(n) || n < 0) return null
    out[key] = n
  }
  return out as Counts
}

export function getCachedSnapshot(): Snapshot | null {
  const value = storageGet(SNAPSHOT_KEY)
  const range = parseRange(value?.range)
  if (!value || typeof value !== "object" || !range) return null
  const snap = emptySnapshot(range, Number(value.fetchedAt) || 0)
  snap.start = Number(value.start) || snap.start
  snap.end = Number(value.end) || snap.end
  snap.stats = parseCounts(value.stats)
  snap.prev = parseCounts(value.prev)
  snap.statsError = typeof value.statsError === "string" ? value.statsError : ""
  snap.devices = Array.isArray(value.devices) ? parseDevices({ devices: value.devices.map(deviceRow) }) : null
  snap.devicesError = typeof value.devicesError === "string" ? value.devicesError : ""
  snap.top = Array.isArray(value.top) ? parseRank({ counts: value.top }) : null
  snap.verify = value.verify === "yes" || value.verify === "no" ? value.verify : "unknown"
  return snap
}

// 快取存的是整理後的 Device，讀回時轉成 API 欄位名稱再走同一個解析流程
function deviceRow(d: any) {
  return {
    device_id: d?.id, name: d?.name, status: d?.status,
    profile: { name: d?.profile }, profile2: { name: d?.profile2 },
    last_activity: d?.lastActivity, stats: d?.logging,
  }
}

/**
 * 讀取全部資料：端點、統計（含前一期）、這支 iPhone 的 DNS 驗證，大尺寸另外讀網域排行。
 * 各部分獨立失敗；連線失敗的部分沿用同一區間的快取並標示 stale。
 */
export async function loadSnapshot(opts: { range?: RangeKey; top?: boolean; now?: number } = {}): Promise<Snapshot> {
  const now = opts.now ?? Date.now()
  const range = opts.range ?? getSettings().range
  const snap = emptySnapshot(range, now)
  const token = getToken()
  if (!token) {
    snap.error = "尚未設定 API Token"
    snap.errorCode = "NO_TOKEN"
    return snap
  }
  const w: Window = { start: snap.start, end: snap.end }

  let statsHost = ""
  const statsTask = (async () => {
    const endpoint = await resolveStatsEndpoint(token, now)
    if (!endpoint) throw new ControlDError("API", "帳號沒有統計主機，可能尚未開啟分析紀錄")
    const base = analyticsBase(endpoint)
    statsHost = base.replace(/^https?:\/\//i, "").replace(/\/.*$/, "")
    const [stats, prev, top] = await Promise.all([
      fetchCounts(base, token, w),
      fetchPrevious(base, token, range, w, now).catch(() => null),
      opts.top ? fetchTopBlocked(base, token, w).catch(() => null) : Promise.resolve(null),
    ])
    return { stats, prev, top }
  })()

  const [devicesResult, statsResult, verifyResult] = await Promise.allSettled([
    fetchDevices(token),
    statsTask,
    probeVerify(),
  ])
  const cached = getCachedSnapshot()
  // 統計只沿用 6 小時內、同一區間的快取；「今天」還要是同一天
  const sameRange = cached && cached.range === range && now - cached.fetchedAt < 6 * HOUR &&
    (range !== "today" || cached.start === snap.start) ? cached : null

  if (devicesResult.status === "fulfilled") {
    snap.devices = devicesResult.value
  } else {
    snap.devicesError = messageOf(devicesResult.reason)
    if (codeOf(devicesResult.reason) === "NETWORK" && cached?.devices) {
      snap.devices = cached.devices
      snap.stale = true
    }
  }

  if (statsResult.status === "fulfilled") {
    snap.stats = statsResult.value.stats
    snap.prev = statsResult.value.prev
    snap.top = statsResult.value.top
  } else {
    snap.statsError = statsErrorText(statsResult.reason, statsHost)
    if (codeOf(statsResult.reason) === "NETWORK" && sameRange?.stats) {
      snap.stats = sameRange.stats
      snap.prev = sameRange.prev
      snap.top = sameRange.top
      snap.start = sameRange.start
      snap.end = sameRange.end
      snap.stale = true
    }
  }

  const devicesCode = devicesResult.status === "rejected" ? codeOf(devicesResult.reason) : ""
  const statsCode = statsResult.status === "rejected" ? codeOf(statsResult.reason) : ""
  // API 有任何回應（含錯誤碼）就代表網路是通的
  const apiReachable = devicesCode !== "NETWORK" || statsCode !== "NETWORK"
  snap.verify = verifyResult.status === "fulfilled" ? verdictOf(verifyResult.value, apiReachable) : "unknown"

  if (devicesCode === "AUTH") {
    snap.error = "API Token 無效或權限不足"
    snap.errorCode = "AUTH"
    return snap
  }
  if (devicesCode === "NETWORK" && statsCode === "NETWORK" && !snap.stale) {
    snap.error = "網路連線失敗"
    snap.errorCode = "NETWORK"
    return snap
  }
  if (snap.stale && cached) snap.fetchedAt = Math.min(snap.fetchedAt, cached.fetchedAt)

  if (!snap.stale && (snap.devices || snap.stats)) {
    storageSet(SNAPSHOT_KEY, {
      fetchedAt: snap.fetchedAt, range, start: snap.start, end: snap.end,
      stats: snap.stats, prev: snap.prev, statsError: snap.statsError,
      devices: snap.devices, devicesError: snap.devicesError, top: snap.top, verify: snap.verify,
    })
  }
  return snap
}

/** 小工具等太久時：有快取就顯示快取（標示離線資料），沒有就顯示錯誤。 */
export function fallbackSnapshot(range: RangeKey | undefined, now: number, message = "連線逾時"): Snapshot {
  const cached = getCachedSnapshot()
  if (cached && (cached.devices || cached.stats)) return { ...cached, stale: true }
  const snap = emptySnapshot(range ?? getSettings().range, now)
  snap.error = message
  snap.errorCode = "NETWORK"
  return snap
}

/** 所有端點都沒開分析紀錄時，統計一定是 0 */
export function loggingDisabled(snap: Snapshot): boolean {
  return !!snap.devices && snap.devices.length > 0 && snap.devices.every((d) => d.logging === 0)
}

/**
 * 統計主機連不上時寫出主機名稱與系統的原始錯誤，方便判斷是不是被擋
 * （Surge 或擋廣告規則常用「analytics」關鍵字封鎖網域）。
 */
export function statsErrorText(error: unknown, host: string): string {
  if (!(error instanceof ControlDError) || error.code !== "NETWORK" || !host) return messageOf(error)
  const detail = error.detail && error.detail !== "timeout" ? error.detail : error.message
  return `連不到統計主機 ${host}（${detail}）。有用 Surge 或擋廣告規則的話，請讓 *.analytics.controld.com 直連放行。`
}

export function nextReload(snap: Snapshot, now: number): number {
  if (snap.errorCode === "NO_TOKEN" || snap.errorCode === "AUTH") return now + 6 * HOUR
  return now + RELOAD_EVERY
}

// ── 顯示用 ───────────────────────────────────────────────────

function trimZero(text: string): string {
  return text.replace(/\.0$/, "")
}

function withCommas(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
}

/** 1,234／1.2 萬／123 萬／1.2 億 */
export function fmtCount(n: number): string {
  if (!Number.isFinite(n)) return "—"
  if (n < 10_000) return withCommas(n)
  if (n < 100_000_000) {
    const wan = n / 10_000
    return `${trimZero(wan < 100 ? wan.toFixed(1) : String(Math.round(wan)))} 萬`
  }
  const yi = n / 100_000_000
  return `${trimZero(yi < 100 ? yi.toFixed(1) : String(Math.round(yi)))} 億`
}

/** 封鎖比例 0–1 */
export function blockedRatio(c: Counts | null): number {
  return c && c.total > 0 ? c.blocked / c.total : 0
}

export function fmtPct(part: number, total: number): string {
  if (!(total > 0)) return "—"
  const pct = (part / total) * 100
  return `${pct > 0 && pct < 0.1 ? "<0.1" : pct.toFixed(1)}%`
}

/** 跟前一期比較查詢量；前一期沒有資料時回傳 null。 */
export function trendOf(cur: Counts | null, prev: Counts | null): { text: string; dir: "up" | "down" | "flat" } | null {
  if (!cur || !prev || !(prev.total > 0)) return null
  const change = ((cur.total - prev.total) / prev.total) * 100
  if (Math.abs(change) < 0.5) return { text: "持平", dir: "flat" }
  const value = Math.abs(change) >= 10 ? Math.round(Math.abs(change)) : Math.abs(change).toFixed(1)
  return { text: `${change > 0 ? "↑" : "↓"}${trimZero(String(value))}%`, dir: change > 0 ? "up" : "down" }
}

export function fmtAgo(ts: number, now: number): string {
  if (!ts) return "沒有紀錄"
  const diff = Math.max(0, now - ts)
  if (diff < MIN) return "剛剛"
  if (diff < HOUR) return `${Math.floor(diff / MIN)} 分鐘前`
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小時前`
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)} 天前`
  return "超過 30 天"
}

/** 台灣時間 HH:mm（跨日加上 M/D） */
export function fmtTime(ts: number, now: number = Date.now()): string {
  if (!ts) return "—"
  const d = new Date(ts + TAIPEI_OFFSET)
  const pad = (n: number) => String(n).padStart(2, "0")
  const hm = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
  return startOfTaipeiDay(ts) === startOfTaipeiDay(now) ? hm : `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${hm}`
}

export function verifyText(v: Verify): string {
  return v === "yes" ? "這支 iPhone 走 Control D" : v === "no" ? "這支 iPhone 沒走 Control D" : "無法判斷 DNS 路徑"
}

export function onlineCount(devices: Device[] | null, now: number): { online: number; total: number } {
  const list = devices ?? []
  return { online: list.filter((d) => isOnline(d, now)).length, total: list.length }
}

// File: src/unlock.ts
// 串流與 AI 服務解鎖檢測。
// 深度檢測（判斷地區與可用程度）：YouTube Premium、Netflix、Disney+、巴哈姆特動畫瘋、ChatGPT。
// 連線檢測（僅確認可連線與該服務實際出口地區）：Spotify、Prime Video、Claude、Gemini、Copilot、Grok、Perplexity。
import { fetch } from "scripting"
import { withTimeout } from "../utils/geo"
import { freshUrl, parseTrace } from "./net"
import type { ServiceInfo } from "./types"

export type ServiceGroup = "media" | "ai"
export type ServiceId =
  | "youtube" | "netflix" | "disney" | "bahamut" | "spotify" | "prime"
  | "chatgpt" | "claude" | "gemini" | "copilot" | "grok" | "perplexity"
export type { ServiceState } from "./types"
import type { ServiceState } from "./types"

export interface ServiceResult {
  id: ServiceId
  name: string
  group: ServiceGroup
  state: ServiceState
  /** 該服務實際判定的地區（兩碼國家代碼）；未知為空字串 */
  region: string
  detail: string
}

type ServiceMeta = { id: ServiceId; name: string; group: ServiceGroup }

export const SERVICES: ServiceMeta[] = [
  { id: "youtube", name: "YouTube", group: "media" },
  { id: "netflix", name: "Netflix", group: "media" },
  { id: "disney", name: "Disney+", group: "media" },
  { id: "bahamut", name: "動畫瘋", group: "media" },
  { id: "spotify", name: "Spotify", group: "media" },
  { id: "prime", name: "Prime Video", group: "media" },
  { id: "chatgpt", name: "ChatGPT", group: "ai" },
  { id: "claude", name: "Claude", group: "ai" },
  { id: "gemini", name: "Gemini", group: "ai" },
  { id: "copilot", name: "Copilot", group: "ai" },
  { id: "grok", name: "Grok", group: "ai" },
  { id: "perplexity", name: "Perplexity", group: "ai" },
]

/** 連線檢測的目標；trace 為 Cloudflare 站點的 /cdn-cgi/trace，可讀出該服務實際出口地區。 */
const REACH_TARGETS: Partial<Record<ServiceId, { url: string; trace?: string }>> = {
  spotify: { url: "https://open.spotify.com/" },
  prime: { url: "https://www.primevideo.com/" },
  claude: { url: "https://claude.ai/", trace: "https://claude.ai/cdn-cgi/trace" },
  gemini: { url: "https://gemini.google.com/" },
  copilot: { url: "https://copilot.microsoft.com/" },
  grok: { url: "https://grok.com/", trace: "https://grok.com/cdn-cgi/trace" },
  perplexity: { url: "https://www.perplexity.ai/", trace: "https://www.perplexity.ai/cdn-cgi/trace" },
}

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
/** OpenAI 未提供服務的地區。 */
const CHATGPT_UNSUPPORTED = ["CN", "HK", "MO", "RU", "KP", "CU", "IR", "SY", "BY", "VE"]

export function makeService(id: ServiceId, state: ServiceState, region = "", detail = ""): ServiceResult {
  const meta = SERVICES.find(item => item.id === id)!
  return { id, name: meta.name, group: meta.group, state, region: regionCode(region), detail }
}

export const PENDING_DETAIL = "檢測中…"

export function pendingServices(): ServiceResult[] {
  return SERVICES.map(item => makeService(item.id, "na", "", PENDING_DETAIL))
}

export function regionCode(value: unknown): string {
  const code = typeof value === "string" ? value.trim().toUpperCase() : ""
  return /^[A-Z]{2}$/.test(code) ? code : ""
}

type HttpResult = { status: number; text: string; url: string; header: (name: string) => string }

async function request(url: string, init: {
  method?: string; headers?: Record<string, string>; body?: string; timeout?: number
} = {}): Promise<HttpResult> {
  const seconds = init.timeout ?? 6
  return withTimeout(async () => {
    const response = await fetch(freshUrl(url), {
      method: init.method,
      headers: {
        "User-Agent": UA, "Accept-Language": "en", Accept: "*/*",
        "Cache-Control": "no-cache, no-store, max-age=0", Pragma: "no-cache",
        ...init.headers,
      },
      body: init.body,
      timeout: seconds,
    })
    const text = await response.text()
    return {
      status: response.status, text, url: response.url || url,
      header: (name: string) => response.headers.get(name) ?? "",
    }
  }, seconds * 1000 + 500)
}

// ── YouTube Premium ──────────────────────────────────────────

export function parseYoutube(status: number, html: string): ServiceResult {
  if (status !== 200) return makeService("youtube", "na", "", "檢測失敗")
  if (html.includes("Premium is not available in your country")) {
    return makeService("youtube", "no", "", "此地區未開放 Premium")
  }
  const region = regionCode(html.match(/"countryCode":"(.*?)"/)?.[1]) || "US"
  return makeService("youtube", "ok", region, "可訂閱 Premium")
}

async function checkYoutube(): Promise<ServiceResult> {
  try {
    const res = await request("https://www.youtube.com/premium")
    return parseYoutube(res.status, res.text)
  } catch { return makeService("youtube", "na", "", "檢測失敗") }
}

// ── Netflix ─────────────────────────────────────────────────

/** 由最終網址（如 https://www.netflix.com/tw/title/…）取出地區；沒有地區路徑時為美國。 */
export function netflixRegion(raw: string): string {
  const segment = (raw.split("/")[3] || "").split("-")[0]
  return segment.toLowerCase() === "title" ? "US" : regionCode(segment) || "US"
}

type NetflixProbe = { kind: "region"; region: string } | { kind: "missing" | "blocked" | "error" }

async function probeNetflix(titleId: number): Promise<NetflixProbe> {
  try {
    const res = await request(`https://www.netflix.com/title/${titleId}`)
    if (res.status === 403) return { kind: "blocked" }
    if (res.status === 404) return { kind: "missing" }
    if (res.status === 200) return { kind: "region", region: netflixRegion(res.header("x-originating-url") || res.url) }
    return { kind: "error" }
  } catch { return { kind: "error" } }
}

/** first：非自製影片（需完整片庫）；second：Netflix 自製影片（僅自製也看得到）。 */
export function judgeNetflix(first: NetflixProbe, second: NetflixProbe): ServiceResult {
  if (first.kind === "region") return makeService("netflix", "ok", first.region, "完整片庫")
  if (first.kind === "blocked") return makeService("netflix", "no", "", "此地區未開放")
  if (first.kind === "error") return makeService("netflix", "na", "", "檢測失敗")
  if (second.kind === "region") return makeService("netflix", "warn", second.region, "僅自製影片")
  if (second.kind === "missing" || second.kind === "blocked") return makeService("netflix", "no", "", "此地區未開放")
  return makeService("netflix", "na", "", "檢測失敗")
}

async function checkNetflix(): Promise<ServiceResult> {
  const [first, second] = await Promise.all([probeNetflix(81280792), probeNetflix(80018499)])
  return judgeNetflix(first, second)
}

// ── Disney+ ─────────────────────────────────────────────────

type DisneyOutcome = "unavailable" | "error"
class DisneyError extends Error {
  outcome: DisneyOutcome
  constructor(outcome: DisneyOutcome) {
    super(outcome)
    this.outcome = outcome
  }
}

async function disneyHome(): Promise<string> {
  const res = await request("https://www.disneyplus.com/", { timeout: 5 })
  if (res.status !== 200 || res.text.includes("Sorry, Disney+ is not available in your region.")) {
    throw new DisneyError("unavailable")
  }
  return regionCode(res.text.match(/Region: ([A-Za-z]{2})[\s\S]*?CNBL: ([12])/)?.[1])
}

async function disneyLocation(): Promise<{ countryCode: string; supported: boolean }> {
  // 與 Disney+ 網頁版相同的公開裝置註冊請求，只用來讀取服務判定的地區。
  const res = await request("https://disney.api.edge.bamgrid.com/graph/v1/device/graphql", {
    method: "POST", timeout: 5,
    headers: {
      Authorization: "ZGlzbmV5JmJyb3dzZXImMS4wLjA.Cu56AgSfBTDag5NiRA81oLHkDZfu5L3CKadnefEAY84",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: "mutation registerDevice($input: RegisterDeviceInput!) { registerDevice(registerDevice: $input) { grant { grantType assertion } } }",
      variables: { input: {
        applicationRuntime: "chrome",
        attributes: {
          browserName: "chrome", browserVersion: "124.0.0", manufacturer: "apple", model: null,
          operatingSystem: "macintosh", operatingSystemVersion: "10.15.7", osDeviceIds: [],
        },
        deviceFamily: "browser", deviceLanguage: "en", deviceProfile: "macosx",
      } },
    }),
  })
  if (res.status !== 200) throw new DisneyError("unavailable")
  let data: any
  try { data = JSON.parse(res.text) } catch { throw new DisneyError("error") }
  if (data?.errors) throw new DisneyError("unavailable")
  const session = data?.extensions?.sdk?.session
  const countryCode = session?.location?.countryCode
  const supported = session?.inSupportedLocation
  if (countryCode == null && supported == null) throw new DisneyError("error")
  return { countryCode: regionCode(countryCode), supported: !(supported === false || supported === "false") }
}

async function checkDisney(): Promise<ServiceResult> {
  const [home, location] = await Promise.allSettled([disneyHome(), disneyLocation()])
  const failed = home.status === "rejected" ? home.reason : location.status === "rejected" ? location.reason : null
  if (failed || home.status !== "fulfilled" || location.status !== "fulfilled") {
    return failed instanceof DisneyError && failed.outcome === "unavailable"
      ? makeService("disney", "no", "", "此地區未開放")
      : makeService("disney", "na", "", "檢測失敗")
  }
  const region = location.value.countryCode || home.value
  return location.value.supported
    ? makeService("disney", "ok", region, "可觀看")
    : makeService("disney", "soon", region, "即將上線")
}

// ── 巴哈姆特動畫瘋（僅限台灣 IP）─────────────────────────────

export function parseBahamut(status: number, body: string): ServiceResult {
  if (status === 200 && body.includes("animeSn")) return makeService("bahamut", "ok", "TW", "可觀看")
  if (status > 0 && status < 500 && /"error"/.test(body)) return makeService("bahamut", "no", "", "限台灣地區觀看")
  return makeService("bahamut", "na", "", "檢測失敗")
}

async function checkBahamut(): Promise<ServiceResult> {
  try {
    const device = await request("https://ani.gamer.com.tw/ajax/getdeviceid.php")
    const deviceId = String(JSON.parse(device.text)?.deviceid || "")
    if (!deviceId) return makeService("bahamut", "na", "", "檢測失敗")
    const token = await request(
      `https://ani.gamer.com.tw/ajax/token.php?adID=89422&sn=37783&device=${encodeURIComponent(deviceId)}`)
    return parseBahamut(token.status, token.text)
  } catch { return makeService("bahamut", "na", "", "檢測失敗") }
}

// ── ChatGPT ─────────────────────────────────────────────────

export function judgeChatGPT(country: string, app: "ok" | "blocked" | "error"): ServiceResult {
  const region = regionCode(country)
  if (!region || CHATGPT_UNSUPPORTED.includes(region)) return makeService("chatgpt", "no", region, "此地區不支援")
  if (app === "ok") return makeService("chatgpt", "ok", region, "網頁與 App 皆可用")
  if (app === "blocked") return makeService("chatgpt", "warn", region, "網頁可用，App 受限")
  return makeService("chatgpt", "warn", region, "網頁可用，App 未確認")
}

async function checkChatGPT(): Promise<ServiceResult> {
  try {
    const [web, app] = await Promise.all([
      request("https://chatgpt.com/cdn-cgi/trace", { headers: { Referer: "https://chatgpt.com/" } }),
      request("https://ios.chat.openai.com/", {
        headers: { Accept: "*/*;q=0.8,application/signed-exchange;v=b3;q=0.7", "Accept-Language": "en-US,en;q=0.9" },
      }).then(res => res.text.toLowerCase().includes("vpn") ? "blocked" as const : "ok" as const)
        .catch(() => "error" as const),
    ])
    if (web.status !== 200) return makeService("chatgpt", "na", "", "檢測失敗")
    return judgeChatGPT(parseTrace(web.text).loc || "", app)
  } catch { return makeService("chatgpt", "na", "", "檢測失敗") }
}

// ── 連線檢測 ─────────────────────────────────────────────────

/**
 * 只確認連得上；HTTP 403 也可能是防機器人驗證，因此 5xx 以下一律視為可連線。
 * 不代表帳號可在該地區註冊或付費。
 */
export function judgeReach(id: ServiceId, status: number, region: string): ServiceResult {
  if (status === 451) return makeService(id, "no", region, "此地區依法無法提供")
  if (status >= 200 && status < 500) return makeService(id, "ok", region, "可連線")
  if (status >= 500) return makeService(id, "na", region, `服務異常（HTTP ${status}）`)
  return makeService(id, "no", "", "無法連線")
}

async function checkReach(id: ServiceId, fallbackRegion: string): Promise<ServiceResult> {
  const target = REACH_TARGETS[id]!
  if (target.trace) {
    try {
      const trace = await request(target.trace)
      const region = trace.status === 200 ? regionCode(parseTrace(trace.text).loc) : ""
      if (region) return makeService(id, "ok", region, "可連線")
    } catch { /* 改用首頁檢測 */ }
  }
  try {
    const res = await request(target.url, { timeout: 8 })
    return judgeReach(id, res.status, fallbackRegion)
  } catch { return judgeReach(id, 0, "") }
}

function checkService(id: ServiceId, fallbackRegion: string): Promise<ServiceResult> {
  switch (id) {
    case "youtube": return checkYoutube()
    case "netflix": return checkNetflix()
    case "disney": return checkDisney()
    case "bahamut": return checkBahamut()
    case "chatgpt": return checkChatGPT()
    default: return checkReach(id, fallbackRegion)
  }
}

/**
 * 並行檢測全部服務；每完成一項就呼叫 onResult，方便頁面逐項更新。
 * fallbackRegion 為主要出口的國家代碼，供無法自行判定地區的服務使用。
 */
export async function checkServices(
  fallbackRegion: () => string = () => "",
  onResult?: (result: ServiceResult) => void,
): Promise<ServiceResult[]> {
  return Promise.all(SERVICES.map(async meta => {
    let result: ServiceResult
    try { result = await withTimeout(checkService(meta.id, regionCode(fallbackRegion())), 12000) }
    catch { result = makeService(meta.id, "na", "", "檢測逾時") }
    try { onResult?.(result) } catch { /* 頁面已關閉 */ }
    return result
  }))
}

export function mergeService(list: ServiceResult[], result: ServiceResult): ServiceResult[] {
  return list.map(item => item.id === result.id ? result : item)
}

export function stateLabel(state: ServiceState): string {
  switch (state) {
    case "ok": return "可用"
    case "warn": return "部分可用"
    case "soon": return "即將上線"
    case "no": return "不可用"
    default: return "未知"
  }
}

/** 可用（含部分可用）數量統計。 */
export function countUsable(list: ServiceResult[], group: ServiceGroup): { ok: number; total: number } {
  const items = list.filter(item => item.group === group)
  return { ok: items.filter(item => item.state === "ok" || item.state === "warn").length, total: items.length }
}

/** 轉成快照用的服務項目；沒有自行判定地區的服務以主要出口地區補上。 */
export function toServiceInfo(result: ServiceResult, fallbackRegion = ""): ServiceInfo {
  const usable = result.state === "ok" || result.state === "warn"
  return {
    id: result.id,
    name: result.name,
    ok: usable,
    cc: result.region || (usable ? regionCode(fallbackRegion) : ""),
    policy: "",
    state: result.state,
    note: result.detail,
  }
}

/** 小工具與頁面共用的狀態文字；沒有 state 的項目（Surge 連線檢測）只分可用與失敗。 */
export function serviceStateText(item: Pick<ServiceInfo, "ok" | "state">): string {
  if (!item.state) return item.ok ? "可用" : "失敗"
  return item.state === "ok" ? "可用" : item.state === "warn" ? "部分" : item.state === "soon" ? "將上線"
    : item.state === "no" ? "不可用" : "未知"
}

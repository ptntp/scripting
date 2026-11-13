// 網路工具：帶逾時的 fetch、並行池、IP 判定、國旗、遮蔽。
import { AbortController, fetch } from "scripting"

export const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"

export type TextResult = { ok: boolean; status: number; text: string; ms: number }

export async function httpText(url: string, timeoutMs = 9000, headers: Record<string, string> = {}): Promise<TextResult> {
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => {
    try { controller.abort() } catch (_) {}
  }, timeoutMs)

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "User-Agent": UA,
        Accept: "application/json,text/plain,text/html,*/*",
        "Cache-Control": "no-cache",
        ...headers,
      },
    })
    const text = await response.text()
    return { ok: response.ok, status: response.status, text, ms: Math.max(1, Date.now() - started) }
  } catch (_) {
    return { ok: false, status: 0, text: "", ms: Math.max(1, Date.now() - started) }
  } finally {
    clearTimeout(timer)
  }
}

export async function httpJson<T = any>(
  url: string,
  timeoutMs = 9000,
  headers: Record<string, string> = {}
): Promise<{ ok: boolean; status: number; data: T | null; ms: number }> {
  const result = await httpText(url, timeoutMs, headers)
  if (!result.text) return { ok: false, status: result.status, data: null, ms: result.ms }
  try {
    return { ok: result.status > 0 && result.status < 500, status: result.status, data: JSON.parse(result.text) as T, ms: result.ms }
  } catch (_) {
    return { ok: false, status: result.status, data: null, ms: result.ms }
  }
}

/** 加上時間戳避免命中快取。 */
export function freshUrl(url: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}_=${Date.now()}`
}

/** 解析 Cloudflare /cdn-cgi/trace 的 key=value 文字。 */
export function parseTrace(text: string): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const line of String(text || "").split("\n")) {
    const index = line.indexOf("=")
    if (index <= 0) continue
    fields[line.slice(0, index).trim()] = line.slice(index + 1).trim()
  }
  return fields
}

/** 並行數受限的 map，避免一次發出幾十個請求。 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  const runners: Promise<void>[] = []
  const size = Math.max(1, Math.min(limit, items.length || 1))
  for (let i = 0; i < size; i += 1) {
    runners.push((async () => {
      while (cursor < items.length) {
        const index = cursor
        cursor += 1
        results[index] = await worker(items[index], index)
      }
    })())
  }
  await Promise.all(runners)
  return results
}

export function clean(value: unknown): string {
  if (value === null || value === undefined) return ""
  return String(value).trim()
}

/** 節點名稱裡常見的地區字樣；節點由供應商命名，因此同時收錄繁體與簡體。 */
const COUNTRY_NAMES: [string, string][] = [
  ["台灣", "TW"], ["臺灣", "TW"], ["台湾", "TW"], ["香港", "HK"], ["澳門", "MO"], ["澳门", "MO"],
  ["日本", "JP"], ["韓國", "KR"], ["韩国", "KR"], ["新加坡", "SG"], ["美國", "US"], ["美国", "US"],
  ["英國", "GB"], ["英国", "GB"], ["德國", "DE"], ["德国", "DE"], ["法國", "FR"], ["法国", "FR"],
  ["荷蘭", "NL"], ["荷兰", "NL"], ["加拿大", "CA"], ["澳洲", "AU"], ["澳大利亞", "AU"], ["澳大利亚", "AU"],
  ["印度尼西亞", "ID"], ["印度尼西亚", "ID"], ["印尼", "ID"], ["印度", "IN"], ["土耳其", "TR"],
  ["越南", "VN"], ["泰國", "TH"], ["泰国", "TH"], ["馬來西亞", "MY"], ["马来西亚", "MY"],
  ["菲律賓", "PH"], ["菲律宾", "PH"], ["阿聯", "AE"], ["阿联酋", "AE"], ["巴西", "BR"], ["阿根廷", "AR"],
  ["南非", "ZA"], ["俄羅斯", "RU"], ["俄罗斯", "RU"], ["烏克蘭", "UA"], ["乌克兰", "UA"],
  ["中國", "CN"], ["中国", "CN"],
]

/** 從國碼、旗幟 emoji 或地區名稱取得兩碼國家代碼；取不到回傳空字串。 */
export function countryCode(value: unknown): string {
  const raw = clean(value)
  if (!raw) return ""
  const upper = raw.toUpperCase()
  if (/^[A-Z]{2}$/.test(upper)) return upper
  return regionOfName(raw)
}

/**
 * 從節點或策略名稱推斷地區。和 countryCode 不同，單獨兩個字母（例如策略群組「AI」）
 * 不會直接當成國碼，只認旗幟、地名與常見國碼。
 */
export function regionOfName(value: unknown): string {
  const raw = clean(value)
  if (!raw) return ""
  // 旗幟 emoji 由兩個區域指示符號組成
  const points = Array.from(raw).map(char => char.codePointAt(0) || 0)
  for (let i = 0; i + 1 < points.length; i += 1) {
    const a = points[i] - 0x1f1e6
    const b = points[i + 1] - 0x1f1e6
    if (a >= 0 && a < 26 && b >= 0 && b < 26) return String.fromCharCode(65 + a, 65 + b)
  }
  for (const [name, code] of COUNTRY_NAMES) if (raw.includes(name)) return code
  // 「TW 01」「JP-Tokyo」這類以國碼開頭或獨立成詞的節點名稱
  const token = raw.match(/(?:^|[^A-Za-z])([A-Z]{2})(?=$|[^A-Za-z])/)
  return token && REGION_CODES.has(token[1]) ? token[1] : ""
}

const REGION_CODES = new Set([
  // 刻意不收 IN、ID、IT、NO、AT 這類容易與一般英文單字相撞的代碼
  "TW", "HK", "MO", "JP", "KR", "SG", "US", "GB", "UK", "DE", "FR", "NL", "CA", "AU", "TR", "VN", "TH",
  "MY", "PH", "AE", "BR", "AR", "ZA", "RU", "UA", "CH", "SE", "ES", "PL", "IE", "FI", "DK", "MX",
])

export function flagOf(cc: string): string {
  const code = countryCode(cc)
  if (!code) return ""
  const iso = code === "UK" ? "GB" : code
  return String.fromCodePoint(...iso.split("").map((char) => 127397 + char.charCodeAt(0)))
}

export function maskIP(ip: string): string {
  const value = clean(ip)
  if (!value) return value
  const parts = value.split(".")
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.*.*`
  const groups = value.split(":")
  if (groups.length > 2) return `${groups.slice(0, 2).join(":")}:***`
  return value
}

export function parseIPv4(ip: string): number[] | null {
  const parts = clean(ip).split(".")
  if (parts.length !== 4) return null
  const values = parts.map(Number)
  if (values.some((v) => !Number.isInteger(v) || v < 0 || v > 255)) return null
  return values
}

export function isPrivateIPv4(ip: string): boolean {
  const parts = parseIPv4(ip)
  if (!parts) return false
  return parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168)
}

export function isCGNATIPv4(ip: string): boolean {
  const parts = parseIPv4(ip)
  return Boolean(parts && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
}

export function isPublicIPv4(ip: string): boolean {
  const parts = parseIPv4(ip)
  if (!parts) return false
  return !isPrivateIPv4(ip) && !isCGNATIPv4(ip) && parts[0] !== 0 && parts[0] !== 127 && parts[0] < 224
    && !(parts[0] === 169 && parts[1] === 254)
}

/**
 * 依本機位址類別推估 NAT 狀態，無法取代 STUN 的 NAT 類型測試。
 * CGNAT：電信級 NAT；NAT：一般路由器；公網：本機直接持有公網位址。
 */
export function detectNAT(localIP: string): string {
  if (isCGNATIPv4(localIP)) return "CGNAT"
  if (isPrivateIPv4(localIP)) return "NAT"
  if (isPublicIPv4(localIP)) return "公網"
  return "未知"
}

/** 台灣常見電信業者簡稱；其餘截短顯示。 */
export function shortCarrier(value: string): string {
  const text = clean(value)
  if (!text) return ""
  if (/chunghwa|hinet|中華電信/i.test(text)) return "中華電信"
  if (/taiwan mobile|台灣大哥大|twm/i.test(text)) return "台灣大哥大"
  if (/far ?eas ?tone|遠傳|fetnet/i.test(text)) return "遠傳電信"
  if (/kbro|凱擘/i.test(text)) return "凱擘大寬頻"
  if (/taiwan fixed network|台灣固網/i.test(text)) return "台灣固網"
  if (/so-?net/i.test(text)) return "So-net"
  if (/tanet|ministry of education/i.test(text)) return "TANet"
  return text.length > 14 ? text.slice(0, 14) : text
}

export type WidgetKind = "small" | "medium" | "large"

/**
 * 判斷小工具版面。系統可能回報腳本不認得的尺寸名稱（例如直式特大尺寸），
 * 這時改依實際顯示大小決定，避免大尺寸落入小型版面。
 */
export function widgetKind(family: string | undefined, size: { width: number; height: number }): WidgetKind {
  if (family === "systemSmall" || family === "accessoryRectangular" || family === "accessoryCircular") return "small"
  if (family === "systemMedium") return "medium"
  if (family && /large/i.test(family)) return "large"
  if (size.height >= 280) return "large"
  return size.width >= size.height * 1.6 ? "medium" : "small"
}

export function agoLabel(ts: number): string {
  if (!ts) return "從未"
  const diff = Date.now() - ts
  if (diff < 60_000) return "剛剛"
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分鐘前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小時前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

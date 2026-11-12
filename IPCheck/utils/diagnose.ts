// File: utils/diagnose.ts
// 網路診斷：本機網路介面、NAT 判斷、國際／台灣延遲、HTTP/3（QUIC）。
// 所有探測點皆為國際常用或台灣本地服務。
import { Device, fetch } from "scripting"
import { canonicalAddress, isPublicExitAddress } from "./ip"
import { withTimeout } from "./geo"

export type LocalNetworkType = "wifi" | "cellular" | "other" | "unknown"

export interface LocalNetwork {
  type: LocalNetworkType
  /** 本機內網 IPv4；取不到時為空字串 */
  ip: string
  /** 是否有對外的 VPN／通道介面（utun、ipsec、ppp…） */
  vpn: boolean
  /** 是否取得全球單播 IPv6 位址（不含 fe80 連結本地位址） */
  ipv6: boolean
}

export interface QuicResult {
  /** 本次請求實際以 HTTP/3 完成 */
  h3: boolean
  /** 探測點可連線（不論協定） */
  reachable: boolean
  /** Cloudflare 回報的協定字串，例如 http/2、http/3 */
  protocol: string
}

export interface DiagReport {
  local: LocalNetwork
  /** 毫秒；全部探測點失敗時為 null */
  latency: { global: number | null; taiwan: number | null }
  quic: QuicResult
}

/** 國際常用的連線檢查端點（Cloudflare、Google）。 */
export const GLOBAL_LATENCY_URLS = [
  "https://cp.cloudflare.com/generate_204",
  "https://www.gstatic.com/generate_204",
  "https://www.google.com/generate_204",
]

/** 台灣本地站點：中華電信 HiNet、中華電信官網、TWNIC、台灣大學（TANet）。 */
export const TAIWAN_LATENCY_URLS = [
  "https://www.hinet.net/favicon.ico",
  "https://www.cht.com.tw/favicon.ico",
  "https://www.twnic.tw/favicon.ico",
  "https://www.ntu.edu.tw/favicon.ico",
]

export const QUIC_TRACE_URLS = [
  "https://cloudflare-quic.com/cdn-cgi/trace",
  "https://www.cloudflare.com/cdn-cgi/trace",
]

const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"

/** 加上時間戳避免命中快取。 */
export function freshUrl(url: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}_=${Date.now()}`
}

export type TimedResponse = { status: number; text: string; ms: number }

/** 計時 GET；任何失敗都以 status 0 回傳，不拋錯。 */
export async function timedGet(url: string, seconds = 7): Promise<TimedResponse> {
  const started = Date.now()
  const elapsed = () => Math.max(1, Date.now() - started)
  try {
    const result = await withTimeout(async () => {
      const response = await fetch(freshUrl(url), {
        timeout: seconds,
        headers: { "User-Agent": UA, Accept: "*/*", "Cache-Control": "no-cache" },
      })
      return { status: response.status, text: await response.text() }
    }, seconds * 1000 + 500)
    return { ...result, ms: elapsed() }
  } catch {
    return { status: 0, text: "", ms: elapsed() }
  }
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

export function isHttp3(protocol: string): boolean {
  const value = protocol.trim().toLowerCase()
  return value === "h3" || value.includes("h3") || value.includes("http/3")
}

type InterfaceAddress = { address: string; family?: string; isInternal?: boolean }

/** 由網路介面清單判斷連線類型；純函式，方便離線測試。 */
export function classifyInterfaces(interfaces: Record<string, InterfaceAddress[] | undefined>): LocalNetwork {
  let wifi = "", cellular = "", other = ""
  let vpn = false, ipv6 = false
  for (const [name, list] of Object.entries(interfaces || {})) {
    const lower = name.toLowerCase()
    const tunnel = /^(utun|ipsec|ppp|tun|tap|wg)/.test(lower)
    for (const item of list || []) {
      if (!item || item.isInternal) continue
      const address = String(item.address || "").split("%")[0]
      const canonical = canonicalAddress(address)
      if (!canonical) continue
      if (tunnel) { vpn = true; continue }
      if (canonical.includes(":")) {
        if (isPublicExitAddress(canonical)) ipv6 = true
        continue
      }
      if (lower === "en0") wifi = wifi || canonical
      else if (lower.startsWith("pdp_ip")) cellular = cellular || canonical
      else other = other || canonical
    }
  }
  return {
    type: wifi ? "wifi" : cellular ? "cellular" : other ? "other" : "unknown",
    ip: wifi || cellular || other,
    vpn, ipv6,
  }
}

export function readLocalNetwork(): LocalNetwork {
  try { return classifyInterfaces(Device.networkInterfaces() as Record<string, InterfaceAddress[]>) }
  catch { return { type: "unknown", ip: "", vpn: false, ipv6: false } }
}

export function localNetworkLabel(type: LocalNetworkType): string {
  return type === "wifi" ? "Wi-Fi" : type === "cellular" ? "行動網路" : type === "other" ? "其他網路" : "未知網路"
}

/**
 * 以本機位址與出口位址推估 NAT 狀態。
 * 只能判斷位址類別，無法取代 STUN 的 NAT 類型（錐型／對稱型）測試。
 */
export function natLabel(localIP: string, exitIP: string): string {
  const local = canonicalAddress(localIP || "")
  if (!local || local.includes(":")) return "未知"
  const [a, b] = local.split(".").map(Number)
  if (a === 100 && b >= 64 && b <= 127) return "電信級 NAT（CGNAT）"
  if (a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168) return "NAT（私有位址）"
  if (isPublicExitAddress(local)) {
    return canonicalAddress(exitIP || "") === local ? "公網位址（無 NAT）" : "公網位址"
  }
  return "未知"
}

/** 並行量測多個端點，取最快的成功回應；全部失敗回傳 null。 */
export async function measureLatency(urls: string[]): Promise<number | null> {
  const results = await Promise.all(urls.map(url => timedGet(url, 6)))
  const passed = results.filter(item => item.status >= 200 && item.status < 500).map(item => item.ms)
  return passed.length ? Math.min(...passed) : null
}

export async function detectQuic(): Promise<QuicResult> {
  const results = await Promise.all(QUIC_TRACE_URLS.map(url => timedGet(url, 6)))
  let reachable = false
  let protocol = ""
  for (const result of results) {
    if (result.status !== 200 || !result.text) continue
    reachable = true
    const value = parseTrace(result.text).http || ""
    if (!protocol) protocol = value
    if (isHttp3(value)) return { h3: true, reachable: true, protocol: value }
  }
  return { h3: false, reachable, protocol }
}

export function latencyLabel(ms: number | null | undefined): string {
  return typeof ms === "number" && Number.isFinite(ms) ? `${Math.round(ms)} ms` : "無回應"
}

export async function runDiagnostics(): Promise<DiagReport> {
  const [global, taiwan, quic] = await Promise.all([
    measureLatency(GLOBAL_LATENCY_URLS),
    measureLatency(TAIWAN_LATENCY_URLS),
    detectQuic(),
  ])
  return { local: readLocalNetwork(), latency: { global, taiwan }, quic }
}

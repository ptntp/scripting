// 本機自測：出口 IP、純淨度、延遲、HTTP/3（QUIC）、串流與 AI 服務。
// 流程與 Surge 版一致，只是無法依策略群組分別檢測（那需要 Surge 的 policy 能力）。
// 出口地名沿用 IPCheck 的繁體轉換；服務檢測沿用 IP-Media 的深度判定。
import { Device } from "scripting"
import { countryName, isPublicExitAddress } from "../utils/ip"
import { toTraditional } from "../utils/s2t"
import { clean, countryCode, detectNAT, freshUrl, httpJson, httpText } from "./net"
import type { ExitInfo, LocalInfo, ServiceInfo, Snapshot } from "./types"
import { EMPTY_EXIT, EMPTY_LOCAL, KIND, RISK } from "./types"
import { SERVICES, checkServices, toServiceInfo } from "./unlock"

/** 國際常用的連線檢查端點（Cloudflare、Google）。 */
export const GLOBAL_LATENCY_URLS = [
  "https://cp.cloudflare.com/generate_204",
  "https://www.gstatic.com/generate_204",
  "https://www.google.com/generate_204",
]

/** 台灣本地站點：HiNet、中華電信、TWNIC、台灣大學（TANet）。 */
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

export type Flags = {
  proxy: boolean
  vpn: boolean
  tor: boolean
  abuser: boolean
  hosting: boolean
  datacenter: boolean
  mobile: boolean
  residential: boolean
}

const EMPTY_FLAGS: Flags = {
  proxy: false, vpn: false, tor: false, abuser: false, hosting: false, datacenter: false, mobile: false, residential: false,
}

export function classifyKind(flags: Flags): string {
  if (flags.mobile) return KIND.mobile
  if (flags.residential) return KIND.residential
  if (flags.datacenter || flags.hosting) return KIND.hosting
  return KIND.unknown
}

export function purityScore(flags: Flags, kind: string): number {
  const trusted = kind === KIND.residential || kind === KIND.mobile
  let score = trusted ? 92 : kind === KIND.hosting ? 78 : 72
  const proxyVpn = (flags.proxy ? 1 : 0) + (flags.vpn ? 1 : 0)

  if (flags.tor) score -= 55
  if (flags.abuser) score -= 35
  if (proxyVpn >= 2) score -= 30
  else if (proxyVpn === 1) score -= 16
  if (flags.datacenter || flags.hosting) score -= 8
  if (trusted && !proxyVpn && !flags.tor && !flags.abuser) score += 3

  return Math.max(0, Math.min(100, Math.round(score)))
}

export function riskLevel(flags: Flags, score: number): string {
  const proxyVpn = (flags.proxy ? 1 : 0) + (flags.vpn ? 1 : 0)
  if (flags.tor || flags.abuser || score < 45 || (proxyVpn >= 2 && score < 60)) return RISK.high
  if (score < 75 || flags.datacenter || flags.hosting || proxyVpn > 0) return RISK.medium
  return RISK.low
}

/** 台灣獨立顯示；地區與城市去掉資料來源可能附帶的「台灣省」等前綴。 */
function localizePlace(value: string, cc: string): string {
  const name = toTraditional(clean(value))
  if (cc !== "TW") return name
  return name.replace(/^中國\s*/, "").replace(/^台灣(省|地區)?\s*/, "").trim()
}

/** 合併四個來源的回應；純函式，方便離線測試。 */
export function mergeExit(a: any, b: any, c: any, d: any): ExitInfo {
  if (a && a.status && a.status !== "success") a = null // ip-api 被限流時忽略該來源
  if (b && b.success === false) b = null

  const ip = clean(a?.query) || clean(b?.ip) || clean(c?.ip) || clean(d?.ip)
  if (!ip) return { ...EMPTY_EXIT }

  const cc = countryCode(a?.countryCode) || countryCode(b?.country_code)
    || countryCode(c?.location?.country_code) || countryCode(d?.country)
  const country = countryName(cc) || toTraditional(clean(a?.country) || clean(b?.country) || clean(c?.location?.country))
  const region = localizePlace(clean(a?.regionName) || clean(b?.region) || clean(c?.location?.state) || clean(d?.region), cc)
  const city = localizePlace(clean(a?.city) || clean(b?.city) || clean(c?.location?.city) || clean(d?.city), cc)

  let org = clean(a?.org) || clean(b?.connection?.org) || clean(c?.asn?.org)
  let asn = clean(a?.as).split(" ")[0] || (b?.connection?.asn ? `AS${b.connection.asn}` : "") || (c?.asn?.asn ? `AS${c.asn.asn}` : "")
  if (clean(d?.org)) {
    const matched = clean(d.org).match(/^(AS\d+)\s+(.*)$/)
    if (matched) {
      asn = asn || matched[1]
      org = org || matched[2]
    } else {
      org = org || clean(d.org)
    }
  }
  const isp = clean(a?.isp) || clean(b?.connection?.isp) || clean(b?.connection?.org) || clean(c?.company?.name) || org

  const flags: Flags = { ...EMPTY_FLAGS }
  if (a) {
    flags.proxy = a.proxy === true
    flags.hosting = a.hosting === true
    flags.mobile = a.mobile === true
  }
  if (c) {
    flags.mobile = flags.mobile || c.is_mobile === true
    flags.datacenter = c.is_datacenter === true
    flags.proxy = flags.proxy || c.is_proxy === true
    flags.vpn = c.is_vpn === true
    flags.tor = c.is_tor === true
    flags.abuser = c.is_abuser === true
  }
  // 沒有任何來源提供旗標時不能當成住宅 IP。
  flags.residential = Boolean(a || c)
    && !flags.datacenter && !flags.hosting && !flags.proxy && !flags.vpn && !flags.tor && !flags.mobile

  const kind = classifyKind(flags)
  const purity = purityScore(flags, kind)
  return {
    ip, cc, country, region, city, isp, asn, org,
    proxy: flags.proxy || flags.vpn,
    hosting: flags.hosting || flags.datacenter,
    mobile: flags.mobile,
    kind, purity,
    risk: riskLevel(flags, purity),
  }
}

async function collectExit(): Promise<ExitInfo> {
  const [ipApi, ipWho, ipApiIs, ipInfo] = await Promise.all([
    httpJson(freshUrl("http://ip-api.com/json/?lang=zh-CN&fields=status,message,query,country,countryCode,regionName,city,isp,org,as,asname,proxy,hosting,mobile"), 9000),
    httpJson(freshUrl("https://ipwho.is/"), 9000),
    httpJson(freshUrl("https://api.ipapi.is/"), 9000),
    httpJson(freshUrl("https://ipinfo.io/json"), 9000),
  ])
  return mergeExit(ipApi.data, ipWho.data, ipApiIs.data, ipInfo.data)
}

type InterfaceAddress = { address: string; family?: string; isInternal?: boolean }
export type LocalNetwork = { net: string; ip: string; vpn: boolean; v6: boolean }

/** 由網路介面清單判斷連線類型；純函式，方便離線測試。 */
export function classifyInterfaces(interfaces: Record<string, InterfaceAddress[] | undefined>): LocalNetwork {
  let wifi = "", cellular = "", other = ""
  let vpn = false, v6 = false
  for (const [name, list] of Object.entries(interfaces || {})) {
    const lower = name.toLowerCase()
    const tunnel = /^(utun|ipsec|ppp|tun|tap|wg)/.test(lower)
    for (const item of list || []) {
      if (!item || item.isInternal) continue
      const address = clean(item.address).split("%")[0]
      if (!address) continue
      if (address.includes(":")) {
        // 連結本地位址（fe80::）不算取得 IPv6
        if (!tunnel && isPublicExitAddress(address)) v6 = true
        continue
      }
      if (tunnel) { vpn = true; continue }
      if (lower === "en0") wifi = wifi || address
      else if (lower.startsWith("pdp_ip")) cellular = cellular || address
      else other = other || address
    }
  }
  return {
    net: wifi ? "Wi-Fi" : cellular ? "行動網路" : other ? "其他網路" : "未知網路",
    ip: wifi || cellular || other,
    vpn, v6,
  }
}

function readLocalNetwork(): LocalNetwork {
  try { return classifyInterfaces(Device.networkInterfaces() as Record<string, InterfaceAddress[]>) }
  catch (_) { return { net: "未知網路", ip: "", vpn: false, v6: false } }
}

/** 並行量測多個端點，回傳最快成功者的毫秒數；全部失敗為 0。 */
async function measureLatency(urls: string[]): Promise<number> {
  const results = await Promise.all(urls.map((url) => httpText(freshUrl(url), 7000)))
  const passed = results.filter((item) => item.status >= 200 && item.status < 500).map((item) => item.ms)
  return passed.length ? Math.min(...passed) : 0
}

export function isHttp3(protocol: string): boolean {
  const value = protocol.trim().toLowerCase()
  return value === "h3" || value.includes("h3") || value.includes("http/3")
}

async function detectQuic(): Promise<{ ok: boolean; reachable: boolean }> {
  const results = await Promise.all(QUIC_TRACE_URLS.map((url) => httpText(freshUrl(url), 7000)))
  let reachable = false
  for (const result of results) {
    if (!result.ok || !result.text) continue
    reachable = true
    const matched = result.text.match(/^http=(.+)$/m)
    if (matched && isHttp3(matched[1])) return { ok: true, reachable: true }
  }
  return { ok: false, reachable }
}

export function splitServices(items: ServiceInfo[]): { media: ServiceInfo[]; ai: ServiceInfo[] } {
  const group = (name: "media" | "ai") =>
    SERVICES.filter((meta) => meta.group === name)
      .map((meta) => items.find((item) => item.id === meta.id))
      .filter((item): item is ServiceInfo => Boolean(item))
  return { media: group("media"), ai: group("ai") }
}

export async function diagnose(): Promise<Snapshot> {
  const startedAt = Date.now()
  let exitCC = ""

  const exitTask = collectExit().then((exit) => { exitCC = exit.cc; return exit })
  const [exit, proxyLatency, localLatency, quic, results] = await Promise.all([
    exitTask,
    measureLatency(GLOBAL_LATENCY_URLS),
    measureLatency(TAIWAN_LATENCY_URLS),
    detectQuic(),
    checkServices(() => exitCC),
  ])

  const { media, ai } = splitServices(results.map((item) => toServiceInfo(item, exit.cc)))
  const localNet = readLocalNetwork()
  const local: LocalInfo = {
    ...EMPTY_LOCAL,
    net: localNet.net,
    ip: localNet.ip,
    nat: detectNAT(localNet.ip),
    vpn: localNet.vpn,
    v6: localNet.v6,
  }

  return {
    v: 1,
    ts: Date.now(),
    src: "self",
    exit,
    local,
    lat: { proxy: proxyLatency, local: localLatency },
    quic,
    media,
    ai,
    cost: Date.now() - startedAt,
  }
}

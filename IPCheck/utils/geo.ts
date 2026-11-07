import { fetch } from "scripting"
import { canonicalAddress, countryName, formatIPLocation } from "./ip"

export interface GeoRow {
  source: string
  ip: string | null
  location: string
  status: "ok" | "unavailable" | "unsupported"
  note?: string
}
export interface ExitObservation { source: string; ip: string; location: string }
export interface GeoReport { rows: GeoRow[]; exits: ExitObservation[] }

type Location = { ip: string; country: string; code: string; region: string; city: string }
const text = (value: unknown): string => typeof value === "string" ? value.trim() : ""

export async function withTimeout<T>(task: Promise<T> | (() => Promise<T>), ms = 6000, message = "請求逾時"): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      typeof task === "function" ? task() : task,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export function sameIP(a: string, b: string): boolean {
  const key = canonicalAddress(a)
  return key !== null && key === canonicalAddress(b)
}

export { countryName }

async function request(url: string, plain = false): Promise<any> {
  return withTimeout(async () => {
    const response = await fetch(url, { timeout: 6 })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return plain ? response.text() : response.json()
  })
}

function empty(source: string, note: string, status: "unavailable" | "unsupported" = "unavailable"): GeoRow {
  return { source, ip: null, location: "", status, note }
}

export async function collectGeoRow(source: string, target: string, probe: boolean, load: () => Promise<Location>): Promise<GeoRow> {
  try {
    const data = await load()
    if (!canonicalAddress(data.ip)) throw new Error("未回傳有效 IP")
    if (!probe && !sameIP(data.ip, target)) throw new Error("回傳位址不匹配")
    const location = formatIPLocation({
      country: countryName(data.code) || data.country,
      countryCode: data.code, regionName: data.region, city: data.city,
    }, "")
    if (!location) return { source, ip: data.ip, location: "", status: "unavailable", note: "位置暫不可用" }
    return {
      source, ip: data.ip, location, status: "ok",
      note: probe && !sameIP(data.ip, target) ? "不同出口" : undefined,
    }
  } catch (error) {
    const message = String(error).replace(/^Error: /, "")
    return empty(source, /逾時|timeout/i.test(message) ? "請求逾時"
      : /HTTP \d+/.test(message) ? message : /不匹配/.test(message) ? message : "暫不可用")
  }
}

/** 位址庫並行查詢；Cloudflare 只觀測目前請求；GeoJS 目前出口時觀測實際請求，手動查詢時查目標 IP。 */
export async function fetchGeoReport(ip: string, currentExit: boolean): Promise<GeoReport> {
  const target = ip.trim()
  const encoded = encodeURIComponent(target)
  const [cloudflare, ip2, dbip, ipinfo, geojs] = await Promise.all([
    currentExit ? collectGeoRow("Cloudflare", target, true, async () => {
      const raw = await request("https://www.cloudflare.com/cdn-cgi/trace", true) as string
      const values = Object.fromEntries(raw.trim().split("\n").map(line => {
        const split = line.indexOf("=")
        return [line.slice(0, split), line.slice(split + 1).trim()]
      }))
      return { ip: text(values.ip), country: "", code: text(values.loc), region: "", city: "" }
    }) : Promise.resolve(empty("Cloudflare", "僅支援目前出口", "unsupported")),
    collectGeoRow("IP2Location", target, false, async () => {
      const data = await request(`https://api.ip2location.io/?ip=${encoded}`)
      if (data.error) throw new Error("資料來源不可用")
      return { ip: text(data.ip), country: text(data.country_name), code: text(data.country_code),
        region: text(data.region_name), city: text(data.city_name) }
    }),
    collectGeoRow("DB-IP", target, false, async () => {
      const data = await request(`https://api.db-ip.com/v2/free/${encoded}`)
      return { ip: text(data.ipAddress), country: text(data.countryName), code: text(data.countryCode),
        region: text(data.stateProv), city: text(data.city) }
    }),
    collectGeoRow("IPInfo.io", target, false, async () => {
      const data = await request(`https://ipinfo.io/${encoded}/json`)
      return { ip: text(data.ip), country: "", code: text(data.country),
        region: text(data.region), city: text(data.city) }
    }),
    collectGeoRow("GeoJS", target, currentExit, async () => {
      const data = await request(currentExit
        ? "https://get.geojs.io/v1/ip/geo.json"
        : `https://get.geojs.io/v1/ip/geo/${encoded}.json`)
      return { ip: text(data.ip), country: text(data.country), code: text(data.country_code),
        region: text(data.region), city: text(data.city) }
    }),
  ])
  const exits: ExitObservation[] = []
  for (const row of currentExit ? [cloudflare, geojs] : []) {
    if (row.ip) {
      exits.push({ source: row.source, ip: row.ip, location: row.location })
    }
  }
  return { rows: [cloudflare, ip2, dbip, empty("MaxMind", "未接入資料來源", "unsupported"), ipinfo, geojs], exits }
}

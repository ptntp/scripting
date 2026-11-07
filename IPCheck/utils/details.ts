import type { IPInfo } from "./ip"
import type { IPPureReport } from "./ippure"
import type { LookupResult } from "./lookup"

export type DetailRow = { label: string; value: string }

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() && value.trim() !== "—" ? value.trim() : null
}

/** ASN 下方已經出現的網路名稱不再重複列出。 */
export function networkDetails(info: IPInfo | null | undefined, displayedNetwork: string): DetailRow[] {
  const seen = new Set([displayedNetwork.trim().toLowerCase()])
  const rows: DetailRow[] = []
  for (const [label, raw] of [["電信業者", info?.isp], ["所屬機構", info?.org]]) {
    const value = text(raw)
    if (!value || seen.has(value.toLowerCase())) continue
    seen.add(value.toLowerCase())
    rows.push({ label: label!, value })
  }
  return rows
}

export function locationDetails(info: IPInfo | null | undefined): DetailRow[] {
  if (!info) return []
  const rows: DetailRow[] = []
  const continents: Record<string, string> = {
    AF: "非洲", AN: "南極洲", AS: "亞洲", EU: "歐洲", NA: "北美洲", OC: "大洋洲", SA: "南美洲",
  }
  const continent = continents[(info.continentCode || "").toUpperCase()] || text(info.continent)
  if (continent) rows.push({ label: "所在大洲", value: continent })
  const timezone = text(info.timezone)
  if (timezone) {
    // offset 是此歸屬時區的秒數；0 表示 UTC，不能當作缺失。
    const offset = info.offset
    const minutes = typeof offset === "number" && Number.isFinite(offset) && Math.abs(offset) <= 14 * 3600
      ? Math.trunc(Math.abs(offset) / 60) : null
    const utc = minutes === null ? "" : ` · UTC${offset! < 0 ? "−" : "+"}${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`
    rows.push({ label: "歸屬時區", value: timezone + utc })
  }
  const postal = text(info.zip)
  if (postal) rows.push({ label: "參考郵遞區號", value: postal })
  return rows
}

export function accessTypeLabel(
  info: IPInfo | null | undefined,
  reputation: LookupResult["reputation"] | undefined,
  pure: Pick<IPPureReport, "isResidential" | "networkType"> | null | undefined,
): string {
  const hosting = pure?.networkType === "hosting" ? true : reputation?.hosting ?? info?.hosting
  return pure?.isResidential === true ? "住宅 IP"
    : hosting === true ? "機房 IP"
    : info?.mobile === true ? "行動網路"
    : pure?.isResidential === false ? "非住宅 IP"
    : networkTypeLabel(reputation?.networkType)
      || (hosting === false ? "非機房標記" : "暫無分類")
}

export function networkTypeLabel(value: string | null | undefined): string | null {
  if (!value) return null
  const labels: Record<string, string> = {
    business: "商業網路", residential: "住宅網路", wireless: "無線網路", mobile: "行動網路",
    hosting: "託管機房", education: "教育網路", government: "政府網路", military: "軍事網路",
  }
  return labels[value.toLowerCase()] || value
}

/** 使用 UTC 展示資料庫記錄時間，避免與歸屬時區或本機檢測時間混淆。 */
export function detectionTime(value: string | null | undefined): string | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null
  return new Date(value).toISOString().slice(0, 16).replace("T", " ") + " UTC"
}

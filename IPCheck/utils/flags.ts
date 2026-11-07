import type { LookupResult } from "./lookup"

export type RiskFlagId = "proxy" | "vpn" | "tor" | "anonymous" | "scraper" | "compromised"
export type RiskFlag = { id: RiskFlagId; label: string; short: string }

const ORDER: RiskFlag[] = [
  { id: "proxy", label: "代理標記", short: "代理" },
  { id: "vpn", label: "VPN 標記", short: "VPN" },
  { id: "tor", label: "Tor 出口", short: "Tor" },
  { id: "anonymous", label: "匿名化標記", short: "匿名化" },
  { id: "scraper", label: "爬蟲標記", short: "爬蟲" },
  { id: "compromised", label: "受侵害標記", short: "受侵害" },
]

/**
 * 只回傳資料庫明確命中的標記。false 與 null 都不佔位：
 * 未標記、查詢中、暫無資料不再生成任何行。
 * proxy 已由頁面按 proxycheck 優先、ip-api 備援解析。
 */
export function activeRiskFlags(
  reputation: LookupResult["reputation"],
  proxy?: boolean | null,
): RiskFlag[] {
  const hits: Record<RiskFlagId, boolean> = {
    proxy: proxy === true || reputation?.proxy === true,
    vpn: reputation?.vpn === true,
    tor: reputation?.tor === true,
    anonymous: reputation?.anonymous === true,
    scraper: reputation?.scraper === true,
    compromised: reputation?.compromised === true,
  }
  return ORDER.filter(flag => hits[flag.id])
}

/** 至少有一個布林標記可判定時，才能把空結果稱為“未標記”。 */
export function hasKnownRiskFlags(
  reputation: LookupResult["reputation"],
  proxy?: boolean | null,
): boolean {
  if (proxy != null) return true
  return !!reputation && [
    reputation.proxy, reputation.vpn, reputation.tor,
    reputation.anonymous, reputation.scraper, reputation.compromised,
  ].some(value => value != null)
}

/** 0 分代表無風險，不渲染刻度條；缺失與正分分別交給待取得狀態和 RiskScale。 */
export function shouldShowRiskScale(value: number | null | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0
}

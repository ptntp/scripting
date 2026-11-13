// 統一的網路診斷快照結構。
// Surge 腳本（surge/ipcheck-radar.js）與 Scripting 小工具自測共用同一份結構，
// 因此小工具既能自己檢測，也能直接顯示 Surge 端產出的結果。

/** ok 可用｜warn 部分可用｜soon 即將上線｜no 不可用｜na 無法判定 */
export type ServiceState = "ok" | "warn" | "soon" | "no" | "na"

export type ServiceInfo = {
  id: string
  name: string
  ok: boolean
  /** 該服務實際判定的地區代碼；也可能是「直連」「攔截」這類標註 */
  cc: string
  /** 該服務實際經過的策略（需 Surge 才有值） */
  policy: string
  /** 深度檢測的細分狀態；只有連線檢測的來源（Surge 腳本）沒有這個欄位 */
  state?: ServiceState
  /** 簡短說明，例如「完整片庫」「僅自製影片」 */
  note?: string
}

export type ExitInfo = {
  ip: string
  cc: string
  country: string
  region: string
  city: string
  isp: string
  asn: string
  org: string
  proxy: boolean
  hosting: boolean
  mobile: boolean
  kind: string
  purity: number
  risk: string
}

export type LocalInfo = {
  /** Wi-Fi · SSID／行動網路 · 電信業者／介面名稱 */
  net: string
  ip: string
  gw: string
  dns: string
  /** 直連出口歸屬地，格式為「TW Taipei」；自測模式無法取得時為空字串 */
  area: string
  carrier: string
  nat: string
  vpn: boolean
  /** 是否取得全球 IPv6 位址 */
  v6?: boolean
}

export type SurgeInfo = {
  mode: string
  policy: string
  protocol: string
  node: string
}

export type Snapshot = {
  v: 1
  ts: number
  src: "surge" | "self"
  masked?: boolean
  exit: ExitInfo
  local: LocalInfo
  /** 毫秒；0 代表逾時。proxy 為國際端點，local 為台灣端點（Surge 端為 DIRECT 策略） */
  lat: { proxy: number; local: number }
  quic: { ok: boolean; reachable: boolean }
  media: ServiceInfo[]
  ai: ServiceInfo[]
  surge?: SurgeInfo
  cost?: number
}

export const KIND = { mobile: "行動網路", residential: "住宅 IP", hosting: "機房 IP", unknown: "未知網路" } as const
export const RISK = { low: "低風險", medium: "中風險", high: "高風險", unknown: "未知" } as const

export const EMPTY_EXIT: ExitInfo = {
  ip: "", cc: "", country: "", region: "", city: "", isp: "", asn: "", org: "",
  proxy: false, hosting: false, mobile: false, kind: KIND.unknown, purity: 0, risk: RISK.unknown,
}

export const EMPTY_LOCAL: LocalInfo = {
  net: "未知網路", ip: "", gw: "", dns: "", area: "", carrier: "", nat: "", vpn: false, v6: false,
}

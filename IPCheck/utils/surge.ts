// File: utils/surge.ts
// Surge HTTP API：讀取出站模式、目前節點與協定，並把每項解鎖檢測對回實際承載的策略。
// x-key 只存在本機 Storage，不會寫入 repo 或傳到 Surge 以外的任何地方。
//
// 使用端點（Surge iOS 5.x）：
//   GET /v1/outbound         → {"mode":"rule|proxy|direct"}
//   GET /v1/policy_groups    → {"群組名": [{name, typeDescription, …}, …]}（成員清單）
//   GET /v1/policy_groups/select?group_name=… → {"policy":"目前選擇"}
//   GET /v1/requests/recent  → {"requests":[{id, remoteHost, URL, policyName, …}]}
import { fetch } from "scripting"
import { withTimeout } from "./geo"
import type { ServiceId } from "./unlock"

export const SURGE_SETTINGS_KEY = "ip-detection.surge.v1"

export interface SurgeSettings { key: string; host: string; port: number }
export const DEFAULT_SURGE_SETTINGS: SurgeSettings = { key: "", host: "127.0.0.1", port: 6171 }

export interface SurgeInfo {
  /** 出站模式的顯示文字 */
  mode: string
  /** 目前節點所屬的策略群組 */
  policy: string
  node: string
  protocol: string
}
export interface SurgeState {
  status: "off" | "ok" | "error"
  info: SurgeInfo | null
  /** 給使用者看的狀態或錯誤說明 */
  note: string
}

const text = (value: unknown): string => typeof value === "string" ? value.trim() : ""

export function parseSurgeSettings(raw: unknown): SurgeSettings {
  const data = raw && typeof raw === "object" ? raw as Record<string, unknown> : {}
  const port = Number(data.port)
  const host = text(data.host)
  return {
    key: text(data.key),
    host: /^[A-Za-z0-9.\-:[\]]+$/.test(host) ? host : DEFAULT_SURGE_SETTINGS.host,
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_SURGE_SETTINGS.port,
  }
}

export function getSurgeSettings(): SurgeSettings {
  try { return parseSurgeSettings(Storage.get<unknown>(SURGE_SETTINGS_KEY)) }
  catch { return { ...DEFAULT_SURGE_SETTINGS } }
}

export function saveSurgeSettings(settings: SurgeSettings): SurgeSettings {
  const next = parseSurgeSettings(settings)
  Storage.set(SURGE_SETTINGS_KEY, next)
  return next
}

/** 顯示用：只露出頭尾各兩碼。 */
export function maskKey(key: string): string {
  if (!key) return "未設定"
  return key.length <= 4 ? "••••" : `${key.slice(0, 2)}••••${key.slice(-2)}`
}

const MODE_LABEL: Record<string, string> = {
  rule: "規則分流", proxy: "全域代理", global: "全域代理", direct: "全部直連",
}

/** 常見的主要節點群組名稱；群組名稱由使用者設定檔決定，因此同時比對繁體、簡體與英文。 */
const PREFERRED_GROUPS = [
  "節點選擇", "节点选择", "代理", "機場", "机场", "節點", "节点", "手動", "手动",
  "選擇", "选择", "Proxy", "主線", "主线", "Default",
]

const PROTOCOLS: [string, string][] = [
  ["vless", "VLESS"], ["vmess", "VMess"], ["trojan", "Trojan"], ["hysteria2", "HY2"], ["hysteria", "HY2"],
  ["hy2", "HY2"], ["tuic", "TUIC"], ["ss2022", "SS"], ["shadowsocks", "SS"], ["anytls", "AnyTLS"],
  ["snell", "Snell"], ["wireguard", "WireGuard"], ["ssh", "SSH"], ["socks5", "SOCKS5"],
  ["https", "HTTPS"], ["http", "HTTP"], ["relay", "Relay"],
]

/** 把 Surge 的 typeDescription（如 "Trojan"、"Shadowsocks"）整理成簡短協定名。 */
export function normalizeProtocol(value: unknown): string {
  const lower = String(value ?? "").toLowerCase().trim()
  if (!lower) return ""
  if (lower === "direct") return "直連"
  return PROTOCOLS.find(([key]) => lower.includes(key))?.[1] || ""
}

/** 節點名稱自帶的協定字樣（例如「TW01-Reality」「JP Trojan」）。 */
export function protocolFromName(name: string): string {
  const lower = String(name || "").toLowerCase()
  if (!lower) return ""
  if (lower.includes("reality")) return "Reality"
  // 節點名稱中的 http / https / relay 太常見，不拿來推斷。
  return PROTOCOLS.filter(([key]) => !["http", "https", "relay", "socks5"].includes(key))
    .find(([key]) => lower.includes(key))?.[1] || ""
}

type Member = { type: string; group: string }
export type ParsedGroups = {
  /** 群組名稱 → 成員名稱 */
  groups: Map<string, string[]>
  /** 成員名稱 → 類型（即協定）與第一個所屬群組 */
  members: Map<string, Member>
  order: string[]
}

/** /v1/policy_groups → 群組與成員索引。回應只列出成員，不含目前選擇。 */
export function parsePolicyGroups(data: unknown): ParsedGroups {
  const groups = new Map<string, string[]>()
  const members = new Map<string, Member>()
  const order: string[] = []
  if (!data || typeof data !== "object" || Array.isArray(data)) return { groups, members, order }
  for (const [key, raw] of Object.entries(data as Record<string, unknown>)) {
    if (!key || !Array.isArray(raw)) continue
    order.push(key)
    const names: string[] = []
    for (const item of raw) {
      const name = text((item as any)?.name)
      if (!name || names.includes(name)) continue
      names.push(name)
      if (!members.has(name)) {
        members.set(name, { type: text((item as any).typeDescription) || text((item as any).type), group: key })
      }
    }
    groups.set(key, names)
  }
  return { groups, members, order }
}

/** 名稱比對時忽略空白、零寬字元與結尾標點。 */
function nameKey(name: string): string {
  return String(name || "").replace(/[\s​-‏﻿]+/g, "").replace(/[。．.、,，:：]+$/g, "").toLowerCase()
}

function findMember(members: Map<string, Member>, node: string): Member | null {
  const exact = members.get(node)
  if (exact) return exact
  const wanted = nameKey(node)
  if (!wanted) return null
  for (const [name, member] of members) if (nameKey(name) === wanted) return member
  return null
}

/** 依各群組目前的選擇往下找到實際節點；selections 為「群組 → 目前選擇」。 */
function resolveNode(parsed: ParsedGroups, selections: Record<string, string>, start: string): { node: string; group: string } {
  let current = start
  const visited = new Set<string>([start])
  for (let hop = 0; hop < 6; hop++) {
    const next = text(selections[current])
    if (!next || visited.has(next)) return { node: "", group: start }
    if (!parsed.groups.has(next)) return { node: next, group: current }
    visited.add(next)
    current = next
  }
  return { node: "", group: start }
}

function groupScore(name: string, index: number): number {
  const lower = name.toLowerCase()
  const hit = PREFERRED_GROUPS.findIndex(key => lower.includes(key.toLowerCase()))
  return hit >= 0 ? 100 - hit : 40 - index
}

/** 依名稱偏好排序的群組，最可能是主要節點群組的排前面。 */
export function rankedGroups(parsed: ParsedGroups): string[] {
  return parsed.order.map((name, index) => ({ name, score: groupScore(name, index) }))
    .sort((a, b) => b.score - a.score).map(item => item.name)
}

export function recentRequests(data: unknown): any[] {
  if (Array.isArray(data)) return data
  const list = (data as any)?.requests
  return Array.isArray(list) ? list : []
}

const BUILTIN_POLICY = /^(DIRECT|REJECT|REJECT-TINYGIF|REJECT-DROP|REJECT-NO-DROP|OUTBOUND|QUIC-BLOCK)/i

/** 最近請求中出現最多的非內建策略，即此刻實際承載流量的節點。 */
export function busiestPolicy(recentData: unknown): { node: string; count: number } | null {
  const counter = new Map<string, number>()
  for (const item of recentRequests(recentData)) {
    const name = text(item?.policyName)
    if (!name || BUILTIN_POLICY.test(name)) continue
    counter.set(name, (counter.get(name) || 0) + 1)
  }
  const top = [...counter.entries()].sort((a, b) => b[1] - a[1])[0]
  return top ? { node: top[0], count: top[1] } : null
}

/**
 * 由各端點的回應組出目前狀態；純函式，方便離線測試。
 * 優先序：最近請求中出現最多的節點 → 依群組目前選擇往下找 → 找不到。
 */
export function resolveSurgeInfo(
  outbound: unknown, groupsData: unknown, recentData: unknown, selections: Record<string, string> = {},
): SurgeState {
  const modeRaw = text((outbound as any)?.mode).toLowerCase()
  const mode = MODE_LABEL[modeRaw] || modeRaw || "規則分流"
  if (modeRaw === "direct") {
    return { status: "ok", info: { mode, policy: "", node: "直連出口", protocol: "" }, note: "全部直連，未使用節點" }
  }
  const parsed = parsePolicyGroups(groupsData)
  const protocolOf = (node: string) =>
    normalizeProtocol(findMember(parsed.members, node)?.type) || protocolFromName(node)

  const busy = busiestPolicy(recentData)
  if (busy) {
    return {
      status: "ok",
      info: { mode, policy: findMember(parsed.members, busy.node)?.group || "", node: busy.node, protocol: protocolOf(busy.node) },
      note: `依最近 ${busy.count} 筆請求判定`,
    }
  }
  if (parsed.groups.size === 0) return { status: "error", info: null, note: "沒有讀到策略群組" }
  for (const start of rankedGroups(parsed)) {
    const resolved = resolveNode(parsed, selections, start)
    if (!resolved.node) continue
    return {
      status: "ok",
      info: { mode, policy: start, node: resolved.node, protocol: protocolOf(resolved.node) },
      note: "最近沒有經節點的請求，依策略群組目前的選擇判定",
    }
  }
  return { status: "error", info: null, note: "最近沒有經節點的請求，也讀不到策略群組的選擇" }
}

async function api(settings: SurgeSettings, path: string, seconds = 3): Promise<{ status: number; data: any }> {
  try {
    return await withTimeout(async () => {
      const host = settings.host.includes(":") && !settings.host.startsWith("[") ? `[${settings.host}]` : settings.host
      const response = await fetch(`http://${host}:${settings.port}${path}`, {
        timeout: seconds, headers: { "X-Key": settings.key, Accept: "application/json" },
      })
      let data: any = null
      try { data = await response.json() } catch { /* 非 JSON 回應 */ }
      return { status: response.status, data }
    }, seconds * 1000 + 500)
  } catch { return { status: 0, data: null } }
}

export async function readSurgeState(settings = getSurgeSettings()): Promise<SurgeState> {
  if (!settings.key) return { status: "off", info: null, note: "尚未設定 x-key" }
  const [outbound, groups, recent] = await Promise.all([
    api(settings, "/v1/outbound"), api(settings, "/v1/policy_groups"), api(settings, "/v1/requests/recent"),
  ])
  if (outbound.status === 401 || outbound.status === 403 || groups.status === 401 || groups.status === 403) {
    return { status: "error", info: null, note: "x-key 不正確" }
  }
  if (outbound.status !== 200 && groups.status !== 200) {
    return { status: "error", info: null, note: "連不上 Surge HTTP API，請確認 Surge 已啟動且已開啟 http-api" }
  }
  // 有最近請求或全部直連時不需要再查各群組的選擇。
  const direct = text(outbound.data?.mode).toLowerCase() === "direct"
  const selections: Record<string, string> = {}
  if (!direct && !busiestPolicy(recent.data)) {
    const names = rankedGroups(parsePolicyGroups(groups.data)).slice(0, 10)
    await Promise.all(names.map(async name => {
      const selected = await api(settings, `/v1/policy_groups/select?group_name=${encodeURIComponent(name)}`)
      const policy = text(selected.data?.policy)
      if (selected.status === 200 && policy) selections[name] = policy
    }))
  }
  return resolveSurgeInfo(outbound.data, groups.data, recent.data, selections)
}

/** 各服務在請求紀錄中對應的網域（不含 www.）。 */
export const SERVICE_HOSTS: Record<ServiceId, string[]> = {
  youtube: ["youtube.com"],
  netflix: ["netflix.com"],
  disney: ["disneyplus.com", "bamgrid.com"],
  bahamut: ["gamer.com.tw"],
  spotify: ["spotify.com"],
  prime: ["primevideo.com"],
  chatgpt: ["chatgpt.com", "openai.com"],
  claude: ["claude.ai"],
  gemini: ["gemini.google.com"],
  copilot: ["copilot.microsoft.com"],
  grok: ["grok.com"],
  perplexity: ["perplexity.ai"],
}

function requestHost(item: any): string {
  const raw = text(item?.remoteHost) || text(item?.URL).match(/^[a-z]+:\/\/([^/?#]+)/i)?.[1] || ""
  return raw.toLowerCase().replace(/:\d+$/, "").replace(/^www\./, "")
}

/**
 * 從請求紀錄找出每項服務最近一次請求實際使用的策略。
 * 結果可能是節點名稱、DIRECT（規則直連）或 REJECT（被規則攔截）。
 */
export function matchServicePolicies(recentData: unknown): Partial<Record<ServiceId, string>> {
  const result: Partial<Record<ServiceId, string>> = {}
  const latest: Partial<Record<ServiceId, number>> = {}
  for (const item of recentRequests(recentData)) {
    const policy = text(item?.policyName)
    // QUIC 被擋的那筆不代表實際出站（另有一筆 TCP 紀錄）。
    if (!policy || /QUIC-BLOCK/i.test(policy)) continue
    const host = requestHost(item)
    if (!host) continue
    const id = Number(item?.id) || 0
    for (const [service, hosts] of Object.entries(SERVICE_HOSTS) as [ServiceId, string[]][]) {
      if (!hosts.some(wanted => host === wanted || host.endsWith(`.${wanted}`))) continue
      if ((latest[service] ?? -1) > id) continue
      latest[service] = id
      result[service] = policy
    }
  }
  return result
}

export async function fetchServicePolicies(settings = getSurgeSettings()): Promise<Partial<Record<ServiceId, string>>> {
  if (!settings.key) return {}
  const recent = await api(settings, "/v1/requests/recent", 4)
  return recent.status === 200 ? matchServicePolicies(recent.data) : {}
}

/** 解鎖結果旁顯示的出口說明。 */
export function policyLabel(policy: string | undefined): string {
  if (!policy) return ""
  if (/^DIRECT$/i.test(policy)) return "直連"
  if (/^REJECT/i.test(policy)) return "被規則攔截"
  return `經 ${policy}`
}

// File: utils/poke.ts
// Poke 通知：出口 IP 變更時，傳一則訊息給使用者自己的 Poke 助理。
// API Key 只存在本機 Keychain：不寫進程式碼、不放 Storage、不會同步到 GitHub，也不輸出到日誌。
// 刻意不從 "scripting" 匯入，只用全域 fetch / Storage / Keychain，方便在 Node 以替身測試。
import type { WidgetSnapshot } from "./widget_sync"

export const POKE_ENDPOINT = "https://poke.com/api/v1/inbound/api-message"
export const POKE_KEY_KEYCHAIN = "ip-detection.poke-api-key"
export const POKE_LAST_IP_KEY = "ip-detection.poke-last-ip.v1"

export type PokeTrigger = "app" | "shortcut"
/** skip：沒有有效 IP；baseline：第一次記錄；same：未變更；no-key：已變更但未設定 Key；send：需要通知 */
export type PokeDecision = "skip" | "baseline" | "same" | "no-key" | "send"

export interface PokeSendResult {
  ok: boolean
  status: number
  error?: string
}

export interface PokeNotifyResult {
  decision: PokeDecision
  sent: boolean
  summary: string
}

// ── API Key（Keychain） ──

export function getPokeKey(): string | null {
  try {
    const value = Keychain.get(POKE_KEY_KEYCHAIN)
    return typeof value === "string" && value.trim() ? value.trim() : null
  } catch {
    return null
  }
}

export function hasPokeKey(): boolean {
  return getPokeKey() !== null
}

/** first_unlock：開機解鎖過一次後，捷徑在背景（螢幕鎖定時）也讀得到；不同步到 iCloud。 */
export function setPokeKey(value: string): boolean {
  const key = value.trim().replace(/^Bearer\s+/i, "").trim()
  if (!key) return clearPokeKey()
  try {
    return Keychain.set(POKE_KEY_KEYCHAIN, key, { accessibility: "first_unlock" })
  } catch {
    return false
  }
}

export function clearPokeKey(): boolean {
  try {
    return Keychain.remove(POKE_KEY_KEYCHAIN)
  } catch {
    return false
  }
}

// ── 上次通知過的出口 IP（Storage，App 與捷徑共用） ──

export function readLastNotifiedIP(): string | null {
  const value = Storage.get<unknown>(POKE_LAST_IP_KEY, { shared: true })
  return typeof value === "string" && value.trim() ? value.trim() : null
}

export function saveLastNotifiedIP(ip: string): boolean {
  return Storage.set(POKE_LAST_IP_KEY, ip, { shared: true })
}

// ── 純函式：決策與訊息 ──

/** 快照的 IP 已由 buildWidgetSnapshot 正規化，直接比字串即可。 */
export function decidePoke(hasKey: boolean, lastIP: string | null, currentIP: string): PokeDecision {
  const current = currentIP.trim()
  if (!current) return "skip"
  if (!lastIP) return "baseline"
  if (lastIP.toLowerCase() === current.toLowerCase()) return "same"
  return hasKey ? "send" : "no-key"
}

function joinUnique(parts: string[], separator: string): string {
  const seen = new Set<string>()
  return parts
    .map(part => part.trim())
    .filter(part => part && !seen.has(part) && seen.add(part))
    .join(separator)
}

export function formatPokeTime(at: number): string {
  return new Date(at).toLocaleString("zh-TW", { hour12: false })
}

export function buildPokeMessage(previousIP: string, snapshot: WidgetSnapshot, trigger: PokeTrigger, at = Date.now()): string {
  const location = joinUnique([snapshot.country, snapshot.regionName, snapshot.city], " · ")
  const asn = snapshot.as.match(/AS\d+/i)?.[0] ?? ""
  const network = joinUnique([snapshot.isp || snapshot.org, asn ? `（${asn}）` : ""], "")
  const risk = snapshot.risk == null
    ? ""
    : `風險 ${Math.round(snapshot.risk)}%${snapshot.riskSource ? `（${snapshot.riskSource}）` : ""}`
  const attribute = joinUnique([snapshot.accessType, risk], " · ")
  const lines = [
    "[IP 檢測] 出口 IP 已變更",
    `舊：${previousIP}`,
    `新：${snapshot.ip}`,
    location ? `位置：${location}` : "",
    network ? `網路：${network}` : "",
    attribute ? `屬性：${attribute}` : "",
    snapshot.vpnStatus && snapshot.vpnStatus !== "未知" ? `標記：${snapshot.vpnStatus}` : "",
    `時間：${formatPokeTime(at)}（${trigger === "shortcut" ? "捷徑背景檢測" : "App 檢測"}）`,
  ]
  return lines.filter(Boolean).join("\n")
}

/** 整包 JSON 都會轉給 Poke 當作上下文；不含經緯度與 API Key。 */
export function buildPokePayload(previousIP: string, snapshot: WidgetSnapshot, trigger: PokeTrigger, at = Date.now()) {
  return {
    message: buildPokeMessage(previousIP, snapshot, trigger, at),
    source: "IPCheck",
    event: "ip_changed",
    trigger,
    detectedAt: new Date(at).toISOString(),
    previousIP,
    current: {
      ip: snapshot.ip,
      country: snapshot.country,
      countryCode: snapshot.countryCode,
      region: snapshot.regionName,
      city: snapshot.city,
      isp: snapshot.isp,
      org: snapshot.org,
      as: snapshot.as,
      accessType: snapshot.accessType,
      risk: snapshot.risk,
      riskSource: snapshot.riskSource,
      flags: snapshot.vpnStatus,
    },
  }
}

// ── 傳送 ──

export async function sendPoke(apiKey: string, body: Record<string, unknown>): Promise<PokeSendResult> {
  try {
    const response = await fetch(POKE_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      timeout: 10,
    })
    if (response.status === 401) return { ok: false, status: 401, error: "API Key 無效、已撤銷或格式錯誤" }
    const data = await response.json().catch(() => null) as { success?: unknown } | null
    if (response.ok && data?.success === true) return { ok: true, status: response.status }
    return { ok: false, status: response.status, error: `Poke 回應異常（HTTP ${response.status}）` }
  } catch {
    // 不把錯誤物件原樣輸出，避免任何情況下帶出請求標頭。
    return { ok: false, status: 0, error: "無法連線到 Poke" }
  }
}

export async function sendPokeTest(): Promise<PokeSendResult> {
  const key = getPokeKey()
  if (!key) return { ok: false, status: 0, error: "尚未設定 API Key" }
  return sendPoke(key, {
    message: `[IP 檢測] Poke 通知已啟用，之後出口 IP 變更時會通知你。（${formatPokeTime(Date.now())}）`,
    source: "IPCheck",
    event: "test",
  })
}

/**
 * 出口 IP 和上次記錄不同時通知 Poke。
 * 沒設定 Key 時只更新基準，避免之後設定 Key 才補發一則過時的變更；傳送失敗則保留舊基準，下次再試。
 */
export async function notifyPokeIfChanged(snapshot: WidgetSnapshot, trigger: PokeTrigger): Promise<PokeNotifyResult> {
  const key = getPokeKey()
  const last = readLastNotifiedIP()
  const decision = decidePoke(key !== null, last, snapshot.ip)

  if (decision === "skip") return { decision, sent: false, summary: "沒有取得出口 IP" }
  if (decision === "same") return { decision, sent: false, summary: `出口 IP 未變更：${snapshot.ip}` }
  if (decision === "baseline" || decision === "no-key") {
    saveLastNotifiedIP(snapshot.ip)
    return {
      decision,
      sent: false,
      summary: decision === "baseline"
        ? `已記錄目前出口 IP：${snapshot.ip}`
        : `出口 IP 已變更為 ${snapshot.ip}（尚未設定 Poke API Key，未通知）`,
    }
  }

  const result = await sendPoke(key as string, buildPokePayload(last as string, snapshot, trigger))
  if (!result.ok) {
    console.log("[IP檢測] Poke 通知失敗", result.error ?? "")
    return { decision, sent: false, summary: `出口 IP 已變更為 ${snapshot.ip}，但 Poke 通知失敗：${result.error ?? "未知錯誤"}` }
  }
  saveLastNotifiedIP(snapshot.ip)
  return { decision, sent: true, summary: `已通知 Poke：${last} → ${snapshot.ip}` }
}

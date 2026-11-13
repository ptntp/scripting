// 本機快取與設定（同一支腳本的頁面與小工具共用 Storage）。
// Surge 的 x-key 只存在這裡，不會寫入 repo。
import type { Snapshot } from "./types"

declare const Storage: {
  get<T = unknown>(key: string, options?: { shared?: boolean }): T | null
  set<T = unknown>(key: string, value: T): boolean
  remove?(key: string): void
}

const SNAPSHOT_KEY = "radar_snapshot_v1"
const SETTINGS_KEY = "radar_settings_v1"
/** 前一版 IPCheck 的 Surge 設定與隱私模式，僅用於沿用舊值。 */
const LEGACY_SURGE_KEY = "ip-detection.surge.v1"
const LEGACY_PRIVACY_KEY = "ip-detection.privacy-mode"

export type Settings = {
  /** 小工具重新診斷的最小間隔（分鐘） */
  refreshMinutes: number
  /** 顯示時遮蔽 IP */
  maskIP: boolean
  /** 選填：Surge 腳本同步出來的快照網址（KV／Worker／NAS），有填會優先讀取 */
  snapshotURL: string
  /** 選填：Surge HTTP API 的 x-key，用來讀取出站模式與目前節點 */
  surgeKey: string
  surgeHost: string
  surgePort: number
}

export const DEFAULT_SETTINGS: Settings = {
  refreshMinutes: 15,
  maskIP: false,
  snapshotURL: "",
  surgeKey: "",
  surgeHost: "127.0.0.1",
  surgePort: 6171,
}

function readValue<T>(key: string): T | null {
  try {
    const value = Storage.get<any>(key)
    if (value === null || value === undefined) return null
    if (typeof value === "string") {
      try { return JSON.parse(value) as T } catch (_) { return null }
    }
    return value as T
  } catch (_) {
    return null
  }
}

function writeValue(key: string, value: unknown): void {
  try { Storage.set(key, value as any) } catch (_) {}
}

const text = (value: unknown): string => typeof value === "string" ? value.trim() : ""

function validPort(value: unknown): number {
  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_SETTINGS.surgePort
}

/** 把任意來源的資料整理成合法設定；純函式，方便離線測試。 */
export function normalizeSettings(raw: unknown, legacy?: unknown, legacyPrivacy?: unknown): Settings {
  const data = raw && typeof raw === "object" ? raw as Record<string, unknown> : {}
  const old = legacy && typeof legacy === "object" ? legacy as Record<string, unknown> : {}
  const minutes = Number(data.refreshMinutes)
  const host = text(data.surgeHost) || text(old.host)
  const url = text(data.snapshotURL)
  return {
    refreshMinutes: Number.isFinite(minutes) && minutes >= 5 ? Math.min(Math.floor(minutes), 240) : DEFAULT_SETTINGS.refreshMinutes,
    // 還沒在雷達設定過時，沿用前一版 IPCheck 頁面的隱私模式。
    maskIP: typeof data.maskIP === "boolean" ? data.maskIP : legacyPrivacy === true,
    // 輸入過程中會逐字儲存，因此這裡不驗證格式；實際讀取時才檢查是否為 http(s) 網址。
    snapshotURL: url,
    surgeKey: text(data.surgeKey) || text(old.key),
    surgeHost: /^[A-Za-z0-9.\-:[\]]+$/.test(host) ? host : DEFAULT_SETTINGS.surgeHost,
    surgePort: validPort(data.surgePort ?? old.port),
  }
}

export function getSettings(): Settings {
  let legacyPrivacy: unknown = null
  try { legacyPrivacy = Storage.get<boolean>(LEGACY_PRIVACY_KEY, { shared: true }) } catch (_) {}
  return normalizeSettings(readValue(SETTINGS_KEY), readValue(LEGACY_SURGE_KEY), legacyPrivacy)
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const next = normalizeSettings({ ...getSettings(), ...patch })
  writeValue(SETTINGS_KEY, next)
  return next
}

export function getSnapshot(): Snapshot | null {
  const raw = readValue<Snapshot>(SNAPSHOT_KEY)
  if (!raw || typeof raw !== "object") return null
  if (!raw.exit || !raw.local || typeof raw.ts !== "number") return null
  if (!Array.isArray(raw.media) || !Array.isArray(raw.ai) || !raw.lat || !raw.quic) return null
  return raw
}

export function saveSnapshot(snapshot: Snapshot): void {
  writeValue(SNAPSHOT_KEY, snapshot)
}

export function clearSnapshot(): void {
  try { Storage.remove?.(SNAPSHOT_KEY) } catch (_) {}
}

export function isFresh(snapshot: Snapshot | null, minutes: number): boolean {
  if (!snapshot) return false
  return Date.now() - snapshot.ts < minutes * 60_000
}

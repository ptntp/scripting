// 小工具進入點：優先用快取，過期後先試 Surge 快照，再退回本機自測。
import { Script, Widget } from "scripting"
import { diagnose } from "./src/diagnose"
import { enrich } from "./src/enrich"
import { fetchRemoteSnapshot } from "./src/surge"
import { getSettings, getSnapshot, isFresh, saveSnapshot } from "./src/store"
import type { Settings } from "./src/store"
import type { Snapshot } from "./src/types"
import { RadarView } from "./src/ui"

const FALLBACK_SIZE = { width: 338, height: 354 }

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([promise, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))])
}

async function loadSnapshot(settings: Settings): Promise<Snapshot | null> {
  const cached = getSnapshot()
  if (isFresh(cached, settings.refreshMinutes)) return cached

  // 1) Surge 腳本同步出來的快照
  if (settings.snapshotURL) {
    const remote = await withTimeout(fetchRemoteSnapshot(settings.snapshotURL), 5000)
    if (remote && Date.now() - remote.ts < settings.refreshMinutes * 2 * 60_000) {
      saveSnapshot(remote)
      return remote
    }
  }

  // 2) 本機自測：限制等待時間，避免冷啟動的網路請求占滿小工具的執行時間。
  //    大型網頁檢測最多 10 秒、單項上限 15 秒，整體再留一點餘裕。
  const fresh = await withTimeout(diagnose(), 20_000)
  if (fresh) {
    saveSnapshot(fresh)
    return fresh
  }

  return cached
}

async function main() {
  const settings = getSettings()
  const size = Widget.displaySize ?? FALLBACK_SIZE
  const family = Widget.family ?? "systemLarge"

  let snapshot: Snapshot | null = null
  try {
    const loaded = await loadSnapshot(settings)
    snapshot = await enrich(loaded, settings)
    // 把策略標註存回快取，避免下次沒抓到請求紀錄時又退回未標註。
    if (snapshot && snapshot !== loaded && [...snapshot.media, ...snapshot.ai].some((item) => item.policy)) {
      saveSnapshot(snapshot)
    }
  } catch (_) {
    snapshot = getSnapshot()
  }

  const reloadDate = new Date(Date.now() + Math.max(5, settings.refreshMinutes) * 60_000)

  Widget.present(<RadarView snapshot={snapshot} settings={settings} family={family} size={size} />, {
    policy: "after",
    date: reloadDate,
  } as any)
  Script.exit()
}

main()

// 捷徑「執行腳本」（背景、無介面）入口：檢測目前出口 IP，有變更就通知 Poke。
// 適合搭配捷徑自動化（加入／離開 Wi-Fi、固定時間）定期執行。
import { Intent, Script, Widget } from "scripting"
import { fetchExitProbe } from "./utils/ip"
import { lookupAddress } from "./utils/lookup"
import { withTimeout } from "./utils/geo"
import { buildWidgetSnapshot, saveWidgetSnapshot } from "./utils/widget_sync"
import { notifyPokeIfChanged } from "./utils/poke"

async function run(): Promise<string> {
  const probe = await withTimeout(fetchExitProbe(), 7000).catch(() => null)
  if (!probe) return "IP 檢測失敗：未能取得出口 IP，請檢查網路"

  const lookup = await withTimeout(lookupAddress(probe.address, true), 12000).catch(() => null)
  const snapshot = buildWidgetSnapshot({
    ip: probe.address,
    info: lookup?.info ?? null,
    reputation: lookup?.reputation ?? null,
    pure: null,
  })

  // 歸屬查到了才順便更新小工具快照，避免用空白資料蓋掉頁面存的完整快照。
  if (lookup?.info) {
    saveWidgetSnapshot(snapshot)
    // Storage 共享寫入在後台落盤；稍等再重新整理小工具。
    await new Promise(resolve => setTimeout(resolve, 300))
    try { Widget.reloadUserWidgets() } catch { /* 背景環境不支援時略過 */ }
  }

  const result = await notifyPokeIfChanged(snapshot, "shortcut")
  return result.summary
}

run()
  .catch(error => `IP 檢測失敗：${String(error).replace(/^Error: /, "")}`)
  .then(summary => Script.exit(Intent.text(summary)))

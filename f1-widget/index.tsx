// index.tsx — 在 Scripting App 內執行時：預覽各尺寸、清除快取
import { Script, Widget } from "scripting"
import { clearCache } from "./f1"

// 預覽時可切換的參數（實際放到主畫面時，在「編輯小工具 → Parameter」輸入同樣的關鍵字即可）
const PARAMS: Record<string, string> = {
  "自動": JSON.stringify({ mode: "auto" }),
  "車手積分": JSON.stringify({ mode: "drivers" }),
  "車隊積分": JSON.stringify({ mode: "teams" }),
  "比賽週末賽程": JSON.stringify({ mode: "schedule" }),
  "English": JSON.stringify({ mode: "auto", lang: "en" }),
}

const MENU: { label: string; family?: string; destructive?: boolean }[] = [
  { label: "預覽：小（主畫面）", family: "systemSmall" },
  { label: "預覽：中（主畫面）", family: "systemMedium" },
  { label: "預覽：大（主畫面）", family: "systemLarge" },
  { label: "預覽：矩形（鎖定畫面）", family: "accessoryRectangular" },
  { label: "預覽：圓形（鎖定畫面）", family: "accessoryCircular" },
  { label: "預覽：單行（鎖定畫面）", family: "accessoryInline" },
  { label: "清除快取並重新整理所有 Widget", destructive: true },
]

async function main() {
  while (true) {
    const index = await Dialog.actionSheet({
      title: "F1 Widget",
      message: "資料來源：jolpica-f1、Open-Meteo",
      actions: MENU.map(m => ({ label: m.label, destructive: m.destructive })),
    })
    if (index == null) break

    const item = MENU[index]
    if (item.family) {
      await Widget.preview({
        family: item.family as any,
        parameters: { options: PARAMS, default: "自動" },
      })
    } else {
      const n = clearCache()
      Widget.reloadAll()
      await Dialog.alert({ title: "完成", message: `已清除 ${n} 筆快取，Widget 會重新抓取資料。` })
    }
  }
  Script.exit()
}

main()

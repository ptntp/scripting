// 小工具按鈕觸發的動作。
import { AppIntentManager, AppIntentProtocol, Widget } from "scripting"
import { runCheck } from "./src/baha"
import { runAll } from "./src/extras"

/** 小型小工具：登入（必要時）→ 查詢 → 尚未簽到就簽到 → 重新整理小工具。 */
export const SignInIntent = AppIntentManager.register({
  name: "BahaSignInIntent",
  protocol: AppIntentProtocol.AppIntent,
  perform: async (_: undefined) => {
    await runCheck(true)
    Widget.reloadAll()
  },
})

/** 中型小工具：主站簽到＋公會簽到＋動畫瘋答題＋廣告雙倍（廣告需等約 30 秒）。 */
export const RunAllIntent = AppIntentManager.register({
  name: "BahaRunAllIntent",
  protocol: AppIntentProtocol.AppIntent,
  perform: async (_: undefined) => {
    await runAll({ onProgress: () => Widget.reloadAll() })
    Widget.reloadAll()
  },
})

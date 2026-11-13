// 小工具按鈕觸發的動作：登入（必要時）→ 查詢 → 尚未簽到就簽到 → 重新整理小工具。
import { AppIntentManager, AppIntentProtocol, Widget } from "scripting"
import { runCheck } from "./src/baha"

export const SignInIntent = AppIntentManager.register({
  name: "BahaSignInIntent",
  protocol: AppIntentProtocol.AppIntent,
  perform: async (_: undefined) => {
    await runCheck(true)
    Widget.reloadAll()
  },
})

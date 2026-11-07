import { Navigation, Script } from "scripting"
import IPPage from "./page"

async function run() {
  try {
    await Navigation.present(<IPPage />)
  } catch (error) {
    console.error("[IP檢測] 頁面呈現失敗", error)
  } finally {
    Script.exit()
  }
}
void run()

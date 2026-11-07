import { AppIntentManager, AppIntentProtocol, Widget } from "scripting";

export const RefreshIPIntent = AppIntentManager.register({
    name: "RefreshIPIntent",
    protocol: AppIntentProtocol.AppIntent,
    perform: async () => {
        console.log("執行重新整理意圖：RefreshIPIntent");
        Widget.reloadAll();
    }
});

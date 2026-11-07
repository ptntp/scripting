# scripting

個人使用的 [Scripting](https://scriptingapp.github.io/) 腳本。

## 腳本

| 資料夾 | 說明 |
| --- | --- |
| [`f1-widget/`](f1-widget/) | F1 小工具：下一節倒數、賽道路線圖、比賽週末賽程與天氣、積分榜、正賽結果（主畫面＋鎖定畫面） |
| [`IPCheck/`](IPCheck/) | IP 檢測：出口 IP、多來源位置對照、代理／風險評分、WebRTC 洩漏檢查與小工具 |

## 在 iPhone 上安裝（自動同步）

在 Scripting 新增腳本，到腳本設定的遠端來源填入該資料夾網址，並設定自動更新間隔：

```
https://github.com/ptntp/scripting/tree/main/f1-widget
https://github.com/ptntp/scripting/tree/main/IPCheck
```

之後在 GitHub 上修改檔案並 commit，iPhone 會在下次檢查時自動更新（最短每 30 分鐘檢查一次）。

## 致謝

F1 Widget 參考以下來源建立，感謝他們給我的靈感：

- **jolpica-f1**：https://github.com/jolpica/jolpica-f1
- **Scripting**：https://scriptingapp.github.io/zh/guide/Quick%20Start
- **F1-Scriptable-Widget**：https://github.com/archive-sh/F1-Scriptable-Widget/blob/main/F1%20Widget%20OfficialF1.js
- **FastF1**：https://github.com/theOehrly/Fast-F1

資料來源與第三方授權聲明請見 [`f1-widget/README.md`](f1-widget/README.md)。

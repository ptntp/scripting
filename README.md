# scripting

個人使用的 [Scripting](https://scriptingapp.github.io/) 腳本。

## 腳本

| 資料夾 | 說明 |
| --- | --- |
| [`f1-widget/`](f1-widget/) | F1 小工具：下一節倒數、賽道路線圖、比賽週末賽程與天氣、積分榜、正賽結果（主畫面＋鎖定畫面） |
| [`IPCheck/`](IPCheck/) | 網路診斷雷達：出口 IP、純淨度、國際／台灣延遲、HTTP/3、串流與 AI 解鎖檢測、Surge 節點與策略，附小／中／大型小工具；另有 IP 詳細檢測頁（多來源位置對照、風險評分、WebRTC 洩漏檢查） |

## 在 iPhone 上安裝（自動同步）

在 Scripting 新增腳本，到腳本設定的遠端來源填入該資料夾網址，並設定自動更新間隔：

```
https://github.com/ptntp/scripting/tree/main/f1-widget
https://github.com/ptntp/scripting/tree/main/IPCheck
```

之後在 GitHub 上修改檔案並 commit，iPhone 會在下次檢查時自動更新（最短每 30 分鐘檢查一次）。

## IPCheck 搭配 Surge（選用）

1. 在 Surge 設定檔的 `[General]` 加入 `http-api = 你的金鑰@127.0.0.1:6171`。
2. 開啟 IPCheck，在主頁最下方的「Surge HTTP API」填入相同金鑰。金鑰只儲存在裝置上。
3. 需要定時診斷與通知時，在 Surge 以網址安裝模組：

```
https://raw.githubusercontent.com/ptntp/scripting/main/IPCheck/surge/ipcheck-radar.sgmodule
```

4. 想讓小工具直接顯示 Surge 端依策略檢測的結果：在模組參數加上 `SYNC=你的網址`（任何可接收 JSON 的 KV／Worker／NAS），再把同一個網址填到 IPCheck 的「Surge 快照網址」。快照內含出口 IP，只會送到你指定的網址。

## 致謝

F1 Widget 參考以下來源建立，感謝他們給我的靈感：

- **jolpica-f1**：https://github.com/jolpica/jolpica-f1
- **Scripting**：https://scriptingapp.github.io/zh/guide/Quick%20Start
- **F1-Scriptable-Widget**：https://github.com/archive-sh/F1-Scriptable-Widget/blob/main/F1%20Widget%20OfficialF1.js
- **FastF1**：https://github.com/theOehrly/Fast-F1

IPCheck 以「網路診斷雷達」為主體，併入 IP-Media 的解鎖判定邏輯，全部改寫為繁體中文（台灣用語），並移除中國來源、改用台灣與國際常用端點：

- **IP-Media（流媒體解鎖檢測）**：https://github.com/iam-Kristen/Scripting
- **網路診斷雷達**：https://github.com/ByteValley/NetTool

資料來源與第三方授權聲明請見 [`f1-widget/README.md`](f1-widget/README.md)。

# F1 Widget（Scripting）

在 iPhone 主畫面與鎖定畫面顯示 F1 下一節倒數、賽道路線圖、比賽週末賽程與天氣、積分榜與正賽結果的 [Scripting](https://scriptingapp.github.io/) 小工具。

## 致謝

本專案參考以下來源建立，感謝他們給我的靈感：

- **jolpica-f1**：https://github.com/jolpica/jolpica-f1
- **Scripting**：https://scriptingapp.github.io/zh/guide/Quick%20Start
- **F1-Scriptable-Widget**：https://github.com/archive-sh/F1-Scriptable-Widget/blob/main/F1%20Widget%20OfficialF1.js
- **FastF1**：https://github.com/theOehrly/Fast-F1

## 資料來源

| 用途 | 來源 | 授權 |
| --- | --- | --- |
| 賽程、積分、正賽結果 | **jolpica-f1**（Ergast 相容 API）：https://github.com/jolpica/jolpica-f1 | 依其 Terms of Use |
| 天氣預報 | **Open-Meteo**：https://open-meteo.com/ | CC BY 4.0，非商業免費 |
| 賽道路線 | **f1-circuits**：https://github.com/bacinger/f1-circuits | MIT（已簡化後內嵌在 `tracks.ts`） |
| 2026 車隊官方色 | **FastF1** `plotting/constants.json`：https://github.com/theOehrly/Fast-F1 | MIT |

全部免金鑰，不需要任何帳號。

## 檔案

| 檔案 | 用途 |
| --- | --- |
| `script.json` | 腳本名稱、圖示、版本 |
| `widget.tsx` | Widget 進入點：抓資料、依尺寸選畫面、排定下次重新整理 |
| `views.tsx` | 各尺寸畫面（小／中／大／特大、鎖定畫面矩形／圓形／單行） |
| `f1.ts` | API（jolpica、Open-Meteo）、快取、賽程計算、時間格式、中文站名／車隊色／國旗 |
| `tracks.ts` | 40 條賽道的簡化路線座標，依 circuitId 或城市名查詢 |
| `index.tsx` | 在 App 內執行時的選單：預覽各尺寸、清除快取 |

## 安裝

### 方法 A：從 GitHub 安裝並自動更新（推薦）

Scripting 支援把 GitHub 資料夾設為腳本的「遠端來源」，之後只要更新 GitHub 上的檔案，iPhone 就會自動同步。

1. 在 Scripting 新增一個腳本（名稱隨意，例如 F1 Widget）。
2. 開啟該腳本的設定，在遠端來源填入：

   ```
   https://github.com/ptntp/scripting/tree/main/f1-widget
   ```

3. 設定自動更新間隔（最短 30 分鐘，例如 3600 秒＝每小時檢查），並確認 App 的全域「自動更新」開關已開啟。
4. 手動檢查一次更新，檔案就會下載到 iPhone。

之後在電腦、iPad 或 GitHub 網頁上修改並 commit，iPhone 會在下次檢查時更新。建議每次改版時遞增 `script.json` 的 `version`，方便辨識。

### 方法 B：手動建立

在 Scripting 新增腳本，建立上表六個檔案並貼上內容（全部放在同一層，不要放子資料夾）。

## 放到主畫面／鎖定畫面

1. 長按主畫面 → 加入小工具 → 選 **Scripting** → 選尺寸（小、中、大）。
2. 長按小工具 → **編輯小工具** → Script 選這個腳本。
3. 鎖定畫面：長按鎖定畫面 → 自訂 → 加入小工具 → Scripting（矩形、圓形，或時間上方的單行）。

## 各尺寸內容

- **小**：下一站、賽道路線圖、下一節倒數與時間（自動換算為手機時區）。
- **中**：左側 2/3 是下一站、大倒數與佔據中央的賽道圖；右側 1/3 是車手積分前 6 名（含車號），列高自動填滿。
- **大**：標題列（站名、賽道圖、倒數）、五個節次卡片、車手與車隊積分各 10 名、底部各節次天氣。賽後 30 小時內改顯示正賽前十名，積分榜縮為 5 名。
- **特大（直式）**：版面同大尺寸，積分區改顯示完整名單：車手全部（兩欄）與車隊全部（兩欄）上下排；`drivers` 為車手全部兩欄、`teams` 為車隊全部單欄。賽後上方加上正賽前十名，下方仍是完整名單。依小工具高度（500pt 以上）判斷。
- **鎖定畫面矩形**：大獎賽、節次、倒數、時間，右側賽道圖。
- **鎖定畫面圓形**：節次縮寫 + 剩餘天數（兩天內改顯示開始時間）。
- **鎖定畫面單行**：國旗、大獎賽、節次、時間。

倒數規則：超過 24 小時顯示「3 天 8 小時」，24 小時內顯示「時:分:秒」，進行中以紅字顯示已經過的時間。這些由 iOS 原生計時文字即時更新，不需要重新抓資料。時間尚未公布的節次（例如提早公布的下一季賽程）會顯示「待定」，倒數改為「3 天後」，不會被當成進行中，也不會觸發正賽結果；同一天排在它後面的已知時間節次一開跑，就會換成那一節，不會被待定節次擋住。

沒有下一場比賽時：只有在本季所有正賽都確定結束後才顯示「賽季已結束」與年度冠軍；賽程暫時抓不到時顯示「賽程暫時無法載入」，仍可顯示已取得的積分榜。

賽道圖：路線經過平滑處理，紅色短線為起跑線位置。方向一律北方朝上，和 F1 轉播圖的角度不一定相同。

天氣（大尺寸）：每一節取該時段中間那個小時的預報，顯示天氣圖示（夜間賽為月亮）、氣溫（°C）、降雨機率。Open-Meteo 最多提供 16 天預報，比賽超過 15 天會顯示「天氣預報將於賽前 15 天提供」。

## Parameter（選填）

在「編輯小工具 → Parameter」輸入關鍵字，可用空白或逗號組合：

| 輸入 | 效果 |
| --- | --- |
| （空白） | 自動：平常顯示車手積分，賽後 30 小時內改顯示正賽結果 |
| `drivers` 或 `車手` | 只顯示車手積分（大尺寸兩欄共 20 名，特大尺寸顯示全部） |
| `teams` 或 `車隊` | 只顯示車隊積分 |
| `schedule` 或 `賽程` | 中尺寸右側改成週末各節次時間 |
| `en` | 英文介面 |

例如：`teams en`、`賽程`。也接受 JSON：`{"mode":"teams","lang":"en"}`。

## 更新頻率與 API 限制

- 每種尺寸只抓畫面會用到的資料（例如小尺寸不抓積分榜、中尺寸 teams 模式只抓車隊榜）。
- jolpica 未驗證請求限制為每秒 4 次、每小時 500 次，因此所有資料都有快取：
  - 賽程：12 小時
  - 積分榜：平常 6 小時；比賽週末或賽後 30 分鐘
  - 正賽結果：出爐前（含名次仍是空的）每 10 分鐘重試，出爐後 12 小時
  - 天氣：平常 3 小時；比賽週末 1 小時（只有大尺寸會抓）
- Widget 平常每 60 分鐘、比賽週末每 15 分鐘請 iOS 重新整理，並在每節開始／結束、倒數剩 24 小時、本地午夜加排一次。實際時間仍由 iOS 依耗電狀況決定。
- 網路失敗時沿用舊快取，大尺寸底部會標示「離線資料」。

## 自訂

- `views.tsx` 的 `PADDING`、`BG`、`F1_RED`：邊距、背景、強調色。
- `views.tsx` 的 `TrackMap` 呼叫：賽道圖大小與線寬。
- `f1.ts` 的 `TEAM_COLORS`、`GP_ZH`：車隊色與大獎賽中文名。沒對到時退回灰色與英文原名。
- `f1.ts` 的 `RESULT_WINDOW_TO`：賽後顯示結果的時間長度（預設 30 小時）。
- 新賽道：在 `tracks.ts` 的 `BY_CIRCUIT_ID` 補上 jolpica 的 circuitId 對應；找不到時會依城市名嘗試，再找不到就不顯示。

## 開發與測試

資料層的回歸測試放在 repo 根目錄的 `tests/`（不在 `f1-widget/` 內，不會同步到 iPhone），只用 Node 內建功能，不需安裝套件：

```bash
node --test tests/f1-widget.test.mjs   # 需要 Node 22.18+
```

涵蓋時間待定（含與已知時間節次混在同一天）、節次開始／結束邊界、正賽結果視窗與快取、季末判斷、天氣配對與參數解析；每個案例結束後會把替換過的 `Date.now`、`fetch`、`Storage` 原樣還原。

## 已知限制

- API 只提供每節開始時間，結束時間為預估值（練習／排位 60 分鐘、衝刺排位 45 分鐘、正賽 120 分鐘），「進行中」狀態可能和實際相差幾分鐘。
- 正賽結果通常在賽後數小時才會更新到 jolpica。
- 不含即時名次（live timing）。
- 賽道圖需要 Scripting 支援 `Path2D` / `PathShape`（新版才有），舊版 App 會自動略過賽道圖。

### 關於 FastF1

FastF1 是 Python 資料分析套件（依賴 pandas、matplotlib，會下載大量計時資料），無法在 iOS Widget 的 JavaScript 環境與約 30 MB 記憶體限制內執行。本專案採用它整理的 2026 車隊官方色與「以車隊名稱比對顏色」的做法。FastF1 畫官方角度賽道圖用的是 MultiViewer 的非公開 API，沒有公開授權，因此賽道圖改用公開的 f1-circuits GeoJSON。

## 第三方授權聲明

- `tracks.ts` 的賽道座標衍生自 f1-circuits — Copyright (c) 2019-2025 Tomislav Bacinger，MIT License。
- 車隊顏色取自 FastF1 — Copyright (c) 2026 Philipp Schäfer，MIT License。
- 天氣資料 © Open-Meteo.com，CC BY 4.0。

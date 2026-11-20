# 更新日誌

## 1.0.2 - 2026-11-21

- 修正 DNS 路徑誤判：開著 Surge 時，`verify.controld.com` 解析失敗會變成 TLS 錯誤（Surge 先在本機接下連線、解析失敗才斷線），舊版把 TLS 錯誤當成「走 Control D」。現在只有收到 HTTP 回應才算走 Control D；真的走 Control D 時這個網域的憑證是有效的。
- 統計主機被擋時的說明改成實際有效的修法：擋廣告模組（例如 Remove ADs）的 `DOMAIN-KEYWORD,analytics,REJECT` 排在設定檔規則前面，在設定檔加直連規則無效，要把 `DOMAIN-SUFFIX,analytics.controld.com,DIRECT` 放進一個模組並啟用。
- 測試更新 3 項（DNS 判斷、TLS 錯誤情境、統計主機錯誤說明），合計 80 項通過。

## 1.0.1 - 2026-11-20

- 統計主機連不上時，說明會寫出主機名稱與系統的原始錯誤，並提醒 Surge 或擋廣告規則可能封鎖了 `*.analytics.controld.com`。
- 測試新增 1 項，合計 80 項通過。

## 1.0.0 - 2026-11-20

- 首版。參考 ControlHub（App Store 上的 Control D 第三方 App）的小工具設計，改寫成 Scripting 腳本。
- 統計：總查詢、已阻擋（含比例）、放行、導向，並和前一段同長度的時間比較查詢量（「今天」對照昨天同一時段）。統計區間可選今天、過去 24 小時、7 天、30 天，小工具參數也能個別指定。
- 端點：列出所有端點與套用的 Profile，最後一次查詢在 15 分鐘內算「在線」，停用中的端點標示軟停用／硬停用。
- DNS 路徑：用 `verify.controld.com`（只有經過 Control D 的 DNS 才解析得到）檢查這支 iPhone 目前是否走 Control D，右上角盾牌綠色＝有走、橘色＝沒走。
- 最常被擋的網域：顯示在大型小工具與 App 頁面。
- 小工具：主畫面小／中／大，鎖定畫面圓形（封鎖比例環）、矩形、單行。斷線時沿用上次的資料並標示「離線資料」。
- API Token 只存在本機 Keychain；換 Token 會清掉舊帳號的快取。
- 新增 `tests/controld-check.test.mjs`（23 項），與既有測試合計 79 項通過。

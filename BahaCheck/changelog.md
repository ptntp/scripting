# 更新日誌

## 1.0.0 - 2026-11-13

- 首版。參考 jkgtw/Surge 的 BahamutDailyBonus 改寫成 Scripting 腳本，只做主站每日簽到。
- 小型小工具：尚未簽到顯示「尚未簽到」，點一下即簽到；已簽到顯示連續簽到天數；失敗時顯示原因並可點擊重試。
- 帳號、密碼、兩步驟驗證金鑰與登入 cookie 只存在本機 Keychain；登入 cookie 失效時自動重新登入一次。
- 兩步驟驗證碼（TOTP）改用純 TypeScript 實作，並修正原版驗證碼開頭為 0 時位數不足的問題。
- 帳密被拒時當天不在背景重試，避免帳號被鎖。
- 新增 `tests/baha-check.test.mjs`（TOTP、SHA-1、cookie、登入與簽到流程），與 F1 測試合計 37 項通過。

// App 頁面：設定帳號（只存在本機 Keychain）、查看今日狀態、手動簽到或全部執行、預覽小工具。
import {
  Button,
  HStack,
  List,
  Navigation,
  NavigationStack,
  Script,
  SecureField,
  Section,
  Spacer,
  Text,
  TextField,
  VStack,
  Widget,
  useEffect,
  useState,
} from "scripting"
import type { DayState, Extra } from "./src/baha"
import {
  clearAll,
  getCredentials,
  getSavedAccount,
  getState,
  messageOf,
  runCheck,
  saveCredentials,
  taipeiDate,
  totp,
  totpRemaining,
} from "./src/baha"
import type { Tone } from "./src/extras"
import { describeExtra, runAll, todayExtras } from "./src/extras"

const GREEN = "#2EB872"
const ORANGE = "#FF8A00"
const RED = "#FF5A5F"
const TONE: Record<Tone, string> = { ok: GREEN, muted: "secondaryLabel", warn: ORANGE, bad: RED }

function ExtraRow({ title, extra, now }: { title: string; extra?: Extra; now: number }) {
  const { text, tone } = describeExtra(extra, now)
  return (
    <VStack alignment="leading" spacing={2}>
      <Row label={title} value={text} color={TONE[tone]} />
      {extra?.detail ? <Text font="caption" foregroundStyle="secondaryLabel">{extra.detail}</Text> : null}
    </VStack>
  )
}

function Row({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <HStack>
      <Text>{label}</Text>
      <Spacer />
      <Text fontWeight="semibold" foregroundStyle={color ?? "secondaryLabel"}>{value || "—"}</Text>
    </HStack>
  )
}

function timeLabel(ts: number): string {
  if (!ts) return "—"
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function statusRow(state: DayState | null): { text: string; color: string } {
  if (!state || state.date !== taipeiDate()) return { text: "尚未檢查", color: "secondaryLabel" }
  if (state.signed) return { text: "已簽到", color: GREEN }
  if (state.error) return { text: "失敗", color: RED }
  return { text: "尚未簽到", color: ORANGE }
}

function App() {
  const dismiss = Navigation.useDismiss()
  const initial = getSavedAccount()
  const [account, setAccount] = useState(initial)
  const [uid, setUid] = useState(initial.uid)
  const [pwd, setPwd] = useState("")
  const [secret, setSecret] = useState("")
  const [state, setState] = useState<DayState | null>(getState())
  const [busy, setBusy] = useState("")
  const [notice, setNotice] = useState("")
  const [now, setNow] = useState(Date.now())

  // 每秒更新驗證碼預覽
  // 每秒更新驗證碼預覽與廣告等待狀態
  useEffect(() => {
    if (!account.hasTotp && busy !== "all") return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [account.hasTotp, busy])

  const configured = account.uid !== "" && account.hasPassword

  async function runEverything() {
    if (busy) return
    setBusy("all")
    setNotice("")
    try {
      const next = await runAll({ onProgress: (s) => { setState(s); Widget.reloadAll() } })
      setState(next)
      Widget.reloadAll()
    } finally {
      setBusy("")
    }
  }

  async function run(label: string, signIn: boolean) {
    if (busy) return
    setBusy(label)
    setNotice("")
    try {
      const next = await runCheck(signIn)
      setState(next)
      Widget.reloadAll()
    } finally {
      setBusy("")
    }
  }

  function save() {
    try {
      saveCredentials({ uid, pwd: pwd || undefined, totp: secret.trim() ? secret : undefined })
      setPwd("")
      setSecret("")
      setAccount(getSavedAccount())
      setState(getState())
      setNotice("已儲存在本機 Keychain")
      Widget.reloadAll()
    } catch (error) {
      setNotice(messageOf(error))
    }
  }

  function removeTotp() {
    try {
      saveCredentials({ uid: account.uid, totp: "" })
      setAccount(getSavedAccount())
      setNotice("已移除兩步驟驗證金鑰")
    } catch (error) {
      setNotice(messageOf(error))
    }
  }

  async function clearEverything() {
    const ok = await Dialog.confirm({ title: "清除所有資料？", message: "會刪除本機儲存的帳號、密碼、兩步驟驗證金鑰與登入狀態。" })
    if (!ok) return
    clearAll()
    setUid("")
    setPwd("")
    setSecret("")
    setAccount(getSavedAccount())
    setState(null)
    setNotice("已清除")
    Widget.reloadAll()
  }

  const status = statusRow(state)
  const extras = todayExtras(state, now)
  const creds = account.hasTotp ? getCredentials() : null
  const code = creds?.totp ? totp(creds.totp, now) : ""

  return (
    <NavigationStack>
      <List
        navigationTitle="Baha Check"
        navigationBarTitleDisplayMode="inline"
        toolbar={{ cancellationAction: <Button title="完成" action={dismiss} /> }}
      >
        <Section header={<Text>今日狀態</Text>} footer={notice ? <Text>{notice}</Text> : undefined}>
          <Row label="今日" value={status.text} color={status.color} />
          {state && state.date === taipeiDate() && state.signed ? <Row label="連續簽到" value={`${state.days} 天`} /> : null}
          {state?.error && !state.signed ? <Text font="caption" foregroundStyle={RED}>{state.error}</Text> : null}
          {state?.nickname ? <Row label="帳號" value={state.nickname} /> : null}
          <Row label="最後檢查" value={state ? timeLabel(state.checkedAt) : "—"} />
          <Button
            title={busy === "signin" ? "簽到中…" : "立即簽到"}
            systemImage="checkmark.circle"
            disabled={!configured || !!busy}
            action={() => run("signin", true)}
          />
          <Button
            title={busy === "check" ? "檢查中…" : "只檢查狀態"}
            systemImage="arrow.clockwise"
            disabled={!configured || !!busy}
            action={() => run("check", false)}
          />
        </Section>

        <Section
          header={<Text>公會／動畫瘋／廣告</Text>}
          footer={<Text>這三項只顯示在中尺寸小工具，點中尺寸小工具即可全部執行。廣告雙倍需要等約 30 秒；動畫瘋答案取自每日公布答案的小屋文章，不保證正確。</Text>}
        >
          <ExtraRow title="公會簽到" extra={extras.guild} now={now} />
          <ExtraRow title="動畫瘋答題" extra={extras.quiz} now={now} />
          <ExtraRow title="廣告雙倍" extra={extras.ads} now={now} />
          <Button
            title={busy === "all" ? "執行中…（廣告約 30 秒）" : "全部執行"}
            systemImage="bolt"
            disabled={!configured || !!busy}
            action={runEverything}
          />
        </Section>

        <Section
          header={<Text>巴哈姆特帳號</Text>}
          footer={<Text>帳號、密碼與兩步驟驗證金鑰只存在這支 iPhone 的 Keychain，不會上傳或寫進 GitHub。密碼與金鑰欄位留空代表沿用已儲存的值。</Text>}
        >
          <TextField title="帳號" prompt="巴哈姆特帳號" value={uid} onChanged={setUid}
            autocorrectionDisabled textInputAutocapitalization="never" />
          <SecureField title="密碼" prompt={account.hasPassword ? "已儲存（留空沿用）" : "密碼"} value={pwd} onChanged={setPwd} />
          <SecureField title="兩步驟驗證金鑰" prompt={account.hasTotp ? "已儲存（留空沿用）" : "選填，16 碼金鑰或 otpauth:// 網址"}
            value={secret} onChanged={setSecret} />
          <Button title="儲存" systemImage="lock" disabled={!uid.trim()} action={save} />
          {code ? <Row label="目前驗證碼" value={`${code.slice(0, 3)} ${code.slice(3)}（${totpRemaining(now)} 秒）`} /> : null}
          {account.hasTotp ? <Button title="移除兩步驟驗證金鑰" role="destructive" action={removeTotp} /> : null}
        </Section>

        <Section header={<Text>小工具</Text>} footer={<Text>主畫面加入 Scripting 小工具並選擇本腳本。小型只處理主站簽到；中型另外顯示公會、答題、廣告，點一下全部執行。</Text>}>
          <Button title="預覽小型（主站簽到）" systemImage="square" action={() => Widget.preview({ family: "systemSmall" })} />
          <Button title="預覽中型（含公會、答題、廣告）" systemImage="rectangle" action={() => Widget.preview({ family: "systemMedium" })} />
        </Section>

        <Section>
          <Button title="清除所有本機資料" role="destructive" action={clearEverything} />
        </Section>
      </List>
    </NavigationStack>
  )
}

async function main() {
  await Navigation.present({ element: <App /> })
  Script.exit()
}

main()

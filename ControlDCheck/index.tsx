// App 頁面：設定 API Token（只存在本機 Keychain）、選統計區間，
// 查看 DNS 路徑、統計、端點在線狀態、最常被擋的網域，並預覽小工具。
import {
  Button,
  Circle,
  HStack,
  List,
  Navigation,
  NavigationStack,
  Script,
  SecureField,
  Section,
  Spacer,
  Text,
  VStack,
  Widget,
  useEffect,
  useState,
} from "scripting"
import type { Device, RangeKey, Snapshot } from "./src/controld"
import {
  RANGES,
  clearAll,
  fmtAgo,
  fmtCount,
  fmtPct,
  fmtTime,
  getCachedSnapshot,
  getSettings,
  hasToken,
  isOnline,
  loadSnapshot,
  loggingDisabled,
  loggingLabel,
  messageOf,
  onlineCount,
  rangeInfo,
  saveSettings,
  saveToken,
  sortDevices,
  statusLabel,
  trendOf,
  verifyText,
} from "./src/controld"

const GREEN = "#2EB872"
const RED = "#FF5A5F"
const ORANGE = "#FF8A00"
const BLUE = "#3B82F6"
const TRACK = "rgba(142,142,147,0.35)"

function Row({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <HStack>
      <Text>{label}</Text>
      <Spacer />
      <Text fontWeight="semibold" foregroundStyle={color ?? "secondaryLabel"}>{value || "—"}</Text>
    </HStack>
  )
}

function DeviceItem({ device, now }: { device: Device; now: number }) {
  const online = isOnline(device, now)
  const status = statusLabel(device.status)
  const detail = [device.profile, device.profile2, loggingLabel(device.logging)].filter(Boolean).join("・")
  return (
    <VStack alignment="leading" spacing={2}>
      <HStack spacing={8}>
        <Circle fill={online ? GREEN : TRACK} frame={{ width: 8, height: 8 }} />
        <Text fontWeight={online ? "semibold" : "regular"}>{device.name}</Text>
        <Spacer />
        <Text font="subheadline" foregroundStyle={status ? ORANGE : "secondaryLabel"}>
          {status || fmtAgo(device.lastActivity, now)}
        </Text>
      </HStack>
      {detail ? <Text font="caption" foregroundStyle="secondaryLabel">{detail}</Text> : null}
    </VStack>
  )
}

function verifyColor(snap: Snapshot | null): string {
  if (!snap) return "secondaryLabel"
  return snap.verify === "yes" ? GREEN : snap.verify === "no" ? ORANGE : "secondaryLabel"
}

function App() {
  const dismiss = Navigation.useDismiss()
  const [configured, setConfigured] = useState(hasToken())
  const [range, setRange] = useState<RangeKey>(getSettings().range)
  const [snap, setSnap] = useState<Snapshot | null>(getCachedSnapshot())
  const [token, setToken] = useState("")
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState("")

  async function refresh(r: RangeKey = range) {
    setBusy(true)
    try {
      const next = await loadSnapshot({ range: r, top: true })
      setSnap(next)
      Widget.reloadAll()
    } catch (error) {
      setNotice(messageOf(error))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (configured) refresh()
  }, [])

  function save() {
    if (!saveToken(token)) {
      setNotice("Token 格式不對，請重新複製一次")
      return
    }
    setToken("")
    setConfigured(true)
    setSnap(null)
    setNotice("已儲存在本機 Keychain")
    refresh()
  }

  function pickRange(r: RangeKey) {
    if (r === range || busy) return
    setRange(r)
    saveSettings({ range: r })
    refresh(r)
  }

  async function clearEverything() {
    const ok = await Dialog.confirm({ title: "清除所有資料？", message: "會刪除本機儲存的 API Token、統計快取與設定。" })
    if (!ok) return
    clearAll()
    setConfigured(false)
    setSnap(null)
    setRange("today")
    setNotice("已清除")
    Widget.reloadAll()
  }

  const now = Date.now()
  const stats = snap?.stats ?? null
  const trend = trendOf(stats, snap?.prev ?? null)
  const devices = snap?.devices ? sortDevices(snap.devices, now) : []
  const { online, total } = onlineCount(snap?.devices ?? null, now)
  const top = snap?.top ?? []
  const statsNote = snap
    ? (loggingDisabled(snap) ? "所有端點都沒有開啟分析紀錄，到 Control D 網頁版的端點設定開啟「Analytics」後才會有統計。" : snap.statsError)
    : ""

  const statusFooter = [
    notice,
    "DNS 路徑用 verify.controld.com 檢查：只有經過 Control D 的 DNS 才解析得到。開著 Surge 等 VPN 時，結果反映的是 VPN 實際使用的 DNS。",
  ].filter(Boolean).join("\n")

  return (
    <NavigationStack>
      <List
        navigationTitle="Control D"
        navigationBarTitleDisplayMode="inline"
        toolbar={{ cancellationAction: <Button title="完成" action={dismiss} /> }}
      >
        <Section header={<Text>連線狀態</Text>} footer={<Text>{statusFooter}</Text>}>
          {snap?.error ? <Text foregroundStyle={snap.errorCode === "NO_TOKEN" ? "secondaryLabel" : RED}>{snap.error}</Text> : null}
          <Row label="DNS 路徑" value={snap ? verifyText(snap.verify) : "尚未檢查"} color={verifyColor(snap)} />
          <Row label="端點在線" value={snap?.devices ? `${online}／${total} 台` : "—"} />
          <Row label="更新時間" value={snap ? `${fmtTime(snap.fetchedAt, now)}${snap.stale ? "（離線資料）" : ""}` : "—"} />
          <Button
            title={busy ? "讀取中…" : "重新整理"}
            systemImage="arrow.clockwise"
            disabled={!configured || busy}
            action={() => refresh()}
          />
        </Section>

        {configured ? (
          <Section
            header={<Text>{`統計（${rangeInfo(range).label}）`}</Text>}
            footer={<Text>總查詢＝阻擋＋放行＋導向。比較對象是前一段同長度的時間，「今天」對照昨天同一時段。</Text>}
          >
            {stats
              ? [
                  <Row key="t" label="總查詢" value={`${fmtCount(stats.total)}${trend ? `（${trend.text}）` : ""}`} />,
                  <Row key="b" label="已阻擋" value={`${fmtCount(stats.blocked)}（${fmtPct(stats.blocked, stats.total)}）`} color={RED} />,
                  <Row key="p" label="放行" value={`${fmtCount(stats.bypassed)}（${fmtPct(stats.bypassed, stats.total)}）`} color={GREEN} />,
                  <Row key="r" label="導向" value={`${fmtCount(stats.redirected)}（${fmtPct(stats.redirected, stats.total)}）`} color={BLUE} />,
                ]
              : <Text foregroundStyle="secondaryLabel">{busy ? "讀取中…" : "沒有統計資料"}</Text>}
            {statsNote ? <Text font="caption" foregroundStyle={ORANGE}>{statsNote}</Text> : null}
          </Section>
        ) : null}

        <Section
          header={<Text>統計區間</Text>}
          footer={<Text>主畫面小工具可以在「參數」填 today、24h、7d 或 30d 指定區間，留空就跟隨這裡的設定。</Text>}
        >
          {RANGES.map((r) => (
            <Button
              key={r.key}
              title={r.label}
              systemImage={r.key === range ? "checkmark.circle.fill" : "circle"}
              disabled={busy}
              action={() => pickRange(r.key)}
            />
          ))}
        </Section>

        {configured ? (
          <Section header={<Text>端點</Text>} footer={<Text>最後一次查詢在 15 分鐘內算「在線」。停用中的端點會顯示軟停用或硬停用。</Text>}>
            {snap?.devices
              ? devices.length
                ? devices.map((d) => <DeviceItem key={d.id} device={d} now={now} />)
                : <Text foregroundStyle="secondaryLabel">沒有端點</Text>
              : <Text foregroundStyle="secondaryLabel">{snap?.devicesError || (busy ? "讀取中…" : "尚未讀取")}</Text>}
          </Section>
        ) : null}

        {top.length ? (
          <Section header={<Text>最常被擋的網域</Text>}>
            {top.map((row) => <Row key={row.value} label={row.value} value={fmtCount(row.count)} />)}
          </Section>
        ) : null}

        <Section
          header={<Text>API Token</Text>}
          footer={<Text>到 Control D 網頁版 Preferences → API 建立 Token，選 Read 權限就夠用。Token 只存在這支 iPhone 的 Keychain，不會上傳或寫進 GitHub。</Text>}
        >
          <SecureField
            title="API Token"
            prompt={configured ? "已儲存（貼上新的會取代）" : "貼上 Control D API Token"}
            value={token}
            onChanged={setToken}
          />
          <Button title="儲存" systemImage="lock" disabled={!token.trim()} action={save} />
        </Section>

        <Section
          header={<Text>小工具</Text>}
          footer={<Text>主畫面有小、中、大三種尺寸；鎖定畫面有圓形（封鎖比例環）、矩形與單行。右上角盾牌：綠色＝這支 iPhone 走 Control D，橘色＝沒走。</Text>}
        >
          <Button title="預覽小型" systemImage="square" action={() => Widget.preview({ family: "systemSmall" })} />
          <Button title="預覽中型" systemImage="rectangle" action={() => Widget.preview({ family: "systemMedium" })} />
          <Button title="預覽大型" systemImage="rectangle.portrait" action={() => Widget.preview({ family: "systemLarge" })} />
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

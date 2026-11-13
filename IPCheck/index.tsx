// 主頁面：查看上一次快照、手動診斷、Surge 狀態、設定，並可開啟 IP 詳細檢測。
import {
  Button,
  HStack,
  List,
  Navigation,
  NavigationStack,
  Script,
  Section,
  Spacer,
  Text,
  TextField,
  Toggle,
  VStack,
  Widget,
  useEffect,
  useState,
} from "scripting"
import IPPage from "./page"
import { diagnose } from "./src/diagnose"
import { enrich, testedDirect } from "./src/enrich"
import { agoLabel, flagOf, maskIP } from "./src/net"
import { clearSnapshot, getSettings, getSnapshot, saveSettings, saveSnapshot } from "./src/store"
import type { Settings } from "./src/store"
import { maskKey, policyLabel, readSurgeState } from "./src/surge"
import type { ServiceInfo, Snapshot, SurgeInfo } from "./src/types"
import { serviceStateText } from "./src/unlock"

const GREEN = "#2ED47A"
const AMBER = "#FFB020"
const RED = "#FF5A5F"
const GRAY = "#8A8A92"

function Row({ label, value, color }: { label: string; value: string; color?: any }) {
  return (
    <HStack>
      <Text>{label}</Text>
      <Spacer />
      <Text fontWeight="semibold" foregroundStyle={color}>
        {value || "—"}
      </Text>
    </HStack>
  )
}

function colorFor(score: number): string {
  if (score >= 75) return GREEN
  if (score >= 45) return AMBER
  return RED
}

function latencyColor(ms: number | undefined): string {
  if (!ms) return RED
  return ms <= 220 ? GREEN : ms <= 500 ? AMBER : RED
}

function serviceColor(item: ServiceInfo): string {
  if (item.state === "warn") return AMBER
  if (item.state === "soon" || item.state === "na") return GRAY
  return item.ok ? GREEN : RED
}

function ServiceRow({ item }: { item: ServiceInfo }) {
  const detail = [item.note, policyLabel(item.policy)].filter(Boolean).join(" · ")
  return (
    <HStack>
      <VStack alignment="leading" spacing={2}>
        <Text>{item.name}</Text>
        {detail ? <Text font={12} foregroundStyle="secondaryLabel">{detail}</Text> : null}
      </VStack>
      <Spacer />
      <Text fontWeight="semibold" foregroundStyle={serviceColor(item)}>
        {[/^[A-Z]{2}$/.test(item.cc) ? item.cc : "", serviceStateText(item)].filter(Boolean).join(" ")}
      </Text>
    </HStack>
  )
}

function RadarPage() {
  const [settings, setSettings] = useState<Settings>(getSettings())
  const [snapshot, setSnapshot] = useState<Snapshot | null>(getSnapshot())
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState("")
  const [surgeInfo, setSurgeInfo] = useState<SurgeInfo | null>(null)
  const [surgeStatus, setSurgeStatus] = useState("未讀取")
  const [surgeNote, setSurgeNote] = useState("")

  useEffect(() => {
    if (!snapshot) void runDiagnose()
    void refreshSurge()
  }, [])

  async function runDiagnose() {
    setLoading(true)
    setMessage("")
    try {
      const result = (await enrich(await diagnose(), getSettings()))!
      saveSnapshot(result)
      setSnapshot(result)
      Widget.reloadAll()
      setMessage(`診斷完成 · 耗時 ${((result.cost || 0) / 1000).toFixed(1)} 秒`)
    } catch (error) {
      setMessage("診斷失敗：" + String(error))
    }
    setLoading(false)
    void refreshSurge()
  }

  async function refreshSurge() {
    const current = getSettings()
    if (!current.surgeKey) {
      setSurgeInfo(null)
      setSurgeStatus("未設定")
      setSurgeNote("")
      return
    }
    setSurgeStatus("讀取中…")
    const state = await readSurgeState(current)
    setSurgeInfo(state.info)
    setSurgeStatus(state.status === "ok" ? "已連線" : "未連線")
    setSurgeNote(state.note)
  }

  function update(patch: Partial<Settings>) {
    setSettings(saveSettings(patch))
  }

  async function openDetail() {
    await Navigation.present(<IPPage />)
  }

  const exit = snapshot?.exit
  const local = snapshot?.local
  const masked = settings.maskIP || snapshot?.masked === true
  const ipText = exit ? (masked ? maskIP(exit.ip) : exit.ip) : ""
  const fromSurge = snapshot?.src === "surge"
  const surgeColor = surgeStatus === "已連線" ? GREEN : surgeStatus === "未連線" ? AMBER : GRAY

  return (
    <NavigationStack>
      <List navigationTitle="網路診斷雷達">
        <Section
          header={<Text>出口</Text>}
          footer={
            <Text>
              {snapshot
                ? `${fromSurge ? "Surge 快照" : "本機自測"} · ${agoLabel(snapshot.ts)}`
                  + (testedDirect(snapshot)
                    ? `。這次檢測的請求在 Surge 都走直連，以上是直連出口，不是目前節點 ${snapshot.surge?.node || ""}；要測節點，請讓 Scripting 的流量走代理，或改用 Surge 模組的結果。`
                    : "")
                : "還沒有資料，點下方「立即診斷」開始"}
            </Text>
          }
        >
          <Row
            label="位置"
            value={exit ? `${flagOf(exit.cc)} ${[exit.country || exit.region, exit.city].filter(Boolean).join(" · ")}`.trim() : ""}
          />
          <Row label="出口 IP" value={ipText} />
          <Row label="電信業者" value={exit?.isp || exit?.org || ""} />
          <Row label="ASN" value={exit?.asn || ""} />
          <Row label="網路類型" value={exit?.kind || ""} />
          <Row
            label="純淨度"
            value={exit ? `${exit.purity} · ${exit.risk}` : ""}
            color={exit ? colorFor(exit.purity) : undefined}
          />
          <Button title="IP 詳細檢測（多來源對照、風險評分、WebRTC）" action={openDetail} />
        </Section>

        <Section
          header={<Text>連線</Text>}
          footer={
            <Text>
              {fromSurge
                ? "Surge 快照：代理延遲走指定策略，直連延遲走 DIRECT。"
                : "本機自測無法指定策略：國際延遲量 Cloudflare／Google，台灣延遲量 HiNet／中華電信／TWNIC／台大，實際走哪條線由 Surge 規則決定。"}
            </Text>
          }
        >
          <Row label="本機網路" value={local?.net || ""} />
          <Row label="內網 IP" value={local ? (masked ? maskIP(local.ip) : local.ip) : ""} />
          <Row label="NAT" value={local?.nat || ""} />
          <Row label="IPv6" value={local ? (local.v6 ? "已取得" : "未取得") : ""} />
          {local?.carrier || local?.area
            ? <Row label="直連歸屬" value={[local?.carrier, local?.area].filter(Boolean).join(" · ")} /> : null}
          <Row
            label={fromSurge ? "代理延遲" : "國際延遲"}
            value={snapshot ? (snapshot.lat.proxy ? `${snapshot.lat.proxy} ms` : "逾時") : ""}
            color={snapshot ? latencyColor(snapshot.lat.proxy) : undefined}
          />
          <Row
            label={fromSurge ? "直連延遲" : "台灣延遲"}
            value={snapshot ? (snapshot.lat.local ? `${snapshot.lat.local} ms` : "逾時") : ""}
            color={snapshot ? latencyColor(snapshot.lat.local) : undefined}
          />
          <Row
            label="HTTP/3（QUIC）"
            value={snapshot ? (snapshot.quic.ok ? "可用" : snapshot.quic.reachable ? "未使用" : "無回應") : ""}
            color={snapshot?.quic.ok ? GREEN : AMBER}
          />
        </Section>

        <Section
          header={<Text>Surge 目前狀態</Text>}
          footer={
            <Text>
              {settings.surgeKey
                ? `${surgeNote || "讀取中"}。小工具每次重新整理都會重讀，切換節點或協定後卡片上的「目前代理」會跟著更新。`
                : "開啟 Surge 的 http-api 並在下方填入 x-key，就能顯示目前節點與協定，並標出每項服務實際經過的策略。"}
            </Text>
          }
        >
          <Row label="連線" value={surgeStatus} color={surgeColor} />
          <Row label="目前節點" value={surgeInfo?.node || ""} />
          <Row label="協定" value={surgeInfo?.protocol || ""} />
          <Row label="出站模式" value={surgeInfo?.mode || ""} />
          <Row label="策略群組" value={surgeInfo?.policy || ""} />
          <Button title="重新讀取" action={refreshSurge} />
        </Section>

        <Section
          header={<Text>串流</Text>}
          footer={<Text>YouTube、Netflix、Disney+、動畫瘋會判斷地區與可觀看範圍；Spotify、Prime Video 只確認可連線。</Text>}
        >
          {(snapshot?.media || []).map((item) => <ServiceRow key={item.id} item={item} />)}
          {!snapshot ? <Text foregroundStyle="secondaryLabel">尚無資料</Text> : null}
        </Section>

        <Section
          header={<Text>AI</Text>}
          footer={<Text>ChatGPT 會比對支援地區與 App 限制；其餘只確認可連線，不代表帳號可在當地註冊或付費。</Text>}
        >
          {(snapshot?.ai || []).map((item) => <ServiceRow key={item.id} item={item} />)}
          {!snapshot ? <Text foregroundStyle="secondaryLabel">尚無資料</Text> : null}
        </Section>

        <Section header={<Text>操作</Text>} footer={<Text>{message || "診斷大約需要 5–15 秒。"}</Text>}>
          <Button title={loading ? "診斷中…" : "立即診斷"} action={runDiagnose} disabled={loading} />
          <Button
            title="預覽大型小工具"
            action={() => {
              Widget.preview({ family: "systemLarge" })
            }}
          />
          <Button
            title="清除快取"
            role="destructive"
            action={() => {
              clearSnapshot()
              setSnapshot(null)
              Widget.reloadAll()
              setMessage("快取已清除")
            }}
          />
        </Section>

        <Section
          header={<Text>小工具設定</Text>}
          footer={
            <Text>
              重新整理間隔同時也是小工具重新診斷的週期。若在 Surge 腳本設定了 SYNC 網址，把同一個網址填到「Surge 快照網址」，小工具就會直接顯示
              Surge 端依策略檢測的結果。
            </Text>
          }
        >
          <TextField
            title="重新整理間隔（分鐘）"
            value={String(settings.refreshMinutes)}
            onChanged={(value) => {
              const minutes = Number(value)
              if (Number.isFinite(minutes) && minutes >= 5) update({ refreshMinutes: minutes })
            }}
          />
          <Toggle
            title="顯示時遮蔽 IP"
            value={settings.maskIP}
            onChanged={(value) => {
              update({ maskIP: value })
              Widget.reloadAll()
            }}
          />
          <TextField
            title="Surge 快照網址"
            prompt="https://…/radar.json"
            value={settings.snapshotURL}
            onChanged={(value) => update({ snapshotURL: value })}
          />
        </Section>

        <Section
          header={<Text>Surge HTTP API</Text>}
          footer={
            <Text>
              在 Surge 設定檔的 [General] 加入「http-api = 你的金鑰@127.0.0.1:6171」，再把金鑰填到這裡。金鑰只儲存在這台裝置
              {settings.surgeKey ? `（目前：${maskKey(settings.surgeKey)}）` : ""}。
            </Text>
          }
        >
          <TextField title="x-key" value={settings.surgeKey} onChanged={(value) => update({ surgeKey: value })} />
          <TextField title="主機" value={settings.surgeHost} onChanged={(value) => update({ surgeHost: value })} />
          <TextField
            title="連接埠"
            value={String(settings.surgePort)}
            onChanged={(value) => {
              const port = Number(value)
              if (Number.isInteger(port) && port > 0 && port < 65536) update({ surgePort: port })
            }}
          />
        </Section>
      </List>
    </NavigationStack>
  )
}

async function run() {
  try {
    await Navigation.present(<RadarPage />)
  } catch (error) {
    console.error("[網路診斷雷達] 頁面呈現失敗", error)
  } finally {
    Script.exit()
  }
}

void run()

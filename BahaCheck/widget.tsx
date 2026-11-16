// 小型：只顯示主站簽到（未簽到時點一下簽到；已簽到顯示連續天數）。
// 中型：左邊主站簽到，右邊公會簽到、動畫瘋答題、廣告雙倍。
// 不論大小，小工具每次更新都會在背景自動執行公會、答題、廣告雙倍（廣告需主站已簽到）。
import { Button, HStack, Image, Rectangle, Spacer, Text, VStack, Widget } from "scripting"
import { RunAllIntent, SignInIntent } from "./app_intents"
import type { DayState, Extra, WidgetState } from "./src/baha"
import {
  getState,
  hasCredentials,
  needsRefresh,
  runCheck,
  widgetStateOf,
} from "./src/baha"
import type { Tone } from "./src/extras"
import { adRunning, allDone, autoExtras, describeExtra, nextReload, todayExtras } from "./src/extras"

const BRAND = "#00A7C4"
const GREEN = "#2EB872"
const ORANGE = "#FF8A00"
const RED = "#FF5A5F"
const BG = { light: "#FFFFFF", dark: "#16181D" } as const
const DIVIDER = "rgba(142,142,147,0.3)"
const FILL = { maxWidth: "infinity", maxHeight: "infinity" } as const

const TONE: Record<Tone, string> = { ok: GREEN, muted: "secondaryLabel", warn: ORANGE, bad: RED }

function Header({ icon, color }: { icon?: string; color?: string }) {
  return (
    <HStack spacing={5}>
      <Image systemName="gamecontroller.fill" font={12} foregroundStyle={BRAND} />
      <Text font={13} fontWeight="semibold">巴哈姆特</Text>
      <Spacer />
      {icon ? <Image systemName={icon} font={15} foregroundStyle={color} /> : null}
    </HStack>
  )
}

function TapHint({ title, color }: { title: string; color: string }) {
  return (
    <HStack spacing={4} padding={{ horizontal: 10, vertical: 5 }}
      widgetBackground={{ style: color, shape: { type: "capsule" } }}>
      <Image systemName="hand.tap.fill" font={11} foregroundStyle="white" />
      <Text font={12} fontWeight="semibold" foregroundStyle="white" lineLimit={1}>{title}</Text>
    </HStack>
  )
}

/** 背景放在最外層；有 intent 時整張卡（含空白處）都可以點。 */
function Card({ children, intent }: { children: any; intent?: any }) {
  const body = (
    <VStack alignment="leading" spacing={4} frame={{ ...FILL, alignment: "topLeading" }} contentShape="rect">
      {children}
    </VStack>
  )
  return (
    <VStack padding={14} frame={FILL} widgetBackground={BG}>
      {intent ? <Button intent={intent} buttonStyle="plain">{body}</Button> : body}
    </VStack>
  )
}

function Days({ days, size }: { days: number; size: number }) {
  return (
    <HStack alignment="lastTextBaseline" spacing={3}>
      <Text font={size} fontWeight="bold" fontDesign="rounded" lineLimit={1} minScaleFactor={0.5}>{String(days)}</Text>
      <Text font={15} fontWeight="semibold" foregroundStyle="secondaryLabel">天</Text>
    </HStack>
  )
}

// ── 小型 ──

function SmallView({ view }: { view: WidgetState }) {
  switch (view.kind) {
    case "signed":
      return (
        <Card>
          <Header icon="checkmark.seal.fill" color={GREEN} />
          <Spacer />
          <Text font={15} fontWeight="semibold" foregroundStyle={GREEN}>今日已簽到</Text>
          <Text font={12} foregroundStyle="secondaryLabel">連續簽到</Text>
          <Days days={view.days} size={38} />
        </Card>
      )
    case "error":
      return (
        <Card intent={SignInIntent(undefined)}>
          <Header icon="exclamationmark.triangle.fill" color={RED} />
          <Spacer />
          <Text font={15} fontWeight="semibold" foregroundStyle={RED}>無法簽到</Text>
          <Text font={11} foregroundStyle="secondaryLabel" lineLimit={3}>{view.message}</Text>
          <Spacer />
          <TapHint title="點擊重試" color={BRAND} />
        </Card>
      )
    case "setup":
      return <SetupView />
    default:
      return (
        <Card intent={SignInIntent(undefined)}>
          <Header icon="exclamationmark.circle.fill" color={ORANGE} />
          <Spacer />
          <Text font={24} fontWeight="bold" foregroundStyle={ORANGE}>尚未簽到</Text>
          <Spacer />
          <TapHint title="點擊簽到" color={BRAND} />
        </Card>
      )
  }
}

function SetupView() {
  return (
    <Card>
      <Header />
      <Spacer />
      <Text font={16} fontWeight="semibold">尚未設定帳號</Text>
      <Text font={12} foregroundStyle="secondaryLabel">開啟 App 輸入帳號密碼</Text>
    </Card>
  )
}

// ── 中型 ──

function ExtraRow({ icon, title, extra, emptyText }: { icon: string; title: string; extra?: Extra; emptyText?: string }) {
  const { text, tone } = describeExtra(extra, emptyText)
  const color = TONE[tone]
  return (
    <HStack spacing={8}>
      <VStack frame={{ width: 26, height: 26 }}
        widgetBackground={{ style: "rgba(0,167,196,0.14)", shape: { type: "rect", cornerRadius: 7 } }}>
        <Image systemName={icon} font={12} foregroundStyle={BRAND} />
      </VStack>
      <VStack alignment="leading" spacing={0}>
        <Text font={11} foregroundStyle="secondaryLabel" lineLimit={1}>{title}</Text>
        <Text font={13} fontWeight="semibold" foregroundStyle={color} lineLimit={1} minScaleFactor={0.7}>{text}</Text>
      </VStack>
      <Spacer />
    </HStack>
  )
}

function MainColumn({ view, done, signed }: { view: WidgetState; done: boolean; signed: boolean }) {
  let status: any
  if (view.kind === "signed") {
    status = (
      <VStack alignment="leading" spacing={0}>
        <Text font={13} fontWeight="semibold" foregroundStyle={GREEN}>今日已簽到</Text>
        <Days days={view.days} size={34} />
      </VStack>
    )
  } else if (view.kind === "error") {
    status = (
      <VStack alignment="leading" spacing={2}>
        <Text font={15} fontWeight="semibold" foregroundStyle={RED}>無法簽到</Text>
        <Text font={11} foregroundStyle="secondaryLabel" lineLimit={2}>{view.message}</Text>
      </VStack>
    )
  } else {
    status = <Text font={22} fontWeight="bold" foregroundStyle={ORANGE}>尚未簽到</Text>
  }
  const icon = view.kind === "signed" ? "checkmark.seal.fill" : view.kind === "error" ? "exclamationmark.triangle.fill" : "exclamationmark.circle.fill"
  const color = view.kind === "signed" ? GREEN : view.kind === "error" ? RED : ORANGE
  return (
    <VStack alignment="leading" spacing={4} frame={{ maxHeight: "infinity", alignment: "topLeading" }}>
      <Header icon={icon} color={color} />
      <Spacer />
      {status}
      <Spacer />
      {done
        ? <HStack spacing={4}>
            <Image systemName="checkmark.circle.fill" font={12} foregroundStyle={GREEN} />
            <Text font={12} fontWeight="semibold" foregroundStyle={GREEN}>今日全部完成</Text>
          </HStack>
        : signed
          ? <HStack spacing={4}>
              <Image systemName="arrow.triangle.2.circlepath" font={11} foregroundStyle="secondaryLabel" />
              <Text font={12} foregroundStyle="secondaryLabel" lineLimit={1}>其餘項目自動執行</Text>
            </HStack>
          : <TapHint title={view.kind === "error" ? "點擊重試" : "點擊簽到"} color={BRAND} />}
    </VStack>
  )
}

function MediumView({ view, state, now }: { view: WidgetState; state: DayState | null; now: number }) {
  if (view.kind === "setup") return <SetupView />
  const extras = todayExtras(state, now)
  const done = allDone(state, now)
  const running = adRunning(state, now)
  const content = (
    <HStack alignment="top" spacing={12} frame={FILL}>
      <VStack frame={{ width: 128, maxHeight: "infinity", alignment: "topLeading" }}>
        <MainColumn view={view} done={done} signed={view.kind === "signed"} />
      </VStack>
      <Rectangle fill={DIVIDER} frame={{ width: 0.5 }} />
      <VStack alignment="leading" spacing={8} frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "leading" }}>
        <ExtraRow icon="person.3.fill" title="公會簽到" extra={extras.guild} />
        <ExtraRow icon="questionmark.bubble.fill" title="動畫瘋答題" extra={extras.quiz} />
        <ExtraRow icon="gift.fill" title="廣告雙倍" extra={extras.ads}
          emptyText={view.kind === "signed" ? "等待執行" : "簽到後自動領"} />
      </VStack>
    </HStack>
  )
  // 點擊＝立即全部執行（含主站簽到）；全部完成或廣告正在領取時不接受點擊，避免重複執行
  return <Card intent={done || running ? undefined : RunAllIntent(undefined)}>{content}</Card>
}

// ── 進入點 ──

function timeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([promise, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))])
}

async function main() {
  const configured = hasCredentials()
  const medium = Widget.family === "systemMedium" || Widget.family === "systemLarge" || Widget.family === "systemExtraLarge"
  let state = getState()
  if (configured) {
    // 1. 主站：只查狀態（簽到要點小工具）
    if (needsRefresh(state)) state = (await timeout(runCheck(false), 12_000)) ?? getState()
    // 2. 公會、答題、廣告雙倍：背景自動執行（不等待，廣告下次更新再領）
    state = (await timeout(autoExtras(), 15_000)) ?? getState()
  }
  const now = Date.now()
  const view = widgetStateOf(state, configured, now)

  Widget.present(medium ? <MediumView view={view} state={state} now={now} /> : <SmallView view={view} />, {
    reloadPolicy: { policy: "after", date: new Date(nextReload(state, configured, now)) },
  })
}

main()

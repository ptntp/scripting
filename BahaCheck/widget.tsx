// 小型小工具：今日未簽到 → 顯示「尚未簽到」，點一下就簽到；已簽到 → 顯示連續簽到天數。
import { Button, HStack, Image, Spacer, Text, VStack, Widget } from "scripting"
import { SignInIntent } from "./app_intents"
import {
  WidgetState,
  getState,
  hasCredentials,
  needsRefresh,
  nextTaipeiMidnight,
  runCheck,
  widgetStateOf,
} from "./src/baha"

const BRAND = "#00A7C4"
const GREEN = "#2EB872"
const ORANGE = "#FF8A00"
const RED = "#FF5A5F"
const BG = { light: "#FFFFFF", dark: "#16181D" } as const
const FILL = { maxWidth: "infinity", maxHeight: "infinity" } as const

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
      <Text font={12} fontWeight="semibold" foregroundStyle="white">{title}</Text>
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

function SignedView({ days }: { days: number }) {
  return (
    <Card>
      <Header icon="checkmark.seal.fill" color={GREEN} />
      <Spacer />
      <Text font={15} fontWeight="semibold" foregroundStyle={GREEN}>今日已簽到</Text>
      <Text font={12} foregroundStyle="secondaryLabel">連續簽到</Text>
      <HStack alignment="lastTextBaseline" spacing={3}>
        <Text font={38} fontWeight="bold" fontDesign="rounded" lineLimit={1} minScaleFactor={0.5}>{String(days)}</Text>
        <Text font={15} fontWeight="semibold" foregroundStyle="secondaryLabel">天</Text>
      </HStack>
    </Card>
  )
}

function UnsignedView() {
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

function ErrorView({ message }: { message: string }) {
  return (
    <Card intent={SignInIntent(undefined)}>
      <Header icon="exclamationmark.triangle.fill" color={RED} />
      <Spacer />
      <Text font={15} fontWeight="semibold" foregroundStyle={RED}>無法簽到</Text>
      <Text font={11} foregroundStyle="secondaryLabel" lineLimit={3}>{message}</Text>
      <Spacer />
      <TapHint title="點擊重試" color={BRAND} />
    </Card>
  )
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

function viewFor(state: WidgetState) {
  switch (state.kind) {
    case "signed": return <SignedView days={state.days} />
    case "error": return <ErrorView message={state.message} />
    case "setup": return <SetupView />
    default: return <UnsignedView />
  }
}

function timeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([promise, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))])
}

async function main() {
  const configured = hasCredentials()
  let state = getState()
  if (configured && needsRefresh(state)) {
    state = (await timeout(runCheck(false), 25_000)) ?? getState()
  }
  const view = widgetStateOf(state, configured)
  const now = Date.now()
  // 已簽到：台灣午夜過後再更新；其他狀態每小時檢查一次（期間若在別處簽到也會更新）。
  const reload = view.kind === "signed" ? nextTaipeiMidnight(now) + 2 * 60_000 : now + 60 * 60_000
  Widget.present(viewFor(view), { reloadPolicy: { policy: "after", date: new Date(reload) } })
}

main()

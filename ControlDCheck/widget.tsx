// 小型：封鎖比例、封鎖／總查詢數，右上角顯示這支 iPhone 是否走 Control D。
// 中型：左邊統計與前期比較，右邊端點在線狀態。
// 大型：四格統計、比例條、端點清單、最常被擋的網域。
// 鎖定畫面：圓形（封鎖比例環）、矩形（統計＋在線端點）、單行。
// 小工具參數可指定統計區間：today、24h、7d、30d；留空跟隨 App 裡的設定。
import { AccessoryWidgetBackground, Circle, HStack, Image, Rectangle, Spacer, Text, VStack, Widget, ZStack } from "scripting"
import type { Counts, Device, Snapshot, Verify } from "./src/controld"
import {
  blockedRatio,
  fallbackSnapshot,
  fmtAgo,
  fmtCount,
  fmtPct,
  fmtTime,
  isOnline,
  loadSnapshot,
  loggingDisabled,
  nextReload,
  onlineCount,
  parseRange,
  rangeInfo,
  sortDevices,
  statusLabel,
  trendOf,
} from "./src/controld"

const BRAND = "#6D5DFC"
const RED = "#FF5A5F"
const GREEN = "#2EB872"
const BLUE = "#3B82F6"
const ORANGE = "#FF8A00"
const TRACK = "rgba(142,142,147,0.25)"
const DIVIDER = "rgba(142,142,147,0.3)"
const BG = { light: "#FFFFFF", dark: "#16181D" } as const
const FILL = { maxWidth: "infinity", maxHeight: "infinity" } as const

// 拿不到 Widget.displaySize 時的備用尺寸（iPhone 6.1 吋）
const FALLBACK_SIZE: Record<string, { width: number; height: number }> = {
  systemSmall: { width: 158, height: 158 },
  systemMedium: { width: 338, height: 158 },
  systemLarge: { width: 338, height: 354 },
  systemExtraLarge: { width: 715, height: 354 },
}

function widgetWidth(family: string): number {
  const d = Widget.displaySize
  if (d && d.width > 0) return d.width
  return (FALLBACK_SIZE[family] ?? FALLBACK_SIZE.systemMedium).width
}

// ── 共用元件 ──

function verifyIcon(v: Verify): { icon: string; color: string; short: string } {
  if (v === "yes") return { icon: "checkmark.shield.fill", color: GREEN, short: "已走 Control D" }
  if (v === "no") return { icon: "xmark.shield.fill", color: ORANGE, short: "沒走 Control D" }
  return { icon: "questionmark.circle", color: "secondaryLabel", short: "DNS 無法判斷" }
}

function Header({ snap, showText = false }: { snap: Snapshot; showText?: boolean }) {
  const v = verifyIcon(snap.verify)
  return (
    <HStack spacing={5}>
      <Image systemName="shield.lefthalf.filled" font={12} foregroundStyle={BRAND} />
      <Text font={13} fontWeight="semibold" lineLimit={1}>Control D</Text>
      <Spacer />
      {snap.stale ? <Text font={10} foregroundStyle="secondaryLabel">離線資料</Text> : null}
      {showText ? <Text font={11} fontWeight="medium" foregroundStyle={v.color} lineLimit={1}>{v.short}</Text> : null}
      <Image systemName={v.icon} font={14} foregroundStyle={v.color} />
    </HStack>
  )
}

function Card({ children }: { children: any }) {
  return (
    <VStack padding={14} frame={FILL} widgetBackground={BG}>
      <VStack alignment="leading" spacing={4} frame={{ ...FILL, alignment: "topLeading" }}>
        {children}
      </VStack>
    </VStack>
  )
}

/** 封鎖（紅）、導向（藍）、放行（綠）的比例條 */
function RatioBar({ stats, width, height = 6 }: { stats: Counts | null; width: number; height?: number }) {
  const total = stats && stats.total > 0 ? stats.total : 0
  if (!total || !stats) return <Rectangle fill={TRACK} frame={{ width, height }} clipShape="capsule" />
  const part = (n: number) => (n > 0 ? Math.max(2, (width * n) / total) : 0)
  const blocked = part(stats.blocked)
  const redirected = part(stats.redirected)
  const bypassed = Math.max(0, width - blocked - redirected)
  return (
    <HStack spacing={0} frame={{ width, height }} clipShape="capsule">
      {blocked ? <Rectangle fill={RED} frame={{ width: blocked, height }} /> : null}
      {redirected ? <Rectangle fill={BLUE} frame={{ width: redirected, height }} /> : null}
      {bypassed ? <Rectangle fill={GREEN} frame={{ width: bypassed, height }} /> : null}
    </HStack>
  )
}

function BigPct({ stats, size }: { stats: Counts; size: number }) {
  return (
    <Text font={size} fontWeight="bold" fontDesign="rounded" foregroundStyle={RED} lineLimit={1} minScaleFactor={0.5}>
      {fmtPct(stats.blocked, stats.total)}
    </Text>
  )
}

/** 統計拿不到時的說明（端點還是照常顯示） */
function StatsNote({ snap }: { snap: Snapshot }) {
  const reason = loggingDisabled(snap) ? "端點都沒有開啟分析紀錄" : snap.statsError || "統計無法取得"
  return (
    <VStack alignment="leading" spacing={2}>
      <Text font={14} fontWeight="semibold" foregroundStyle={ORANGE} lineLimit={1}>沒有統計</Text>
      <Text font={11} foregroundStyle="secondaryLabel" lineLimit={3}>{reason}</Text>
    </VStack>
  )
}

function DeviceRow({ device, now, showProfile = false }: { device: Device; now: number; showProfile?: boolean }) {
  const online = isOnline(device, now)
  const status = statusLabel(device.status)
  return (
    <HStack spacing={6}>
      <Circle fill={online ? GREEN : TRACK} frame={{ width: 7, height: 7 }} />
      <Text font={12} fontWeight={online ? "semibold" : "regular"} lineLimit={1}>{device.name}</Text>
      {showProfile && device.profile
        ? <Text font={10} foregroundStyle="secondaryLabel" lineLimit={1}>{device.profile}</Text>
        : null}
      <Spacer />
      <Text font={11} foregroundStyle={status ? ORANGE : "secondaryLabel"} lineLimit={1}>
        {status || fmtAgo(device.lastActivity, now)}
      </Text>
    </HStack>
  )
}

function DeviceList({ snap, now, limit, showProfile = false }: { snap: Snapshot; now: number; limit: number; showProfile?: boolean }) {
  if (!snap.devices) {
    return <Text font={11} foregroundStyle="secondaryLabel" lineLimit={2}>{snap.devicesError || "端點無法取得"}</Text>
  }
  if (snap.devices.length === 0) return <Text font={11} foregroundStyle="secondaryLabel">沒有端點</Text>
  const list = sortDevices(snap.devices, now).slice(0, limit)
  return (
    <VStack alignment="leading" spacing={5}>
      {list.map((d) => <DeviceRow key={d.id} device={d} now={now} showProfile={showProfile} />)}
    </VStack>
  )
}

function SectionTitle({ title, trailing }: { title: string; trailing?: string }) {
  return (
    <HStack>
      <Text font={12} fontWeight="semibold" foregroundStyle="secondaryLabel">{title}</Text>
      <Spacer />
      {trailing ? <Text font={11} foregroundStyle="secondaryLabel">{trailing}</Text> : null}
    </HStack>
  )
}

function onlineText(snap: Snapshot, now: number): string {
  const { online, total } = onlineCount(snap.devices, now)
  return snap.devices ? `在線 ${online}/${total}` : ""
}

// ── 主畫面 ──

function SetupView({ snap }: { snap: Snapshot }) {
  const setup = snap.errorCode === "NO_TOKEN"
  return (
    <Card>
      <HStack spacing={5}>
        <Image systemName="shield.lefthalf.filled" font={12} foregroundStyle={BRAND} />
        <Text font={13} fontWeight="semibold">Control D</Text>
      </HStack>
      <Spacer />
      <Text font={16} fontWeight="semibold" foregroundStyle={setup ? "label" : ORANGE} lineLimit={2}>
        {setup ? "尚未設定 API Token" : snap.error}
      </Text>
      <Text font={12} foregroundStyle="secondaryLabel" lineLimit={2}>
        {setup ? "開啟 App 貼上 Token" : snap.errorCode === "AUTH" ? "開啟 App 重新設定 Token" : "稍後會自動重試"}
      </Text>
    </Card>
  )
}

function SmallView({ snap, width }: { snap: Snapshot; width: number }) {
  const stats = snap.stats
  return (
    <Card>
      <Header snap={snap} />
      <Spacer />
      {stats && stats.total > 0
        ? [
            <Text key="l" font={11} foregroundStyle="secondaryLabel">{`${rangeInfo(snap.range).short}已阻擋`}</Text>,
            <BigPct key="p" stats={stats} size={34} />,
            <RatioBar key="b" stats={stats} width={width - 28} />,
            <Text key="c" font={11} foregroundStyle="secondaryLabel" lineLimit={1} minScaleFactor={0.7}>
              {`擋 ${fmtCount(stats.blocked)}・共 ${fmtCount(stats.total)}`}
            </Text>,
          ]
        : <StatsNote snap={snap} />}
    </Card>
  )
}

function MediumView({ snap, now }: { snap: Snapshot; now: number }) {
  const stats = snap.stats
  const trend = trendOf(stats, snap.prev)
  const left = 132
  return (
    <Card>
      <HStack alignment="top" spacing={12} frame={FILL}>
        <VStack alignment="leading" spacing={4} frame={{ width: left, maxHeight: "infinity", alignment: "topLeading" }}>
          <Header snap={snap} />
          <Spacer />
          {stats && stats.total > 0
            ? [
                <Text key="l" font={11} foregroundStyle="secondaryLabel">{`${rangeInfo(snap.range).short}已阻擋`}</Text>,
                <BigPct key="p" stats={stats} size={32} />,
                <RatioBar key="b" stats={stats} width={left} />,
                <Text key="c" font={11} foregroundStyle="secondaryLabel" lineLimit={1} minScaleFactor={0.7}>
                  {`擋 ${fmtCount(stats.blocked)}・共 ${fmtCount(stats.total)}`}
                </Text>,
                trend
                  ? <Text key="t" font={11} foregroundStyle="secondaryLabel" lineLimit={1}>{`查詢量 ${trend.text}`}</Text>
                  : null,
              ]
            : <StatsNote snap={snap} />}
        </VStack>
        <Rectangle fill={DIVIDER} frame={{ width: 0.5 }} />
        <VStack alignment="leading" spacing={6} frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "topLeading" }}>
          <SectionTitle title="端點" trailing={onlineText(snap, now)} />
          <DeviceList snap={snap} now={now} limit={4} />
          <Spacer />
        </VStack>
      </HStack>
    </Card>
  )
}

function StatTile({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <VStack alignment="leading" spacing={1} frame={{ maxWidth: "infinity", alignment: "leading" }}>
      <Text font={10} foregroundStyle="secondaryLabel" lineLimit={1}>{label}</Text>
      <Text font={17} fontWeight="bold" fontDesign="rounded" foregroundStyle={color ?? "label"} lineLimit={1} minScaleFactor={0.6}>
        {value}
      </Text>
      <Text font={10} foregroundStyle="secondaryLabel" lineLimit={1}>{sub || " "}</Text>
    </VStack>
  )
}

function LargeView({ snap, now, width }: { snap: Snapshot; now: number; width: number }) {
  const stats = snap.stats
  const trend = trendOf(stats, snap.prev)
  const top = snap.top ?? []
  return (
    <Card>
      <Header snap={snap} showText />
      {stats && stats.total > 0
        ? [
            <HStack key="tiles" spacing={8}>
              <StatTile label="總查詢" value={fmtCount(stats.total)} sub={trend ? `比前期 ${trend.text}` : ""} />
              <StatTile label="已阻擋" value={fmtCount(stats.blocked)} sub={fmtPct(stats.blocked, stats.total)} color={RED} />
              <StatTile label="放行" value={fmtCount(stats.bypassed)} sub={fmtPct(stats.bypassed, stats.total)} color={GREEN} />
              <StatTile label="導向" value={fmtCount(stats.redirected)} sub={fmtPct(stats.redirected, stats.total)} color={BLUE} />
            </HStack>,
            <RatioBar key="bar" stats={stats} width={width - 28} height={8} />,
          ]
        : <StatsNote snap={snap} />}
      <Spacer />
      <SectionTitle title="端點" trailing={onlineText(snap, now)} />
      <DeviceList snap={snap} now={now} limit={top.length ? 4 : 7} showProfile />
      {top.length
        ? [
            <Spacer key="s" />,
            <SectionTitle key="h" title="最常被擋的網域" />,
            <VStack key="list" alignment="leading" spacing={4}>
              {top.slice(0, 4).map((row) => (
                <HStack key={row.value} spacing={6}>
                  <Text font={12} lineLimit={1}>{row.value}</Text>
                  <Spacer />
                  <Text font={11} foregroundStyle="secondaryLabel">{fmtCount(row.count)}</Text>
                </HStack>
              ))}
            </VStack>,
          ]
        : null}
      <Spacer />
      <Text font={10} foregroundStyle="secondaryLabel" lineLimit={1}>
        {`${rangeInfo(snap.range).label}・更新 ${fmtTime(snap.fetchedAt, now)}`}
      </Text>
    </Card>
  )
}

// ── 鎖定畫面 ──

function shortPct(stats: Counts | null): string {
  if (!stats || !(stats.total > 0)) return "—"
  const pct = blockedRatio(stats) * 100
  return `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`
}

function CircularView({ snap }: { snap: Snapshot }) {
  const ratio = Math.min(1, Math.max(0, blockedRatio(snap.stats)))
  return (
    <ZStack>
      <AccessoryWidgetBackground />
      <Circle stroke={{ shapeStyle: "rgba(255,255,255,0.25)", strokeStyle: { lineWidth: 5 } }} frame={{ width: 54, height: 54 }} />
      {ratio > 0
        ? <Circle trim={{ from: 0, to: ratio }} stroke={{ shapeStyle: "white", strokeStyle: { lineWidth: 5 } }}
            frame={{ width: 54, height: 54 }} rotationEffect={-90} widgetAccentable />
        : null}
      <VStack spacing={0}>
        <Text font={14} fontWeight="bold" fontDesign="rounded" lineLimit={1} minScaleFactor={0.6}>{shortPct(snap.stats)}</Text>
        <Text font={9} foregroundStyle="secondaryLabel">擋</Text>
      </VStack>
    </ZStack>
  )
}

function RectangularView({ snap, now }: { snap: Snapshot; now: number }) {
  const v = verifyIcon(snap.verify)
  const stats = snap.stats
  const online = onlineText(snap, now)
  return (
    <VStack alignment="leading" spacing={1} frame={{ maxWidth: "infinity", alignment: "leading" }}>
      <HStack spacing={4}>
        <Image systemName={v.icon} font={12} />
        <Text font={13} fontWeight="semibold" lineLimit={1} widgetAccentable>Control D</Text>
        <Spacer />
        <Text font={11} foregroundStyle="secondaryLabel" lineLimit={1}>{rangeInfo(snap.range).short}</Text>
      </HStack>
      {snap.error
        ? <Text font={12} foregroundStyle="secondaryLabel" lineLimit={2}>{snap.error}</Text>
        : [
            <Text key="a" font={13} fontWeight="semibold" lineLimit={1} minScaleFactor={0.7}>
              {stats && stats.total > 0 ? `擋 ${shortPct(stats)}・${fmtCount(stats.blocked)} 次` : "沒有統計"}
            </Text>,
            <Text key="b" font={12} foregroundStyle="secondaryLabel" lineLimit={1} minScaleFactor={0.7}>
              {[stats && stats.total > 0 ? `查詢 ${fmtCount(stats.total)}` : "", online ? `${online} 台` : ""].filter(Boolean).join("・") || v.short}
            </Text>,
          ]}
    </VStack>
  )
}

function InlineView({ snap }: { snap: Snapshot }) {
  if (snap.error) return <Text>{`Control D・${snap.error}`}</Text>
  if (snap.verify === "no") return <Text>⚠︎ 沒走 Control D</Text>
  const stats = snap.stats
  return <Text>{stats && stats.total > 0 ? `🛡 擋 ${shortPct(stats)}・${fmtCount(stats.total)} 次查詢` : "🛡 Control D・沒有統計"}</Text>
}

// ── 進入點 ──

function timeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([promise, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))])
}

function Root({ snap, family, now }: { snap: Snapshot; family: string; now: number }) {
  if (family === "accessoryCircular") return <CircularView snap={snap} />
  if (family === "accessoryRectangular") return <RectangularView snap={snap} now={now} />
  if (family === "accessoryInline") return <InlineView snap={snap} />
  if (snap.error) return <SetupView snap={snap} />
  const width = widgetWidth(family)
  if (family === "systemSmall") return <SmallView snap={snap} width={width} />
  if (family === "systemLarge" || family === "systemExtraLarge") return <LargeView snap={snap} now={now} width={width} />
  return <MediumView snap={snap} now={now} />
}

async function main() {
  const family = Widget.family ?? "systemMedium"
  const range = parseRange(Widget.parameter) ?? undefined
  const now = Date.now()
  const isLarge = family === "systemLarge" || family === "systemExtraLarge"
  const snap = (await timeout(loadSnapshot({ range, top: isLarge, now }), 25_000)) ?? fallbackSnapshot(range, now)
  Widget.present(<Root snap={snap} family={family} now={now} />, {
    reloadPolicy: { policy: "after", date: new Date(nextReload(snap, now)) },
  })
}

main()

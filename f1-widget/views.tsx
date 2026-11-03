// views.tsx — 各尺寸 Widget 的畫面
import {
  AccessoryWidgetBackground,
  Circle,
  DateLabel,
  HStack,
  Image,
  Path2D,
  PathShape,
  Rectangle,
  RoundedRectangle,
  Spacer,
  Text,
  VStack,
  VirtualNode,
  ZStack,
} from "scripting"

import {
  Config,
  DriverRow,
  RaceResult,
  Session,
  Standings,
  Strings,
  TeamRow,
  Race,
  Weather,
  WeekendState,
  dayDiff,
  driverCode,
  flag,
  fmtDay,
  fmtPoints,
  fmtRange,
  fmtTime,
  fmtWhen,
  gpName,
  gpShort,
  sessionLabel,
  t,
  teamColor,
  teamShort,
  weatherSymbol,
} from "./f1"
import { trackPoints } from "./tracks"

// ─────────────────────────────────────────────
// 主題
// ─────────────────────────────────────────────

const F1_RED = "#E10600"
const BG = { light: "#FFFFFF", dark: "#15151E" } as const
const DIVIDER = "rgba(142,142,147,0.3)"
// 若主畫面上四周留白太多（代表系統已自動加邊距），把這個改成 0
const PADDING = 14

export interface WidgetData {
  cfg: Config
  now: number
  size: { width: number; height: number } // Widget.displaySize
  state: WeekendState
  drivers: Standings<DriverRow> | null
  teams: Standings<TeamRow> | null
  result: RaceResult | null
  weather: Weather | null // 只有大尺寸會抓
  weatherInRange: boolean
  stale: boolean
  updatedAt: number
  nextSeasonYear: number | null
  error: string | null
}

// ─────────────────────────────────────────────
// 共用元件
// ─────────────────────────────────────────────

function Root({ children, spacing = 6 }: { children: any; spacing?: number }) {
  return (
    <VStack
      alignment="leading"
      spacing={spacing}
      padding={PADDING}
      frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "topLeading" }}
      widgetBackground={BG}
    >
      {children}
    </VStack>
  )
}

type Pt = { x: number; y: number }

/**
 * 賽道路線圖。Widget 不能用 draw 回呼，所以依固定尺寸預先算好 Path2D：
 * 以相鄰點的中點串成二次曲線讓轉角平滑，粗線 + 淡色外光暈，起跑線畫一道紅色短線。
 */
function TrackMap({
  race,
  width,
  height,
  lineWidth = 3,
  color = "label",
  offsetY = 0,
}: {
  race: Race
  width: number
  height: number
  lineWidth?: number
  color?: string
  offsetY?: number
}) {
  // 舊版 Scripting 沒有 Path2D / PathShape 時直接略過
  if (typeof Path2D !== "function" || !PathShape) return null
  const raw = trackPoints(race.circuitId, race.locality)
  if (!raw || raw.length < 3) return null

  let maxX = 0
  let maxY = 0
  for (const [x, y] of raw) {
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  const pad = lineWidth + 3
  const k = Math.min((width - pad * 2) / (maxX || 1), (height - pad * 2) / (maxY || 1))
  const ox = (width - maxX * k) / 2
  const oy = (height - maxY * k) / 2
  const P: Pt[] = raw.map(([x, y]) => ({ x: ox + x * k, y: oy + y * k }))
  const n = P.length
  const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })

  const start = mid(P[0], P[1])
  const line = new Path2D()
  line.move(start)
  for (let i = 1; i <= n; i++) {
    const cur = P[i % n]
    const nxt = P[(i + 1) % n]
    line.addQuadCurve(mid(cur, nxt), cur)
  }
  line.closeSubpath()

  // 起跑線：與行進方向垂直的紅色短線
  const dx = P[1].x - P[0].x
  const dy = P[1].y - P[0].y
  const len = Math.hypot(dx, dy) || 1
  const L = lineWidth + 3
  const nx = (-dy / len) * L
  const ny = (dx / len) * L
  const startLine = new Path2D()
  startLine.move({ x: start.x - nx, y: start.y - ny })
  startLine.addLine({ x: start.x + nx, y: start.y + ny })

  const stroke = (shapeStyle: string, w: number) => ({
    shapeStyle,
    strokeStyle: { lineWidth: w, lineCap: "round", lineJoin: "round" },
  })

  return (
    <ZStack frame={{ width, height }} offset={offsetY ? { x: 0, y: offsetY } : undefined}>
      <PathShape path={line} stroke={stroke(color, lineWidth + 4)} opacity={0.12} frame={{ width, height }} />
      <PathShape path={line} stroke={stroke(color, lineWidth)} frame={{ width, height }} />
      <PathShape path={startLine} stroke={stroke(F1_RED, Math.max(2, lineWidth * 0.8))} frame={{ width, height }} widgetAccentable />
    </ZStack>
  )
}

function TeamBar({ teamId, teamName = "", height = 11 }: { teamId: string; teamName?: string; height?: number }) {
  return <RoundedRectangle cornerRadius={1.5} fill={teamColor(teamId, teamName)} frame={{ width: 3, height }} />
}

function SectionTitle({ title, font = 11 }: { title: string; font?: number }) {
  return (
    <Text font={font} fontWeight="bold" foregroundStyle={F1_RED} lineLimit={1} minScaleFactor={0.8} widgetAccentable>
      {title}
    </Text>
  )
}

function LiveDot() {
  return <Circle fill={F1_RED} frame={{ width: 6, height: 6 }} widgetAccentable />
}

/** 積分／結果的一列。fill = 平均分配垂直空間（填滿欄位、減少留白） */
function Row({
  pos,
  teamId,
  teamName,
  name,
  extra,
  value,
  font = 12,
  fill = false,
}: {
  pos: string
  teamId: string
  teamName: string
  name: string
  extra?: string // 名字後方的小字（車號）
  value: string
  font?: number
  fill?: boolean
}) {
  return (
    <HStack spacing={3} frame={fill ? { maxWidth: "infinity", maxHeight: "infinity" } : undefined}>
      <Text
        font={font}
        fontWeight="semibold"
        monospacedDigit
        foregroundStyle="secondaryLabel"
        frame={{ width: font * 1.3, alignment: "trailing" }}
      >
        {pos}
      </Text>
      <TeamBar teamId={teamId} teamName={teamName} height={font} />
      {/* 名字區塊撐滿剩餘寬度、數值靠右（不用 Spacer，窄欄也不會被最小間距擠掉） */}
      <HStack spacing={2} frame={{ maxWidth: "infinity", alignment: "leading" }}>
        <Text font={font} fontWeight="semibold" lineLimit={1} minScaleFactor={0.75} layoutPriority={1}>
          {name}
        </Text>
        {extra ? (
          <Text font={font - 3} fontWeight="medium" monospacedDigit foregroundStyle="secondaryLabel" lineLimit={1}>
            {extra}
          </Text>
        ) : null}
      </HStack>
      <Text font={font - 1} monospacedDigit foregroundStyle="secondaryLabel" lineLimit={1} minScaleFactor={0.7} layoutPriority={1}>
        {value}
      </Text>
    </HStack>
  )
}

/** 倒數：進行中 → 已經過時間；24 小時內 → 時:分:秒；更久 → 「4 天 3 小時」 */
function Countdown({
  data,
  session,
  font,
  alignment = "leading",
}: {
  data: WidgetData
  session: Session
  font: number
  alignment?: "leading" | "trailing" | "center"
}) {
  const live = session.start <= data.now
  const within24h = session.start - data.now <= 24 * 60 * 60 * 1000
  return (
    <DateLabel
      date={new Date(session.start)}
      style={live || within24h ? "timer" : "relative"}
      font={font}
      fontWeight="bold"
      monospacedDigit
      lineLimit={1}
      minScaleFactor={0.5}
      multilineTextAlignment={alignment}
      foregroundStyle={live ? F1_RED : "label"}
      widgetAccentable
    />
  )
}

/** 「下一節 · FP1」或紅色「● FP1 進行中」；withTime 會在後面接上開始時間 */
function NextLabel({
  data,
  session,
  s,
  font = 11,
  withTime = false,
}: {
  data: WidgetData
  session: Session
  s: Strings
  font?: number
  withTime?: boolean
}) {
  const live = session.start <= data.now
  const name = sessionLabel(session.key, data.cfg.lang)
  const when = withTime ? ` · ${fmtWhen(session.start, data.cfg.lang, data.now)}` : ""
  if (live) {
    return (
      <HStack spacing={4}>
        <LiveDot />
        <Text font={font} fontWeight="bold" foregroundStyle={F1_RED} lineLimit={1} minScaleFactor={0.8}>
          {`${name} ${s.live}${when}`}
        </Text>
      </HStack>
    )
  }
  return (
    <Text font={font} foregroundStyle="secondaryLabel" lineLimit={1} minScaleFactor={0.8}>
      {`${s.next} · ${name}${when}`}
    </Text>
  )
}

function roundLine(data: WidgetData, s: Strings): string {
  const race = data.state.race!
  const prefix = data.nextSeasonYear ? `${s.nextSeason(data.nextSeasonYear)} · ` : ""
  return `${flag(race.country)} ${prefix}${s.roundShort(race.round)} · ${fmtRange(race)}`
}

// ─────────────────────────────────────────────
// 內容區塊
// ─────────────────────────────────────────────

/** 小尺寸：比賽資訊 + 右側中段的賽道圖 */
function SmallRaceCard({ data }: { data: WidgetData }) {
  const s = t(data.cfg.lang)
  const race = data.state.race!
  const next = data.state.next!
  const W = data.size.width - PADDING * 2
  const H = data.size.height - PADDING * 2
  return (
    <ZStack alignment="trailing" frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
      <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "topLeading" }}>
        <Text font={10} fontWeight="semibold" foregroundStyle="secondaryLabel" lineLimit={1} minScaleFactor={0.8}>
          {roundLine(data, s)}
        </Text>
        <Text font={15} fontWeight="heavy" lineLimit={2} minScaleFactor={0.7}>
          {gpName(race.raceName, data.cfg.lang)}
        </Text>
        <Text font={10} foregroundStyle="secondaryLabel" lineLimit={1}>
          {race.locality}
        </Text>
        <Spacer />
        <NextLabel data={data} session={next} s={s} />
        <Countdown data={data} session={next} font={21} />
        <Text font={11} foregroundStyle="secondaryLabel" lineLimit={1} minScaleFactor={0.8}>
          {fmtWhen(next.start, data.cfg.lang, data.now)}
        </Text>
      </VStack>
      <TrackMap race={race} width={Math.round(W * 0.55)} height={Math.round(H * 0.4)} lineWidth={2.6} offsetY={-Math.round(H * 0.05)} />
    </ZStack>
  )
}

/** 中尺寸左側（2/3）：大倒數 + 佔據中央區域的大賽道圖 */
function MediumRaceCard({ data, width, height }: { data: WidgetData; width: number; height: number }) {
  const s = t(data.cfg.lang)
  const race = data.state.race!
  const next = data.state.next!
  const bottomBlock = 54 // 「下一節」那行 + 大倒數
  const trackH = Math.max(46, Math.round(height - bottomBlock - 2))
  const trackW = Math.min(Math.round(width * 0.52), Math.round(trackH * 1.45))
  const textW = width - trackW - 4
  return (
    <ZStack alignment="topTrailing" frame={{ width, height }}>
      <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "topLeading" }}>
        <Text font={10} fontWeight="semibold" foregroundStyle="secondaryLabel" lineLimit={1} minScaleFactor={0.75} frame={{ maxWidth: textW, alignment: "leading" }}>
          {roundLine(data, s)}
        </Text>
        {/* 中文名稱單行自動縮小（避免「新加坡大獎／賽」斷行）；英文名稱較長，允許兩行 */}
        <Text
          font={17}
          fontWeight="heavy"
          lineLimit={data.cfg.lang === "zh" ? 1 : 2}
          minScaleFactor={0.6}
          frame={{ maxWidth: textW, alignment: "leading" }}
        >
          {gpName(race.raceName, data.cfg.lang)}
        </Text>
        <Text font={10} foregroundStyle="secondaryLabel" lineLimit={1} frame={{ maxWidth: textW, alignment: "leading" }}>
          {race.locality}
        </Text>
        <Spacer />
        <NextLabel data={data} session={next} s={s} withTime />
        <Countdown data={data} session={next} font={30} />
      </VStack>
      <TrackMap race={race} width={trackW} height={trackH} lineWidth={3.2} />
    </ZStack>
  )
}

function DriverList({
  data,
  from,
  count,
  font = 12,
  full = false,
  numbers = false,
  fill = false,
  spacing = 3,
}: {
  data: WidgetData
  from: number
  count: number
  font?: number
  full?: boolean
  numbers?: boolean
  fill?: boolean
  spacing?: number
}) {
  const rows = data.drivers?.rows.slice(from, from + count) ?? []
  if (!rows.length) {
    return <Text font={11} foregroundStyle="secondaryLabel">{t(data.cfg.lang).noStandings}</Text>
  }
  return (
    <VStack alignment="leading" spacing={fill ? 0 : spacing} frame={fill ? { maxWidth: "infinity", maxHeight: "infinity" } : undefined}>
      {rows.map(d => (
        <Row
          pos={d.posText}
          teamId={d.teamId}
          teamName={d.teamName}
          name={full ? d.familyName : driverCode(d.code, d.familyName)}
          extra={numbers && d.number ? d.number : undefined}
          value={fmtPoints(d.points)}
          font={font}
          fill={fill}
        />
      ))}
    </VStack>
  )
}

function TeamList({
  data,
  from,
  count,
  font = 12,
  fill = false,
  spacing = 3,
  narrow = false,
}: {
  data: WidgetData
  from: number
  count: number
  font?: number
  fill?: boolean
  spacing?: number
  narrow?: boolean
}) {
  const rows = data.teams?.rows.slice(from, from + count) ?? []
  if (!rows.length) {
    return <Text font={11} foregroundStyle="secondaryLabel">{t(data.cfg.lang).noStandings}</Text>
  }
  return (
    <VStack alignment="leading" spacing={fill ? 0 : spacing} frame={fill ? { maxWidth: "infinity", maxHeight: "infinity" } : undefined}>
      {rows.map(c => (
        <Row
          pos={c.posText}
          teamId={c.teamId}
          teamName={c.teamName}
          name={teamShort(c.teamId, c.teamName, narrow)}
          value={fmtPoints(c.points)}
          font={font}
          fill={fill}
        />
      ))}
    </VStack>
  )
}

function ResultList({
  data,
  from,
  count,
  font = 12,
  fill = false,
  spacing = 3,
}: {
  data: WidgetData
  from: number
  count: number
  font?: number
  fill?: boolean
  spacing?: number
}) {
  const rows = data.result?.rows.slice(from, from + count) ?? []
  return (
    <VStack alignment="leading" spacing={fill ? 0 : spacing} frame={fill ? { maxWidth: "infinity", maxHeight: "infinity" } : undefined}>
      {rows.map(r => (
        <Row
          pos={r.posText}
          teamId={r.teamId}
          teamName={r.teamName}
          name={driverCode(r.code, r.familyName)}
          // 冠軍顯示總時間（去掉毫秒），其餘顯示差距；未完賽顯示狀態（Lapped、DNF…）
          value={r.time ? (r.pos === 1 ? r.time.replace(/\.\d+$/, "") : r.time) : r.status}
          font={font}
          fill={fill}
        />
      ))}
    </VStack>
  )
}

/** 週末各節次時間表（中尺寸右側，窄欄用短名稱） */
function ScheduleList({ data, font = 12 }: { data: WidgetData; font?: number }) {
  const race = data.state.race!
  const lang = data.cfg.lang
  const s = t(lang)
  return (
    <VStack alignment="leading" spacing={0} frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
      {race.sessions.map(se => {
        const done = se.end <= data.now
        const live = se.start <= data.now && !done
        const isNext = data.state.next?.key === se.key
        const color = done ? "tertiaryLabel" : isNext ? "label" : "secondaryLabel"
        return (
          <HStack spacing={4} frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
            <RoundedRectangle
              cornerRadius={1.5}
              fill={isNext ? F1_RED : "rgba(142,142,147,0.35)"}
              frame={{ width: 3, height: font }}
              widgetAccentable={isNext}
            />
            <Text font={font} fontWeight={isNext ? "bold" : "medium"} foregroundStyle={color} lineLimit={1}>
              {sessionLabel(se.key, lang, true)}
            </Text>
            <Spacer />
            {live ? (
              <HStack spacing={3}>
                <LiveDot />
                <Text font={font - 1} fontWeight="bold" foregroundStyle={F1_RED}>
                  {s.live}
                </Text>
              </HStack>
            ) : (
              <Text
                font={font - 1}
                monospacedDigit
                fontWeight={isNext ? "semibold" : "regular"}
                foregroundStyle={color}
                lineLimit={1}
                minScaleFactor={0.7}
              >
                {`${fmtDay(se.start, lang, data.now)} ${fmtTime(se.start)}`}
              </Text>
            )}
          </HStack>
        )
      })}
    </VStack>
  )
}

/** 週末各節次橫排卡片（大尺寸）：第一行「節次 星期」，第二行時間 */
function SessionChips({ data }: { data: WidgetData }) {
  const race = data.state.race!
  const lang = data.cfg.lang
  const s = t(lang)
  return (
    <HStack spacing={5}>
      {race.sessions.map(se => {
        const done = se.end <= data.now
        const live = se.start <= data.now && !done
        const isNext = data.state.next?.key === se.key
        const color = done ? "tertiaryLabel" : isNext ? "label" : "secondaryLabel"
        return (
          <VStack
            alignment="leading"
            spacing={1}
            padding={{ horizontal: 5, vertical: 4 }}
            frame={{ maxWidth: "infinity", alignment: "leading" }}
            background={
              <RoundedRectangle cornerRadius={8} fill={isNext ? "rgba(225,6,0,0.13)" : "rgba(142,142,147,0.12)"} />
            }
          >
            <HStack spacing={3}>
              <Text
                font={10}
                fontWeight="bold"
                foregroundStyle={isNext ? F1_RED : color}
                lineLimit={1}
                minScaleFactor={0.7}
                widgetAccentable={isNext}
              >
                {sessionLabel(se.key, lang, true)}
              </Text>
              <Text font={10} foregroundStyle={color} lineLimit={1} minScaleFactor={0.7}>
                {fmtDay(se.start, lang, data.now)}
              </Text>
            </HStack>
            <Text
              font={12}
              fontWeight="semibold"
              monospacedDigit
              foregroundStyle={live ? F1_RED : color}
              lineLimit={1}
              minScaleFactor={0.7}
            >
              {live ? s.live : fmtTime(se.start)}
            </Text>
          </VStack>
        )
      })}
    </HStack>
  )
}

/** 依參數決定中尺寸右側要放什麼 */
function sidePanel(data: WidgetData): "drivers" | "teams" | "schedule" | "result" {
  const { mode } = data.cfg
  if (mode === "auto") return data.result ? "result" : "drivers"
  return mode
}

function resultTitle(data: WidgetData, s: Strings, short = false): string {
  const r = data.result!
  return short ? `${flag(r.country)} ${s.result}` : `${flag(r.country)} ${gpShort(r.raceName, data.cfg.lang)} ${s.result}`
}

function Footer({ data }: { data: WidgetData }) {
  const s = t(data.cfg.lang)
  const text = `${data.stale ? s.stale + " · " : ""}${s.updated} ${fmtTime(data.updatedAt)} · jolpica-f1${data.weather ? " · Open-Meteo" : ""}`
  return (
    <Text font={9} foregroundStyle="tertiaryLabel" lineLimit={1}>
      {text}
    </Text>
  )
}

// ─────────────────────────────────────────────
// 特殊狀態
// ─────────────────────────────────────────────

export function ErrorView({ data }: { data: WidgetData }) {
  const s = t(data.cfg.lang)
  return (
    <Root>
      <SectionTitle title="F1" />
      <Spacer />
      <Text font={14} fontWeight="bold">{s.noData}</Text>
      <Text font={11} foregroundStyle="secondaryLabel" lineLimit={3}>
        {s.noDataHint}
      </Text>
    </Root>
  )
}

export function AccessoryErrorView({ data }: { data: WidgetData }) {
  const s = t(data.cfg.lang)
  return (
    <VStack alignment="leading" spacing={1} frame={{ maxWidth: "infinity", alignment: "leading" }}>
      <Text font={13} fontWeight="semibold" widgetAccentable>
        🏁 F1
      </Text>
      <Text font={12} foregroundStyle="secondaryLabel" lineLimit={2}>
        {s.noData}
      </Text>
    </VStack>
  )
}

function ChampionCard({ data, expand = true }: { data: WidgetData; expand?: boolean }) {
  const s = t(data.cfg.lang)
  const champ = data.drivers?.rows[0]
  return (
    <VStack
      alignment="leading"
      spacing={3}
      frame={expand ? { maxWidth: "infinity", maxHeight: "infinity", alignment: "topLeading" } : { maxWidth: "infinity", alignment: "topLeading" }}
    >
      <Text font={10} fontWeight="semibold" foregroundStyle="secondaryLabel">
        {`🏁 ${data.drivers?.season ?? ""} · ${s.seasonOver}`}
      </Text>
      {expand ? <Spacer /> : null}
      {champ ? (
        <VStack alignment="leading" spacing={2}>
          <SectionTitle title={`🏆 ${s.champion}`} />
          <HStack spacing={6}>
            <TeamBar teamId={champ.teamId} teamName={champ.teamName} height={30} />
            <VStack alignment="leading" spacing={0}>
              <Text font={11} foregroundStyle="secondaryLabel" lineLimit={1}>
                {champ.givenName}
              </Text>
              <Text font={18} fontWeight="heavy" lineLimit={1} minScaleFactor={0.6}>
                {champ.familyName}
              </Text>
            </VStack>
          </HStack>
          <Text font={11} foregroundStyle="secondaryLabel">
            {`${fmtPoints(champ.points)} ${s.pts}`}
          </Text>
        </VStack>
      ) : null}
    </VStack>
  )
}

// ─────────────────────────────────────────────
// 主畫面：小、中、大
// ─────────────────────────────────────────────

export function SmallView({ data }: { data: WidgetData }) {
  if (!data.state.race || !data.state.next) {
    return (
      <Root>
        <ChampionCard data={data} />
      </Root>
    )
  }
  return (
    <Root>
      <SmallRaceCard data={data} />
    </Root>
  )
}

export function MediumView({ data }: { data: WidgetData }) {
  const s = t(data.cfg.lang)
  const hasRace = !!data.state.race && !!data.state.next
  let panel = sidePanel(data)
  if (panel === "schedule" && !hasRace) panel = "drivers"

  // 左 2/3、右 1/3
  const W = data.size.width - PADDING * 2
  const H = data.size.height - PADDING * 2
  const gap = 10
  const leftW = Math.round(((W - gap * 2) * 2) / 3)

  let title = s.drivers
  let content: VirtualNode = <DriverList data={data} from={0} count={6} numbers fill />
  if (panel === "teams") {
    title = s.teams
    content = <TeamList data={data} from={0} count={6} fill narrow />
  } else if (panel === "result") {
    title = resultTitle(data, s, true) // 窄欄只放國旗 + 「正賽結果」
    content = <ResultList data={data} from={0} count={6} fill />
  } else if (panel === "schedule") {
    title = s.schedule
    content = <ScheduleList data={data} />
  }

  return (
    <Root>
      <HStack alignment="top" spacing={gap} frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
        {hasRace ? (
          <MediumRaceCard data={data} width={leftW} height={H} />
        ) : (
          <VStack frame={{ width: leftW, height: H }}>
            <ChampionCard data={data} />
          </VStack>
        )}
        <Rectangle fill={DIVIDER} frame={{ width: 0.5 }} />
        <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "topLeading" }}>
          <SectionTitle title={title} font={13} />
          {content}
        </VStack>
      </HStack>
    </Root>
  )
}

/** 天氣圖示配色：雲用灰色，太陽／月亮用黃色，雨雪用藍色（白底也看得到雲） */
function weatherPalette(symbol: string) {
  const cloud = "systemGray"
  if (symbol === "sun.max.fill") return { primary: "systemYellow", secondary: "systemYellow" }
  if (symbol === "moon.stars.fill") return { primary: "systemYellow", secondary: "systemYellow" }
  if (symbol === "cloud.sun.fill" || symbol === "cloud.moon.fill") return { primary: cloud, secondary: "systemYellow" }
  if (symbol === "cloud.bolt.rain.fill") return { primary: cloud, secondary: "systemYellow", tertiary: "systemBlue" }
  if (symbol === "cloud.fill" || symbol === "cloud.fog.fill") return { primary: cloud, secondary: cloud }
  return { primary: cloud, secondary: "systemBlue" } // 雨、毛毛雨、雪、冰雹
}

/** 各節次天氣：圖示、氣溫、降雨機率（欄位與上方節次卡片對齊） */
function WeatherRow({ data }: { data: WidgetData }) {
  const s = t(data.cfg.lang)
  const race = data.state.race!
  const lang = data.cfg.lang
  const w = data.weather
  if (!w || w.round !== race.round || w.season !== race.season || !w.sessions.length) {
    if (data.weatherInRange) return null // 在範圍內但抓不到：不佔版面
    return (
      <HStack spacing={4}>
        <Image systemName="cloud.sun" font={10} foregroundStyle="tertiaryLabel" />
        <Text font={10} foregroundStyle="tertiaryLabel" lineLimit={1}>
          {s.weatherSoon}
        </Text>
      </HStack>
    )
  }
  return (
    <HStack spacing={5}>
      {race.sessions.map(se => {
        const wx = w.sessions.find(x => x.key === se.key)
        const symbol = wx ? weatherSymbol(wx.code, wx.isDay) : ""
        return (
          <VStack alignment="leading" spacing={1} padding={{ leading: 5 }} frame={{ maxWidth: "infinity", alignment: "leading" }}>
            <HStack spacing={4}>
              <Text font={9} fontWeight="semibold" foregroundStyle="secondaryLabel" lineLimit={1} minScaleFactor={0.7}>
                {sessionLabel(se.key, lang, true)}
              </Text>
              {wx ? (
                <Image systemName={symbol} symbolRenderingMode="palette" foregroundStyle={weatherPalette(symbol)} font={12} />
              ) : null}
            </HStack>
            <HStack spacing={3}>
              <Text font={11} fontWeight="semibold" monospacedDigit lineLimit={1} layoutPriority={1}>
                {wx ? `${Math.round(wx.temp)}°` : "–"}
              </Text>
              <HStack spacing={1}>
                <Image systemName="drop.fill" font={7} foregroundStyle={wx ? "systemBlue" : "tertiaryLabel"} />
                <Text font={9} monospacedDigit foregroundStyle="secondaryLabel" lineLimit={1} minScaleFactor={0.7}>
                  {wx && wx.pop != null ? `${Math.round(wx.pop)}%` : "–"}
                </Text>
              </HStack>
            </HStack>
          </VStack>
        )
      })}
    </HStack>
  )
}

function LargeHeader({ data }: { data: WidgetData }) {
  const s = t(data.cfg.lang)
  const race = data.state.race!
  const next = data.state.next!
  return (
    <HStack alignment="center" spacing={8}>
      <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity", alignment: "leading" }}>
        <Text font={11} fontWeight="semibold" foregroundStyle="secondaryLabel" lineLimit={1} minScaleFactor={0.8}>
          {roundLine(data, s)}
        </Text>
        <Text font={20} fontWeight="heavy" lineLimit={1} minScaleFactor={0.6}>
          {gpName(race.raceName, data.cfg.lang)}
        </Text>
        <Text font={10} foregroundStyle="secondaryLabel" lineLimit={1} minScaleFactor={0.8}>
          {race.circuitName}
        </Text>
      </VStack>
      <TrackMap race={race} width={66} height={48} lineWidth={2.6} />
      {/* 倒數文字（relative / timer）會盡量撐滿寬度，固定欄寬避免把左邊的大獎賽名稱擠掉 */}
      <VStack alignment="trailing" spacing={2} frame={{ width: 112, alignment: "trailing" }}>
        <NextLabel data={data} session={next} s={s} font={10} />
        <Countdown data={data} session={next} font={20} alignment="trailing" />
        <Text font={10} foregroundStyle="secondaryLabel" lineLimit={1} minScaleFactor={0.8}>
          {fmtWhen(next.start, data.cfg.lang, data.now)}
        </Text>
      </VStack>
    </HStack>
  )
}

function Columns({
  left,
  right,
  fill = false,
}: {
  left: VirtualNode | VirtualNode[]
  right: VirtualNode | VirtualNode[]
  fill?: boolean
}) {
  const frame = fill
    ? { maxWidth: "infinity" as const, maxHeight: "infinity" as const, alignment: "topLeading" as const }
    : { maxWidth: "infinity" as const, alignment: "topLeading" as const }
  return (
    <HStack alignment="top" spacing={14} frame={fill ? { maxWidth: "infinity", maxHeight: "infinity" } : undefined}>
      <VStack alignment="leading" spacing={4} frame={frame}>
        {left}
      </VStack>
      <VStack alignment="leading" spacing={4} frame={frame}>
        {right}
      </VStack>
    </HStack>
  )
}

export function LargeView({ data }: { data: WidgetData }) {
  const s = t(data.cfg.lang)
  const hasRace = !!data.state.race && !!data.state.next
  const mode = data.cfg.mode
  // 積分榜 10 名；賽後上半部顯示前十名結果，積分榜改 5 名
  const rows = data.result ? 5 : 10
  const font = 11

  // 上半部：正賽結果（自動模式、賽後 30 小時內）或比賽週末各節次
  let top: VirtualNode | null = null
  if (data.result) {
    top = (
      <VStack alignment="leading" spacing={4}>
        <SectionTitle title={resultTitle(data, s)} />
        <Columns
          left={<ResultList data={data} from={0} count={5} font={font} spacing={2} />}
          right={<ResultList data={data} from={5} count={5} font={font} spacing={2} />}
        />
      </VStack>
    )
  } else if (hasRace) {
    top = <SessionChips data={data} />
  }

  // 下半部：積分榜（自動 / 賽程模式 = 車手 + 車隊並排），列高平均分配填滿剩餘空間
  let bottom: VirtualNode
  if (mode === "drivers") {
    bottom = (
      <VStack alignment="leading" spacing={4} frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
        <SectionTitle title={s.drivers} />
        <Columns
          fill
          left={<DriverList data={data} from={0} count={rows} font={font} full fill />}
          right={<DriverList data={data} from={rows} count={rows} font={font} full fill />}
        />
      </VStack>
    )
  } else if (mode === "teams") {
    const half = Math.ceil((data.teams?.rows.length ?? 0) / 2) || 6
    bottom = (
      <VStack alignment="leading" spacing={4} frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
        <SectionTitle title={s.teams} />
        <Columns
          fill
          left={<TeamList data={data} from={0} count={half} font={font + 1} fill />}
          right={<TeamList data={data} from={half} count={half} font={font + 1} fill />}
        />
      </VStack>
    )
  } else {
    bottom = (
      <Columns
        fill
        left={[<SectionTitle title={s.drivers} />, <DriverList data={data} from={0} count={rows} font={font} fill />]}
        right={[<SectionTitle title={s.teams} />, <TeamList data={data} from={0} count={rows} font={font} fill />]}
      />
    )
  }

  return (
    <Root spacing={6}>
      {hasRace ? <LargeHeader data={data} /> : <ChampionCard data={data} expand={false} />}
      {top}
      <Rectangle fill={DIVIDER} frame={{ height: 0.5 }} />
      {bottom}
      {hasRace ? <WeatherRow data={data} /> : null}
      <Footer data={data} />
    </Root>
  )
}

// ─────────────────────────────────────────────
// 鎖定畫面
// ─────────────────────────────────────────────

export function RectangularView({ data }: { data: WidgetData }) {
  const lang = data.cfg.lang
  const s = t(lang)
  const race = data.state.race
  const next = data.state.next
  if (!race || !next) {
    const champ = data.drivers?.rows[0]
    return (
      <VStack alignment="leading" spacing={1} frame={{ maxWidth: "infinity", alignment: "leading" }}>
        <Text font={13} fontWeight="semibold" widgetAccentable lineLimit={1}>
          {`🏁 F1 · ${s.seasonOver}`}
        </Text>
        {champ ? (
          <Text font={15} fontWeight="bold" lineLimit={1}>
            {`🏆 ${champ.familyName}`}
          </Text>
        ) : null}
        {champ ? (
          <Text font={12} foregroundStyle="secondaryLabel" lineLimit={1}>
            {`${fmtPoints(champ.points)} ${s.pts}`}
          </Text>
        ) : null}
      </VStack>
    )
  }
  return (
    <VStack alignment="leading" spacing={0} frame={{ maxWidth: "infinity", alignment: "leading" }}>
      <Text font={13} fontWeight="semibold" lineLimit={1} minScaleFactor={0.8} widgetAccentable>
        {`${flag(race.country)} ${gpShort(race.raceName, lang)} · ${sessionLabel(next.key, lang)}`}
      </Text>
      <HStack spacing={4}>
        <VStack alignment="leading" spacing={0}>
          <Countdown data={data} session={next} font={18} />
          <Text font={12} foregroundStyle="secondaryLabel" lineLimit={1}>
            {next.start <= data.now ? s.live : fmtWhen(next.start, lang, data.now)}
          </Text>
        </VStack>
        <Spacer />
        <TrackMap race={race} width={50} height={38} lineWidth={2} />
      </HStack>
    </VStack>
  )
}

export function CircularView({ data }: { data: WidgetData }) {
  const lang = data.cfg.lang
  const s = t(lang)
  const next = data.state.next
  let top = "F1"
  let main = "🏁"
  let bottom = ""
  if (next) {
    top = sessionLabel(next.key, lang, true)
    const diff = dayDiff(next.start, data.now)
    if (next.start <= data.now) {
      main = "LIVE"
      bottom = s.live
    } else if (diff >= 2) {
      main = String(diff)
      bottom = s.daysUnit
    } else {
      main = fmtTime(next.start)
      bottom = diff === 0 ? s.today : s.tomorrow
    }
  }
  return (
    <ZStack>
      <AccessoryWidgetBackground />
      <VStack spacing={0}>
        <Text font={10} fontWeight="semibold" lineLimit={1} minScaleFactor={0.6} widgetAccentable>
          {top}
        </Text>
        <Text font={main.length > 3 ? 15 : 22} fontWeight="bold" monospacedDigit lineLimit={1} minScaleFactor={0.5}>
          {main}
        </Text>
        <Text font={9} foregroundStyle="secondaryLabel" lineLimit={1} minScaleFactor={0.6}>
          {bottom}
        </Text>
      </VStack>
    </ZStack>
  )
}

export function InlineView({ data }: { data: WidgetData }) {
  const lang = data.cfg.lang
  const s = t(lang)
  const race = data.state.race
  const next = data.state.next
  let text = `🏁 F1 · ${s.seasonOver}`
  if (race && next) {
    const when = next.start <= data.now ? s.live : fmtWhen(next.start, lang, data.now, false)
    text = `${flag(race.country)} ${gpShort(race.raceName, lang)} ${sessionLabel(next.key, lang, true)} ${when}`
  }
  return <Text>{text}</Text>
}

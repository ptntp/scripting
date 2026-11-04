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
  HOUR,
  Race,
  RaceResult,
  Session,
  Standings,
  Strings,
  TeamRow,
  Weather,
  WeekendState,
  dayDiff,
  driverCode,
  flag,
  fmtDay,
  fmtPoints,
  fmtRange,
  fmtSessionTime,
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
// 撐滿可用空間
const FILL = { maxWidth: "infinity", maxHeight: "infinity" } as const

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
  error: boolean // 沒有任何可顯示的資料
}

/** 有下一場（或進行中的）比賽可顯示 */
const hasRace = (data: WidgetData) => !!data.state.race && !!data.state.next

// ─────────────────────────────────────────────
// 共用元件
// ─────────────────────────────────────────────

function Root({ children, spacing = 6 }: { children: any; spacing?: number }) {
  return (
    <VStack alignment="leading" spacing={spacing} padding={PADDING} frame={{ ...FILL, alignment: "topLeading" }} widgetBackground={BG}>
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
  for (let i = 1; i <= n; i++) line.addQuadCurve(mid(P[i % n], P[(i + 1) % n]), P[i % n])
  line.closeSubpath()

  // 起跑線：與行進方向垂直的紅色短線
  const dx = P[1].x - P[0].x
  const dy = P[1].y - P[0].y
  const L = (lineWidth + 3) / (Math.hypot(dx, dy) || 1)
  const startLine = new Path2D()
  startLine.move({ x: start.x + dy * L, y: start.y - dx * L })
  startLine.addLine({ x: start.x - dy * L, y: start.y + dx * L })

  const stroke = (shapeStyle: string, w: number) => ({
    shapeStyle,
    strokeStyle: { lineWidth: w, lineCap: "round", lineJoin: "round" },
  })
  const frame = { width, height }

  return (
    <ZStack frame={frame} offset={offsetY ? { x: 0, y: offsetY } : undefined}>
      <PathShape path={line} stroke={stroke(color, lineWidth + 4)} opacity={0.12} frame={frame} />
      <PathShape path={line} stroke={stroke(color, lineWidth)} frame={frame} />
      <PathShape path={startLine} stroke={stroke(F1_RED, Math.max(2, lineWidth * 0.8))} frame={frame} widgetAccentable />
    </ZStack>
  )
}

function TeamBar({ teamId, teamName, height }: { teamId: string; teamName: string; height: number }) {
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

// ─────────────────────────────────────────────
// 排行列表（車手、車隊、正賽結果共用）
// ─────────────────────────────────────────────

interface RowItem {
  pos: string
  teamId: string
  teamName: string
  name: string
  extra?: string // 名字後方的小字（車號）
  value: string
}

/** 一列排行。fill = 平均分配垂直空間（填滿欄位、減少留白） */
function Row({ item, font, fill }: { item: RowItem; font: number; fill: boolean }) {
  return (
    <HStack spacing={3} frame={fill ? FILL : undefined}>
      {/* 名次固定兩位數（01、02…10），欄寬依兩位數計算，必要時縮小而不是顯示「…」 */}
      <Text
        font={font}
        fontWeight="semibold"
        monospacedDigit
        foregroundStyle="secondaryLabel"
        lineLimit={1}
        minScaleFactor={0.7}
        frame={{ width: font * 1.5, alignment: "trailing" }}
      >
        {/^\d+$/.test(item.pos) ? item.pos.padStart(2, "0") : item.pos}
      </Text>
      <TeamBar teamId={item.teamId} teamName={item.teamName} height={font} />
      {/* 名字區塊撐滿剩餘寬度、數值靠右（不用 Spacer，窄欄也不會被最小間距擠掉） */}
      <HStack spacing={2} frame={{ maxWidth: "infinity", alignment: "leading" }}>
        <Text font={font} fontWeight="semibold" lineLimit={1} minScaleFactor={0.75} layoutPriority={1}>
          {item.name}
        </Text>
        {item.extra ? (
          <Text font={font - 3} fontWeight="medium" monospacedDigit foregroundStyle="secondaryLabel" lineLimit={1}>
            {item.extra}
          </Text>
        ) : null}
      </HStack>
      <Text font={font - 1} monospacedDigit foregroundStyle="secondaryLabel" lineLimit={1} minScaleFactor={0.7} layoutPriority={1}>
        {item.value}
      </Text>
    </HStack>
  )
}

function RowList({
  data,
  items,
  font = 12,
  fill = false,
  spacing = 3,
}: {
  data: WidgetData
  items: RowItem[]
  font?: number
  fill?: boolean
  spacing?: number
}) {
  if (!items.length) {
    return <Text font={11} foregroundStyle="secondaryLabel">{t(data.cfg.lang).noStandings}</Text>
  }
  return (
    <VStack alignment="leading" spacing={fill ? 0 : spacing} frame={fill ? FILL : undefined}>
      {items.map(item => (
        <Row item={item} font={font} fill={fill} />
      ))}
    </VStack>
  )
}

function driverItems(data: WidgetData, from: number, count: number, opts: { full?: boolean; numbers?: boolean } = {}): RowItem[] {
  return (data.drivers?.rows.slice(from, from + count) ?? []).map(d => ({
    pos: d.posText,
    teamId: d.teamId,
    teamName: d.teamName,
    name: opts.full ? d.familyName : driverCode(d.code, d.familyName),
    extra: opts.numbers && d.number ? d.number : undefined,
    value: fmtPoints(d.points),
  }))
}

function teamItems(data: WidgetData, from: number, count: number, narrow = false): RowItem[] {
  return (data.teams?.rows.slice(from, from + count) ?? []).map(c => ({
    pos: c.posText,
    teamId: c.teamId,
    teamName: c.teamName,
    name: teamShort(c.teamId, c.teamName, narrow),
    value: fmtPoints(c.points),
  }))
}

function resultItems(data: WidgetData, from: number, count: number): RowItem[] {
  return (data.result?.rows.slice(from, from + count) ?? []).map(r => ({
    pos: r.posText,
    teamId: r.teamId,
    teamName: r.teamName,
    name: driverCode(r.code, r.familyName),
    // 冠軍顯示總時間（去掉毫秒），其餘顯示差距；未完賽顯示狀態（Lapped、DNF…）
    value: r.time ? (r.posText === "1" ? r.time.replace(/\.\d+$/, "") : r.time) : r.status,
  }))
}

// ─────────────────────────────────────────────
// 倒數與節次
// ─────────────────────────────────────────────

/** 倒數：進行中 → 已經過時間；24 小時內 → 時:分:秒；更久 → 「4 天 3 小時」；時間待定 → 「3 天後」 */
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
  if (!session.hasTime) {
    return (
      <Text font={font} fontWeight="bold" lineLimit={1} minScaleFactor={0.5} widgetAccentable>
        {t(data.cfg.lang).inDays(dayDiff(session.start, data.now))}
      </Text>
    )
  }
  const live = session.start <= data.now
  return (
    <DateLabel
      date={new Date(session.start)}
      style={live || session.start - data.now <= 24 * HOUR ? "timer" : "relative"}
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
function NextLabel({ data, session, font = 11, withTime = false }: { data: WidgetData; session: Session; font?: number; withTime?: boolean }) {
  const s = t(data.cfg.lang)
  const name = sessionLabel(session.key, data.cfg.lang)
  const when = withTime ? ` · ${fmtWhen(session, data.cfg.lang, data.now)}` : ""
  if (session.start <= data.now) {
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

/** 節次狀態：是否進行中、是否為下一節、文字顏色（已結束變淡） */
function sessionStatus(se: Session, data: WidgetData) {
  const done = se.end <= data.now
  const isNext = data.state.next?.key === se.key
  return {
    live: se.start <= data.now && !done,
    isNext,
    color: done ? "tertiaryLabel" : isNext ? "label" : "secondaryLabel",
  }
}

function roundLine(data: WidgetData): string {
  const s = t(data.cfg.lang)
  const race = data.state.race!
  const prefix = data.nextSeasonYear ? `${s.nextSeason(data.nextSeasonYear)} · ` : ""
  return `${flag(race.country)} ${prefix}${s.roundShort(race.round)} · ${fmtRange(race)}`
}

// ─────────────────────────────────────────────
// 內容區塊
// ─────────────────────────────────────────────

/** 小尺寸：比賽資訊 + 右側中段的賽道圖 */
function SmallRaceCard({ data }: { data: WidgetData }) {
  const race = data.state.race!
  const next = data.state.next!
  const W = data.size.width - PADDING * 2
  const H = data.size.height - PADDING * 2
  return (
    <ZStack alignment="trailing" frame={FILL}>
      <VStack alignment="leading" spacing={2} frame={{ ...FILL, alignment: "topLeading" }}>
        <Text font={10} fontWeight="semibold" foregroundStyle="secondaryLabel" lineLimit={1} minScaleFactor={0.8}>
          {roundLine(data)}
        </Text>
        <Text font={15} fontWeight="heavy" lineLimit={2} minScaleFactor={0.7}>
          {gpName(race.raceName, data.cfg.lang)}
        </Text>
        <Text font={10} foregroundStyle="secondaryLabel" lineLimit={1}>
          {race.locality}
        </Text>
        <Spacer />
        <NextLabel data={data} session={next} />
        <Countdown data={data} session={next} font={21} />
        <Text font={11} foregroundStyle="secondaryLabel" lineLimit={1} minScaleFactor={0.8}>
          {fmtWhen(next, data.cfg.lang, data.now)}
        </Text>
      </VStack>
      <TrackMap race={race} width={Math.round(W * 0.55)} height={Math.round(H * 0.4)} lineWidth={2.6} offsetY={-Math.round(H * 0.05)} />
    </ZStack>
  )
}

/** 中尺寸左側（2/3）：大倒數 + 佔據中央區域的大賽道圖 */
function MediumRaceCard({ data, width, height }: { data: WidgetData; width: number; height: number }) {
  const race = data.state.race!
  const next = data.state.next!
  const bottomBlock = 54 // 「下一節」那行 + 大倒數
  const trackH = Math.max(46, Math.round(height - bottomBlock - 2))
  const trackW = Math.min(Math.round(width * 0.52), Math.round(trackH * 1.45))
  const textFrame = { maxWidth: width - trackW - 4, alignment: "leading" } as const
  return (
    <ZStack alignment="topTrailing" frame={{ width, height }}>
      <VStack alignment="leading" spacing={2} frame={{ ...FILL, alignment: "topLeading" }}>
        <Text font={10} fontWeight="semibold" foregroundStyle="secondaryLabel" lineLimit={1} minScaleFactor={0.75} frame={textFrame}>
          {roundLine(data)}
        </Text>
        {/* 中文名稱單行自動縮小（避免「新加坡大獎／賽」斷行）；英文名稱較長，允許兩行 */}
        <Text font={17} fontWeight="heavy" lineLimit={data.cfg.lang === "zh" ? 1 : 2} minScaleFactor={0.6} frame={textFrame}>
          {gpName(race.raceName, data.cfg.lang)}
        </Text>
        <Text font={10} foregroundStyle="secondaryLabel" lineLimit={1} frame={textFrame}>
          {race.locality}
        </Text>
        <Spacer />
        <NextLabel data={data} session={next} withTime />
        <Countdown data={data} session={next} font={30} />
      </VStack>
      <TrackMap race={race} width={trackW} height={trackH} lineWidth={3.2} />
    </ZStack>
  )
}

/** 週末各節次時間表（中尺寸右側，窄欄用短名稱） */
function ScheduleList({ data, font = 12 }: { data: WidgetData; font?: number }) {
  const lang = data.cfg.lang
  return (
    <VStack alignment="leading" spacing={0} frame={FILL}>
      {data.state.race!.sessions.map(se => {
        const { live, isNext, color } = sessionStatus(se, data)
        return (
          <HStack spacing={4} frame={FILL}>
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
                  {t(lang).live}
                </Text>
              </HStack>
            ) : (
              <Text font={font - 1} monospacedDigit fontWeight={isNext ? "semibold" : "regular"} foregroundStyle={color} lineLimit={1} minScaleFactor={0.7}>
                {`${fmtDay(se.start, lang, data.now)} ${fmtSessionTime(se, lang)}`}
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
  const lang = data.cfg.lang
  return (
    <HStack spacing={5}>
      {data.state.race!.sessions.map(se => {
        const { live, isNext, color } = sessionStatus(se, data)
        return (
          <VStack
            alignment="leading"
            spacing={1}
            padding={{ horizontal: 5, vertical: 4 }}
            frame={{ maxWidth: "infinity", alignment: "leading" }}
            background={<RoundedRectangle cornerRadius={8} fill={isNext ? "rgba(225,6,0,0.13)" : "rgba(142,142,147,0.12)"} />}
          >
            <HStack spacing={3}>
              <Text font={10} fontWeight="bold" foregroundStyle={isNext ? F1_RED : color} lineLimit={1} minScaleFactor={0.7} widgetAccentable={isNext}>
                {sessionLabel(se.key, lang, true)}
              </Text>
              <Text font={10} foregroundStyle={color} lineLimit={1} minScaleFactor={0.7}>
                {fmtDay(se.start, lang, data.now)}
              </Text>
            </HStack>
            <Text font={12} fontWeight="semibold" monospacedDigit foregroundStyle={live ? F1_RED : color} lineLimit={1} minScaleFactor={0.7}>
              {live ? t(lang).live : fmtSessionTime(se, lang)}
            </Text>
          </VStack>
        )
      })}
    </HStack>
  )
}

function resultTitle(data: WidgetData, short = false): string {
  const r = data.result!
  const s = t(data.cfg.lang)
  return short ? `${flag(r.country)} ${s.result}` : `${flag(r.country)} ${gpShort(r.raceName, data.cfg.lang)} ${s.result}`
}

function Footer({ data }: { data: WidgetData }) {
  const s = t(data.cfg.lang)
  return (
    <Text font={9} foregroundStyle="tertiaryLabel" lineLimit={1}>
      {`${data.stale ? s.stale + " · " : ""}${s.updated} ${fmtTime(data.updatedAt)} · jolpica-f1${data.weather ? " · Open-Meteo" : ""}`}
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
  return (
    <VStack alignment="leading" spacing={1} frame={{ maxWidth: "infinity", alignment: "leading" }}>
      <Text font={13} fontWeight="semibold" widgetAccentable>
        🏁 F1
      </Text>
      <Text font={12} foregroundStyle="secondaryLabel" lineLimit={2}>
        {t(data.cfg.lang).noData}
      </Text>
    </VStack>
  )
}

/** 賽季結束：年度冠軍 */
function ChampionCard({ data, expand = true }: { data: WidgetData; expand?: boolean }) {
  const s = t(data.cfg.lang)
  const champ = data.drivers?.rows[0]
  return (
    <VStack alignment="leading" spacing={3} frame={expand ? { ...FILL, alignment: "topLeading" } : { maxWidth: "infinity", alignment: "topLeading" }}>
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
  return <Root>{hasRace(data) ? <SmallRaceCard data={data} /> : <ChampionCard data={data} />}</Root>
}

export function MediumView({ data }: { data: WidgetData }) {
  const s = t(data.cfg.lang)
  const race = hasRace(data)

  // 右側內容：自動模式賽後顯示結果，否則依參數
  let panel = data.cfg.mode === "auto" ? (data.result ? "result" : "drivers") : data.cfg.mode
  if (panel === "schedule" && !race) panel = "drivers"

  // 左 2/3、右 1/3
  const gap = 10
  const H = data.size.height - PADDING * 2
  const leftW = Math.round(((data.size.width - PADDING * 2 - gap * 2) * 2) / 3)

  let title = s.drivers
  let content: VirtualNode = <RowList data={data} items={driverItems(data, 0, 6, { numbers: true })} fill />
  if (panel === "teams") {
    title = s.teams
    content = <RowList data={data} items={teamItems(data, 0, 6, true)} fill />
  } else if (panel === "result") {
    title = resultTitle(data, true) // 窄欄只放國旗 + 「正賽結果」
    content = <RowList data={data} items={resultItems(data, 0, 6)} fill />
  } else if (panel === "schedule") {
    title = s.schedule
    content = <ScheduleList data={data} />
  }

  return (
    <Root>
      <HStack alignment="top" spacing={gap} frame={FILL}>
        {race ? (
          <MediumRaceCard data={data} width={leftW} height={H} />
        ) : (
          <VStack frame={{ width: leftW, height: H }}>
            <ChampionCard data={data} />
          </VStack>
        )}
        <Rectangle fill={DIVIDER} frame={{ width: 0.5 }} />
        <VStack alignment="leading" spacing={2} frame={{ ...FILL, alignment: "topLeading" }}>
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
  switch (symbol) {
    case "sun.max.fill":
    case "moon.stars.fill":
      return { primary: "systemYellow", secondary: "systemYellow" }
    case "cloud.sun.fill":
    case "cloud.moon.fill":
      return { primary: cloud, secondary: "systemYellow" }
    case "cloud.bolt.rain.fill":
      return { primary: cloud, secondary: "systemYellow", tertiary: "systemBlue" }
    case "cloud.fill":
    case "cloud.fog.fill":
      return { primary: cloud, secondary: cloud }
    default:
      return { primary: cloud, secondary: "systemBlue" } // 雨、毛毛雨、雪、冰雹
  }
}

/** 各節次天氣：圖示、氣溫、降雨機率（欄位與上方節次卡片對齊） */
function WeatherRow({ data }: { data: WidgetData }) {
  const s = t(data.cfg.lang)
  const race = data.state.race!
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
                {sessionLabel(se.key, data.cfg.lang, true)}
              </Text>
              {wx ? <Image systemName={symbol} symbolRenderingMode="palette" foregroundStyle={weatherPalette(symbol)} font={12} /> : null}
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
  const race = data.state.race!
  const next = data.state.next!
  return (
    <HStack alignment="center" spacing={8}>
      <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity", alignment: "leading" }}>
        <Text font={11} fontWeight="semibold" foregroundStyle="secondaryLabel" lineLimit={1} minScaleFactor={0.8}>
          {roundLine(data)}
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
        <NextLabel data={data} session={next} font={10} />
        <Countdown data={data} session={next} font={20} alignment="trailing" />
        <Text font={10} foregroundStyle="secondaryLabel" lineLimit={1} minScaleFactor={0.8}>
          {fmtWhen(next, data.cfg.lang, data.now)}
        </Text>
      </VStack>
    </HStack>
  )
}

/** 左右兩欄；fill = 撐滿剩餘高度 */
function Columns({ left, right, fill = false }: { left: VirtualNode | VirtualNode[]; right: VirtualNode | VirtualNode[]; fill?: boolean }) {
  const col = fill ? { ...FILL, alignment: "topLeading" as const } : { maxWidth: "infinity" as const, alignment: "topLeading" as const }
  return (
    <HStack alignment="top" spacing={14} frame={fill ? FILL : undefined}>
      <VStack alignment="leading" spacing={4} frame={col}>
        {left}
      </VStack>
      <VStack alignment="leading" spacing={4} frame={col}>
        {right}
      </VStack>
    </HStack>
  )
}

export function LargeView({ data }: { data: WidgetData }) {
  const s = t(data.cfg.lang)
  const race = hasRace(data)
  const mode = data.cfg.mode
  // 積分榜 10 名；賽後上半部顯示前十名結果，積分榜改 5 名
  const rows = data.result ? 5 : 10
  const font = 11

  // 上半部：正賽結果（自動模式、賽後 30 小時內）或比賽週末各節次
  let top: VirtualNode | null = null
  if (data.result) {
    top = (
      <VStack alignment="leading" spacing={4}>
        <SectionTitle title={resultTitle(data)} />
        <Columns
          left={<RowList data={data} items={resultItems(data, 0, 5)} font={font} spacing={2} />}
          right={<RowList data={data} items={resultItems(data, 5, 5)} font={font} spacing={2} />}
        />
      </VStack>
    )
  } else if (race) {
    top = <SessionChips data={data} />
  }

  // 下半部：積分榜（自動 / 賽程模式 = 車手 + 車隊並排），列高平均分配填滿剩餘空間
  let bottom: VirtualNode
  if (mode === "drivers" || mode === "teams") {
    const half = mode === "teams" ? Math.ceil((data.teams?.rows.length ?? 0) / 2) || 6 : rows
    const items = (from: number) =>
      mode === "teams" ? teamItems(data, from, half) : driverItems(data, from, half, { full: true })
    const f = mode === "teams" ? font + 1 : font
    bottom = (
      <VStack alignment="leading" spacing={4} frame={FILL}>
        <SectionTitle title={mode === "teams" ? s.teams : s.drivers} />
        <Columns
          fill
          left={<RowList data={data} items={items(0)} font={f} fill />}
          right={<RowList data={data} items={items(half)} font={f} fill />}
        />
      </VStack>
    )
  } else {
    bottom = (
      <Columns
        fill
        left={[<SectionTitle title={s.drivers} />, <RowList data={data} items={driverItems(data, 0, rows)} font={font} fill />]}
        right={[<SectionTitle title={s.teams} />, <RowList data={data} items={teamItems(data, 0, rows)} font={font} fill />]}
      />
    )
  }

  return (
    <Root spacing={6}>
      {race ? <LargeHeader data={data} /> : <ChampionCard data={data} expand={false} />}
      {top}
      <Rectangle fill={DIVIDER} frame={{ height: 0.5 }} />
      {bottom}
      {race ? <WeatherRow data={data} /> : null}
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
        {champ
          ? [
              <Text font={15} fontWeight="bold" lineLimit={1}>
                {`🏆 ${champ.familyName}`}
              </Text>,
              <Text font={12} foregroundStyle="secondaryLabel" lineLimit={1}>
                {`${fmtPoints(champ.points)} ${s.pts}`}
              </Text>,
            ]
          : null}
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
            {next.start <= data.now ? s.live : fmtWhen(next, lang, data.now)}
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
  const live = !!next && next.start <= data.now
  // 上：節次縮寫；中：天數 / 開始時間 / 進行中則為已經過時間；下：單位或狀態
  let main = "🏁"
  let bottom = ""
  if (next && live) {
    bottom = s.live
  } else if (next) {
    const diff = dayDiff(next.start, data.now)
    main = diff >= 2 ? String(diff) : fmtSessionTime(next, lang)
    bottom = diff >= 2 ? s.daysUnit : diff === 0 ? s.today : s.tomorrow
  }
  return (
    <ZStack>
      <AccessoryWidgetBackground />
      <VStack spacing={0}>
        <Text font={10} fontWeight="semibold" lineLimit={1} minScaleFactor={0.6} widgetAccentable>
          {next ? sessionLabel(next.key, lang, true) : "F1"}
        </Text>
        {live ? (
          // 進行中：顯示從節次開始到現在的經過時間（iOS 原生計時，自動跳動）
          <DateLabel
            date={new Date(next!.start)}
            style="timer"
            font={15}
            fontWeight="bold"
            monospacedDigit
            lineLimit={1}
            minScaleFactor={0.5}
            multilineTextAlignment="center"
          />
        ) : (
          <Text font={main.length > 3 ? 15 : 22} fontWeight="bold" monospacedDigit lineLimit={1} minScaleFactor={0.5}>
            {main}
          </Text>
        )}
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
    const when = next.start <= data.now ? s.live : fmtWhen(next, lang, data.now, false)
    text = `${flag(race.country)} ${gpShort(race.raceName, lang)} ${sessionLabel(next.key, lang, true)} ${when}`
  }
  return <Text>{text}</Text>
}

// widget.tsx — Widget 進入點：抓資料 → 依尺寸選畫面 → Widget.present
import { Widget } from "scripting"

import {
  DriverRow,
  RaceResult,
  Standings,
  TeamRow,
  WeekendState,
  computeState,
  loadDriverStandings,
  loadLastResult,
  loadSchedule,
  loadTeamStandings,
  loadWeather,
  nextReloadDate,
  parseConfig,
  weatherInRange,
} from "./f1"

import {
  AccessoryErrorView,
  CircularView,
  ErrorView,
  InlineView,
  LargeView,
  MediumView,
  RectangularView,
  SmallView,
  WidgetData,
} from "./views"

const MIN = 60 * 1000
const HOUR = 60 * MIN

// 拿不到 Widget.displaySize 時的備用尺寸（iPhone 6.1 吋）
const FALLBACK_SIZE: Record<string, { width: number; height: number }> = {
  systemSmall: { width: 158, height: 158 },
  systemMedium: { width: 338, height: 158 },
  systemLarge: { width: 338, height: 354 },
  systemExtraLarge: { width: 715, height: 354 },
  accessoryRectangular: { width: 172, height: 76 },
  accessoryCircular: { width: 76, height: 76 },
  accessoryInline: { width: 257, height: 26 },
}

function widgetSize(family: string): { width: number; height: number } {
  const d = Widget.displaySize
  if (d && d.width > 0 && d.height > 0) return { width: d.width, height: d.height }
  return FALLBACK_SIZE[family] ?? FALLBACK_SIZE.systemMedium
}

async function buildData(): Promise<{ data: WidgetData; reload: Date }> {
  const cfg = parseConfig(Widget.parameter)
  const now = Date.now()
  const family = String(Widget.family)
  const isAccessory = family.startsWith("accessory")
  const isLarge = family.startsWith("systemLarge") || family.startsWith("systemExtraLarge")

  let stale = false
  const fetchedTimes: number[] = []
  let error: string | null = null
  let state: WeekendState = computeState([], now)
  let nextSeasonYear: number | null = null

  // 1. 賽程
  try {
    const sched = await loadSchedule("current")
    stale = stale || sched.stale
    fetchedTimes.push(sched.fetchedAt)
    state = computeState(sched.data, now)

    // 本季已全部跑完 → 嘗試下一季賽程
    if (!state.race) {
      const season = sched.data[0]?.season ?? new Date(now).getFullYear()
      try {
        const ns = await loadSchedule(season + 1)
        if (ns.data.length) {
          const s2 = computeState(ns.data, now)
          state = { ...s2, lastRace: state.lastRace, showResult: state.showResult }
          nextSeasonYear = season + 1
        }
      } catch {
        // 下一季賽程尚未公布
      }
    }
  } catch (e) {
    error = String(e)
  }

  // 2. 積分榜與正賽結果（依尺寸只抓需要的）
  const standingsTTL = state.weekend || state.showResult ? 30 * MIN : 6 * HOUR
  const needDrivers = !isAccessory || !state.race
  const needTeams = isLarge || (family === "systemMedium" && cfg.mode === "teams")
  const needResult =
    state.showResult && !!state.lastRace && cfg.mode === "auto" && (family === "systemMedium" || isLarge)

  // 天氣只在大尺寸顯示；比賽週末每小時更新，平常每 3 小時
  const wxInRange = !!state.race && weatherInRange(state.race, now)
  const needWeather = isLarge && wxInRange

  const [drivers, teams, result, weather] = await Promise.all([
    needDrivers
      ? loadDriverStandings(standingsTTL).catch(() => null)
      : Promise.resolve(null),
    needTeams ? loadTeamStandings(standingsTTL).catch(() => null) : Promise.resolve(null),
    needResult
      ? loadLastResult({ season: state.lastRace!.season, round: state.lastRace!.round }).catch(() => null)
      : Promise.resolve(null),
    needWeather
      ? loadWeather(state.race!, state.weekend ? 1 * HOUR : 3 * HOUR).catch(() => null)
      : Promise.resolve(null),
  ])

  for (const l of [drivers, teams, result, weather]) {
    if (l) {
      stale = stale || l.stale
      fetchedTimes.push(l.fetchedAt)
    }
  }

  let raceResult: RaceResult | null = null
  const lr = result?.data
  if (lr && state.lastRace && lr.season === state.lastRace.season && lr.round === state.lastRace.round && lr.rows.length) {
    raceResult = lr
  }
  const awaitingResult = needResult && !raceResult

  const data: WidgetData = {
    cfg,
    now,
    size: widgetSize(family),
    state,
    drivers: (drivers?.data as Standings<DriverRow> | undefined) ?? null,
    teams: (teams?.data as Standings<TeamRow> | undefined) ?? null,
    result: raceResult,
    weather: weather?.data ?? null,
    weatherInRange: wxInRange,
    stale,
    updatedAt: fetchedTimes.length ? Math.min(...fetchedTimes) : now,
    nextSeasonYear,
    error: state.race || drivers ? null : error ?? "no data",
  }

  const reload = data.error ? new Date(now + 15 * MIN) : nextReloadDate(state, now, awaitingResult)
  return { data, reload }
}

function viewFor(family: string, data: WidgetData) {
  if (data.error) {
    if (family === "accessoryInline") return <InlineView data={data} />
    if (family === "accessoryCircular") return <CircularView data={data} />
    if (family.startsWith("accessory")) return <AccessoryErrorView data={data} />
    return <ErrorView data={data} />
  }
  switch (family) {
    case "systemSmall":
      return <SmallView data={data} />
    case "systemMedium":
      return <MediumView data={data} />
    case "systemLarge":
    case "systemExtraLarge":
    case "systemExtraLargePortrait":
      return <LargeView data={data} />
    case "accessoryRectangular":
      return <RectangularView data={data} />
    case "accessoryCircular":
      return <CircularView data={data} />
    case "accessoryInline":
      return <InlineView data={data} />
    default:
      return <MediumView data={data} />
  }
}

async function run() {
  const { data, reload } = await buildData()
  const family = String(Widget.family)
  Widget.present(viewFor(family, data), {
    reloadPolicy: { policy: "after", date: reload },
    relevance: { score: data.state.live ? 1 : data.state.weekend ? 0.7 : 0.1 },
  })
}

run()

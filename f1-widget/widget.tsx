// widget.tsx — Widget 進入點：抓資料 → 依尺寸選畫面 → Widget.present
import { Widget } from "scripting"

import {
  HOUR,
  Loaded,
  MIN,
  RaceResult,
  WeekendState,
  computeState,
  isSeasonOver,
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

async function buildData(family: string): Promise<{ data: WidgetData; reload: Date }> {
  const cfg = parseConfig(Widget.parameter)
  const now = Date.now()
  const isAccessory = family.startsWith("accessory")
  const isLarge = family.startsWith("systemLarge") || family.startsWith("systemExtraLarge")
  const isMedium = !isAccessory && !isLarge && family !== "systemSmall" // 未知尺寸沿用中尺寸

  let stale = false
  const fetchedTimes: number[] = []
  // 記錄實際用到的資料：任一來源是舊快取就標示「離線資料」，更新時間取最舊的一筆
  const used = (l: Loaded<unknown> | null) => {
    if (!l) return
    stale = stale || l.stale
    fetchedTimes.push(l.fetchedAt)
  }
  let state: WeekendState = computeState([], now)
  let seasonOver = false
  let nextSeasonYear: number | null = null

  // 1. 賽程
  try {
    const sched = await loadSchedule("current")
    used(sched)
    state = computeState(sched.data, now)
    seasonOver = isSeasonOver(sched.data, now)

    // 本季確定全部跑完 → 嘗試下一季賽程（空賽程或抓取失敗不算季末，不會跳過本季）
    if (seasonOver) {
      const season = sched.data[0].season
      try {
        const ns = await loadSchedule(season + 1)
        if (ns.data.length) {
          used(ns)
          state = { ...computeState(ns.data, now), lastRace: state.lastRace, showResult: state.showResult }
          nextSeasonYear = season + 1
        }
      } catch {
        // 下一季賽程尚未公布
      }
    }
  } catch {
    // 賽程抓不到且沒有快取
  }

  // 2. 依尺寸與參數只抓畫面會用到的資料
  const hasRace = !!state.race && !!state.next
  const needChampion = !hasRace && seasonOver && (!isAccessory || family === "accessoryRectangular")
  const needDrivers =
    needChampion ||
    (isMedium && cfg.mode !== "teams" && (cfg.mode !== "schedule" || !hasRace)) ||
    (isLarge && cfg.mode !== "teams")
  const needTeams = (isMedium && cfg.mode === "teams") || (isLarge && cfg.mode !== "drivers")
  const needResult = state.showResult && cfg.mode === "auto" && (isMedium || isLarge)
  // 天氣只在大尺寸顯示；比賽週末每小時更新，平常每 3 小時
  const wxInRange = !!state.race && weatherInRange(state.race, now)
  const needWeather = isLarge && wxInRange
  const standingsTTL = state.weekend || state.showResult ? 30 * MIN : 6 * HOUR

  const [drivers, teams, result, weather] = await Promise.all([
    needDrivers ? loadDriverStandings(standingsTTL).catch(() => null) : null,
    needTeams ? loadTeamStandings(standingsTTL).catch(() => null) : null,
    needResult
      ? loadLastResult({ season: state.lastRace!.season, round: state.lastRace!.round }).catch(() => null)
      : null,
    needWeather ? loadWeather(state.race!, state.weekend ? 1 * HOUR : 3 * HOUR).catch(() => null) : null,
  ])
  for (const l of [drivers, teams, result, weather]) used(l)

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
    drivers: drivers?.data ?? null,
    teams: teams?.data ?? null,
    result: raceResult,
    weather: weather?.data ?? null,
    weatherInRange: wxInRange,
    stale,
    updatedAt: fetchedTimes.length ? Math.min(...fetchedTimes) : now,
    nextSeasonYear,
    seasonOver,
    // 只要還有任何一種資料能顯示，就不蓋成錯誤畫面
    error: !state.race && !seasonOver && !drivers && !teams && !raceResult,
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
  const family = String(Widget.family)
  const { data, reload } = await buildData(family)
  Widget.present(viewFor(family, data), {
    reloadPolicy: { policy: "after", date: reload },
    relevance: { score: data.state.live ? 1 : data.state.weekend ? 0.7 : 0.1 },
  })
}

run()

// f1.ts — 資料層：jolpica-f1 API、快取、賽程計算、格式化與對照表
// 資料來源：https://github.com/jolpica/jolpica-f1 （Ergast 相容 API）

// ─────────────────────────────────────────────
// 可調整設定
// ─────────────────────────────────────────────

const BASE = "https://api.jolpi.ca/ergast/f1"
// jolpica 要求自訂 User-Agent（App 名稱 + 版本）
const USER_AGENT = "ScriptingF1Widget/1.2 (Scripting iOS)"
const CACHE_PREFIX = "f1w:"

export const MIN = 60 * 1000
export const HOUR = 60 * MIN
const DAY = 24 * HOUR

// 各節次的預估長度（API 只給開始時間）
const SESSION_MINUTES: Record<SessionKey, number> = {
  fp1: 60,
  fp2: 60,
  fp3: 60,
  sq: 45,
  sprint: 60,
  quali: 60,
  race: 120,
}

// 正賽開始後多久內顯示「正賽結果」
const RESULT_WINDOW_FROM = 2 * HOUR
const RESULT_WINDOW_TO = 30 * HOUR

// ─────────────────────────────────────────────
// 型別
// ─────────────────────────────────────────────

export type SessionKey = "fp1" | "fp2" | "fp3" | "sq" | "sprint" | "quali" | "race"
export type Lang = "zh" | "en"

export interface Session {
  key: SessionKey
  start: number // epoch ms
  end: number
  hasTime: boolean // false = API 只給日期，時間待定
}

export interface Race {
  season: number
  round: number
  raceName: string
  circuitId: string
  circuitName: string
  locality: string
  country: string
  lat: number
  lng: number
  sessions: Session[] // 依開始時間排序，最後一節為正賽
  raceStart: number
}

export interface DriverRow {
  posText: string
  points: number
  code: string
  number: string // 車號（permanentNumber）
  givenName: string
  familyName: string
  teamId: string
  teamName: string
}

export interface TeamRow {
  posText: string
  points: number
  teamId: string
  teamName: string
}

export interface Standings<T> {
  season: number
  rows: T[]
}

export interface ResultRow {
  posText: string
  code: string
  familyName: string
  teamId: string
  teamName: string
  status: string
  time: string | null
}

export interface RaceResult {
  season: number
  round: number
  raceName: string
  country: string
  rows: ResultRow[]
}

export interface Loaded<T> {
  data: T
  fetchedAt: number
  stale: boolean // true = 網路失敗，使用舊快取
}

// ─────────────────────────────────────────────
// 網路與快取
// ─────────────────────────────────────────────

interface CacheEntry<T> {
  t: number
  v: T
}

async function getMRData(path: string): Promise<any> {
  const res = await fetch(`${BASE}/${path}`, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    },
    timeout: 12,
    debugLabel: `jolpica ${path}`,
  })
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${path}`)
  }
  const json = await res.json()
  if (!json || !json.MRData) throw new Error(`格式錯誤 ${path}`)
  return json.MRData
}

/**
 * 先看快取，過期才打 API；API 失敗時退回舊快取。
 * isFresh 讓呼叫端依資料內容決定是否需要更新。
 */
async function cached<T>(
  key: string,
  isFresh: (entry: CacheEntry<T>, now: number) => boolean,
  loader: () => Promise<T>,
): Promise<Loaded<T>> {
  const now = Date.now()
  const fullKey = CACHE_PREFIX + key
  let entry: CacheEntry<T> | null = null
  try {
    entry = Storage.get<CacheEntry<T>>(fullKey)
  } catch {
    entry = null
  }

  if (entry && isFresh(entry, now)) {
    return { data: entry.v, fetchedAt: entry.t, stale: false }
  }

  try {
    const v = await loader()
    try {
      Storage.set(fullKey, { t: now, v })
    } catch {
      // 寫入失敗不影響顯示
    }
    return { data: v, fetchedAt: now, stale: false }
  } catch (e) {
    if (entry) return { data: entry.v, fetchedAt: entry.t, stale: true }
    throw e
  }
}

const maxAge = (ms: number) => (entry: CacheEntry<unknown>, now: number) => now - entry.t < ms

export function clearCache(): number {
  let n = 0
  for (const k of Storage.keys()) {
    if (k.startsWith(CACHE_PREFIX)) {
      Storage.remove(k)
      n++
    }
  }
  return n
}

// ─────────────────────────────────────────────
// 解析
// ─────────────────────────────────────────────

function toMs(date?: string, time?: string): { ms: number; hasTime: boolean } | null {
  if (!date) return null
  const hasTime = !!time
  const t = time ? (time.endsWith("Z") ? time : time + "Z") : "12:00:00Z"
  const ms = Date.parse(`${date}T${t}`)
  return isNaN(ms) ? null : { ms, hasTime }
}

const SESSION_FIELDS: [string, SessionKey][] = [
  ["FirstPractice", "fp1"],
  ["SecondPractice", "fp2"],
  ["ThirdPractice", "fp3"],
  ["SprintQualifying", "sq"],
  ["SprintShootout", "sq"],
  ["Sprint", "sprint"],
  ["Qualifying", "quali"],
]

export function parseRace(r: any): Race | null {
  const raceTime = toMs(r.date, r.time)
  if (!raceTime) return null
  const sessions: Session[] = []
  const seen = new Set<SessionKey>()
  for (const [field, key] of SESSION_FIELDS) {
    const s = r[field]
    if (!s || seen.has(key)) continue
    const t = toMs(s.date, s.time)
    if (!t) continue
    seen.add(key)
    sessions.push({ key, start: t.ms, end: t.ms + SESSION_MINUTES[key] * MIN, hasTime: t.hasTime })
  }
  sessions.push({
    key: "race",
    start: raceTime.ms,
    end: raceTime.ms + SESSION_MINUTES.race * MIN,
    hasTime: raceTime.hasTime,
  })
  sessions.sort((a, b) => a.start - b.start)

  const loc = r.Circuit?.Location ?? {}
  return {
    season: Number(r.season),
    round: Number(r.round),
    raceName: String(r.raceName ?? ""),
    circuitId: String(r.Circuit?.circuitId ?? ""),
    circuitName: String(r.Circuit?.circuitName ?? ""),
    locality: String(loc.locality ?? ""),
    country: String(loc.country ?? ""),
    lat: Number(loc.lat),
    lng: Number(loc.long),
    sessions,
    raceStart: raceTime.ms,
  }
}

function lastConstructor(list: any[] | undefined): { id: string; name: string } {
  const c = list && list.length ? list[list.length - 1] : null
  return { id: String(c?.constructorId ?? ""), name: String(c?.name ?? "") }
}

// ─────────────────────────────────────────────
// 讀取 API（含快取）
// ─────────────────────────────────────────────

export function loadSchedule(season: "current" | number): Promise<Loaded<Race[]>> {
  return cached<Race[]>(`schedule:${season}`, maxAge(12 * HOUR), async () => {
    const mr = await getMRData(`${season}.json?limit=50`)
    const races: any[] = mr.RaceTable?.Races ?? []
    return races.map(parseRace).filter((r): r is Race => r !== null)
  })
}

export function loadDriverStandings(ttlMs: number): Promise<Loaded<Standings<DriverRow>>> {
  return cached<Standings<DriverRow>>("drivers", maxAge(ttlMs), async () => {
    const mr = await getMRData("current/driverstandings.json?limit=40")
    const list = mr.StandingsTable?.StandingsLists?.[0]
    const rows: DriverRow[] = (list?.DriverStandings ?? []).map((d: any, i: number) => {
      const team = lastConstructor(d.Constructors)
      return {
        posText: String(d.positionText ?? d.position ?? i + 1),
        points: Number(d.points ?? 0),
        code: String(d.Driver?.code ?? ""),
        number: String(d.Driver?.permanentNumber ?? ""),
        givenName: String(d.Driver?.givenName ?? ""),
        familyName: String(d.Driver?.familyName ?? ""),
        teamId: team.id,
        teamName: team.name,
      }
    })
    return { season: Number(list?.season ?? mr.StandingsTable?.season ?? 0), rows }
  })
}

export function loadTeamStandings(ttlMs: number): Promise<Loaded<Standings<TeamRow>>> {
  return cached<Standings<TeamRow>>("teams", maxAge(ttlMs), async () => {
    const mr = await getMRData("current/constructorstandings.json?limit=30")
    const list = mr.StandingsTable?.StandingsLists?.[0]
    const rows: TeamRow[] = (list?.ConstructorStandings ?? []).map((c: any, i: number) => ({
      posText: String(c.positionText ?? c.position ?? i + 1),
      points: Number(c.points ?? 0),
      teamId: String(c.Constructor?.constructorId ?? ""),
      teamName: String(c.Constructor?.name ?? ""),
    }))
    return { season: Number(list?.season ?? mr.StandingsTable?.season ?? 0), rows }
  })
}

/** 讀取最近一場正賽結果；expected 為預期的 season/round，未出爐前每 10 分鐘重試 */
export function loadLastResult(expected: { season: number; round: number }): Promise<Loaded<RaceResult | null>> {
  const matches = (v: RaceResult | null) => !!v && v.season === expected.season && v.round === expected.round
  return cached<RaceResult | null>(
    "lastResult",
    (entry, now) => (matches(entry.v) ? now - entry.t < 12 * HOUR : now - entry.t < 10 * MIN),
    async () => {
      const mr = await getMRData("current/last/results.json?limit=30")
      const race = mr.RaceTable?.Races?.[0]
      if (!race) return null
      const rows: ResultRow[] = (race.Results ?? []).map((r: any, i: number) => ({
        posText: String(r.positionText ?? r.position ?? i + 1),
        code: String(r.Driver?.code ?? ""),
        familyName: String(r.Driver?.familyName ?? ""),
        teamId: String(r.Constructor?.constructorId ?? ""),
        teamName: String(r.Constructor?.name ?? ""),
        status: String(r.status ?? ""),
        time: r.Time?.time ? String(r.Time.time) : null,
      }))
      return {
        season: Number(race.season),
        round: Number(race.round),
        raceName: String(race.raceName ?? ""),
        country: String(race.Circuit?.Location?.country ?? ""),
        rows,
      }
    },
  )
}

// ─────────────────────────────────────────────
// 天氣（Open-Meteo，免金鑰，資料授權 CC BY 4.0）
// ─────────────────────────────────────────────

const WEATHER_BASE = "https://api.open-meteo.com/v1/forecast"
// Open-Meteo 最多提供 16 天預報，保守抓 15 天
const WEATHER_HORIZON = 15 * DAY

export interface SessionWeather {
  key: SessionKey
  temp: number // °C
  code: number // WMO weather code
  pop: number | null // 降雨機率 %
  isDay: boolean
}

export interface Weather {
  season: number
  round: number
  sessions: SessionWeather[]
}

/** 這場比賽目前能不能查到預報（座標有效且在 15 天內） */
export function weatherInRange(race: Race, now: number): boolean {
  return isFinite(race.lat) && isFinite(race.lng) && race.raceStart - now <= WEATHER_HORIZON
}

const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/** 取得每一節開始～結束中間時段的逐時預報 */
export function loadWeather(race: Race, ttlMs: number): Promise<Loaded<Weather>> {
  const key = `weather:${race.season}-${race.round}`
  return cached<Weather>(key, maxAge(ttlMs), async () => {
    const now = Date.now()
    const start = isoDate(Math.max(race.sessions[0].start, now - 2 * DAY))
    const end = isoDate(Math.min(race.raceStart, now + WEATHER_HORIZON))
    if (start > end) throw new Error("超出預報範圍")
    const url =
      `${WEATHER_BASE}?latitude=${race.lat}&longitude=${race.lng}` +
      `&hourly=temperature_2m,precipitation_probability,weather_code,is_day` +
      `&timeformat=unixtime&timezone=GMT&start_date=${start}&end_date=${end}`
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, timeout: 12, debugLabel: "open-meteo" })
    if (!res.ok) throw new Error(`HTTP ${res.status} open-meteo`)
    const json = await res.json()
    const h = json?.hourly
    const times: number[] = h?.time ?? []
    if (!times.length) throw new Error("沒有預報資料")

    const sessions: SessionWeather[] = []
    for (const s of race.sessions) {
      if (!s.hasTime) continue // 時間待定的節次查不準，不顯示天氣
      const mid = (s.start + s.end) / 2 / 1000
      let best = -1
      let bestDiff = Infinity
      for (let i = 0; i < times.length; i++) {
        const diff = Math.abs(times[i] - mid)
        if (diff < bestDiff) {
          bestDiff = diff
          best = i
        }
      }
      const temp = h.temperature_2m?.[best]
      const code = h.weather_code?.[best]
      if (best < 0 || bestDiff > 90 * 60 || temp == null || code == null) continue
      const pop = h.precipitation_probability?.[best]
      sessions.push({
        key: s.key,
        temp: Number(temp),
        code: Number(code),
        pop: pop == null ? null : Number(pop),
        isDay: h.is_day?.[best] !== 0,
      })
    }
    // 清掉其他比賽的舊天氣快取
    for (const k of Storage.keys()) {
      if (k.startsWith(CACHE_PREFIX + "weather:") && k !== CACHE_PREFIX + key) Storage.remove(k)
    }
    return { season: race.season, round: race.round, sessions }
  })
}

/** WMO 天氣代碼 → SF Symbol */
export function weatherSymbol(code: number, isDay: boolean): string {
  if (code === 0) return isDay ? "sun.max.fill" : "moon.stars.fill"
  if (code === 1 || code === 2) return isDay ? "cloud.sun.fill" : "cloud.moon.fill"
  if (code === 3) return "cloud.fill"
  if (code === 45 || code === 48) return "cloud.fog.fill"
  if (code >= 51 && code <= 57) return "cloud.drizzle.fill"
  if (code === 66 || code === 67) return "cloud.sleet.fill"
  if (code === 65 || code === 82) return "cloud.heavyrain.fill"
  if ((code >= 61 && code <= 64) || code === 80 || code === 81) return "cloud.rain.fill"
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "cloud.snow.fill"
  if (code >= 95) return "cloud.bolt.rain.fill"
  return "cloud.fill"
}

// ─────────────────────────────────────────────
// 賽程狀態
// ─────────────────────────────────────────────

export interface WeekendState {
  race: Race | null // 本週末或下一場比賽
  next: Session | null // 下一個（或正在進行的）節次
  live: boolean // next 是否進行中
  weekend: boolean // 是否已進入比賽週末（第一節前 12 小時起）
  lastRace: Race | null // 最近一場已開跑的正賽
  showResult: boolean // 是否在「顯示正賽結果」時間窗內
}

export function computeState(races: Race[], now: number): WeekendState {
  const sorted = [...races].sort((a, b) => a.raceStart - b.raceStart)
  const race = sorted.find(r => r.sessions[r.sessions.length - 1].end > now) ?? null
  const next = race ? race.sessions.find(s => s.end > now) ?? null : null
  const live = !!next && next.start <= now
  const weekend = !!race && now >= race.sessions[0].start - 12 * HOUR

  let lastRace: Race | null = null
  for (const r of sorted) if (r.raceStart <= now) lastRace = r
  const sinceLast = lastRace ? now - lastRace.raceStart : Infinity
  const showResult = sinceLast >= RESULT_WINDOW_FROM && sinceLast <= RESULT_WINDOW_TO

  return { race, next, live, weekend, lastRace, showResult }
}

/** 下次請 iOS 重新整理 Widget 的時間 */
export function nextReloadDate(state: WeekendState, now: number, awaitingResult: boolean): Date {
  const busy = state.weekend || state.live || awaitingResult
  const candidates: number[] = [now + (busy ? 15 * MIN : 60 * MIN)]

  if (state.race) {
    for (const s of state.race.sessions) {
      candidates.push(s.start, s.end, s.start - 24 * HOUR)
    }
  }
  if (state.lastRace) {
    candidates.push(state.lastRace.raceStart + RESULT_WINDOW_FROM, state.lastRace.raceStart + RESULT_WINDOW_TO)
  }
  // 本地午夜（「今天/明天」、剩餘天數會變）
  const midnight = new Date(now)
  midnight.setHours(24, 0, 5, 0)
  candidates.push(midnight.getTime())

  const earliest = now + 3 * MIN
  const target = Math.min(...candidates.filter(t => t > now + 30 * 1000))
  return new Date(Math.max(target + 5 * 1000, earliest))
}

// ─────────────────────────────────────────────
// 文字與格式
// ─────────────────────────────────────────────

const STRINGS = {
  zh: {
    next: "下一節",
    live: "進行中",
    drivers: "車手積分",
    teams: "車隊積分",
    schedule: "比賽週末",
    result: "正賽結果",
    roundShort: (n: number) => `R${n}`,
    seasonOver: "賽季已結束",
    champion: "年度冠軍",
    noData: "無法載入 F1 資料",
    noDataHint: "請檢查網路連線，稍後會自動重試",
    stale: "離線資料",
    updated: "更新",
    today: "今天",
    tomorrow: "明天",
    pts: "分",
    daysUnit: "天",
    noStandings: "賽季尚未開始",
    nextSeason: (y: number) => `${y} 賽季`,
    weatherSoon: "天氣預報將於賽前 15 天提供",
    tbc: "待定",
    inDays: (n: number) => (n <= 0 ? "今天" : `${n} 天後`),
    week: ["週日", "週一", "週二", "週三", "週四", "週五", "週六"],
  },
  en: {
    next: "Next",
    live: "LIVE",
    drivers: "Drivers",
    teams: "Constructors",
    schedule: "Race weekend",
    result: "Race result",
    roundShort: (n: number) => `R${n}`,
    seasonOver: "Season finished",
    champion: "Champion",
    noData: "Unable to load F1 data",
    noDataHint: "Check your connection. Will retry automatically.",
    stale: "Offline",
    updated: "Updated",
    today: "Today",
    tomorrow: "Tmrw",
    pts: "pts",
    daysUnit: "days",
    noStandings: "Season not started",
    nextSeason: (y: number) => `${y} season`,
    weatherSoon: "Forecast available 15 days before the race",
    tbc: "TBC",
    inDays: (n: number) => (n <= 0 ? "Today" : `in ${n} ${n === 1 ? "day" : "days"}`),
    week: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
  },
}

export type Strings = typeof STRINGS.zh
export const t = (lang: Lang): Strings => STRINGS[lang]

const SESSION_LABELS: Record<Lang, Record<SessionKey, { full: string; short: string }>> = {
  zh: {
    fp1: { full: "FP1", short: "FP1" },
    fp2: { full: "FP2", short: "FP2" },
    fp3: { full: "FP3", short: "FP3" },
    sq: { full: "衝刺排位", short: "SQ" },
    sprint: { full: "衝刺賽", short: "衝刺" },
    quali: { full: "排位賽", short: "排位" },
    race: { full: "正賽", short: "正賽" },
  },
  en: {
    fp1: { full: "Practice 1", short: "FP1" },
    fp2: { full: "Practice 2", short: "FP2" },
    fp3: { full: "Practice 3", short: "FP3" },
    sq: { full: "Sprint Quali", short: "SQ" },
    sprint: { full: "Sprint", short: "Sprint" },
    quali: { full: "Qualifying", short: "Quali" },
    race: { full: "Race", short: "Race" },
  },
}

export const sessionLabel = (key: SessionKey, lang: Lang, short = false) =>
  short ? SESSION_LABELS[lang][key].short : SESSION_LABELS[lang][key].full

const pad2 = (n: number) => (n < 10 ? "0" + n : String(n))

export function fmtTime(ms: number): string {
  const d = new Date(ms)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

function fmtDate(ms: number): string {
  const d = new Date(ms)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/** 本地日期相差幾天（0 = 今天） */
export function dayDiff(ms: number, now: number): number {
  const a = new Date(now)
  a.setHours(0, 0, 0, 0)
  const b = new Date(ms)
  b.setHours(0, 0, 0, 0)
  return Math.round((b.getTime() - a.getTime()) / DAY)
}

/** 「今天」「明天」或「週六」 */
export function fmtDay(ms: number, lang: Lang, now: number): string {
  const diff = dayDiff(ms, now)
  if (diff === 0) return t(lang).today
  if (diff === 1) return t(lang).tomorrow
  return t(lang).week[new Date(ms).getDay()]
}

/** 節次開始時間「02:00」；API 只給日期時顯示「待定」 */
export function fmtSessionTime(se: Session, lang: Lang): string {
  return se.hasTime ? fmtTime(se.start) : t(lang).tbc
}

/** 「週六 11/8 02:00」，今天/明天時省略日期 */
export function fmtWhen(se: Session, lang: Lang, now: number, withDate = true): string {
  const diff = dayDiff(se.start, now)
  const day = fmtDay(se.start, lang, now)
  const time = fmtSessionTime(se, lang)
  if (diff === 0 || diff === 1 || !withDate) return `${day} ${time}`
  return `${day} ${fmtDate(se.start)} ${time}`
}

export function fmtRange(race: Race): string {
  const a = fmtDate(race.sessions[0].start)
  const b = fmtDate(race.raceStart)
  return a === b ? a : `${a} – ${b}`
}

export function fmtPoints(p: number): string {
  return Number.isInteger(p) ? String(p) : p.toFixed(1)
}

// ─────────────────────────────────────────────
// 對照表：大獎賽中文名、國旗、車隊
// ─────────────────────────────────────────────

const GP_ZH: Record<string, string> = {
  "Australian Grand Prix": "澳洲",
  "Chinese Grand Prix": "中國",
  "Japanese Grand Prix": "日本",
  "Bahrain Grand Prix": "巴林",
  "Saudi Arabian Grand Prix": "沙烏地阿拉伯",
  "Miami Grand Prix": "邁阿密",
  "Emilia Romagna Grand Prix": "艾米利亞-羅馬涅",
  "Canadian Grand Prix": "加拿大",
  "Monaco Grand Prix": "摩納哥",
  "Spanish Grand Prix": "西班牙",
  "Barcelona Grand Prix": "巴塞隆納",
  "Barcelona-Catalunya Grand Prix": "巴塞隆納",
  "Austrian Grand Prix": "奧地利",
  "British Grand Prix": "英國",
  "Belgian Grand Prix": "比利時",
  "Hungarian Grand Prix": "匈牙利",
  "Dutch Grand Prix": "荷蘭",
  "Italian Grand Prix": "義大利",
  "Madrid Grand Prix": "馬德里",
  "Azerbaijan Grand Prix": "亞塞拜然",
  "Singapore Grand Prix": "新加坡",
  "United States Grand Prix": "美國",
  "Mexico City Grand Prix": "墨西哥城",
  "Mexican Grand Prix": "墨西哥",
  "São Paulo Grand Prix": "聖保羅",
  "Sao Paulo Grand Prix": "聖保羅",
  "Brazilian Grand Prix": "巴西",
  "Las Vegas Grand Prix": "拉斯維加斯",
  "Qatar Grand Prix": "卡達",
  "Abu Dhabi Grand Prix": "阿布達比",
  "Portuguese Grand Prix": "葡萄牙",
  "Turkish Grand Prix": "土耳其",
}

/** 完整名稱：「聖保羅大獎賽」/ "São Paulo Grand Prix" */
export function gpName(raceName: string, lang: Lang): string {
  if (lang === "zh" && GP_ZH[raceName]) return GP_ZH[raceName] + "大獎賽"
  return raceName
}

/** 短名稱：「聖保羅」/ "São Paulo" */
export function gpShort(raceName: string, lang: Lang): string {
  if (lang === "zh" && GP_ZH[raceName]) return GP_ZH[raceName]
  return raceName.replace(/\s*Grand Prix$/i, "")
}

const FLAGS: Record<string, string> = {
  Australia: "🇦🇺",
  China: "🇨🇳",
  Japan: "🇯🇵",
  Bahrain: "🇧🇭",
  "Saudi Arabia": "🇸🇦",
  USA: "🇺🇸",
  "United States": "🇺🇸",
  Italy: "🇮🇹",
  Canada: "🇨🇦",
  Monaco: "🇲🇨",
  Spain: "🇪🇸",
  Austria: "🇦🇹",
  UK: "🇬🇧",
  "United Kingdom": "🇬🇧",
  Belgium: "🇧🇪",
  Hungary: "🇭🇺",
  Netherlands: "🇳🇱",
  Azerbaijan: "🇦🇿",
  Singapore: "🇸🇬",
  Mexico: "🇲🇽",
  Brazil: "🇧🇷",
  Qatar: "🇶🇦",
  UAE: "🇦🇪",
  "United Arab Emirates": "🇦🇪",
  Portugal: "🇵🇹",
  Turkey: "🇹🇷",
  France: "🇫🇷",
  Germany: "🇩🇪",
}

export const flag = (country: string) => FLAGS[country] ?? "🏁"

// 車隊色：取自 FastF1（MIT License）plotting/constants.json 的 2026 "official" 色。
// 依車隊名稱關鍵字比對（同 FastF1 做法；車隊改名時 constructorId 可能沿用舊值，名稱較可靠），比不到再用 ID。
export type TeamColor = string | { light: string; dark: string }
const TEAM_COLORS: [string, TeamColor][] = [
  ["racing bulls", "#6692FF"],
  ["rb f1", "#6692FF"],
  ["red bull", "#3671C6"],
  ["mercedes", "#27F4D2"],
  ["ferrari", "#E80020"],
  ["mclaren", "#FF8000"],
  ["aston martin", "#229971"],
  ["alpine", "#0093CC"],
  ["williams", "#64C4FF"],
  ["haas", "#B6BABD"],
  ["audi", "#FF2D00"],
  ["sauber", "#52E252"],
  // 官方色 #444444 在深色背景看不到，深色模式改用淺灰
  ["cadillac", { light: "#444444", dark: "#B4B4B8" }],
]
const TEAM_ID_ALIAS: Record<string, string> = {
  red_bull: "red bull",
  aston_martin: "aston martin",
  rb: "racing bulls",
  racing_bulls: "racing bulls",
  kick_sauber: "sauber",
}

export function teamColor(id: string, name = ""): TeamColor {
  const n = name.toLowerCase()
  const byName = n ? TEAM_COLORS.find(([kw]) => n.includes(kw)) : undefined
  if (byName) return byName[1]
  const key = TEAM_ID_ALIAS[id] ?? id
  return TEAM_COLORS.find(([kw]) => kw === key)?.[1] ?? "#8E8E93"
}

// 窄欄用的更短名稱（參考 FastF1 constants.json 的 short_name）
const TEAM_NARROW: Record<string, string> = {
  "Racing Bulls": "RB",
  "Aston Martin": "Aston",
}

export function teamShort(id: string, name: string, narrow = false): string {
  let n = name.replace(/\s*F1 Team$/i, "").trim()
  if (n === "RB") n = "Racing Bulls"
  if (!n) n = id.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())
  return narrow ? TEAM_NARROW[n] ?? n : n
}

export function driverCode(code: string, familyName: string): string {
  if (code) return code
  return familyName.replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase()
}

// ─────────────────────────────────────────────
// Widget 參數
// ─────────────────────────────────────────────

export type Mode = "auto" | "drivers" | "teams" | "schedule"

export interface Config {
  mode: Mode
  lang: Lang
}

/**
 * 支援兩種寫法：
 *   1. 關鍵字（空白或逗號分隔）："teams"、"schedule en"、"車隊"
 *   2. JSON：{"mode":"teams","lang":"en"}
 */
export function parseConfig(raw: string | null | undefined): Config {
  const cfg: Config = { mode: "auto", lang: "zh" }
  const text = (raw ?? "").trim()
  if (!text) return cfg

  let tokens: string[] = []
  if (text.startsWith("{")) {
    try {
      const obj = JSON.parse(text)
      tokens = [obj.mode, obj.lang].filter(Boolean).map(String)
    } catch {
      // 格式錯誤就用預設值
    }
  } else {
    tokens = text.replace(/^"|"$/g, "").split(/[\s,;，、]+/)
  }

  for (const word of tokens) {
    const tok = word.toLowerCase()
    if (["drivers", "driver", "車手"].includes(tok)) cfg.mode = "drivers"
    else if (["teams", "team", "constructors", "車隊"].includes(tok)) cfg.mode = "teams"
    else if (["schedule", "賽程"].includes(tok)) cfg.mode = "schedule"
    else if (["auto", "自動"].includes(tok)) cfg.mode = "auto"
    else if (["en", "english"].includes(tok)) cfg.lang = "en"
    else if (["zh", "中文", "tw", "zh-tw"].includes(tok)) cfg.lang = "zh"
  }
  return cfg
}

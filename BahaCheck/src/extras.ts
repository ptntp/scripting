// 其他每日項目：公會簽到、動畫瘋答題、廣告雙倍巴幣（只在中尺寸小工具顯示，會自動執行）。
// 流程參考 jkgtw/Surge 的 BahamutDailyBonus.js。
import type { DayState, Extra } from "./baha"
import {
  BahaError,
  HOME,
  MIN,
  Session,
  acquireLock,
  apiMessage,
  assertLoggedIn,
  errorPatch,
  fetchCsrfToken,
  getAdToken,
  getState,
  hasCredentials,
  http,
  isFinal,
  mainPatch,
  mainStep,
  makeExtra,
  mergeCookies,
  messageOf,
  nextTaipeiMidnight,
  parseJSON,
  patchState,
  releaseLock,
  requireCredentials,
  setAdToken,
  sleep,
  taipeiDate,
} from "./baha"

const GUILD_LIST_URL = "https://api.gamer.com.tw/ajax/common/topBar.php?type=forum"
const GUILD_SIGN_URL = "https://guild.gamer.com.tw/ajax/guildSign.php"
const ANI_HOME = "https://ani.gamer.com.tw/"
const QUIZ_URL = "https://ani.gamer.com.tw/ajax/animeGetQuestion.php"
const QUIZ_ANSWER_URL = "https://ani.gamer.com.tw/ajax/animeAnsQuestion.php"
// 每天公布動畫瘋答案的小屋（原腳本使用的來源）
const ANSWER_LIST_URL = "https://api.gamer.com.tw/mobile_app/bahamut/v1/home.php?owner=blackXblue&page=1"
const ANSWER_DETAIL_URL = "https://api.gamer.com.tw/mobile_app/bahamut/v1/home_creation_detail.php"

/** 廣告要看滿 30 秒才能領 */
export const AD_WAIT = 30_000
/** 按鈕執行時：開始超過 10 分鐘沒領就重新開始 */
const AD_MAX_AGE = 10 * MIN
/** 失敗或答案未公布時，自動執行至少隔這麼久再試 */
export const RETRY_AFTER = 30 * MIN

type Step = { extra: Extra; cookie: string }

// ── 公會簽到 ──────────────────────────────────────────────────

function cleanText(html: string): string {
  return String(html || "")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#0?39;/g, "'")
    .trim()
}

/** 從頂端選單的 HTML 取出公會編號與名稱（同一公會多個連結只算一次）。 */
export function parseGuilds(html: string): { sn: string; name: string }[] {
  const text = String(html || "").replace(/\n/g, "")
  const hits = [...text.matchAll(/guild\.php\?g?sn=(\d+)/g)]
  const names = new Map<string, string>()
  const order: string[] = []
  hits.forEach((match, i) => {
    const sn = match[1]
    if (!names.has(sn)) order.push(sn)
    // 名稱取這個連結到下一個公會連結之間的第一個 <p>
    const start = (match.index ?? 0) + match[0].length
    const end = i + 1 < hits.length ? hits[i + 1].index ?? text.length : text.length
    const name = cleanText(text.slice(start, end).match(/<p[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? "")
    if (name && !names.get(sn)) names.set(sn, name)
    else if (!names.has(sn)) names.set(sn, "")
  })
  return order.map((sn) => ({ sn, name: names.get(sn) || `公會 ${sn}` }))
}

export async function guildSign(cookie: string): Promise<Step> {
  const bar = await http(GUILD_LIST_URL, { cookie, referer: HOME })
  const jar = mergeCookies(cookie, bar.cookie)
  const guilds = parseGuilds(bar.text)
  if (!guilds.length) return { extra: makeExtra("skip", "未加入公會"), cookie: jar }

  const results = await Promise.all(guilds.map(async (guild) => {
    try {
      const res = await http(GUILD_SIGN_URL, {
        method: "POST", body: `sn=${guild.sn}`, cookie: jar,
        referer: `https://guild.gamer.com.tw/guild.php?gsn=${guild.sn}`,
      })
      const json = parseJSON(res.text)
      if (json?.ok) return { kind: "ok", msg: "" }
      const msg = apiMessage(json) || `HTTP ${res.status}`
      if (/請先登入/.test(msg)) return { kind: "nologin", msg }
      if (/已經簽到|簽到過/.test(msg)) return { kind: "ok", msg }
      if (/不是成員|不存在/.test(msg)) return { kind: "ignore", msg }
      return { kind: "fail", msg: `${guild.name}：${msg}` }
    } catch (error) {
      return { kind: "fail", msg: `${guild.name}：${messageOf(error)}` }
    }
  }))

  if (results.every((r) => r.kind === "nologin")) throw new BahaError("NO_LOGIN", "登入狀態失效")
  const ok = results.filter((r) => r.kind === "ok").length
  const failed = results.filter((r) => r.kind === "fail" || r.kind === "nologin")
  if (failed.length) {
    return { extra: makeExtra("fail", `${failed.length} 個失敗`, failed.map((r) => r.msg).join("\n")), cookie: jar }
  }
  if (!ok) return { extra: makeExtra("skip", "未加入公會"), cookie: jar }
  return { extra: makeExtra("done", `${ok} 個公會`), cookie: jar }
}

// ── 動畫瘋答題 ────────────────────────────────────────────────

/** 找出標題含今天日期（MM/dd，可不補 0）的答案文章 */
export function findAnswerPost(list: unknown, today: string): string {
  const [, month, day] = today.split("-").map(Number)
  const pattern = new RegExp(`(^|\\D)0?${month}/0?${day}(\\D|$)`)
  const items = Array.isArray(list) ? list : []
  const hit = items.find((item: any) => item && typeof item.title === "string" && pattern.test(item.title) && item.sn)
  return hit ? String((hit as any).sn) : ""
}

export function answerFrom(content: unknown): string {
  return String(content ?? "").match(/A\s*[:;：]\s*([1-4])/)?.[1] ?? ""
}

export function giftText(gift: unknown): string {
  const coins = String(gift ?? "").match(/(\d+)\s*巴幣/)?.[1]
  return coins ? `+${coins} 巴幣` : "答對了"
}

const ANSWERED = /已經答過|答過題目/

/** 先找今天的答案（公開資料、不需登入），有答案才去拿題目作答。 */
export async function animeQuiz(cookie: string, now: number = Date.now()): Promise<Step> {
  const list = await http(ANSWER_LIST_URL)
  const sn = findAnswerPost(parseJSON(list.text)?.creation, taipeiDate(now))
  if (!sn) return { extra: makeExtra("wait", "答案未公布", "今天的答案文章還沒發表，稍後會自動再試"), cookie }
  const post = await http(`${ANSWER_DETAIL_URL}?sn=${encodeURIComponent(sn)}`)
  const answer = answerFrom(parseJSON(post.text)?.content)
  if (!answer) return { extra: makeExtra("fail", "找不到答案", `答案文章 ${sn} 裡找不到答案`), cookie }

  const question = await http(`${QUIZ_URL}?t=${Date.now()}`, { cookie, referer: ANI_HOME })
  let jar = mergeCookies(cookie, question.cookie)
  const q = parseJSON(question.text)
  if (q?.nologin) throw new BahaError("NO_LOGIN", "登入狀態失效")
  if (!q?.token) {
    const msg = apiMessage(q)
    if (ANSWERED.test(msg)) return { extra: makeExtra("done", "已作答"), cookie: jar }
    return { extra: makeExtra("fail", "取得題目失敗", msg || `HTTP ${question.status}`), cookie: jar }
  }

  const res = await http(QUIZ_ANSWER_URL, {
    method: "POST",
    body: `token=${encodeURIComponent(q.token)}&ans=${answer}&t=${Date.now()}`,
    cookie: jar,
    referer: ANI_HOME,
  })
  jar = mergeCookies(jar, res.cookie)
  const r = parseJSON(res.text)
  if (r?.nologin) throw new BahaError("NO_LOGIN", "登入狀態失效")
  if (r?.ok) return { extra: makeExtra("done", giftText(r.gift), r.gift ? String(r.gift) : undefined), cookie: jar }
  const msg = apiMessage(r)
  if (ANSWERED.test(msg)) return { extra: makeExtra("done", "已作答"), cookie: jar }
  if (/答題錯誤|答錯/.test(msg)) return { extra: makeExtra("miss", "答錯了", `送出的答案：${answer}`), cookie: jar }
  return { extra: makeExtra("fail", "答題失敗", msg || `HTTP ${res.status}`), cookie: jar }
}

// ── 廣告雙倍巴幣 ──────────────────────────────────────────────

const AD_DONE = /已領|領取過|已經/

async function adCall(type: "start" | "finished", cookie: string, token: string) {
  const url = `https://api.gamer.com.tw/mobile_app/bahamut/v1/sign_in_ad_${type}.php?bahamutCsrfToken=${encodeURIComponent(token)}`
  const res = await http(url, {
    method: "POST",
    cookie: mergeCookies(cookie, `ckBahamutCsrfToken=${token}`),
    headers: { "X-Bahamut-Csrf-Token": token },
  })
  const json = parseJSON(res.text)
  assertLoggedIn(json, res.status)
  const raw = json?.data?.finished
  const finished = raw === undefined || raw === null ? null : Number(raw)
  return { finished, message: apiMessage(json) || (finished === null ? `HTTP ${res.status}` : ""), cookie: mergeCookies(cookie, res.cookie) }
}

/** 開始看廣告；成功時回傳 running，30 秒後再呼叫 adFinish。 */
export async function adStart(cookie: string, now: number = Date.now()): Promise<Step> {
  const csrf = await fetchCsrfToken(cookie)
  const token = csrf.token.slice(0, 16)
  const r = await adCall("start", csrf.cookie, token)
  if (r.finished === 0) {
    setAdToken(token)
    return { extra: { ...makeExtra("running", "領取中…", undefined, now), startedAt: now }, cookie: r.cookie }
  }
  if (r.finished === 1 || AD_DONE.test(r.message)) return { extra: makeExtra("done", "已領取"), cookie: r.cookie }
  return { extra: makeExtra("fail", "領取失敗", r.message), cookie: r.cookie }
}

export async function adFinish(cookie: string): Promise<Step> {
  const token = getAdToken()
  if (!token) return { extra: makeExtra("fail", "領取失敗", "找不到廣告令牌，請再點一次"), cookie }
  const r = await adCall("finished", cookie, token)
  setAdToken("")
  if (r.finished === 1 || AD_DONE.test(r.message)) return { extra: makeExtra("done", "已領取"), cookie: r.cookie }
  return { extra: makeExtra("fail", "領取失敗", r.message), cookie: r.cookie }
}

// ── 執行 ──────────────────────────────────────────────────────

async function safely(task: () => Promise<Extra>): Promise<Extra> {
  try {
    return await task()
  } catch (error) {
    const { error: message } = errorPatch(error)
    return makeExtra("fail", "失敗", message)
  }
}

/** 執行中帳密被拒：記到主狀態，之後小工具當天不再自動登入，避免帳號被鎖。 */
function recordLoginError(session: Session): DayState | null {
  if (!session.loginError) return null
  return patchState({ checkedAt: Date.now(), ...errorPatch(session.loginError) })
}

const guildTask = (session: Session) => safely(async () => (await session.run(guildSign)).extra)
const quizTask = (session: Session) => safely(async () => (await session.run((cookie) => animeQuiz(cookie))).extra)
const adStartTask = (session: Session) => safely(async () => (await session.run((cookie) => adStart(cookie))).extra)
const adFinishTask = (session: Session) => safely(async () => (await session.run(adFinish)).extra)

export type RunOptions = {
  /** 中途狀態有變化時呼叫（例如重新整理小工具） */
  onProgress?: (state: DayState) => void
  /** 等待廣告的函式，測試時可替換 */
  wait?: (ms: number) => Promise<unknown>
}

/**
 * 手動「全部執行」（中型小工具按鈕、App 按鈕）：
 * 主站簽到 → 開始看廣告 → 公會簽到 → 動畫瘋答題 → 等滿 30 秒領廣告獎勵。
 * 已完成的項目今天不會重做；某一項失敗不影響其他項目。不會丟出例外。
 */
export async function runAll(options: RunOptions = {}): Promise<DayState> {
  const wait = options.wait ?? sleep
  const progress = () => {
    const state = getState()
    if (state && options.onProgress) {
      try { options.onProgress(state) } catch (_) {}
    }
  }

  let session: Session
  try {
    session = new Session(requireCredentials())
  } catch (error) {
    return patchState({ checkedAt: Date.now(), ...errorPatch(error) })
  }

  // 手動執行優先：直接佔用執行鎖，自動執行看到鎖就會跳過
  acquireLock(0)
  try {
    // 1. 主站簽到
    let signed = false
    try {
      const result = await mainStep(session, true)
      signed = result.signed
      patchState(mainPatch(session, result))
    } catch (error) {
      const state = patchState({
        checkedAt: Date.now(),
        ...errorPatch(error),
        ...(session.nickname ? { nickname: session.nickname } : {}),
      })
      // 登入失敗或連不上網路時，其他項目也做不了
      if (error instanceof BahaError && error.code !== "API") {
        progress()
        return state
      }
      signed = state.signed
    }

    const before = getState()

    // 2. 廣告：先開始計時，等待時間拿來做公會與答題
    let adStartedAt = 0
    if (signed && !isFinal(before?.ads)) {
      const running = before?.ads?.state === "running" ? before.ads.startedAt ?? 0 : 0
      if (running && Date.now() - running < AD_MAX_AGE && getAdToken()) {
        adStartedAt = running
      } else {
        const extra = await adStartTask(session)
        patchState({ ads: extra })
        if (extra.state === "running") adStartedAt = extra.startedAt ?? Date.now()
      }
    }
    progress()

    // 3. 公會簽到、4. 動畫瘋答題
    if (!isFinal(before?.guild)) patchState({ guild: await guildTask(session) })
    if (!isFinal(before?.quiz)) patchState({ quiz: await quizTask(session) })

    // 5. 領廣告獎勵
    if (adStartedAt && !session.loginError) {
      progress()
      const remain = adStartedAt + AD_WAIT + 1000 - Date.now()
      if (remain > 0) await wait(remain)
      patchState({ ads: await adFinishTask(session) })
    }
    recordLoginError(session)
  } finally {
    releaseLock()
  }

  progress()
  return getState() ?? patchState({})
}

/** 自動執行時這一項是否該做（失敗或等待中的項目隔 RETRY_AFTER 再試） */
function due(extra: Extra | undefined, now: number): boolean {
  if (!extra) return true
  if (isFinal(extra)) return false
  return now - extra.at >= RETRY_AFTER
}

export type AutoPlan = { guild: boolean; quiz: boolean; ads: "start" | "finish" | null }

/**
 * 小工具更新時要自動做哪些項目。
 * 主站簽到維持手動（點小工具）；廣告雙倍要主站簽到後才做，開始後下次更新（滿 30 秒）再領。
 */
export function autoPlan(state: DayState | null, now: number = Date.now(), hasAdToken: boolean = !!getAdToken()): AutoPlan {
  const none: AutoPlan = { guild: false, quiz: false, ads: null }
  const today = state && state.date === taipeiDate(now) ? state : null
  if (today?.errorCode === "LOGIN") return none
  const plan: AutoPlan = { guild: due(today?.guild, now), quiz: due(today?.quiz, now), ads: null }
  if (today?.signed && !isFinal(today.ads)) {
    const ads = today.ads
    if (ads?.state === "running") {
      if (now - (ads.startedAt ?? ads.at) >= AD_WAIT) plan.ads = hasAdToken ? "finish" : "start"
    } else if (due(ads, now)) {
      plan.ads = "start"
    }
  }
  return plan
}

/**
 * 背景自動執行（小工具每次更新時呼叫）：公會簽到、動畫瘋答題、廣告雙倍。
 * 不會等待：廣告開始後就結束，下次更新再領獎勵。不會丟出例外。
 */
export async function autoExtras(now: number = Date.now()): Promise<DayState | null> {
  if (!hasCredentials()) return getState()
  const plan = autoPlan(getState(), now)
  if (!plan.guild && !plan.quiz && !plan.ads) return getState()
  if (!acquireLock()) return getState()
  try {
    const session = new Session(requireCredentials())
    try {
      await session.ensure()
    } catch (error) {
      // 連登入都失敗：帳密錯誤記到主狀態；網路問題則下次更新再試
      return recordLoginError(session) ?? getState()
    }
    // 廣告最趕時間，先做
    if (plan.ads === "finish") patchState({ ads: await adFinishTask(session) })
    else if (plan.ads === "start") patchState({ ads: await adStartTask(session) })
    if (plan.guild) patchState({ guild: await guildTask(session) })
    if (plan.quiz) patchState({ quiz: await quizTask(session) })
    recordLoginError(session)
  } catch (error) {
    // 理論上不會到這裡；保險起見不讓小工具崩潰
    console.log?.(`[BahaCheck] autoExtras: ${messageOf(error)}`)
  } finally {
    releaseLock()
  }
  return getState()
}

/** 下次更新小工具的時間 */
export function nextReload(state: DayState | null, configured: boolean, now: number = Date.now()): number {
  const hourly = now + 60 * MIN
  if (!configured) return hourly
  const today = state && state.date === taipeiDate(now) ? state : null
  if (!today) return hourly
  const ads = today.ads
  // 廣告看滿 30 秒後盡快更新以領取獎勵
  if (ads?.state === "running") return Math.max(now + MIN, (ads.startedAt ?? ads.at) + AD_WAIT + 5_000)
  if (today.errorCode === "LOGIN") return hourly
  if (today.signed && allDone(today, now)) return nextTaipeiMidnight(now) + 2 * MIN
  // 有項目在等待重試：到可以重試的時間再更新（最多一小時）
  const retries = [today.guild, today.quiz, today.signed ? ads : undefined]
    .filter((extra): extra is Extra => !!extra && !isFinal(extra))
    .map((extra) => extra.at + RETRY_AFTER + MIN)
  return Math.min(hourly, ...retries.map((at) => Math.max(now + 5 * MIN, at)))
}

// ── 顯示 ──────────────────────────────────────────────────────

export type Tone = "ok" | "muted" | "warn" | "bad"

/** 中尺寸小工具與 App 用的狀態文字與顏色；emptyText 為今天還沒執行時的文字。 */
export function describeExtra(extra: Extra | undefined, emptyText: string = "等待執行"): { text: string; tone: Tone } {
  if (!extra) return { text: emptyText, tone: "muted" }
  switch (extra.state) {
    case "done": return { text: extra.text, tone: "ok" }
    case "skip": return { text: extra.text, tone: "muted" }
    case "miss": return { text: extra.text, tone: "bad" }
    case "wait":
    case "running": return { text: extra.text, tone: "warn" }
    default: return { text: extra.text, tone: "bad" }
  }
}

/** 今天的其他項目（只看今天的狀態） */
export function todayExtras(state: DayState | null, now: number = Date.now()): { guild?: Extra; quiz?: Extra; ads?: Extra } {
  if (!state || state.date !== taipeiDate(now)) return {}
  return { guild: state.guild, quiz: state.quiz, ads: state.ads }
}

/** 主站已簽到且其他三項都不用再做 */
export function allDone(state: DayState | null, now: number = Date.now()): boolean {
  if (!state || state.date !== taipeiDate(now) || !state.signed) return false
  return isFinal(state.guild) && isFinal(state.quiz) && isFinal(state.ads)
}

/** 廣告正在領取中（今天開始、還沒領） */
export function adRunning(state: DayState | null, now: number = Date.now()): boolean {
  return todayExtras(state, now).ads?.state === "running"
}

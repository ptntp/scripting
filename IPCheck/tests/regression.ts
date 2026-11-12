import { Script } from "scripting"
import { canonicalAddress, expandIPv6, formatIPAddress, formatIPLocation, isPublicExitAddress, parseIPInfo, calculateRiskValue } from "../utils/ip"
import { collectGeoRow, sameIP, withTimeout } from "../utils/geo"
import { validIPAddress, parseProxyCheck, assembleLookupResult } from "../utils/lookup"
import { parseIPPure } from "../utils/ippure"
import { normalizeRTCAddress, rtcAddressScope, parseWebRTC, assessWebRTC } from "../utils/webrtc"
import { detectionTime, locationDetails, networkDetails } from "../utils/details"
import { activeRiskFlags, hasKnownRiskFlags, shouldShowRiskScale } from "../utils/flags"
import { buildWidgetSnapshot, parseWidgetSnapshot } from "../utils/widget_sync"
import { hasCoordinates } from "../utils/map"
import { classifyInterfaces, isHttp3, latencyLabel, natLabel, parseTrace,
  GLOBAL_LATENCY_URLS, TAIWAN_LATENCY_URLS, QUIC_TRACE_URLS } from "../utils/diagnose"
import { SERVICES, countUsable, judgeChatGPT, judgeNetflix, judgeReach, makeService, mergeService,
  netflixRegion, parseBahamut, parseYoutube, pendingServices, regionCode } from "../utils/unlock"
import { buildDiagSummary, diagSummaryText, parseDiagSummary, widgetKind } from "../utils/widget_sync"
import { maskKey, matchServicePolicies, normalizeProtocol, parsePolicyGroups, parseSurgeSettings, policyLabel,
  protocolFromName, resolveSurgeInfo } from "../utils/surge"
import type { IPInfo } from "../utils/ip"

const failures: string[] = []
let passed = 0
function check(name: string, assertion: () => boolean) {
  try {
    if (!assertion()) throw new Error("斷言失敗")
    passed++
  } catch (error) { failures.push(`${name}: ${String(error)}`) }
}

async function run() {
  for (const ip of ["1:2:3:4:5:6:7::8", "::1:2:3:4:5:6:7:8", "1:2:3:4:5:6:7:8::", "1:::2", "2001::db8::1", "256.0.0.1"]) {
    check(`拒絕非法位址 ${ip}`, () => !validIPAddress(ip) && canonicalAddress(ip) === null && normalizeRTCAddress(ip) === null)
  }
  for (const ip of ["::", "::1", "2001:db8::1", "1:2:3:4:5:6:7:8", "::ffff:192.0.2.1", "192.0.2.1"]) {
    check(`接受有效位址 ${ip}`, () => validIPAddress(ip) && canonicalAddress(ip) !== null)
  }
  check("IPv6 壓縮必須代表至少一段", () => expandIPv6("1:2:3:4:5:6:7::8") === null)
  check("等價 IPv6", () => sameIP("2001:db8::1", "2001:0db8:0:0:0:0:0:1"))
  check("IPv4 mapped 同址", () => sameIP("::ffff:192.0.2.1", "192.0.2.1"))
  check("IPv4 mapped 隱私", () => formatIPAddress("::ffff:192.0.2.1", true) === "192.0.x.x")
  check("IPv6 隱私", () => formatIPAddress("2001:db8::1234", true) === "2001:0db8:0000:0000::/64")
  check("IPv4 空白不繞過隱私", () => formatIPAddress(" 192.0.2.1 ", true) === "192.0.x.x")
  check("非法位址不能同址", () => !sameIP("invalid", "invalid"))
  for (const ip of ["127.0.0.1", "10.1.2.3", "100.64.1.1", "169.254.1.2", "192.0.2.1", "198.51.100.2", "203.0.113.1", "::1", "fe80::1", "fc00::1", "2001:db8::1", "::ffff:127.0.0.1"]) {
    check(`出口不採信非公網 ${ip}`, () => !isPublicExitAddress(ip))
  }
  check("出口採信公網 IPv4", () => isPublicExitAddress("8.8.8.8"))
  check("台灣獨立顯示", () => formatIPLocation({ country: "台灣", countryCode: "TW", regionName: "台灣省", city: "台北市" }) === "台灣 · 台北市")
  check("台灣去除中國前綴", () => formatIPLocation({ country: "中國", countryCode: "", regionName: "台灣", city: "高雄" }) === "台灣 · 高雄")
  check("台灣英文 Province of China 去除", () => formatIPLocation({ country: "Taiwan (Province of China)", countryCode: "TW", regionName: "Taipei", city: "Taipei" }) === "台灣 · Taipei")
  check("簡體地名轉繁體", () => formatIPLocation({ country: "美国", countryCode: "US", regionName: "加利福尼亚州", city: "洛杉矶" }) === "美國 · 加利福尼亞州 · 洛杉磯")
  check("簡體台灣地名轉繁體", () => formatIPLocation({ country: "台湾", countryCode: "TW", regionName: "台湾省", city: "台东县" }) === "台灣 · 台東縣")
  check("簡體港澳轉繁體", () => formatIPLocation({ country: "中国", countryCode: "MO", regionName: "澳门特别行政区", city: "澳门" }) === "中國 · 澳門地區")
  check("ip-api 文字欄位轉繁體", () => parseIPInfo({ status: "success", query: "8.8.8.8", country: "俄罗斯", isp: "数据中心" })?.country === "俄羅斯")
  check("出口採信公網 IPv6", () => isPublicExitAddress("2606:4700:4700::1111"))
  check("ip-api 拒絕無效目標位址", () => parseIPInfo({ status: "success", query: "invalid" }) === null)
  check("ip-api 拒絕錯址回應", () => parseIPInfo({ status: "success", query: "1.1.1.1" }, "8.8.8.8") === null)
  check("ip-api 欄位缺失不使小工具崩潰", () => {
    const info = parseIPInfo({ status: "success", query: "8.8.8.8", isp: 88, offset: 0 })
    return !!info && info.isp === "" && info.offset === 0 && calculateRiskValue(info).riskValue >= 0
  })
  check("ip-api 忽略異常布林值與座標", () => {
    const info = parseIPInfo({ status: "success", query: "8.8.8.8", hosting: "false", lat: 999, lon: 999 })
    return !!info && info.hosting === undefined && !hasCoordinates(info)
  })
  check("ip-api 單側座標缺失不會畫到赤道", () => {
    const info = parseIPInfo({ status: "success", query: "8.8.8.8", lon: 120.1 })
    return !!info && !hasCoordinates(info)
  })
  check("ip-api 真實零緯度保留", () => {
    const info = parseIPInfo({ status: "success", query: "8.8.8.8", lat: 0, lon: 120.1 })
    return !!info && hasCoordinates(info)
  })

  const ip = "8.8.8.8"
  const pc = parseProxyCheck({ status: "warning", [ip]: { detections: { risk: 0, proxy: false, vpn: false, confidence: 0 }, device_estimate: { address: 0, subnet: 0 } } }, ip)
  check("proxycheck 保留真實零值與 false", () => pc?.risk === 0 && pc.proxy === false && pc.confidence === 0 && pc.devices?.address === 0)
  check("proxycheck 缺失仍未知", () => pc?.tor === null && pc?.hosting === null)
  check("未標記與未知標記均不佔位", () => activeRiskFlags(pc, false).length === 0 && activeRiskFlags(pc, null).length === 0)
  check("空信譽不佔位", () => activeRiskFlags(null, null).length === 0)
  const mixedFlags = parseProxyCheck({ status: "ok", [ip]: { detections: {
    proxy: false, vpn: true, tor: false, anonymous: null, scraper: true, compromised: false,
  } } }, ip)
  check("只渲染明確陽性的標記", () => activeRiskFlags(mixedFlags, false).map(flag => flag.id).join(",") === "vpn,scraper")
  check("代理備援為真時排在首位", () => activeRiskFlags(mixedFlags, true).map(flag => flag.id).join(",") === "proxy,vpn,scraper")
  const allFlags = parseProxyCheck({ status: "ok", [ip]: { detections: {
    proxy: true, vpn: true, tor: true, anonymous: true, scraper: true, compromised: true,
  } } }, ip)
  check("全部命中保持固定順序", () => activeRiskFlags(allFlags, true).map(flag => flag.id).join(",") === "proxy,vpn,tor,anonymous,scraper,compromised")
  check("零分與缺失不顯示刻度條", () => !shouldShowRiskScale(0) && !shouldShowRiskScale(null)
    && !shouldShowRiskScale(undefined) && !shouldShowRiskScale(Number.NaN))
  check("正分顯示刻度條", () => shouldShowRiskScale(0.5) && shouldShowRiskScale(1) && shouldShowRiskScale(100))

  const widgetInfo: IPInfo = { query: ip, status: "success", country: "美國", countryCode: "US",
    regionName: "California", city: "Mountain View", isp: "Google", org: "Google LLC",
    as: "AS15169 Google LLC", lat: 37.4, lon: -122.1, timezone: "America/Los_Angeles", offset: -28800 }
  const widgetRep = parseProxyCheck({ status: "ok", [ip]: { detections: {
    risk: 42, proxy: false, vpn: true, tor: false, anonymous: false, scraper: false, compromised: false, hosting: false,
  } } }, ip)
  const snapshot = buildWidgetSnapshot({ ip, info: widgetInfo, reputation: widgetRep, pure: null })
  check("小工具快照同步 IP 與地圖座標", () => snapshot.ip === ip && snapshot.lat === 37.4 && snapshot.lon === -122.1)
  check("小工具快照使用 proxycheck 風險", () => snapshot.risk === 42 && snapshot.riskSource === "proxycheck")
  check("小工具快照同步風險標記與屬性", () => snapshot.vpnStatus === "VPN" && snapshot.accessType === "非機房標記")
  check("未標記與未知可區分", () => snapshot.vpnStatus === "VPN"
    && buildWidgetSnapshot({ ip, info: widgetInfo, reputation: pc, pure: null }).vpnStatus === "未標記"
    && buildWidgetSnapshot({ ip, info: widgetInfo, reputation: null, pure: null }).vpnStatus === "未知"
    && hasKnownRiskFlags(pc) && !hasKnownRiskFlags(null))

  const pureStub: import("../utils/ippure").IPPureReport = {
    source: null, asn: null, organization: null, domain: null, range: null, isBroadcast: null,
    isResidential: null, networkType: null, risk: 77, cloudflareRisk: null, traffic: null,
    locations: [], exit: null, note: "",
  }
  const zeroRep = parseProxyCheck({ status: "ok", [ip]: { detections: {
    risk: 0, proxy: false, vpn: false, confidence: 0,
  } } }, ip)
  const zeroSnapshot = buildWidgetSnapshot({ ip, info: widgetInfo, reputation: zeroRep, pure: pureStub })
  check("proxycheck 0 分不被 IPPure 覆蓋", () => zeroSnapshot.risk === 0 && zeroSnapshot.riskSource === "proxycheck")
  const pureSnapshot = buildWidgetSnapshot({ ip, info: widgetInfo, reputation: null, pure: pureStub })
  check("proxycheck 缺失時改用 IPPure", () => pureSnapshot.risk === 77 && pureSnapshot.riskSource === "IPPure")
  check("快照往返保留關鍵欄位", () => {
    const parsed = parseWidgetSnapshot(snapshot)
    return !!parsed && parsed.ip === snapshot.ip && parsed.risk === 42 && parsed.riskSource === "proxycheck"
      && parsed.accessType === snapshot.accessType && parsed.vpnStatus === "VPN"
  })
  check("快照拒絕非法版本與位址", () => parseWidgetSnapshot({ ...snapshot, version: 2 }) === null
    && parseWidgetSnapshot({ ...snapshot, ip: "999.1.1.1" }) === null)
  check("快照剔除越界或單邊座標", () => {
    const parsed = parseWidgetSnapshot({ ...snapshot, lat: 999, lon: 10 })
    return !!parsed && parsed.lat === null && parsed.lon === null
  })
  check("proxycheck 不採信異址資料", () => parseProxyCheck({ status: "ok", "1.1.1.1": { detections: { risk: 90 } } }, ip) === null)
  check("歸屬缺失保留同址信譽結果", () => {
    const result = assembleLookupResult(ip, null, null, pc)
    return result.info === null && result.reputation?.risk === 0 && result.reputation.proxy === false
  })
  check("歸屬與信譽均缺失則明確失敗", () => {
    try { assembleLookupResult(ip, null, null, null); return false }
    catch (error) { return String(error).includes("歸屬查詢失敗") }
  })
  check("補充源畸形國家碼不損害主源", () => {
    const info = parseIPInfo({ status: "success", query: ip, country: "美國" })!
    const result = assembleLookupResult(ip, info, { success: true, ip, country_code: 42 as never,
      connection: { org: 88 as never, asn: 15169 } }, pc)
    return result.info === info && result.alternateLocation?.countryCode === "" && result.connection?.organization === "—"
  })
  check("備選源單側座標缺失不畫錯地圖", () => {
    const result = assembleLookupResult(ip, null, { success: true, ip, latitude: 0, country: "美國" }, null)
    return result.info !== null && !hasCoordinates(result.info)
  })

  const base = { queriedIP: ip, basic: { ip, asn: { number: 15169 } } }
  check("IPPure 異址評分拒絕", () => parseIPPure(ip, { ...base, risk: 87, riskIP: "1.1.1.1" }, null).risk === null)
  check("IPPure 無來源評分拒絕", () => parseIPPure(ip, { ...base, risk: 87 }, null).risk === null)
  check("IPPure 同址零分保留", () => parseIPPure(ip, { ...base, risk: 0, riskIP: ip }, null).risk === 0)
  check("IPPure 官方異址僅作出口", () => {
    const report = parseIPPure(ip, null, { ip: "1.1.1.1", fraudScore: 99 })
    return report.risk === null && report.exit?.ip === "1.1.1.1"
  })
  check("IPPure 官方同址補零分", () => parseIPPure(ip, null, { ip, fraudScore: 0 }).risk === 0)
  check("IPPure IPv6 不借用殘留 IPv4 評分", () => parseIPPure("2001:db8::1", { queriedIP: "2001:db8::1", basic: { ip: "2001:db8::1" }, risk: 88, riskIP: ip }, null).risk === null)
  check("Cloudflare 獨立校驗位址", () => parseIPPure(ip, { ...base, cf: { ip: "1.1.1.1", risk_score: 99 } }, null).cloudflareRisk === null)
  check("人機比異常值拒絕", () => parseIPPure(ip, { ...base, traffic: { human: 80, bot: 80 } }, null).traffic === null)

  const info: IPInfo = { query: ip, status: "success", country: "美國", countryCode: "US", regionName: "", city: "", isp: "Example", org: "example", as: "", lat: 37, lon: -122, timezone: "Etc/UTC", offset: 0 }
  check("地理詳情保留 UTC 0 偏移", () => locationDetails(info).some(row => row.value === "Etc/UTC · UTC+00:00"))
  check("電信業者機構去重", () => networkDetails(info, "EXAMPLE").length === 0)
  check("異常時間不顯示", () => detectionTime("invalid") === null)
  check("地圖拒絕缺失座標", () => !hasCoordinates({ ...info, lat: NaN }))
  check("地圖拒絕越界座標", () => !hasCoordinates({ ...info, lon: 181 }))
  check("地圖接受赤道有效座標", () => hasCoordinates({ ...info, lat: 0 }))
  check("地圖區分真實零座標與缺失", () => hasCoordinates({ ...info, lat: 0, lon: 0 }))
  check("NAT64 全球轉換前綴參與公網對照", () => rtcAddressScope("64:ff9b::808:808") === "public")
  check("NAT64 內嵌環回位址不算公網", () => rtcAddressScope("64:ff9b::7f00:1") === "local")
  check("NAT64 內嵌私網位址不算公網", () => rtcAddressScope("64:ff9b::c0a8:101") === "local")
  check("IPv6 新文件前綴不參與公網對照", () => rtcAddressScope("3fff::1") === "local")
  check("IPv4 公網特殊用途例外保留", () => rtcAddressScope("192.0.0.9") === "public")
  check("IPv6 ORCHID 非公網", () => rtcAddressScope("2001:20::1") === "local")
  const exitWithoutLocation = await collectGeoRow("Cloudflare", ip, true, async () =>
    ({ ip: "1.1.1.1", country: "", code: "", region: "", city: "" }))
  check("位置未知時保留已觀測出口", () => exitWithoutLocation.ip === "1.1.1.1"
    && exitWithoutLocation.status === "unavailable" && exitWithoutLocation.note === "位置暫不可用")
  const wrongAddress = await collectGeoRow("DB-IP", ip, false, async () =>
    ({ ip: "1.1.1.1", country: "美國", code: "US", region: "", city: "" }))
  check("位址庫錯址不採信", () => wrongAddress.ip === null && wrongAddress.status === "unavailable")

  const rtc = parseWebRTC({ status: "complete", candidates: [
    "candidate:1 1 UDP 123 8.8.8.8 6000 typ srflx raddr 192.168.0.1 rport 5000",
    "candidate:1 1 UDP 123 8.8.8.8 6000 typ srflx raddr 192.168.0.1 rport 5000",
    "candidate:2 1 UDP 123 secret.local 5000 typ host",
  ] })
  check("WebRTC 去重且不混入 raddr", () => rtc.candidates.length === 2 && !rtc.candidates.some(candidate => candidate.address === "192.168.0.1"))
  check("WebRTC 同址出口", () => assessWebRTC(rtc, [{ source: "測試", ip, location: "" }]).tone === "ok")
  check("WebRTC 異址警示", () => assessWebRTC(rtc, [{ source: "測試", ip: "1.1.1.1", location: "" }]).tone === "warning")
  check("WebRTC 無對照不判定安全", () => assessWebRTC(rtc, []).tone === "neutral")
  check("手動查詢不做 WebRTC", () => assessWebRTC(rtc, [], false, true).label === "不適用")

  // ── 網路診斷 ──
  const trace = parseTrace("fl=1\nip=8.8.8.8\nloc=TW\nhttp=http/3\nbroken\n=x\n")
  check("trace 解析", () => trace.loc === "TW" && trace.http === "http/3" && trace.ip === "8.8.8.8" && !("broken" in trace))
  check("HTTP/3 判定", () => isHttp3("http/3") && isHttp3("h3") && !isHttp3("http/2") && !isHttp3(""))
  check("NAT：CGNAT", () => natLabel("100.72.1.9", "1.1.1.1") === "電信級 NAT（CGNAT）")
  check("NAT：私有位址", () => natLabel("192.168.1.20", "1.1.1.1") === "NAT（私有位址）" && natLabel("172.20.0.4", "") === "NAT（私有位址）")
  check("NAT：公網同址", () => natLabel("8.8.8.8", "8.8.8.8") === "公網位址（無 NAT）" && natLabel("8.8.8.8", "1.1.1.1") === "公網位址")
  check("NAT：無效輸入", () => natLabel("", "1.1.1.1") === "未知" && natLabel("fe80::1", "1.1.1.1") === "未知" && natLabel("172.32.0.1", "") === "公網位址")
  const wifi = classifyInterfaces({
    lo0: [{ address: "127.0.0.1", family: "IPv4", isInternal: true }],
    en0: [{ address: "fe80::1%en0", family: "IPv6" }, { address: "192.168.1.20", family: "IPv4" }, { address: "2001:b011::5", family: "IPv6" }],
    utun3: [{ address: "10.8.0.2", family: "IPv4" }],
    pdp_ip0: [{ address: "10.20.30.40", family: "IPv4" }],
  })
  check("介面：Wi-Fi 優先並識別 VPN / IPv6", () => wifi.type === "wifi" && wifi.ip === "192.168.1.20" && wifi.vpn && wifi.ipv6)
  const cell = classifyInterfaces({ pdp_ip0: [{ address: "100.72.1.9" }, { address: "fe80::2" }] })
  check("介面：行動網路且連結本地 IPv6 不算", () => cell.type === "cellular" && !cell.ipv6 && !cell.vpn)
  check("介面：空清單", () => classifyInterfaces({}).type === "unknown" && classifyInterfaces({}).ip === "")
  check("延遲文字", () => latencyLabel(41.6) === "42 ms" && latencyLabel(null) === "無回應" && latencyLabel(NaN) === "無回應")

  // ── 解鎖檢測 ──
  check("地區代碼正規化", () => regionCode(" tw ") === "TW" && regionCode("TWN") === "" && regionCode(null) === "")
  check("Netflix 地區路徑", () => netflixRegion("https://www.netflix.com/tw/title/81280792") === "TW"
    && netflixRegion("https://www.netflix.com/title/81280792") === "US"
    && netflixRegion("https://www.netflix.com/jp-en/title/1") === "JP")
  check("Netflix 完整片庫", () => judgeNetflix({ kind: "region", region: "TW" }, { kind: "error" }).state === "ok")
  check("Netflix 僅自製", () => {
    const result = judgeNetflix({ kind: "missing" }, { kind: "region", region: "JP" })
    return result.state === "warn" && result.region === "JP"
  })
  check("Netflix 未開放 / 失敗", () => judgeNetflix({ kind: "blocked" }, { kind: "error" }).state === "no"
    && judgeNetflix({ kind: "missing" }, { kind: "missing" }).state === "no"
    && judgeNetflix({ kind: "error" }, { kind: "region", region: "US" }).state === "na"
    && judgeNetflix({ kind: "missing" }, { kind: "error" }).state === "na")
  check("YouTube Premium 地區", () => parseYoutube(200, '{"countryCode":"TW"}').region === "TW"
    && parseYoutube(200, "Premium is not available in your country").state === "no"
    && parseYoutube(200, "<html></html>").region === "US" && parseYoutube(503, "").state === "na")
  check("ChatGPT 支援地區", () => judgeChatGPT("tw", "ok").state === "ok" && judgeChatGPT("TW", "blocked").state === "warn"
    && judgeChatGPT("TW", "error").state === "warn" && judgeChatGPT("HK", "ok").state === "no" && judgeChatGPT("", "ok").state === "no")
  check("動畫瘋判定", () => parseBahamut(200, '{"animeSn":37783}').region === "TW"
    && parseBahamut(200, '{"error":{"code":1011}}').state === "no" && parseBahamut(0, "").state === "na" && parseBahamut(503, '{"error":1}').state === "na")
  check("連線檢測判定", () => judgeReach("claude", 403, "TW").state === "ok" && judgeReach("gemini", 200, "tw").region === "TW"
    && judgeReach("copilot", 451, "").state === "no" && judgeReach("grok", 502, "").state === "na" && judgeReach("spotify", 0, "").state === "no")
  const pending = pendingServices()
  check("服務清單 6 + 6", () => countUsable(pending, "media").total === 6 && countUsable(pending, "ai").total === 6 && countUsable(pending, "ai").ok === 0)
  const merged = mergeService(mergeService(pending, makeService("netflix", "warn", "JP", "")), makeService("claude", "ok", "TW", ""))
  check("逐項合併與統計", () => countUsable(merged, "media").ok === 1 && countUsable(merged, "ai").ok === 1 && merged.length === 12)
  const BLOCKED_HOSTS = /(\.cn$|baidu|qq\.com|ipip\.net|3322\.net|miui|vivo|bilibili|deepseek|tiktok|douyin|aliyun|tencent|163\.com|weibo)/i
  check("探測點不含中國來源", () => [...GLOBAL_LATENCY_URLS, ...TAIWAN_LATENCY_URLS, ...QUIC_TRACE_URLS]
    .every(url => !BLOCKED_HOSTS.test(new URL(url).hostname))
    && SERVICES.every(item => !/deepseek|tiktok/i.test(item.id + item.name)))
  const summary = buildDiagSummary(merged, 41.6)
  check("診斷摘要", () => diagSummaryText(summary) === "串流 1/6 · AI 1/6 · 42 ms"
    && diagSummaryText(buildDiagSummary(merged, null)) === "串流 1/6 · AI 1/6")
  check("診斷摘要解析", () => parseDiagSummary(JSON.parse(JSON.stringify(summary)))?.aiOk === 1
    && parseDiagSummary({ ...summary, mediaOk: 9 }) === null && parseDiagSummary({ ...summary, version: 2 }) === null
    && parseDiagSummary(null) === null)

  check("小工具版面：標準尺寸", () => widgetKind("systemSmall", { width: 158, height: 158 }) === "small"
    && widgetKind("systemMedium", { width: 338, height: 158 }) === "medium"
    && widgetKind("systemLarge", { width: 338, height: 354 }) === "large"
    && widgetKind("systemExtraLarge", { width: 715, height: 354 }) === "large")
  check("小工具版面：未知尺寸依大小判定", () => widgetKind("systemExtraLargePortrait", { width: 338, height: 547 }) === "large"
    && widgetKind("somethingNew", { width: 338, height: 547 }) === "large"
    && widgetKind(undefined, { width: 338, height: 158 }) === "medium"
    && widgetKind(undefined, { width: 158, height: 158 }) === "small")

  // ── Surge HTTP API ──
  const groupsData = {
    "AI": [{ name: "節點選擇", typeDescription: "Select Group" }, { name: "JP02", typeDescription: "Shadowsocks" }],
    "節點選擇": [{ name: "TW01 Trojan", typeDescription: "Trojan" }, { name: "TW01 Trojan", typeDescription: "Trojan" }, { name: "JP02", typeDescription: "Shadowsocks" }],
  }
  const recentData = { requests: [
    { id: 1, remoteHost: "www.netflix.com:443", policyName: "TW01 Trojan" },
    { id: 2, remoteHost: "claude.ai:443", policyName: "JP02" },
    { id: 3, remoteHost: "claude.ai:443", policyName: "QUIC-BLOCK" },
    { id: 4, URL: "https://open.spotify.com/", policyName: "DIRECT" },
    { id: 5, remoteHost: "ani.gamer.com.tw:443", policyName: "TW01 Trojan" },
    { id: 6, remoteHost: "notnetflix.com:443", policyName: "REJECT" },
    { id: 7, remoteHost: "example.com:443", policyName: "TW01 Trojan" },
  ] }
  const parsedGroups = parsePolicyGroups(groupsData)
  check("Surge 群組解析", () => parsedGroups.order.length === 2 && parsedGroups.members.get("JP02")?.group === "AI"
    && parsedGroups.groups.get("節點選擇")?.length === 2 && parsePolicyGroups(null).groups.size === 0)
  const busy = resolveSurgeInfo({ mode: "rule" }, groupsData, recentData)
  check("Surge 以最近請求判定節點", () => busy.status === "ok" && busy.info?.node === "TW01 Trojan"
    && busy.info.protocol === "Trojan" && busy.info.policy === "節點選擇" && busy.info.mode === "規則分流")
  const idle = { requests: [{ id: 1, policyName: "DIRECT" }] }
  const chained = resolveSurgeInfo({ mode: "proxy" }, groupsData, idle, { "節點選擇": "JP02", "AI": "節點選擇" })
  check("Surge 無請求時依群組選擇", () => chained.info?.node === "JP02" && chained.info.policy === "節點選擇"
    && chained.info.protocol === "SS" && chained.info.mode === "全域代理")
  const nested = resolveSurgeInfo({ mode: "rule" }, { "AI": groupsData["AI"], "其他": groupsData["節點選擇"] }, idle, { "AI": "其他", "其他": "TW01 Trojan" })
  check("Surge 巢狀群組往下解析", () => nested.info?.node === "TW01 Trojan")
  check("Surge 無選擇資料不猜測", () => resolveSurgeInfo({ mode: "rule" }, groupsData, idle).status === "error"
    && resolveSurgeInfo({ mode: "rule" }, groupsData, idle, { "節點選擇": "節點選擇" }).status === "error")
  check("Surge 直連與空資料", () => resolveSurgeInfo({ mode: "direct" }, null, null).info?.node === "直連出口"
    && resolveSurgeInfo({ mode: "rule" }, {}, []).status === "error")
  const matched = matchServicePolicies(recentData)
  check("Surge 服務策略對照", () => matched.netflix === "TW01 Trojan" && matched.claude === "JP02"
    && matched.spotify === "DIRECT" && matched.bahamut === "TW01 Trojan" && matched.youtube === undefined)
  check("Surge 策略文字", () => policyLabel("DIRECT") === "直連" && policyLabel("REJECT-DROP") === "被規則攔截"
    && policyLabel("TW01") === "經 TW01" && policyLabel(undefined) === "")
  check("Surge 協定辨識", () => normalizeProtocol("Shadowsocks") === "SS" && normalizeProtocol("HTTPS") === "HTTPS"
    && normalizeProtocol("") === "" && protocolFromName("TW01-Reality") === "Reality" && protocolFromName("HTTP Lab") === "")
  check("Surge 設定正規化", () => {
    const fallback = parseSurgeSettings({ key: " abc ", host: "bad host/", port: 70000 })
    const custom = parseSurgeSettings({ key: "k", host: "192.168.1.2", port: 6170 })
    return fallback.key === "abc" && fallback.host === "127.0.0.1" && fallback.port === 6171
      && custom.host === "192.168.1.2" && custom.port === 6170 && parseSurgeSettings(null).key === ""
  })
  check("Surge 金鑰遮罩", () => maskKey("") === "未設定" && maskKey("abcd") === "••••" && maskKey("secret-key") === "se••••ey")

  try {
    await withTimeout(new Promise<never>(() => {}), 15, "測試逾時")
    failures.push("未觸發逾時")
  } catch (error) { check("逾時按期拒絕", () => String(error).includes("測試逾時")) }
  const fast = await withTimeout(Promise.resolve(42), 100)
  check("成功回傳原值", () => fast === 42)
  Script.exit({ passed, failed: failures.length, failures })
}
void run().catch(error => Script.exit({ passed, failed: failures.length + 1, failures: [...failures, String(error)] }))

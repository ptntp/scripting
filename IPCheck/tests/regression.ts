import { Script } from "scripting"
import { canonicalAddress, expandIPv6, formatIPAddress, formatIPLocation, isPublicExitAddress, parseIPInfo, calculateRiskValue } from "../utils/ip"
import { collectGeoRow, sameIP, withTimeout } from "../utils/geo"
import { validIPAddress, parseProxyCheck, assembleLookupResult } from "../utils/lookup"
import { parseIPPure } from "../utils/ippure"
import { normalizeRTCAddress, rtcAddressScope, parseWebRTC, assessWebRTC } from "../utils/webrtc"
import { detectionTime, locationDetails, networkDetails } from "../utils/details"
import { activeRiskFlags, hasKnownRiskFlags, shouldShowRiskScale } from "../utils/flags"
import { hasCoordinates } from "../utils/map"
import { countryCode, detectNAT, flagOf, maskIP, parseTrace, regionOfName, widgetKind } from "../src/net"
import { GLOBAL_LATENCY_URLS, QUIC_TRACE_URLS, TAIWAN_LATENCY_URLS, classifyInterfaces, isHttp3, mergeExit, splitServices } from "../src/diagnose"
import { SERVICES, judgeChatGPT, judgeNetflix, judgeReach, makeService, netflixRegion, parseBahamut, bahamutError, bahamutGeo, setCookiePairs, mergeCookies, cookieCount, parseYoutube,
  regionCode, serviceStateText, toServiceInfo } from "../src/unlock"
import { SERVICE_HOSTS, maskKey, matchServicePolicies, normalizeProtocol, parsePolicyGroups, parseRemoteSnapshot,
  policyLabel, protocolFromName, resolveSurgeInfo } from "../src/surge"
import { applySurge, relabel, testedDirect } from "../src/enrich"
import { normalizeSettings } from "../src/store"
import { largeLayout } from "../src/layout"
import type { Snapshot } from "../src/types"
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
  check("風險標記已知與未知可區分", () => hasKnownRiskFlags(pc) && !hasKnownRiskFlags(null))
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

  // ── 雷達：網路工具 ──
  const trace = parseTrace("fl=1\nip=8.8.8.8\nloc=TW\nhttp=http/3\nbroken\n=x\n")
  check("trace 解析", () => trace.loc === "TW" && trace.http === "http/3" && !("broken" in trace))
  check("HTTP/3 判定", () => isHttp3("http/3") && isHttp3("h3") && !isHttp3("http/2") && !isHttp3(""))
  check("NAT 推估", () => detectNAT("100.72.1.9") === "CGNAT" && detectNAT("192.168.1.20") === "NAT"
    && detectNAT("172.20.0.4") === "NAT" && detectNAT("8.8.8.8") === "公網" && detectNAT("") === "未知" && detectNAT("fe80::1") === "未知")
  check("國碼：代碼、旗幟、地名", () => countryCode("tw") === "TW" && countryCode("🇯🇵 東京 01") === "JP"
    && countryCode("台灣 HiNet") === "TW" && countryCode("台湾-02") === "TW" && countryCode("美國 洛杉磯") === "US")
  check("國碼：節點名稱中的代碼", () => regionOfName("TW 01") === "TW" && regionOfName("IEPL-JP-Tokyo") === "JP"
    && regionOfName("Proxy") === "" && regionOfName("AI") === "" && regionOfName("") === "" && countryCode("TW 01") === "TW")
  check("策略群組 AI 不被當成國碼", () => relabel({ id: "x", name: "x", ok: true, cc: "", policy: "" }, "AI", "", "TW").cc === "")
  check("台灣旗幟正常顯示", () => flagOf("TW") === "🇹🇼" && flagOf("JP") === "🇯🇵" && flagOf("UK") === "🇬🇧" && flagOf("") === "")
  check("IP 遮蔽", () => maskIP("203.0.113.9") === "203.0.*.*" && maskIP("2001:db8::1") === "2001:db8:***" && maskIP("") === "")
  check("小工具版面：標準尺寸", () => widgetKind("systemSmall", { width: 158, height: 158 }) === "small"
    && widgetKind("systemMedium", { width: 338, height: 158 }) === "medium"
    && widgetKind("systemLarge", { width: 338, height: 354 }) === "large"
    && widgetKind("accessoryRectangular", { width: 160, height: 72 }) === "small")
  check("小工具版面：未知尺寸依大小判定", () => widgetKind("systemExtraLargePortrait", { width: 338, height: 547 }) === "large"
    && widgetKind("somethingNew", { width: 338, height: 547 }) === "large"
    && widgetKind(undefined, { width: 338, height: 158 }) === "medium" && widgetKind(undefined, { width: 158, height: 158 }) === "small")

  // ── 雷達：大型小工具縮放 ──
  // 頂欄 50、內容上下留白 20、底部指標約 40（皆乘以 z），加上兩條分隔線。
  const fits = (size: { width: number; height: number }) => {
    const L = largeLayout(size)
    const used = 70 * L.z + 40 * L.z + 1 + L.topH + L.gap + L.serviceH + (L.detailH > 0 ? L.gap + L.detailH : 0)
    return used <= L.winH + 0.5 && L.cw > 0
  }
  const standard = largeLayout({ width: 338, height: 354 })
  check("大型：標準尺寸維持原比例且不顯示詳情", () => standard.z === 1 && standard.detailH === 0 && standard.topH === 98)
  const proMax = largeLayout({ width: 364, height: 382 })
  check("大型：大螢幕略放大", () => proMax.z === 1.08 && proMax.detailH === 0)
  const xl = largeLayout({ width: 377, height: 609 })
  check("特大直式：字級跟寬度放大並填滿高度", () => xl.z === 1.12 && xl.detailRows === 5 && xl.detailZ > 1.1
    && xl.detailH > 200 && xl.winH - (110 * xl.z + 1 + xl.topH + xl.gap * 2 + xl.serviceH + xl.detailH) < 8)
  const tall = largeLayout({ width: 377, height: 900 })
  check("特大直式：太高時詳情卡封頂、其餘給服務網格", () => tall.detailRows === 5 && tall.detailZ === 1.45 && tall.serviceH > 110 * tall.z)
  check("大型：小螢幕縮小不超框", () => largeLayout({ width: 329, height: 345 }).z === 0.97)
  check("各尺寸內容不超出視窗", () => [[338, 354], [364, 382], [377, 609], [377, 900], [329, 345], [715, 354], [364, 760]]
    .every(([width, height]) => fits({ width, height })))

  // ── 雷達：出口與本機網路 ──
  const exitTW = mergeExit(
    { status: "success", query: "203.0.113.9", country: "台湾", countryCode: "TW", regionName: "台湾省 高雄市", city: "高雄", isp: "Chunghwa Telecom", org: "HiNet", as: "AS3462 Data Communication", proxy: false, hosting: false, mobile: true },
    null, { is_mobile: true }, null)
  check("出口：台灣獨立顯示且轉繁體", () => exitTW.country === "台灣" && exitTW.region === "高雄市" && exitTW.city === "高雄" && exitTW.cc === "TW")
  check("出口：行動網路判定", () => exitTW.kind === "行動網路" && exitTW.mobile && exitTW.asn === "AS3462" && exitTW.risk === "低風險" && exitTW.purity === 95)
  const exitDC = mergeExit({ status: "fail", query: "1.1.1.1" }, { ip: "198.51.100.7", country_code: "JP", country: "Japan", city: "Tokyo", connection: { asn: 64500, org: "Example", isp: "ExampleNet" } },
    { is_datacenter: true, is_vpn: true, is_proxy: true }, { org: "AS64500 Example KK" })
  check("出口：限流來源被忽略並合併其餘來源", () => exitDC.ip === "198.51.100.7" && exitDC.cc === "JP" && exitDC.asn === "AS64500" && exitDC.isp === "ExampleNet")
  check("出口：機房與代理降低純淨度", () => exitDC.kind === "機房 IP" && exitDC.proxy && exitDC.hosting && exitDC.purity === 40 && exitDC.risk === "高風險")
  const exitBare = mergeExit(null, null, null, { ip: "198.51.100.8", country: "US", org: "AS1 Foo" })
  check("出口：沒有旗標來源時不當成住宅", () => exitBare.kind === "未知網路" && exitBare.asn === "AS1" && exitBare.org === "Foo")
  check("出口：全部失敗", () => mergeExit(null, null, null, null).ip === "" && mergeExit(null, { success: false, ip: "9.9.9.9" }, null, null).ip === "")
  const wifi = classifyInterfaces({
    lo0: [{ address: "127.0.0.1", family: "IPv4", isInternal: true }],
    en0: [{ address: "fe80::1%en0", family: "IPv6" }, { address: "192.168.1.20", family: "IPv4" }, { address: "2001:b011::5", family: "IPv6" }],
    utun3: [{ address: "10.8.0.2", family: "IPv4" }, { address: "2001:db9::1", family: "IPv6" }],
    pdp_ip0: [{ address: "10.20.30.40", family: "IPv4" }],
  })
  check("介面：Wi-Fi 優先並識別 VPN / IPv6", () => wifi.net === "Wi-Fi" && wifi.ip === "192.168.1.20" && wifi.vpn && wifi.v6)
  const cell = classifyInterfaces({ pdp_ip0: [{ address: "100.72.1.9" }, { address: "fe80::2" }] })
  check("介面：行動網路且連結本地 IPv6 不算", () => cell.net === "行動網路" && !cell.v6 && !cell.vpn)
  check("介面：空清單", () => classifyInterfaces({}).net === "未知網路" && classifyInterfaces({}).ip === "")

  // ── 雷達：解鎖檢測 ──
  check("地區代碼正規化", () => regionCode(" tw ") === "TW" && regionCode("TWN") === "" && regionCode(null) === "")
  check("Netflix 地區路徑", () => netflixRegion("https://www.netflix.com/tw/title/81280792") === "TW"
    && netflixRegion("https://www.netflix.com/title/81280792") === "US" && netflixRegion("https://www.netflix.com/jp-en/title/1") === "JP")
  check("Netflix 判定", () => judgeNetflix({ kind: "region", region: "TW" }, { kind: "error" }).state === "ok"
    && judgeNetflix({ kind: "missing" }, { kind: "region", region: "JP" }).state === "warn"
    && judgeNetflix({ kind: "blocked" }, { kind: "error" }).state === "no"
    && judgeNetflix({ kind: "missing" }, { kind: "missing" }).state === "no"
    && judgeNetflix({ kind: "error" }, { kind: "region", region: "US" }).state === "na")
  check("YouTube Premium 地區", () => parseYoutube(200, '{"countryCode":"TW"}').region === "TW"
    && parseYoutube(200, "Premium is not available in your country").state === "no" && parseYoutube(503, "").state === "na")
  check("ChatGPT 支援地區", () => judgeChatGPT("tw", "ok").state === "ok" && judgeChatGPT("TW", "blocked").state === "warn"
    && judgeChatGPT("HK", "ok").state === "no" && judgeChatGPT("", "ok").state === "no")
  check("動畫瘋可觀看", () => parseBahamut(200, '{"animeSn":37783}').state === "ok" && parseBahamut(200, '{"animeSn":37783}').region === "TW"
    && parseBahamut(200, '{"animeSn":37783}', "HK").region === "HK")
  check("動畫瘋地區限制才算不可用", () => parseBahamut(200, '{"error":{"code":1011,"message":"很抱歉！本節目因版權限制，僅限台灣地區觀看"}}').state === "no"
    && parseBahamut(200, '{"error":{"code":1}}', "JP").state === "no")
  check("動畫瘋其他錯誤不誤判", () => parseBahamut(200, '{"error":{"code":1011}}').state === "na"
    && parseBahamut(200, '{"error":{"message":"裝置驗證失敗"}}', "TW").state === "na"
    && parseBahamut(200, '{"error":{"message":"裝置驗證失敗"}}', "TW").detail === "檢測失敗：裝置驗證失敗"
    && parseBahamut(0, "").state === "na")
  check("Set-Cookie 合併標頭解析", () => setCookiePairs("a=1; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT, b=2; HttpOnly") === "a=1; b=2"
    && setCookiePairs("") === "" && setCookiePairs("nologinuser=abc; domain=.gamer.com.tw") === "nologinuser=abc")
  check("Cookie 合併與計數", () => mergeCookies("a=1; b=2", "b=3", "") === "a=1; b=3" && cookieCount("a=1; b=3") === 2 && cookieCount("") === 0)
  check("動畫瘋失敗附除錯資訊", () => parseBahamut(200, '{"error":{"message":"裝置驗證異常！"}}', "TW", "cookie 0").detail === "檢測失敗：裝置驗證異常！（cookie 0）"
    && parseBahamut(503, "", "", "").detail === "檢測失敗（HTTP 503）")
  check("動畫瘋首頁地區", () => bahamutGeo('<body data-geo="TW" class="x">') === "TW" && bahamutGeo("<body>") === ""
    && bahamutError('{"error":{"message":" 錯誤 "}}') === "錯誤" && bahamutError("oops") === "")
  check("連線檢測判定", () => judgeReach("claude", 403, "TW").state === "ok" && judgeReach("copilot", 451, "").state === "no"
    && judgeReach("grok", 502, "").state === "na" && judgeReach("spotify", 0, "").state === "no")
  const partial = toServiceInfo(makeService("netflix", "warn", "JP", "僅自製影片"), "TW")
  const reach = toServiceInfo(makeService("gemini", "ok", "", "可連線"), "tw")
  const failed = toServiceInfo(makeService("grok", "no", "", "無法連線"), "TW")
  check("快照服務項目", () => partial.ok && partial.cc === "JP" && partial.note === "僅自製影片" && reach.cc === "TW" && !failed.ok && failed.cc === "")
  check("服務狀態文字", () => serviceStateText(partial) === "部分" && serviceStateText(reach) === "可用" && serviceStateText(failed) === "不可用"
    && serviceStateText({ ok: true }) === "可用" && serviceStateText({ ok: false }) === "失敗")
  const all = SERVICES.map(meta => toServiceInfo(makeService(meta.id, "ok", "TW", "")))
  const split = splitServices([...all].reverse())
  check("服務分組 6 + 6 且順序固定", () => split.media.length === 6 && split.ai.length === 6
    && split.media[0].id === "youtube" && split.media[3].id === "bahamut" && split.ai[0].id === "chatgpt" && split.ai[3].id === "copilot")
  const BLOCKED_HOSTS = /(\.cn$|baidu|qq\.com|ipip\.net|3322\.net|miui|vivo|bilibili|deepseek|tiktok|douyin|aliyun|tencent|163\.com|weibo)/i
  check("探測點與服務不含中國來源", () => [...GLOBAL_LATENCY_URLS, ...TAIWAN_LATENCY_URLS, ...QUIC_TRACE_URLS]
    .every(url => !BLOCKED_HOSTS.test(new URL(url).hostname))
    && SERVICES.every(item => !/deepseek|tiktok/i.test(item.id + item.name))
    && Object.values(SERVICE_HOSTS).flat().every(host => !BLOCKED_HOSTS.test(host))
    && SERVICES.every(item => Array.isArray(SERVICE_HOSTS[item.id])))

  // ── 雷達：Surge ──
  const groupsData = {
    "AI": [{ name: "節點選擇", typeDescription: "Select Group" }, { name: "JP02", typeDescription: "Shadowsocks" }],
    "節點選擇": [{ name: "TW01 Trojan", typeDescription: "Trojan" }, { name: "JP02", typeDescription: "Shadowsocks" }],
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
  check("Surge 群組解析", () => parsePolicyGroups(groupsData).members.get("JP02")?.group === "AI" && parsePolicyGroups(null).groups.size === 0)
  const busy = resolveSurgeInfo({ mode: "rule" }, groupsData, recentData)
  check("Surge 以最近請求判定節點", () => busy.status === "ok" && busy.info?.node === "TW01 Trojan"
    && busy.info.protocol === "Trojan" && busy.info.policy === "節點選擇" && busy.info.mode === "規則分流")
  const idle = { requests: [{ id: 1, policyName: "DIRECT" }] }
  const chained = resolveSurgeInfo({ mode: "proxy" }, groupsData, idle, { "節點選擇": "JP02", "AI": "節點選擇" })
  check("Surge 無請求時依群組選擇", () => chained.info?.node === "JP02" && chained.info.protocol === "SS" && chained.info.mode === "全域代理")
  check("Surge 無選擇資料不猜測", () => resolveSurgeInfo({ mode: "rule" }, groupsData, idle).status === "error"
    && resolveSurgeInfo({ mode: "direct" }, null, null).info?.node === "直連出口")
  const matched = matchServicePolicies(recentData)
  check("Surge 服務策略對照", () => matched.netflix === "TW01 Trojan" && matched.claude === "JP02"
    && matched.spotify === "DIRECT" && matched.bahamut === "TW01 Trojan" && matched.youtube === undefined)
  check("Surge 策略文字與協定", () => policyLabel("DIRECT") === "直連" && policyLabel("REJECT-DROP") === "被規則攔截"
    && policyLabel("TW01") === "經 TW01" && normalizeProtocol("Shadowsocks") === "SS" && protocolFromName("TW01-Reality") === "Reality")
  check("Surge 金鑰遮罩", () => maskKey("") === "未設定" && maskKey("abcd") === "••••" && maskKey("secret-key") === "se••••ey")
  check("重新標註：攔截與直連", () => relabel(partial, "REJECT-DROP", "JP", "TW").cc === "攔截" && relabel(partial, "DIRECT", "JP", "TW").cc === "直連")
  check("重新標註：保留服務自己判定的地區", () => relabel(partial, "🇺🇸 US 01", "US", "TW").cc === "JP"
    && relabel({ id: "x", name: "x", ok: true, cc: "", policy: "" }, "🇺🇸 US 01", "SG", "TW").cc === "US"
    && relabel({ id: "x", name: "x", ok: true, cc: "", policy: "" }, "自動選擇", "SG", "TW").cc === "SG")
  check("重新標註：無紀錄時不覆蓋", () => relabel(partial, "", "US", "TW").cc === "JP"
    && relabel({ id: "x", name: "x", ok: true, cc: "TW", policy: "" }, "", "US", "TW").cc === "US")
  const snap: Snapshot = {
    v: 1, ts: Date.now(), src: "self", exit: exitTW,
    local: { net: "Wi-Fi", ip: "192.168.1.20", gw: "", dns: "", area: "", carrier: "", nat: "NAT", vpn: false, v6: true },
    lat: { proxy: 40, local: 9 }, quic: { ok: true, reachable: true }, media: [partial], ai: [reach],
  }
  const applied = applySurge(snap, { mode: "規則分流", policy: "節點選擇", node: "JP02", protocol: "SS" }, { netflix: "JP02", gemini: "DIRECT" })
  check("套用 Surge 狀態", () => applied.surge?.node === "JP02" && applied.media[0].policy === "JP02" && applied.media[0].cc === "JP"
    && applied.ai[0].cc === "直連" && snap.media[0].policy === "" && applySurge(applied, null, null).surge?.node === "JP02")
  const direct = (policies: string[], node = "JPWS"): Snapshot => ({ ...snap, surge: { mode: "規則分流", policy: "JP", node, protocol: "WireGuard" },
    media: policies.map((policy, i) => ({ id: `m${i}`, name: "x", ok: true, cc: "", policy })), ai: [] })
  check("檢測走直連判定", () => testedDirect(direct(["DIRECT", "DIRECT", ""])) && !testedDirect(direct(["DIRECT", "JPWS"]))
    && !testedDirect(direct(["", ""])) && !testedDirect(direct(["DIRECT"], "直連出口")) && !testedDirect({ ...snap, surge: undefined }))
  const remote = parseRemoteSnapshot(JSON.parse(JSON.stringify({ ...snap, src: "surge", exit: { ...exitTW, purity: 180 }, media: [{ id: "netflix", name: "Netflix", ok: true, policy: "串流" }, { bad: 1 }] })))
  check("外部快照驗證", () => remote?.src === "surge" && remote.exit.purity === 100 && remote.media.length === 1 && remote.media[0].cc === ""
    && parseRemoteSnapshot({ ts: 1 }) === null && parseRemoteSnapshot({ exit: {}, local: {}, ts: "x" }) === null && parseRemoteSnapshot(null) === null)
  const settings = normalizeSettings({ refreshMinutes: 2, surgeHost: "bad host/", surgePort: 70000, snapshotURL: " https://x.example/r.json " }, { key: " old ", host: "192.168.1.2", port: 6170 })
  check("設定正規化與沿用舊金鑰", () => settings.refreshMinutes === 15 && settings.surgeKey === "old" && settings.surgeHost === "127.0.0.1"
    && settings.surgePort === 6171 && settings.snapshotURL === "https://x.example/r.json"
    && normalizeSettings({ surgeKey: "new", refreshMinutes: 999 }, { key: "old", host: "10.0.0.2", port: 6170 }).surgeKey === "new"
    && normalizeSettings({ refreshMinutes: 999 }).refreshMinutes === 240
    && normalizeSettings({}, { key: "k", host: "10.0.0.2", port: 6170 }).surgeHost === "10.0.0.2"
    && normalizeSettings(null).surgePort === 6171)
  check("遮蔽設定沿用舊版隱私模式", () => normalizeSettings({}, null, true).maskIP
    && !normalizeSettings({}, null, null).maskIP && !normalizeSettings({ maskIP: false }, null, true).maskIP
    && normalizeSettings({ maskIP: true }, null, false).maskIP)

  try {
    await withTimeout(new Promise<never>(() => {}), 15, "測試逾時")
    failures.push("未觸發逾時")
  } catch (error) { check("逾時按期拒絕", () => String(error).includes("測試逾時")) }
  const fast = await withTimeout(Promise.resolve(42), 100)
  check("成功回傳原值", () => fast === 42)
  Script.exit({ passed, failed: failures.length, failures })
}
void run().catch(error => Script.exit({ passed, failed: failures.length + 1, failures: [...failures, String(error)] }))

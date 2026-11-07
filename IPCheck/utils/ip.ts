// File: utils/ip.ts
// 取得 IP 資訊並計算風險值
import { fetch, Device } from "scripting"
import { toTraditional } from "./s2t"

// ip-api 沒有繁體選項，地名以 zh-CN 取得後再由 toTraditional 轉為繁體。
export const API_URL = "http://ip-api.com/json/?lang=zh-CN"
// 出口 IP 探針（依序嘗試，取第一個有效公網位址）
const EXIT_IP_APIS = [
  "https://api.ipify.org?format=json",  // 首選：ipify，全球 CDN
  "https://icanhazip.com",              // 備用1：Cloudflare，純文本
  "https://checkip.amazonaws.com"       // 備用2：AWS，純文本
]

export interface IPInfo {
  query: string;
  country: string;
  countryCode: string;
  regionName: string;
  city: string;
  isp: string;
  org: string;
  as: string;
  status: string;
  lat: number;
  lon: number;
  asname?: string;
  proxy?: boolean;
  hosting?: boolean;
  mobile?: boolean;
  // 可選欄位保持小工具和現有 IPInfo 呼叫方相容。
  continent?: string;
  continentCode?: string;
  timezone?: string;
  offset?: number;
  zip?: string;
}

export const PRIVACY_MODE_KEY = "ip-detection.privacy-mode"

export function getPrivacyMode(): boolean {
  return Storage.get<boolean>(PRIVACY_MODE_KEY, { shared: true }) ?? true
}

export function setPrivacyMode(enabled: boolean): boolean {
  return Storage.set(PRIVACY_MODE_KEY, enabled, { shared: true })
}

function dottedIPv4ToGroups(value: string): string | null {
  const groups = value.split(".")
  if (groups.length !== 4 || !groups.every(group => /^\d{1,3}$/.test(group) && Number(group) <= 255)) return null
  const [a, b, c, d] = groups.map(Number)
  return `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
}

export function expandIPv6(address: string): string[] | null {
  let source = address.split("%")[0].toLowerCase()
  // RFC 4291 允許 IPv6 尾段寫成點分 IPv4（如 ::ffff:192.0.2.1）。
  if (source.includes(".")) {
    const tail = source.slice(source.lastIndexOf(":") + 1)
    const groups = dottedIPv4ToGroups(tail)
    if (!groups) return null
    source = source.slice(0, source.lastIndexOf(":") + 1) + groups
  }
  const sections = source.split("::")
  if (sections.length > 2) return null

  const left = sections[0] ? sections[0].split(":") : []
  const right = sections.length === 2 && sections[1] ? sections[1].split(":") : []
  const missing = 8 - left.length - right.length
  if (missing < 0 || (sections.length === 2 && missing === 0) || (sections.length === 1 && missing !== 0)) return null

  const groups = sections.length === 2
    ? [...left, ...Array(missing).fill("0"), ...right]
    : left

  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null
  return groups.map((group) => group.padStart(4, "0"))
}

export function canonicalAddress(value: string): string | null {
  const source = value.trim().toLowerCase()
  if (!source || source.includes("%")) return null
  if (!source.includes(":")) {
    const groups = source.split(".")
    return groups.length === 4 && groups.every(group => /^\d{1,3}$/.test(group) && Number(group) <= 255)
      ? groups.map(Number).join(".") : null
  }
  const groups = expandIPv6(source)
  if (!groups) return null
  // IPv4-mapped IPv6 與對應 IPv4 視為同一位址，避免雙堆疊出口被誤判為不同。
  if (groups.slice(0, 5).every(group => group === "0000") && groups[5] === "ffff") {
    const a = parseInt(groups[6], 16), b = parseInt(groups[7], 16)
    return [a >> 8, a & 255, b >> 8, b & 255].join(".")
  }
  return groups.join(":")
}

function sameAddress(a: string, b: string): boolean {
  const key = canonicalAddress(a)
  return key !== null && key === canonicalAddress(b)
}

export function formatIPAddress(address: string | null | undefined, privacyMode = getPrivacyMode()): string {
  if (!address) return "—"
  if (!privacyMode) return address

  const canonical = canonicalAddress(address)
  if (!canonical) return "—"
  if (!canonical.includes(":")) {
    const groups = canonical.split(".")
    return `${groups[0]}.${groups[1]}.x.x`
  }
  const groups = expandIPv6(canonical)!
  return `${groups.slice(0, 4).join(":")}::/64`
}

export function formatIPLocation(
  info: Pick<IPInfo, "country" | "countryCode" | "regionName" | "city"> | null | undefined,
  fallback = "未知位置"
): string {
  if (!info) return fallback

  const code = (info.countryCode || "").toUpperCase()
  // 資料來源可能回傳簡體，先統一轉為繁體再判斷與顯示。
  const country = countryName(code) || toTraditional(info.country || "") || code
  const regionName = toTraditional(info.regionName || "")
  const city = toTraditional(info.city || "")
  const source = `${country} ${regionName} ${city}`.toLowerCase()

  // 台灣獨立顯示為國家：去掉資料來源可能附帶的“中國 / 台灣省 / Province of China”等字樣。
  if (code === "TW" || /台灣|taiwan/.test(source)) {
    const detail = [regionName, city]
      .map(value => value.replace(/^中國\s*/, "").replace(/^台灣(省|地區)\s*/, "").trim())
      .filter((value, index, values) =>
        !!value &&
        !/^(中國|台灣|taiwan|taiwan \(province of china\)|taiwan, province of china)$/i.test(value) &&
        values.indexOf(value) === index
      )
    return ["台灣", ...detail].join(" · ")
  }

  const detail = [regionName, city]
    .filter((value, index, values) =>
      !!value &&
      !/^(香港|香港特別行政區|澳門|澳門特別行政區|hong kong|macao|macau)$/i.test(value) &&
      values.indexOf(value) === index
    )

  let region: string | null = null
  if (code === "HK" || source.includes("香港") || source.includes("hong kong")) {
    region = "香港地區"
  } else if (code === "MO" || source.includes("澳門") || source.includes("macao") || source.includes("macau")) {
    region = "澳門地區"
  }

  if (region) return ["中國", region, ...detail].join(" · ")

  return [country, regionName, city]
    .filter((value, index, values) => !!value && values.indexOf(value) === index)
    .join(" · ") || fallback
}

/** 國家代碼轉繁體中文國名（台灣用語）；代碼無效時回傳空字串。 */
export function countryName(code: string): string {
  if (!/^[A-Z]{2}$/i.test(code)) return ""
  try { return new Intl.DisplayNames(["zh-Hant-TW", "zh-Hant"], { type: "region" }).of(code.toUpperCase()) || "" }
  catch { return "" }
}

const RISK_KEYWORDS = {
  dataCenter: ["資料中心", "數據中心", "Amazon", "Google", "Tencent", "Alibaba", "Cloudflare", "IDC", "DMIT", "Vultr", "DigitalOcean", "Linode", "OVH"],
  homeBroadband: ["電信", "寬頻", "寬帶", "HiNet", "Chunghwa", "Seednet", "So-net", "Kbro", "Comcast", "Verizon", "家庭", "住宅"],
  highRiskCountries: ["俄羅斯", "印度", "烏克蘭"],
  vpnKeywords: ["VPN", "Proxy", "Tunnel", "虛擬", "加速器", "節點"]
};

/**
 * 取得本地活躍的網路介面資訊
 */
function getLocalNetworkInfo(): { hasVPNInterface: boolean } {
  try {
    const interfaces = Device.networkInterfaces();
    const vpnInterfaceKeywords = ["utun", "ppp", "ipsec", "tun", "tap", "wireguard", "wg"];
    let hasVPNInterface = false;

    for (const [name, addresses] of Object.entries(interfaces)) {
      const lowerName = name.toLowerCase();
      // 檢查是否為VPN介面
      if (vpnInterfaceKeywords.some(kw => lowerName.includes(kw))) {
        const hasExternal = addresses.some(addr => !addr.isInternal);
        if (hasExternal) {
          hasVPNInterface = true;
          break;
        }
      }
    }

    return { hasVPNInterface };
  } catch (e) {
    return { hasVPNInterface: false };
  }
}

/** 保守識別可用於出口對照的公網位址；不把本地及文件網段計為公網。 */
export function isPublicExitAddress(value: string): boolean {
  const ip = canonicalAddress(value)
  if (!ip) return false
  if (ip.includes(":")) {
    const groups = ip.split(":").map(group => parseInt(group, 16))
    // RFC 6052 的全球 NAT64 前綴不在通常的 2000::/3 內。
    if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every(group => group === 0)) {
      return isPublicExitAddress([groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join("."))
    }
    return (groups[0] & 0xe000) === 0x2000
      && !(groups[0] === 0x2001 && (groups[1] === 0x0db8 || groups[1] === 0x0002 && groups[2] === 0
        || (groups[1] & 0xfff0) === 0x10 || (groups[1] & 0xfff0) === 0x20))
      && !(groups[0] === 0x3fff && (groups[1] & 0xf000) === 0)
  }
  const [a, b, c, d] = ip.split(".").map(Number)
  return !(a === 0 || a === 10 || a === 127 || a >= 224
    || a === 100 && b >= 64 && b <= 127
    || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31
    || a === 192 && (b === 168 || b === 0 && c === 0 && d !== 9 && d !== 10 || b === 0 && c === 2 || b === 88 && c === 99)
    || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)
    || a === 203 && b === 0 && c === 113)
}

/**
 * 分析ISP型別
 */
function analyzeISP(isp: string, org: string): {
  isDataCenter: boolean;
  isHomeBroadband: boolean;
  isVPNService: boolean;
  confidence: number;
} {
  const ispLower = isp.toLowerCase();
  const orgLower = org.toLowerCase();
  const combined = `${ispLower} ${orgLower}`;

  // 檢測資料中心
  const isDataCenter = RISK_KEYWORDS.dataCenter.some(kw =>
    combined.includes(kw.toLowerCase())
  );

  // 檢測家寬
  const isHomeBroadband = RISK_KEYWORDS.homeBroadband.some(kw =>
    combined.includes(kw.toLowerCase())
  );

  // 檢測VPN服務商
  const isVPNService = RISK_KEYWORDS.vpnKeywords.some(kw =>
    combined.includes(kw.toLowerCase())
  );

  // 計算置信度
  let confidence = 50;
  if (isDataCenter) confidence += 30;
  if (isVPNService) confidence += 20;
  if (isHomeBroadband) confidence -= 20;

  return { isDataCenter, isHomeBroadband, isVPNService, confidence: Math.max(0, Math.min(100, confidence)) };
}

/**
 * 綜合判斷VPN/代理狀態（含多源IP對比）
 */
export function detectVPNStatus(
  ipInfo: IPInfo,
  probeIP: string | null
): {
  isVPN: boolean;
  isProxy: boolean;
  proxyType: string;
  confidence: number;
} {
  const localInfo = getLocalNetworkInfo();
  const ispAnalysis = analyzeISP(ipInfo.isp, ipInfo.org);
  const intlIP = ipInfo.query;

  let vpnScore = 0;
  let isProxy = false;
  let proxyType = "";

  // 1. 多源IP對比（核心檢測）
  if (probeIP && !sameAddress(probeIP, intlIP)) {
    // IP不一致 = 存在分流代理/旁路由
    isProxy = true;
    proxyType = "分流代理";
    vpnScore += 50;
  }

  // 2. VPN介面檢測 (+40分)
  if (localInfo.hasVPNInterface) {
    vpnScore += 40;
  }

  // 3. ISP分析 (+30分如果是資料中心/VPN服務)
  if (ispAnalysis.isVPNService) {
    vpnScore += 35;
  } else if (ispAnalysis.isDataCenter) {
    vpnScore += 25;
  }

  // 4. 如果明確是家寬，降低VPN可能性 (-20分)
  if (ispAnalysis.isHomeBroadband && !ispAnalysis.isDataCenter) {
    vpnScore -= 20;
  }

  // 計算最終置信度
  let confidence = ispAnalysis.confidence;
  if (vpnScore > 0) {
    confidence = Math.min(95, confidence + vpnScore);
  } else {
    confidence = Math.max(5, confidence);
  }

  // 判定閾值：>= 60分認為是VPN/代理
  const isVPN = vpnScore >= 60;

  // 如果IP分流且VPN介面檢測成功，認為是VPN
  if (isProxy && localInfo.hasVPNInterface) {
    return {
      isVPN: true,
      isProxy: true,
      proxyType: "VPN",
      confidence: Math.min(95, confidence)
    };
  }

  return {
    isVPN,
    isProxy,
    proxyType,
    confidence
  };
}

export function parseIPInfo(value: unknown, address?: string): IPInfo | null {
  if (!value || typeof value !== "object") return null
  const data = value as Record<string, unknown>
  const query = typeof data.query === "string" ? data.query.trim() : ""
  if (data.status !== "success" || !canonicalAddress(query) || address && !sameAddress(query, address)) return null
  // ip-api 以 zh-CN 回傳，文字欄位統一轉為繁體。
  const text = (key: string) => typeof data[key] === "string" ? toTraditional((data[key] as string).trim()) : ""
  const flag = (key: string) => typeof data[key] === "boolean" ? data[key] as boolean : undefined
  const coordinate = (key: string) => typeof data[key] === "number" && Number.isFinite(data[key]) ? data[key] as number : NaN
  return {
    query, status: "success", country: text("country"), countryCode: text("countryCode"),
    regionName: text("regionName"), city: text("city"), isp: text("isp"), org: text("org"),
    as: text("as"), lat: coordinate("lat"), lon: coordinate("lon"), asname: text("asname"),
    proxy: flag("proxy"), hosting: flag("hosting"), mobile: flag("mobile"),
    continent: text("continent"), continentCode: text("continentCode"), timezone: text("timezone"),
    offset: coordinate("offset") || (data.offset === 0 ? 0 : undefined), zip: text("zip"),
  }
}

export async function fetchIPInfo(address?: string): Promise<IPInfo | null> {
  try {
    const fields = "status,query,country,countryCode,regionName,city,lat,lon,isp,org,as,asname,mobile,proxy,hosting,continent,continentCode,timezone,offset,zip";
    const url = address
      ? `http://ip-api.com/json/${encodeURIComponent(address)}?fields=${fields}&lang=zh-CN`
      : `${API_URL}&fields=${fields}`;
    const response = await fetch(url, { timeout: 6 });
    if (!response.ok) return null;
    return parseIPInfo(await response.json(), address);
  } catch (error) {
    console.error("取得 IP 資料失敗：", error);
    return null;
  }
}

/**
 * 取得獨立出口IP（用於與 ip-api 對比檢測分流代理/旁路由）
 * 依序嘗試 ipify / icanhazip / AWS，每個 2 秒逾時
 */
export async function fetchExitProbe(): Promise<{ address: string; source: string } | null> {
  for (const apiUrl of EXIT_IP_APIS) {
    try {
      const response = await fetch(apiUrl, { timeout: 2 });

      if (response.ok) {
        const text = await response.text().catch(() => "");
        // 嘗試解析JSON或直接回傳IP
        let ip = text.trim();
        try {
          const data = JSON.parse(text);
          ip = typeof data.ip === "string" ? data.ip : "";
        } catch { /* 純文本介面直接回傳位址 */ }
        if (isPublicExitAddress(ip)) {
          return { address: ip, source: new URL(apiUrl).hostname };
        }
      }
    } catch (error) {
      continue;
    }
  }

  console.log("[IP檢測] 出口探針暫不可用");
  return null;
}

export async function fetchProbeIP(): Promise<string | null> {
  return (await fetchExitProbe())?.address ?? null;
}

export function calculateRiskValue(ipInfo: IPInfo, probeIP: string | null = null) {
  let riskValue = 0;

  // 使用新的VPN檢測方法（含IP對比）
  const vpnStatus = detectVPNStatus(ipInfo, probeIP);

  // ISP分析
  const ispAnalysis = analyzeISP(ipInfo.isp, ipInfo.org);

  // 風險計算
  if (vpnStatus.isVPN || vpnStatus.isProxy) {
    riskValue += vpnStatus.confidence * 0.5;
  }

  if (ispAnalysis.isDataCenter) {
    riskValue += 20;
  }

  if (ispAnalysis.isHomeBroadband) {
    riskValue -= 15;
  }

  if (RISK_KEYWORDS.highRiskCountries.some(kw => ipInfo.country.includes(kw))) {
    riskValue += 25;
  }

  riskValue = Math.max(0, Math.min(100, riskValue));

  // 狀態顯示文本
  let vpnStatusText = "未連線";
  if (vpnStatus.isVPN) {
    vpnStatusText = "已連線";
  } else if (vpnStatus.isProxy) {
    vpnStatusText = vpnStatus.proxyType;
  }

  return {
    riskValue: Math.round(riskValue),
    isHomeBroadband: ispAnalysis.isHomeBroadband ? "家寬" : "非家寬",
    vpnStatus: vpnStatusText
  };
}

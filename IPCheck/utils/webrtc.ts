import { canonicalAddress, isPublicExitAddress } from "./ip"
import { sameIP, withTimeout } from "./geo"
import type { ExitObservation } from "./geo"

export type CandidateType = "host" | "srflx" | "prflx" | "relay"
export interface RTCCandidate {
  address: string
  type: CandidateType
  protocol: string
  scope: "public" | "local" | "mdns"
}
export interface WebRTCReport {
  status: "complete" | "timeout" | "unsupported" | "error" | "cancelled"
  candidates: RTCCandidate[]
  errors: number[]
  note: string
}
export interface WebRTCAssessment {
  label: string
  tone: "neutral" | "ok" | "warning"
  note: string
}

// 自有空白頁面，無遠端網頁腳本；僅向公共 STUN 服務傳送位址探測。
const PROBE_HTML = "<!doctype html><html><head><meta charset='utf-8'></head><body></body></html>"
const COLLECT_ICE = String.raw`
  const Peer = window.RTCPeerConnection || window.webkitRTCPeerConnection;
  if (!Peer) return JSON.stringify({ status: 'unsupported', candidates: [], errors: [], note: '目前 WebView 未提供 WebRTC 介面。' });
  if (!window.isSecureContext) return JSON.stringify({ status: 'error', candidates: [], errors: [], note: 'WebRTC 需要安全瀏覽器上下文。' });
  const candidates = [], errors = [];
  let pc, channel, timer, finish;
  let status = 'timeout';
  const finished = new Promise(resolve => { finish = resolve; });
  timer = setTimeout(() => finish(), 6500);
  function add(candidate) {
    if (candidate && typeof candidate.candidate === 'string') candidates.push(candidate.candidate);
  }
  try {
    pc = new Peer({
      iceServers: [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }],
      iceTransportPolicy: 'all', iceCandidatePoolSize: 0,
    });
    pc.onicecandidate = event => {
      if (event.candidate) add(event.candidate);
      else { status = 'complete'; finish(); }
    };
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === 'complete') { status = 'complete'; finish(); }
    };
    pc.onicecandidateerror = event => {
      if (Number.isFinite(event.errorCode)) errors.push(event.errorCode);
    };
    // 只建立資料通道，不請求麥克風或攝像頭，也不連線遠端 Peer。
    channel = pc.createDataChannel('ip-check');
    Promise.resolve().then(async () => {
      await pc.setLocalDescription(await pc.createOffer());
    }).catch(() => { status = 'error'; finish(); });
    await finished;
    // 某些 WebKit 版本只在 SDP 中提供部分候選；不把 c= 或 raddr 當候選。
    for (const line of (pc.localDescription?.sdp || '').split(/\r?\n/)) {
      if (line.startsWith('a=candidate:')) candidates.push(line.slice(2));
    }
    return JSON.stringify({ status, candidates, errors });
  } catch (_) {
    return JSON.stringify({ status: 'error', candidates, errors });
  } finally {
    clearTimeout(timer);
    if (pc) {
      pc.onicecandidate = null;
      pc.onicegatheringstatechange = null;
      pc.onicecandidateerror = null;
    }
    try { if (channel) channel.close(); } catch (_) {}
    try { if (pc) pc.close(); } catch (_) {}
  }
`

/** 候選位址歸一化；IPv4-mapped IPv6 與其 IPv4 表示視為同一位址。 */
export function normalizeRTCAddress(value: string): string | null {
  let ip = value.trim().toLowerCase()
  if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.slice(1, -1)
  return canonicalAddress(ip)
}

export function rtcAddressScope(address: string): RTCCandidate["scope"] | null {
  if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.local$/i.test(address)) return "mdns"
  const ip = normalizeRTCAddress(address)
  if (!ip) return null
  return isPublicExitAddress(ip) ? "public" : "local"
}

export function parseWebRTC(raw: unknown): WebRTCReport {
  const data = raw as { status?: unknown; candidates?: unknown; errors?: unknown; note?: unknown } | null
  const status = data?.status
  const valid = status === "complete" || status === "timeout" || status === "unsupported" || status === "error"
  const result: WebRTCReport = {
    status: valid ? status : "error", candidates: [], errors: [],
    note: typeof data?.note === "string" ? data.note : "",
  }
  if (Array.isArray(data?.errors)) result.errors = [...new Set<number>(data.errors.filter(
    (code): code is number => typeof code === "number" && Number.isFinite(code)))].slice(0, 8)
  if (!Array.isArray(data?.candidates)) return result
  for (const line of data.candidates) {
    if (typeof line !== "string") continue
    const fields = line.trim().replace(/^a=/, "").split(/\s+/)
    const typeIndex = fields.indexOf("typ", 6)
    // RFC 8445: fields[4] 是主 connection-address；raddr 只代表關聯位址，不能混入主候選。
    if (!fields[0]?.startsWith("candidate:") || typeIndex < 6) continue
    const type = fields[typeIndex + 1]
    if (type !== "host" && type !== "srflx" && type !== "prflx" && type !== "relay") continue
    const original = fields[4]?.toLowerCase() || ""
    const scope = rtcAddressScope(original)
    if (!scope) continue
    const address = scope === "mdns" ? original : normalizeRTCAddress(original)!
    const protocol = fields[2]?.toLowerCase()
    if (protocol !== "udp" && protocol !== "tcp") continue
    if (!result.candidates.some(c => c.address === address && c.type === type && c.protocol === protocol)) {
      result.candidates.push({ address, type, protocol, scope })
    }
  }
  return result
}

export async function fetchWebRTC(isCurrent = () => true): Promise<WebRTCReport> {
  const empty = (status: WebRTCReport["status"], note = ""): WebRTCReport => ({ status, candidates: [], errors: [], note })
  if (!isCurrent()) return empty("cancelled")
  let web: WebViewController | null = null
  let cancellation: ReturnType<typeof setInterval> | undefined
  try {
    web = new WebViewController({ ephemeral: true, settings: { inactiveSchedulingPolicy: "none" } })
    const controller = web
    cancellation = setInterval(() => {
      try { if (!isCurrent() && !controller.isDisposed) controller.dispose() } catch { /* 請求已結束 */ }
    }, 150)
    const loaded = await withTimeout(web.loadHTML(PROBE_HTML, "https://webrtc.scripting.invalid/"), 3000)
    if (!isCurrent()) return empty("cancelled")
    if (!loaded) return empty("error", "瀏覽器檢測頁面載入失敗，請重新檢測。")
    const raw = await withTimeout(web.callAsyncJavaScript<string>(COLLECT_ICE), 8000)
    return isCurrent() ? parseWebRTC(JSON.parse(raw)) : empty("cancelled")
  } catch (error) {
    if (!isCurrent()) return empty("cancelled")
    const timedOut = /逾時|timeout/i.test(String(error))
    return empty(timedOut ? "timeout" : "error", timedOut ? "WebRTC 檢測逾時，請重試。" : "瀏覽器檢測失敗，請重新檢測。")
  } finally {
    if (cancellation !== undefined) clearInterval(cancellation)
    try { web?.dispose() } catch { /* 已釋放 */ }
  }
}

export function assessWebRTC(report: WebRTCReport | null, exits: ExitObservation[], loading = false, manual = false): WebRTCAssessment {
  const result = (label: string, tone: WebRTCAssessment["tone"], note: string) => ({ label, tone, note })
  if (manual) return result("不適用", "neutral", "WebRTC 檢測本裝置的網路；手動 IP 查詢不執行裝置檢測。")
  if (loading) return result("檢測中", "neutral", "正在通過瀏覽器採集 WebRTC 位址…")
  if (!report || report.status === "error") return result("檢測失敗", "warning", report?.note || "WebRTC 本次未能完成，請重新檢測。")
  if (report.status === "unsupported") return result("環境不支援", "neutral", "目前瀏覽器未提供 WebRTC 介面，無法判斷是否洩露。")
  if (report.status === "cancelled") return result("已取消", "neutral", "本次檢測已取消。")
  const publicCandidates = report.candidates.filter(c => c.scope === "public" && c.type !== "relay")
  const partial = report.status === "timeout" ? "採集逾時，結果不完整。" : report.errors.length ? "部分 STUN 請求失敗。" : ""
  if (!publicCandidates.length) {
    const hidden = report.candidates.some(c => c.scope === "mdns")
    const local = report.candidates.some(c => c.scope === "local")
    if (report.status === "timeout") return result("檢測逾時", "warning", report.note || "未取得公網候選，不能據此判定無洩露。")
    return result("未獲得公網候選", "neutral", (hidden ? "本地位址已由 mDNS 隱藏。" : local ? "僅取得本地或保留位址。" : "瀏覽器未回傳可用公網位址。")
      + "可能受瀏覽器策略或 STUN 連通性影響，不能據此判定無洩露。")
  }
  const normalized = exits.map(e => ({ ...e, address: normalizeRTCAddress(e.ip) })).filter(e => e.address)
  const withoutReference = publicCandidates.filter(c => !normalized.some(e => e.address!.includes(":") === c.address.includes(":")))
  const different = publicCandidates.filter(c => !withoutReference.includes(c)
    && !normalized.some(e => sameIP(e.address!, c.address)))
  if (different.length) return result("存在不同公網位址", "warning", partial + "WebRTC 出現 HTTP 出口之外的同協議公網位址，存在洩露可能；也可能與分流或多出口有關。")
  const primary = normalized[0]
  const differsFromPrimary = primary && publicCandidates.some(c => c.address.includes(":") === primary.address!.includes(":")
    && !sameIP(c.address, primary.address!))
  if (differsFromPrimary) return result("與主出口不同", "warning", partial + `WebRTC 位址與 ${primary.source} 不同，但與其他 HTTP 出口一致；請結合分流規則核對。`)
  if (withoutReference.length) return result("缺少同協議對照", "neutral", partial + "已獲得公網候選，但缺少對應 IPv4 / IPv6 的 HTTP 出口，暫無法判斷。")
  if (report.status === "timeout" || report.errors.length) return result("已採集·結果不完整", "neutral", partial + "已取得的公網候選與 HTTP 出口一致；未覆蓋的路徑仍無法判斷。")
  return result("與已觀測出口一致", "ok", "本次 WebRTC 公網位址與已觀測 HTTP 出口一致，未發現額外公網位址。結果僅代表目前內嵌瀏覽器和網路。")
}

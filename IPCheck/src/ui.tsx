// 小工具 UI：沿用「網路診斷雷達」的排版（兩欄卡片 + 服務網格 + 底部指標條），
// 深色模式保留暗灰配色，淺色模式切換為淺底和深色文字。
import { Circle, HStack, Image, Path, Rectangle, Script, Spacer, Text, VStack, VirtualNode, Widget, ZStack, modifiers } from "scripting"
import type { ServiceInfo, Snapshot } from "./types"
import { agoLabel, flagOf, maskIP, regionOfName, widgetKind } from "./net"
import { testedDirect } from "./enrich"
import type { Settings } from "./store"
import { serviceStateText } from "./unlock"
import { largeLayout } from "./layout"
import type { LargeLayout } from "./layout"

export type Size = { width: number; height: number }

// 執行時支援 light/dark 動態樣式；當前 Scripting TypeScript 定義仍把這些屬性標成 ShapeStyle，
// 因此在這個邊界收窄型別檢查，保留原樣式物件傳給執行時解析。
const adaptive = (light: string, dark: string): any => ({ light, dark })

const C = {
  bg: adaptive("#F1F2F6", "#2B2B2F"),
  // 大型視窗：比全域性底色略亮一檔，和外框形成「窗臺 + 窗面」的層次
  window: adaptive("#FAFAFC", "#2F2F36"),
  card: adaptive("#FFFFFF", "#35353A"),
  soft: adaptive("#EEF0F5", "#3E3E45"),
  line: adaptive("rgba(60,60,67,0.16)", "rgba(255,255,255,0.07)"),
  text: adaptive("#1C1C1E", "#F5F5F7"),
  sub: adaptive("#5D5D66", "#A6A6AE"),
  dim: adaptive("#82828A", "#7B7B84"),
  green: adaptive("#16803C", "#32D74B"),
  amber: adaptive("#A15C00", "#FF9F0A"),
  red: adaptive("#D72638", "#FF453A"),
  blue: adaptive("#0066CC", "#0A84FF"),
  purple: adaptive("#7C3AED", "#BF5AF2"),
  teal: adaptive("#007E8A", "#40CBE0"),
  orange: adaptive("#A15C00", "#FF9F0A"),
  pink: adaptive("#D81B60", "#FF375F"),
  iconSurface: adaptive("rgba(60,60,67,0.08)", "rgba(255,255,255,0.06)"),
  subtleSurface: adaptive("rgba(60,60,67,0.07)", "rgba(255,255,255,0.08)"),
  blueTint: adaptive("rgba(0,102,204,0.10)", "rgba(10,132,255,0.16)"),
  greenTint: adaptive("rgba(22,128,60,0.10)", "rgba(50,215,75,0.16)"),
  redTint: adaptive("rgba(215,38,56,0.10)", "rgba(255,69,58,0.16)"),
  ringTrack: adaptive("rgba(60,60,67,0.16)", "rgba(255,255,255,0.14)"),
  footer: adaptive("rgba(60,60,67,0.04)", "rgba(0,0,0,0.16)"),
} as const

const WEEKDAYS = ["週日", "週一", "週二", "週三", "週四", "週五", "週六"]

/* ------------------------------------------------------------------ */
/* 資料工具                                                          */
/* ------------------------------------------------------------------ */

function purityColor(score: number): any {
  if (score >= 75) return C.green
  if (score >= 45) return C.amber
  return C.red
}

function riskColor(risk: string): any {
  if (risk === "低風險") return C.green
  if (risk === "中風險") return C.amber
  if (risk === "高風險") return C.red
  return C.dim
}

function latencyColor(ms: number): any {
  if (!ms) return C.red
  if (ms <= 220) return C.green
  if (ms <= 500) return C.amber
  return C.red
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

function clockLabel(ts: number): string {
  const date = new Date(ts || Date.now())
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

function dateLabel(ts: number): string {
  const date = new Date(ts || Date.now())
  return `${pad2(date.getMonth() + 1)}/${pad2(date.getDate())} ${WEEKDAYS[date.getDay()]}`
}

/** 歸屬地格式為「TW Taipei」：開頭國碼交給旗幟呈現，其餘取最後兩段。 */
function shortArea(area: string): string {
  const parts = String(area || "").split(/\s+/).filter(Boolean)
  if (parts.length && /^[A-Z]{2}$/.test(parts[0])) parts.shift()
  const unique: string[] = []
  for (const part of parts) {
    if (!unique.includes(part)) unique.push(part)
  }
  return unique.slice(-2).join(" ")
}

function localFlagCode(area: string): string {
  const first = String(area || "").split(/\s+/)[0] || ""
  return /^[A-Z]{2}$/.test(first) ? first : ""
}

function isWifi(net: string): boolean {
  return /^wi-?fi/i.test(String(net || ""))
}

/** Surge 快照的延遲是「代理／直連」；本機自測分不出策略，實際量的是「國際／台灣」端點。 */
function latencyNames(snapshot: Snapshot): { proxy: string; local: string } {
  return snapshot.src === "surge" ? { proxy: "代理", local: "直連" } : { proxy: "國際", local: "台灣" }
}

function shortIsp(value: string): string {
  const text = String(value || "").trim()
  if (!text) return "未知"
  if (/oracle/i.test(text)) return "Oracle"
  if (/chunghwa|hinet/i.test(text)) return "中華電信"
  if (/taiwan mobile|taiwanmobile/i.test(text)) return "台灣大哥大"
  if (/far ?eas ?tone|fetnet/i.test(text)) return "遠傳電信"
  if (/kddi|ntt/i.test(text)) return "KDDI"
  if (/softbank/i.test(text)) return "SoftBank"
  if (/amazon|aws/i.test(text)) return "AWS"
  if (/google/i.test(text)) return "Google"
  if (/cloudflare/i.test(text)) return "Cloudflare"
  if (/digitalocean/i.test(text)) return "DigitalOcean"
  if (/microsoft|azure/i.test(text)) return "Azure"
  const first = text.split(/[,，]/)[0].split(/\s{2,}/)[0]
  return first.length > 12 ? `${first.slice(0, 11)}…` : first
}

function shortProtocol(protocol: string): string {
  const text = String(protocol || "").trim()
  if (!text) return "—"
  return text.length > 10 ? `${text.slice(0, 9)}…` : text
}

/** 節點名裡常帶國旗/圖示，有的字型渲染成方框，顯示前清一下 */
function prettyName(value: string): string {
  const raw = String(value || "").trim()
  if (!raw) return ""
  const stripped = raw
    .replace(/[\u{1F000}-\u{1FAFF}]/gu, "")
    .replace(/[\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, "")
    .replace(/[\u{E0020}-\u{E007F}]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
  return stripped || raw
}

/* ------------------------------------------------------------------ */
/* 原子元件                                                            */
/* ------------------------------------------------------------------ */

function Tag({ text, color = C.sub, bg = C.subtleSurface, z = 1 }: { text: string; color?: any; bg?: any; z?: number }): VirtualNode {
  return (
    <Text
      font={6.5 * z}
      fontWeight="semibold"
      foregroundStyle={color}
      lineLimit={1}
      padding={{ horizontal: 4 * z, vertical: 1 * z }}
      widgetBackground={{ style: bg, shape: { type: "rect", cornerRadius: 3 * z } }}
    >
      {text}
    </Text>
  )
}

function IconBox({
  symbol,
  color = C.blue,
  size = 22,
  radius = 7,
  bg = C.soft,
  children,
}: {
  symbol?: string
  color?: any
  size?: number
  radius?: number
  bg?: any
  children?: VirtualNode | VirtualNode[]
}): VirtualNode {
  // 注意：Scripting 的 JSX 對自閉合標籤會傳 children = []，空陣列是真值，必須判長度
  const hasChildren = Array.isArray(children) ? children.length > 0 : Boolean(children)

  return (
    <VStack
      alignment="center"
      frame={{ width: size, height: size }}
      widgetBackground={{ style: bg, shape: { type: "rect", cornerRadius: radius } }}
    >
      {hasChildren ? children : <Image systemName={symbol || "circle"} font={size * 0.5} foregroundStyle={color} />}
    </VStack>
  )
}

/* Surge 官方圖示：App Store 取 512px 原圖，去掉白底、裁到圖形邊界，存兩份：
   專案 assets/（隨腳本同步）+ App Group（小工具直讀）。缺失時退回下面手繪的 SurgeMark。 */
declare const FileManager: any
declare const UIImage: any

let logoCache: any = null
let logoTried = false

/** 本地資源圖片必須經 UIImage.fromFile 才能渲染（直接 Image filePath 在小工具裡不出圖）。小圖片快取一次即可。 */
function surgeLogo(): any {
  if (logoTried) return logoCache
  logoTried = true

  const candidates: string[] = []
  try {
    candidates.push(Path.join(Script.directory, "assets", "surge-logo.png"))
  } catch (_) {}
  try {
    candidates.push(`${FileManager.appGroupDocumentsDirectory}/surge-logo.png`)
  } catch (_) {}

  for (const path of candidates) {
    try {
      if (!FileManager.existsSync(path)) continue
      const image = UIImage.fromFile(path)
      if (image) {
        logoCache = image
        break
      }
    } catch (_) {}
  }

  return logoCache
}

/** 旗幟直接用系統 emoji，不需要另外的圖檔。 */
function CountryFlag({ value, size }: { value: string; size: number }): VirtualNode {
  const flag = flagOf(value)
  if (!flag) return <VStack frame={{ width: 0, height: 0 }} />
  return (
    <Text font={Math.max(7, size * 1.05)} lineLimit={1}>
      {flag}
    </Text>
  )
}

function SurgeBadge({ size = 26 }: { size?: number }): VirtualNode {
  const logo = surgeLogo()
  const inner = size * 0.7

  return (
    <IconBox size={size} radius={size * 0.31} bg={C.iconSurface}>
      {logo ? (
        <Image image={logo} resizable frame={{ width: inner, height: inner }} widgetAccentedRenderingMode="fullColor" />
      ) : (
        <SurgeMark size={size * 0.7} />
      )}
    </IconBox>
  )
}

/* 手繪兼底版本：五根膠囊豎條 */
type SurgeBar = { top: number; height: number; colors: string[] }

const SURGE_BARS: SurgeBar[] = [
  { top: 0.55, height: 0.32, colors: ["#9C8CF0", "#C77DE0", "#D98BC8"] },
  { top: 0.38, height: 0.55, colors: ["#5D9EF2", "#A87FE8", "#EDA062"] },
  { top: 0.09, height: 0.83, colors: ["#4E9CF0", "#9A85EE", "#F4A55C"] },
  { top: 0.0, height: 0.65, colors: ["#4E9CF0", "#A47EEA", "#CE7FCB"] },
  { top: 0.24, height: 0.33, colors: ["#6FAAF5", "#B47FE4"] },
]

function SurgeMark({ size }: { size: number }): VirtualNode {
  const barWidth = size * 0.1
  const gap = size * 0.093

  return (
    <HStack alignment="center" spacing={gap} frame={{ height: size }}>
      {SURGE_BARS.map((bar, index) => {
        const bottom = Math.max(0, 1 - bar.top - bar.height)
        return (
          <VStack key={`surge-col-${index}`} spacing={0} frame={{ width: barWidth }}>
            <VStack frame={{ width: barWidth, height: size * bar.top }} />
            <VStack
              frame={{ width: barWidth, height: size * bar.height }}
              background={{
                style: { colors: bar.colors, startPoint: "top", endPoint: "bottom" } as any,
                shape: { type: "capsule", style: "continuous" },
              }}
            />
            <VStack frame={{ width: barWidth, height: size * bottom }} />
          </VStack>
        )
      })}
    </HStack>
  )
}

function Card({
  children,
  width,
  height,
  spacing = 0,
  pad = 8,
  radius = 12,
}: {
  children: VirtualNode | VirtualNode[]
  width: number
  height: number
  spacing?: number
  pad?: number
  radius?: number
}): VirtualNode {
  return (
    <VStack
      alignment="leading"
      spacing={spacing}
      padding={pad}
      frame={{ width, height, alignment: "topLeading" }}
      widgetBackground={{ style: C.card, shape: { type: "rect", cornerRadius: radius } }}
      border={{ style: C.line, width: 0.5 }}
    >
      {children}
    </VStack>
  )
}

function Mini({ label, value, color = C.text, width, z = 1 }: { label: string; value: string; color?: any; width: number; z?: number }): VirtualNode {
  return (
    <VStack alignment="leading" spacing={0.5 * z} frame={{ width, alignment: "leading" }}>
      <Text font={5.8 * z} foregroundStyle={C.dim} lineLimit={1}>
        {label}
      </Text>
      <Text font={7.6 * z} fontWeight="semibold" foregroundStyle={color} lineLimit={1} minScaleFactor={0.7}>
        {value}
      </Text>
    </VStack>
  )
}

function FooterCell({
  symbol,
  color,
  label,
  value,
  width,
  z = 1,
}: {
  symbol: string
  color: any
  label: string
  value: string
  width: number
  z?: number
}): VirtualNode {
  return (
    <HStack spacing={4 * z} frame={{ width, alignment: "leading" }}>
      <IconBox symbol={symbol} color={color} size={16 * z} radius={5 * z} />
      <VStack alignment="leading" spacing={0.5 * z} frame={{ maxWidth: "infinity", alignment: "leading" }}>
        <Text font={5.8 * z} foregroundStyle={C.dim} lineLimit={1}>
          {label}
        </Text>
        <Text font={7.6 * z} fontWeight="semibold" foregroundStyle={C.text} lineLimit={1} minScaleFactor={0.65}>
          {value}
        </Text>
      </VStack>
    </HStack>
  )
}

/* 品牌徽標 */
const BRAND: Record<string, { text?: string; symbol?: string; color: any }> = {
  netflix: { text: "N", color: "#FF3B30" },
  disney: { text: "D+", color: "#5E8BFF" },
  spotify: { symbol: "waveform", color: C.green },
  bahamut: { text: "巴", color: "#11AAC1" },
  youtube: { symbol: "play.rectangle.fill", color: "#FF453A" },
  prime: { text: "P", color: C.blue },
  chatgpt: { symbol: "circle.hexagongrid.fill", color: "#30D5A0" },
  claude: { text: "A", color: "#E0805C" },
  gemini: { symbol: "sparkles", color: "#8E7CFF" },
  copilot: { symbol: "sparkle", color: "#3A8DDE" },
  grok: { text: "X", color: C.text },
  perplexity: { symbol: "magnifyingglass", color: C.teal },
}

/* 品牌圖示：各服務官網 favicon（128px 原圖，存 assets/logos/），用 UIImage 讀入後快取 */
let brandTried: Record<string, boolean> = {}
let brandCache: Record<string, any> = {}

function brandLogo(id: string): any {
  if (brandTried[id]) return brandCache[id]
  brandTried[id] = true

  try {
    const path = Path.join(Script.directory, "assets", "logos", `${id}.png`)
    if (FileManager.existsSync(path)) {
      const image = UIImage.fromFile(path)
      if (image) brandCache[id] = image
    }
  } catch (_) {}

  return brandCache[id]
}

function BrandBadge({ id, size }: { id: string; size: number }): VirtualNode {
  const brand = BRAND[id] || { text: id.slice(0, 1).toUpperCase(), color: C.sub }
  const logo = brandLogo(id)

  return (
    <VStack
      alignment="center"
      frame={{ width: size, height: size }}
      widgetBackground={{ style: C.iconSurface, shape: { type: "rect", cornerRadius: size * 0.28 } }}
    >
      {logo ? (
        <Image image={logo} resizable frame={{ width: size * 0.74, height: size * 0.74 }} widgetAccentedRenderingMode="fullColor" />
      ) : brand.symbol ? (
        <Image systemName={brand.symbol} font={size * 0.5} foregroundStyle={brand.color} />
      ) : (
        <Text font={size * (id === "disney" ? 0.42 : 0.53)} fontWeight="bold" foregroundStyle={brand.color}>
          {brand.text || ""}
        </Text>
      )}
    </VStack>
  )
}

function ServiceItem({ service, width, height, z = 1 }: { service: ServiceInfo; width: number; height: number; z?: number }): VirtualNode {
  const ok = service.ok
  const color = service.state === "warn" ? C.amber : service.state === "soon" ? C.blue
    : service.state === "na" ? C.dim : ok ? C.green : C.red

  return (
    <HStack spacing={5 * z} frame={{ width, height, alignment: "leading" }}>
      <BrandBadge id={service.id} size={height - 6 * z} />
      <VStack alignment="leading" spacing={0.5 * z} frame={{ maxWidth: "infinity", alignment: "leading" }}>
        <Text font={8 * z} fontWeight="semibold" foregroundStyle={C.text} lineLimit={1} minScaleFactor={0.7}>
          {service.name}
        </Text>
        <HStack spacing={2 * z}>
          <Text font={6.2 * z} fontWeight="bold" foregroundStyle={color}>
            {service.state === "na" ? "?" : ok ? "✓" : "✕"}
          </Text>
          <Text font={6.2 * z} foregroundStyle={C.sub} lineLimit={1} minScaleFactor={0.7}>
            {`${service.cc || "--"} ${serviceStateText(service)}`}
          </Text>
        </HStack>
      </VStack>
    </HStack>
  )
}

function ServiceCard({
  title,
  symbol,
  color,
  items,
  width,
  height,
  z = 1,
}: {
  title: string
  symbol: string
  color: any
  items: ServiceInfo[]
  width: number
  height: number
  z?: number
}): VirtualNode {
  const pad = 8 * z
  const inner = width - pad * 2
  const okCount = items.filter((item) => item.ok).length
  const per = items.length > 6 ? 6 : items.length || 6
  const colWidth = (inner - 6 * z) / 2
  const rows: ServiceInfo[][] = []
  for (let i = 0; i < per; i += 2) rows.push(items.slice(i, i + 2))
  // 卡片比基本高度高時，把多出的空間平均給每一列。
  const itemHeight = Math.max(24 * z, (height - pad * 2 - 16 * z - 2 * z * (rows.length - 1)) / Math.max(1, rows.length))

  return (
    <Card width={width} height={height} spacing={4 * z} pad={pad} radius={12 * z}>
      <HStack spacing={3 * z} frame={{ width: inner, height: 12 * z }}>
        <Image systemName={symbol} font={8 * z} foregroundStyle={color} />
        <Text font={8.6 * z} fontWeight="semibold" foregroundStyle={C.text} lineLimit={1}>
          {title}
        </Text>
        <Spacer />
        <Tag z={z} text={`${okCount}/${items.length}`} color={okCount === items.length ? C.green : C.amber} />
      </HStack>

      <VStack alignment="leading" spacing={2 * z} frame={{ width: inner, alignment: "topLeading" }}>
        {rows.map((row, index) => (
          <HStack key={`row-${index}`} spacing={6 * z} frame={{ width: inner, height: itemHeight, alignment: "leading" }}>
            {row.map((service) => (
              <ServiceItem key={service.id} service={service} width={colWidth} height={Math.min(itemHeight, 34 * z)} z={z} />
            ))}
          </HStack>
        ))}
      </VStack>
    </Card>
  )
}

/* ------------------------------------------------------------------ */
/* 主檢視                                                              */
/* ------------------------------------------------------------------ */

export function RadarView({
  snapshot,
  settings,
  family,
  size,
}: {
  snapshot: Snapshot | null
  settings: Settings
  family: string
  size: Size
}): VirtualNode {
  if (!snapshot) {
    return (
      <VStack
        alignment="center"
        spacing={8}
        modifiers={modifiers()
          .widgetBackground(C.bg)
          .frame({ maxWidth: "infinity", maxHeight: "infinity" })}
      >
        <Image systemName="wifi.exclamationmark" font={22} foregroundStyle={C.amber} />
        <Text font={11} foregroundStyle={C.sub}>
          還沒有診斷資料
        </Text>
        <Text font={9} foregroundStyle={C.dim}>
          點開腳本執行一次即可
        </Text>
      </VStack>
    )
  }

  // 尺寸名稱不認得時依實際大小選版面（例如直式特大尺寸會用大型版面並多出一張出口詳情）。
  const kind = widgetKind(family, size)
  if (kind === "small") return <SmallCard snapshot={snapshot} settings={settings} size={size} />
  if (kind === "medium") return <MediumCard snapshot={snapshot} settings={settings} size={size} />

  return <LargeCard snapshot={snapshot} settings={settings} size={size} />
}

function LargeCard({ snapshot, settings, size }: { snapshot: Snapshot; settings: Settings; size: Size }): VirtualNode {
  // 版面依實際大小等比縮放：大型在大螢幕會略放大，直式特大多出的高度交給出口詳情卡。
  const L = largeLayout(size)
  const z = L.z
  const WIN_R = 16 * z     // 外窗圓角（外層 ~24 − 外框 8，同心收斂）
  const PAD = L.pad        // 視窗內左右留白
  const gap = L.gap
  const winW = L.winW
  const winH = L.winH
  const cw = L.cw
  const halfWidth = L.half
  const inner = halfWidth - 16 * z

  const exit = snapshot.exit
  const local = snapshot.local
  const masked = settings.maskIP || snapshot.masked === true
  const ipText = masked ? maskIP(exit.ip) : exit.ip
  const modeLabel = snapshot.surge?.mode || "預設規則"

  const carrierText = /^[\w.-]+\.[a-z]{2,}$/i.test(local.carrier) ? "" : local.carrier
  const localName = carrierText || local.net
  const localSub = shortArea(local.area) || (local.ip ? (masked ? maskIP(local.ip) : local.ip) : "未取得位址")
  const names = latencyNames(snapshot)
  const connected = local.net !== "未知網路"
  const proxyOk = Boolean(exit.ip)
  // 有 Surge 節點時卡片顯示節點：旗幟取自節點名稱，副標顯示策略群組，避免和直連出口的業者、國旗混在一起。
  const node = snapshot.surge?.node || ""
  const nodeFlag = node ? regionOfName(node) : exit.cc || exit.country
  const nodeSub = node && snapshot.surge?.policy ? `策略 ${prettyName(snapshot.surge.policy)}` : shortIsp(exit.isp)
  const direct = testedDirect(snapshot)
  const proxyTag = direct ? "檢測走直連" : proxyOk ? "連線正常" : "無出口"
  const proxyTone = direct ? C.amber : proxyOk ? C.green : C.red

  const miniWidth = (inner - 6 * z) / 2
  const ring = Math.max(0, Math.min(100, exit.purity))
  const ringSize = 30 * z
  const footerWidth = (cw - 12 * z) / 4

  return (
    <VStack
      alignment="leading"
      spacing={0}
      modifiers={modifiers()
        .padding(L.frame)
        .frame({ maxWidth: "infinity", maxHeight: "infinity", alignment: "topLeading" })
        .widgetBackground(C.bg)}
    >
      <VStack
        alignment="leading"
        spacing={0}
        frame={{ width: winW, height: winH, alignment: "topLeading" }}
        widgetBackground={{ style: C.window, shape: { type: "rect", cornerRadius: WIN_R } }}
        border={{ style: C.line, width: 0.5 }}
        clipShape={{ type: "rect", cornerRadius: WIN_R }}
      >
      {/* 頂欄 */}
      <VStack alignment="leading" spacing={0} padding={{ horizontal: PAD, vertical: 9 * z }} frame={{ maxWidth: "infinity" }}>
        <HStack spacing={6 * z} frame={{ width: cw, height: 32 * z }}>
          <IconBox symbol="waveform.path.ecg" color={C.blue} size={28 * z} radius={8 * z} bg={C.blueTint} />
          <VStack alignment="leading" spacing={1.5 * z}>
            <HStack spacing={4 * z}>
              <Text font={12 * z} fontWeight="bold" foregroundStyle={C.text} lineLimit={1}>
                網路診斷雷達
              </Text>
              <Tag z={z} text="PRO" color={C.blue} bg={C.blueTint} />
            </HStack>
            <Text font={6.6 * z} foregroundStyle={C.dim} lineLimit={1}>
              {snapshot.src === "surge" ? "Surge · 全面網路狀態檢測" : "Scripting · 全面網路狀態檢測"}
            </Text>
          </VStack>

          <Spacer />

          {/* 狀態簇：策略 | 時間，靠右成組，和左側標題構成「視窗標題欄」 */}
          <HStack spacing={7 * z}>
            <HStack spacing={3 * z}>
              <Image systemName="scope" font={9 * z} foregroundStyle={C.dim} />
              <VStack alignment="leading" spacing={1 * z}>
                <Text font={6 * z} foregroundStyle={C.dim} lineLimit={1}>
                  出站模式
                </Text>
                <Text font={7.6 * z} fontWeight="semibold" foregroundStyle={C.text} lineLimit={1} minScaleFactor={0.7}>
                  {modeLabel}
                </Text>
              </VStack>
            </HStack>

            <Rectangle frame={{ width: 0.5, height: 22 * z }} foregroundStyle={C.line} />

            <VStack alignment="trailing" spacing={1 * z}>
              <Text font={11.5 * z} fontWeight="bold" fontDesign="monospaced" foregroundStyle={C.text} lineLimit={1}>
                {clockLabel(snapshot.ts)}
              </Text>
              <Text font={6.2 * z} foregroundStyle={C.dim} lineLimit={1}>
                {dateLabel(snapshot.ts)}
              </Text>
            </VStack>
          </HStack>
        </HStack>
      </VStack>

      <Rectangle frame={{ maxWidth: "infinity", height: 0.5 }} foregroundStyle={C.line} />

      {/* 左：本機網路卡；右：代理卡 */}
      <VStack alignment="leading" spacing={gap} padding={{ horizontal: PAD, vertical: 10 * z }} frame={{ maxWidth: "infinity" }}>
        <HStack spacing={gap} frame={{ width: cw, height: L.topH, alignment: "topLeading" }}>
          <Card width={halfWidth} height={L.topH} spacing={5 * z} pad={8 * z} radius={12 * z}>
            <HStack spacing={3 * z} frame={{ width: inner, height: 12 * z }}>
              <Image systemName="wifi" font={8 * z} foregroundStyle={C.blue} />
              <Text font={8.4 * z} fontWeight="semibold" foregroundStyle={C.text} lineLimit={1}>
                本機網路
              </Text>
              <Spacer />
              <Tag z={z} text={connected ? "已連線" : "離線"} color={connected ? C.green : C.red} bg={connected ? C.greenTint : C.redTint} />
            </HStack>

            <HStack spacing={6 * z} frame={{ width: inner, height: 28 * z, alignment: "leading" }}>
              <IconBox
                symbol={isWifi(local.net) ? "wifi" : "antenna.radiowaves.left.and.right"}
                color={C.blue}
                size={26 * z}
                radius={8 * z}
                bg={C.blueTint}
              />
              <VStack alignment="leading" spacing={1.5 * z} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                <Text font={8.6 * z} fontWeight="semibold" foregroundStyle={C.text} lineLimit={1} minScaleFactor={0.7}>
                  {localName}
                </Text>
                <HStack spacing={2 * z}>
                  <CountryFlag value={localFlagCode(local.area)} size={7 * z} />
                  <Text font={6.4 * z} foregroundStyle={C.sub} lineLimit={1} minScaleFactor={0.7}>
                    {localSub}
                  </Text>
                </HStack>
              </VStack>
            </HStack>

            <HStack spacing={6 * z} frame={{ width: inner, height: 13 * z }}>
              <Mini z={z} label="閘道" value={local.gw || "—"} width={miniWidth} color={local.gw ? C.text : C.dim} />
              <Mini z={z} label={`${names.local}延遲`} value={snapshot.lat.local ? `${snapshot.lat.local}ms` : "逾時"} width={miniWidth} color={latencyColor(snapshot.lat.local)} />
            </HStack>
            <HStack spacing={6 * z} frame={{ width: inner, height: 13 * z }}>
              <Mini
                z={z}
                label="IPv4 / IPv6"
                value={`✓ / ${local.v6 ? "✓" : "✕"}`}
                width={miniWidth}
                color={local.v6 ? C.green : C.sub}
              />
              <Mini z={z} label="DNS" value={local.dns || "系統"} width={miniWidth} />
            </HStack>
          </Card>

          <Card width={halfWidth} height={L.topH} spacing={5 * z} pad={8 * z} radius={12 * z}>
            <HStack spacing={3 * z} frame={{ width: inner, height: 12 * z }}>
              <Image systemName="point.3.connected.trianglepath.dotted" font={8 * z} foregroundStyle={C.purple} />
              <Text font={8.4 * z} fontWeight="semibold" foregroundStyle={C.text} lineLimit={1}>
                目前代理
              </Text>
              <Spacer />
              <Tag
                z={z}
                text={proxyTag}
                color={proxyTone}
                bg={direct ? C.subtleSurface : proxyOk ? C.greenTint : C.redTint}
              />
            </HStack>

            <HStack spacing={5 * z} frame={{ width: inner, height: 30 * z, alignment: "leading" }}>
              <SurgeBadge size={26 * z} />
              <VStack alignment="leading" spacing={1 * z} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                <HStack spacing={2 * z}>
                  <CountryFlag value={nodeFlag} size={7 * z} />
                  <Text font={8.4 * z} fontWeight="semibold" foregroundStyle={C.text} lineLimit={1} minScaleFactor={0.6}>
                    {prettyName(node || exit.city || exit.country) || "未識別"}
                  </Text>
                </HStack>
                <Text font={6.4 * z} foregroundStyle={C.sub} lineLimit={1} minScaleFactor={0.7}>
                  {nodeSub}
                </Text>
              </VStack>

              <ZStack frame={{ width: ringSize, height: ringSize }}>
                <Circle stroke={{ shapeStyle: C.ringTrack as any, strokeStyle: { lineWidth: 3 * z } }} frame={{ width: ringSize, height: ringSize }} />
                <Circle
                  trim={{ from: 0, to: ring / 100 }}
                  stroke={{ shapeStyle: purityColor(ring), strokeStyle: { lineWidth: 3 * z } }}
                  frame={{ width: ringSize, height: ringSize }}
                  rotationEffect={-90}
                />
                <VStack alignment="center" spacing={0}>
                  <Text font={8.6 * z} fontWeight="bold" foregroundStyle={purityColor(ring)}>
                    {String(ring)}
                  </Text>
                  <Text font={4.6 * z} foregroundStyle={C.dim}>
                    純淨
                  </Text>
                </VStack>
              </ZStack>
            </HStack>

            <HStack spacing={6 * z} frame={{ width: inner, height: 13 * z }}>
              <Mini z={z} label={`${names.proxy}延遲`} value={snapshot.lat.proxy ? `${snapshot.lat.proxy}ms` : "逾時"} width={miniWidth} color={latencyColor(snapshot.lat.proxy)} />
              <Mini z={z} label="NAT" value={local.nat || "—"} width={miniWidth} color={local.nat === "NAT" || local.nat === "公網" ? C.green : C.amber} />
            </HStack>
            <HStack spacing={6 * z} frame={{ width: inner, height: 13 * z }}>
              <Mini
                z={z}
                label="HTTP/3 QUIC"
                value={snapshot.quic.ok ? "✓ 可用" : snapshot.quic.reachable ? "✕ 未使用" : "無回應"}
                width={miniWidth}
                color={snapshot.quic.ok ? C.green : C.amber}
              />
              <Mini z={z} label="協定" value={shortProtocol(snapshot.surge?.protocol || "")} width={miniWidth} color={snapshot.surge?.protocol ? C.teal : C.dim} />
            </HStack>
          </Card>
        </HStack>

      {/* 服務網格 */}
        <HStack spacing={gap} frame={{ width: cw, height: L.serviceH, alignment: "topLeading" }}>
          <ServiceCard z={z} title="串流解鎖" symbol="play.tv.fill" color={C.blue} items={snapshot.media} width={halfWidth} height={L.serviceH} />
          <ServiceCard z={z} title="AI 解鎖檢測" symbol="sparkles" color={C.purple} items={snapshot.ai} width={halfWidth} height={L.serviceH} />
        </HStack>

        {L.detailH > 0 ? <ExitDetailCard snapshot={snapshot} ipText={ipText} width={cw} layout={L} /> : null}
      </VStack>

      <Spacer />

      <Rectangle frame={{ maxWidth: "infinity", height: 0.5 }} foregroundStyle={C.line} />

      {/* 底部指標 */}
      <HStack
        spacing={4 * z}
        frame={{ width: winW, height: 26 * z, alignment: "leading" }}
        padding={{ horizontal: PAD, vertical: 7 * z }}
        widgetBackground={{ style: C.footer, shape: { type: "rect", cornerRadii: { topLeading: 0, topTrailing: 0, bottomLeading: WIN_R, bottomTrailing: WIN_R } } }}
      >
          <FooterCell z={z} symbol="server.rack" color={C.blue} label="ISP／業者" value={shortIsp(exit.isp || exit.org)} width={footerWidth} />
          <FooterCell z={z} symbol="building.2.fill" color={C.amber} label="屬性類型" value={exit.kind || "未知"} width={footerWidth} />
          <FooterCell z={z} symbol="checkmark.shield.fill" color={purityColor(ring)} label="純淨評分" value={`${ring} 分`} width={footerWidth} />
          <FooterCell z={z} symbol="exclamationmark.shield.fill" color={riskColor(exit.risk)} label="風險等級" value={exit.risk || "未知"} width={footerWidth} />
      </HStack>
      </VStack>
    </VStack>
  )
}

function DetailCell({ label, value, width, color = C.text, mono = false, z = 1 }: {
  label: string; value: string; width: number; color?: any; mono?: boolean; z?: number
}): VirtualNode {
  return (
    <VStack alignment="leading" spacing={1 * z} frame={{ width, alignment: "leading" }}>
      <Text font={6.2 * z} foregroundStyle={C.dim} lineLimit={1}>
        {label}
      </Text>
      <Text
        font={9 * z}
        fontWeight="semibold"
        fontDesign={mono ? "monospaced" : undefined}
        foregroundStyle={color}
        lineLimit={1}
        minScaleFactor={0.6}
      >
        {value || "—"}
      </Text>
    </VStack>
  )
}

/** 直式特大等較高的尺寸才會出現：列出大型版面放不下的出口資訊，列高與字級隨卡片高度放大。 */
function ExitDetailCard({ snapshot, ipText, width, layout }: {
  snapshot: Snapshot; ipText: string; width: number; layout: LargeLayout
}): VirtualNode {
  const z = layout.z
  const tz = z * layout.detailZ
  const exit = snapshot.exit
  const inner = width - 16 * z
  const cell = (inner - 8 * z) / 2
  const usable = (items: ServiceInfo[]) => `${items.filter((item) => item.ok).length}/${items.length}`
  const rows: { key: string; left: VirtualNode; right: VirtualNode }[] = [
    {
      key: "ip",
      left: <DetailCell z={tz} label="出口 IP" value={ipText || "未識別"} width={cell} mono />,
      right: <DetailCell z={tz} label="位置" value={[exit.country || exit.cc, exit.region, exit.city]
        .filter((part, index, list) => Boolean(part) && list.indexOf(part) === index).join(" · ")} width={cell} />,
    },
    {
      key: "net",
      left: <DetailCell z={tz} label="ISP" value={exit.isp || exit.org} width={cell} />,
      right: <DetailCell z={tz} label="ASN" value={exit.asn} width={cell} mono />,
    },
    {
      key: "risk",
      left: <DetailCell z={tz} label="屬性類型" value={exit.kind} width={cell} />,
      right: <DetailCell z={tz} label="純淨度／風險" value={`${exit.purity} 分 · ${exit.risk}`} width={cell} color={riskColor(exit.risk)} />,
    },
    {
      key: "surge",
      left: <DetailCell z={tz} label="目前節點" value={prettyName(snapshot.surge?.node || "")} width={cell} />,
      right: <DetailCell z={tz} label="策略群組" value={prettyName(snapshot.surge?.policy || "")} width={cell} />,
    },
    {
      key: "sum",
      left: <DetailCell z={tz} label="解鎖摘要" value={`串流 ${usable(snapshot.media)} · AI ${usable(snapshot.ai)}`} width={cell} />,
      right: <DetailCell z={tz} label="資料來源" value={`${snapshot.src === "surge" ? "Surge 快照" : "本機自測"} · ${agoLabel(snapshot.ts)}`} width={cell} />,
    },
  ]

  return (
    <Card width={width} height={layout.detailH} spacing={5 * z} pad={8 * z} radius={12 * z}>
      <HStack spacing={3 * z} frame={{ width: inner, height: 12 * z }}>
        <Image systemName="globe.asia.australia.fill" font={8 * z} foregroundStyle={C.teal} />
        <Text font={8.4 * z} fontWeight="semibold" foregroundStyle={C.text} lineLimit={1}>
          出口詳情
        </Text>
        <Spacer />
        <CountryFlag value={exit.cc || exit.country} size={8 * z} />
      </HStack>
      <VStack alignment="leading" spacing={0} frame={{ width: inner, alignment: "topLeading" }}>
        {rows.slice(0, layout.detailRows).map((row) => (
          <HStack key={row.key} spacing={8 * z} frame={{ width: inner, height: layout.detailRowH, alignment: "leading" }}>
            {row.left}
            {row.right}
          </HStack>
        ))}
      </VStack>
    </Card>
  )
}

function MediumCard({ snapshot, settings, size }: { snapshot: Snapshot; settings: Settings; size: Size }): VirtualNode {
  const pad = 13
  const cw = size.width - pad * 2
  const exit = snapshot.exit
  const local = snapshot.local
  const masked = settings.maskIP || snapshot.masked === true
  const ipText = masked ? maskIP(exit.ip) : exit.ip
  const metricWidth = (cw - 12) / 3

  return (
    <VStack
      alignment="leading"
      spacing={0}
      modifiers={modifiers()
        .padding({ horizontal: pad, vertical: 11 })
        .frame({ maxWidth: "infinity", maxHeight: "infinity", alignment: "topLeading" })
        .widgetBackground(C.bg)}
    >
      <HStack spacing={5} frame={{ width: cw, height: 20 }}>
        <IconBox symbol="waveform.path.ecg" color={C.blue} size={18} radius={6} bg={C.blueTint} />
        <Text font={11.5} fontWeight="bold" foregroundStyle={C.text}>
          網路診斷雷達
        </Text>
        <Tag text={snapshot.surge?.mode || "預設規則"} color={C.sub} />
        <Spacer />
        <Text font={8} foregroundStyle={C.dim}>
          {clockLabel(snapshot.ts)}
        </Text>
      </HStack>

      <Spacer />

      <HStack spacing={5} frame={{ width: cw, height: 22 }}>
        <CountryFlag value={exit.cc || exit.country} size={14} />
        <Text font={10.5} fontWeight="semibold" foregroundStyle={C.text} lineLimit={1}>
          {[exit.country || exit.region, exit.city].filter(Boolean).join(" · ") || "未知地區"}
        </Text>
        <Spacer />
        <Tag text={exit.risk} color={riskColor(exit.risk)} bg={C.subtleSurface} />
        <Text font={12} fontWeight="bold" foregroundStyle={purityColor(exit.purity)}>
          {String(exit.purity)}
        </Text>
      </HStack>

      <HStack spacing={5} frame={{ width: cw, height: 18 }}>
        <Text font={12} fontWeight="bold" fontDesign="monospaced" foregroundStyle={C.text} lineLimit={1} minScaleFactor={0.6}>
          {ipText || "出口未識別"}
        </Text>
        <Spacer />
        <Text font={7.5} foregroundStyle={C.dim} lineLimit={1}>
          {[local.net, shortArea(local.area)].filter(Boolean).join(" · ")}
        </Text>
      </HStack>

      <Spacer />

      <HStack spacing={6} frame={{ width: cw, height: 34 }}>
        <VStack
          alignment="leading"
          spacing={1}
          padding={{ horizontal: 7, vertical: 5 }}
          frame={{ width: metricWidth, height: 34, alignment: "leading" }}
          widgetBackground={{ style: C.card, shape: { type: "rect", cornerRadius: 9 } }}
        >
          <Text font={6.4} foregroundStyle={C.dim}>
            {`${latencyNames(snapshot).proxy}延遲`}
          </Text>
          <Text font={11.5} fontWeight="bold" foregroundStyle={latencyColor(snapshot.lat.proxy)} lineLimit={1} minScaleFactor={0.7}>
            {snapshot.lat.proxy ? `${snapshot.lat.proxy}ms` : "逾時"}
          </Text>
        </VStack>
        <VStack
          alignment="leading"
          spacing={1}
          padding={{ horizontal: 7, vertical: 5 }}
          frame={{ width: metricWidth, height: 34, alignment: "leading" }}
          widgetBackground={{ style: C.card, shape: { type: "rect", cornerRadius: 9 } }}
        >
          <Text font={6.4} foregroundStyle={C.dim}>
            {`${latencyNames(snapshot).local}延遲`}
          </Text>
          <Text font={11.5} fontWeight="bold" foregroundStyle={latencyColor(snapshot.lat.local)} lineLimit={1} minScaleFactor={0.7}>
            {snapshot.lat.local ? `${snapshot.lat.local}ms` : "逾時"}
          </Text>
        </VStack>
        <VStack
          alignment="leading"
          spacing={1}
          padding={{ horizontal: 7, vertical: 5 }}
          frame={{ width: metricWidth, height: 34, alignment: "leading" }}
          widgetBackground={{ style: C.card, shape: { type: "rect", cornerRadius: 9 } }}
        >
          <Text font={6.4} foregroundStyle={C.dim}>
            QUIC
          </Text>
          <Text font={11.5} fontWeight="bold" foregroundStyle={snapshot.quic.ok ? C.green : C.red} lineLimit={1}>
            {snapshot.quic.ok ? "✓ 可用" : "✕ 未用"}
          </Text>
        </VStack>
      </HStack>

      <Spacer />

      <HStack spacing={4} frame={{ width: cw, height: 12 }}>
        <Text font={7.5} foregroundStyle={C.sub} lineLimit={1}>
          {shortIsp(exit.isp)}
        </Text>
        <Spacer />
        <Text font={7.5} foregroundStyle={C.dim}>
          串流 {snapshot.media.filter((item) => item.ok).length}/{snapshot.media.length}
        </Text>
        <Text font={7.5} foregroundStyle={C.dim}>
          AI {snapshot.ai.filter((item) => item.ok).length}/{snapshot.ai.length}
        </Text>
      </HStack>
    </VStack>
  )
}

function SmallCard({ snapshot, settings, size }: { snapshot: Snapshot; settings: Settings; size: Size }): VirtualNode {
  const exit = snapshot.exit
  const masked = settings.maskIP || snapshot.masked === true
  const ipText = masked ? maskIP(exit.ip) : exit.ip
  const mediaOk = snapshot.media.filter((item) => item.ok).length
  const aiOk = snapshot.ai.filter((item) => item.ok).length

  return (
    <VStack
      alignment="leading"
      spacing={0}
      modifiers={modifiers()
        .padding({ horizontal: 12, vertical: 11 })
        .frame({ maxWidth: "infinity", maxHeight: "infinity", alignment: "topLeading" })
        .widgetBackground(C.bg)}
    >
      <VStack alignment="leading" spacing={6} frame={{ maxWidth: "infinity", alignment: "leading" }}>
        <HStack spacing={4} frame={{ maxWidth: "infinity", height: 14 }}>
          <IconBox symbol="waveform.path.ecg" color={C.blue} size={14} radius={4} bg={C.blueTint} />
          <Text font={9.5} fontWeight="bold" foregroundStyle={C.text} lineLimit={1}>
            網路雷達
          </Text>
          <Spacer />
          <Text font={7} foregroundStyle={C.dim} lineLimit={1}>
            {agoLabel(snapshot.ts)}
          </Text>
        </HStack>

        <HStack spacing={4} frame={{ maxWidth: "infinity", height: 20 }}>
          <CountryFlag value={exit.cc || exit.country} size={13} />
          <Text font={15} fontWeight="bold" foregroundStyle={purityColor(exit.purity)}>
            {String(exit.purity)}
          </Text>
          <Spacer />
          <Tag text={exit.risk} color={riskColor(exit.risk)} bg={C.subtleSurface} />
        </HStack>

        <Text
          font={9.5}
          fontWeight="semibold"
          fontDesign="monospaced"
          foregroundStyle={C.text}
          lineLimit={1}
          minScaleFactor={0.5}
          frame={{ maxWidth: "infinity", alignment: "leading" }}
        >
          {ipText || "未識別"}
        </Text>
      </VStack>

      <Spacer />

      <VStack alignment="leading" spacing={3} frame={{ maxWidth: "infinity", alignment: "leading" }}>
        <HStack spacing={4} frame={{ maxWidth: "infinity", height: 13 }}>
          <Text font={9} fontWeight="medium" foregroundStyle={latencyColor(snapshot.lat.proxy)} lineLimit={1} minScaleFactor={0.6}>
            {latencyNames(snapshot).proxy} {snapshot.lat.proxy || "—"}ms
          </Text>
          <Spacer />
          <Text font={9} fontWeight="medium" foregroundStyle={latencyColor(snapshot.lat.local)} lineLimit={1} minScaleFactor={0.6}>
            {latencyNames(snapshot).local} {snapshot.lat.local || "—"}ms
          </Text>
        </HStack>

        <HStack spacing={6} frame={{ maxWidth: "infinity", height: 13 }}>
          <Text font={8} foregroundStyle={C.dim} lineLimit={1}>
            串流 {mediaOk}/{snapshot.media.length}
          </Text>
          <Text font={8} foregroundStyle={C.dim} lineLimit={1}>
            AI {aiOk}/{snapshot.ai.length}
          </Text>
          <Spacer />
          <Text font={8} foregroundStyle={C.dim} lineLimit={1}>
            QUIC {snapshot.quic.ok ? "✓" : "✕"}
          </Text>
        </HStack>
      </VStack>
    </VStack>
  )
}

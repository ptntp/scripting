// 大型小工具版面計算：依實際顯示大小等比縮放，並把多出來的高度分配給各區。
// 純函式，方便離線測試。

/** 大型小工具（338×354pt）扣掉外框後的視窗寬度，以及基本內容需要的高度。 */
export const BASE_WINDOW_WIDTH = 322
export const BASE_CONTENT_HEIGHT = 330
const FRAME = 8
const MIN_ZOOM = 0.9
const MAX_ZOOM = 1.6

export type LargeLayout = {
  /** 字級、圖示、間距的縮放倍率 */
  z: number
  frame: number
  winW: number
  winH: number
  pad: number
  gap: number
  /** 視窗內容寬度與半欄寬度 */
  cw: number
  half: number
  topH: number
  serviceH: number
  /** 出口詳情卡高度；0 代表放不下而不顯示 */
  detailH: number
  /** 出口詳情卡顯示幾列 */
  detailRows: number
  /** 出口詳情每列高度 */
  detailRowH: number
  /** 出口詳情內文字的額外放大倍率（在 z 之上） */
  detailZ: number
}

const DETAIL_ROWS = 5

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function largeLayout(size: { width: number; height: number }): LargeLayout {
  const winW = Math.max(1, size.width - FRAME * 2)
  const winH = Math.max(1, size.height - FRAME * 2)
  // 寬度決定字級上限（避免文字被擠到縮小），高度不足時再往下縮。
  const z = Math.round(clamp(Math.min(winW / BASE_WINDOW_WIDTH, winH / BASE_CONTENT_HEIGHT), MIN_ZOOM, MAX_ZOOM) * 100) / 100
  const pad = 12 * z
  const gap = 7 * z
  const cw = winW - pad * 2
  const half = (cw - gap) / 2
  let topH = 98 * z
  let serviceH = 110 * z

  // 直式特大等較高的尺寸：多出的高度先給出口詳情卡，太高時再把剩餘的給服務網格。
  const spare = winH - BASE_CONTENT_HEIGHT * z
  let detailH = spare >= 62 * z ? spare - gap : 0
  const detailChrome = (8 * 2 + 12 + 5) * z
  const maxDetailH = detailChrome + DETAIL_ROWS * 42 * z
  if (detailH > maxDetailH) {
    serviceH += detailH - maxDetailH
    detailH = maxDetailH
  }

  let detailRows = 0
  let detailRowH = 0
  let detailZ = 1
  if (detailH > 0) {
    const usable = detailH - detailChrome
    detailRows = clamp(Math.floor(usable / (27 * z)), 1, DETAIL_ROWS)
    detailRowH = usable / detailRows
    detailZ = Math.round(clamp(detailRowH / (27 * z), 1, 1.45) * 100) / 100
  }

  return { z, frame: FRAME, winW, winH, pad, gap, cw, half, topH, serviceH, detailH, detailRows, detailRowH, detailZ }
}

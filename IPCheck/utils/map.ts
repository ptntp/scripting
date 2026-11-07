import type { IPInfo } from "./ip"

export function hasCoordinates(info: IPInfo | null | undefined): info is IPInfo {
  if (!info) return false
  const { lat, lon } = info
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return false
  return true
}

export function regionSpanForFamily(family?: string): {
  latitudeDelta: number
  longitudeDelta: number
} {
  switch (family) {
    case "systemSmall":
    case "accessoryCircular":
      return { latitudeDelta: 0.45, longitudeDelta: 0.55 }
    case "systemMedium":
    case "accessoryRectangular":
      return { latitudeDelta: 0.34, longitudeDelta: 0.44 }
    default:
      return { latitudeDelta: 0.24, longitudeDelta: 0.32 }
  }
}

export function approximateRadiusMeters(info: IPInfo): number {
  if (info.city) return 3500
  if (info.regionName) return 12000
  return 25000
}

export async function takeIPMapSnapshot(options: {
  lat: number
  lon: number
  width: number
  height: number
  family?: string
  appearance?: "light" | "dark"
}): Promise<{
  image: any
  size: { width: number; height: number }
  point: (coordinate: { latitude: number; longitude: number }) => { x: number; y: number }
} | null> {
  const width = Math.max(64, Math.round(options.width))
  const height = Math.max(48, Math.round(options.height))
  const span = regionSpanForFamily(options.family)
  // 定位座標始終作為地圖快照的中心點；地圖檢視本身再由元件佈局移動到 (3/4, 1/2)。
  const center = {
    latitude: options.lat,
    longitude: options.lon,
  }

  try {
    const common = {
      region: {
        center,
        span,
      },
      size: { width, height },
      appearance: options.appearance,
    }

    try {
      const snap = await MapSnapshotter.take({
        ...common,
        mapStyle: {
          style: "standard",
          showsTraffic: false,
          pointsOfInterest: "excludingAll",
        },
      })
      if (snap?.image) return snap
    } catch (primaryError) {
      console.error("[IP檢測] 簡潔地圖快照失敗，嘗試預設樣式", primaryError)
    }

    const fallback = await MapSnapshotter.take(common)
    return fallback?.image ? fallback : null
  } catch (error) {
    console.error("[IP檢測] 地圖快照失敗", error)
    return null
  }
}

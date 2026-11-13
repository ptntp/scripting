// 把 Surge 的即時狀態補進快照：目前節點／協定，以及每項解鎖檢測實際經過的策略。
// 頁面與小工具共用。
import { countryCode, regionOfName } from "./net"
import type { Settings } from "./store"
import { fetchServicePolicies, fetchSurgeState } from "./surge"
import type { ServiceInfo, Snapshot } from "./types"

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([promise, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))])
}

/**
 * 依實際承載的策略重新標註一項服務：
 * 被規則攔截 → 「攔截」；規則直連 → 「直連」；走節點 → 保留服務自己判定的地區，
 * 沒有才用節點名稱或目前節點的地區。純函式，方便離線測試。
 */
export function relabel(service: ServiceInfo, policy: string, nodeCC: string, exitCC: string): ServiceInfo {
  if (policy) {
    if (/^REJECT/i.test(policy)) return { ...service, policy, cc: "攔截" }
    if (/^DIRECT$/i.test(policy)) return { ...service, policy, cc: "直連" }
    const detected = /^[A-Z]{2}$/.test(service.cc) && service.state ? service.cc : ""
    return { ...service, policy, cc: detected || regionOfName(policy) || nodeCC || service.cc }
  }
  // 請求紀錄裡沒找到這項服務：只在還沒有結果（或仍是主要出口地區）時以目前節點補上，
  // 不覆蓋服務自己判定的地區，也不覆蓋已儲存的「直連／攔截」。
  if (nodeCC && !service.state && (!service.cc || service.cc === exitCC)) return { ...service, cc: nodeCC }
  return service
}

export function applySurge(
  snapshot: Snapshot,
  state: Snapshot["surge"] | null,
  policies: Record<string, string> | null,
): Snapshot {
  const nodeCC = regionOfName(state?.node || "")
  const exitCC = countryCode(snapshot.exit?.cc || "")
  const label = (item: ServiceInfo) => relabel(item, policies?.[item.id] || "", nodeCC, exitCC)
  return {
    ...snapshot,
    media: (snapshot.media || []).map(label),
    ai: (snapshot.ai || []).map(label),
    surge: {
      mode: state?.mode || snapshot.surge?.mode || "",
      policy: state?.policy || snapshot.surge?.policy || "",
      node: state?.node || snapshot.surge?.node || "",
      protocol: state?.protocol || snapshot.surge?.protocol || "",
    },
  }
}

/** 沒設定 x-key 或連不上 Surge 時原樣回傳。 */
export async function enrich(snapshot: Snapshot | null, settings: Settings): Promise<Snapshot | null> {
  if (!snapshot || !settings.surgeKey) return snapshot
  const [state, policies] = await Promise.all([
    withTimeout(fetchSurgeState(settings), 5000),
    withTimeout(fetchServicePolicies(settings), 5000),
  ])
  if (!state && !policies) return snapshot
  return applySurge(snapshot, state, policies)
}

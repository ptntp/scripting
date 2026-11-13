/**
 * IPCheck 網路診斷 · Surge 版
 *
 * 利用 Surge 的 policy 參數分別檢測「代理出口」與「直連出口」，並依策略群組測試
 * 串流與 AI 服務，最後推送一則摘要通知，結果另存於 $persistentStore。
 * 所有探測點皆為國際常用或台灣本地服務。
 *
 * 參數（argument，以 & 連接）：
 *   POLICY=策略名稱    最高優先，出口／延遲／HTTP3／串流／AI 全部走該策略
 *   LMT=策略群組名稱   串流專用（POLICY 為空時生效）
 *   AI=策略群組名稱    AI 服務專用（POLICY 為空時生效）
 *   YS=1              輸出時遮蔽 IP（123.123.123.123 → 123.123.*.*）
 *   XY=VLESS          手動指定協定（不填則由節點名稱推斷）
 *   NOTIFY=0          關閉通知（預設會通知）
 *   SYNC=https://...  把快照 POST 到該網址（任何可接收 JSON 的 KV／Worker／NAS），供小工具讀取
 *   DEBUG=1           輸出詳細記錄
 */

const KEY_SNAPSHOT = "radar.snapshot.v1";
const TITLE = "IPCheck 網路診斷";
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

const TIMEOUT = 8;        // 單一請求逾時（秒）
const PROBE_TIMEOUT = 3;  // 策略探測逾時（秒）
const CONCURRENCY = 6;

const ARG = parseArgument(typeof $argument === "string" ? $argument : "");
const POLICY = clean(ARG.POLICY);
const LMT = clean(ARG.LMT);
const AI = clean(ARG.AI);
const MASK = clean(ARG.YS) === "1";
const FORCE_PROTOCOL = clean(ARG.XY);
const NOTIFY = clean(ARG.NOTIFY) !== "0";
const SYNC = /^https?:\/\//i.test(clean(ARG.SYNC)) ? clean(ARG.SYNC) : "";
const DEBUG = clean(ARG.DEBUG) === "1";

// 國際常用的連線檢查端點（Cloudflare、Google）
const GLOBAL_LATENCY_URLS = [
  "https://cp.cloudflare.com/generate_204",
  "https://www.gstatic.com/generate_204",
  "https://www.google.com/generate_204"
];

// 台灣本地站點：HiNet、中華電信、TWNIC、台灣大學
const TAIWAN_LATENCY_URLS = [
  "https://www.hinet.net/favicon.ico",
  "https://www.cht.com.tw/favicon.ico",
  "https://www.twnic.tw/favicon.ico",
  "https://www.ntu.edu.tw/favicon.ico"
];

const QUIC_TRACE_URLS = [
  "https://cloudflare-quic.com/cdn-cgi/trace",
  "https://www.cloudflare.com/cdn-cgi/trace"
];

// 直連出口位址探針（依序嘗試）
const DIRECT_IP_URLS = [
  "https://api.ipify.org",
  "https://icanhazip.com",
  "https://checkip.amazonaws.com"
];

const MEDIA_SERVICES = [
  { id: "youtube", name: "YouTube", url: "https://www.youtube.com/" },
  { id: "netflix", name: "Netflix", url: "https://www.netflix.com/title/81280792" },
  { id: "disney", name: "Disney+", url: "https://www.disneyplus.com/" },
  { id: "bahamut", name: "動畫瘋", url: "https://ani.gamer.com.tw/" },
  { id: "spotify", name: "Spotify", url: "https://open.spotify.com/" },
  { id: "prime", name: "Prime Video", url: "https://www.primevideo.com/" }
];

const AI_SERVICES = [
  { id: "chatgpt", name: "ChatGPT", url: "https://chatgpt.com/" },
  { id: "claude", name: "Claude", url: "https://claude.ai/" },
  { id: "gemini", name: "Gemini", url: "https://gemini.google.com/" },
  { id: "copilot", name: "Copilot", url: "https://copilot.microsoft.com/" },
  { id: "grok", name: "Grok", url: "https://grok.com/" },
  { id: "perplexity", name: "Perplexity", url: "https://www.perplexity.ai/" }
];

// 策略群組名稱由設定檔決定，因此同時列出繁體、簡體與英文常見寫法。
const MEDIA_POLICY_CANDIDATES = [
  "串流", "串流媒體", "串流解鎖", "流媒體", "流媒体", "流媒体解锁", "Netflix", "媒體", "媒体",
  "國際媒體", "国际媒体", "Streaming", "Media", "解鎖", "解锁"
];
const AI_POLICY_CANDIDATES = [
  "AI", "AI 服務", "AI服務", "AI服务", "AI 服务", "人工智慧", "人工智能", "ChatGPT", "OpenAI"
];
const MAIN_GROUP_HINTS = ["節點", "节点", "代理", "機場", "机场", "手動", "手动", "主策略", "Proxy", "PROXY", "選擇", "选择"];

const DNS_PROVIDERS = [
  { key: ["1.1.1.1", "1.0.0.1"], name: "Cloudflare" },
  { key: ["8.8.8.8", "8.8.4.4"], name: "Google" },
  { key: ["168.95.1.1", "168.95.192.1"], name: "HiNet" },
  { key: ["101.101.101.101", "101.102.103.104"], name: "TWNIC Quad101" },
  { key: ["9.9.9.9", "149.112.112.112"], name: "Quad9" },
  { key: ["208.67.222.222", "208.67.220.220"], name: "OpenDNS" }
];

/* ---------------------------------------------------------------- */
/* 主流程                                                            */
/* ---------------------------------------------------------------- */

(async function main() {
  const startedAt = Date.now();
  const net = readNetwork();
  const surgeInfo = readSurgeInfo();

  const [exitInfo, directExit, proxyLat, directLat, quic] = await Promise.all([
    collectExit(),
    collectDirectExit(),
    measureLatency(GLOBAL_LATENCY_URLS, POLICY),
    measureLatency(TAIWAN_LATENCY_URLS, "DIRECT"),
    detectQuic()
  ]);

  const mediaPolicy = await resolveCategoryPolicy("media");
  const aiPolicy = await resolveCategoryPolicy("ai");
  const [media, ai] = await Promise.all([
    runServices(MEDIA_SERVICES, mediaPolicy),
    runServices(AI_SERVICES, aiPolicy)
  ]);

  const snapshot = {
    v: 1,
    ts: Date.now(),
    src: "surge",
    masked: MASK,
    exit: {
      ip: displayIP(exitInfo.ip), cc: exitInfo.cc, country: exitInfo.country, region: exitInfo.region,
      city: exitInfo.city, isp: exitInfo.isp, asn: exitInfo.asn, org: exitInfo.org,
      proxy: exitInfo.flags.proxy || exitInfo.flags.vpn,
      hosting: exitInfo.flags.hosting || exitInfo.flags.datacenter,
      mobile: exitInfo.flags.mobile, kind: exitInfo.kind, purity: exitInfo.purity, risk: exitInfo.risk
    },
    local: {
      net: net.label, ip: displayIP(net.ip), gw: net.gw, dns: net.dnsLabel,
      exitIP: displayIP(directExit.ip), area: directExit.area, carrier: directExit.carrier,
      nat: natLabel(net.ip), vpn: net.vpn, v6: net.v6
    },
    lat: { proxy: proxyLat, local: directLat },
    quic: quic,
    media: media,
    ai: ai,
    surge: {
      mode: "", policy: surgeInfo.policy, node: surgeInfo.node,
      protocol: FORCE_PROTOCOL || surgeInfo.protocol
    },
    cost: Date.now() - startedAt
  };

  const json = JSON.stringify(snapshot);
  $persistentStore.write(json, KEY_SNAPSHOT);
  if (SYNC) await pushSync(SYNC, json);
  if (NOTIFY) notify(snapshot);
  log("完成，耗時 " + snapshot.cost + "ms");
  $done();
})().catch(function (error) {
  log("嚴重錯誤：" + error);
  if (NOTIFY) $notification.post(TITLE, "診斷失敗", String(error).slice(0, 180));
  $done();
});

/* ---------------------------------------------------------------- */
/* 資料蒐集                                                          */
/* ---------------------------------------------------------------- */

async function collectExit() {
  const stamp = Date.now();
  const [ipApi, ipWho, ipApiIs, ipInfo] = await Promise.all([
    getJSON("http://ip-api.com/json/?fields=status,message,query,country,countryCode,regionName,city,isp,org,as,asname,proxy,hosting,mobile&_=" + stamp, TIMEOUT, POLICY),
    getJSON("https://ipwho.is/?_=" + stamp, TIMEOUT, POLICY),
    getJSON("https://api.ipapi.is/?_=" + stamp, TIMEOUT, POLICY),
    getJSON("https://ipinfo.io/json?_=" + stamp, TIMEOUT, POLICY)
  ]);

  const flags = { proxy: false, vpn: false, tor: false, abuser: false, hosting: false, datacenter: false, mobile: false, residential: false };
  let ip = "", cc = "", country = "", region = "", city = "", isp = "", asn = "", org = "";

  if (ipApi && ipApi.status === "success") {
    ip = clean(ipApi.query);
    country = clean(ipApi.country);
    cc = countryCode(ipApi.countryCode);
    region = clean(ipApi.regionName);
    city = clean(ipApi.city);
    isp = clean(ipApi.isp);
    org = clean(ipApi.org);
    asn = clean(ipApi.as).split(" ")[0];
    flags.proxy = ipApi.proxy === true;
    flags.hosting = ipApi.hosting === true;
    flags.mobile = ipApi.mobile === true;
  }
  if (ipWho && ipWho.success !== false) {
    const conn = ipWho.connection || {};
    ip = ip || clean(ipWho.ip);
    country = country || clean(ipWho.country);
    cc = cc || countryCode(ipWho.country_code);
    region = region || clean(ipWho.region);
    city = city || clean(ipWho.city);
    isp = isp || clean(conn.isp) || clean(conn.org);
    org = org || clean(conn.org);
    asn = asn || (conn.asn ? "AS" + conn.asn : "");
  }
  if (ipApiIs) {
    const asnInfo = ipApiIs.asn || {};
    const loc = ipApiIs.location || {};
    ip = ip || clean(ipApiIs.ip);
    country = country || clean(loc.country);
    cc = cc || countryCode(loc.country_code);
    region = region || clean(loc.state);
    city = city || clean(loc.city);
    org = org || clean(asnInfo.org) || clean((ipApiIs.company || {}).name);
    asn = asn || (asnInfo.asn ? "AS" + asnInfo.asn : "");
    flags.mobile = flags.mobile || ipApiIs.is_mobile === true;
    flags.datacenter = ipApiIs.is_datacenter === true;
    flags.proxy = flags.proxy || ipApiIs.is_proxy === true;
    flags.vpn = ipApiIs.is_vpn === true;
    flags.tor = ipApiIs.is_tor === true;
    flags.abuser = ipApiIs.is_abuser === true;
  }
  if (ipInfo) {
    ip = ip || clean(ipInfo.ip);
    cc = cc || countryCode(ipInfo.country);
    city = city || clean(ipInfo.city);
    region = region || clean(ipInfo.region);
    const matched = clean(ipInfo.org).match(/^(AS\d+)\s+(.*)$/);
    if (matched) {
      asn = asn || matched[1];
      org = org || matched[2];
    } else {
      org = org || clean(ipInfo.org);
    }
  }

  if (!ip) {
    return { ip: "", cc: "", country: "", region: "", city: "", isp: "", asn: "", org: "", flags: flags, kind: "未知網路", purity: 0, risk: "未知" };
  }

  flags.residential = !flags.datacenter && !flags.hosting && !flags.proxy && !flags.vpn && !flags.tor && !flags.mobile;
  const kind = classifyExitKind(flags);
  const purity = purityScore(flags, kind);
  return {
    ip: ip, cc: cc, country: country, region: region, city: city, isp: isp || org, asn: asn, org: org,
    flags: flags, kind: kind, purity: purity, risk: riskLevel(flags, purity)
  };
}

/** 直連出口：以 DIRECT 策略取得本地電信業者與歸屬地。 */
async function collectDirectExit() {
  let ip = "";
  for (let i = 0; i < DIRECT_IP_URLS.length && !ip; i += 1) {
    const matched = clean(await getText(DIRECT_IP_URLS[i], 4, "DIRECT")).match(/^(\d{1,3}(?:\.\d{1,3}){3}|[0-9a-fA-F:]+)$/);
    if (matched) ip = matched[1];
  }
  if (!ip) return { ip: "", area: "", carrier: "" };

  const detail = await getJSON("https://ipwho.is/" + encodeURIComponent(ip) + "?_=" + Date.now(), TIMEOUT, "DIRECT");
  if (!detail || detail.success === false) return { ip: ip, area: "", carrier: "" };
  const conn = detail.connection || {};
  return {
    ip: ip,
    area: [countryCode(detail.country_code), clean(detail.city) || clean(detail.region)].filter(Boolean).join(" "),
    carrier: shortCarrier(clean(conn.isp) || clean(conn.org))
  };
}

async function detectQuic() {
  const results = await Promise.all(QUIC_TRACE_URLS.map(function (url) {
    return getText(url + "?_=" + Date.now(), TIMEOUT, POLICY);
  }));
  let reachable = false;
  for (let i = 0; i < results.length; i += 1) {
    if (!results[i]) continue;
    reachable = true;
    const matched = results[i].match(/^http=(.+)$/m);
    const protocol = matched ? matched[1].trim().toLowerCase() : "";
    if (protocol.indexOf("h3") >= 0 || protocol.indexOf("http/3") >= 0) return { ok: true, reachable: true };
  }
  return { ok: false, reachable: reachable };
}

/** 回傳最快成功端點的毫秒數；全部失敗為 0。 */
async function measureLatency(urls, policy) {
  const results = await Promise.all(urls.map(function (url) {
    return get(url + (url.indexOf("?") >= 0 ? "&" : "?") + "_=" + Date.now(), TIMEOUT, policy);
  }));
  const passed = results.filter(function (item) {
    return !item.error && item.status >= 200 && item.status < 500;
  }).map(function (item) { return item.ms; });
  return passed.length ? Math.min.apply(null, passed) : 0;
}

async function runServices(services, policy) {
  return mapLimit(services, CONCURRENCY, async function (service) {
    const status = await getStatus(service.url + (service.url.indexOf("?") >= 0 ? "&" : "?") + "_=" + Date.now(), TIMEOUT, policy);
    return { id: service.id, name: service.name, ok: status >= 200 && status < 500, policy: policy || "" };
  });
}

async function resolveCategoryPolicy(category) {
  if (POLICY) return POLICY;
  const preset = category === "media" ? LMT : AI;
  if (preset) return preset;

  const candidates = category === "media" ? MEDIA_POLICY_CANDIDATES : AI_POLICY_CANDIDATES;
  const available = listPolicyNames();
  // 讀不到策略清單時不盲目嘗試，直接走預設規則。
  const ordered = candidates.filter(function (name) { return available.indexOf(name) >= 0; });
  for (let i = 0; i < ordered.length; i += 1) {
    const status = await getStatus("https://cp.cloudflare.com/generate_204?_=" + Date.now(), PROBE_TIMEOUT, ordered[i]);
    if (status >= 200 && status < 500) {
      log(category + " 使用策略：" + ordered[i]);
      return ordered[i];
    }
  }
  return "";
}

/* ---------------------------------------------------------------- */
/* Surge 環境                                                        */
/* ---------------------------------------------------------------- */

function readNetwork() {
  let network = {};
  try { network = typeof $network === "object" && $network ? $network : {}; } catch (_) {}
  const wifi = network.wifi || {};
  const v4 = network.v4 || {};
  const ssid = clean(wifi.ssid);
  const carrier = clean(network["cellular-data"] && network["cellular-data"].carrier);
  return {
    label: ssid ? "Wi-Fi · " + ssid : carrier ? "行動網路 · " + carrier : clean(v4.primaryInterface) || "未知網路",
    ip: clean(v4.primaryAddress),
    gw: clean(v4.primaryRouter),
    dnsLabel: dnsLabel(network.dns),
    vpn: /utun|ppp|ipsec|tun/i.test(clean(v4.primaryInterface)),
    v6: Boolean(clean(network.v6 && network.v6.primaryAddress))
  };
}

function selectDetails() {
  try {
    if (typeof $surge === "object" && $surge && typeof $surge.selectGroupDetails === "function") {
      return $surge.selectGroupDetails() || {};
    }
  } catch (error) {
    log("無法讀取策略群組：" + error);
  }
  return {};
}

function readSurgeInfo() {
  const decisions = selectDetails().decisions || {};
  const names = Object.keys(decisions);
  let group = "";
  for (let i = 0; i < MAIN_GROUP_HINTS.length && !group; i += 1) {
    for (let j = 0; j < names.length; j += 1) {
      if (names[j].indexOf(MAIN_GROUP_HINTS[i]) >= 0) { group = names[j]; break; }
    }
  }
  if (!group && names.length) group = names[0];
  const node = clean(group ? decisions[group] : "");
  return { policy: clean(group), node: node, protocol: protocolFromName(node) };
}

function listPolicyNames() {
  const details = selectDetails();
  return Object.keys(details.groups || {}).concat(Object.keys(details.decisions || {}));
}

function protocolFromName(name) {
  const text = clean(name).toLowerCase();
  const table = [
    ["vless", "VLESS"], ["vmess", "VMess"], ["trojan", "Trojan"], ["hysteria2", "HY2"], ["hy2", "HY2"],
    ["tuic", "TUIC"], ["ss2022", "SS"], ["shadowsocks", "SS"], ["anytls", "AnyTLS"], ["snell", "Snell"],
    ["wireguard", "WireGuard"], ["ssh", "SSH"], ["reality", "Reality"]
  ];
  for (let i = 0; i < table.length; i += 1) {
    if (text && text.indexOf(table[i][0]) >= 0) return table[i][1];
  }
  return "";
}

/* ---------------------------------------------------------------- */
/* HTTP                                                              */
/* ---------------------------------------------------------------- */

function get(url, timeout, policy) {
  return new Promise(function (resolve) {
    const options = {
      url: url,
      timeout: timeout || TIMEOUT,
      headers: { "User-Agent": UA, Accept: "application/json,text/plain,text/html,*/*", "Cache-Control": "no-cache" }
    };
    if (policy) options.policy = policy;
    const started = Date.now();
    $httpClient.get(options, function (error, response, data) {
      resolve({
        error: error || null,
        status: response ? response.status : 0,
        text: typeof data === "string" ? data : "",
        ms: Math.max(1, Date.now() - started)
      });
    });
  });
}

async function getText(url, timeout, policy) {
  const result = await get(url, timeout, policy);
  return result.error || result.status < 200 || result.status >= 500 ? "" : result.text || "";
}

async function getStatus(url, timeout, policy) {
  const result = await get(url, timeout, policy);
  return result.error ? 0 : result.status || 0;
}

async function getJSON(url, timeout, policy) {
  const text = await getText(url, timeout, policy);
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) { return null; }
}

/** 快照內含出口 IP；只會送到你在 SYNC 指定的網址。 */
function pushSync(url, body) {
  return new Promise(function (resolve) {
    try {
      $httpClient.post({
        url: url, timeout: 10, body: body,
        headers: { "Content-Type": "application/json", "User-Agent": "IPCheck-Radar/1.0" }
      }, function (error) {
        log(error ? "同步失敗：" + error : "同步完成");
        resolve();
      });
    } catch (error) {
      log("同步錯誤：" + error);
      resolve();
    }
  });
}

/* ---------------------------------------------------------------- */
/* 通知與記錄                                                        */
/* ---------------------------------------------------------------- */

function notify(snapshot) {
  const exit = snapshot.exit;
  const count = function (list) { return list.filter(function (item) { return item.ok; }).length; };
  const subtitle = [[exit.cc, exit.city].filter(Boolean).join(" "), exit.ip].filter(Boolean).join(" · ");
  const body = [
    "代理 " + (snapshot.lat.proxy || "—") + "ms／直連 " + (snapshot.lat.local || "—") + "ms／HTTP3 " + (snapshot.quic.ok ? "✓" : "✗"),
    "純淨度 " + exit.purity + " · " + exit.risk + " · " + exit.kind,
    "串流 " + count(snapshot.media) + "/" + snapshot.media.length + " · AI " + count(snapshot.ai) + "/" + snapshot.ai.length
      + (snapshot.surge.node ? " · " + snapshot.surge.node : "")
  ].join("\n");
  $notification.post(TITLE, subtitle || "未取得出口 IP", body);
}

function log(message) {
  if (DEBUG) console.log("[IPCheck] " + message);
}

/* ---------------------------------------------------------------- */
/* 工具函式                                                          */
/* ---------------------------------------------------------------- */

function parseArgument(raw) {
  const out = {};
  clean(raw).split("&").forEach(function (pair) {
    if (!pair) return;
    const index = pair.indexOf("=");
    if (index < 0) { out[pair.trim()] = "1"; return; }
    const key = pair.slice(0, index).trim();
    if (key) out[key] = pair.slice(index + 1).trim();
  });
  return out;
}

function clean(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function countryCode(value) {
  const text = clean(value).toUpperCase();
  return /^[A-Z]{2}$/.test(text) ? text : "";
}

function displayIP(ip) {
  const value = clean(ip);
  if (!MASK || !value) return value;
  const parts = value.split(".");
  if (parts.length === 4) return parts[0] + "." + parts[1] + ".*.*";
  const groups = value.split(":");
  return groups.length > 2 ? groups.slice(0, 2).join(":") + ":***" : value;
}

/** 台灣常見電信業者簡稱；其餘截短顯示。 */
function shortCarrier(value) {
  const text = clean(value);
  if (!text) return "";
  if (/chunghwa|hinet|中華電信/i.test(text)) return "中華電信";
  if (/taiwan mobile|台灣大哥大|twm/i.test(text)) return "台灣大哥大";
  if (/far ?eas ?tone|遠傳|fetnet/i.test(text)) return "遠傳電信";
  if (/kbro|凱擘/i.test(text)) return "凱擘大寬頻";
  if (/taiwan fixed network|台灣固網/i.test(text)) return "台灣固網";
  if (/so-?net/i.test(text)) return "So-net";
  if (/tanet|ministry of education/i.test(text)) return "TANet";
  return text.length > 16 ? text.slice(0, 16) : text;
}

function dnsLabel(servers) {
  const list = Array.isArray(servers) ? servers.map(clean).filter(Boolean) : [];
  if (!list.length) return "系統 DNS";
  for (let i = 0; i < DNS_PROVIDERS.length; i += 1) {
    for (let j = 0; j < list.length; j += 1) {
      if (DNS_PROVIDERS[i].key.indexOf(list[j]) >= 0) return DNS_PROVIDERS[i].name;
    }
  }
  return isPrivateIPv4(list[0]) ? "路由器 " + list[0] : list[0];
}

function classifyExitKind(flags) {
  if (flags.mobile) return "行動網路";
  if (flags.residential) return "住宅 IP";
  if (flags.datacenter || flags.hosting) return "機房 IP";
  return "未知網路";
}

function purityScore(flags, kind) {
  const trusted = kind === "住宅 IP" || kind === "行動網路";
  let score = trusted ? 92 : kind === "機房 IP" ? 78 : 72;
  const proxyVpn = (flags.proxy ? 1 : 0) + (flags.vpn ? 1 : 0);
  if (flags.tor) score -= 55;
  if (flags.abuser) score -= 35;
  if (proxyVpn >= 2) score -= 30;
  else if (proxyVpn === 1) score -= 16;
  if (flags.datacenter || flags.hosting) score -= 8;
  if (trusted && !proxyVpn && !flags.tor && !flags.abuser) score += 3;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function riskLevel(flags, score) {
  const proxyVpn = (flags.proxy ? 1 : 0) + (flags.vpn ? 1 : 0);
  if (flags.tor || flags.abuser || score < 45 || (proxyVpn >= 2 && score < 60)) return "高風險";
  if (score < 75 || flags.datacenter || flags.hosting || proxyVpn > 0) return "中風險";
  return "低風險";
}

/** 只依本機位址類別推估，無法取代 STUN 的 NAT 類型測試。標籤與小工具端一致。 */
function natLabel(localIP) {
  const parts = parseIPv4(localIP);
  if (!parts) return "未知";
  if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return "CGNAT";
  if (isPrivateIPv4(localIP)) return "NAT";
  if (parts[0] === 0 || parts[0] === 127 || parts[0] >= 224 || (parts[0] === 169 && parts[1] === 254)) return "未知";
  return "公網";
}

function parseIPv4(ip) {
  const parts = clean(ip).split(".");
  if (parts.length !== 4) return null;
  const values = parts.map(Number);
  for (let i = 0; i < 4; i += 1) {
    if (!Number.isInteger(values[i]) || values[i] < 0 || values[i] > 255) return null;
  }
  return values;
}

function isPrivateIPv4(ip) {
  const parts = parseIPv4(ip);
  return Boolean(parts && (parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168)));
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }
  const runners = [];
  for (let i = 0; i < Math.min(limit || 1, items.length || 1); i += 1) runners.push(run());
  await Promise.all(runners);
  return results;
}

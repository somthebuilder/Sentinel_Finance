type MarketThemeSignal = {
  score: number;
  evidenceCount: number;
  sources: string[];
};

const MARKET_SOURCE_URLS = {
  trendlyne: "https://trendlyne.com/equity/sector-industry-analysis/sector/month/",
  nseAllIndices: "https://www.nseindia.com/api/allIndices",
};

const THEME_MARKET_KEYWORDS: Record<string, string[]> = {
  Technology: ["it", "tech", "software", "information technology", "data center"],
  "Capital Goods": ["capital goods", "industrial", "engineering", "infrastructure"],
  Financials: ["bank", "financial", "nbfc", "private bank", "psu bank"],
  Metals: ["metal", "steel", "mining"],
  Consumption: ["fmcg", "consumer", "retail", "auto"],
  Defense: ["defence", "defense", "aerospace"],
  Railways: ["rail", "railway"],
  "Energy Transition": ["energy", "power", "oil", "gas", "renewable", "utility"],
};

const marketSignalCache = new Map<string, { signals: Record<string, MarketThemeSignal>; cachedAtMs: number }>();

function getEnv(name: string, fallback: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return v;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function normalizeToUnitInterval(values: Record<string, number>): Record<string, number> {
  const nums = Object.values(values).filter((v) => Number.isFinite(v));
  if (!nums.length) return {};
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  if (max - min < 1e-9) {
    const out: Record<string, number> = {};
    for (const k of Object.keys(values)) out[k] = 0.5;
    return out;
  }
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(values)) {
    out[k] = Math.max(0, Math.min(1, (v - min) / (max - min)));
  }
  return out;
}

async function fetchNseIndexChanges(timeoutMs: number): Promise<Array<{ name: string; changePct: number }>> {
  try {
    const res = await fetchWithTimeout(
      MARKET_SOURCE_URLS.nseAllIndices,
      {
        method: "GET",
        headers: {
          Accept: "application/json,text/plain,*/*",
          "User-Agent": "Mozilla/5.0",
          Referer: "https://www.nseindia.com/",
        },
      },
      timeoutMs
    );
    if (!res.ok) return [];
    const json = await res.json().catch(() => null);
    const rows = Array.isArray(json?.data) ? json.data : [];
    return rows
      .map((r: any) => {
        const name = String(r?.index ?? r?.indexSymbol ?? "").trim();
        const changePct = Number(r?.percentChange ?? r?.perChange365d ?? r?.percentChange365d ?? NaN);
        return { name, changePct };
      })
      .filter((x: { name: string; changePct: number }) => x.name && Number.isFinite(x.changePct));
  } catch {
    return [];
  }
}

async function fetchTrendlynePage(timeoutMs: number): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(
      MARKET_SOURCE_URLS.trendlyne,
      { method: "GET", headers: { "User-Agent": "Mozilla/5.0", Accept: "text/html,*/*" } },
      timeoutMs
    );
    return res.ok;
  } catch {
    return false;
  }
}

export async function getMarketThemeSignals(themeNames: string[]): Promise<Record<string, MarketThemeSignal>> {
  const uniqueThemes = Array.from(new Set(themeNames)).filter(Boolean);
  if (!uniqueThemes.length) return {};

  const ttlMs = Number(getEnv("MARKET_SIGNALS_CACHE_TTL_MS", "300000"));
  const timeoutMs = Number(getEnv("MARKET_SIGNAL_TIMEOUT_MS", "5000"));
  const cacheKey = uniqueThemes.join("|");
  const cached = marketSignalCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAtMs < ttlMs) return cached.signals;

  const [nseRows, trendlyneOk] = await Promise.all([fetchNseIndexChanges(timeoutMs), fetchTrendlynePage(timeoutMs)]);
  const rawScores: Record<string, number> = {};
  const counts: Record<string, number> = {};
  const matchedSources: Record<string, Set<string>> = {};

  for (const theme of uniqueThemes) {
    rawScores[theme] = 0;
    counts[theme] = 0;
    matchedSources[theme] = new Set<string>();
    const keywords = THEME_MARKET_KEYWORDS[theme] ?? [];
    for (const row of nseRows) {
      const n = row.name.toLowerCase();
      if (keywords.some((k) => n.includes(k))) {
        rawScores[theme] += row.changePct;
        counts[theme] += 1;
        matchedSources[theme].add("nse");
      }
    }
    if (trendlyneOk) {
      // We currently use Trendlyne as a hardcoded source-availability signal;
      // matched sector movement is derived from NSE index trend data.
      matchedSources[theme].add("trendlyne");
    }
  }

  const averaged: Record<string, number> = {};
  for (const theme of uniqueThemes) {
    averaged[theme] = counts[theme] > 0 ? rawScores[theme] / counts[theme] : 0;
  }
  const normalized = normalizeToUnitInterval(averaged);

  const signals: Record<string, MarketThemeSignal> = {};
  for (const theme of uniqueThemes) {
    signals[theme] = {
      score: normalized[theme] ?? 0.5,
      evidenceCount: counts[theme],
      sources: Array.from(matchedSources[theme]),
    };
  }
  marketSignalCache.set(cacheKey, { signals, cachedAtMs: Date.now() });
  return signals;
}


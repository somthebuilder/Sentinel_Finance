type MarketThemeSignal = {
  score: number;
  evidenceCount: number;
  sources: string[];
};

/**
 * Single market data source: Trendlyne sector/industry weekly (and YoY for penalty) JSON.
 * @see https://trendlyne.com/equity/sector-industry-analysis/overall/week-changeP/?format=json
 */
const TRENDLYNE_MARKET_JSON =
  "https://trendlyne.com/equity/sector-industry-analysis/overall/week-changeP/?format=json";

/**
 * Map Trendlyne sector/industry labels (lowercased substring match, longest phrase wins).
 */
const THEME_SECTOR_PHRASES: Record<string, string[]> = {
  Technology: [
    "software & services",
    "hardware technology",
    "telecommunications equipment",
    "telecom services",
    "it consulting",
    "internet software",
    "data processing",
  ],
  Metals: ["metals & mining"],
  Financials: ["banking and finance"],
  Consumption: [
    "fmcg",
    "retailing",
    "consumer durables",
    "automobiles & auto",
    "media",
    "hotels restaurants",
    "food, beverages & tobacco",
    "textiles apparels",
    "forest materials",
    "diversified consumer services",
  ],
  Defense: ["aerospace", "defence", "defense"],
  Railways: ["transportation", "railway", "rail "],
  "Energy Transition": ["oil & gas", "utilities", "power - electric", "green & renewable"],
  Healthcare: ["pharmaceuticals & biotechnology", "healthcare"],
  Realty: ["realty"],
  Chemicals: ["chemicals & petrochemicals", "fertilizers"],
  "Capital Goods": [
    "cement and construction",
    "general industrials",
    "general & industrial manufacturing",
    "commercial services & supplies",
    "electrical equipment",
    "industrial machinery",
  ],
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

type TlRow = { name: string; weekPct: number; yearPct: number };

function extractTrendlyneRows(json: unknown): TlRow[] {
  const body = (json as { body?: Record<string, unknown> })?.body;
  if (!body) return [];
  const out: TlRow[] = [];

  for (const sectionKey of ["sector", "industry"] as const) {
    const section = body[sectionKey] as { tableData?: unknown[] } | undefined;
    const table = Array.isArray(section?.tableData) ? section.tableData : [];
    for (const row of table) {
      const r = row as Record<string, unknown>;
      const sc = r.stock_column as Record<string, unknown> | undefined;
      const name = String(sc?.stockName ?? sc?.get_full_name ?? "").trim();
      const weekRaw = r.week_changeP_mcapw_sec ?? r.week_changeP_mcapw_ind ?? r.week_changeP;
      const yearRaw = r.year_changeP_mcapw_sec ?? r.year_changeP_mcapw_ind ?? r.year_changeP;
      const weekPct = Number(weekRaw);
      const yearPct = Number(yearRaw);
      if (!name || !Number.isFinite(weekPct)) continue;
      out.push({
        name,
        weekPct,
        yearPct: Number.isFinite(yearPct) ? yearPct : weekPct,
      });
    }
  }

  return out;
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

/**
 * Cap relative scores when the underlying Trendlyne YoY trend is weak (aligns with macro view).
 */
function applyAbsoluteTrendPenalty(
  yearAveraged: Record<string, number>,
  normalized: Record<string, number>
): Record<string, number> {
  const out = { ...normalized };
  for (const [theme, avgY] of Object.entries(yearAveraged)) {
    if (!Number.isFinite(avgY)) continue;
    const cur = out[theme];
    if (cur === undefined) continue;
    if (avgY < -15) out[theme] = Math.min(cur, 0.12);
    else if (avgY < -8) out[theme] = Math.min(cur, 0.22);
    else if (avgY < 0) out[theme] = Math.min(cur, 0.36);
  }
  return out;
}

type BestMatch = { theme: string; phraseLen: number };

function bestThemeForLabel(label: string, themeNames: string[]): BestMatch | null {
  const n = label.toLowerCase();
  let best: BestMatch | null = null;
  for (const theme of themeNames) {
    const phrases = THEME_SECTOR_PHRASES[theme];
    if (!phrases?.length) continue;
    for (const p of phrases) {
      if (!p.length) continue;
      if (n.includes(p)) {
        if (!best || p.length > best.phraseLen) {
          best = { theme, phraseLen: p.length };
        }
      }
    }
  }
  return best;
}

async function fetchTrendlyneMarketRows(timeoutMs: number): Promise<TlRow[]> {
  try {
    const res = await fetchWithTimeout(
      TRENDLYNE_MARKET_JSON,
      {
        method: "GET",
        headers: {
          Accept: "application/json,text/plain,*/*",
          "User-Agent": "Mozilla/5.0 (compatible; SentinelFinance/1.0)",
        },
      },
      timeoutMs
    );
    if (!res.ok) return [];
    const json = await res.json().catch(() => null);
    return extractTrendlyneRows(json);
  } catch {
    return [];
  }
}

export async function getMarketThemeSignals(themeNames: string[]): Promise<Record<string, MarketThemeSignal>> {
  const uniqueThemes = Array.from(new Set(themeNames)).filter(Boolean);
  if (!uniqueThemes.length) return {};

  const ttlMs = Number(getEnv("MARKET_SIGNALS_CACHE_TTL_MS", "300000"));
  const timeoutMs = Number(getEnv("MARKET_SIGNAL_TIMEOUT_MS", "8000"));
  const cacheKey = uniqueThemes.join("|");
  const cached = marketSignalCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAtMs < ttlMs) return cached.signals;

  const rows = await fetchTrendlyneMarketRows(timeoutMs);

  const weekSum: Record<string, number> = {};
  const yearSum: Record<string, number> = {};
  const counts: Record<string, number> = {};
  const matchedSources: Record<string, Set<string>> = {};

  for (const theme of uniqueThemes) {
    weekSum[theme] = 0;
    yearSum[theme] = 0;
    counts[theme] = 0;
    matchedSources[theme] = new Set<string>();
  }

  for (const row of rows) {
    const hit = bestThemeForLabel(row.name, uniqueThemes);
    if (!hit) continue;
    const { theme } = hit;
    weekSum[theme] += row.weekPct;
    yearSum[theme] += row.yearPct;
    counts[theme] += 1;
    matchedSources[theme].add("trendlyne");
  }

  const weekAvg: Record<string, number> = {};
  const yearAvg: Record<string, number> = {};
  for (const theme of uniqueThemes) {
    const c = counts[theme];
    weekAvg[theme] = c > 0 ? weekSum[theme] / c : Number.NaN;
    yearAvg[theme] = c > 0 ? yearSum[theme] / c : Number.NaN;
  }

  const finiteWeek: Record<string, number> = {};
  for (const theme of uniqueThemes) {
    const v = weekAvg[theme];
    if (Number.isFinite(v)) finiteWeek[theme] = v;
  }

  const normalized = Object.keys(finiteWeek).length
    ? applyAbsoluteTrendPenalty(
        yearAvg,
        normalizeToUnitInterval(
          Object.fromEntries(Object.entries(finiteWeek).filter(([, v]) => Number.isFinite(v)))
        )
      )
    : {};

  const signals: Record<string, MarketThemeSignal> = {};
  for (const theme of uniqueThemes) {
    const hasData = counts[theme] > 0;
    const score = hasData ? normalized[theme] ?? 0.5 : 0.5;
    signals[theme] = {
      score: Number.isFinite(score) ? score : 0.5,
      evidenceCount: counts[theme],
      sources: Array.from(matchedSources[theme]),
    };
  }
  marketSignalCache.set(cacheKey, { signals, cachedAtMs: Date.now() });
  return signals;
}

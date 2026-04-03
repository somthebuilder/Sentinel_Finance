import { Theme } from "../models/theme";
import { PDFParse } from "pdf-parse";
import { getMarketThemeSignals } from "./marketTrendService";
import { getBaseThemes } from "./themeService";

type TavilyResult = {
  title?: string;
  content?: string;
  url?: string;
  score?: number;
};

export type MacroTheme = {
  theme: string;
  keywords: string[];
  strength: number;
  marketScore?: number;
  narrativeScore?: number;
  overlapBoost?: number;
  sourceEvidenceCount?: number;
};

const THEME_MAP: Record<string, string> = {
  railways: "Railways",
  wagon: "Railways",
  defense: "Defense",
  military: "Defense",
  solar: "Energy Transition",
  renewable: "Energy Transition",
  "energy transition": "Energy Transition",
  nbfc: "Financials",
  bank: "Financials",
  banking: "Financials",
  capex: "Capital Goods",
  infrastructure: "Capital Goods",
  "capital goods": "Capital Goods",
  consumer: "Consumption",
  retail: "Consumption",
  consumption: "Consumption",
  ai: "Technology",
  cloud: "Technology",
  "data center": "Technology",
  semiconductor: "Technology",
  copper: "Metals",
  steel: "Metals",
  aluminium: "Metals",
};

const NARRATIVE_THEME_KEYWORDS: Record<string, string[]> = {
  Technology: ["technology", "tech", "software", "ai", "cloud", "semiconductor", "chip", "data center"],
  "Capital Goods": ["capital goods", "industrial", "engineering", "infrastructure", "capex", "order book"],
  Financials: ["financials", "banking", "bank", "nbfc", "credit growth", "loan growth", "deposit growth"],
  Metals: ["metals", "metal", "steel", "aluminium", "copper", "mining"],
  Consumption: ["consumption", "consumer", "fmcg", "retail", "demand", "volume growth"],
  Defense: ["defense", "defence", "aerospace", "military", "security"],
  Railways: ["railways", "railway", "wagon", "rail infra"],
  "Energy Transition": ["energy", "power", "renewable", "solar", "wind", "oil", "gas", "utility", "grid"],
};

const DEFAULT_INCLUDE_DOMAINS = [
  "moneycontrol.com",
  "economictimes.indiatimes.com",
  "business-standard.com",
  "screener.in",
];
const themeCache = new Map<string, { themes: MacroTheme[]; cachedAtMs: number }>();

function getEnv(name: string): string | undefined;
function getEnv(name: string, fallback: string): string;
function getEnv(name: string, fallback?: string) {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return v;
}

function getNarrativeEnv(primary: string, fallback?: string): string | undefined {
  const direct = getEnv(primary);
  if (direct !== undefined) return direct;
  // Backward-compatible alias support: TRAVILY_* <-> TAVILY_*
  if (primary.startsWith("TRAVILY_")) {
    const alt = getEnv(primary.replace(/^TRAVILY_/, "TAVILY_"));
    if (alt !== undefined) return alt;
  }
  if (primary.startsWith("TAVILY_")) {
    const alt = getEnv(primary.replace(/^TAVILY_/, "TRAVILY_"));
    if (alt !== undefined) return alt;
  }
  return fallback;
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

function normalizeText(s: string) {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function buildMacroQuery() {
  return getNarrativeEnv(
    "TRAVILY_MACRO_QUERY",
    "India macro trends sectors growth 2026 infrastructure demand sectoral themes India"
  )!;
}

function parseIncludeDomains(): string[] {
  const raw = getNarrativeEnv("TRAVILY_INCLUDE_DOMAINS");
  if (!raw) return DEFAULT_INCLUDE_DOMAINS;
  return raw
    .split(/[,\n]/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

function sanitizeInputDomain(value: string): string {
  const host = getHostname(value);
  return host;
}

export function mergeNarrativeDomains(customDomains: string[] = []): string[] {
  const merged = new Set<string>();
  for (const d of parseIncludeDomains()) {
    const clean = sanitizeInputDomain(d);
    if (clean) merged.add(clean);
  }
  for (const d of customDomains) {
    const clean = sanitizeInputDomain(d);
    if (clean) merged.add(clean);
  }
  return Array.from(merged).slice(0, 7);
}

function getHostname(input: string | undefined): string {
  if (!input) return "";
  const raw = input.trim();
  if (!raw) return "";
  const candidate = raw.startsWith("http://") || raw.startsWith("https://") ? raw : `https://${raw}`;
  try {
    return new URL(candidate).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function sanitizeNarrativeUrl(input: string): string {
  try {
    const u = new URL(input);
    if (!/^https?:$/i.test(u.protocol)) return "";
    u.hash = "";
    return u.toString();
  } catch {
    return "";
  }
}

function isAllowedDomain(url: string | undefined, includeDomains: string[]): boolean {
  const host = getHostname(url);
  if (!host) return false;
  return includeDomains.some((d) => host === d || host.endsWith(`.${d}`));
}

function isHighSignalResult(r: TavilyResult): boolean {
  const title = normalizeText(r.title ?? "");
  const content = normalizeText(r.content ?? "");
  if (!title && !content) return false;

  // Drop noisy listing/news-index patterns.
  const noisy = /(latest news|videos|photos|page \d+|page-\d+|newsletter|live updates)/i;
  if (noisy.test(r.title ?? "")) return false;
  if ((r.title ?? "").trim().length < 20) return false;
  return true;
}

function dedupeResults(results: TavilyResult[]): TavilyResult[] {
  const seen = new Set<string>();
  const out: TavilyResult[] = [];
  for (const r of results) {
    const key = `${getHostname(r.url)}|${normalizeText(r.title ?? "").slice(0, 120)}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

async function tavilySearch(query: string, includeDomains: string[]): Promise<TavilyResult[]> {
  const apiKey = getNarrativeEnv("TRAVILY_API_KEY");
  const baseUrl = getNarrativeEnv("TRAVILY_BASE_URL", "https://api.tavily.com");
  const timeoutMs = Number(getNarrativeEnv("TAVILY_TIMEOUT_MS", "10000"));
  if (!apiKey) return [];

  const url = `${baseUrl!.replace(/\/$/, "")}/search`;
  try {
    const res = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          query,
          include_domains: includeDomains,
          search_depth: "advanced",
          max_results: 20,
          include_answer: false,
          include_raw_content: false,
        }),
      },
      timeoutMs
    );
    if (!res.ok) return [];

    const json = await res.json().catch(() => null);
    const results: TavilyResult[] = Array.isArray(json?.results) ? json.results : [];
    const filtered = results
      .filter((r) => isAllowedDomain(r.url, includeDomains))
      .filter(isHighSignalResult)
      .sort((a, b) => Number(b.score ?? 0) - Number(a.score ?? 0));
    return dedupeResults(filtered).slice(0, 12);
  } catch (err) {
    console.warn("Tavily search failed, returning empty result set:", err);
    return [];
  }
}

function htmlToText(rawHtml: string): string {
  return rawHtml
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchExactSourceResults(sourceUrls: string[]): Promise<TavilyResult[]> {
  if (!sourceUrls.length) return [];
  const timeoutMs = Number(getEnv("EXACT_SOURCE_TIMEOUT_MS", "6000"));
  const maxTextChars = Number(getEnv("EXACT_SOURCE_MAX_CHARS", "4000"));
  const maxUrls = Number(getEnv("EXACT_SOURCE_MAX_URLS", "2"));
  const maxPdfPages = Number(getEnv("EXACT_SOURCE_MAX_PDF_PAGES", "3"));

  const jobs = sourceUrls.slice(0, Math.max(1, maxUrls)).map(async (rawUrl) => {
    const cleanUrl = sanitizeNarrativeUrl(rawUrl);
    if (!cleanUrl) return null;
    try {
      const res = await fetchWithTimeout(
        cleanUrl,
        {
          method: "GET",
          headers: {
            Accept: "text/html,application/pdf;q=0.9,*/*;q=0.8",
            "User-Agent": "Sentinel-Finance/1.0",
          },
        },
        timeoutMs
      );
      if (!res.ok) return null;

      const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
      const bytes = Buffer.from(await res.arrayBuffer());
      let text = "";
      if (contentType.includes("pdf") || cleanUrl.toLowerCase().includes(".pdf")) {
        const parser = new PDFParse({ data: bytes });
        try {
          const parsed = await parser.getText({ first: maxPdfPages });
          text = parsed?.text ?? "";
        } finally {
          await parser.destroy().catch(() => undefined);
        }
      } else {
        text = htmlToText(bytes.toString("utf8"));
      }
      const clipped = text.slice(0, maxTextChars).trim();
      if (clipped.length < 120) return null;

      return {
        title: `Exact source: ${getHostname(cleanUrl)}`,
        content: clipped,
        url: cleanUrl,
        score: 1,
      } satisfies TavilyResult;
    } catch (err) {
      console.warn("Exact source fetch failed, skipping URL:", cleanUrl, err);
      return null;
    }
  });

  const settled = await Promise.all(jobs);
  const out: TavilyResult[] = [];
  for (const item of settled) {
    if (item) out.push(item);
  }
  return out;
}

function fallbackExtractKeywords(text: string): string[] {
  // Deterministic fallback: pick only controlled-vocab keys that appear in the text.
  const normalized = normalizeText(text);
  const hits: string[] = [];
  for (const k of Object.keys(THEME_MAP)) {
    if (normalized.includes(k)) hits.push(k);
  }
  // Limit to 10.
  return hits.slice(0, 10);
}

async function extractKeywordsAI(text: string): Promise<string[]> {
  // AI is ONLY used here. If not configured, we fall back deterministically.
  const apiKey = getEnv("OPENAI_API_KEY") ?? process.env.openai_API_Key;
  const baseUrl = getEnv("OPENAI_BASE_URL", "https://api.openai.com/v1");
  const model = getEnv("OPENAI_MODEL", "gpt-5-nano");
  const timeoutMs = Number(getEnv("OPENAI_TIMEOUT_MS", "12000"));

  if (!apiKey) return fallbackExtractKeywords(text);

  const prompt = [
    "Extract macro-relevant keywords from this text.",
    "Rules:",
    "- Only economic/sector keywords relevant to India",
    "- No sentences, no punctuation",
    "- Max 10 keywords",
    "- Lowercase",
    "Return ONLY a JSON array of strings.",
    "",
    text.slice(0, 4000),
  ].join("\n");

  const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
  try {
    const res = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
        }),
      },
      timeoutMs
    );
    if (!res.ok) return fallbackExtractKeywords(text);

    const json = await res.json().catch(() => null);
    const content = json?.choices?.[0]?.message?.content;
    if (typeof content !== "string") return fallbackExtractKeywords(text);

    const parsed = JSON.parse(content);
    const arr = Array.isArray(parsed) ? parsed : null;
    if (!arr) return fallbackExtractKeywords(text);
    const cleaned = arr
      .map((s) => (s ?? "").toString().trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 10);
    return cleaned;
  } catch (err) {
    console.warn("OpenAI keyword extraction failed, using deterministic keywords:", err);
    return fallbackExtractKeywords(text);
  }
}

function countKeywordOccurrences(text: string, keyword: string): number {
  const normalizedText = normalizeText(text);
  const normalizedKeyword = normalizeText(keyword);
  if (!normalizedKeyword) return 0;
  let idx = 0;
  let count = 0;
  while (true) {
    idx = normalizedText.indexOf(normalizedKeyword, idx);
    if (idx === -1) break;
    count += 1;
    idx += normalizedKeyword.length;
  }
  return count;
}

function computeNarrativeThemeScores(results: TavilyResult[]): Record<string, { score: number; hits: number }> {
  const POSITIVE_WORDS = [
    "growth",
    "strong",
    "bullish",
    "outperform",
    "expansion",
    "tailwind",
    "improving",
    "rally",
  ];
  const NEGATIVE_WORDS = [
    "weak",
    "bearish",
    "decline",
    "slowdown",
    "headwind",
    "risk",
    "fall",
    "contraction",
  ];
  const themeHits: Record<string, number> = {};
  for (const theme of Object.keys(NARRATIVE_THEME_KEYWORDS)) themeHits[theme] = 0;

  for (const r of results) {
    const text = normalizeText(`${r.title ?? ""} ${r.content ?? ""}`);
    if (!text) continue;
    const sourceWeight = (r.title ?? "").startsWith("Exact source:") ? 1.5 : 1.0;
    const pos = POSITIVE_WORDS.reduce((acc, w) => acc + countKeywordOccurrences(text, w), 0);
    const neg = NEGATIVE_WORDS.reduce((acc, w) => acc + countKeywordOccurrences(text, w), 0);
    const sentiment = (pos - neg) / (pos + neg + 1);
    const sentimentMultiplier = Math.max(0.6, Math.min(1.4, 1 + sentiment * 0.4));
    for (const [theme, kws] of Object.entries(NARRATIVE_THEME_KEYWORDS)) {
      let hit = 0;
      for (const kw of kws) {
        hit += countKeywordOccurrences(text, kw);
      }
      if (hit > 0) themeHits[theme] += hit * sourceWeight * sentimentMultiplier;
    }
  }

  const out: Record<string, { score: number; hits: number }> = {};
  for (const [theme, hits] of Object.entries(themeHits)) {
    const score = Math.max(0, Math.min(1, Math.log1p(hits) / Math.log1p(25)));
    out[theme] = { score: Number(score.toFixed(4)), hits: Math.round(hits) };
  }
  return out;
}

export function buildThemesFromKeywords(keywords: string[], corpus: string, results: TavilyResult[]): MacroTheme[] {
  const buckets: Record<string, { theme: string; keywords: string[]; keywordHits: number; articleHits: number; strength: number }> = {};
  for (const kw of keywords) {
    const k = normalizeText(kw);
    const theme = THEME_MAP[k];
    if (!theme) continue;
    if (!buckets[theme]) buckets[theme] = { theme, keywords: [], keywordHits: 0, articleHits: 0, strength: 0 };
    if (!buckets[theme].keywords.includes(k)) buckets[theme].keywords.push(k);

    const keywordHits = countKeywordOccurrences(corpus, k);
    const articleHits = results.filter((r) => normalizeText(`${r.title ?? ""} ${r.content ?? ""}`).includes(k)).length;
    buckets[theme].keywordHits += keywordHits;
    buckets[theme].articleHits += articleHits;
  }

  const themes = Object.values(buckets).map((b) => {
    // Theme strength from article + keyword evidence, normalized to [0..1].
    const raw = Math.log1p(b.articleHits + b.keywordHits);
    const strength = Math.max(0, Math.min(1, raw / Math.log1p(25)));
    return { theme: b.theme, keywords: b.keywords, strength: Number(strength.toFixed(4)) };
  });

  return themes
    .filter((t) => t.strength > 0.05)
    .sort((a, b) => b.strength - a.strength)
    .slice(0, 6);
}

export async function getDynamicMacroThemes(
  customDomains: string[] = [],
  sourceUrls: string[] = [],
  forceRefresh = false
): Promise<MacroTheme[]> {
  const ttlMs = Number(getEnv("THEMES_CACHE_TTL_MS", "7200000") ?? "7200000");
  const includeDomains = mergeNarrativeDomains(customDomains);
  const exactUrls = sourceUrls.map(sanitizeNarrativeUrl).filter(Boolean).slice(0, 7);
  const cacheKey = `${includeDomains.join("|")}||${exactUrls.join("|")}`;
  const cached = themeCache.get(cacheKey);
  if (!forceRefresh && cached && Date.now() - cached.cachedAtMs < ttlMs) return cached.themes;

  const [tavilyResults, exactSourceResults] = await Promise.all([
    tavilySearch(buildMacroQuery(), includeDomains),
    fetchExactSourceResults(exactUrls),
  ]);
  const results = dedupeResults([...exactSourceResults, ...tavilyResults]);
  const corpus = results
    .map((r) => `${r.title ?? ""}\n${(r.content ?? "").slice(0, 320)}`.trim())
    .filter(Boolean)
    .join("\n\n");

  const keywords = await extractKeywordsAI(corpus);
  const narrativeThemes = buildThemesFromKeywords(keywords, corpus, results);
  const narrativeMap = new Map<string, MacroTheme>(narrativeThemes.map((t) => [t.theme, t]));
  const narrativeSignals = computeNarrativeThemeScores(results);
  const knownThemeNames = Array.from(new Set(Object.values(THEME_MAP)));
  const marketSignals = await getMarketThemeSignals(knownThemeNames);
  const overlapWeight = Number(getEnv("THEME_OVERLAP_BOOST_WEIGHT", "0.2"));

  const themes: MacroTheme[] = knownThemeNames
    .map((themeName) => {
      const narrative = narrativeMap.get(themeName);
      const narrativeScore = Number(
        narrativeSignals[themeName]?.score ??
          narrative?.strength ??
          0
      );
      const marketScore = Number(marketSignals[themeName]?.score ?? 0.5);
      const overlapBoost = Math.max(0, Math.min(0.25, overlapWeight * Math.min(narrativeScore, marketScore)));
      const base = 0.5 * narrativeScore + 0.5 * marketScore;
      const strength = Math.max(0, Math.min(1, base + overlapBoost));
      const sourceEvidenceCount = Number(
        (marketSignals[themeName]?.evidenceCount ?? 0) + (narrativeSignals[themeName]?.hits ?? 0)
      );
      return {
        theme: themeName,
        keywords: narrative?.keywords ?? [],
        strength: Number(strength.toFixed(4)),
        marketScore: Number(marketScore.toFixed(4)),
        narrativeScore: Number(narrativeScore.toFixed(4)),
        overlapBoost: Number(overlapBoost.toFixed(4)),
        sourceEvidenceCount,
      };
    })
    .filter((t) => t.strength > 0.05)
    .sort((a, b) => b.strength - a.strength)
    .slice(0, 8);

  themeCache.set(cacheKey, { themes, cachedAtMs: Date.now() });
  return themes;
}

export function macroThemesToThemeModels(macroThemes: MacroTheme[]): Theme[] {
  const baseThemeMap = new Map(getBaseThemes().map((b) => [b.theme.toLowerCase(), b]));
  return macroThemes.map((t) => ({
    ...(baseThemeMap.get(t.theme.toLowerCase()) ?? {}),
    theme: t.theme,
    sectors: (baseThemeMap.get(t.theme.toLowerCase())?.sectors ?? [t.theme]).slice(0, 10),
    keywords: (t.keywords.length ? t.keywords : baseThemeMap.get(t.theme.toLowerCase())?.keywords ?? []).slice(0, 12),
    rationale: `Macro theme strength: ${t.strength}. Blend = 50% market trend + 50% user-source narrative, overlap boost ${t.overlapBoost ?? 0}.`,
    strength: t.strength,
    marketScore: t.marketScore,
    narrativeScore: t.narrativeScore,
    overlapBoost: t.overlapBoost,
    sourceEvidenceCount: t.sourceEvidenceCount,
  }));
}


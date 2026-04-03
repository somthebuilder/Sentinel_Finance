import { Theme } from "../models/theme";

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

function normalizeText(s: string) {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function buildMacroQuery() {
  return getEnv(
    "TRAVILY_MACRO_QUERY",
    "India macro trends sectors growth 2026 infrastructure demand sectoral themes India"
  );
}

function parseIncludeDomains(): string[] {
  const raw = getEnv("TRAVILY_INCLUDE_DOMAINS");
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
  const apiKey = getEnv("TRAVILY_API_KEY");
  const baseUrl = getEnv("TRAVILY_BASE_URL", "https://api.tavily.com");
  if (!apiKey) return [];

  const url = `${baseUrl.replace(/\/$/, "")}/search`;
  const res = await fetch(url, {
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
  });

  const json = await res.json().catch(() => null);
  const results: TavilyResult[] = Array.isArray(json?.results) ? json.results : [];
  const filtered = results
    .filter((r) => isAllowedDomain(r.url, includeDomains))
    .filter(isHighSignalResult)
    .sort((a, b) => Number(b.score ?? 0) - Number(a.score ?? 0));
  return dedupeResults(filtered).slice(0, 12);
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
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
      }),
    });

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

export async function getDynamicMacroThemes(customDomains: string[] = []): Promise<MacroTheme[]> {
  const ttlMs = Number(getEnv("THEMES_CACHE_TTL_MS", "7200000") ?? "7200000");
  const includeDomains = mergeNarrativeDomains(customDomains);
  const cacheKey = includeDomains.join("|");
  const cached = themeCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAtMs < ttlMs) return cached.themes;

  const results = await tavilySearch(buildMacroQuery(), includeDomains);
  const corpus = results
    .map((r) => `${r.title ?? ""}\n${(r.content ?? "").slice(0, 320)}`.trim())
    .filter(Boolean)
    .join("\n\n");

  const keywords = await extractKeywordsAI(corpus);
  const themes = buildThemesFromKeywords(keywords, corpus, results);
  themeCache.set(cacheKey, { themes, cachedAtMs: Date.now() });
  return themes;
}

export function macroThemesToThemeModels(macroThemes: MacroTheme[]): Theme[] {
  return macroThemes.map((t) => ({
    theme: t.theme,
    sectors: [t.theme],
    keywords: t.keywords,
    rationale: `Macro theme strength: ${t.strength}. Watch news flow and sector tailwinds related to: ${t.keywords.join(", ")}.`,
    strength: t.strength,
  }));
}


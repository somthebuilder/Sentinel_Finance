import { Theme } from "../models/theme";
import { Stock } from "../models/stock";
import { enrichThemeDriversWithTavily } from "./tavilyService";

// Deterministic base themes. Tavily enriches `drivers` for copy; theme strength in recommendations is mostly market breadth, not narrative.
const BASE_THEMES: Theme[] = [
  {
    theme: "Technology",
    sectors: ["Technology", "Semiconductors", "Software", "Cloud"],
    keywords: ["ai", "machine learning", "artificial intelligence", "software", "cloud", "semiconductor", "chip", "automation", "data", "robotics"],
    rationale:
      "Look for exposure to AI/data workloads, chips/semiconductors, software modernization, and automation/cloud adoption.",
  },
  {
    theme: "Energy",
    sectors: ["Energy", "Oil & Gas", "Renewables", "Utilities"],
    keywords: ["energy", "oil", "gas", "renewable", "solar", "wind", "hydrogen", "battery", "grid"],
    rationale:
      "Look for energy transition beneficiaries: renewables/solar/wind plus grid/storage themes, and resilient demand from power/commodity cycles.",
  },
  {
    theme: "Growth",
    sectors: ["Growth", "Consumer Discretionary", "Industrials"],
    keywords: ["growth", "revenue", "earnings", "expansion", "margin", "profit", "demand"],
    rationale:
      "Look for strong revenue/earnings momentum: margin expansion, demand acceleration, and expansion capacity.",
  },
  {
    theme: "Healthcare",
    sectors: ["Healthcare", "Biotech", "Pharma", "Medical", "Pharmaceuticals", "Biotechnology"],
    keywords: [
      "health",
      "healthcare",
      "biotech",
      "pharma",
      "pharmaceutical",
      "pharmaceuticals",
      "biotechnology",
      "medical",
      "drug",
      "vaccine",
    ],
    rationale:
      "Look for healthcare innovation/rollout: biotech/pharma pipeline updates, drug demand, and medical spend resilience.",
  },
  {
    theme: "Consumer",
    sectors: ["Consumer", "Retail", "E-Commerce", "Subscriptions"],
    keywords: ["consumer", "retail", "ecommerce", "spending", "brand", "commerce", "subscription"],
    rationale:
      "Look for consumer demand: retail/ecommerce growth, brand strength, and subscription/recurring revenue models.",
  },
  {
    theme: "Defense",
    sectors: ["Defense", "Aerospace", "Security", "Cybersecurity"],
    keywords: ["defense", "aerospace", "security", "cyber", "surveillance"],
    rationale:
      "Look for security/cyber/aerospace beneficiaries: defense spending tailwinds and cybersecurity adoption.",
  },
];

function normalizeToken(s: string) {
  return s.trim().toLowerCase();
}

function tokenize(s: string): string[] {
  return normalizeToken(s)
    .replace(/&/g, " ")
    .split(/[^a-z0-9]+/g)
    .map((x) => x.trim())
    .filter((x) => x.length >= 3);
}

function normalizeThemeName(name: string): string {
  const cleaned = name.replace(/\s+/g, " ").trim();
  const words = cleaned.split(" ").filter(Boolean);
  // Limit to 2-3 words for clean UI.
  const limited = words.slice(0, 3).join(" ");
  return limited
    .split(" ")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(" ");
}

export type ThemeRelevanceDetails = {
  themeRelevance: number;
  sectorMatch: 0 | 1;
  subSectorMatch: 0 | 1;
  matchedTags: string[];
};

export function getBaseThemes(): Theme[] {
  return BASE_THEMES.map((t) => ({
    ...t,
    theme: normalizeThemeName(t.theme),
    sectors: [...t.sectors],
    keywords: [...t.keywords],
  }));
}

// Matching is deterministic and rule-based:
// - sector match weight = 0.5
// - subsector match weight = 0.2
// - tag/keyword overlap weight = 0.3
export function calculateThemeRelevanceDetails(stock: Stock, theme: Theme): ThemeRelevanceDetails {
  const themeSectors = new Set(theme.sectors.map((s) => normalizeToken(s)));
  const themeSectorTokens = new Set(theme.sectors.flatMap(tokenize));
  const normalizedSector = normalizeToken(stock.sector ?? "");
  const sectorUnknown = !normalizedSector || normalizedSector === "unknown" || normalizedSector === "na" || normalizedSector === "n/a";
  const sectorTokens = new Set(tokenize(stock.sector ?? ""));
  const subSectorTokens = new Set(tokenize(stock.subSector ?? ""));
  const hasTokenIntersection = (a: Set<string>, b: Set<string>) => {
    for (const x of a) if (b.has(x)) return true;
    return false;
  };

  /** Long-form screener tokens ("pharmaceuticals") vs theme keywords ("pharma"). */
  function tokensRelate(a: string, b: string): boolean {
    if (a === b) return true;
    const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
    if (shorter.length < 3) return false;
    return longer.startsWith(shorter);
  }

  function hasFlexibleTokenIntersection(a: Set<string>, b: Set<string>) {
    for (const x of a) {
      if (b.has(x)) return true;
      for (const y of b) {
        if (tokensRelate(x, y)) return true;
      }
    }
    return false;
  }

  const sectorMatch: 0 | 1 =
    themeSectors.has(normalizedSector) ||
    hasTokenIntersection(sectorTokens, themeSectorTokens) ||
    hasFlexibleTokenIntersection(sectorTokens, themeSectorTokens)
      ? 1
      : 0;
  const subSectorMatch: 0 | 1 =
    !!stock.subSector &&
    (themeSectors.has(normalizeToken(stock.subSector)) ||
      hasTokenIntersection(subSectorTokens, themeSectorTokens) ||
      hasFlexibleTokenIntersection(subSectorTokens, themeSectorTokens))
      ? 1
      : 0;

  const tagSet = new Set<string>();
  for (const t of stock.tags) {
    const n = normalizeToken(t);
    if (n) tagSet.add(n);
    for (const tk of tokenize(t)) tagSet.add(tk);
  }
  const keywordSet = new Set<string>();
  for (const k of theme.keywords) {
    const n = normalizeToken(k);
    if (n) keywordSet.add(n);
    for (const tk of tokenize(k)) keywordSet.add(tk);
  }

  // Tag/keyword alignment: strict hits plus prefix-style hits (screener vs macro vocabulary).
  const matchedTags = new Set<string>();
  for (const t of tagSet) {
    if (keywordSet.has(t)) {
      matchedTags.add(t);
      continue;
    }
    for (const k of keywordSet) {
      if (tokensRelate(t, k)) {
        matchedTags.add(t);
        break;
      }
    }
  }
  const unionSize = new Set<string>([...tagSet, ...keywordSet]).size;
  const jaccardLike = unionSize > 0 ? matchedTags.size / unionSize : 0;
  // Floor so a single strong token (e.g. "pharmaceuticals" ~ "pharma") still moves the needle.
  const hitFloor = matchedTags.size >= 2 ? 0.42 : matchedTags.size >= 1 ? 0.28 : 0;
  const overlap = Math.max(jaccardLike, hitFloor);

  // If sector is unknown, rely on tag-keyword alignment (deterministic fallback).
  const themeRelevance = sectorUnknown
    ? Math.max(0, Math.min(1, overlap))
    : 0.5 * sectorMatch + 0.2 * subSectorMatch + 0.3 * overlap;

  return {
    themeRelevance,
    sectorMatch,
    subSectorMatch,
    matchedTags: Array.from(matchedTags).slice(0, 4),
  };
}

export function calculateThemeRelevance(stock: Stock, theme: Theme): number {
  return calculateThemeRelevanceDetails(stock, theme).themeRelevance;
}

export async function getThemesForMvp(): Promise<Theme[]> {
  const themes = getBaseThemes();
  const apiKey = process.env.TRAVILY_API_KEY;
  if (!apiKey) return themes;

  // Enrich only a few themes to keep API usage reasonable.
  const enrichCount = Math.min(3, themes.length);
  const enriched = await Promise.all(
    themes.slice(0, enrichCount).map((t) => enrichThemeDriversWithTavily(t))
  );

  return themes.map((t, i) => {
    if (i >= enrichCount) return t;
    const drivers = enriched[i]?.drivers ?? [];
    return { ...t, drivers };
  });
}


import { z } from "zod";

import {
  computeMacroSectorAlignmentFloat,
  detectMacroDriver,
  floatToMacroTriplet,
  getRegime,
  macroDriverDisplayLabel,
  type MacroDriver,
  type MacroRegime,
} from "../data/macroSectorMap";
import { getSectorForIndustry } from "../data/industrySectorMapping";
import { buildMacroHumanUi } from "../data/macroHumanUi";
import { getDynamicMacroThemes, macroThemesToThemeModels } from "./macroThemeService";
import type { Theme } from "../models/theme";

export type { MacroDriver, MacroRegime } from "../data/macroSectorMap";
export { getRegime, macroDriverDisplayLabel } from "../data/macroSectorMap";

/**
 * Trendlyne sector/industry weekly JSON (industry-level metrics).
 * @see https://trendlyne.com/equity/sector-industry-analysis/overall/week-changeP/?format=json
 */
const TRENDLYNE_MARKET_JSON =
  "https://trendlyne.com/equity/sector-industry-analysis/overall/week-changeP/?format=json";

// ——— Macro (deterministic) ———

export const macroInputSchema = z.object({
  rates: z.enum(["Rising", "Stable", "Falling"]),
  inflation: z.enum(["Rising", "Stable", "Cooling"]),
  yields: z.enum(["Rising", "Stable", "Falling"]),
  growth: z.enum(["Slowing", "Expanding", "Contracting"]),
});

export type MacroInput = z.infer<typeof macroInputSchema>;

export const defaultMacroInput: MacroInput = {
  rates: "Stable",
  inflation: "Stable",
  yields: "Rising",
  growth: "Expanding",
};

export type MacroVector = {
  rates: number;
  inflation: number;
  yields: number;
  growth: number;
};

const RATES_MAP: Record<MacroInput["rates"], number> = { Rising: -1, Stable: 0, Falling: 1 };
const INFLATION_MAP: Record<MacroInput["inflation"], number> = { Rising: -1, Stable: 0, Cooling: 1 };
const YIELDS_MAP: Record<MacroInput["yields"], number> = { Rising: -1, Stable: 0, Falling: 1 };
const GROWTH_MAP: Record<MacroInput["growth"], number> = {
  Slowing: -1,
  Expanding: 1,
  Contracting: -1,
};

export function computeMacroVector(input: MacroInput): MacroVector {
  return {
    rates: RATES_MAP[input.rates],
    inflation: INFLATION_MAP[input.inflation],
    yields: YIELDS_MAP[input.yields],
    growth: GROWTH_MAP[input.growth],
  };
}

export function computeMacroScore(input: MacroInput): number {
  const v = computeMacroVector(input);
  return (v.rates + v.inflation + v.yields + v.growth) / 4;
}

export function detectRegime(macroScore: number): MacroRegime {
  return getRegime(macroScore);
}

function macroLabel(input: MacroInput, regime: MacroRegime, driver: MacroDriver): string {
  if (driver === "CONFLICTED") {
    return "What wins: names with earnings visibility, balance-sheet quality, and sector tailwinds where flows still meet fundamentals. What struggles: fragile leverage and long-duration hype without cash flows. Liquidity does not reward indiscriminate beta — be selective.";
  }

  const bits: string[] = [];
  if (input.rates === "Rising") bits.push("tighter rates");
  else if (input.rates === "Falling") bits.push("easier rates");
  if (input.inflation === "Rising") bits.push("hot inflation");
  else if (input.inflation === "Cooling") bits.push("cooling inflation");
  if (input.yields === "Rising") bits.push("higher yields");
  else if (input.yields === "Falling") bits.push("falling yields");
  if (input.growth === "Contracting") bits.push("contracting growth");
  else if (input.growth === "Slowing") bits.push("slowing growth");
  else bits.push("expanding growth");

  const regimeHint: Record<MacroRegime, string> = {
    RISK_OFF: "Risk-off: prioritize capital preservation and defensive tilts.",
    NEUTRAL:
      "Mixed macro: no single dominant force. Size ideas on evidence — momentum, breadth, and sector fit — not on headline macro alone.",
    MILD_RISK_ON: "Constructive but not euphoric: size beta with discipline.",
    STRONG_RISK_ON: "Broad risk-on: growth and beta generally favoured.",
  };
  const driverHint: Record<MacroDriver, string> = {
    BALANCED: "",
    CONFLICTED: "",
    GROWTH_LED: " Driver: growth-led (industrials / capex tilt).",
    LIQUIDITY_TIGHT: " Driver: yield pressure tightening financial conditions.",
    LIQUIDITY_LED: " Driver: easier liquidity (rates & yields falling).",
    INFLATION_LED: " Driver: inflation-led (commodities / energy; watch consumption).",
  };
  return `${bits.join(" · ")}. ${regimeHint[regime]}${driverHint[driver]}`;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

// ——— Industry raw (normalized after fetch) ———

export type IndustryNormalized = {
  name: string;
  weekly_change: number;
  advances: number;
  declines: number;
  pe: number | null;
  roe: number | null;
  sector: string;
};

export type IndustryComputed = {
  name: string;
  sector: string;
  tags: string[];
  momentum_score: number;
  breadth_score: number;
  /** Weekly return vs same-sector average (snapshot percentile 0–1). */
  relative_strength_score: number;
  quality_score: number;
  macro_alignment: -1 | 0 | 1;
  /** Raw macro sector alignment in [-1, 1] before triplet mapping (same for all industries in an NSE sector). */
  macro_alignment_float: number;
  final_score: number;
  classification: "BUY" | "WATCH" | "AVOID";
};

/** Top industries within a sector (capital-flow primary view). */
export type SectorIndustryPin = {
  name: string;
  final_score: number;
  classification: "BUY" | "WATCH" | "AVOID";
  macro_alignment: -1 | 0 | 1;
  momentum_score: number;
  breadth_score: number;
  relative_strength_score: number;
  /** Rank in the global industry list (by final_score). */
  global_rank: number;
  /** 1-based rank within this NSE sector. */
  rank_within_sector: number;
};

export type SectorSignalStrength = "STRONG" | "MODERATE" | "WEAK";

export type SectorView = {
  sector: string;
  /** Mean of top industry final_scores in this sector (up to 2 pinned). */
  sector_score: number;
  /** Same macro alignment float as any industry row in this sector. */
  alignment: number;
  macro_alignment: -1 | 0 | 1;
  /** Short label for UI. */
  macro_alignment_label: "Tailwind" | "Neutral" | "Headwind";
  /** One-line macro + driver context for cards. */
  macro_line: string;
  /** Mean momentum (0–1) across pinned industries in this sector. */
  avg_momentum: number;
  /** Mean breadth (0–1) across pinned industries. */
  avg_breadth: number;
  signal_strength: SectorSignalStrength;
  /** @deprecated Prefer `participation_line` in UI. */
  signal_summary: string;
  /** One compressed line: tape + participation (no raw score dump). */
  participation_line: string;
  /** Single supporting sentence — not keyword bullets. */
  why_one_liner: string;
  industries: SectorIndustryPin[];
  /** Legacy keyword list (kept API-compat); UI should use `why_one_liner`. */
  narrative: string[];
  /** @deprecated Use `narrative`; kept for older clients. */
  narrative_hints: string[];
};

export type IndustryIntelligencePayload = {
  macro: {
    score: number;
    regime: MacroRegime;
    label: string;
    input: MacroInput;
    /** Internal model weights — not shown in the main UI. */
    vector: MacroVector;
    driver: MacroDriver;
    /** Short UI string for `driver` */
    driver_label: string;
    /** Human headline instead of raw score. */
    human_headline: string;
    growth_liquidity_note: string;
    regime_chip: string;
    sector_bias: string[];
    sector_bias_line: string;
  };
  /** Sectors ranked by sector_score; each lists top 2 industries. */
  top_sectors: SectorView[];
  top_industries: IndustryComputed[];
  avoid_list: IndustryComputed[];
  insight: string;
};

function buildMacroPayloadBlock(
  macro: MacroInput,
  macroScore: number,
  regime: MacroRegime,
  vector: MacroVector,
  driver: MacroDriver,
  label: string
): IndustryIntelligencePayload["macro"] {
  const human = buildMacroHumanUi(macro, regime, driver, macroScore);
  return {
    score: round4(macroScore),
    regime,
    label,
    input: macro,
    vector,
    driver,
    driver_label: macroDriverDisplayLabel(driver),
    ...human,
  };
}

// ——— Tag inference (hardcoded rules; expand over time) ———

function inferTags(name: string, sector: string): string[] {
  const n = `${name} ${sector}`.toLowerCase();
  const tags = new Set<string>();

  const rules: { test: (s: string) => boolean; tags: string[] }[] = [
    { test: (s) => /bank|nbfc|finance|insurance|life insurance|asset management|capital market/.test(s), tags: ["financial", "rate_sensitive"] },
    { test: (s) => /metal|steel|aluminium|copper|mining|commodity/.test(s), tags: ["commodity", "cyclical"] },
    { test: (s) => /oil|gas|petro|energy|power|utility|renewable|electric/.test(s), tags: ["energy", "commodity"] },
    { test: (s) => /software|it consulting|data processing|internet software|hardware technology|telecom/.test(s), tags: ["export", "defensive"] },
    { test: (s) => /fmcg|packaged food|personal product|tobacco|beverage|household|consumer durables/.test(s), tags: ["consumption", "defensive"] },
    { test: (s) => /realty|real estate|housing|construction/.test(s), tags: ["rate_sensitive", "cyclical"] },
    { test: (s) => /pharma|healthcare|hospital|biotech/.test(s), tags: ["defensive", "export"] },
    { test: (s) => /auto|tyre|vehicle|auto parts/.test(s), tags: ["cyclical", "consumption"] },
    { test: (s) => /cement|capital goods|engineering|industrial machinery/.test(s), tags: ["cyclical", "commodity"] },
    { test: (s) => /chemical|fertilizer|agrochemical/.test(s), tags: ["cyclical", "commodity"] },
    { test: (s) => /textile|apparel|retail/.test(s), tags: ["export", "consumption"] },
    { test: (s) => /defence|aerospace/.test(s), tags: ["cyclical", "export"] },
  ];

  for (const r of rules) {
    if (r.test(n)) for (const t of r.tags) tags.add(t);
  }

  if (!tags.size) tags.add("cyclical");
  return Array.from(tags);
}

function qualityScore(pe: number | null, roe: number | null): number {
  const peN = pe !== null && Number.isFinite(pe) ? pe : 25;
  const roeN = roe !== null && Number.isFinite(roe) ? roe : 10;
  const roeScore = Math.min(roeN / 20, 1);
  const pePenalty = Math.max(0, (peN - 25) / 25);
  return Math.max(0, Math.min(1, roeScore - pePenalty));
}

function breadthScore(advances: number, declines: number): number {
  const a = Math.max(0, advances);
  const d = Math.max(0, declines);
  const tot = a + d;
  if (tot <= 0) return 0.5;
  const raw = (a - d) / tot;
  return (raw + 1) / 2;
}

/** Average-rank percentile in [0, 1]; stable under ties (vs min–max on raw returns). */
function percentileRank01(values: number[]): number[] {
  const n = values.length;
  if (n === 0) return [];
  if (n === 1) return [0.5];
  const idx = values.map((v, i) => ({ v, i }));
  idx.sort((a, b) => a.v - b.v);
  const out = new Array<number>(n);
  let start = 0;
  while (start < n) {
    let end = start;
    while (end + 1 < n && idx[end + 1].v === idx[start].v) end++;
    const avgRank = (start + 1 + end + 1) / 2;
    const p = (avgRank - 1) / (n - 1);
    for (let k = start; k <= end; k++) out[idx[k].i] = p;
    start = end + 1;
  }
  return out;
}

function classify(finalScore: number): "BUY" | "WATCH" | "AVOID" {
  if (finalScore > 0.7) return "BUY";
  if (finalScore >= 0.55) return "WATCH";
  return "AVOID";
}

/**
 * Stronger penalty/reward when sector macro alignment is clearly wrong/right vs neutral.
 * CONFLICTED driver: no extra boost/penalty — macro is informational only.
 */
function applyAlignmentConfidenceBoost(alignmentFloat: number, driver: MacroDriver): number {
  if (driver === "CONFLICTED") return alignmentFloat;
  if (alignmentFloat <= -0.3) return Math.max(-1, alignmentFloat - 0.12);
  if (alignmentFloat >= 0.3) return Math.min(1, alignmentFloat + 0.1);
  return alignmentFloat;
}

/**
 * Momentum 0.40 (0.45 when CONFLICTED), breadth 0.20, macro 0.15 (0.10 when CONFLICTED),
 * relative strength 0.15, quality 0.10. Narrative is not scored — themes only refine copy.
 */
function finalScore(
  momentum: number,
  breadth: number,
  relativeStrength: number,
  quality: number,
  alignmentFloat: number,
  driver: MacroDriver
): number {
  const align01 = (alignmentFloat + 1) / 2;
  const wMacro = driver === "CONFLICTED" ? 0.1 : 0.15;
  const wMom = driver === "CONFLICTED" ? 0.45 : 0.4;
  return (
    wMom * momentum +
    0.2 * breadth +
    wMacro * align01 +
    0.15 * relativeStrength +
    0.1 * quality
  );
}

function macroAlignmentLabel(m: -1 | 0 | 1): "Tailwind" | "Neutral" | "Headwind" {
  if (m === 1) return "Tailwind";
  if (m === -1) return "Headwind";
  return "Neutral";
}

/** Display-only hints from sector name (not scored). */
function inferSectorNarrativeHints(sector: string): string[] {
  const s = sector.toLowerCase();
  const o: string[] = [];
  if (/(cement|construction|infra|transport|highway|road)/.test(s)) o.push("Infra / mobility / capex");
  if (/(bank|finance|nbfc)/.test(s)) o.push("Credit cycle & rates");
  if (/(oil|gas|mining|metal|power|utility)/.test(s)) o.push("Commodity & energy");
  if (/(software|hardware|telecom|data)/.test(s)) o.push("Tech & connectivity");
  if (/(fmcg|retail|consumer|auto|vehicle|tyre)/.test(s)) o.push("Consumption lever");
  if (/(pharma|health|hospital|bio)/.test(s)) o.push("Healthcare demand");
  if (/(real|realty|housing)/.test(s)) o.push("Housing / rate sensitivity");
  if (/(chemical|fertil|agro)/.test(s)) o.push("Agri & chemicals");
  if (/(textile|apparel|garment)/.test(s)) o.push("Export & discretionary");
  return o.slice(0, 3);
}

function buildMacroLine(
  label: "Tailwind" | "Neutral" | "Headwind",
  driverLabel: string
): string {
  const head =
    label === "Tailwind" ? "Macro tailwind" : label === "Headwind" ? "Macro headwind" : "Macro neutral";
  if (driverLabel && driverLabel !== "Balanced") return `${head} · ${driverLabel}`;
  return head;
}

function buildParticipationLine(
  strength: SectorSignalStrength,
  avgMomentum: number,
  avgBreadth: number
): string {
  const momHi = avgMomentum >= 0.55;
  const brHi = avgBreadth >= 0.55;
  const momLo = avgMomentum <= 0.42;
  const brLo = avgBreadth <= 0.45;

  if (strength === "STRONG") {
    if (momHi && brHi) return "Strong trend with broad participation.";
    if (brHi) return "Solid breadth with supportive momentum.";
    return "Aligned tape — participation holding up.";
  }
  if (strength === "WEAK") {
    if (momLo && brLo) return "Soft momentum and thin breadth — be selective.";
    if (momLo) return "Momentum fading — breadth mixed.";
    return "Headwinds on participation — risk-off skew.";
  }
  if (momHi && !brHi) return "Good momentum, average breadth — verify follow-through.";
  if (!momHi && brHi) return "Breadth OK, momentum mixed — chase selectively.";
  return "Mixed tape — no clear one-way conviction.";
}

function computeSectorSignal(
  macroTriplet: -1 | 0 | 1,
  macroFloat: number,
  avgMomentum: number,
  avgBreadth: number
): { strength: SectorSignalStrength; summary: string; participation_line: string } {
  const macroPos = macroTriplet === 1 || macroFloat >= 0.18;
  const macroNeg = macroTriplet === -1 || macroFloat <= -0.18;
  const momPos = avgMomentum >= 0.5;
  const momNeg = avgMomentum <= 0.42;
  const brPos = avgBreadth >= 0.5;
  const brNeg = avgBreadth <= 0.46;

  const aligned = [macroPos, momPos, brPos].filter(Boolean).length;
  const against = [macroNeg, momNeg, brNeg].filter(Boolean).length;

  let strength: SectorSignalStrength;
  if (aligned >= 3) strength = "STRONG";
  else if (against >= 2) strength = "WEAK";
  else strength = "MODERATE";

  const participation_line = buildParticipationLine(strength, avgMomentum, avgBreadth);
  return { strength, summary: participation_line, participation_line };
}

const SECTOR_WHY_SNIPPETS: { re: RegExp; line: string }[] = [
  { re: /transport|logistics|shipping|freight|surface/i, line: "Mobility and freight demand anchoring logistics-heavy names." },
  { re: /metal|mining|steel|alumin/i, line: "Commodity cycle and capacity tightness driving the metals complex." },
  { re: /utility|power|electric/i, line: "Defensive yield and regulated demand supporting utilities." },
  { re: /software|data processing|it|hardware|telecom/i, line: "Digital spend and services resilience underpinning tech-linked flows." },
  { re: /consumer|retail|fmcg|durables/i, line: "Consumption trajectory and pricing power matter for discretionary exposure." },
  { re: /commercial service|supplies|diversified service/i, line: "Services demand and operating leverage driving commercial exposures." },
  { re: /bank|finance|nbfc/i, line: "Credit growth and rate path dominate financials here." },
  { re: /health|pharma|biotech/i, line: "Healthcare demand and export mix support defensives in this bucket." },
  { re: /real|realty|construction|cement/i, line: "Rates and project pipeline set the tone for housing-linked names." },
  { re: /auto|vehicle|tyre/i, line: "Cycle demand and input costs swing auto exposures." },
  { re: /chemical|fertil|agro/i, line: "Agri and input costs drive chemical sector moves." },
];

function buildInitialWhyLine(sector: string, regime: MacroRegime, driver: MacroDriver): string {
  for (const { re, line } of SECTOR_WHY_SNIPPETS) {
    if (re.test(sector)) return line;
  }
  if (driver === "CONFLICTED") {
    return "Growth is improving while yields keep liquidity tight — stay selective within the sector.";
  }
  if (regime === "RISK_OFF") {
    return "Risk-off backdrop: prioritize quality and balance-sheet resilience.";
  }
  if (regime === "STRONG_RISK_ON" || regime === "MILD_RISK_ON") {
    return "Risk appetite supports beta — still match names to your risk budget.";
  }
  return "Sector moves reflect the current macro blend and intra-sector leadership.";
}

function dedupeKeywordSoup(items: string[]): string[] {
  const raw = items.map((x) => x.trim()).filter(Boolean);
  const out: string[] = [];
  const seenNorm = new Set<string>();
  for (const x of raw) {
    const norm = x
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/^(railways?|rail)\b/i, "rail")
      .trim();
    if (norm.length < 4) continue;
    let dup = false;
    for (const s of seenNorm) {
      if (norm.includes(s) || s.includes(norm)) {
        dup = true;
        break;
      }
    }
    if (dup) continue;
    seenNorm.add(norm);
    out.push(x);
    if (out.length >= 2) break;
  }
  return out;
}

function refineWhyOneLiner(base: string, mergedKeywords: string[]): string {
  const clean = dedupeKeywordSoup(mergedKeywords);
  const phrase = clean.find((k) => k.length >= 22);
  if (phrase) {
    const cap = phrase.charAt(0).toUpperCase() + phrase.slice(1);
    return cap.endsWith(".") ? cap : `${cap}.`;
  }
  return base;
}

function themeTouchesNseSector(theme: Theme, nseLower: string, nseWords: string[]): boolean {
  for (const s of theme.sectors ?? []) {
    const t = s.toLowerCase().trim();
    if (t.length < 2) continue;
    if (nseLower.includes(t)) return true;
    for (const w of nseWords) {
      if (w.length > 2 && (t.includes(w) || nseLower.includes(w))) return true;
    }
  }
  const tn = (theme.theme || "").toLowerCase();
  if (tn.length > 2) {
    if (nseLower.includes(tn)) return true;
    for (const w of nseWords) {
      if (w.length > 2 && tn.includes(w)) return true;
    }
  }
  for (const kw of (theme.keywords ?? []).slice(0, 14)) {
    const k = kw.toLowerCase();
    if (k.length < 4) continue;
    if (nseLower.includes(k)) return true;
  }
  return false;
}

/** Merge theme keywords; refine `why_one_liner` when a substantive phrase appears (deduped). */
export function mergeThemeNarrativeIntoSectors(sectors: SectorView[], themes: Theme[]): SectorView[] {
  return sectors.map((s) => {
    const base = [...(s.narrative?.length ? s.narrative : s.narrative_hints)];
    const n = s.sector.toLowerCase();
    const words = n.split(/[^a-z0-9]+/).filter((w) => w.length > 2);
    const seen = new Set(base.map((x) => x.toLowerCase()));
    const extras: string[] = [];

    outer: for (const t of themes) {
      if (!themeTouchesNseSector(t, n, words)) continue;
      for (const kw of (t.keywords ?? []).slice(0, 8)) {
        const k = kw.trim();
        if (k.length < 3 || k.length > 52) continue;
        if (seen.has(k.toLowerCase())) continue;
        seen.add(k.toLowerCase());
        extras.push(k);
        if (base.length + extras.length >= 4) break outer;
      }
    }

    const merged = dedupeKeywordSoup([...base, ...extras]);
    const extrasOnly = dedupeKeywordSoup(extras);
    const why = refineWhyOneLiner(s.why_one_liner, extrasOnly);
    return { ...s, narrative: merged.slice(0, 3), narrative_hints: merged.slice(0, 3), why_one_liner: why };
  });
}

export type IndustryIntelNarrativeOpts = {
  domains: string[];
  sourceUrls: string[];
  forceRefresh: boolean;
};

const TOP_INDUSTRY_PER_SECTOR = 2;
const MAX_SECTOR_ROWS = 12;

function buildTopSectors(
  computed: IndustryComputed[],
  globalRankByName: Map<string, number>,
  driverLabel: string,
  regime: MacroRegime,
  driver: MacroDriver
): SectorView[] {
  const bySector = new Map<string, IndustryComputed[]>();
  for (const c of computed) {
    const key = c.sector || "Unknown";
    const arr = bySector.get(key);
    if (arr) arr.push(c);
    else bySector.set(key, [c]);
  }

  const views: SectorView[] = [];
  for (const [sector, rows] of bySector) {
    const sorted = [...rows].sort((a, b) => b.final_score - a.final_score);
    const topK = sorted.slice(0, TOP_INDUSTRY_PER_SECTOR);
    if (!topK.length) continue;
    const sector_score =
      topK.reduce((s, x) => s + x.final_score, 0) / topK.length;
    const af = topK[0].macro_alignment_float;
    const ma = topK[0].macro_alignment;
    const mal = macroAlignmentLabel(ma);
    const avgMom = round4(topK.reduce((s, x) => s + x.momentum_score, 0) / topK.length);
    const avgBr = round4(topK.reduce((s, x) => s + x.breadth_score, 0) / topK.length);
    const sig = computeSectorSignal(ma, af, avgMom, avgBr);
    const hints = inferSectorNarrativeHints(sector);
    const whyBase = buildInitialWhyLine(sector, regime, driver);
    const industries: SectorIndustryPin[] = topK.map((x, i) => ({
      name: x.name,
      final_score: x.final_score,
      classification: x.classification,
      macro_alignment: x.macro_alignment,
      momentum_score: x.momentum_score,
      breadth_score: x.breadth_score,
      relative_strength_score: x.relative_strength_score,
      global_rank: globalRankByName.get(x.name) ?? 0,
      rank_within_sector: i + 1,
    }));
    views.push({
      sector,
      sector_score: round4(sector_score),
      alignment: round4(af),
      macro_alignment: ma,
      macro_alignment_label: mal,
      macro_line: buildMacroLine(mal, driverLabel),
      avg_momentum: avgMom,
      avg_breadth: avgBr,
      signal_strength: sig.strength,
      signal_summary: sig.summary,
      participation_line: sig.participation_line,
      why_one_liner: whyBase,
      industries,
      narrative: hints,
      narrative_hints: hints,
    });
  }

  return views.sort((a, b) => b.sector_score - a.sector_score).slice(0, MAX_SECTOR_ROWS);
}

function buildInsight(regime: MacroRegime, topSectors: string[], avoid: string[]): string {
  const topS = topSectors.slice(0, 4).join(", ") || "n/a";
  const avS = avoid.slice(0, 4).join(", ") || "n/a";
  if (regime === "RISK_OFF") {
    return `Capital is favouring sectors ${topS} under risk-off; ${avS} screen as weaker industry fits.`;
  }
  if (regime === "NEUTRAL") {
    return `Mixed macro: sector leadership at ${topS}; watch laggards ${avS}.`;
  }
  if (regime === "MILD_RISK_ON" || regime === "STRONG_RISK_ON") {
    return `Risk-on skew: ${topS} lead on momentum, breadth, RS & quality; ${avS} trail.`;
  }
  return `Top sectors: ${topS}. Monitor: ${avS}.`;
}

// ——— Trendlyne fetch ———

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

function extractIndustryRows(json: unknown): IndustryNormalized[] {
  const body = (json as { body?: { industry?: { tableData?: unknown[] } } })?.body;
  const table = Array.isArray(body?.industry?.tableData) ? body!.industry!.tableData! : [];
  const out: IndustryNormalized[] = [];

  for (const row of table) {
    const r = row as Record<string, unknown>;
    const sc = r.stock_column as Record<string, unknown> | undefined;
    const name = String(sc?.stockName ?? "").trim();
    const sector = String(r.sector_name ?? "").trim();
    const weekRaw = r.week_changeP_mcapw_ind;
    const week = Number(weekRaw);
    const advObj = r.advance as { value?: unknown } | undefined;
    const decObj = r.decline as { value?: unknown } | undefined;
    const advances = Number(advObj?.value ?? 0);
    const declines = Number(decObj?.value ?? 0);
    const peRaw = r.pe_ttm_mcapw_ind;
    const roeRaw = r.roe_a_mcapw;
    const pe = Number(peRaw);
    const roe = Number(roeRaw);

    if (!name || !Number.isFinite(week)) continue;

    out.push({
      name,
      sector: sector || "Unknown",
      weekly_change: week,
      advances: Number.isFinite(advances) ? advances : 0,
      declines: Number.isFinite(declines) ? declines : 0,
      pe: Number.isFinite(pe) ? pe : null,
      roe: Number.isFinite(roe) ? roe : null,
    });
  }

  return out;
}

let tlCache: { rows: IndustryNormalized[]; at: number } | null = null;

async function fetchTrendlyneIndustries(timeoutMs: number): Promise<IndustryNormalized[]> {
  const ttl = Number(getEnv("MARKET_SIGNALS_CACHE_TTL_MS", "300000"));
  if (tlCache && Date.now() - tlCache.at < ttl) return tlCache.rows;

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
    const rows = extractIndustryRows(json);
    tlCache = { rows, at: Date.now() };
    return rows;
  } catch {
    return tlCache?.rows ?? [];
  }
}

export function computeIndustryIntelligence(
  macro: MacroInput,
  industries: IndustryNormalized[]
): IndustryIntelligencePayload {
  const macroScore = computeMacroScore(macro);
  const regime = detectRegime(macroScore);
  const vector = computeMacroVector(macro);
  const driver = detectMacroDriver(macro);
  const label = macroLabel(macro, regime, driver);

  if (!industries.length) {
    return {
      macro: buildMacroPayloadBlock(macro, macroScore, regime, vector, driver, label),
      top_sectors: [],
      top_industries: [],
      avoid_list: [],
      insight: "Industry data unavailable. Check Trendlyne connectivity or try again.",
    };
  }

  const n = industries.length;
  const sectorLabels: string[] = [];
  const weeklyChanges: number[] = [];
  for (const ind of industries) {
    sectorLabels.push(getSectorForIndustry(ind.name) ?? ind.sector);
    weeklyChanges.push(ind.weekly_change);
  }

  const sectorToWeekly = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const sec = sectorLabels[i];
    const arr = sectorToWeekly.get(sec);
    if (arr) arr.push(weeklyChanges[i]);
    else sectorToWeekly.set(sec, [weeklyChanges[i]]);
  }
  const sectorMeanWeekly = new Map<string, number>();
  for (const [sec, ws] of sectorToWeekly) {
    sectorMeanWeekly.set(sec, ws.reduce((a, b) => a + b, 0) / ws.length);
  }

  const RS_CLIP = 20;
  const rsRaw: number[] = [];
  for (let i = 0; i < n; i++) {
    const sm = sectorMeanWeekly.get(sectorLabels[i]) ?? 0;
    const ratio = Math.abs(sm) < 1e-9 ? 1 : weeklyChanges[i] / sm;
    rsRaw.push(Math.max(-RS_CLIP, Math.min(RS_CLIP, ratio)));
  }

  const momentumPct = percentileRank01(weeklyChanges);
  const rsPct = percentileRank01(rsRaw);

  const partial: Array<
    IndustryNormalized & {
      momentum_score: number;
      breadth_score: number;
      relative_strength_score: number;
      quality_score: number;
      tags: string[];
      macro_alignment_float: number;
      macro_alignment: -1 | 0 | 1;
    }
  > = [];

  for (let i = 0; i < n; i++) {
    const ind = industries[i];
    const sectorLabel = sectorLabels[i];
    const momentum_score = momentumPct[i] ?? 0.5;
    const breadth_score = breadthScore(ind.advances, ind.declines);
    const relative_strength_score = rsPct[i] ?? 0.5;
    const quality_score = qualityScore(ind.pe, ind.roe);
    const tags = inferTags(ind.name, sectorLabel);
    const macro_alignment_raw = computeMacroSectorAlignmentFloat(sectorLabel, macro, regime, driver);
    const macro_alignment_float = applyAlignmentConfidenceBoost(macro_alignment_raw, driver);
    const macro_alignment = floatToMacroTriplet(macro_alignment_float);
    partial.push({
      ...ind,
      sector: sectorLabel,
      momentum_score,
      breadth_score,
      relative_strength_score,
      quality_score,
      tags,
      macro_alignment_float,
      macro_alignment,
    });
  }

  const computed: IndustryComputed[] = partial.map((p) => {
    const fs = finalScore(
      p.momentum_score,
      p.breadth_score,
      p.relative_strength_score,
      p.quality_score,
      p.macro_alignment_float,
      driver
    );
    return {
      name: p.name,
      sector: p.sector,
      tags: p.tags,
      momentum_score: round4(p.momentum_score),
      breadth_score: round4(p.breadth_score),
      relative_strength_score: round4(p.relative_strength_score),
      quality_score: round4(p.quality_score),
      macro_alignment: p.macro_alignment,
      macro_alignment_float: round4(p.macro_alignment_float),
      final_score: round4(fs),
      classification: classify(fs),
    };
  });

  const sorted = [...computed].sort((a, b) => b.final_score - a.final_score);
  const globalRankByName = new Map(sorted.map((c, i) => [c.name, i + 1]));
  const driverLabel = macroDriverDisplayLabel(driver);
  const top_sectors = buildTopSectors(computed, globalRankByName, driverLabel, regime, driver);
  const top_industries = sorted.slice(0, 15);

  const avoidCandidates = computed.filter((c) => c.classification === "AVOID");
  const avoid_list =
    avoidCandidates.length > 0
      ? [...avoidCandidates].sort((a, b) => a.final_score - b.final_score).slice(0, 12)
      : [...computed].sort((a, b) => a.final_score - b.final_score).slice(0, 8);

  const insight = buildInsight(
    regime,
    top_sectors.map((x) => x.sector),
    avoid_list.map((x) => x.name)
  );

  return {
    macro: buildMacroPayloadBlock(macro, macroScore, regime, vector, driver, label),
    top_sectors,
    top_industries,
    avoid_list,
    insight,
  };
}

export async function getIndustryIntelligence(
  macroInput: MacroInput,
  narrativeOpts?: IndustryIntelNarrativeOpts
): Promise<IndustryIntelligencePayload> {
  const timeoutMs = Number(getEnv("MARKET_SIGNAL_TIMEOUT_MS", "8000"));
  const parsed = macroInputSchema.parse(macroInput);
  const rows = await fetchTrendlyneIndustries(timeoutMs);
  let payload = computeIndustryIntelligence(parsed, rows);

  if (narrativeOpts) {
    try {
      const macroThemes = await getDynamicMacroThemes(
        narrativeOpts.domains,
        narrativeOpts.sourceUrls,
        narrativeOpts.forceRefresh
      );
      const themeModels = macroThemesToThemeModels(macroThemes);
      payload = {
        ...payload,
        top_sectors: mergeThemeNarrativeIntoSectors(payload.top_sectors, themeModels),
      };
    } catch {
      // Keep structural narrative hints only if theme fetch fails.
    }
  }

  return payload;
}

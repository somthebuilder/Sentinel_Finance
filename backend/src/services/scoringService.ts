import { Stock } from "../models/stock";
import { Theme } from "../models/theme";
import { calculateThemeRelevanceDetails } from "./themeService";
import { polishReasonsIfNeeded } from "./aiEnrichmentService";
import {
  buildFactorScores,
  buildRiskFlags,
  buildStrengthProfile,
  calculateFundamentalScore,
  interpretMetricScores,
  isEliteByRules,
  normalize01,
} from "./financialRules";

export type ScoreBreakdown = {
  themeRelevance: number;
  revenueGrowthScore: number;
  epsGrowthScore: number;
  debtScore: number;
  piotroskiScore: number;
  growthFactor: number;
  momentumFactor: number;
  durabilityFactor: number;
  valuationFactor: number;
  participationFactor: number;
  momentumScore: number;
  institutionalScore: number;
  accelerationScore: number;
  breakoutScore: number;
  baseScore: number;
  themeStrengthMultiplier: number;
  eliteBoost: number;
  rawCompositeScore: number;
  rawRevenueGrowth?: number;
  rawEpsGrowth?: number;
  rawDebtToEquity?: number;
  rawPiotroski?: number;
  rawMomentum?: number;
  rawInstitutional?: number;
};

export type StockRecommendation = {
  name: string;
  symbol?: string;
  sector?: string;
  subSector?: string;
  score: number;
  conviction: "HIGH" | "MEDIUM" | "LOW";
  tier: "A+ (High Growth)" | "A (Strong)" | "B (Watchlist)" | "C (Ignore)";
  signals: string[];
  whyNow: string;
  scoreBreakdown: ScoreBreakdown;
  strengthProfile: string[];
  riskFlags: string[];
  reasons: string[];
  // Backward compatibility for existing UI renderer.
  reason: string[];
};

export type RankedByTheme = { theme: string; strength: number; topStocks: StockRecommendation[] };

function normalizeTo01MaybePercent(value: number): number {
  return normalize01(value);
}

function accelerationScore(stock: Stock): number {
  const curr = normalizeTo01MaybePercent(stock.revenueGrowth);
  const prev = normalizeTo01MaybePercent(stock.previousRevenueGrowth);
  return Math.max(0, Math.min(1, curr - prev + 0.5)); // centered acceleration proxy
}

function breakoutScore(stock: Stock): number {
  const momentum = normalizeTo01MaybePercent(stock.momentumScore);
  const inst = normalizeTo01MaybePercent(stock.institutionalOwnership);
  return Math.max(0, Math.min(1, momentum * 0.7 + inst * 0.3));
}

function formatPercentLikeDecimal(value: number): string {
  if (!Number.isFinite(value)) return "0.0%";
  const pct = value > 1 ? (value <= 100 ? value : 100) : value * 100;
  return `${pct.toFixed(1)}%`;
}

function pickStrongMetric(
  revenueGrowthScore: number,
  momentumScore: number,
  institutionalScore: number
): "revenueGrowth" | "momentumScore" | "institutionalScore" {
  const entries: [string, number][] = [
    ["revenueGrowth", revenueGrowthScore],
    ["momentumScore", momentumScore],
    ["institutionalScore", institutionalScore],
  ];
  entries.sort((a, b) => b[1] - a[1]);
  return entries[0][0] as any;
}

export function calculateFinalScore(stock: Stock, theme: Theme): number {
  const { themeRelevance } = calculateThemeRelevanceDetails(stock, theme);
  const fundamentalScore = calculateFundamentalScore(stock);
  const acceleration = accelerationScore(stock);
  const breakout = breakoutScore(stock);

  // Theme + factor intelligence layer.
  const stockScore = themeRelevance * 0.3 + fundamentalScore * 0.7 + acceleration * 0.05 + breakout * 0.05;
  const clipped = Math.max(0, Math.min(1, stockScore));
  return Number(clipped.toFixed(6));
}

export function generateReason(
  stock: Stock,
  theme: Theme,
  themeRelevanceDetails: ReturnType<typeof calculateThemeRelevanceDetails>,
): string[] {
  // 1 theme-based reason (specific: what matched)
  const matchedTags = themeRelevanceDetails.matchedTags;
  const themeReason = matchedTags.length
    ? `Tags align with ${theme.theme} theme keywords: ${matchedTags.join(", ")}`
    : `Sector/subsector aligns with ${theme.theme}`;

  // 1 metric-based reason (specific: strongest metric)
  const interpreted = interpretMetricScores(stock);
  const revenueGrowthScore = interpreted.revenueGrowth;
  const momentumScore = interpreted.momentum;
  const institutionalScore = interpreted.institutionalActivity;
  const strongest = pickStrongMetric(revenueGrowthScore, momentumScore, institutionalScore);

  if (strongest === "revenueGrowth") {
    return [themeReason, `Revenue growth is strongest (${formatPercentLikeDecimal(stock.revenueGrowth)})`];
  }
  if (strongest === "momentumScore") {
    return [themeReason, `Momentum score is strongest (${formatPercentLikeDecimal(stock.momentumScore)})`];
  }
  return [themeReason, `Institutional ownership score is strongest (${formatPercentLikeDecimal(stock.institutionalOwnership)})`];
}

export function passesGrowthFilter(stock: Stock): boolean {
  const sectorUnknown =
    !stock.sector ||
    stock.sector.toLowerCase() === "unknown" ||
    stock.sector.toLowerCase() === "na" ||
    stock.sector.toLowerCase() === "n/a";

  const interpreted = interpretMetricScores(stock);
  const momentum = interpreted.momentum;
  const rev = interpreted.revenueGrowth;
  const eps = interpreted.epsGrowth;
  const pio = interpreted.piotroski;
  const fundamental = calculateFundamentalScore(stock);

  if (sectorUnknown) {
    return fundamental > 0.45 && (momentum > 0.45 || rev >= 0.7);
  }

  return fundamental > 0.55 && (momentum > 0.45 || eps >= 0.7 || pio >= 0.7);
}

function isElite(stock: Stock): boolean {
  return isEliteByRules(stock);
}

function getTier(score: number): "A+ (High Growth)" | "A (Strong)" | "B (Watchlist)" | "C (Ignore)" {
  if (score > 0.75) return "A+ (High Growth)";
  if (score > 0.6) return "A (Strong)";
  if (score > 0.5) return "B (Watchlist)";
  return "C (Ignore)";
}

function convictionForScore(score: number): "HIGH" | "MEDIUM" | "LOW" {
  if (score >= 0.7) return "HIGH";
  if (score >= 0.5) return "MEDIUM";
  return "LOW";
}

function buildSignals(stock: Stock): string[] {
  const signals: string[] = [];
  if (normalizeTo01MaybePercent(stock.momentumScore) > 0.7) signals.push("Breakout Candidate");
  if (normalizeTo01MaybePercent(stock.revenueGrowth) > 0.2) signals.push("High Growth");
  if (normalizeTo01MaybePercent(stock.institutionalOwnership) > 0.3) signals.push("Institutional Buying");
  return signals.slice(0, 3);
}

function buildWhyNow(stock: Stock, theme: Theme): string {
  const chunks: string[] = [];
  if (normalizeTo01MaybePercent(stock.momentumScore) > 0.7) chunks.push("strong momentum");
  if (normalizeTo01MaybePercent(stock.revenueGrowth) > 0.2) chunks.push("high growth");
  if (normalizeTo01MaybePercent(stock.institutionalOwnership) > 0.3) chunks.push("institutional accumulation");
  if (!chunks.length) chunks.push("improving fundamentals");
  return `${chunks.join(" + ")} with ${theme.theme.toLowerCase()} macro support`;
}

export async function rankStocksByTheme(themes: Theme[], stocks: Stock[]): Promise<RankedByTheme[]> {
  const topN = 5;
  const enableReasonPolish = String(process.env.ENABLE_REASON_POLISH ?? "false").toLowerCase() === "true";
  const maxPolishPerTheme = Number(process.env.MAX_REASON_POLISH_PER_THEME ?? "2");

  const ranked: RankedByTheme[] = [];
  for (const theme of themes) {
    const strengthRaw = Number(theme.strength ?? 0);
    const strengthNormalized = Number.isFinite(strengthRaw) ? Math.max(0, Math.min(1, strengthRaw)) : 0;

    const scored = stocks
      .filter(passesGrowthFilter)
      .map((stock): StockRecommendation | null => {
        const details = calculateThemeRelevanceDetails(stock, theme);

        // Deterministic match gate with token-aware overlap from themeService.
        // Relax slightly so valid sector/subsector matches are not dropped.
        if (details.themeRelevance <= 0.35) return null;

        const interpreted = interpretMetricScores(stock);
        const factors = buildFactorScores(stock);
        const revenueGrowthScore = interpreted.revenueGrowth;
        const epsGrowthScore = interpreted.epsGrowth;
        const debtScore = interpreted.debt;
        const piotroskiScore = interpreted.piotroski;
        const momentumScore = interpreted.momentum;
        const institutionalScore = interpreted.institutionalActivity;

        // Base score is deterministic; then weight by theme strength.
        const baseScore = calculateFinalScore(stock, theme);
        const themeStrengthMultiplier = 1 + strengthNormalized * 0.3;
        const eliteBoost = isElite(stock) ? 0.15 : 0;
        const rawComposite = baseScore * themeStrengthMultiplier + eliteBoost;
        let score = Math.max(0, Math.min(1, rawComposite));
        score = Number(score.toFixed(6));

        const reasons = generateReason(stock, theme, details);
        const strengthProfile = buildStrengthProfile(stock);
        const riskFlags = buildRiskFlags(stock);
        const signals = buildSignals(stock);
        const whyNow = buildWhyNow(stock, theme);
        const acc = accelerationScore(stock);
        const br = breakoutScore(stock);

        return {
          name: stock.name,
          symbol: stock.symbol,
          sector: stock.sector,
          subSector: stock.subSector,
          score,
          conviction: convictionForScore(score),
          tier: getTier(score),
          signals,
          whyNow,
          strengthProfile,
          riskFlags,
          scoreBreakdown: {
            themeRelevance: Number(details.themeRelevance.toFixed(6)),
            revenueGrowthScore: Number(revenueGrowthScore.toFixed(6)),
            epsGrowthScore: Number(epsGrowthScore.toFixed(6)),
            debtScore: Number(debtScore.toFixed(6)),
            piotroskiScore: Number(piotroskiScore.toFixed(6)),
            growthFactor: Number(factors.growth.toFixed(6)),
            momentumFactor: Number(factors.momentum.toFixed(6)),
            durabilityFactor: Number(factors.durability.toFixed(6)),
            valuationFactor: Number(factors.valuation.toFixed(6)),
            participationFactor: Number(factors.participation.toFixed(6)),
            momentumScore: Number(momentumScore.toFixed(6)),
            institutionalScore: Number(institutionalScore.toFixed(6)),
            accelerationScore: Number(acc.toFixed(6)),
            breakoutScore: Number(br.toFixed(6)),
            baseScore: Number(baseScore.toFixed(6)),
            themeStrengthMultiplier: Number(themeStrengthMultiplier.toFixed(6)),
            eliteBoost: Number(eliteBoost.toFixed(6)),
            rawCompositeScore: Number(rawComposite.toFixed(6)),
            rawRevenueGrowth: Number(stock.revenueGrowth ?? 0),
            rawEpsGrowth: Number(stock.epsGrowth ?? stock.netProfitYoYGrowth ?? 0),
            rawDebtToEquity: Number(stock.debtToEquity ?? stock.ltDebtToEquity ?? 0),
            rawPiotroski: Number(stock.piotroski ?? 0),
            rawMomentum: Number(stock.momentumScore ?? 0),
            rawInstitutional: Number(stock.institutionalOwnership ?? stock.institutionalActivity ?? 0),
          },
          reasons,
          reason: reasons,
        };
      })
      .filter((x): x is StockRecommendation => x !== null);

    const topStocks = scored.sort((a, b) => b.score - a.score).slice(0, topN);

    if (topStocks.length) {
      // Optional AI polish is disabled by default to keep recommendations fast/stable.
      // When enabled, polish only a small top slice in parallel.
      if (enableReasonPolish && maxPolishPerTheme > 0) {
        const toPolish = topStocks.slice(0, Math.min(maxPolishPerTheme, topStocks.length));
        const polishedBatch = await Promise.all(
          toPolish.map((s, idx) => polishReasonsIfNeeded(s.reasons, idx + 1).catch(() => s.reasons))
        );
        for (let i = 0; i < toPolish.length; i++) {
          topStocks[i].reasons = polishedBatch[i];
          topStocks[i].reason = polishedBatch[i];
        }
      }

      ranked.push({
        theme: theme.theme,
        strength: Number(strengthNormalized.toFixed(3)),
        topStocks,
      });
    }
  }

  return ranked;
}


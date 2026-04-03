import { Stock } from "../models/stock";

export const RULES = {
  revenueGrowth: { excellent: 0.25, good: 0.15, bad: 0.05 },
  epsGrowth: { excellent: 0.25, good: 0.1, bad: 0 },
  debtToEquity: { excellent: 0.3, acceptable: 1, risky: 2 },
  piotroski: { excellent: 8, good: 6, bad: 4 },
  momentum: { breakout: 0.5, strong: 0.2, weak: 0 },
  institutionalOwnership: { strong: 0.3, moderate: 0.15 },
  promoterHolding: { strong: 0.6, moderate: 0.4 },
} as const;

export function normalize01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value > 1 && value <= 100) return Math.max(0, Math.min(1, value / 100));
  if (value > 1) return 1;
  return Math.max(0, Math.min(1, value));
}

export function normalizePercentLike(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value > 1 && value <= 100) return value / 100;
  return value;
}

export function scoreRevenueGrowth(value: number): number {
  const raw = normalizePercentLike(value);
  if (!Number.isFinite(raw) || raw < 0) return 0;
  const v = normalize01(raw);
  if (v >= RULES.revenueGrowth.excellent) return 1;
  if (v >= RULES.revenueGrowth.good) return 0.7;
  if (v >= RULES.revenueGrowth.bad) return 0.4;
  return 0;
}

export function scoreEPSGrowth(value: number): number {
  const raw = normalizePercentLike(value);
  if (!Number.isFinite(raw) || raw < 0) return 0;
  const v = normalize01(raw);
  if (v >= RULES.epsGrowth.excellent) return 1;
  if (v >= RULES.epsGrowth.good) return 0.7;
  if (v > RULES.epsGrowth.bad) return 0.4;
  return 0;
}

export function scoreDebt(value: number): number {
  const v = Number.isFinite(value) ? value : 999;
  if (v <= RULES.debtToEquity.excellent) return 1;
  if (v <= RULES.debtToEquity.acceptable) return 0.7;
  if (v <= RULES.debtToEquity.risky) return 0.3;
  return 0;
}

export function scorePiotroski(value: number): number {
  const v = Number.isFinite(value) ? value : 0;
  if (v >= RULES.piotroski.excellent) return 1;
  if (v >= RULES.piotroski.good) return 0.7;
  if (v >= RULES.piotroski.bad) return 0.4;
  return 0;
}

export function scoreMomentum(value: number): number {
  const v = normalizePercentLike(value);
  if (v > RULES.momentum.breakout) return 1;
  if (v > RULES.momentum.strong) return 0.7;
  if (v >= RULES.momentum.weak) return 0.4;
  return 0;
}

export function scoreDistanceFromHigh(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  const dist = normalize01(normalizePercentLike(value));
  return Number((1 - dist).toFixed(6));
}

export function scorePEG(value: number): number {
  const v = Number.isFinite(value) ? value : 999;
  if (v <= 1) return 1;
  if (v <= 2) return 0.6;
  return 0.2;
}

export function scorePBVRelative(pbv: number, industryPbv: number): number {
  if (!Number.isFinite(pbv) || !Number.isFinite(industryPbv) || industryPbv <= 0) return 0.5;
  const ratio = pbv / industryPbv;
  if (ratio <= 1) return 1;
  if (ratio <= 1.25) return 0.7;
  if (ratio <= 1.6) return 0.4;
  return 0.2;
}

/**
 * Hard gate for recommendations: flag clear richness vs earnings (PEG) or vs industry PBV.
 * Only applies when the relevant inputs are present; missing metrics do not force a fail.
 */
export function isOvervaluedByRules(stock: Stock): boolean {
  const peg = stock.peg;
  if (Number.isFinite(peg) && peg > 0 && peg > 2) return true;

  const pbv = stock.pbv;
  const ind = stock.industryPbv;
  if (Number.isFinite(pbv) && Number.isFinite(ind) && ind > 0 && pbv / ind > 1.6) return true;

  return false;
}

export function passesValuationGate(stock: Stock): boolean {
  return !isOvervaluedByRules(stock);
}

/**
 * Ownership is usually a fraction (0–1) or percent (1–100). Screener exports often use large
 * activity/delivery figures; `normalize01` would clamp any value &gt; 100 to 1.0 and wipe out spread.
 */
export function scoreInstitutionalActivity(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  if (value <= 1) return Math.max(0, Math.min(1, value));
  if (value <= 100) return Math.max(0, Math.min(1, value / 100));
  const cap = 5_000_000;
  const x = Math.min(value, 1e12);
  return Math.max(0, Math.min(1, Math.log10(1 + x) / Math.log10(1 + cap)));
}

export function scorePromoterHolding(value: number): number {
  const v = normalize01(normalizePercentLike(value));
  if (v > RULES.promoterHolding.strong) return 1;
  if (v >= RULES.promoterHolding.moderate) return 0.7;
  return 0.3;
}

export type FactorScores = {
  growth: number;
  momentum: number;
  durability: number;
  valuation: number;
  participation: number;
};

export type InterpretedMetricScores = {
  revenueGrowth: number;
  epsGrowth: number;
  revenueGrowthQoQ: number;
  momentum: number;
  distanceFromHigh: number;
  roe: number;
  roce: number;
  piotroski: number;
  debt: number;
  peg: number;
  pbvRelative: number;
  institutionalActivity: number;
  promoterHolding: number;
};

export function interpretMetricScores(stock: Stock): InterpretedMetricScores {
  const revenueGrowth = scoreRevenueGrowth(stock.revenueGrowth);
  const epsGrowth = scoreEPSGrowth(stock.epsGrowth || stock.netProfitYoYGrowth);
  const revenueGrowthQoQ = scoreRevenueGrowth(stock.revenueGrowthQoQ);
  const momentum = scoreMomentum(stock.momentumScore);
  const distanceFromHigh = scoreDistanceFromHigh(stock.distanceFromHigh);
  const roe = scoreRevenueGrowth(stock.roe); // same threshold style for profitability %
  const roce = scoreRevenueGrowth(stock.roce);
  const piotroski = scorePiotroski(stock.piotroski);
  const debt = scoreDebt(stock.debtToEquity || stock.ltDebtToEquity);
  const peg = scorePEG(stock.peg);
  const pbvRelative = scorePBVRelative(stock.pbv, stock.industryPbv);
  const institutionalActivity = scoreInstitutionalActivity(stock.institutionalActivity || stock.institutionalOwnership);
  const promoterHolding = scorePromoterHolding(stock.promoterHolding);

  return {
    revenueGrowth,
    epsGrowth,
    revenueGrowthQoQ,
    momentum,
    distanceFromHigh,
    roe,
    roce,
    piotroski,
    debt,
    peg,
    pbvRelative,
    institutionalActivity,
    promoterHolding,
  };
}

export function buildFactorScores(stock: Stock): FactorScores {
  const m = interpretMetricScores(stock);
  const growth = m.revenueGrowth * 0.4 + m.epsGrowth * 0.3 + m.revenueGrowthQoQ * 0.3;
  const momentum = m.momentum * 0.6 + m.distanceFromHigh * 0.4;
  const durability = m.roe * 0.25 + m.roce * 0.25 + m.piotroski * 0.25 + m.debt * 0.25;
  const valuation = m.peg * 0.6 + m.pbvRelative * 0.4;
  const participation = m.institutionalActivity * 0.6 + m.promoterHolding * 0.4;
  return {
    growth: Number(growth.toFixed(6)),
    momentum: Number(momentum.toFixed(6)),
    durability: Number(durability.toFixed(6)),
    valuation: Number(valuation.toFixed(6)),
    participation: Number(participation.toFixed(6)),
  };
}

export function calculateFundamentalScore(stock: Stock): number {
  const factors = buildFactorScores(stock);
  return Number(
    (
      factors.growth * 0.25 +
      factors.momentum * 0.25 +
      factors.durability * 0.2 +
      factors.valuation * 0.15 +
      factors.participation * 0.15
    ).toFixed(6)
  );
}

export function isEliteByRules(stock: Stock): boolean {
  const m = interpretMetricScores(stock);
  return (
    m.revenueGrowth === 1 &&
    m.epsGrowth === 1 &&
    m.momentum >= 0.7 &&
    stock.piotroski >= 7
  );
}

export function buildStrengthProfile(stock: Stock): string[] {
  const f = buildFactorScores(stock);
  const out: string[] = [];
  if (f.growth >= 0.7) out.push("Strong growth and earnings expansion");
  if (f.momentum >= 0.7) out.push("High momentum (trend strength)");
  if (f.durability >= 0.7) out.push("Good financial quality and balance-sheet strength");
  if (f.valuation >= 0.65) out.push("Reasonable valuation vs growth");
  if (f.participation >= 0.65) out.push("Healthy participation (institutional/promoter)");
  if (!out.length) out.push("Balanced profile with no dominant factor");

  return out.slice(0, 4);
}

export function buildRiskFlags(stock: Stock): string[] {
  const flags: string[] = [];
  const m = interpretMetricScores(stock);
  if (m.debt <= 0.3) flags.push("High debt");
  if (m.epsGrowth === 0) flags.push("Negative/weak earnings growth");
  if (m.revenueGrowth === 0) flags.push("Weak revenue growth");
  if (m.piotroski <= 0.4) flags.push("Weak financial quality");
  if (m.momentum === 0) flags.push("Negative momentum");
  return flags.slice(0, 4);
}

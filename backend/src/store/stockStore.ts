import { Stock } from "../models/stock";

// In-memory store for MVP. This resets when the backend restarts.
let stocks: Stock[] = [];

function normalizeStock(s: Stock): Stock {
  return {
    name: (s.name ?? "").toString().trim(),
    symbol: s.symbol ? s.symbol.toString().trim().toUpperCase() : undefined,
    exchange: s.exchange,
    sector: (s.sector ?? "").toString().trim(),
    subSector: s.subSector ? s.subSector.toString().trim() : undefined,
    tags: Array.isArray(s.tags)
      ? s.tags.map((t) => t.toString().trim()).filter((t) => t.length > 0)
      : [],
    revenueGrowth: Number(s.revenueGrowth),
    previousRevenueGrowth: Number(s.previousRevenueGrowth),
    peRatio: Number(s.peRatio),
    institutionalOwnership: Number(s.institutionalOwnership),
    momentumScore: Number(s.momentumScore),
    netProfitYoYGrowth: Number(s.netProfitYoYGrowth),
    ltDebtToEquity: Number(s.ltDebtToEquity),
    piotroski: Number(s.piotroski),
    distanceFromHigh: Number(s.distanceFromHigh),
    revenueGrowthQoQ: Number(s.revenueGrowthQoQ),
    epsGrowth: Number(s.epsGrowth),
    roe: Number(s.roe),
    roce: Number(s.roce),
    altmanZ: Number(s.altmanZ),
    debtToEquity: Number(s.debtToEquity),
    peg: Number(s.peg),
    pbv: Number(s.pbv),
    industryPbv: Number(s.industryPbv),
    institutionalActivity: Number(s.institutionalActivity),
    promoterHolding: Number(s.promoterHolding),
  };
}

export function getStocks(): Stock[] {
  return stocks;
}

export function replaceStocks(incoming: Stock[]): Stock[] {
  const normalized = incoming.map(normalizeStock).filter((s) => s.name.length > 0);
  stocks = normalized;
  return stocks;
}

export function addStocks(incoming: Stock[]): Stock[] {
  const normalized = incoming.map(normalizeStock).filter((s) => s.name.length > 0);
  if (!normalized.length) return stocks;

  // Simple dedupe by (name, sector).
  const keyOf = (s: Stock) => `${s.name.toLowerCase()}|${(s.sector ?? "").toLowerCase()}|${(s.subSector ?? "").toLowerCase()}`;
  const existing = new Map(stocks.map((s) => [keyOf(s), s]));
  for (const s of normalized) {
    const key = keyOf(s);
    existing.set(key, { ...(existing.get(key) ?? {}), ...s });
  }
  stocks = Array.from(existing.values());
  return stocks;
}


import assert from "node:assert/strict";

import { calculateThemeRelevance } from "./themeService";
import { calculateFinalScore, rankStocksByTheme } from "./scoringService";
import { Theme } from "../models/theme";
import { Stock } from "../models/stock";

const stock: Stock = {
  name: "NVDA",
  exchange: "NSE",
  sector: "Semiconductors",
  subSector: "AI Chips",
  tags: ["ai", "semiconductor"],
  revenueGrowth: 0.2,
  previousRevenueGrowth: 0.1,
  peRatio: 35,
  institutionalOwnership: 0.6,
  momentumScore: 0.7,
  netProfitYoYGrowth: 0.22,
  ltDebtToEquity: 0.2,
  piotroski: 8,
  distanceFromHigh: 0.15,
  revenueGrowthQoQ: 0.12,
  epsGrowth: 0.22,
  roe: 0.24,
  roce: 0.2,
  altmanZ: 3.1,
  debtToEquity: 0.2,
  peg: 1.2,
  pbv: 4,
  industryPbv: 5,
  institutionalActivity: 0.6,
  promoterHolding: 0.55,
};

const theme: Theme = {
  theme: "Technology",
  sectors: ["Technology", "Semiconductors", "Software", "Cloud"],
  keywords: ["ai", "machine learning", "artificial intelligence", "software", "cloud", "semiconductor", "chip", "automation", "data", "robotics"],
  drivers: [],
};

// Expected values for this example are computed with the deterministic rules in code.
async function runExamples() {
  const themeRel = calculateThemeRelevance(stock, theme);
  const finalScore = calculateFinalScore(stock, theme);
  const ranked = await rankStocksByTheme([theme], [stock]);

  assert.equal(themeRel.toFixed(6), "0.626000");
  assert.equal(finalScore.toFixed(6), "0.749555");
  assert.equal(ranked[0].topStocks[0].name, "NVDA");
  assert.equal(ranked[0].topStocks[0].score.toFixed(6), "0.749555");

  return { themeRel, finalScore, ranked };
}

if (require.main === module) {
  // Run with: `node dist/services/deterministicEngine.examples.js`
  // so you can quickly sanity-check the deterministic engine after edits.
  // eslint-disable-next-line no-console
  runExamples().then((r) => console.log(r));
}


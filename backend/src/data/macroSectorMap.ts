/** Mirrors MacroInput / MacroRegime in industryIntelligenceService (avoid circular imports). */
export type MacroRegime = "RISK_OFF" | "NEUTRAL" | "MILD_RISK_ON" | "STRONG_RISK_ON";

export type MacroInputShape = {
  rates: "Rising" | "Stable" | "Falling";
  inflation: "Rising" | "Stable" | "Cooling";
  yields: "Rising" | "Stable" | "Falling";
  growth: "Slowing" | "Expanding" | "Contracting";
};

/**
 * Logical macro buckets → NSE sector strings (from industrySectorMapping / Trendlyne).
 * Defensives — core: staples, pharma/health, utilities, staples F&B; semi: telecom + export-style IT.
 */
export const LOGICAL_TO_NSE: Record<string, readonly string[]> = {
  Technology: [
    "Software & Services",
    "Hardware Technology & Equipment",
    "Telecom Services",
    "Telecommunications Equipment",
  ],
  Healthcare: ["Healthcare", "Pharmaceuticals & Biotechnology"],
  Energy: ["Oil & Gas", "Utilities"],
  Metals: ["Metals & Mining"],
  Financials: ["Banking and Finance", "Banking & Finance"],
  /** Consumption-facing (discretionary + staples exposure) */
  Consumer: [
    "FMCG",
    "Retailing",
    "Food, Beverages & Tobacco",
    "Consumer Durables",
    "Diversified Consumer Services",
  ],
  RealEstate: ["Realty"],
  Automobile: ["Automobiles & Auto Components"],
  Industrials: ["General Industrials", "General & Industrial Manufacturing"],
  CapitalGoods: ["Cement and Construction", "General & Industrial Manufacturing"],
  Infrastructure: ["Cement and Construction", "Transportation"],
  DefensiveCore: [
    "FMCG",
    "Healthcare",
    "Pharmaceuticals & Biotechnology",
    "Utilities",
    "Food, Beverages & Tobacco",
  ],
  DefensiveSemi: [
    "Telecom Services",
    "Telecommunications Equipment",
    "Software & Services",
    "Hardware Technology & Equipment",
  ],
  Defensive: [
    "FMCG",
    "Healthcare",
    "Pharmaceuticals & Biotechnology",
    "Utilities",
    "Food, Beverages & Tobacco",
    "Telecom Services",
    "Telecommunications Equipment",
    "Software & Services",
    "Hardware Technology & Equipment",
  ],
  UtilitiesOnly: ["Utilities"],
  Cyclicals: [
    "Banking and Finance",
    "Banking & Finance",
    "Automobiles & Auto Components",
    "Realty",
    "Metals & Mining",
    "Cement and Construction",
    "General Industrials",
    "General & Industrial Manufacturing",
    "Oil & Gas",
    "Chemicals & Petrochemicals",
    "Transportation",
    "Textiles Apparels & Accessories",
    "Media",
    "Hotels Restaurants & Tourism",
    "Retailing",
    "Consumer Durables",
    "Diversified Consumer Services",
    "Forest Materials",
    "Fertilizers",
    "Commercial Services & Supplies",
    "Diversified",
    "Others",
    "Gems & Jewellery",
  ],
  Commodities: ["Metals & Mining", "Chemicals & Petrochemicals", "Oil & Gas"],
  Consumption: ["FMCG", "Retailing", "Consumer Durables", "Food, Beverages & Tobacco"],
  Growth: ["Software & Services", "Hardware Technology & Equipment"],
  Value: ["General Industrials", "Banking and Finance", "Banking & Finance"],
  Banks: ["Banking and Finance"],
  NBFC: ["Banking & Finance", "Banking & Finance"],
};

export type MacroImpact = {
  favoured: string[];
  avoid: string[];
};

/** Combined regime → sector bias (logical labels, expanded via LOGICAL_TO_NSE). */
export const MACRO_SECTOR_MAP: Record<MacroRegime, MacroImpact> = {
  RISK_OFF: {
    favoured: ["Technology", "Healthcare", "Energy", "Metals"],
    avoid: ["Financials", "Consumer", "RealEstate", "Automobile"],
  },
  NEUTRAL: {
    favoured: ["Industrials", "CapitalGoods", "Infrastructure", "Energy"],
    avoid: [],
  },
  MILD_RISK_ON: {
    favoured: ["Industrials", "CapitalGoods", "Infrastructure", "Financials"],
    avoid: ["DefensiveCore"],
  },
  STRONG_RISK_ON: {
    favoured: ["Financials", "Consumer", "RealEstate", "Automobile"],
    avoid: ["Technology", "Healthcare", "Defensive"],
  },
};

export type MacroDriver =
  | "BALANCED"
  | "CONFLICTED"
  | "GROWTH_LED"
  | "LIQUIDITY_TIGHT"
  | "INFLATION_LED"
  | "LIQUIDITY_LED";

/** Sector tilt only for these drivers; others use factor/regime layers only. */
export const DRIVER_OVERRIDES: Pick<
  Record<MacroDriver, MacroImpact>,
  "GROWTH_LED" | "LIQUIDITY_LED" | "INFLATION_LED"
> = {
  GROWTH_LED: {
    favoured: ["Industrials", "CapitalGoods"],
    avoid: ["DefensiveCore"],
  },
  LIQUIDITY_LED: {
    favoured: ["Financials", "Consumption", "RealEstate"],
    avoid: [],
  },
  INFLATION_LED: {
    favoured: ["Commodities", "Energy"],
    avoid: ["Consumption", "Growth"],
  },
};

const V_YIELDS: Record<MacroInputShape["yields"], number> = { Rising: -1, Stable: 0, Falling: 1 };
const V_GROWTH: Record<MacroInputShape["growth"], number> = {
  Slowing: -1,
  Expanding: 1,
  Contracting: -1,
};

/** Regime from headline macro score (same inputs as vector average / 4). */
export function getRegime(macroScore: number): MacroRegime {
  if (macroScore <= -0.5) return "RISK_OFF";
  if (macroScore > -0.5 && macroScore < 0.25) return "NEUTRAL";
  if (macroScore >= 0.25 && macroScore < 0.75) return "MILD_RISK_ON";
  return "STRONG_RISK_ON";
}

/** Human-readable driver for UI (short label). */
export function macroDriverDisplayLabel(driver: MacroDriver): string {
  const labels: Record<MacroDriver, string> = {
    BALANCED: "Balanced",
    CONFLICTED: "Conflicted (growth vs liquidity)",
    GROWTH_LED: "Growth-led",
    LIQUIDITY_TIGHT: "Liquidity tight (yields)",
    INFLATION_LED: "Inflation-led",
    LIQUIDITY_LED: "Liquidity abundance (rates & yields falling)",
  };
  return labels[driver];
}

/** Per-factor sector tilts (NSE sectors in favoured / avoid). */
export const RATES_FACTOR: Record<MacroInputShape["rates"], MacroImpact> = {
  Rising: {
    favoured: ["Banking and Finance", "Banking & Finance", "Metals & Mining", "Chemicals & Petrochemicals"],
    avoid: ["Realty", "Automobiles & Auto Components"],
  },
  Falling: {
    favoured: ["Realty", "FMCG", "Retailing", "Diversified Consumer Services"],
    avoid: ["Banking and Finance", "Banking & Finance"],
  },
  Stable: { favoured: [], avoid: [] },
};

export const INFLATION_FACTOR: Record<MacroInputShape["inflation"], MacroImpact> = {
  Rising: {
    favoured: ["Metals & Mining", "Oil & Gas", "Chemicals & Petrochemicals"],
    avoid: ["FMCG", "Food, Beverages & Tobacco", "Consumer Durables"],
  },
  Cooling: {
    favoured: ["FMCG", "Retailing", "Consumer Durables"],
    avoid: ["Metals & Mining", "Oil & Gas"],
  },
  Stable: { favoured: [], avoid: [] },
};

export const YIELDS_FACTOR: Record<MacroInputShape["yields"], MacroImpact> = {
  Rising: {
    favoured: ["Banking and Finance", "Banking & Finance", "General Industrials"],
    avoid: ["Software & Services", "Hardware Technology & Equipment"],
  },
  Falling: {
    favoured: ["Software & Services", "Hardware Technology & Equipment", "Banking and Finance", "Banking & Finance"],
    avoid: ["Metals & Mining", "General Industrials"],
  },
  Stable: { favoured: [], avoid: [] },
};

export const GROWTH_FACTOR: Record<Exclude<MacroInputShape["growth"], "Contracting">, MacroImpact> = {
  Expanding: {
    favoured: ["Industrials", "CapitalGoods", "Financials", "Automobile"],
    /** Hurt classic defensives when growth is strong (staples, pharma, healthcare, utilities, staples F&B). */
    avoid: ["DefensiveCore"],
  },
  /** IT / pharma / utilities favoured; cyclicals hurt. */
  Slowing: {
    favoured: ["Technology", "Healthcare", "UtilitiesOnly"],
    avoid: ["Cyclicals"],
  },
};

/**
 * Contracting: only defensives (core + semi) positive; everything else negative.
 * Not expressible as a single favoured/avoid MacroImpact with neutral middle — handled in scoreGrowthFactor.
 */
export function scoreContractingGrowth(nseSector: string): number {
  const { favoured } = expandMacroImpact({
    favoured: ["DefensiveCore", "DefensiveSemi"],
    avoid: [],
  });
  return favoured.has(nseSector) ? 1 : -1;
}

export function scoreGrowthFactor(nseSector: string, growth: MacroInputShape["growth"]): number {
  if (growth === "Contracting") return scoreContractingGrowth(nseSector);
  return scoreSectorAgainstImpact(nseSector, GROWTH_FACTOR[growth]);
}

/** Expand MacroImpact: logical labels OR raw NSE sector strings. */
export function expandMacroImpact(impact: MacroImpact): { favoured: Set<string>; avoid: Set<string> } {
  const favoured = new Set<string>();
  const avoid = new Set<string>();

  const push = (labels: readonly string[], bucket: Set<string>) => {
    for (const label of labels) {
      if (LOGICAL_TO_NSE[label]) {
        for (const s of LOGICAL_TO_NSE[label]) bucket.add(s);
      } else {
        bucket.add(label);
      }
    }
  };

  push(impact.favoured, favoured);
  push(impact.avoid, avoid);
  return { favoured, avoid };
}

/** -1 avoid, +1 favoured, 0 neutral */
export function scoreSectorAgainstImpact(nseSector: string, impact: MacroImpact): number {
  const { favoured, avoid } = expandMacroImpact(impact);
  if (favoured.has(nseSector)) return 1;
  if (avoid.has(nseSector)) return -1;
  return 0;
}

/**
 * Narrative driver from macro vector (rates/inflation/yields/growth ∈ {-1,0,1}).
 * Priority: inflation-led & liquidity-abundance regimes, then growth vs yields tension.
 */
export function detectMacroDriver(input: MacroInputShape): MacroDriver {
  const growth = V_GROWTH[input.growth];
  const yields = V_YIELDS[input.yields];

  if (input.inflation === "Rising" && input.yields === "Rising") {
    return "INFLATION_LED";
  }
  if (input.rates === "Falling" && input.yields === "Falling") {
    return "LIQUIDITY_LED";
  }
  if (growth > 0 && yields < 0) {
    return "CONFLICTED";
  }
  if (growth > 0) {
    return "GROWTH_LED";
  }
  if (yields < 0) {
    return "LIQUIDITY_TIGHT";
  }
  return "BALANCED";
}

/**
 * Combined alignment in [-1, 1]:
 * regime_score + driver_adjustment + sector_match (factor average), then / 3.
 */
export function computeMacroSectorAlignmentFloat(
  nseSector: string,
  input: MacroInputShape,
  regime: MacroRegime,
  driver: MacroDriver
): number {
  const regimeImpact = MACRO_SECTOR_MAP[regime];
  const regimeScore = scoreSectorAgainstImpact(nseSector, regimeImpact);

  let driverScore = 0;
  if (driver === "GROWTH_LED" || driver === "LIQUIDITY_LED" || driver === "INFLATION_LED") {
    driverScore = scoreSectorAgainstImpact(nseSector, DRIVER_OVERRIDES[driver]);
  }

  const fRates = scoreSectorAgainstImpact(nseSector, RATES_FACTOR[input.rates]);
  const fInfl = scoreSectorAgainstImpact(nseSector, INFLATION_FACTOR[input.inflation]);
  const fYld = scoreSectorAgainstImpact(nseSector, YIELDS_FACTOR[input.yields]);
  const fGrowth = scoreGrowthFactor(nseSector, input.growth);
  const factorAvg = (fRates + fInfl + fYld + fGrowth) / 4;

  return (regimeScore + driverScore + factorAvg) / 3;
}

/** Map float alignment to legacy triplet for scoring UI. */
export function floatToMacroTriplet(x: number): -1 | 0 | 1 {
  if (x > 0.28) return 1;
  if (x < -0.28) return -1;
  return 0;
}

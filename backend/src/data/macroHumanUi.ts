import type { MacroDriver, MacroInputShape, MacroRegime } from "./macroSectorMap";

export type MacroHumanUi = {
  /** One line a human reads instead of “macro score 0”. */
  human_headline: string;
  /** e.g. "Growth ↑ · Liquidity ↓ (tight yields)" — no internal −1/0/1. */
  growth_liquidity_note: string;
  /** Short chip label for the regime strip. */
  regime_chip: string;
  /** Overlay-adjusted sector buckets (display names, not NSE strings). */
  sector_bias: string[];
  /** "Industrials · Transportation · Utilities" */
  sector_bias_line: string;
};

function growthArrow(input: MacroInputShape): "↑" | "↓" {
  return input.growth === "Expanding" ? "↑" : "↓";
}

/** Liquidity ↑ = easing (yields/rates falling); ↓ = tight (yields or rates rising). */
function liquidityArrow(input: MacroInputShape): "↑" | "↓" {
  if (input.yields === "Falling") return "↑";
  if (input.yields === "Rising") return "↓";
  if (input.rates === "Falling") return "↑";
  if (input.rates === "Rising") return "↓";
  return "↓";
}

function glKey(g: "↑" | "↓", l: "↑" | "↓"): string {
  return `${g}${l}`;
}

/** Base layer — growth × liquidity (user table). Order preserved. */
const BASE_SECTOR_BIAS: Record<string, readonly string[]> = {
  "↑↑": ["Technology", "Consumer Discretionary", "Financials", "Industrials"],
  "↑↓": ["Industrials", "Transportation", "Utilities", "Commodities"],
  "↓↑": ["Financials", "Industrials", "Cyclicals"],
  "↓↓": ["Utilities", "Consumer Staples", "Healthcare"],
};

function applyInflationTilt(bias: string[], inflation: MacroInputShape["inflation"]): string[] {
  const s = new Set(bias);
  if (inflation === "Rising") {
    for (const x of ["Commodities", "Energy", "Materials"]) {
      if (!s.has(x)) {
        s.add(x);
        bias.push(x);
      }
    }
    for (const drop of ["Technology", "Consumer Discretionary"]) {
      const i = bias.indexOf(drop);
      if (i >= 0) bias.splice(i, 1);
    }
  } else if (inflation === "Cooling") {
    for (const x of ["Technology", "Consumer Discretionary"]) {
      if (!s.has(x)) {
        s.add(x);
        bias.push(x);
      }
    }
    for (const drop of ["Commodities", "Energy"]) {
      const i = bias.indexOf(drop);
      if (i >= 0) bias.splice(i, 1);
    }
  }
  return [...new Set(bias)];
}

function applyRatesTilt(bias: string[], rates: MacroInputShape["rates"]): string[] {
  const s = new Set(bias);
  if (rates === "Rising") {
    if (!s.has("Financials")) {
      s.add("Financials");
      bias.push("Financials");
    }
    for (const drop of ["Technology", "Consumer Discretionary"]) {
      const i = bias.indexOf(drop);
      if (i >= 0) bias.splice(i, 1);
    }
  } else if (rates === "Falling") {
    for (const x of ["Technology", "Consumer Discretionary"]) {
      if (!s.has(x)) {
        s.add(x);
        bias.push(x);
      }
    }
    const fi = bias.indexOf("Financials");
    if (fi >= 0) bias.splice(fi, 1);
  }
  return [...new Set(bias)];
}

function buildSectorBias(input: MacroInputShape): string[] {
  const g = growthArrow(input);
  const l = liquidityArrow(input);
  const base = [...(BASE_SECTOR_BIAS[glKey(g, l)] ?? ["Industrials", "Utilities"])];
  let out = applyInflationTilt([...base], input.inflation);
  out = applyRatesTilt([...out], input.rates);
  return out.slice(0, 7);
}

function growthLiquidityNote(input: MacroInputShape, l: "↑" | "↓"): string {
  const g = growthArrow(input);
  const gTxt = g === "↑" ? "Growth ↑" : "Growth ↓";
  const lTxt = l === "↑" ? "Liquidity ↑" : "Liquidity ↓";
  let tail = "";
  if (input.yields === "Rising") tail = " — elevated yields tighten conditions";
  else if (input.yields === "Falling") tail = " — easing yields help risk assets";
  else if (input.rates === "Rising") tail = " — policy rates moving up";
  else if (input.rates === "Falling") tail = " — policy easing";
  return `${gTxt} · ${lTxt}${tail}`;
}

function humanHeadline(regime: MacroRegime, driver: MacroDriver, input: MacroInputShape): string {
  if (driver === "CONFLICTED") {
    return "Growth improving, but liquidity is tight (elevated yields). Favors selective participation over broad rallies.";
  }
  if (driver === "GROWTH_LED") {
    return "Growth-led tape — capex and cyclicals tend to lead.";
  }
  if (driver === "LIQUIDITY_LED") {
    return "Liquidity improving — easier conditions for risk and duration.";
  }
  if (driver === "LIQUIDITY_TIGHT") {
    return "Liquidity tight — yield pressure keeps conditions selective.";
  }
  if (driver === "INFLATION_LED") {
    return "Inflation-led — commodities and pricing power matter most.";
  }
  if (regime === "RISK_OFF") {
    return "Risk-off — preserve capital; defensives and quality first.";
  }
  if (regime === "STRONG_RISK_ON") {
    return "Strong risk-on — beta and growth generally rewarded.";
  }
  if (regime === "MILD_RISK_ON") {
    return "Constructive risk appetite — size beta with discipline.";
  }
  return "Mixed macro — no single dominant force; stay selective.";
}

function regimeChip(regime: MacroRegime, driver: MacroDriver, g: "↑" | "↓", l: "↑" | "↓"): string {
  if (driver === "CONFLICTED") return "Selective";
  if (glKey(g, l) === "↑↑") return "Risk-on";
  if (glKey(g, l) === "↑↓") return "Selective growth";
  if (glKey(g, l) === "↓↑") return "Liquidity-led";
  if (glKey(g, l) === "↓↓") return "Risk-off";
  return regime.replace(/_/g, " ");
}

/**
 * Human-facing macro copy + stacked sector bias (base growth×liquidity, then inflation & rates tilts).
 * Does not expose internal vector math.
 */
export function buildMacroHumanUi(
  input: MacroInputShape,
  regime: MacroRegime,
  driver: MacroDriver,
  _score: number
): MacroHumanUi {
  const l = liquidityArrow(input);
  const g = growthArrow(input);
  const sector_bias = buildSectorBias(input);
  return {
    human_headline: humanHeadline(regime, driver, input),
    growth_liquidity_note: growthLiquidityNote(input, l),
    regime_chip: regimeChip(regime, driver, g, l),
    sector_bias,
    sector_bias_line: sector_bias.join(" · "),
  };
}

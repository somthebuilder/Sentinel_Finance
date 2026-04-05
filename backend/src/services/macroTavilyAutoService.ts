import type { MacroInput } from "./industryIntelligenceService";
import { defaultMacroInput } from "./industryIntelligenceService";
import { fetchTavilyResearchNarrative, type NarrativeResult } from "./tavilyResearch";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Domain hint appended to focus retrieval toward India macro dashboards (e.g. IMI). */
function domainHintSuffix(overrideHost?: string): string {
  const raw = (overrideHost ?? process.env.TAVILY_MACRO_AUTO_DOMAIN_HINT ?? "indiamacroindicators.co.in").trim();
  return raw ? ` Context: prioritize India official and ${raw} style macro dashboards, RBI, CMIE.` : "";
}

function buildQueries(hintSuffix: string) {
  return {
    rates: `India interest rates outlook RBI policy trend repo rate ${hintSuffix}`,
    inflation: `India inflation CPI trend latest data consumer prices ${hintSuffix}`,
    yields: `India 10 year bond yield trend G-Sec yields outlook ${hintSuffix}`,
    growth: `India GDP growth trend outlook economy growth ${hintSuffix}`,
  } as const;
}

export type MacroTavilyAutoOptions = {
  /** Hostname(s) or URL-like strings; passed to Tavily Research `include_domains` for all four calls. */
  includeDomains?: string[];
  /** Overrides env default — single reference host (e.g. indiamacroindicators.co.in) woven into query text. */
  domainHint?: string;
};

export type MacroDimension = "rates" | "inflation" | "yields" | "growth";

export type MacroConfidence = Record<MacroDimension, number>;

export type MacroTavilyAutoResult = {
  ok: boolean;
  macro: MacroInput;
  confidence: MacroConfidence;
  usedFallback: boolean;
  /** Per-dimension vote breakdown for debugging */
  debug?: {
    queries: ReturnType<typeof buildQueries>;
    votes: Record<MacroDimension, string[]>;
    combinedTextChars: Record<MacroDimension, number>;
  };
};

function collectText(results: NarrativeResult[]): string {
  const parts: string[] = [];
  for (const r of results) {
    const title = (r.title ?? "").trim();
    const body = (r.content ?? "").trim();
    if (title) parts.push(title);
    if (body) parts.push(body);
  }
  return parts.join("\n\n").replace(/\s+/g, " ").trim();
}

/** Split into voting units (sentences / long clauses). */
function splitVotingUnits(text: string, maxUnits = 14): string[] {
  const raw = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 22);
  return raw.slice(0, maxUnits);
}

function extractRates(t: string): "Rising" | "Stable" | "Falling" {
  const s = t.toLowerCase();
  if (
    /rate hike|hiking rates|tightening|repo rate (was )?raised|increase in (the )?repo|higher (policy )?rates|rbi (raised|hikes|hiked)/.test(s)
  ) {
    return "Rising";
  }
  if (
    /rate cut|cutting rates|easing|repo rate cut|reduction in (the )?repo|lower (policy )?rates|rbi (cut|cuts|easing)/.test(s)
  ) {
    return "Falling";
  }
  if (/hold|on hold|pause|unchanged|steady|maintain|status quo|no change/.test(s)) {
    return "Stable";
  }
  return "Stable";
}

function extractInflation(t: string): "Rising" | "Stable" | "Cooling" {
  const s = t.toLowerCase();
  if (/inflation (is )?rising|re-?accelerat|price pressures|heating up|sticky inflation|elevated inflation/.test(s)) {
    return "Rising";
  }
  if (/cooling|easing inflation|disinflation|softening|inflation (has )?moderated|declining inflation/.test(s)) {
    return "Cooling";
  }
  if (/stable inflation|inflation (is )?stable|within (the )?target|muted inflation/.test(s)) {
    return "Stable";
  }
  return "Stable";
}

function extractYields(t: string): "Rising" | "Stable" | "Falling" {
  const s = t.toLowerCase();
  if (
    /yields (have )?risen|yields rising|bond yields? (have )?(edged )?higher|g-sec.*(up|higher)|yield (is )?up|steepening|higher (long )?yields/.test(
      s
    )
  ) {
    return "Rising";
  }
  if (/yields (have )?fallen|yields falling|bond rally|yield (is )?down|compression|lower (bond )?yields/.test(s)) {
    return "Falling";
  }
  if (/stable (bond )?yields|yields (were )?steady|range-?bound yields/.test(s)) {
    return "Stable";
  }
  return "Stable";
}

function extractGrowth(t: string): "Slowing" | "Expanding" | "Contracting" {
  const s = t.toLowerCase();
  if (/recession|contracting (gdp|economy)|negative growth|sharp contraction|economy shrinks/.test(s)) {
    return "Contracting";
  }
  if (/slowdown|decelerat|weak growth|sluggish|losing momentum|cooling growth/.test(s)) {
    return "Slowing";
  }
  if (
    /strong growth|resilient|expanding|recovery|pick-?up|upbeat|robust growth|faster growth|accelerat/.test(s)
  ) {
    return "Expanding";
  }
  return "Expanding";
}

export function extractSignal(
  text: string,
  type: MacroDimension
): "Rising" | "Stable" | "Falling" | "Cooling" | "Slowing" | "Expanding" | "Contracting" {
  if (type === "rates") return extractRates(text);
  if (type === "inflation") return extractInflation(text);
  if (type === "yields") return extractYields(text);
  return extractGrowth(text);
}

export function aggregateSignals<T extends string>(signals: T[], fallback: T): { value: T; confidencePct: number } {
  if (!signals.length) return { value: fallback, confidencePct: 0 };
  const count: Record<string, number> = {};
  for (const s of signals) count[s] = (count[s] ?? 0) + 1;
  const sorted = Object.entries(count).sort((a, b) => b[1] - a[1]);
  const winner = sorted[0][0] as T;
  const n = sorted[0][1];
  return { value: winner, confidencePct: Math.round((n / signals.length) * 100) };
}

async function runOneQuery(query: string, includeDomains?: string[]): Promise<string> {
  const results = await fetchTavilyResearchNarrative(query, { includeDomains });
  return collectText(results);
}

function dimensionFallback(d: MacroDimension): MacroInput[keyof MacroInput] {
  return defaultMacroInput[d];
}

/**
 * Four focused Tavily Research calls → keyword voting → `MacroInput`.
 * Falls back to `defaultMacroInput` if text is empty or API missing.
 */
export async function buildMacroFromTavily(
  includeDebug: boolean,
  options?: MacroTavilyAutoOptions
): Promise<MacroTavilyAutoResult> {
  const apiKey = process.env.TAVILY_API_KEY ?? process.env.TRAVILY_API_KEY;
  const hintSuffix = domainHintSuffix(options?.domainHint);
  const querySet = buildQueries(hintSuffix);
  const includeDomains = options?.includeDomains?.length ? options.includeDomains : undefined;

  if (!apiKey) {
    return {
      ok: false,
      macro: { ...defaultMacroInput },
      confidence: { rates: 0, inflation: 0, yields: 0, growth: 0 },
      usedFallback: true,
      ...(includeDebug
        ? {
            debug: {
              queries: querySet,
              votes: { rates: [], inflation: [], yields: [], growth: [] },
              combinedTextChars: { rates: 0, inflation: 0, yields: 0, growth: 0 },
            },
          }
        : {}),
    };
  }

  /** Bursting 4 parallel Research jobs triggers "excessive requests" on many plans — run sequentially with a gap. */
  const gapMs = Math.max(0, Number(process.env.TAVILY_MACRO_AUTO_QUERY_GAP_MS ?? "1200"));
  const queries = [querySet.rates, querySet.inflation, querySet.yields, querySet.growth] as const;
  const texts: string[] = [];
  for (let i = 0; i < queries.length; i++) {
    if (i > 0 && gapMs > 0) await sleep(gapMs);
    try {
      texts.push(await runOneQuery(queries[i], includeDomains));
    } catch (e) {
      console.warn(`buildMacroFromTavily: query ${i} failed:`, e);
      texts.push("");
    }
  }
  const [ratesText, inflationText, yieldsText, growthText] = texts;

  const vote = (text: string, dim: MacroDimension): { val: string; votes: string[]; pct: number } => {
    const fb = String(dimensionFallback(dim));
    if (!text || text.length < 40) {
      return { val: fb, votes: [fb], pct: 0 };
    }
    const units = splitVotingUnits(text);
    let signals = units.map((u) => extractSignal(u, dim)) as string[];
    if (!signals.length) {
      signals = [extractSignal(text.slice(0, 8000), dim) as string];
    }
    const agg = aggregateSignals(signals, fb);
    return { val: agg.value, votes: signals, pct: agg.confidencePct };
  };

  const r = vote(ratesText, "rates");
  const i = vote(inflationText, "inflation");
  const y = vote(yieldsText, "yields");
  const g = vote(growthText, "growth");

  const usedFallback =
    !ratesText &&
    !inflationText &&
    !yieldsText &&
    !growthText;

  const macro: MacroInput = {
    rates: r.val as MacroInput["rates"],
    inflation: i.val as MacroInput["inflation"],
    yields: y.val as MacroInput["yields"],
    growth: g.val as MacroInput["growth"],
  };

  if (usedFallback) {
    Object.assign(macro, defaultMacroInput);
  }

  const result: MacroTavilyAutoResult = {
    ok: true,
    macro,
    confidence: {
      rates: r.pct,
      inflation: i.pct,
      yields: y.pct,
      growth: g.pct,
    },
    usedFallback,
  };

  if (includeDebug) {
    result.debug = {
      queries: querySet,
      votes: { rates: r.votes, inflation: i.votes, yields: y.votes, growth: g.votes },
      combinedTextChars: {
        rates: ratesText.length,
        inflation: inflationText.length,
        yields: yieldsText.length,
        growth: growthText.length,
      },
    };
  }

  return result;
}

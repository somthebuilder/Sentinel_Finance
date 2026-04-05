function $(id) {
  return document.getElementById(id);
}

let hasSubmittedStocks = false;
let activeNarrativeSources = [];
let activeNarrativeUrls = [];
let latestRecommendationsRequestId = 0;
let recommendationsProgressTicker = null;
/** Default narrative lines: domains + optional exact URLs. Trendlyne = reference for sector/industry weekly momentum (backend also fetches its JSON API). */
const DEFAULT_NARRATIVE_SOURCES = [
  "trendlyne.com",
  "https://trendlyne.com/equity/sector-industry-analysis/overall/week-changeP/",
  "pulse.zerodha.com",
  "equitymaster.com",
  "moneycontrol.com",
];

/** First-load default for Tavily macro “preferred domains” (session may override). */
const DEFAULT_TAVILY_MACRO_DOMAINS_TEXT = [
  "trendlyne.com",
  "rbi.org.in",
  "ibef.org",
  "mospi.gov.in",
].join("\n");

/** v2: defaults include Trendlyne + macro reference domains */
const TAVILY_MACRO_DOMAINS_KEY = "sentinel_tavily_macro_domains_v2";
const TAVILY_MACRO_HINT_KEY = "sentinel_tavily_macro_hint_v1";
let activeTavilyMacroDomains = [];
let activeTavilyMacroDomainHint = "";

function showStatus(el, msg, kind) {
  el.textContent = msg;
  el.style.color = kind === "error" ? "var(--bad)" : "var(--muted)";
}

function parseTags(cell) {
  const txt = (cell ?? "").toString().trim();
  if (!txt) return [];
  return txt.split(/[;|]/g).map((s) => s.trim()).filter(Boolean);
}

const METRIC_GLOSSARY = {
  name: ["name", "stock", "company", "company name"],
  symbol: ["symbol", "ticker", "code"],
  exchange: ["exchange"],
  sector: ["sector", "industry sector", "segment"],
  subSector: ["subsector", "sub sector", "industry", "business segment"],
  tags: ["tags", "keywords", "themes"],
  revenueGrowth: ["Rev. Ann. 3Y Growth %", "Rev. Growth Ann. YoY %", "Revenue QoQ Growth %"],
  previousRevenueGrowth: ["Rev. Ann. 2Y Growth %", "Revenue QoQ Growth %"],
  peRatio: ["PE", "P/E", "PE Ratio", "P E", "PE TTM", "PE 3Yr Average", "PE 5Yr Average"],
  institutionalOwnership: ["Delivery% Vol. Avg Month", "Delivery% Vol. Avg 6M"],
  momentumScore: ["Month Chg %", "Qtr Chg %", "1Yr Chg %", "2Y price Chg %", "3Y price Chg %"],
  ltDebtToEquity: ["Total Debt to Total Equity Ann.", "LT Debt To Equity Ann."],
  roe: ["ROE Ann. %", "ROE", "Sector ROE", "Industry ROE"],
  epsGrowth: ["EPS TTM Growth %", "Net Profit Ann. YoY Growth %", "Operating Profit Ann. YoY Growth %"],
  piotroski: ["Piotroski Score"],
  ltp: ["LTP", "Close", "Price"],
  marketCap: ["Market Cap", "Mcap"],
};

function inferCanonicalMetric(headerText) {
  const h = normalizeHeaderKey(headerText);
  if (!h) return undefined;

  if (/(^stock$|company|security|script|scripname|stockname)/.test(h)) return "name";
  if (/(symbol|ticker|code|isin)/.test(h)) return "symbol";
  if (/^exchange$/.test(h)) return "exchange";
  if (/(^sector$|industrysector|sectorname)/.test(h)) return "sector";
  if (/(subsector|industry|businesssegment)/.test(h)) return "subSector";

  if (/(pettm|fwdpe|forwardpe|pe3yr|pe5yr|peratio|^pe$|pricetoearnings)/.test(h)) return "peRatio";
  if (/(revenue.*growth|rev.*growth|sales.*growth|topline.*growth|turnover.*growth)/.test(h)) return "revenueGrowth";
  if (/(eps.*growth|netprofit.*growth|operatingprofit.*growth|profit.*growth)/.test(h)) return "epsGrowth";
  if (/(delivery|institution|instholding|fii|dii|mutualfundholding|publicholding)/.test(h)) return "institutionalOwnership";
  if (/(chg|change|return|roc|performance|outperformance|underperformance)/.test(h)) return "momentumScore";
  if (/(roe|returnonequity)/.test(h)) return "roe";
  if (/(piotroski|fscore)/.test(h)) return "piotroski";
  if (/(ltdebttoequity|debttoequity|gearing)/.test(h)) return "ltDebtToEquity";
  if (/(marketcap|mcap)/.test(h)) return "marketCap";
  if (/(^ltp$|lasttradedprice|closeprice|close)/.test(h)) return "ltp";
  return undefined;
}

function normalizeHeaderKey(input) {
  return (input ?? "")
    .toString()
    .replace(/\uFEFF/g, "")
    .toLowerCase()
    .replace(/[%\.\(\)\/:_-]/g, "")
    .replace(/\s+/g, "");
}

function buildCanonicalHeaderIndex(headers) {
  const normalizedToIndex = {};
  headers.forEach((h, i) => {
    normalizedToIndex[normalizeHeaderKey(h)] = i;
  });

  const canonical = {};
  for (const [key, aliases] of Object.entries(METRIC_GLOSSARY)) {
    for (const alias of aliases) {
      const idx = normalizedToIndex[normalizeHeaderKey(alias)];
      if (idx !== undefined) {
        canonical[key] = idx;
        break;
      }
    }
  }

  // Pattern-based fallback to support large/variable Trendlyne naming variants.
  headers.forEach((h, i) => {
    const inferred = inferCanonicalMetric(h);
    if (inferred && canonical[inferred] === undefined) {
      canonical[inferred] = i;
    }
  });
  return canonical;
}

function getByAliases(rowMap, aliases) {
  // direct key hit
  for (const a of aliases) {
    if (rowMap[a] !== undefined && rowMap[a] !== "") return rowMap[a];
  }
  // normalized fallback key hit
  const normalized = {};
  for (const [k, v] of Object.entries(rowMap)) {
    normalized[normalizeHeaderKey(k)] = v;
  }
  for (const a of aliases) {
    const v = normalized[normalizeHeaderKey(a)];
    if (v !== undefined && v !== "") return v;
  }
  return "";
}

function parseLooseNumber(value) {
  if (value === undefined || value === null) return 0;
  const raw = value.toString().trim();
  if (!raw || raw === "-" || /^history$/i.test(raw)) return 0;
  const normalized = raw.replace(/,/g, "").replace(/%/g, "").trim();
  const n = Number(normalized);
  return Number.isFinite(n) ? n : 0;
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function buildTagsFromRow(rowMap) {
  const tags = [];
  const rev3 = parseLooseNumber(getByAliases(rowMap, METRIC_GLOSSARY.revenueGrowth));
  const rev2 = parseLooseNumber(getByAliases(rowMap, METRIC_GLOSSARY.previousRevenueGrowth));
  const month = parseLooseNumber(getByAliases(rowMap, ["Month Chg %", "1Yr Chg %"]));
  const qtr = parseLooseNumber(getByAliases(rowMap, ["Qtr Chg %", "2Y price Chg %"]));
  const debt = parseLooseNumber(getByAliases(rowMap, METRIC_GLOSSARY.ltDebtToEquity));
  const delivery = parseLooseNumber(getByAliases(rowMap, METRIC_GLOSSARY.institutionalOwnership));
  const profit = parseLooseNumber(getByAliases(rowMap, METRIC_GLOSSARY.epsGrowth));
  const roe = parseLooseNumber(getByAliases(rowMap, METRIC_GLOSSARY.roe));
  const pe = parseLooseNumber(getByAliases(rowMap, METRIC_GLOSSARY.peRatio));

  if (rev3 > 50 || rev2 > 50) tags.push("high growth");
  if (month > 8 || qtr > 12) tags.push("momentum");
  if (profit > 20) tags.push("profit growth");
  if (roe > 15) tags.push("high roe");
  if (pe > 0 && pe < 20) tags.push("reasonable valuation");
  if (delivery > 65) tags.push("high delivery");
  if (debt < 0.5) tags.push("low debt");
  if (debt > 1.2) tags.push("high debt");

  return tags.length ? tags : ["emerging"];
}

function splitIndustryTags(value) {
  const txt = (value ?? "").toString().trim().toLowerCase();
  if (!txt) return [];
  return txt
    .split(/[,&/|-]/g)
    .map((s) => s.trim())
    .filter((s) => s.length >= 3);
}

function parseScreeningStyleTable(raw) {
  const allLines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!allLines.length) return [];

  const headerLine = allLines.find((l) => {
    if (!l.includes("Stock")) return false;
    const normalized = normalizeHeaderKey(l);
    return (
      normalized.includes("pettm") ||
      normalized.includes("roeann") ||
      normalized.includes("1yrchg") ||
      normalized.includes("revann3ygrowth") ||
      normalized.includes("marketcap")
    );
  });
  if (!headerLine) return null;

  const delimiter = headerLine.includes("\t") ? "\t" : /\s{2,}/;
  const rawHeader = (delimiter === "\t" ? headerLine.split("\t") : headerLine.split(delimiter))
    .map((h) => h.trim())
    .filter(Boolean);
  const header = rawHeader.filter((h) => !/^stock$/i.test(h)); // first text column is name line

  const noiseTokens = new Set([
    "board meeting",
    "premium parameter",
    "-",
    "history",
  ]);

  const startIdx = allLines.indexOf(headerLine) + 1;
  const rows = [];
  let i = startIdx;

  while (i < allLines.length) {
    // Format can be:
    // rank line, name line, then one or multiple metric/noise lines until next rank.
    const rankLine = allLines[i];
    if (!/^\d+$/.test(rankLine)) {
      i += 1;
      continue;
    }

    const nameLine = allLines[i + 1];
    if (!nameLine) break;

    let j = i + 2;
    const valueCells = [];
    while (j < allLines.length && !/^\d+$/.test(allLines[j])) {
      const parts = (delimiter === "\t" ? allLines[j].split("\t") : allLines[j].split(/\s{2,}/))
        .map((c) => c.trim())
        .filter(Boolean)
        .filter((token) => !noiseTokens.has(token.toLowerCase()));
      for (const p of parts) valueCells.push(p);
      j += 1;
    }

    const rowMap = {};
    for (let c = 0; c < header.length; c++) {
      rowMap[header[c]] = valueCells[c] ?? "";
    }

    const revenueGrowth = parseLooseNumber(
      getByAliases(rowMap, [...METRIC_GLOSSARY.revenueGrowth, ...METRIC_GLOSSARY.epsGrowth, ...METRIC_GLOSSARY.roe])
    ) / 100;
    const previousRevenueGrowth = parseLooseNumber(
      getByAliases(rowMap, [...METRIC_GLOSSARY.previousRevenueGrowth, "3Y price Chg %", "2Y price Chg %"])
    ) / 100;
    const monthChg = parseLooseNumber(getByAliases(rowMap, ["Month Chg %", "1Yr Chg %", "2Y price Chg %"]));
    const qtrChg = parseLooseNumber(getByAliases(rowMap, ["Qtr Chg %", "2Y price Chg %", "3Y price Chg %"]));
    const momentumScore = clamp01((monthChg + qtrChg + 100) / 200);
    let instProxy = clamp01(parseLooseNumber(getByAliases(rowMap, METRIC_GLOSSARY.institutionalOwnership)) / 100);
    if (instProxy === 0) {
      const pio = parseLooseNumber(getByAliases(rowMap, METRIC_GLOSSARY.piotroski));
      if (pio > 0) instProxy = clamp01(pio / 9);
    }
    if (instProxy === 0) instProxy = 0.45;
    const peProxy = parseLooseNumber(getByAliases(rowMap, METRIC_GLOSSARY.peRatio));
    const inferredIndustry = getByAliases(rowMap, ["Industry", "Industry Name"]);
    let sectorValue = getByAliases(rowMap, METRIC_GLOSSARY.sector);
    const subSectorValue = getByAliases(rowMap, METRIC_GLOSSARY.subSector) || inferredIndustry;
    if (!sectorValue && inferredIndustry) sectorValue = inferredIndustry;
    if (!sectorValue) sectorValue = "Unknown";
    const metricTags = buildTagsFromRow(rowMap);
    const industryTags = splitIndustryTags(subSectorValue);
    const combinedTags = Array.from(new Set([...metricTags, ...industryTags]));

    rows.push({
      name: nameLine,
      symbol: nameLine.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10),
      exchange: "NSE",
      sector: sectorValue,
      subSector: subSectorValue || undefined,
      tags: combinedTags.length ? combinedTags : ["emerging"],
      revenueGrowth: clamp01(revenueGrowth),
      previousRevenueGrowth: clamp01(previousRevenueGrowth),
      peRatio: peProxy,
      institutionalOwnership: instProxy,
      momentumScore,
    });

    i = j;
  }

  return rows.length ? rows : null;
}

function parseJsonOrCsv(input) {
  const raw = input.trim();
  if (!raw) return [];

  // JSON: array of stocks or { stocks: [...] }
  if (raw.startsWith("[") || raw.startsWith("{")) {
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.stocks) ? parsed.stocks : null;
    if (!arr) throw new Error("JSON must be an array of stocks or an object with a `stocks` array.");

    return arr.map((s) => {
      const sector = (s.sector ?? "").toString().trim();
      const subSector = s.subSector ? s.subSector.toString().trim() : undefined;
      const tags =
        Array.isArray(s.tags)
          ? s.tags.map((t) => t.toString().trim()).filter((t) => t.length > 0)
          : typeof s.tags === "string"
            ? parseTags(s.tags)
            : [sector, subSector].filter(Boolean);

      return {
        name: (s.name ?? "").toString().trim(),
        symbol: s.symbol ? s.symbol.toString().trim().toUpperCase() : undefined,
        exchange: (s.exchange ?? "NSE").toString().trim().toUpperCase(),
        sector,
        subSector,
        tags,
        revenueGrowth: Number(s.revenueGrowth ?? 0),
        previousRevenueGrowth: Number(s.previousRevenueGrowth ?? 0),
        peRatio: Number(s.peRatio ?? 0),
        institutionalOwnership: Number(s.institutionalOwnership ?? 0),
        momentumScore: Number(s.momentumScore ?? 0),
        netProfitYoYGrowth: Number(s.netProfitYoYGrowth ?? s.epsGrowth ?? 0),
        ltDebtToEquity: Number(s.ltDebtToEquity ?? s.debtToEquity ?? 0),
        piotroski: Number(s.piotroski ?? 0),
        distanceFromHigh: Number(s.distanceFromHigh ?? 0),
        revenueGrowthQoQ: Number(s.revenueGrowthQoQ ?? 0),
        epsGrowth: Number(s.epsGrowth ?? s.netProfitYoYGrowth ?? 0),
        roe: Number(s.roe ?? 0),
        roce: Number(s.roce ?? 0),
        altmanZ: Number(s.altmanZ ?? 0),
        debtToEquity: Number(s.debtToEquity ?? s.ltDebtToEquity ?? 0),
        peg: Number(s.peg ?? 0),
        pbv: Number(s.pbv ?? 0),
        industryPbv: Number(s.industryPbv ?? 0),
        institutionalActivity: Number(s.institutionalActivity ?? s.institutionalOwnership ?? 0),
        promoterHolding: Number(s.promoterHolding ?? 0),
      };
    });
  }

  // Special-case parser for copied screening tables that come as:
  // rank line -> stock name line -> metric line (repeated blocks)
  const screeningRows = parseScreeningStyleTable(raw);
  if (Array.isArray(screeningRows)) return screeningRows;

  // Delimited table: CSV (comma) or Excel paste (tab).
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length < 2) throw new Error("CSV must include a header row and at least one data row.");

  const pickDelimiter = (line) => {
    if ((line.match(/\t/g) || []).length >= 2) return "\t";
    if ((line.match(/,/g) || []).length >= 2) return ",";
    if ((line.match(/;/g) || []).length >= 2) return ";";
    return line.includes("\t") ? "\t" : ",";
  };
  const delimiter = pickDelimiter(lines[0]);
  const splitRow = (line) => line.split(delimiter).map((c) => c.trim());

  let headerLineIdx = 0;
  const scanLimit = Math.min(lines.length, 8);
  for (let i = 0; i < scanLimit; i++) {
    const probe = splitRow(lines[i]);
    const probeIdx = buildCanonicalHeaderIndex(probe);
    if (probeIdx.name !== undefined) {
      headerLineIdx = i;
      break;
    }
    const normalizedProbe = probe.map((h) => normalizeHeaderKey(h)).join("|");
    if (/(stock|company|symbol|ticker|industry|sector|pettm|revenue|growth)/.test(normalizedProbe)) {
      headerLineIdx = i;
      break;
    }
  }

  const header = splitRow(lines[headerLineIdx]);
  const canonicalIdx = buildCanonicalHeaderIndex(header);
  if (canonicalIdx.name === undefined) {
    // Fallback: treat first column as name if header is unusual.
    canonicalIdx.name = 0;
  }

  const idx = canonicalIdx;

  const getNum = (cols, i, idx, key, aliases = []) => {
    let v;
    if (idx[key] !== undefined) v = cols[idx[key]];
    if ((v === undefined || v === "") && aliases.length) {
      for (const alias of aliases) {
        const aIdx = idx[alias];
        if (aIdx !== undefined && cols[aIdx] !== undefined && cols[aIdx] !== "") {
          v = cols[aIdx];
          break;
        }
      }
    }
    if (v === undefined || v === "") return 0;
    const n = parseLooseNumber(v);
    if (Number.isNaN(n)) throw new Error(`Invalid number in column ${key} on row ${i + 1}.`);
    return n;
  };

  const stocks = [];
  for (let i = headerLineIdx + 1; i < lines.length; i++) {
    const cols = splitRow(lines[i]);
    if (!cols.length) continue;
    const maybeRank = (cols[0] || "").trim();
    // Ignore pure rank rows from copied screeners.
    if (/^\d+$/.test(maybeRank) && cols.length <= 2) continue;
    const rowMap = {};
    for (let c = 0; c < header.length; c++) rowMap[header[c]] = cols[c] ?? "";
    const subSector = idx["subSector"] !== undefined ? cols[idx["subSector"]] || "" : "";
    const inferredIndustry = getByAliases(rowMap, ["Industry", "Industry Name"]);
    let sector = idx["sector"] !== undefined ? cols[idx["sector"]] || "" : "";
    if (!sector && inferredIndustry) sector = inferredIndustry;
    if (!sector) sector = "Unknown";
    const tagsCell = idx["tags"] !== undefined ? cols[idx["tags"]] || "" : "";
    const parsedTags = parseTags(tagsCell);
    const metricTags = buildTagsFromRow(rowMap);
    const industryTags = splitIndustryTags(subSector || inferredIndustry);
    const tags = Array.from(new Set([...parsedTags, ...metricTags, ...industryTags]));
    const revenueGrowthRaw = getNum(cols, i + 1, idx, "revenueGrowth");
    const epsGrowthRaw = getNum(cols, i + 1, idx, "epsGrowth");
    const roeRaw = getNum(cols, i + 1, idx, "roe");
    const revenueGrowth = clamp01((revenueGrowthRaw || epsGrowthRaw || roeRaw) / 100);
    const previousRevenueGrowth = clamp01(
      getNum(cols, i + 1, idx, "previousRevenueGrowth") / 100 || getNum(cols, i + 1, idx, "momentumScore") / 100
    );
    const peRatio = getNum(cols, i + 1, idx, "peRatio");
    const piotroski = getNum(cols, i + 1, idx, "piotroski");
    let institutionalOwnership = getNum(cols, i + 1, idx, "institutionalOwnership") / 100;
    if (!institutionalOwnership) institutionalOwnership = piotroski ? clamp01(piotroski / 9) : 0.45;
    const oneY = getNum(cols, i + 1, idx, "momentumScore");
    const twoY = getNum(cols, i + 1, idx, "previousRevenueGrowth");
    const momentumScore = clamp01((oneY + twoY + 100) / 200);

    const rowName = (cols[idx["name"]] || "").trim();
    if (!rowName) continue;

    stocks.push({
      name: rowName,
      symbol: idx["symbol"] !== undefined ? cols[idx["symbol"]] || "" : "",
      exchange: idx["exchange"] !== undefined ? (cols[idx["exchange"]] || "NSE").toUpperCase() : "NSE",
      sector,
      subSector: (subSector || inferredIndustry) || undefined,
      tags: tags.length ? tags : [sector, subSector, inferredIndustry].filter(Boolean),
      revenueGrowth,
      previousRevenueGrowth,
      peRatio,
      institutionalOwnership: clamp01(institutionalOwnership),
      momentumScore,
    });
  }

  return stocks;
}

function renderRecommendations(themesRanked) {
  const list = $("recsList");
  list.innerHTML = "";

  if (!themesRanked || !themesRanked.length) {
    const msg = document.createElement("div");
    msg.className = "subtle";
    msg.textContent = "No recommendations yet (no stocks matched strongly enough).";
    list.appendChild(msg);
    return;
  }

  const bandFromScore01 = (x) => {
    const n = Number(x);
    if (!Number.isFinite(n)) return { scaled: 1, band: "Low" };
    const clipped = Math.max(0, Math.min(1, n));
    const scaled = 1 + clipped * 4;
    let band = "Low";
    if (scaled >= 4.4) band = "Excellent";
    else if (scaled >= 3.6) band = "Strong";
    else if (scaled >= 2.8) band = "Good";
    else if (scaled >= 2.0) band = "Fair";
    return { scaled, band };
  };

  const fmt01 = (x) => {
    const n = Number(x);
    if (!Number.isFinite(n)) return "1.0/5 (Low)";
    const { scaled, band } = bandFromScore01(n);
    return `${scaled.toFixed(1)}/5 (${band})`;
  };

  /** Match backend formatPercentLikeDecimal: value may be fraction or already a percent. */
  const fmtPercentLike = (value) => {
    if (!Number.isFinite(value)) return "—";
    const pct = value > 1 ? (value <= 100 ? value : 100) : value * 100;
    return `${pct.toFixed(2)}%`;
  };

  /** Prefer a concrete raw reading; fall back to the 1–5 score. Band always from the normalized score. */
  const fmtActualWithBand = (raw, score01, formatRaw) => {
    const s = Number(score01);
    const scoreOk = Number.isFinite(s);
    const n = Number(raw);
    const rawOk = Number.isFinite(n);
    if (!scoreOk && !rawOk) return "—";
    const { scaled, band } = bandFromScore01(scoreOk ? s : 0);
    if (rawOk) {
      return `${formatRaw(n)} (${band})`;
    }
    return `${scaled.toFixed(1)}/5 (${band})`;
  };

  const stockMap = new Map();
  for (const t of themesRanked) {
    const themeLabel = t.theme ?? "Theme";
    const topStocks = Array.isArray(t.topStocks) ? t.topStocks : [];
    for (const s of topStocks) {
      const key = `${s.name ?? ""}|${s.symbol ?? ""}`;
      if (!stockMap.has(key)) {
        stockMap.set(key, {
          stock: s,
          themes: new Set(),
          tags: new Set(),
        });
      }
      const entry = stockMap.get(key);
      entry.themes.add(themeLabel);
      if (s.sector) entry.tags.add(s.sector);
      if (s.subSector) entry.tags.add(s.subSector);
      if (!entry.stock.score || Number(s.score ?? 0) > Number(entry.stock.score ?? 0)) {
        entry.stock = s; // keep best-confidence projection
      }
    }
  }

  const convictionRank = { HIGH: 3, MEDIUM: 2, LOW: 1 };
  const flattened = Array.from(stockMap.values())
    .map((x) => ({
      ...x.stock,
      _themes: Array.from(x.themes),
      _tags: Array.from(x.tags),
    }))
    .sort((a, b) => {
      const c = (convictionRank[b.conviction] || 0) - (convictionRank[a.conviction] || 0);
      if (c !== 0) return c;
      return Number(b.score ?? 0) - Number(a.score ?? 0);
    });

  for (const s of flattened) {
    const row = document.createElement("div");
    row.className = "card";

    const stockTop = document.createElement("div");
    stockTop.className = "stockTopLine";

    const name = document.createElement("div");
    name.className = "stockName";
    name.textContent = s.symbol ? `${s.name ?? "Stock"} (${s.symbol})` : (s.name ?? "Stock");
    stockTop.appendChild(name);

    const scoreChip = document.createElement("div");
    scoreChip.className = "scoreChip";
    const scoreStr = typeof s.score === "number" ? s.score.toFixed(3) : String(s.score ?? "");
    scoreChip.textContent = `Score ${scoreStr}`;
    stockTop.appendChild(scoreChip);

    if (s.tier) {
      const tierChip = document.createElement("div");
      tierChip.className = "tierChip";
      tierChip.textContent = `${s.conviction ?? "LOW"} • ${s.tier}`;
      stockTop.appendChild(tierChip);
    }

    row.appendChild(stockTop);

    const tagWrap = document.createElement("div");
    tagWrap.className = "chips";
    for (const t of (s._themes || []).slice(0, 4)) {
      const chip = document.createElement("div");
      chip.className = "chip";
      chip.textContent = `Theme: ${t}`;
      tagWrap.appendChild(chip);
    }
    for (const tag of (s._tags || []).slice(0, 3)) {
      const chip = document.createElement("div");
      chip.className = "chip";
      chip.textContent = `Sector: ${tag}`;
      tagWrap.appendChild(chip);
    }
    row.appendChild(tagWrap);

    const breakdown = s.scoreBreakdown ?? {};
    const scorePct = Math.max(0, Math.min(1, Number(s.score ?? 0)));

    const barLabel = document.createElement("div");
    barLabel.className = "scoreBarLabelRow";
    barLabel.innerHTML = `<span>Overall score</span><span>${fmt01(scorePct)}</span>`;
    row.appendChild(barLabel);

    const barWrap = document.createElement("div");
    barWrap.className = "scoreBarWrap";
    const bar = document.createElement("div");
    bar.className = "scoreBar";
    const fill = document.createElement("div");
    fill.className = "scoreBarFill";
    fill.style.width = `${Math.round(scorePct * 100)}%`;
    bar.appendChild(fill);
    barWrap.appendChild(bar);
    row.appendChild(barWrap);

    const grid = document.createElement("div");
    grid.className = "breakdownGrid";
    const fmtPiotroskiRaw = (v) =>
      Math.abs(v - Math.round(v)) < 1e-6 ? String(Math.round(v)) : v.toFixed(1);
    const fmtInstitutionalRaw = (v) =>
      v.toLocaleString(undefined, { maximumFractionDigits: 2 });

    const bdItems = [
      ["Theme relevance", fmt01(breakdown.themeRelevance ?? 0)],
      ["Growth factor", fmt01(breakdown.growthFactor ?? 0)],
      ["Momentum factor", fmt01(breakdown.momentumFactor ?? 0)],
      ["Durability factor", fmt01(breakdown.durabilityFactor ?? 0)],
      ["Valuation factor", fmt01(breakdown.valuationFactor ?? 0)],
      ["Participation factor", fmt01(breakdown.participationFactor ?? 0)],
      [
        "Revenue growth",
        fmtActualWithBand(breakdown.rawRevenueGrowth, breakdown.revenueGrowthScore ?? 0, fmtPercentLike),
      ],
      [
        "EPS growth",
        fmtActualWithBand(breakdown.rawEpsGrowth, breakdown.epsGrowthScore ?? 0, fmtPercentLike),
      ],
      [
        "Debt score",
        fmtActualWithBand(breakdown.rawDebtToEquity, breakdown.debtScore ?? 0, (x) => x.toFixed(2)),
      ],
      [
        "Piotroski",
        fmtActualWithBand(breakdown.rawPiotroski, breakdown.piotroskiScore ?? 0, fmtPiotroskiRaw),
      ],
      [
        "Momentum score",
        fmtActualWithBand(breakdown.rawMomentum, breakdown.momentumScore ?? 0, fmtPercentLike),
      ],
      [
        "Institutional",
        fmtActualWithBand(breakdown.rawInstitutional, breakdown.institutionalScore ?? 0, fmtInstitutionalRaw),
      ],
      ["Acceleration", fmt01(breakdown.accelerationScore ?? 0)],
      ["Breakout", fmt01(breakdown.breakoutScore ?? 0)],
    ];
    for (const [k, v] of bdItems) {
      const item = document.createElement("div");
      item.className = "breakdownItem";
      item.innerHTML = `${k}: <span class="breakdownValue">${v}</span>`;
      grid.appendChild(item);
    }
    row.appendChild(grid);

    if (typeof breakdown.baseScore === "number") {
      const detail = document.createElement("div");
      detail.className = "reasonItem";
      const mult = Number(breakdown.themeStrengthMultiplier ?? 1).toFixed(2);
      const elite = Number(breakdown.eliteBoost ?? 0).toFixed(2);
      const raw = Number(breakdown.rawCompositeScore ?? 0).toFixed(3);
      detail.textContent = `Score build: base ${breakdown.baseScore.toFixed(3)} × themeStrength ${mult} + elite ${elite} => raw ${raw}`;
      detail.style.marginTop = "6px";
      row.appendChild(detail);
    }

    if (s.whyNow) {
      const why = document.createElement("div");
      why.className = "reasonItem";
      why.textContent = `Why now: ${s.whyNow}`;
      why.style.marginTop = "8px";
      row.appendChild(why);
    }

    const signals = Array.isArray(s.signals) ? s.signals.filter(Boolean) : [];
    if (signals.length) {
      const signalRow = document.createElement("div");
      signalRow.className = "signalRow";
      for (const sig of signals) {
        const badge = document.createElement("div");
        badge.className = "signalBadge";
        const map = {
          "Breakout Candidate": "🚀 Breakout Candidate",
          "High Growth": "📈 High Growth",
          "Institutional Buying": "🏦 Institutional Buying",
        };
        badge.textContent = map[sig] ?? sig;
        signalRow.appendChild(badge);
      }
      row.appendChild(signalRow);
    }

    const reasons = Array.isArray(s.reason) ? s.reason.filter(Boolean) : [];
    if (reasons.length) {
      const reasonList = document.createElement("div");
      reasonList.className = "reasonList";

      const r1 = document.createElement("div");
      r1.className = "reasonItem";
      r1.textContent = `Theme: ${reasons[0] ?? ""}`;
      reasonList.appendChild(r1);

      if (reasons[1]) {
        const r2 = document.createElement("div");
        r2.className = "reasonItem";
        r2.textContent = `Metric: ${reasons[1] ?? ""}`;
        reasonList.appendChild(r2);
      }

      row.appendChild(reasonList);
    }

    const profile = Array.isArray(s.strengthProfile) ? s.strengthProfile.filter(Boolean) : [];
    if (profile.length) {
      const profileBlock = document.createElement("div");
      profileBlock.className = "reasonList";
      const head = document.createElement("div");
      head.className = "reasonItem";
      head.textContent = "Strength profile:";
      profileBlock.appendChild(head);
      for (const p of profile.slice(0, 4)) {
        const it = document.createElement("div");
        it.className = "reasonItem";
        it.textContent = `- ${p}`;
        profileBlock.appendChild(it);
      }
      row.appendChild(profileBlock);
    }

    const risks = Array.isArray(s.riskFlags) ? s.riskFlags.filter(Boolean) : [];
    if (risks.length) {
      const riskBlock = document.createElement("div");
      riskBlock.className = "reasonList";
      const head = document.createElement("div");
      head.className = "reasonItem";
      head.textContent = "Risk flags:";
      riskBlock.appendChild(head);
      for (const rf of risks.slice(0, 4)) {
        const it = document.createElement("div");
        it.className = "reasonItem";
        it.textContent = `- ${rf}`;
        riskBlock.appendChild(it);
      }
      row.appendChild(riskBlock);
    }

    list.appendChild(row);
  }
}

async function fetchJson(path, options = {}) {
  const timeoutMs = Number(options.timeoutMs ?? 30000);
  const forceRefresh = options.forceRefresh === true;
  const endpoint = new URL(path, window.location.origin);
  if (activeNarrativeSources.length) {
    endpoint.searchParams.set("sources", activeNarrativeSources.join(","));
  }
  if (activeNarrativeUrls.length) {
    endpoint.searchParams.set("sourceUrls", activeNarrativeUrls.join("\n"));
  }
  if (forceRefresh) {
    endpoint.searchParams.set("refresh", "1");
    endpoint.searchParams.set("_t", String(Date.now()));
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(endpoint.toString(), { method: "GET", signal: controller.signal });
  } catch (err) {
    if (err && err.name === "AbortError") {
      throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Request failed (${res.status}). ${text}`.trim());
  }
  return res.json();
}

function parseTavilyMacroDomainsInput(raw) {
  const parts = (raw ?? "")
    .split(/[,\n]/g)
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const p of parts) {
    try {
      const u = p.includes("://") ? new URL(p) : new URL(`https://${p}`);
      const host = u.hostname.replace(/^www\./, "").toLowerCase();
      if (!host || seen.has(host)) continue;
      seen.add(host);
      out.push(host);
      if (out.length >= 16) break;
    } catch {
      // skip invalid tokens
    }
  }
  return out;
}

function syncTavilyMacroFromInput() {
  const dEl = $("tavilyMacroDomainsInput");
  const hEl = $("tavilyMacroDomainHint");
  if (dEl) {
    activeTavilyMacroDomains = parseTavilyMacroDomainsInput(dEl.value);
    try {
      sessionStorage.setItem(TAVILY_MACRO_DOMAINS_KEY, dEl.value);
    } catch {
      // ignore
    }
  }
  if (hEl) {
    activeTavilyMacroDomainHint = (hEl.value || "").trim().slice(0, 220);
    try {
      sessionStorage.setItem(TAVILY_MACRO_HINT_KEY, hEl.value || "");
    } catch {
      // ignore
    }
  }
}

function restoreTavilyMacroUi() {
  const dEl = $("tavilyMacroDomainsInput");
  const hEl = $("tavilyMacroDomainHint");
  try {
    const sd = sessionStorage.getItem(TAVILY_MACRO_DOMAINS_KEY);
    const sh = sessionStorage.getItem(TAVILY_MACRO_HINT_KEY);
    if (dEl) {
      if (sd !== null) dEl.value = sd;
      else dEl.value = DEFAULT_TAVILY_MACRO_DOMAINS_TEXT;
    }
    if (hEl && sh !== null) hEl.value = sh;
  } catch {
    if (dEl && !dEl.value) dEl.value = DEFAULT_TAVILY_MACRO_DOMAINS_TEXT;
  }
  syncTavilyMacroFromInput();
}

function parseNarrativeSourcesInput(raw) {
  const parts = (raw ?? "")
    .split(/[,\n]/g)
    .map((s) => s.trim())
    .filter(Boolean);
  const domains = [];
  const urls = [];
  const seenDomains = new Set();
  const seenUrls = new Set();
  const toDomain = (value) => {
    const v = value.trim();
    if (!v) return "";
    try {
      const url = v.includes("://") ? new URL(v) : new URL(`https://${v}`);
      return url.hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      return "";
    }
  };
  for (const p of parts) {
    const token = p.trim();
    const isUrl = /^https?:\/\//i.test(token);
    if (isUrl) {
      try {
        const u = new URL(token);
        u.hash = ""; // UI fragments like #zoom are local-only and should not affect backend fetch.
        const normalizedUrl = u.toString();
        if (!seenUrls.has(normalizedUrl) && urls.length < 7) {
          seenUrls.add(normalizedUrl);
          urls.push(normalizedUrl);
        }
      } catch {
        // ignore invalid URL
      }
    }

    const d = toDomain(token);
    if (!d || seenDomains.has(d)) continue;
    seenDomains.add(d);
    domains.push(d);
    if (domains.length >= 7) break;
  }
  return { domains, urls };
}

function renderParseDiagnostics(diag) {
  const box = $("stocksDiagnostics");
  if (!box) return;
  if (!diag || typeof diag !== "object") {
    box.hidden = true;
    box.textContent = "";
    return;
  }

  const canonicalPairs = Object.entries(diag.canonicalMap ?? {})
    .map(([k, v]) => `${k} -> ${v}`)
    .slice(0, 14);
  const skippedPairs = Object.entries(diag.skippedReasons ?? {})
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");
  const unmatched = Array.isArray(diag.unmatchedHeaders) ? diag.unmatchedHeaders.slice(0, 12).join(", ") : "";

  box.textContent =
    `Parse report\n` +
    `- delimiter: ${diag.delimiter ?? "unknown"}\n` +
    `- headerRowIndex: ${diag.headerRowIndex ?? 0}\n` +
    `- acceptedRows: ${diag.acceptedRows ?? 0}/${diag.totalDataRows ?? 0}\n` +
    `- skippedRows: ${diag.skippedRows ?? 0}${skippedPairs ? ` (${skippedPairs})` : ""}\n` +
    `- mappedHeaders: ${canonicalPairs.join(" | ") || "none"}\n` +
    `- unmatchedHeaders: ${unmatched || "none"}`;
  box.hidden = false;
}

async function loadRecommendations(options = {}) {
  const status = $("recsStatus");
  const requestId = ++latestRecommendationsRequestId;
  if (recommendationsProgressTicker) {
    clearInterval(recommendationsProgressTicker);
    recommendationsProgressTicker = null;
  }
  showStatus(status, "Loading recommendations...", null);
  recommendationsProgressTicker = setInterval(() => {
    if (requestId !== latestRecommendationsRequestId) return;
    showStatus(status, "Still processing recommendations...", null);
  }, 4000);
  try {
    const data = await fetchJson("/recommendations", { timeoutMs: 45000, forceRefresh: options.forceRefresh === true });
    if (requestId !== latestRecommendationsRequestId) return;
    const themesRanked = data.themes ?? data.recommendations ?? data.items ?? [];
    const reason = (data?.meta?.reason ?? "").toString().toUpperCase();
    if (!themesRanked.length && (reason === "NO_STOCKS" || !hasSubmittedStocks)) {
      showStatus(status, "Paste stock data to generate recommendations.", null);
      renderRecommendations([]);
      return;
    }
    if (!themesRanked.length && reason === "NO_MATCHES") {
      showStatus(status, "No strong matches found for current themes and stock universe.", null);
      renderRecommendations([]);
      return;
    }
    if (themesRanked.length) hasSubmittedStocks = true;
    renderRecommendations(themesRanked);
    status.textContent = "";
  } catch (e) {
    if (requestId !== latestRecommendationsRequestId) return;
    showStatus(status, `Failed to load recommendations: ${e.message || e}`, "error");
  } finally {
    if (requestId === latestRecommendationsRequestId && recommendationsProgressTicker) {
      clearInterval(recommendationsProgressTicker);
      recommendationsProgressTicker = null;
    }
  }
}

function syncNarrativeFromInput() {
  const input = $("narrativeSourcesInput");
  if (!input) return;
  const parsed = parseNarrativeSourcesInput(input.value);
  activeNarrativeSources = parsed.domains;
  activeNarrativeUrls = parsed.urls;
}

function prepopulateDefaultNarrativeSources() {
  const input = $("narrativeSourcesInput");
  if (!input) return;
  input.value = DEFAULT_NARRATIVE_SOURCES.join("\n");
  syncNarrativeFromInput();
}

async function submitStocks(options = {}) {
  const replaceExisting = options.replaceExisting !== false;
  const status = $("stocksStatus");
  const input = $("stocksInput").value;
  status.textContent = "";

  const raw = (input ?? "").trim();
  if (!raw) {
    showStatus(status, "Nothing to submit. Paste JSON/CSV or upload a file.", "error");
    return;
  }

  let payload;
  if (raw.startsWith("[") || raw.startsWith("{")) {
    let stocks;
    try {
      stocks = parseJsonOrCsv(raw);
    } catch (e) {
      showStatus(status, e.message || String(e), "error");
      return;
    }
    if (!stocks.length) {
      showStatus(status, "Nothing to submit. Paste JSON with at least one stock.", "error");
      return;
    }
    payload = { stocks, replace: replaceExisting };
  } else {
    // For CSV/TSV uploads and Excel pastes, let backend parser handle quotes/large files.
    payload = { csv: raw, replace: replaceExisting };
  }

  try {
    const res = await fetch("/stocks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await res.json().catch(() => null);
    if (!res.ok) {
      if (data?.parseDiagnostics) renderParseDiagnostics(data.parseDiagnostics);
      const text = data ? JSON.stringify(data) : await res.text().catch(() => "");
      throw new Error(`Request failed (${res.status}). ${text}`.trim());
    }

    renderParseDiagnostics(data?.parseDiagnostics ?? null);
    hasSubmittedStocks = true;
    const accepted = Number(data?.received ?? 0);
    const rejected = Number(data?.rejected ?? 0);
    const modeLabel = data?.mode === "merge" ? "merged" : "replaced";
    showStatus(
      status,
      `Stocks ${modeLabel} (${accepted} accepted, ${rejected} rejected).`,
      null
    );
    syncNarrativeFromInput();
    const recsStatusEl = $("recsStatus");
    if (recsStatusEl) {
      showStatus(recsStatusEl, "Updating recommendations…", null);
    }
    await loadRecommendations();
  } catch (e) {
    showStatus(status, `Failed to submit stocks: ${e.message || e}`, "error");
  }
}

async function loadCsvFromFile() {
  const status = $("stocksStatus");
  const input = $("stocksFile");
  const file = input && input.files ? input.files[0] : null;
  if (!file) {
    showStatus(status, "Choose a CSV/TSV file first.", "error");
    return;
  }

  try {
    const text = await file.text();
    const lineCount = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean).length;
    $("stocksInput").value = text;
    renderParseDiagnostics(null);
    showStatus(status, `Loaded ${file.name} (${lineCount} non-empty lines). Starting processing...`, null);
    await submitStocks({ replaceExisting: true });
  } catch (e) {
    showStatus(status, `Failed to read file: ${e.message || e}`, "error");
  }
}

const INDUSTRY_INTEL_SNAPSHOT_KEY = "sentinel_industry_intel_snapshot_v2";

function readIndustrySnapshot() {
  try {
    const raw = sessionStorage.getItem(INDUSTRY_INTEL_SNAPSHOT_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (o && o.v === 2 && o.ind && o.sec) return o;
    return null;
  } catch {
    return null;
  }
}

function writeIndustrySnapshot(payload) {
  const ind = {};
  payload.top_industries.forEach((item, i) => {
    ind[item.name] = { rank: i + 1, bucket: "top", classification: item.classification };
  });
  payload.avoid_list.forEach((item, i) => {
    ind[item.name] = { rank: i + 1, bucket: "avoid", classification: item.classification };
  });
  const sec = {};
  const sectors = payload.top_sectors || [];
  sectors.forEach((s, i) => {
    sec[s.sector] = { rank: i + 1 };
  });
  sessionStorage.setItem(INDUSTRY_INTEL_SNAPSHOT_KEY, JSON.stringify({ v: 2, ind, sec }));
}

function clearIndustrySnapshot() {
  sessionStorage.removeItem(INDUSTRY_INTEL_SNAPSHOT_KEY);
}

function findIndustryPlacement(name, top, avoid) {
  const ti = top.findIndex((x) => x.name === name);
  if (ti >= 0) return { bucket: "top", rank: ti + 1 };
  const ai = avoid.findIndex((x) => x.name === name);
  if (ai >= 0) return { bucket: "avoid", rank: ai + 1 };
  return null;
}

function snapshotIndustryLayer(prevMap) {
  if (!prevMap) return {};
  return prevMap.ind != null ? prevMap.ind : prevMap;
}

function formatSectorMovement(sector, index, prevSecMap) {
  const rank = index + 1;
  const hasBaseline = prevSecMap && Object.keys(prevSecMap).length > 0;
  if (!hasBaseline) {
    return { text: "—", cls: "flat" };
  }
  const prev = prevSecMap[sector];
  if (!prev) {
    return { text: "new", cls: "new" };
  }
  const delta = prev.rank - rank;
  if (delta > 0) return { text: `↑ #${prev.rank} → #${rank}`, cls: "up" };
  if (delta < 0) return { text: `↓ #${prev.rank} → #${rank}`, cls: "down" };
  return { text: `#${rank}`, cls: "flat" };
}

function formatIndustryMovement(name, prevMap, top, avoid) {
  const layer = snapshotIndustryLayer(prevMap);
  const curr = findIndustryPlacement(name, top, avoid);
  const hasBaseline = layer && Object.keys(layer).length > 0;

  if (!hasBaseline) {
    return { text: "—", cls: "flat" };
  }

  const prev = layer[name];
  if (!prev && curr) {
    return { text: "new", cls: "new" };
  }
  if (!prev && !curr) {
    return { text: "—", cls: "flat" };
  }
  if (prev && !curr) {
    if (prev.bucket === "top") {
      return { text: `↓ #${prev.rank} → off list`, cls: "down" };
    }
    if (prev.bucket === "avoid") {
      return { text: `↑ left avoid`, cls: "up" };
    }
    return { text: "—", cls: "flat" };
  }

  if (prev.bucket === "top" && curr.bucket === "avoid") {
    return { text: `↓ #${prev.rank} → Avoid`, cls: "down" };
  }
  if (prev.bucket === "avoid" && curr.bucket === "top") {
    return { text: `↑ Avoid → #${curr.rank}`, cls: "up" };
  }
  if (prev.bucket === curr.bucket) {
    const delta = prev.rank - curr.rank;
    if (delta > 0) return { text: `↑ #${prev.rank} → #${curr.rank}`, cls: "up" };
    if (delta < 0) return { text: `↓ #${prev.rank} → #${curr.rank}`, cls: "down" };
    return { text: `#${curr.rank}`, cls: "flat" };
  }
  return { text: "—", cls: "flat" };
}

function macroControlsToQuery() {
  return {
    rates: $("macroRates").value,
    inflation: $("macroInflation").value,
    yields: $("macroYields").value,
    growth: $("macroGrowth").value,
  };
}

let suppressMacroSelectEvents = false;

function isMacroAutoSource() {
  const el = $("macroSourceAuto");
  return el && el.checked;
}

function ensureSelectOption(selectEl, value) {
  if (!selectEl || value === undefined || value === null) return;
  const v = String(value);
  const allowed = [...selectEl.options].map((o) => o.value);
  if (allowed.includes(v)) {
    selectEl.value = v;
    return;
  }
  console.warn("Macro auto: value not in list", selectEl.id, v, allowed);
}

function setMacroSelects(macro) {
  if (!macro || typeof macro !== "object") return;
  suppressMacroSelectEvents = true;
  ensureSelectOption($("macroRates"), macro.rates);
  ensureSelectOption($("macroInflation"), macro.inflation);
  ensureSelectOption($("macroYields"), macro.yields);
  ensureSelectOption($("macroGrowth"), macro.growth);
  suppressMacroSelectEvents = false;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderMacroConfidence(conf, usedFallback) {
  const el = $("macroConfidenceRow");
  if (!el) return;
  if (!isMacroAutoSource()) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  if (usedFallback) {
    el.hidden = false;
    el.innerHTML =
      "<strong>Auto macro</strong> — Tavily had no API key or no usable text; <strong>default preset</strong> is applied. Switch to Manual to edit.";
    return;
  }
  if (!conf) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.innerHTML = [
    "<strong>Auto confidence (vote share)</strong> — ",
    `Rates ${escapeHtml(conf.rates)}% · `,
    `Inflation ${escapeHtml(conf.inflation)}% · `,
    `Yields ${escapeHtml(conf.yields)}% · `,
    `Growth ${escapeHtml(conf.growth)}%`,
  ].join("");
}

async function fetchMacroFromTavilyApi() {
  syncTavilyMacroFromInput();
  const u = new URL("/macro-from-tavily", window.location.origin);
  if (activeTavilyMacroDomains.length) {
    u.searchParams.set("tavilyDomains", activeTavilyMacroDomains.join(","));
  }
  if (activeTavilyMacroDomainHint) {
    u.searchParams.set("domainHint", activeTavilyMacroDomainHint);
  }
  const res = await fetch(u.toString(), {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  const raw = await res.text();
  const ct = (res.headers.get("content-type") ?? "").toLowerCase();
  if (!res.ok) {
    throw new Error(`Macro auto failed (${res.status}). ${raw.slice(0, 200)}`.trim());
  }
  if (!ct.includes("json") && !raw.trimStart().startsWith("{")) {
    throw new Error(
      "Macro auto: server returned HTML instead of JSON. Restart the backend after `npm run build` so /macro-from-tavily is registered."
    );
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("Macro auto: invalid JSON from server.");
  }
  if (!data.macro || typeof data.macro !== "object") {
    throw new Error("Macro auto: response missing macro object.");
  }
  return data;
}

async function applyAutoMacroFromTavily() {
  const status = $("industryIntelStatus");
  showStatus(status, "Fetching macro via Tavily (four research queries)…", null);
  try {
    const data = await fetchMacroFromTavilyApi();
    setMacroSelects(data.macro);
    renderMacroConfidence(data.confidence, data.usedFallback);
    const m = data.macro;
    const presetNote =
      m.rates === "Stable" &&
      m.inflation === "Stable" &&
      m.yields === "Rising" &&
      m.growth === "Expanding"
        ? " (same as default preset — Tavily may agree with your baseline or had no strong signal)."
        : "";
    if (!data.usedFallback) {
      showStatus(
        status,
        `Macro (Tavily): rates ${m.rates}, inflation ${m.inflation}, yields ${m.yields}, growth ${m.growth}${presetNote} Loading ranks…`,
        null
      );
    } else {
      showStatus(
        status,
        "Tavily unavailable or empty — kept default macro. Set TAVILY_API_KEY and restart the server.",
        null
      );
    }
  } catch (e) {
    showStatus(status, e.message || String(e), "error");
    const el = $("macroConfidenceRow");
    if (el && isMacroAutoSource()) {
      el.hidden = false;
      el.innerHTML =
        "<strong>Auto macro failed</strong> — using on-screen values. Check Tavily API key or try again.";
    }
  }
}

async function fetchIndustryIntelligenceJson(macro, timeoutMs = 30000) {
  const endpoint = new URL("/industry-intelligence", window.location.origin);
  endpoint.searchParams.set("rates", macro.rates);
  endpoint.searchParams.set("inflation", macro.inflation);
  endpoint.searchParams.set("yields", macro.yields);
  endpoint.searchParams.set("growth", macro.growth);
  if (activeNarrativeSources.length) {
    endpoint.searchParams.set("sources", activeNarrativeSources.join(","));
  }
  if (activeNarrativeUrls.length) {
    endpoint.searchParams.set("sourceUrls", activeNarrativeUrls.join("\n"));
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(endpoint.toString(), { method: "GET", signal: controller.signal });
  } catch (err) {
    if (err && err.name === "AbortError") {
      throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Request failed (${res.status}). ${text}`.trim());
  }
  return res.json();
}

function renderClassPill(cl) {
  const low = (cl || "").toLowerCase();
  const wrap = document.createElement("span");
  const mid = low === "watch" || low === "neutral";
  wrap.className = `classPill ${low === "buy" ? "buy" : mid ? "neutral" : "avoid"}`;
  wrap.textContent = cl || "";
  return wrap;
}

function signalStrengthPillClass(strength) {
  const s = String(strength || "").toUpperCase();
  if (s === "STRONG") return "signalPill strong";
  if (s === "WEAK") return "signalPill weak";
  return "signalPill moderate";
}

function strengthArrow(strength) {
  const s = String(strength || "").toUpperCase();
  if (s === "STRONG") return "↑";
  if (s === "WEAK") return "↓";
  return "→";
}

function momHuman(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  if (n >= 0.62) return "High";
  if (n >= 0.48) return "Mid";
  return "Low";
}

function breadthHuman(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  if (n >= 0.58) return "Strong";
  if (n >= 0.45) return "Mixed";
  return "Thin";
}

function rsHuman(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  if (n >= 0.62) return "Leader";
  if (n >= 0.48) return "Inline";
  return "Laggard";
}

function verdictHuman(cl) {
  const u = String(cl || "").toUpperCase();
  if (u === "BUY") return "BUY";
  if (u === "WATCH" || u === "NEUTRAL") return "Watch";
  return "Avoid";
}

function renderSectorTopList(el, sectors, prevSec, prevInd, top, avoid) {
  el.textContent = "";
  if (!sectors.length) {
    const p = document.createElement("p");
    p.className = "intelEmpty";
    p.textContent = "No sector aggregates (waiting for industry data).";
    el.appendChild(p);
    return;
  }
  for (let i = 0; i < sectors.length; i++) {
    const sv = sectors[i];
    const card = document.createElement("article");
    card.className = "sectorCard sectorCardCompressed";
    const head = document.createElement("div");
    head.className = "sectorCardHead";
    const rank = document.createElement("span");
    rank.className = "sectorRank";
    rank.textContent = `#${i + 1}`;
    const headText = document.createElement("div");
    headText.className = "sectorHeadText";
    const title = document.createElement("div");
    title.className = "sectorTitle";
    title.textContent = sv.sector;

    const hero = document.createElement("div");
    hero.className = "sectorHeroLine";
    const st = String(sv.signal_strength || "MODERATE").toUpperCase();
    const sigPill = document.createElement("span");
    sigPill.className = signalStrengthPillClass(st);
    sigPill.textContent = `${st} ${strengthArrow(st)}`;
    const scoreNum = Number(sv.sector_score).toFixed(2);
    hero.appendChild(sigPill);
    hero.appendChild(document.createTextNode(` (${scoreNum})`));
    const sm = formatSectorMovement(sv.sector, i, prevSec);
    const mspan = document.createElement("span");
    mspan.className = `rankMove sectorHeroMove ${sm.cls}`;
    mspan.textContent = sm.text;
    hero.appendChild(mspan);

    const participation =
      sv.participation_line || sv.signal_summary || "Mixed participation vs macro.";
    const sub = document.createElement("div");
    sub.className = "sectorParticipationLine";
    sub.textContent = participation;

    headText.appendChild(title);
    headText.appendChild(hero);
    headText.appendChild(sub);
    head.appendChild(rank);
    head.appendChild(headText);
    card.appendChild(head);

    const playsTitle = document.createElement("div");
    playsTitle.className = "sectorSectionLabel sectorSectionLabelHero";
    playsTitle.textContent = "Top plays";
    card.appendChild(playsTitle);

    const plays = document.createElement("div");
    plays.className = "sectorTopPlays";
    const pins = sv.industries || [];
    for (let p = 0; p < pins.length; p++) {
      const pin = pins[p];
      const row = document.createElement("div");
      row.className = "sectorTopPlayRow";
      const pinRank = document.createElement("div");
      pinRank.className = "topPlayRank";
      pinRank.textContent = `#${p + 1}`;
      const body = document.createElement("div");
      body.className = "topPlayBody";
      const nameRow = document.createElement("div");
      nameRow.className = "topPlayNameRow";
      const nm = document.createElement("span");
      nm.className = "topPlayName";
      nm.textContent = pin.name;
      nameRow.appendChild(nm);
      if (p === 0) {
        const fire = document.createElement("span");
        fire.className = "topPlayFire";
        fire.textContent = " 🔥";
        fire.title = "Leading industry in this sector";
        nameRow.appendChild(fire);
      }
      const detail = document.createElement("div");
      detail.className = "topPlayDetail";
      const mm = momHuman(pin.momentum_score);
      const bb = breadthHuman(pin.breadth_score);
      const rr = rsHuman(pin.relative_strength_score);
      detail.appendChild(
        document.createTextNode(`Mom: ${mm} · Breadth: ${bb} · RS: ${rr} → `)
      );
      const vb = document.createElement("span");
      vb.className = `verdictTag verdict-${String(pin.classification || "WATCH").toLowerCase()}`;
      vb.textContent = verdictHuman(pin.classification);
      detail.appendChild(vb);
      const indMove = formatIndustryMovement(pin.name, prevInd, top, avoid);
      if (indMove.text && indMove.text !== "—") {
        detail.appendChild(document.createTextNode(" "));
        const mv = document.createElement("span");
        mv.className = `rankMove ${indMove.cls}`;
        mv.textContent = indMove.text;
        detail.appendChild(mv);
      }
      body.appendChild(nameRow);
      body.appendChild(detail);
      row.appendChild(pinRank);
      row.appendChild(body);
      plays.appendChild(row);
    }
    card.appendChild(plays);

    const whyLabel = document.createElement("div");
    whyLabel.className = "sectorSectionLabel";
    whyLabel.textContent = "Why";
    card.appendChild(whyLabel);
    const why = document.createElement("p");
    why.className = "sectorWhyLine";
    why.textContent =
      sv.why_one_liner ||
      (Array.isArray(sv.narrative) && sv.narrative.length ? sv.narrative[0] : "") ||
      "Add narrative sources above for richer context, or use macro + plays as the main signal.";
    card.appendChild(why);

    el.appendChild(card);
  }
}

function renderAvoidIndustryGrid(el, avoidList, prevInd, topIndustries, avoidForPlacement) {
  el.textContent = "";
  if (!avoidList.length) {
    const p = document.createElement("p");
    p.className = "intelEmpty";
    p.textContent = "No industries in the avoid / weak slice.";
    el.appendChild(p);
    return;
  }
  for (let j = 0; j < avoidList.length; j++) {
    const ind = avoidList[j];
    const card = document.createElement("article");
    card.className = "avoidWeakCard";
    const head = document.createElement("div");
    head.className = "avoidWeakCardHead";
    const rank = document.createElement("span");
    rank.className = "avoidWeakRank";
    rank.textContent = `#${j + 1}`;
    const title = document.createElement("div");
    title.className = "avoidWeakTitle";
    title.textContent = ind.name;
    head.appendChild(rank);
    head.appendChild(title);
    card.appendChild(head);
    const meta = document.createElement("div");
    meta.className = "avoidWeakMeta";
    const move = formatIndustryMovement(ind.name, prevInd, topIndustries, avoidForPlacement);
    meta.appendChild(
      document.createTextNode(
        `${verdictHuman(ind.classification)} · Mom ${momHuman(ind.momentum_score)} · Br ${breadthHuman(ind.breadth_score)} · RS ${rsHuman(ind.relative_strength_score)} · score ${ind.final_score != null ? Number(ind.final_score).toFixed(2) : "—"} · `
      )
    );
    const spanM = document.createElement("span");
    spanM.className = `rankMove ${move.cls}`;
    spanM.textContent = move.text;
    meta.appendChild(spanM);
    meta.appendChild(document.createTextNode(" · "));
    meta.appendChild(renderClassPill(ind.classification));
    card.appendChild(meta);
    el.appendChild(card);
  }
}

function renderIndustryIntelUI(data, prevMap) {
  const macro = data.macro;
  const prevInd = prevMap && prevMap.ind != null ? prevMap.ind : prevMap || {};
  const prevSec = (prevMap && prevMap.sec) || {};
  $("macroIntelCard").hidden = false;
  $("industryIntelInsight").hidden = false;

  const regimeChip =
    macro.regime_chip && String(macro.regime_chip).trim()
      ? macro.regime_chip
      : (macro.regime || "").replace(/_/g, " ");
  $("macroRegimePill").textContent = regimeChip;
  $("macroHumanHeadline").textContent =
    macro.human_headline ||
    "Macro backdrop — see narrative below for how to position.";
  $("macroGlLine").textContent =
    macro.growth_liquidity_note || "Adjust macro inputs for growth, yields, and liquidity.";
  const sectorLine = macro.sector_bias_line || "";
  const sectorBlock = $("macroSectorBiasBlock");
  const biasLineEl = $("macroSectorBiasLine");
  if (biasLineEl) biasLineEl.textContent = sectorLine;
  if (sectorBlock) sectorBlock.hidden = !sectorLine;
  $("macroLabelText").textContent = macro.label;
  $("industryIntelInsight").textContent = data.insight;

  const top = data.top_industries || [];
  const avoid = data.avoid_list || [];
  const sectors = data.top_sectors || [];

  const sectorTopListEl = $("sectorTopList");
  if (sectorTopListEl) renderSectorTopList(sectorTopListEl, sectors, prevSec, prevInd, top, avoid);

  const avoidGrid = $("avoidIndustryGrid");
  if (avoidGrid) renderAvoidIndustryGrid(avoidGrid, avoid, prevInd, top, avoid);
}

let industryIntelBusy = false;

async function waitIndustryIntelIdle(maxMs = 180000) {
  const t0 = Date.now();
  while (industryIntelBusy && Date.now() - t0 < maxMs) {
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function loadIndustryIntelligence() {
  if (industryIntelBusy) return;
  industryIntelBusy = true;
  const status = $("industryIntelStatus");
  const prevMap = readIndustrySnapshot();
  syncNarrativeFromInput();
  showStatus(status, "Loading sector intelligence (Trendlyne + narrative merge)…", null);
  try {
    const macro = macroControlsToQuery();
    const data = await fetchIndustryIntelligenceJson(macro);
    renderIndustryIntelUI(data, prevMap);
    writeIndustrySnapshot(data);
    const hint = prevMap
      ? "Updated. Movement compares to your previous run this session."
      : "Baseline saved. Change macro inputs again to see rank movement.";
    showStatus(status, hint, null);
  } catch (e) {
    showStatus(status, e.message || String(e), "error");
    $("macroIntelCard").hidden = true;
    $("industryIntelInsight").hidden = true;
  } finally {
    industryIntelBusy = false;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  $("submitStocks").addEventListener("click", submitStocks);
  $("loadCsvFile").addEventListener("click", loadCsvFromFile);
  $("loadIndustryIntel").addEventListener("click", loadIndustryIntelligence);
  $("clearIndustryBaseline").addEventListener("click", () => {
    clearIndustrySnapshot();
    loadIndustryIntelligence();
  });
  const macroIds = ["macroRates", "macroInflation", "macroYields", "macroGrowth"];
  for (const id of macroIds) {
    $(id).addEventListener("change", () => {
      if (suppressMacroSelectEvents) return;
      if (isMacroAutoSource()) {
        $("macroSourceManual").checked = true;
        $("macroConfidenceRow").hidden = true;
        $("macroConfidenceRow").textContent = "";
      }
      loadIndustryIntelligence();
    });
  }

  $("macroSourceAuto").addEventListener("change", () => {
    if ($("macroSourceAuto").checked) {
      applyAutoMacroFromTavily()
        .catch(() => undefined)
        .then(() => waitIndustryIntelIdle())
        .then(() => loadIndustryIntelligence());
    }
  });

  $("macroSourceManual").addEventListener("change", () => {
    if ($("macroSourceManual").checked) {
      $("macroConfidenceRow").hidden = true;
      $("macroConfidenceRow").textContent = "";
      loadIndustryIntelligence();
    }
  });

  $("fetchMacroFromTavily").addEventListener("click", () => {
    $("macroSourceAuto").checked = true;
    applyAutoMacroFromTavily()
      .catch(() => undefined)
      .then(() => waitIndustryIntelIdle())
      .then(() => loadIndustryIntelligence());
  });

  prepopulateDefaultNarrativeSources();
  restoreTavilyMacroUi();
  syncNarrativeFromInput();
  const tavilyDomainsEl = $("tavilyMacroDomainsInput");
  const tavilyHintEl = $("tavilyMacroDomainHint");
  if (tavilyDomainsEl) tavilyDomainsEl.addEventListener("input", syncTavilyMacroFromInput);
  if (tavilyHintEl) tavilyHintEl.addEventListener("input", syncTavilyMacroFromInput);
  if ($("macroSourceAuto").checked) {
    applyAutoMacroFromTavily()
      .catch(() => undefined)
      .then(() => waitIndustryIntelIdle())
      .then(() => loadIndustryIntelligence());
  } else {
    loadIndustryIntelligence();
  }
});


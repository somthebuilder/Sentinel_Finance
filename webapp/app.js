function $(id) {
  return document.getElementById(id);
}

let hasSubmittedStocks = false;
let activeNarrativeSources = [];

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

function renderThemes(themes) {
  const list = $("trendsList");
  list.innerHTML = "";

  if (!themes || !themes.length) {
    const msg = document.createElement("div");
    msg.className = "subtle";
    msg.textContent = "No themes yet (Tavily drivers may be empty).";
    list.appendChild(msg);
    return;
  }

  for (const t of themes.slice(0, 10)) {
    const card = document.createElement("div");
    card.className = "card";

    const topRow = document.createElement("div");
    topRow.className = "cardTitleRow";

    const title = document.createElement("div");
    title.className = "themeTitle";
    title.textContent = t.theme ?? "Theme";
    topRow.appendChild(title);

    const chips = document.createElement("div");
    chips.className = "chips";
    const kws = Array.isArray(t.keywords) ? t.keywords.slice(0, 6) : [];
    for (const kw of kws) {
      const chip = document.createElement("div");
      chip.className = "chip";
      chip.textContent = kw;
      chips.appendChild(chip);
    }

    card.appendChild(topRow);
    card.appendChild(chips);

    const driver = Array.isArray(t.drivers) && t.drivers.length ? t.drivers[0] : "";
    if (driver) {
      const snippet = document.createElement("div");
      snippet.className = "driverSnippet";
      snippet.textContent = driver;
      card.appendChild(snippet);
    }

    if (t.rationale) {
      const rationale = document.createElement("div");
      rationale.className = "driverSnippet";
      rationale.textContent = `Rationale: ${t.rationale}`;
      card.appendChild(rationale);
    }

    list.appendChild(card);
  }
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

  const fmt01 = (x) => {
    const n = Number(x);
    if (!Number.isFinite(n)) return "0.0%";
    return `${(n * 100).toFixed(1)}%`;
  };

  for (const t of themesRanked) {
    const themeLabel = t.theme ?? "Theme";
    const topStocks = Array.isArray(t.topStocks) ? t.topStocks : [];
    if (!topStocks.length) continue;

    const card = document.createElement("div");
    card.className = "card";

    const topRow = document.createElement("div");
    topRow.className = "cardTitleRow";

    const title = document.createElement("div");
    title.className = "themeTitle";
    title.textContent = themeLabel;
    topRow.appendChild(title);

    const count = document.createElement("div");
    count.className = "subtle";
    count.textContent = `Top ${topStocks.length}`;
    topRow.appendChild(count);

    card.appendChild(topRow);

    const stockList = document.createElement("div");
    stockList.className = "stockList";

    for (const s of topStocks) {
      const row = document.createElement("div");
      row.className = "stockRow";

      const stockTop = document.createElement("div");
      stockTop.className = "stockTopLine";

      const name = document.createElement("div");
      name.className = "stockName";
      name.textContent = s.name ?? "Stock";
      stockTop.appendChild(name);

      const scoreChip = document.createElement("div");
      scoreChip.className = "scoreChip";
      const scoreStr = typeof s.score === "number" ? s.score.toFixed(3) : String(s.score ?? "");
      scoreChip.textContent = `Score ${scoreStr}`;
      stockTop.appendChild(scoreChip);

      if (s.tier) {
        const tierChip = document.createElement("div");
        tierChip.className = "tierChip";
        tierChip.textContent = s.tier;
        stockTop.appendChild(tierChip);
      }

      row.appendChild(stockTop);

      const breakdown = s.scoreBreakdown ?? {};
      const themeRel = Number(breakdown.themeRelevance ?? 0);
      const scorePct = Math.max(0, Math.min(1, Number(s.score ?? 0)));

      const barLabel = document.createElement("div");
      barLabel.className = "scoreBarLabelRow";
      barLabel.innerHTML = `<span>Theme match</span><span>${fmt01(themeRel)}</span>`;
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
      const bdItems = [
        ["Theme relevance", fmt01(breakdown.themeRelevance ?? 0)],
        ["Growth factor", fmt01(breakdown.growthFactor ?? 0)],
        ["Momentum factor", fmt01(breakdown.momentumFactor ?? 0)],
        ["Durability factor", fmt01(breakdown.durabilityFactor ?? 0)],
        ["Valuation factor", fmt01(breakdown.valuationFactor ?? 0)],
        ["Participation factor", fmt01(breakdown.participationFactor ?? 0)],
        ["Revenue growth", fmt01(breakdown.revenueGrowthScore ?? 0)],
        ["EPS growth", fmt01(breakdown.epsGrowthScore ?? 0)],
        ["Debt score", fmt01(breakdown.debtScore ?? 0)],
        ["Piotroski", fmt01(breakdown.piotroskiScore ?? 0)],
        ["Momentum score", fmt01(breakdown.momentumScore ?? 0)],
        ["Institutional", fmt01(breakdown.institutionalScore ?? 0)],
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

      stockList.appendChild(row);
    }

    card.appendChild(stockList);
    list.appendChild(card);
  }
}

async function fetchJson(path) {
  const endpoint = new URL(path, window.location.origin);
  if (activeNarrativeSources.length) {
    endpoint.searchParams.set("sources", activeNarrativeSources.join(","));
  }
  const res = await fetch(endpoint.toString(), { method: "GET" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Request failed (${res.status}). ${text}`.trim());
  }
  return res.json();
}

function parseNarrativeSourcesInput(raw) {
  const parts = (raw ?? "")
    .split(/[,\n]/g)
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  const seen = new Set();
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
    const d = toDomain(p);
    if (!d || seen.has(d)) continue;
    seen.add(d);
    out.push(d);
    if (out.length >= 7) break;
  }
  return out;
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

async function loadThemes() {
  const status = $("trendsStatus");
  showStatus(status, "Loading themes...", null);
  try {
    const data = await fetchJson("/trends");
    const themes = data.themes ?? data.trends ?? data.items ?? [];
    renderThemes(themes);
    status.textContent = "";
  } catch (e) {
    showStatus(status, `Failed to load themes: ${e.message || e}`, "error");
  }
}

async function loadRecommendations() {
  const status = $("recsStatus");
  showStatus(status, "Loading recommendations...", null);
  try {
    const data = await fetchJson("/recommendations");
    const themesRanked = data.themes ?? data.recommendations ?? data.items ?? [];
    if (!themesRanked.length && !hasSubmittedStocks) {
      showStatus(status, "Paste stock data to generate recommendations.", null);
      renderRecommendations([]);
      return;
    }
    if (themesRanked.length) hasSubmittedStocks = true;
    renderRecommendations(themesRanked);
    status.textContent = "";
  } catch (e) {
    showStatus(status, `Failed to load recommendations: ${e.message || e}`, "error");
  }
}

async function runCombinedAnalysis() {
  const status = $("trendsStatus");
  const input = $("narrativeSourcesInput");
  const parsed = parseNarrativeSourcesInput(input ? input.value : "");
  activeNarrativeSources = parsed;
  showStatus(
    status,
    parsed.length
      ? `Running analysis with ${parsed.length} custom narrative source(s)...`
      : "Running analysis with default narrative sources...",
    null
  );
  await loadThemes();
  await loadRecommendations();
}

async function submitStocks() {
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
    payload = { stocks };
  } else {
    // For CSV/TSV uploads and Excel pastes, let backend parser handle quotes/large files.
    payload = { csv: raw };
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
    showStatus(status, `Stocks saved (${accepted} accepted, ${rejected} rejected). Refreshing recommendations...`, null);
    await loadThemes();
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
    $("stocksInput").value = text;
    showStatus(status, `Loaded ${file.name}. Click Submit to recompute recommendations.`, null);
  } catch (e) {
    showStatus(status, `Failed to read file: ${e.message || e}`, "error");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  $("submitStocks").addEventListener("click", submitStocks);
  $("loadCsvFile").addEventListener("click", loadCsvFromFile);
  $("runCombinedAnalysis").addEventListener("click", runCombinedAnalysis);
  loadThemes();
  loadRecommendations();
});


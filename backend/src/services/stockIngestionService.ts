import { Stock } from "../models/stock";
import { buildCanonicalHeaderIndex } from "./metricGlossary";

export type StockInput = {
  name?: string;
  symbol?: string;
  exchange?: "NSE" | "BSE" | string;
  sector?: string;
  subSector?: string;
  tags?: string[] | string;
  revenueGrowth?: number | string;
  previousRevenueGrowth?: number | string;
  peRatio?: number | string;
  institutionalOwnership?: number | string;
  momentumScore?: number | string;
};

export type CsvParseDiagnostics = {
  delimiter: "," | ";" | "\t";
  headerRowIndex: number;
  headerColumns: string[];
  canonicalMap: Record<string, string>;
  unmatchedHeaders: string[];
  totalDataRows: number;
  acceptedRows: number;
  skippedRows: number;
  skippedReasons: Record<string, number>;
};

function normalizeSector(value: string | undefined) {
  return (value ?? "")
    .toString()
    .trim()
    .replace(/\s+/g, " ");
}

function toNumber(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeExchange(value: string | undefined): "NSE" | "BSE" {
  const ex = (value ?? "").toString().trim().toUpperCase();
  if (ex === "NSE" || ex === "BSE") return ex;
  return "NSE";
}

function normalizeTags(value: StockInput["tags"], sector: string, subSector?: string): string[] {
  if (Array.isArray(value)) {
    const cleaned = value.map((t) => t.toString().trim().toLowerCase()).filter(Boolean);
    if (cleaned.length) return cleaned;
  }
  if (typeof value === "string") {
    const cleaned = value.split(/[;,]/g).map((t) => t.trim().toLowerCase()).filter(Boolean);
    if (cleaned.length) return cleaned;
  }
  return [sector, subSector ?? ""].map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export function parseStockInput(row: StockInput): Stock {
  const sector = normalizeSector(row.sector) || "Unknown";
  const subSector = normalizeSector(row.subSector);
  const stock: Stock = {
    name: (row.name ?? "").toString().trim(),
    symbol: row.symbol ? row.symbol.toString().trim().toUpperCase() : undefined,
    exchange: normalizeExchange(row.exchange),
    sector,
    subSector: subSector || undefined,
    tags: normalizeTags(row.tags, sector, subSector || undefined),
    revenueGrowth: toNumber(row.revenueGrowth),
    previousRevenueGrowth: toNumber(row.previousRevenueGrowth),
    peRatio: toNumber(row.peRatio),
    institutionalOwnership: toNumber(row.institutionalOwnership),
    momentumScore: toNumber(row.momentumScore),
  };
  return stock;
}

export function validateStock(stock: Stock): void {
  if (!stock.name || !stock.sector) {
    throw new Error("Invalid stock data: name and sector are required");
  }
  if (!["NSE", "BSE"].includes(stock.exchange)) {
    throw new Error("Non-Indian stock not allowed");
  }
}

export function parseCsvToStockInputs(csv: string): StockInput[] {
  return parseCsvToStockInputsWithDiagnostics(csv).rows;
}

export function parseCsvToStockInputsWithDiagnostics(csv: string): {
  rows: StockInput[];
  diagnostics: CsvParseDiagnostics;
} {
  const lines = csv
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) {
    return {
      rows: [],
      diagnostics: {
        delimiter: ",",
        headerRowIndex: 0,
        headerColumns: [],
        canonicalMap: {},
        unmatchedHeaders: [],
        totalDataRows: 0,
        acceptedRows: 0,
        skippedRows: 0,
        skippedReasons: { notEnoughLines: 1 },
      },
    };
  }

  const pickDelimiter = (line: string) => {
    const tabs = (line.match(/\t/g) ?? []).length;
    const commas = (line.match(/,/g) ?? []).length;
    const semis = (line.match(/;/g) ?? []).length;
    if (tabs >= 2) return "\t";
    if (commas >= 2) return ",";
    if (semis >= 2) return ";";
    return ",";
  };

  const delimiter = pickDelimiter(lines[0]) as "," | ";" | "\t";
  const splitQuoted = (line: string, delim: string): string[] => {
    if (delim === "\t") return line.split("\t").map((c) => c.trim());
    const out: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === "\"") {
        if (inQuotes && line[i + 1] === "\"") {
          cur += "\"";
          i += 1;
        } else {
          inQuotes = !inQuotes;
        }
        continue;
      }
      if (ch === delim && !inQuotes) {
        out.push(cur.trim());
        cur = "";
      } else {
        cur += ch;
      }
    }
    out.push(cur.trim());
    return out;
  };

  let headerLineIdx = 0;
  const scanLimit = Math.min(lines.length, 8);
  for (let i = 0; i < scanLimit; i++) {
    const probe = splitQuoted(lines[i], delimiter);
    const probeIdx = buildCanonicalHeaderIndex(probe);
    if (probeIdx.name !== undefined) {
      headerLineIdx = i;
      break;
    }
  }

  const header = splitQuoted(lines[headerLineIdx], delimiter);
  const idx = buildCanonicalHeaderIndex(header);
  const canonicalMap: Record<string, string> = {};
  for (const [canonical, colIndex] of Object.entries(idx)) {
    if (colIndex !== undefined && header[colIndex] !== undefined) {
      canonicalMap[canonical] = header[colIndex];
    }
  }
  const matchedHeaderIndexes = new Set<number>(Object.values(idx));
  const unmatchedHeaders = header.filter((_h, i) => !matchedHeaderIndexes.has(i));

  const out: StockInput[] = [];
  const skippedReasons: Record<string, number> = {};
  const bumpSkip = (reason: string) => {
    skippedReasons[reason] = (skippedReasons[reason] ?? 0) + 1;
  };
  for (const line of lines.slice(headerLineIdx + 1)) {
    const cols = splitQuoted(line, delimiter);
    const get = (k: string) => (idx[k] === undefined ? undefined : cols[idx[k]]);
    const rawName = (get("name") ?? cols[0] ?? "").toString().trim();
    if (!rawName) {
      bumpSkip("missingName");
      continue;
    }
    if (/^\d+$/.test(rawName)) {
      bumpSkip("rankOnlyRow");
      continue;
    }
    const sector = (get("sector") ?? get("subSector") ?? "Unknown").toString().trim() || "Unknown";
    const subSector = (get("subSector") ?? get("sector") ?? "").toString().trim();
    const revenueProxy = get("revenueGrowth") ?? get("netProfitYoYGrowth") ?? get("roe");
    const piotroskiRaw = get("piotroski");
    const piotroskiNum = piotroskiRaw === undefined ? NaN : Number((piotroskiRaw as string).toString().replace(/,/g, "").trim());
    const institutionalRaw = get("institutionalOwnership");
    const institutionalFromPiotroski =
      idx["institutionalOwnership"] !== undefined &&
      idx["piotroski"] !== undefined &&
      idx["institutionalOwnership"] === idx["piotroski"];
    const instProxy =
      (institutionalFromPiotroski && Number.isFinite(piotroskiNum) && piotroskiNum > 0
        ? (piotroskiNum / 9).toFixed(6)
        : institutionalRaw) ??
      (Number.isFinite(piotroskiNum) && piotroskiNum > 0 ? (piotroskiNum / 9).toFixed(6) : undefined);
    const momentumProxy = get("momentumScore") ?? get("revenueGrowth") ?? get("netProfitYoYGrowth");

    out.push({
      name: rawName,
      symbol: get("symbol"),
      exchange: (get("exchange") as string | undefined) ?? "NSE",
      sector,
      subSector: subSector || undefined,
      tags: get("tags"),
      revenueGrowth: revenueProxy,
      previousRevenueGrowth: get("previousRevenueGrowth"),
      peRatio: get("peRatio"),
      institutionalOwnership: instProxy,
      momentumScore: momentumProxy,
    } satisfies StockInput);
  }
  const totalDataRows = Math.max(0, lines.length - (headerLineIdx + 1));
  const diagnostics: CsvParseDiagnostics = {
    delimiter,
    headerRowIndex: headerLineIdx,
    headerColumns: header,
    canonicalMap,
    unmatchedHeaders,
    totalDataRows,
    acceptedRows: out.length,
    skippedRows: Math.max(0, totalDataRows - out.length),
    skippedReasons,
  };
  return { rows: out, diagnostics };
}


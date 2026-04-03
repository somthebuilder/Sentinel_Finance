import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";

import { rankStocksByTheme } from "./services/scoringService";
import { addStocks, getStocks } from "./store/stockStore";
import { getDynamicMacroThemes, macroThemesToThemeModels } from "./services/macroThemeService";
import { getBaseThemes } from "./services/themeService";
import {
  CsvParseDiagnostics,
  StockInput,
  parseCsvToStockInputs,
  parseCsvToStockInputsWithDiagnostics,
  parseStockInput,
  validateStock,
} from "./services/stockIngestionService";
import { enrichTagsIfNeeded } from "./services/aiEnrichmentService";

dotenv.config();

const app = express();
// Serve static UI assets (logo, etc.) for the local web app.
const assetsDir = path.resolve(__dirname, "..", "..", "webapp", "assets");
if (fs.existsSync(assetsDir)) {
  app.use("/assets", express.static(assetsDir));
}
app.use(cors({ origin: true }));
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT ?? 3000);

const webAppDir = path.resolve(__dirname, "..", "..", "webapp");
const indexHtmlPath = path.join(webAppDir, "index.html");
const hasWebApp = fs.existsSync(indexHtmlPath);
if (hasWebApp) {
  app.use(express.static(webAppDir));
}

const tagsSchema = z.preprocess((v) => {
  if (typeof v === "string") {
    // Accept "a,b,c" or "a;b;c" from loosely formatted inputs.
    const parts = v.split(/[;,]/g).map((s) => s.trim()).filter(Boolean);
    return parts;
  }
  return v;
}, z.array(z.string().min(1)).min(1));

const toLooseNumber = z.preprocess((v) => {
  if (v === undefined || v === null || v === "") return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const s = String(v).replace(/,/g, "").replace(/%/g, "").trim();
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}, z.number());

const stockSchema = z.object({
  name: z.string().min(1),
  symbol: z.string().optional(),
  exchange: z.preprocess((v) => {
    const ex = String(v ?? "NSE").trim().toUpperCase();
    return ex === "BSE" ? "BSE" : "NSE";
  }, z.enum(["NSE", "BSE"])),
  sector: z.preprocess((v) => String(v ?? "Unknown"), z.string().min(1)),
  subSector: z.preprocess((v) => (v === undefined || v === null ? undefined : String(v)), z.string().optional()),
  tags: z.preprocess((v) => {
    if (Array.isArray(v) && v.length > 0) return v;
    if (typeof v === "string" && v.trim()) return v;
    return ["emerging"];
  }, tagsSchema),
  revenueGrowth: toLooseNumber,
  previousRevenueGrowth: toLooseNumber.optional().default(0),
  peRatio: toLooseNumber,
  institutionalOwnership: toLooseNumber,
  momentumScore: toLooseNumber,
  netProfitYoYGrowth: toLooseNumber.optional().default(0),
  ltDebtToEquity: toLooseNumber.optional().default(0),
  piotroski: toLooseNumber.optional().default(0),
  distanceFromHigh: toLooseNumber.optional().default(0),
  revenueGrowthQoQ: toLooseNumber.optional().default(0),
  epsGrowth: toLooseNumber.optional().default(0),
  roe: toLooseNumber.optional().default(0),
  roce: toLooseNumber.optional().default(0),
  altmanZ: toLooseNumber.optional().default(0),
  debtToEquity: toLooseNumber.optional().default(0),
  peg: toLooseNumber.optional().default(0),
  pbv: toLooseNumber.optional().default(0),
  industryPbv: toLooseNumber.optional().default(0),
  institutionalActivity: toLooseNumber.optional().default(0),
  promoterHolding: toLooseNumber.optional().default(0),
});

function asyncHandler(fn: express.RequestHandler) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function parseNarrativeSources(input: unknown): string[] {
  if (typeof input !== "string") return [];
  const items = input
    .split(/[,\n]/g)
    .map((s) => s.trim())
    .filter(Boolean);
  return items.slice(0, 7);
}

app.get("/", (_req, res) => {
  if (hasWebApp) return res.sendFile(indexHtmlPath);
  return res.json({ ok: true, service: "Personal Finance MVP API" });
});

app.get(
  "/health",
  (_req, res) => {
    res.json({ ok: true });
  }
);

app.get(
  "/trends",
  asyncHandler(async (req, res) => {
    // Dynamic macro themes (controlled vocabulary mapping).
    const domains = parseNarrativeSources(req.query.sources);
    const macroThemes = await getDynamicMacroThemes(domains);
    const dynamicThemes = macroThemesToThemeModels(macroThemes);
    const themes = dynamicThemes.length ? dynamicThemes : getBaseThemes();
    res.json({ themes });
  })
);

app.get(
  "/themes",
  asyncHandler(async (req, res) => {
    const domains = parseNarrativeSources(req.query.sources);
    const macroThemes = await getDynamicMacroThemes(domains);
    const dynamicThemes = macroThemesToThemeModels(macroThemes);
    const themes = dynamicThemes.length ? dynamicThemes : getBaseThemes();
    res.json({ themes });
  })
);

app.get(
  "/recommendations",
  asyncHandler(async (req, res) => {
    const stocks = getStocks();
    const domains = parseNarrativeSources(req.query.sources);
    const macroThemes = await getDynamicMacroThemes(domains);
    const dynamicThemes = macroThemesToThemeModels(macroThemes);
    const themes = dynamicThemes.length ? dynamicThemes : getBaseThemes();

    let themesRanked = await rankStocksByTheme(themes, stocks);
    if (!themesRanked.length) {
      // Safety fallback: if dynamic mapping is too sparse for current stock universe,
      // use base themes so UI never returns a blank recommendation payload.
      themesRanked = await rankStocksByTheme(getBaseThemes(), stocks);
    }
    res.json({ themes: themesRanked });
  })
);

app.post(
  "/stocks",
  asyncHandler(async (req, res) => {
    let stockInputs: StockInput[] = [];
    let parseDiagnostics: CsvParseDiagnostics | null = null;
    const body = req.body as any;

    if (Array.isArray(body)) {
      stockInputs = body as StockInput[];
    } else if (body && typeof body === "object") {
      if (Array.isArray(body.stocks)) {
        stockInputs = body.stocks as StockInput[];
      } else if (typeof body.csv === "string") {
        const parsedCsv = parseCsvToStockInputsWithDiagnostics(body.csv);
        stockInputs = parsedCsv.rows;
        parseDiagnostics = parsedCsv.diagnostics;
      } else if (typeof body.text === "string") {
        stockInputs = parseCsvToStockInputs(body.text);
      } else if (typeof body.data === "string") {
        stockInputs = parseCsvToStockInputs(body.data);
      }
    } else if (typeof body === "string") {
      stockInputs = parseCsvToStockInputs(body);
    }

    if (!stockInputs.length) {
      return res.status(400).json({
        ok: false,
        error: "ValidationError",
        message: "No stock rows found in payload",
        parseDiagnostics,
      });
    }

    const normalized = [];
    const rejected: Array<{ index: number; reason: string }> = [];
    for (let i = 0; i < stockInputs.length; i++) {
      const input = stockInputs[i];
      try {
        const loose = stockSchema.parse(input ?? {});
        const stock = parseStockInput(loose);
        validateStock(stock);
        stock.tags = await enrichTagsIfNeeded(stock);
        normalized.push(stock);
      } catch (err: any) {
        const reason = err?.issues?.[0]?.message || err?.message || "Invalid row";
        rejected.push({ index: i, reason });
      }
    }

    if (!normalized.length) {
      return res.status(400).json({
        ok: false,
        error: "ValidationError",
        message: "No valid stock rows found",
        rejected: rejected.slice(0, 20),
        parseDiagnostics,
      });
    }

    addStocks(normalized);

    res.json({
      ok: true,
      received: normalized.length,
      totalStocks: getStocks().length,
      rejected: rejected.length,
      rejectedSample: rejected.slice(0, 10),
      parseDiagnostics,
    });
  })
);

// For SPA-like routing (optional). Only used if the webapp is present.
if (hasWebApp) {
  app.use((_req, res) => {
    res.sendFile(indexHtmlPath);
  });
}

// Zod errors -> 400.
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err && err.name === "ZodError") {
    const issue = err.issues?.[0];
    const path = Array.isArray(issue?.path) ? issue.path.join(".") : "";
    const msg = issue?.message ?? "Invalid request body";
    const detail = path ? `${path}: ${msg}` : msg;
    res.status(400).json({
      ok: false,
      error: "ValidationError",
      message: detail,
      issues: Array.isArray(err.issues)
        ? err.issues.slice(0, 8).map((i: any) => ({
            path: Array.isArray(i?.path) ? i.path.join(".") : "",
            message: i?.message ?? "Invalid input",
          }))
        : [],
    });
    return;
  }

  console.error(err);
  res.status(500).json({
    ok: false,
    error: "InternalServerError",
    message: err?.message ?? "Unexpected error",
  });
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`API listening on http://localhost:${PORT}`);
});


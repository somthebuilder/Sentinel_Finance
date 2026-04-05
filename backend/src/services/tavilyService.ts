import { Theme } from "../models/theme";
import { fetchTavilyResearchNarrative, type NarrativeResult } from "./tavilyResearch";

export type TavilyStructuredData = {
  summary: string;
  drivers: string[];
  sectors: string[];
  keywords: string[];
};

const ALLOWED_DOMAINS = [
  "moneycontrol.com",
  "economictimes.indiatimes.com",
  "screener.in",
];

function getEnv(name: string): string | undefined;
function getEnv(name: string, fallback: string): string;
function getEnv(name: string, fallback?: string) {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return v;
}

function getHostname(input: unknown): string | undefined {
  const raw = (input ?? "").toString().trim();
  if (!raw) return undefined;

  const candidate = raw.startsWith("http://") || raw.startsWith("https://") ? raw : `https://${raw}`;

  try {
    return new URL(candidate).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function isAllowedSourceRow(r: NarrativeResult): boolean {
  const host = getHostname(r.url);
  if (!host) return false;
  return ALLOWED_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

function sanitizeText(s: unknown, maxLen: number) {
  const str = (s ?? "").toString().replace(/\s+/g, " ").trim();
  return str.length > maxLen ? `${str.slice(0, maxLen - 1)}…` : str;
}

function extractDriversFromNarrative(results: NarrativeResult[], limit: number): string[] {
  const drivers: string[] = [];
  const synthesis = results.find((r) => (r.title ?? "").includes("Tavily research") && (r.content ?? "").trim());
  if (synthesis?.content) {
    const chunks = synthesis.content
      .split(/(?<=[.!?])\s+/)
      .map((s) => sanitizeText(s, 200))
      .filter((s) => s.length > 35);
    for (const c of chunks) {
      drivers.push(c);
      if (drivers.length >= limit) return drivers;
    }
  }
  for (const r of results) {
    if (!isAllowedSourceRow(r)) continue;
    const title = sanitizeText(r.title, 160);
    if (title) drivers.push(title);
    if (drivers.length >= limit) break;
  }
  return drivers.slice(0, limit);
}

export async function enrichThemeDriversWithTavily(theme: Theme): Promise<TavilyStructuredData> {
  const apiKey = getEnv("TRAVILY_API_KEY") ?? getEnv("TAVILY_API_KEY");
  if (!apiKey) {
    return { summary: "", drivers: [], sectors: theme.sectors, keywords: theme.keywords };
  }

  try {
    const query = `${theme.theme} India sector drivers outlook ${theme.keywords.slice(0, 8).join(" ")}`;
    const results = await fetchTavilyResearchNarrative(query);
    const synthesis = results.find((r) => (r.title ?? "").includes("Tavily research"));
    const summary = sanitizeText(synthesis?.content ?? "", 320);
    const firstAllowed = results.find((r) => isAllowedSourceRow(r) && (r.title ?? "").trim());
    const summaryFallback = sanitizeText(firstAllowed?.title ?? "", 280);
    const drivers = extractDriversFromNarrative(results, 5);
    return {
      summary: summary || summaryFallback,
      drivers: drivers.length ? drivers : (summary ? [sanitizeText(summary, 200)] : []),
      sectors: theme.sectors,
      keywords: theme.keywords,
    };
  } catch {
    return { summary: "", drivers: [], sectors: theme.sectors, keywords: theme.keywords };
  }
}

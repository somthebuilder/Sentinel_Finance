import { tavily, type TavilyResearchResponse } from "@tavily/core";

export type NarrativeResult = {
  title?: string;
  content?: string;
  url?: string;
  score?: number;
};

/** Optional steering for Tavily Research (same four calls as search `include_domains`). */
export type TavilyResearchCallOptions = {
  includeDomains?: string[];
};

function getNarrativeEnv(primary: string, fallback?: string): string | undefined {
  const v = process.env[primary];
  if (v !== undefined && v !== "") return v;
  if (primary.startsWith("TRAVILY_")) {
    const alt = process.env[primary.replace(/^TRAVILY_/, "TAVILY_")];
    if (alt !== undefined && alt !== "") return alt;
  }
  if (primary.startsWith("TAVILY_")) {
    const alt = process.env[primary.replace(/^TAVILY_/, "TRAVILY_")];
    if (alt !== undefined && alt !== "") return alt;
  }
  return fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err ?? "");
}

/** Tavily / API plan limits — treat as non-fatal; use empty results + fallbacks. */
function isTavilyQuotaOrUsageError(err: unknown): boolean {
  const m = errorMessage(err).toLowerCase();
  return (
    m.includes("usage limit") ||
    m.includes("exceeds your plan") ||
    m.includes("plan's set usage") ||
    m.includes("quota") ||
    m.includes("rate limit") ||
    m.includes("too many requests") ||
    m.includes("excessive requests") ||
    m.includes("blocked due to") ||
    m.includes("verify you are using production") ||
    /\b429\b/.test(m)
  );
}

/** After a quota error, skip new research calls for a while to avoid log/API spam. */
let tavilyQuotaBackoffUntilMs = 0;

/**
 * Runs a Tavily Research task and maps the report + cited sources into narrative snippets
 * for the macro theme pipeline (replaces one-off /search calls).
 */
export async function fetchTavilyResearchNarrative(
  query: string,
  opts?: TavilyResearchCallOptions
): Promise<NarrativeResult[]> {
  const apiKey = getNarrativeEnv("TRAVILY_API_KEY") ?? getNarrativeEnv("TAVILY_API_KEY");
  if (!apiKey) return [];
  if (getNarrativeEnv("TAVILY_DISABLE") === "1") return [];

  const now = Date.now();
  if (now < tavilyQuotaBackoffUntilMs) {
    return [];
  }

  const maxWaitMs = Number(getNarrativeEnv("TAVILY_RESEARCH_MAX_WAIT_MS", "120000"));
  const pollMs = Number(getNarrativeEnv("TAVILY_RESEARCH_POLL_MS", "2500"));
  const researchTimeout = Number(getNarrativeEnv("TAVILY_RESEARCH_START_TIMEOUT_S", "120"));
  const includeDomains =
    opts?.includeDomains?.length ? opts.includeDomains.map((d) => d.trim()).filter(Boolean).slice(0, 16) : undefined;

  try {
    const client = tavily({ apiKey });
    const started = await client.research(query, {
      model: "mini",
      timeout: researchTimeout,
      stream: false,
      ...(includeDomains?.length ? { includeDomains } : {}),
    });
    if (started && typeof (started as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function") {
      console.warn("Tavily research streaming mode is not supported in this integration");
      return [];
    }
    const requestId = (started as TavilyResearchResponse).requestId;
    const deadline = Date.now() + maxWaitMs;

    while (Date.now() < deadline) {
      const data = await client.getResearch(requestId);
      const st = String((data as { status?: string }).status ?? "").toLowerCase();

      if (st === "failed" || st === "error") {
        console.warn("Tavily research task failed:", requestId, st);
        return [];
      }

      if (st === "completed" || st === "complete") {
        const full = data as {
          content?: string | Record<string, unknown>;
          sources?: Array<{ title: string; url: string }>;
        };
        const text =
          typeof full.content === "string"
            ? full.content
            : JSON.stringify(full.content ?? "");
        const out: NarrativeResult[] = [];
        if (text.trim()) {
          out.push({
            title: "Tavily research synthesis",
            content: text.slice(0, 14_000),
            url: "https://tavily.com",
            score: 1,
          });
        }
        const sources = Array.isArray(full.sources) ? full.sources : [];
        for (const s of sources.slice(0, 16)) {
          out.push({
            title: s.title,
            content: "",
            url: s.url,
            score: 0.75,
          });
        }
        return out;
      }

      await sleep(pollMs);
    }

    console.warn("Tavily research timed out:", requestId);
    return [];
  } catch (err) {
    if (isTavilyQuotaOrUsageError(err)) {
      const backoffMs = Number(getNarrativeEnv("TAVILY_QUOTA_BACKOFF_MS", "600000"));
      tavilyQuotaBackoffUntilMs = Date.now() + Math.max(60_000, backoffMs);
      console.warn(
        `[Tavily] Usage or plan limit — skipping research for ~${Math.round(backoffMs / 60_000)} min. ` +
          "Macro/themes use offline fallbacks (Trendlyne, base themes). Upgrade plan or wait for quota reset."
      );
      return [];
    }
    console.warn("[Tavily] Research failed:", errorMessage(err));
    return [];
  }
}

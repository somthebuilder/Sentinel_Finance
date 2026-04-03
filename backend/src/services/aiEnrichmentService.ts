import { Stock } from "../models/stock";

const tagCache = new Map<string, string[]>();
const GENERIC_TAGS = new Set([
  "high growth",
  "momentum",
  "high delivery",
  "low debt",
  "high debt",
  "emerging",
]);

function getEnv(name: string, fallback?: string) {
  const direct = process.env[name];
  if (direct) return direct;
  // Support user's mentioned variant.
  if (name === "OPENAI_API_KEY") return process.env.openai_API_Key ?? fallback;
  return fallback;
}

function getOpenAIConfig() {
  return {
    apiKey: getEnv("OPENAI_API_KEY"),
    baseUrl: getEnv("OPENAI_BASE_URL", "https://api.openai.com/v1"),
    model: getEnv("OPENAI_MODEL", "gpt-5-nano"),
    timeoutMs: Number(getEnv("OPENAI_TIMEOUT_MS", "12000")),
  };
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function normalizeTags(tags: string[]): string[] {
  return tags.map((t) => t.toLowerCase().trim()).filter(Boolean).slice(0, 8);
}

export function needsTagEnrichment(stock: Stock): boolean {
  const sectorUnknown = !stock.sector || stock.sector.toLowerCase() === "unknown";
  const tags = Array.isArray(stock.tags) ? stock.tags : [];
  const usefulTags = tags.filter((t) => !GENERIC_TAGS.has((t ?? "").toLowerCase().trim()));
  return sectorUnknown || tags.length < 3 || usefulTags.length < 2;
}

export async function enrichTagsIfNeeded(stock: Stock): Promise<string[]> {
  const key = `${stock.name.toLowerCase()}|${stock.sector.toLowerCase()}`;
  if (tagCache.has(key)) return tagCache.get(key)!;
  if (!needsTagEnrichment(stock)) {
    tagCache.set(key, stock.tags);
    return stock.tags;
  }

  const { apiKey, baseUrl, model, timeoutMs } = getOpenAIConfig();
  if (!apiKey) return stock.tags;

  const prompt = [
    "Generate 5-8 business-relevant tags for this Indian company.",
    "Rules:",
    "- lowercase",
    "- no explanations",
    "- comma-separated",
    "- focus on business segments and demand drivers",
    "- prioritize sector/industry terms useful for macro theme matching",
    `Input: name=${stock.name}, sector=${stock.sector}`,
  ].join("\n");

  try {
    const res = await fetchWithTimeout(
      `${baseUrl!.replace(/\/$/, "")}/chat/completions`,
      {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
      }),
      },
      timeoutMs
    );
    if (!res.ok) {
      throw new Error(`OpenAI tag enrichment failed (${res.status})`);
    }
    const json = await res.json().catch(() => null);
    const content: string = json?.choices?.[0]?.message?.content ?? "";
    const tags = normalizeTags(content.split(","));
    const merged = normalizeTags([...stock.tags, ...tags]);
    tagCache.set(key, merged);
    return merged;
  } catch (err) {
    console.warn("OpenAI tag enrichment failed, using deterministic tags:", err);
    return stock.tags;
  }
}

export function shouldPolish(rank: number): boolean {
  return rank <= 3;
}

export async function polishReasonsIfNeeded(reasons: string[], rank: number): Promise<string[]> {
  if (!shouldPolish(rank) || reasons.length === 0) return reasons;

  const { apiKey, baseUrl, model, timeoutMs } = getOpenAIConfig();
  if (!apiKey) return reasons;

  const prompt = [
    "Rewrite these investment reasons into sharp, concise insights.",
    "Rules:",
    "- no fluff",
    "- max 2 lines per reason",
    "- keep factual",
    "Return JSON array of strings only.",
    JSON.stringify(reasons),
  ].join("\n");

  try {
    const res = await fetchWithTimeout(
      `${baseUrl!.replace(/\/$/, "")}/chat/completions`,
      {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] }),
      },
      timeoutMs
    );
    if (!res.ok) {
      throw new Error(`OpenAI reason polish failed (${res.status})`);
    }
    const json = await res.json().catch(() => null);
    const content: string = json?.choices?.[0]?.message?.content ?? "";
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) return reasons;
    return parsed.map((x) => String(x)).filter(Boolean).slice(0, 3);
  } catch (err) {
    console.warn("OpenAI reason polish failed, using deterministic reasons:", err);
    return reasons;
  }
}


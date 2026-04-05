# Sentinel — Macro-driven stock discovery (India)

<p align="center">
  <img src="webapp/assets/logo.svg" alt="Sentinel logo" width="88" />
</p>

**Sentinel** maps **macro** and **sector/industry momentum** to **high-growth Indian stocks** using deterministic scoring and a **financial interpretation layer** (growth, earnings, debt, quality—not raw numbers only).

It answers: **“What stocks are positioned to benefit from what is happening right now?”**

**Pipeline:** macro inputs + Trendlyne industry tape → blended scores (momentum, breadth, relative strength, quality, macro alignment) → sector cards and ranks; optional Tavily narrative for theme copy. Stock flow: ingest screener-style data → themes → match by sector/keywords → score and rank.

---

## Demo

Screen recording of the app in use (macro & industry momentum, stock analysis, recommendations):

<p align="center">
  <video src="docs/assets/Sentinel.mp4" controls playsinline width="100%" style="max-width: 960px">
    Your browser does not support embedded video.
    <a href="docs/assets/Sentinel.mp4">Open the demo (MP4)</a>.
  </video>
</p>

<p align="center"><sub>File: <code>docs/assets/Sentinel.mp4</code> — same asset ships in this repo for offline viewing.</sub></p>

---

## What you get

### Macro & industry momentum

- **Trendlyne** (server-side JSON) drives weekly industry % change, breadth, and sector structure.
- **Macro dials** (rates, inflation, yields, growth) combine with a regime/sector map for alignment; optional **Tavily** auto-fills macro from research (rate-limited; manual mode always works).
- **Sector cards**: top industries per sector, participation lines, BUY / Watch / Avoid style labels, optional narrative keywords from your domains/URLs.

### Analyze stocks & recommendations

Paste JSON, CSV/TSV, or **Load CSV/TSV File** (replaces the in-memory universe). **Analyze stocks** runs ingest + scoring; **Recommendations** shows ranked cards with conviction, tier, factor bands, and rationale.

---

## Why Sentinel

| Typical tools | Sentinel |
|---------------|----------|
| “What looks good on a screen?” | “What fits **today’s** macro and sector flow?” |
| Opaque ranks | Deterministic rules + visible breakdowns |

---

## Core features

- Industry intelligence API (`GET /industry-intelligence`) blending momentum, breadth, relative strength, quality, and macro alignment (see `docs/MACRO_AND_INDUSTRY_LOGIC.md`).
- Dynamic themes from Indian finance sources (optional Tavily/OpenAI; fallbacks if keys are missing).
- Theme ↔ stock matching: sector / subSector + keyword overlap; relevance thresholding.
- **Financial interpretation layer:** classifies revenue/EPS growth, debt risk, Piotroski, momentum, institutional activity.
- Composite stock scoring: growth, momentum, participation, valuation, acceleration.
- Web UI: static `webapp/`, served by the backend.

### Financial interpretation layer

Rules turn metrics into signals (e.g. weak / good / excellent growth, balance-sheet risk, quality). That is how Sentinel **reasons** about names, not only sums columns.

---

## Tech stack

| Area | Stack |
|------|--------|
| Backend | Node.js, Express 5, TypeScript, Zod |
| Integrations | Optional Tavily Research (macro + themes), OpenAI (enrichment / polish) |
| Frontend | Static `webapp/` (HTML/CSS/JS), served by the backend |

**API (selected):** `GET /health`, `GET /industry-intelligence`, `GET /trends`, `GET /themes`, `GET /recommendations`, `GET /macro-from-tavily`, `POST /stocks` (JSON or `csv` text with `replace: true` to overwrite the universe).

---

## Quick start

**Needs:** Node.js 18+ and npm.

```bash
git clone https://github.com/somthebuilder/Sentinel_Finance.git
cd Sentinel_Finance/backend
npm install
cp .env.example .env
# Edit .env — TAVILY_API_KEY optional for macro auto + richer themes; OPENAI_* optional
npm run dev
```

Open **http://localhost:3000** (or your `PORT`). Production-style: `npm run build && npm run start`.

### Use the app

1. **Macro & industry momentum** — Set narrative domains/URLs if you want Tavily theme context; choose Auto or Manual macro; **Refresh industry data** loads Trendlyne + merged narrative.
2. **Analyze stocks** — Paste or upload; **Analyze stocks** runs ingest + scoring. Check status under **Recommendations**.
3. **Recommendations** — If empty, check the parse report and that sectors/tags overlap active themes.

**Data:** Works best with **Trendlyne-style** exports; other screeners may need interpreter tweaks (see disclaimer).

---

## Typical stock fields

`name`, `symbol`, `exchange`, `sector`, `subSector`, `tags`, plus growth/valuation/ownership fields the parser can map (e.g. `revenueGrowth`, `peRatio`, `institutionalOwnership`, `momentumScore`). Aliasing handles many CSV header variants.

---

## Roadmap (summary)

- **Now:** Sharper theme ↔ stock mapping, sector-specific interpretation rules, tagging and breakout-style signals  
- **Next:** Validation (hit rates, history), execution hints (timing, risk), product features (watchlists, multi-user)

---

## Disclaimer

Not financial advice. Do your own diligence.

Sentinel is tuned for **Trendlyne-style** dumps; verify the financial interpretation layer for other data vendors before relying on scores.

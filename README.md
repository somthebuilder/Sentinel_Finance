# Sentinel - Find High-Growth Indian Stocks Using Macro Trends + Quant Scoring

<p align="center">
  <img src="webapp/assets/logo.svg" alt="Sentinel logo" width="96" />
</p>

**Sentinel** is an AI-assisted macro + quantitative engine to discover high-growth Indian stocks using macro trends, fundamental signals, and deterministic scoring.

This project is built for investors and builders who want a transparent, explainable **Indian stock market screener** combining:
- macro trend discovery
- fundamental analysis
- quant-style scoring
- AI-assisted keyword/reason enrichment (optional)

## Product Preview

### Themes Dashboard

![Sentinel macro themes dashboard](docs/images/sentinel-themes.png)

### Recommendations + Stock Ingestion

![Sentinel recommendations and stock ingestion workflow](docs/images/sentinel-recommendations.png)

## Why Sentinel

Most retail screeners either:
- stop at raw metrics, or
- give opaque "AI picks" with low explainability

Sentinel aims to bridge this gap with:
- **macro-aware themes** (India-focused sectors)
- **deterministic scoring logic** (clear formulas)
- **human-readable reasons** for each recommendation

## Core Features

- Dynamic macro theme extraction from trusted Indian finance sources
- Theme-to-stock matching using sector/subsector + keyword overlap
- Composite stock scoring using growth, momentum, ownership, valuation, and acceleration
- Clear "why now", conviction, tier, and signal outputs
- Web UI for fast experimentation with JSON/CSV/Excel-style pasted data
- Chrome extension popup (local backend mode) for lightweight monitoring

## Tech Stack

### Backend (`backend/`)
- Node.js + Express 5
- TypeScript
- Zod validation for robust input parsing
- Optional Tavily integration for macro source retrieval
- Optional OpenAI integration for keyword extraction and reason polishing

### Web App (`webapp/`)
- Vanilla HTML/CSS/JavaScript
- Single-page local interface served by backend
- Rich stock ingestion parser (JSON, CSV, TSV, pasted tables)

### Browser Extension (`extension/`)
- Manifest V3
- Popup UI calling `http://localhost:3000`

## How It Works (User Flow)

1. Sentinel fetches macro data (or fallback themes if APIs are not configured).
2. Macro text is converted into theme keywords and normalized to known sector themes.
3. You submit stock data via JSON/CSV/TSV/pasted screener table.
4. Stocks are validated, normalized, and optionally tag-enriched.
5. Stocks are ranked per theme with explainable score breakdowns.
6. UI renders top picks with reasons, tiers, and confidence signals.

## API Endpoints

- `GET /health` - service health check
- `GET /trends` - macro-driven themes
- `GET /themes` - alias of trends output
- `GET /recommendations` - ranked recommendations by theme
- `POST /stocks` - ingest stock payload (JSON/CSV/text)

## Local Setup

### 1) Clone and install backend deps

```bash
git clone https://github.com/somthebuilder/Sentinel_Finance.git
cd Sentinel_Finance/backend
npm install
```

### 2) Configure environment

```bash
cp .env.example .env
```

Set values in `backend/.env`:
- `TRAVILY_BASE_URL`
- `TRAVILY_API_KEY`
- `TRAVILY_TIMEOUT_MS`
- `TRAVILY_INCLUDE_DOMAINS`
- `OPENAI_API_KEY` (optional)
- `OPENAI_MODEL` (optional, default available in example)
- `PORT`

### 3) Build and run

```bash
npm run build
npm run start
```

Open: [http://localhost:3000](http://localhost:3000)

## Input Format (Minimum)

Each stock row supports fields like:
- `name`
- `symbol`
- `exchange`
- `sector`
- `subSector`
- `tags`
- `revenueGrowth`
- `previousRevenueGrowth`
- `peRatio`
- `institutionalOwnership`
- `momentumScore`

## Current Problems Being Solved

- **Signal quality in noisy macro news**  
  News feeds contain duplicates and low-value updates. Sentinel applies source filtering, deduping, and controlled theme mapping.

- **Mapping messy screener exports into normalized stock records**  
  Different tools use inconsistent headers. Sentinel includes robust aliasing and fallback parsing for real-world CSV/Excel data.

- **Balancing explainability with scoring quality**  
  Black-box outputs reduce trust. Sentinel keeps deterministic scoring and exposes score breakdowns plus reasons.

- **Cold-start dependency risk**  
  If external APIs are unavailable, Sentinel falls back to deterministic theme logic so the app still runs.

## Roadmap

### Near Term (0-2 months)
- Add unit/integration tests for parsers and scoring pipeline
- Improve error surfaces and data quality diagnostics in UI
- Add saved watchlists and result snapshots
- Add one-command local dev startup for backend + webapp

### Mid Term (2-4 months)
- Backtesting module for scoring consistency over historical periods
- Better factor weighting calibration for different market regimes
- Expand data connectors (more Indian market/public data adapters)
- Better ranking confidence diagnostics and uncertainty bands

### Long Term (4+ months)
- Portfolio construction layer (position sizing + risk constraints)
- Personalized strategy templates (growth, value, momentum blends)
- Collaboration features (shared watchlists, annotation, notes)
- Cloud deployment with auth and multi-user workspaces

## SEO Keywords

Indian stock market, stock screener, macro trends, AI investing, fundamental analysis, quantitative finance, growth investing, stock analysis India.

## Repository Metadata Recommendations

For best GitHub discoverability:
- **Repository name:** `Sentinel_Finance` (already updated)
- **Description:** `AI-assisted macro + quantitative engine to discover high-growth Indian stocks`
- **Suggested topics:** `stock-market`, `india`, `finance`, `investing`, `algorithmic-trading`, `quant`, `ai`, `stock-analysis`

## Disclaimer

This is a research and decision-support tool, not financial advice. Always do your own due diligence before investing.

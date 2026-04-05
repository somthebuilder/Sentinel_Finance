# Macro & industry intelligence — how it works

This document describes **what runs, in what order**, and **which rules** apply in the Sentinel backend for **industry intelligence** (Trendlyne data + macro overlays). It is meant as a functional map, not API reference.

**Code map**

| Area | Location |
|------|----------|
| Macro inputs, score, vector, Trendlyne fetch, industry scoring | `backend/src/services/industryIntelligenceService.ts` |
| Human headline, growth/liquidity line, regime chip, stacked **sector bias** (base quadrant + inflation/rates tilts) | `backend/src/data/macroHumanUi.ts` (merged into `macro` on `/industry-intelligence`) |
| Regime thresholds, drivers, NSE sector maps, factor tilts | `backend/src/data/macroSectorMap.ts` |
| Industry name → NSE sector (CSV-derived) | `backend/data/sector-industry-mapping.csv`, `backend/src/data/industrySectorMapping.ts` |
| HTTP routes | `backend/src/server.ts` (`GET` / `POST` `/industry-intelligence`; optional `sources`, `sourceUrls`, `refresh`) |
| Narrative → sector merge | `mergeThemeNarrativeIntoSectors` in `industryIntelligenceService.ts` (uses `getDynamicMacroThemes` + `macroThemesToThemeModels`) |
| Web UI | `webapp/index.html`, `webapp/app.js` |

---

## 1. End-to-end flow (one request)

1. **Client** sends macro inputs (defaults merged on the server if omitted): `rates`, `inflation`, `yields`, `growth`, and optionally **narrative** `sources` / `sourceUrls` (same shape as `/trends`).
2. **Validate** with Zod (`macroInputSchema`).
3. **Fetch** Trendlyne JSON (cached in memory with TTL from env; timeout from env).
4. **Normalize** each industry row: name, weekly % change, advances/declines, PE, ROE, sector string from JSON.
5. **Override sector** when the industry name exists in `INDUSTRY_TO_SECTOR` (your mapping file) — canonical NSE-style sector label.
6. **Compute** per industry: momentum, breadth, quality, macro alignment (float), optional **narrative slot** (neutral until wired), then **final score** and **BUY / NEUTRAL / AVOID**.
7. **Aggregate to sectors**: group industries by NSE `sector`; for each sector, keep the **top 2** industries by `final_score`. **Sector score** = mean of those two scores. Each sector row includes **`signal_strength`**, **`participation_line`** (one human-readable sentence on tape/participation), **`why_one_liner`** (one supporting sentence from sector templates + optional deduped theme keywords), pinned industries with momentum/breadth, and legacy **`narrative`** / **`macro_line`** fields for compatibility.
8. **Narrative merge (optional but default in UI):** run **`getDynamicMacroThemes`** with client domains/URLs; **dedupe** keyword soup (e.g. rail variants); **refine `why_one_liner`** when a substantive phrase appears; otherwise keep the template line.
9. **Sort** all industries by `final_score`; take **top 15** (`top_industries`) and an **avoid** list (AVOID-classified, or bottom slice if none).
10. **Return** JSON: `macro` (includes **human-facing** fields: `human_headline`, `growth_liquidity_note`, `regime_chip`, `sector_bias`, `sector_bias_line`; vector remains for debugging/back-compat), **`top_sectors`**, `top_industries`, `avoid_list`, `insight`.

The web app calls `GET /industry-intelligence?rates=…&sources=…` and renders **unified sector cards** in a **grid** (macro, momentum/breadth, signal, narrative, industries), then **avoid / weak** in a **second grid**. The **macro summary card** shows **plain-language** copy and a **single sector bias line** (e.g. `Industrials · Transportation · Utilities`), not raw macro score or internal vector components. The separate **Themes** UI was removed; narrative sources live next to macro controls. **Session baseline** (`ind` + `sec` maps) drives **rank movement** between runs.

---

## 2. Macro vector (deterministic)

Each dimension maps to **−1, 0, or +1** (same values used in the headline score):

| Dimension | Negative (−1) | Neutral (0) | Positive (+1) |
|-----------|----------------|-------------|----------------|
| Rates | Rising | Stable | Falling |
| Inflation | Rising | Stable | Cooling |
| Yields | Rising | Stable | Falling |
| Growth | Slowing, Contracting | — | Expanding |

**Headline macro score**

\[
\text{macroScore} = \frac{\text{rates} + \text{inflation} + \text{yields} + \text{growth}}{4}
\]

Example (default India preset): Stable / Stable / Rising / Expanding → \((0 + 0 - 1 + 1) / 4 = 0\).

---

## 3. Regime (from headline score only)

Implemented in `getRegime()` (`macroSectorMap.ts`), used as `detectRegime()` in the service:

| Condition | Regime |
|-----------|--------|
| `score <= -0.5` | `RISK_OFF` |
| `-0.5 < score < 0.25` | `NEUTRAL` |
| `0.25 <= score < 0.75` | `MILD_RISK_ON` |
| `score >= 0.75` | `STRONG_RISK_ON` |

So a score of **0** is **NEUTRAL**, not mild risk-on.

---

## 4. Narrative driver (separate from regime)

Drivers describe **which forces dominate** for copy and context. Resolved in `detectMacroDriver()` with this **priority**:

1. **`INFLATION_LED`** — inflation Rising **and** yields Rising (joint macro shock).
2. **`LIQUIDITY_LED`** — rates Falling **and** yields Falling (easy liquidity / easing).
3. **`CONFLICTED`** — growth vector **> 0** **and** yields vector **< 0** (e.g. expanding growth vs rising yields).
4. **`GROWTH_LED`** — growth vector **> 0**.
5. **`LIQUIDITY_TIGHT`** — yields vector **< 0** (rising yields).
6. **`BALANCED`** — otherwise.

**Sector overlay (`DRIVER_OVERRIDES`)** applies only to **`GROWTH_LED`**, **`LIQUIDITY_LED`**, and **`INFLATION_LED`**. Other drivers do not add a driver-level sector tilt (regime + factor stack still apply).

**`CONFLICTED` and alignment boost:** when the driver is **`CONFLICTED`**, `applyAlignmentConfidenceBoost` **does not** amplify macro alignment (no extra penalty/reward beyond the raw float). Final-score **macro weight** is also **reduced** (see §9) so the model does not lean hard on macro when growth and yields disagree.

**API fields**

- `macro.driver` — enum above.
- `macro.driver_label` — short human string (e.g. “Conflicted (growth vs liquidity)”).

**Copy rule**

- If driver is **`CONFLICTED`**, the main `macro.label` is a **fixed** sentence about growth vs yields and selective participation (not a generic bullish line).

---

## 5. NSE sector mapping (“logical buckets”)

`LOGICAL_TO_NSE` maps **labels** (e.g. `Financials`, `DefensiveCore`) to **arrays of exact NSE sector strings** used in your industry CSV / Trendlyne alignment.

Notable splits:

- **`DefensiveCore`** — staples, pharma/health, utilities, food & beverages & tobacco.
- **`DefensiveSemi`** — telecom equipment/services + software & hardware (semi-defensive / export-style IT).
- **`Defensive`** — core + semi (used where “broad defensives” matter, e.g. some risk-on avoids).
- **`Cyclicals`** — broad economy-sensitive list used when growth is **slowing** (avoid cyclicals).

`MACRO_SECTOR_MAP` encodes **regime → favoured / avoid** using these **logical** names; they expand to concrete sectors when scoring.

---

## 6. Per-factor sector tilts (rates, inflation, yields, growth)

Each factor has a **`MacroImpact`** `{ favoured, avoid }` of either logical labels or raw NSE sector strings. For a given industry sector string `s`:

- If `s` is in **favoured** → **+1**
- Else if `s` is in **avoid** → **−1**
- Else → **0**

**Growth special case — `Contracting`**

- Not a simple favoured/avoid table: **+1** only if the sector is in **`DefensiveCore` ∪ `DefensiveSemi`**; **−1** for every other sector (“defensives only vs everything else”).

---

## 7. Combined macro alignment (per industry)

For each industry, after resolving its **NSE sector** string:

1. **Regime score** — `scoreSectorAgainstImpact(sector, MACRO_SECTOR_MAP[regime])`.
2. **Driver score** — only if driver is `GROWTH_LED`, `LIQUIDITY_LED`, or `INFLATION_LED`; else 0.
3. **Factor average** — average of four factor scores: rates, inflation, yields, growth (each in {−1, 0, +1} except growth uses contracting logic when applicable).

Then:

\[
\text{macroAlignmentFloat} = \frac{\text{regimeScore} + \text{driverScore} + \text{factorAvg}}{3}
\]

That float is turned into a **legacy triplet** `macro_alignment` ∈ {−1, 0, +1} via thresholds (`floatToMacroTriplet`) for display consistency.

---

## 8. Momentum, breadth, quality (per industry)

- **Momentum** — min–max normalize **weekly % change** across all industries in the snapshot (same denominator for everyone).
- **Breadth** — \((\text{advances} - \text{declines}) / (\text{advances} + \text{declines})\), then mapped from [−1, 1] to [0, 1].
- **Quality** — ROE capped vs 20%, PE penalty above 25, clamped to [0, 1].

---

## 9. Final score and classification

Weights (narrative slot reserved; default neutral \(0.5\) until corpus-backed sector narrative exists):

\[
\text{finalScore} = w_m \cdot m + 0.2 \cdot b + 0.2 \cdot q + w_{\mu} \cdot \frac{\text{macroAlignmentFloat} + 1}{2} + 0.05 \cdot n
\]

where \(m, b, q\) are momentum, breadth, quality in [0, 1], \(n \in [0,1]\) is the narrative term (default **0.5**), and:

| Driver | \(w_m\) | \(w_{\mu}\) (macro) |
|--------|---------|---------------------|
| **`CONFLICTED`** | **0.45** | **0.10** |
| Other | **0.40** | **0.15** |

The macro term maps alignment from [−1, 1] to [0, 1].

| finalScore | Classification |
|------------|------------------|
| > 0.65 | `BUY` |
| > 0.5 | `NEUTRAL` |
| else | `AVOID` |

**Tags** (`inferTags` from industry name + sector) are still computed for **chips / context**; the **numeric** macro alignment uses the sector-map pipeline above, not tag-based alignment.

---

## 10. Tags (supplementary)

Rule-based tags (financial, commodity, defensive, etc.) are attached to each industry row for UI; they are **not** the primary input to `macro_alignment` after the sector-map work.

---

## 11. API defaults

Server merges query/body with **`defaultMacroInput`** in `industryIntelligenceService.ts` (currently India-style preset: Stable / Stable / Rising / Expanding unless overridden).

---

## 12. Web UI behaviour (industry block)

- Changing any macro control triggers a **refresh** of `/industry-intelligence`.
- **Narrative sources** (domains/URLs) sit **above** macro controls; each refresh sends them as query params so **sector `narrative`** can include **keyword bullets** from the same Tavily pipeline as the old Themes page.
- **Primary block:** **Compressed sector cards** — **`STRONG ↑ (score)`**-style headline, **`participation_line`**, **Top plays** (2 industries, human momentum/breadth labels, **BUY / Watch / Avoid**), **Why** (single sentence).
- **Secondary block:** **Avoid / weak** grid (same scores; shows mom/br).
- **`sessionStorage` (v2)** keeps **industry** and **sector** rank maps for movement; **Reset movement baseline** clears and refetches.
- **Recommendations** still call `/recommendations` (internal theme list + light overlap); there is **no separate Themes section** in the UI.

---

## 13. Environment (Trendlyne)

- Cache TTL and fetch timeout align with other market calls (see `MARKET_SIGNALS_CACHE_TTL_MS`, `MARKET_SIGNAL_TIMEOUT_MS` in `backend/.env.example` if present).

---

## 14. Regenerating industry ↔ sector TypeScript

After editing `data/sector-industry-mapping.csv`:

```bash
cd backend && npm run generate:industry-sector-map && npm run build
```

This refreshes `backend/src/data/industrySectorMapping.ts`.

---

## 15. Tavily auto-macro (`/macro-from-tavily`)

- **Service:** `backend/src/services/macroTavilyAutoService.ts`
- Runs **four** Tavily Research queries (rates, inflation, yields, growth) with an optional domain hint (`TAVILY_MACRO_AUTO_DOMAIN_HINT`, default `indiamacroindicators.co.in`).
- Concatenates synthesis + source lines, splits into **sentence voting units**, runs **keyword-based** `extractSignal` per unit, then **majority vote** → `MacroInput` + **confidence %** (vote share of the winning label per dimension).
- If there is **no API key** or **no usable text**, returns **`defaultMacroInput`** (`usedFallback: true`).
- **Does not** replace `defaultMacroInput` in code; the UI may **Auto**-fill selects from this endpoint or **Manual**-override.
- **Alignment boost:** `industryIntelligenceService` applies `applyAlignmentConfidenceBoost` to the raw sector alignment float (extra penalty if `≤ -0.3`, extra boost if `≥ 0.3`) before `final_score`, **except** when the macro driver is **`CONFLICTED`** (no boost; see §4).

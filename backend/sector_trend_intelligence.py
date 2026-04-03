#!/usr/bin/env python3
"""
Sector Trend Intelligence Engine (India) - v1

Builds ranked sector scores from:
1) Trendlyne trend signal
2) Tavily narrative signal
3) FPI smart-money signal (mock/override)

Usage examples:
  python sector_trend_intelligence.py
  python sector_trend_intelligence.py --tavily-api-key "tvly-..." --user-sources-json "[{\"domain\":\"equitymaster.com\",\"weight\":1.1}]"
  python sector_trend_intelligence.py --exclude-default "moneycontrol.com,pulse.zerodha.com"
  python sector_trend_intelligence.py --fpi-json "{\"Banking\":\"inflow\",\"IT\":\"neutral\",\"Metals\":\"outflow\"}"
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass
from html import unescape
from typing import Dict, Iterable, List, Optional, Tuple
from urllib.parse import urlparse
from urllib.request import Request, urlopen

try:
    from bs4 import BeautifulSoup  # type: ignore
except Exception:
    BeautifulSoup = None


DEFAULT_SECTORS = [
    "Banking",
    "IT",
    "Pharma",
    "FMCG",
    "Auto",
    "Capital Goods",
    "Power",
    "Infrastructure",
    "Metals",
    "Real Estate",
    "Energy",
]

DEFAULT_SOURCES = [
    "pulse.zerodha.com",
    "moneycontrol.com",
    "economictimes.indiatimes.com",
    "business-standard.com",
]

MAX_DOMAINS = 7

TREND_URL = "https://trendlyne.com/equity/sector-industry-analysis/sector/month/"
FPI_URL = "https://www.fpi.nsdl.co.in/Reports/Monthly.aspx"
TAVILY_SEARCH_URL = "https://api.tavily.com/search"
NSE_HOME_URL = "https://www.nseindia.com/"
NSE_ALL_INDICES_URL = "https://www.nseindia.com/api/allIndices"

TAVILY_QUERIES = [
    "which sectors are outperforming india stock market this week",
    "which industries are seeing strong investor interest india",
    "top performing sectors india recent news",
]

SECTOR_KEYWORDS: Dict[str, List[str]] = {
    "Power": ["power", "renewable", "electricity", "transmission", "utility"],
    "Capital Goods": ["capital goods", "engineering", "industrial", "capex", "order book", "capacity expansion"],
    "IT": ["it services", "software exports", "technology spending", "digital transformation", "cloud spending"],
    "Banking": ["banking", "credit growth", "loan growth", "npa", "deposit growth"],
    "Pharma": ["pharma", "healthcare demand", "drug approvals", "formulation", "api demand"],
    "FMCG": ["fmcg", "consumer demand", "rural demand", "volume growth", "pricing pressure"],
    "Auto": ["auto demand", "automobile", "vehicle sales", "ev demand", "inventory correction"],
    "Infrastructure": ["infrastructure", "roads", "railways", "construction activity", "project pipeline"],
    "Metals": ["metals", "steel demand", "base metals", "commodity cycle", "capacity utilization"],
    "Real Estate": ["real estate", "realty demand", "housing sales", "inventory overhang", "property cycle"],
    "Energy": ["energy", "oil and gas", "refining margins", "upstream", "downstream"],
}

SECTOR_ALIASES: Dict[str, List[str]] = {
    "Banking": ["banking", "financial services", "private banks", "psu banks", "banks"],
    "IT": ["it", "information technology", "software", "technology"],
    "Pharma": ["pharma", "healthcare", "drugs", "pharmaceutical"],
    "FMCG": ["fmcg", "consumer staples", "consumer goods", "staples"],
    "Auto": ["auto", "automobile", "automobiles", "vehicle", "auto ancillary"],
    "Capital Goods": ["capital goods", "industrials", "engineering", "machinery"],
    "Power": ["power", "utilities", "electricity", "renewable power"],
    "Infrastructure": ["infrastructure", "construction", "infra", "roads"],
    "Metals": ["metals", "metal", "mining", "steel"],
    "Real Estate": ["real estate", "realty", "property", "housing"],
    "Energy": ["energy", "oil", "gas", "o&g"],
}

POSITIVE_WORDS = ["growth", "rally", "strong", "bullish"]
NEGATIVE_WORDS = ["decline", "weak", "fall", "bearish"]


@dataclass
class SourceConfig:
    domain: str
    weight: float = 1.0


@dataclass
class NarrativeResult:
    title: str
    content: str
    domain: str


def normalize_domain(value: str) -> str:
    v = (value or "").strip().lower()
    if not v:
        return ""
    if "://" in v:
        v = urlparse(v).netloc.lower()
    # strip path if user passed accidental path without scheme
    v = v.split("/")[0].strip()
    # strip leading www. for dedupe consistency
    if v.startswith("www."):
        v = v[4:]
    return v


def parse_user_sources(user_sources_json: str) -> List[SourceConfig]:
    if not user_sources_json.strip():
        return []
    try:
        data = json.loads(user_sources_json)
    except json.JSONDecodeError as err:
        raise ValueError(f"Invalid --user-sources-json: {err}") from err
    if not isinstance(data, list):
        raise ValueError("--user-sources-json must be a JSON array")

    out: List[SourceConfig] = []
    for idx, item in enumerate(data):
        if not isinstance(item, dict):
            raise ValueError(f"user source at index {idx} must be an object")
        d = normalize_domain(str(item.get("domain", "")))
        if not d:
            continue
        w = item.get("weight", 1.0)
        try:
            w_num = float(w)
        except (TypeError, ValueError):
            w_num = 1.0
        if w_num <= 0:
            w_num = 1.0
        out.append(SourceConfig(domain=d, weight=w_num))
    return out


def merge_sources(
    default_sources: Iterable[str],
    user_sources: List[SourceConfig],
    excluded_defaults: Iterable[str],
    max_domains: int = MAX_DOMAINS,
) -> List[SourceConfig]:
    excluded = {normalize_domain(x) for x in excluded_defaults if normalize_domain(x)}
    merged: Dict[str, SourceConfig] = {}

    for d in default_sources:
        dn = normalize_domain(d)
        if not dn or dn in excluded:
            continue
        merged[dn] = SourceConfig(domain=dn, weight=1.0)

    for src in user_sources:
        if not src.domain:
            continue
        prev = merged.get(src.domain)
        if prev:
            # keep stronger weight if duplicate domain appears
            prev.weight = max(prev.weight, src.weight)
        else:
            merged[src.domain] = SourceConfig(domain=src.domain, weight=src.weight)

    # Keep stable order: defaults first, then user-only.
    ordered = list(merged.values())
    return ordered[:max_domains]


def http_get_text(url: str, timeout: int = 20) -> str:
    req = Request(url, headers={"User-Agent": "Mozilla/5.0 SectorIntel/1.0"})
    with urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="replace")


def http_post_json(url: str, payload: dict, timeout: int = 25, headers: Optional[dict] = None) -> dict:
    raw = json.dumps(payload).encode("utf-8")
    req_headers = {"Content-Type": "application/json", "User-Agent": "Mozilla/5.0 SectorIntel/1.0"}
    if headers:
        req_headers.update(headers)
    req = Request(url, data=raw, headers=req_headers, method="POST")
    with urlopen(req, timeout=timeout) as resp:
        body = resp.read().decode("utf-8", errors="replace")
    return json.loads(body)


def fetch_nse_all_indices(timeout: int = 20) -> dict:
    # NSE commonly requires a priming homepage request for cookies.
    opener = __import__("urllib.request").request.build_opener(
        __import__("urllib.request").request.HTTPCookieProcessor()
    )
    common_headers = {
        "User-Agent": "Mozilla/5.0 SectorIntel/1.0",
        "Accept": "application/json,text/plain,*/*",
        "Accept-Language": "en-US,en;q=0.9",
    }
    home_req = Request(NSE_HOME_URL, headers=common_headers)
    with opener.open(home_req, timeout=timeout):
        pass
    api_headers = dict(common_headers)
    api_headers["Referer"] = NSE_HOME_URL
    api_req = Request(NSE_ALL_INDICES_URL, headers=api_headers)
    with opener.open(api_req, timeout=timeout) as resp:
        body = resp.read().decode("utf-8", errors="replace")
    return json.loads(body)


def html_to_text(html: str) -> str:
    text = re.sub(r"<script[^>]*>.*?</script>", " ", html, flags=re.I | re.S)
    text = re.sub(r"<style[^>]*>.*?</style>", " ", text, flags=re.I | re.S)
    text = re.sub(r"<[^>]+>", " ", text)
    text = unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def count_keyword_occurrences(text: str, keyword: str) -> int:
    t = (text or "").lower()
    k = (keyword or "").strip().lower()
    if not k:
        return 0
    if len(k) <= 2 and k.isalpha():
        # Avoid false positives for very short tokens like "it", "lt".
        return len(re.findall(rf"\b{re.escape(k)}\b", t))
    if " " in k:
        return len(re.findall(rf"\b{re.escape(k)}\b", t))
    return t.count(k)


def fuzzy_match_sector(candidate: str, sectors: List[str]) -> Optional[str]:
    c = candidate.lower()
    sector_lu = {s.lower(): s for s in sectors}
    # Exact contains first.
    for k, canonical in sector_lu.items():
        if k in c:
            return canonical
    # Fuzzy token/alias contains.
    for sector in sectors:
        tokens = [sector.lower()] + [a.lower() for a in SECTOR_ALIASES.get(sector, [])]
        for token in tokens:
            token_parts = [p for p in re.split(r"\s+", token) if p]
            if any(part in c for part in token_parts):
                return sector
    return None


def extract_trend_returns_from_trendlyne(html: str, sectors: List[str], debug: bool = False) -> Dict[str, float]:
    values: Dict[str, float] = {}
    if debug:
        print("\n[DEBUG] Trendlyne raw html (first 2000 chars):")
        print(html[:2000])

    if BeautifulSoup is None:
        if debug:
            print("[DEBUG] BeautifulSoup not available; using regex fallback parse.")
        text = html_to_text(html).lower()
        for sector in sectors:
            s = sector.lower()
            pattern = rf"{re.escape(s)}.{{0,220}}?([-+]?\d+(?:\.\d+)?)\s*%"
            m = re.search(pattern, text, flags=re.I)
            if m:
                try:
                    values[sector] = float(m.group(1))
                except ValueError:
                    pass
        return values

    soup = BeautifulSoup(html, "html.parser")
    rows = soup.select("table tr")
    if debug:
        print(f"\n[DEBUG] Trendlyne parsed rows: {len(rows)}")

    header_cells: List[str] = []
    one_month_idx = -1
    sector_idx = 0
    for row_idx, row in enumerate(rows):
        cells = row.find_all(["th", "td"])
        cols = [c.get_text(" ", strip=True) for c in cells]
        if debug and cols:
            print(f"[DEBUG] row[{row_idx}] cols={cols}")
        if not cols:
            continue

        low_cols = [c.lower() for c in cols]
        # header detection
        if row.find("th") is not None and not header_cells:
            header_cells = low_cols
            for i, h in enumerate(header_cells):
                if "1 month" in h or h == "1m" or "1m return" in h:
                    one_month_idx = i
                if "sector" in h or "industry" in h or "name" in h:
                    sector_idx = i
            continue

        # data row parsing
        candidate_sector_text = cols[sector_idx] if sector_idx < len(cols) else cols[0]
        matched_sector = fuzzy_match_sector(candidate_sector_text, sectors)
        if not matched_sector:
            continue

        candidate_return = ""
        if 0 <= one_month_idx < len(cols):
            candidate_return = cols[one_month_idx]
        else:
            # fallback: pick first percentage-looking cell in row
            for c in cols:
                if "%" in c:
                    candidate_return = c
                    break

        m = re.search(r"([-+]?\d+(?:\.\d+)?)\s*%?", candidate_return.replace(",", ""))
        if not m:
            continue
        try:
            values[matched_sector] = float(m.group(1))
        except ValueError:
            continue

    return values


def normalize_numeric_map(values: Dict[str, float], keys: List[str]) -> Dict[str, Optional[float]]:
    present = [v for v in values.values() if isinstance(v, (int, float))]
    if not present:
        return {k: None for k in keys}

    lo, hi = min(present), max(present)
    if abs(hi - lo) < 1e-9:
        # Data exists but has no separation; keep as low-confidence middle.
        return {k: 50.0 if k in values else None for k in keys}

    out: Dict[str, Optional[float]] = {}
    for k in keys:
        v = values.get(k)
        if v is None:
            out[k] = None
        else:
            out[k] = ((v - lo) / (hi - lo)) * 100.0
    return out


def run_trend_engine(sectors: List[str], trend_url: str = TREND_URL, debug: bool = False) -> Dict[str, Optional[float]]:
    try:
        html = http_get_text(trend_url)
        one_month_returns = extract_trend_returns_from_trendlyne(html, sectors, debug=debug)
        print("Trend raw:", one_month_returns)
        if not one_month_returns:
            print("WARN: Trendlyne parse empty. Trying NSE proxy trend source.", file=sys.stderr)
            one_month_returns = extract_nse_proxy_returns(sectors, debug=debug)
            print("Trend raw (NSE proxy):", one_month_returns)
        elif debug:
            print(f"[DEBUG] Trendlyne extracted raw returns: {one_month_returns}")
        if not one_month_returns:
            print("WARN: No trend source produced data. Trend scores will be marked missing.", file=sys.stderr)
        return normalize_numeric_map(one_month_returns, sectors)
    except Exception as err:
        print(f"WARN: Trend engine failed ({err}). Trend scores will be marked missing.", file=sys.stderr)
        return {s: None for s in sectors}


def extract_nse_proxy_returns(sectors: List[str], debug: bool = False) -> Dict[str, float]:
    # Proxy trend source when Trendlyne table is unavailable:
    # Uses NSE sector index percent change as directional trend proxy.
    sector_to_index_tokens: Dict[str, List[str]] = {
        "Banking": ["nifty bank", "nifty private bank", "nifty psu bank"],
        "IT": ["nifty it"],
        "Pharma": ["nifty pharma", "nifty healthcare"],
        "FMCG": ["nifty fmcg"],
        "Auto": ["nifty auto"],
        "Capital Goods": ["nifty industrials", "nifty india manufacturing", "nifty capital markets"],
        "Power": ["nifty energy", "nifty cpse"],
        "Infrastructure": ["nifty infrastructure", "nifty pse", "nifty india defence"],
        "Metals": ["nifty metal", "nifty commodities"],
        "Real Estate": ["nifty realty"],
        "Energy": ["nifty oil & gas", "nifty energy"],
    }
    out: Dict[str, float] = {}
    try:
        payload = fetch_nse_all_indices()
    except Exception as err:
        if debug:
            print(f"[DEBUG] NSE proxy fetch failed: {err}")
        return out

    rows = payload.get("data") or []
    if debug:
        print(f"[DEBUG] NSE indices rows: {len(rows)}")
    normalized_rows: List[Tuple[str, float]] = []
    for r in rows:
        index_name = str(r.get("index", "")).strip().lower()
        if not index_name:
            continue
        raw_change = r.get("percentChange")
        try:
            pct = float(str(raw_change).replace(",", "").strip())
        except Exception:
            continue
        normalized_rows.append((index_name, pct))

    for sector in sectors:
        tokens = [t.lower() for t in sector_to_index_tokens.get(sector, [])]
        found: Optional[float] = None
        for idx_name, pct in normalized_rows:
            if any(tok in idx_name for tok in tokens):
                found = pct
                break
        if found is not None:
            out[sector] = found
    return out


def extract_domain_from_url(url: str) -> str:
    if not url:
        return ""
    try:
        return normalize_domain(urlparse(url).netloc)
    except Exception:
        return ""


def run_tavily_queries(api_key: str, include_domains: List[str], debug: bool = False) -> List[NarrativeResult]:
    results: List[NarrativeResult] = []
    headers = {"Authorization": f"Bearer {api_key}"}

    for query in TAVILY_QUERIES:
        payload = {
            "query": query,
            "topic": "finance",
            "time_range": "week",
            "search_depth": "advanced",
            "max_results": 8,
            "include_domains": include_domains,
        }
        try:
            data = http_post_json(TAVILY_SEARCH_URL, payload, headers=headers)
        except Exception as err:
            print(f"WARN: Tavily query failed for '{query}': {err}", file=sys.stderr)
            continue
        if debug:
            print(f"\n[DEBUG] Tavily response for query: {query}")
            print(json.dumps(data, indent=2)[:4000])

        for row in data.get("results", []) or []:
            title = str(row.get("title", "")).strip()
            content = str(row.get("content", "")).strip()
            domain = extract_domain_from_url(str(row.get("url", "")))
            if not domain:
                domain = normalize_domain(str(row.get("source", "")))
            if title or content:
                results.append(NarrativeResult(title=title, content=content, domain=domain))
    return results


def score_sentiment(text: str) -> int:
    t = (text or "").lower()
    pos = sum(t.count(w) for w in POSITIVE_WORDS)
    neg = sum(t.count(w) for w in NEGATIVE_WORDS)
    return pos - neg


def run_narrative_engine(
    sectors: List[str],
    source_weights: Dict[str, float],
    tavily_api_key: Optional[str],
    debug: bool = False,
) -> Tuple[Dict[str, Optional[float]], Dict[str, int]]:
    if not tavily_api_key:
        print("WARN: TAVILY_API_KEY missing. Narrative scores will be marked missing.", file=sys.stderr)
        return {s: None for s in sectors}, {s: 0 for s in sectors}

    include_domains = list(source_weights.keys())
    entries = run_tavily_queries(tavily_api_key, include_domains=include_domains, debug=debug)
    if not entries:
        print("WARN: Narrative engine produced no entries. Narrative scores will be marked missing.", file=sys.stderr)
        return {s: None for s in sectors}, {s: 0 for s in sectors}
    if debug:
        combined_text = " ".join((e.content or "") for e in entries)
        print("\n[DEBUG] Combined narrative content sample:")
        print(combined_text[:2500])

    raw: Dict[str, float] = {s: 0.0 for s in sectors}
    coverage: Dict[str, int] = {s: 0 for s in sectors}

    for e in entries:
        content = f"{e.title} {e.content}".lower()
        sentiment = score_sentiment(content)

        weight = float(source_weights.get(e.domain, 1.0))
        for sector in sectors:
            keywords = SECTOR_KEYWORDS.get(sector, [sector.lower()])
            mentions = sum(count_keyword_occurrences(content, k) for k in keywords)
            if mentions > 0 and sentiment == 0:
                sentiment_effective = 0.5
            else:
                sentiment_effective = float(sentiment)
            if debug and mentions > 0:
                for k in keywords:
                    if count_keyword_occurrences(content, k) > 0:
                        print(f"[DEBUG] narrative keyword hit: sector={sector}, keyword={k}, domain={e.domain}")
            weighted_mentions = mentions * weight
            raw[sector] += weighted_mentions * sentiment_effective
            coverage[sector] += mentions

    # Narrative score should not go negative in this v1.
    raw_non_negative = {k: max(v, 0.0) for k, v in raw.items()}
    print("Narrative raw:", raw_non_negative)
    if all(v <= 0 for v in raw_non_negative.values()):
        return {s: None for s in sectors}, coverage
    return normalize_numeric_map(raw_non_negative, sectors), coverage


def parse_fpi_json_input(fpi_json: str, sectors: List[str]) -> Dict[str, float]:
    if not fpi_json.strip():
        return {}
    try:
        data = json.loads(fpi_json)
    except json.JSONDecodeError as err:
        raise ValueError(f"Invalid --fpi-json: {err}") from err
    if not isinstance(data, dict):
        raise ValueError("--fpi-json must be a JSON object: {sector: inflow|neutral|outflow|number}")

    out: Dict[str, float] = {}
    sector_lu = {s.lower(): s for s in sectors}
    for raw_key, raw_val in data.items():
        canonical = sector_lu.get(str(raw_key).strip().lower())
        if not canonical:
            continue
        if isinstance(raw_val, (int, float)):
            out[canonical] = max(-20.0, min(20.0, float(raw_val)))
            continue
        v = str(raw_val).strip().lower()
        if v == "inflow":
            out[canonical] = 20.0
        elif v == "outflow":
            out[canonical] = -20.0
        else:
            out[canonical] = 0.0
    return out


def run_fpi_engine(sectors: List[str], fpi_override_json: str, fpi_url: str = FPI_URL) -> Dict[str, float]:
    # v1: NSDL is not sector-granular in a stable parse format; use override/mock.
    try:
        _ = http_get_text(fpi_url, timeout=12)
    except Exception as err:
        print(f"WARN: FPI source fetch failed ({err}). Using mock/override.", file=sys.stderr)

    override = parse_fpi_json_input(fpi_override_json, sectors) if fpi_override_json else {}
    base = {s: 0.0 for s in sectors}
    base.update(override)

    # Normalize -20..20 to 0..100 for weighted blend.
    normalized = {s: ((base[s] + 20.0) / 40.0) * 100.0 for s in sectors}
    return normalized


def classify_status(final_score: float, trend_score: float) -> str:
    # Business rule: weak trend cannot be masked by narrative.
    if final_score >= 75.0:
        return "Strong Uptrend"
    if final_score >= 55.0:
        return "Emerging"
    return "Weak"


def compute_final_scores(
    sectors: List[str],
    trend_scores: Dict[str, Optional[float]],
    narrative_scores: Dict[str, Optional[float]],
    fpi_scores: Dict[str, float],
    narrative_coverage: Dict[str, int],
) -> List[dict]:
    ranked: List[dict] = []
    for sector in sectors:
        trend_raw = trend_scores.get(sector)
        narrative_raw = narrative_scores.get(sector)
        trend = float(trend_raw) if trend_raw is not None else 30.0
        narrative = float(narrative_raw) if narrative_raw is not None else 30.0
        fpi = float(fpi_scores.get(sector, 50.0))
        coverage = int(narrative_coverage.get(sector, 0))

        # Trend gets highest priority.
        final_score = (0.5 * trend) + (0.3 * narrative) + (0.2 * fpi)

        # Narrative cannot override weak trend.
        if trend < 40.0 and final_score >= 55.0:
            final_score = 54.0

        status = classify_status(final_score, trend)
        confidence = "Low Confidence" if coverage == 0 else "High Confidence"
        if confidence == "Low Confidence" and status == "Weak":
            status = "Weak (Low Confidence)"
        ranked.append(
            {
                "name": sector,
                "trend_missing": trend_raw is None,
                "narrative_missing": narrative_raw is None,
                "coverage_mentions": coverage,
                "confidence": confidence,
                "trend_score": round(trend, 2),
                "narrative_score": round(narrative, 2),
                "fpi_score": round(fpi, 2),
                "final_score": round(final_score, 2),
                "status": status,
            }
        )
    ranked.sort(key=lambda x: x["final_score"], reverse=True)
    return ranked


def parse_sector_list(raw_json: str) -> List[str]:
    if not raw_json.strip():
        return DEFAULT_SECTORS
    try:
        data = json.loads(raw_json)
    except json.JSONDecodeError as err:
        raise ValueError(f"Invalid --sectors-json: {err}") from err
    if not isinstance(data, list):
        raise ValueError("--sectors-json must be a JSON array of sector names")
    cleaned = [str(x).strip() for x in data if str(x).strip()]
    return cleaned or DEFAULT_SECTORS


def print_cli_table(rows: List[dict]) -> None:
    print("\nRanked sectors:\n")
    print(f"{'Rank':<5} {'Sector':<16} {'Trend':>8} {'Narrative':>11} {'Cov':>6} {'FPI':>8} {'Final':>8} {'Status':>22}")
    print("-" * 102)
    for i, row in enumerate(rows, start=1):
        print(
            f"{i:<5} {row['name']:<16} "
            f"{row['trend_score']:>8.2f} {row['narrative_score']:>11.2f} "
            f"{row['coverage_mentions']:>6} {row['fpi_score']:>8.2f} {row['final_score']:>8.2f} {row['status']:>22}"
        )
    print("")


def build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Sector trend intelligence engine for Indian markets.")
    p.add_argument("--tavily-api-key", default=os.getenv("TAVILY_API_KEY", "").strip(), help="Tavily API key")
    p.add_argument("--user-sources-json", default="", help='JSON array: [{"domain":"equitymaster.com","weight":1.1}]')
    p.add_argument("--exclude-default", default="", help="Comma-separated default domains to remove")
    p.add_argument("--sectors-json", default="", help='Optional JSON array of sectors; defaults to built-in list')
    p.add_argument("--trend-url", default=TREND_URL, help="Trendlyne URL")
    p.add_argument("--fpi-url", default=FPI_URL, help="NSDL FPI URL")
    p.add_argument("--fpi-json", default="", help='Optional JSON object: {"Banking":"inflow","IT":"neutral"}')
    p.add_argument("--debug", action="store_true", help="Enable verbose debug output for Trendlyne/Tavily parsing")
    p.add_argument("--sanity-test", action="store_true", help="Run scoring with hardcoded fake data and exit")
    return p


def main() -> int:
    args = build_arg_parser().parse_args()

    sectors = parse_sector_list(args.sectors_json)
    user_sources = parse_user_sources(args.user_sources_json)
    excluded_defaults = [x.strip() for x in args.exclude_default.split(",") if x.strip()]
    merged_sources = merge_sources(DEFAULT_SOURCES, user_sources, excluded_defaults, MAX_DOMAINS)
    source_weights = {s.domain: s.weight for s in merged_sources}

    if len(merged_sources) > MAX_DOMAINS:
        # defensive; merge_sources already caps
        merged_sources = merged_sources[:MAX_DOMAINS]

    if args.sanity_test:
        trend_scores: Dict[str, Optional[float]] = {s: None for s in sectors}
        narrative_scores: Dict[str, Optional[float]] = {s: None for s in sectors}
        trend_scores.update({"Power": 90.0, "IT": 40.0, "Banking": 70.0})
        narrative_scores.update({"Power": 80.0, "IT": 30.0, "Banking": 60.0})
        narrative_coverage = {s: 0 for s in sectors}
        narrative_coverage.update({"Power": 9, "IT": 5, "Banking": 7})
        fpi_scores = {s: 50.0 for s in sectors}
    else:
        trend_scores = run_trend_engine(sectors, trend_url=args.trend_url, debug=args.debug)
        narrative_scores, narrative_coverage = run_narrative_engine(
            sectors, source_weights, args.tavily_api_key, debug=args.debug
        )
        fpi_scores = run_fpi_engine(sectors, fpi_override_json=args.fpi_json, fpi_url=args.fpi_url)

    print(
        json.dumps(
            {
                "trend_data": trend_scores,
                "narrative_data": narrative_scores,
                "narrative_coverage": narrative_coverage,
                "fpi_data": fpi_scores,
            },
            indent=2,
        )
    )

    ranked = compute_final_scores(sectors, trend_scores, narrative_scores, fpi_scores, narrative_coverage)
    print_cli_table(ranked)

    output = {"top_sectors": ranked}
    print(json.dumps(output, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

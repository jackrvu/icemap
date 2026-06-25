# =========================
# FAST DROP-IN IMPROVEMENTS
# =========================

from __future__ import annotations

import asyncio
import csv
import io
import json
import os
import time
import hashlib
from dataclasses import dataclass
from datetime import datetime
from functools import lru_cache
from typing import Optional, Callable, Literal

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from dotenv import load_dotenv

from newspaper import Article

# Load environment variables from .env file
load_dotenv()

# -------------------------
# Shared HTTP session + retries (keep-alive)
# -------------------------

def _build_session() -> requests.Session:
    s = requests.Session()
    retry = Retry(
        total=5,
        connect=5,
        read=5,
        backoff_factor=0.35,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=frozenset(["GET", "POST"]),
        raise_on_status=False,
    )
    adapter = HTTPAdapter(max_retries=retry, pool_connections=100, pool_maxsize=100)
    s.mount("http://", adapter)
    s.mount("https://", adapter)
    s.headers.update({"Connection": "keep-alive"})
    return s

SESSION = _build_session()

# -------------------------
# Small helpers
# -------------------------

def _domain_publisher(url: str) -> str:
    """Fast publisher fallback: derive from URL domain (no LLM)."""
    try:
        from urllib.parse import urlparse
        host = urlparse(url).netloc.lower()
        if host.startswith("www."):
            host = host[4:]
        host = host.split(":")[0]
        base = host.split(".")[0] if host else "unknown"
        return base.capitalize() if base else "Unknown"
    except Exception:
        return "Unknown"

def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", errors="ignore")).hexdigest()

# -------------------------
# Local CSV cache (static fallback for frontend)
# -------------------------
import threading as _threading
import uuid as _uuid

_LOCAL_CSV_LOCK = _threading.Lock()
_LOCAL_CSV_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "frontend", "public", "aggregated_incidents.csv"
)
_LOCAL_CSV_FIELDS = [
    "publisher", "state", "category", "longitude", "latitude",
    "scrape_date", "reported_count", "location", "url", "zip",
    "street", "city", "id", "title", "county", "summary", "date",
]

def _append_to_local_csv(payload: dict) -> None:
    """Append a successfully processed article to the static frontend CSV."""
    try:
        coords = payload.get("coordinates", {})
        loc = payload.get("parsed_location") or {}
        row = {
            "publisher": payload.get("publisher", ""),
            "state": loc.get("state", ""),
            "category": payload.get("category", "unknown"),
            "longitude": coords.get("lon", ""),
            "latitude": coords.get("lat", ""),
            "scrape_date": "",
            "reported_count": 1,
            "location": payload.get("address", ""),
            "url": payload.get("url", ""),
            "zip": "",
            "street": "",
            "city": loc.get("city", ""),
            "id": str(_uuid.uuid4()),
            "title": payload.get("title", ""),
            "county": "",
            "summary": "",
            "date": payload.get("date", ""),
        }
        import csv as _csv
        with _LOCAL_CSV_LOCK:
            write_header = not os.path.exists(_LOCAL_CSV_PATH)
            with open(_LOCAL_CSV_PATH, "a", newline="", encoding="utf-8") as fh:
                writer = _csv.DictWriter(fh, fieldnames=_LOCAL_CSV_FIELDS, extrasaction="ignore")
                if write_header:
                    writer.writeheader()
                writer.writerow(row)
    except Exception:
        pass  # Never fail the pipeline due to local write errors

async def _to_thread(fn, *args, **kwargs):
    """Run blocking call in thread (works on py>=3.9)."""
    try:
        return await asyncio.to_thread(fn, *args, **kwargs)
    except AttributeError:
        # Fallback for Python < 3.9
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, lambda: fn(*args, **kwargs))

# -------------------------
# OpenAI: single-call analysis per article
# -------------------------

OPENAI_API_URL = "https://api.openai.com/v1/responses"
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")

def _openai_json(prompt: str, *, max_output_tokens: int = 260, timeout: int = 30) -> dict:
    """
    Calls Responses API in JSON mode; returns parsed dict or {}.
    Uses SESSION for connection reuse + retries.
    """
    if not OPENAI_API_KEY:
        return {}

    headers = {
        "Authorization": f"Bearer {OPENAI_API_KEY}",
        "Content-Type": "application/json",
    }

    data: dict = {
        "model": "gpt-5-nano",
        "input": prompt,
        "max_output_tokens": max_output_tokens,
        "reasoning": {"effort": "minimal"},
        "text": {"format": {"type": "json_object"}},
    }

    try:
        resp = SESSION.post(OPENAI_API_URL, headers=headers, json=data, timeout=timeout)
        if not resp.ok:
            return {}
        result = resp.json()
        out = result.get("output_text")
        if isinstance(out, str) and out.strip():
            return json.loads(out)
        # Fallback: scan "output" array
        chunks = []
        for item in result.get("output", []) or []:
            if item.get("type") == "message":
                for c in item.get("content", []) or []:
                    if c.get("type") in ("output_text", "text"):
                        t = c.get("text")
                        if isinstance(t, str) and t:
                            chunks.append(t)
        if chunks:
            return json.loads("".join(chunks))
    except Exception:
        return {}

    return {}

def analyze_article_once(text: str, url: str) -> dict:
    """
    One LLM call for:
    - relevance
    - category
    - geocode-ready address query (or null)
    - parsed_location (city/state/country/address/location_details)
    - publisher
    """
    # Keep it short for latency & cost. Usually enough for ICE + location.
    clipped = text[:2500]

    prompt = f"""
You extract structured fields for a news ingestion pipeline focused on ICE (Immigration and Customs Enforcement).

Return ONLY valid JSON with EXACT keys:
- relevant: boolean (true if the article discusses ICE operations, detentions, arrests, raids, ICE policy, ICE-related protests, or ICE news)
- category: one of ["raid","arrest","detention","protest","policy","opinion","unknown"]
- address_query: a geocoding-ready location string (city/state/country, address, landmark) or null if not location-specific
- parsed_location: object with keys ["city","state","country","address","location_details"] (empty strings allowed)
- publisher: short canonical publisher name inferred from URL/domain or article

Important rules:
- If the location is ambiguous (e.g., "Washington"), prefer "Washington, DC, USA" unless context strongly indicates otherwise.
- For abbreviations (LA, NYC), expand to a standard geocoding string.
- If this is national policy news with no place, set address_query to null.
- Output JSON only.

URL: {url}

Article text:
{clipped}
""".strip()

    return _openai_json(prompt, max_output_tokens=260, timeout=30)

# -------------------------
# newspaper3k text fetch (cached by URL only)
# -------------------------

def getText(url: str) -> str:
    article = Article(url)
    article.download()
    article.parse()
    return article.text or ""

@lru_cache(maxsize=4096)
def fast_getText(url: str) -> str:
    return getText(url)

# -------------------------
# Google Places geocoding (keep your existing geoTag, but use SESSION)
# -------------------------

GOOGLE_PLACES_API_KEY = os.getenv("GOOGLE_PLACES_API_KEY")

@lru_cache(maxsize=8192)
def fast_geoTag(address: str) -> Optional[tuple[float, float]]:
    if not GOOGLE_PLACES_API_KEY or not address:
        return None
    try:
        places_url = "https://maps.googleapis.com/maps/api/place/findplacefromtext/json"
        params = {
            "input": address,
            "inputtype": "textquery",
            "fields": "geometry/location,formatted_address",
            "key": GOOGLE_PLACES_API_KEY,
        }
        r = SESSION.get(places_url, params=params, timeout=10)
        if not r.ok:
            return None
        data = r.json()
        if data.get("status") == "OK" and data.get("candidates"):
            loc = data["candidates"][0]["geometry"]["location"]
            return (loc["lat"], loc["lng"])
    except Exception:
        return None
    return None

# -------------------------
# Your APIs (persist + mark processed), with session reuse
# -------------------------

ARTICLES_API = os.getenv("ARTICLES_API")
ARTICLES_API_KEY = os.getenv("ARTICLES_API_KEY")
ARTICLES_GET_API = os.getenv("ARTICLES_GET_API")
ARTICLES_PROCESS_MARK_API = os.getenv("ARTICLES_PROCESS_MARK_API")

def getUnprocessedArticles() -> str:
    if not ARTICLES_GET_API:
        raise RuntimeError("ARTICLES_GET_API env var required")
    r = SESSION.get(ARTICLES_GET_API, timeout=30)
    r.raise_for_status()
    j = r.json()
    if j.get("statusCode") != 200:
        raise RuntimeError(f"GET unprocessed failed: {j}")
    return (j.get("body") or "")

def addArticle(payload: dict) -> None:
    if not ARTICLES_API:
        raise RuntimeError("ARTICLES_API env var required")
    if not ARTICLES_API_KEY:
        raise RuntimeError("ARTICLES_API_KEY env var required")
    headers = {"Content-Type": "application/json", "x-api-key": ARTICLES_API_KEY}
    r = SESSION.post(ARTICLES_API, headers=headers, json=payload, timeout=15)
    if not r.ok:
        raise RuntimeError(f"putArticle failed → {r.status_code}: {r.text}")

def markArticleAsProcessed(url: str) -> None:
    if not ARTICLES_PROCESS_MARK_API:
        raise RuntimeError("ARTICLES_PROCESS_MARK_API env var required")
    if not ARTICLES_API_KEY:
        raise RuntimeError("ARTICLES_API_KEY env var required")
    headers = {"Content-Type": "application/json", "x-api-key": ARTICLES_API_KEY}
    r = SESSION.post(ARTICLES_PROCESS_MARK_API, headers=headers, json={"url": url}, timeout=15)
    r.raise_for_status()
    # Accept either raw 200 or Lambda proxy JSON with statusCode.
    try:
        j = r.json()
        if isinstance(j, dict) and j.get("statusCode") not in (None, 200):
            raise RuntimeError(f"mark failed: {j}")
    except Exception:
        pass

def markArticlesAsProcessed_batch(urls: list[str]) -> None:
    """
    Tries batch payload: {"urls":[...]}.
    If your API doesn't support it, falls back to per-url marking.
    """
    if not urls:
        return
    if not ARTICLES_PROCESS_MARK_API or not ARTICLES_API_KEY:
        # fall back to per-url (will raise meaningful errors)
        for u in urls:
            markArticleAsProcessed(u)
        return

    headers = {"Content-Type": "application/json", "x-api-key": ARTICLES_API_KEY}

    # Try batch first
    try:
        r = SESSION.post(ARTICLES_PROCESS_MARK_API, headers=headers, json={"urls": urls}, timeout=20)
        # If API doesn't support, it may 4xx or return statusCode != 200.
        if r.ok:
            try:
                j = r.json()
                if isinstance(j, dict) and j.get("statusCode") not in (None, 200):
                    raise RuntimeError(f"batch mark rejected: {j}")
            except Exception:
                # If it's not JSON, but HTTP 200, assume ok
                pass
            return
    except Exception:
        pass

    # Fallback: individual marks
    for u in urls:
        try:
            markArticleAsProcessed(u)
        except Exception:
            # Best effort; you can log if you want
            pass

# -------------------------
# Record type
# -------------------------

@dataclass
class CSVRecord:
    title: str
    description: str
    date: datetime
    url: str

def _parse_csv_records(csv_blob: str, limit: int) -> list[CSVRecord]:
    csv_blob = (csv_blob or "").replace("\r\n", "\n").replace("\r", "\n")
    reader = csv.DictReader(io.StringIO(csv_blob))
    out: list[CSVRecord] = []
    for row in reader:
        if len(out) >= limit:
            break
        try:
            try:
                d = datetime.strptime(row["date"], "%Y-%m-%d")
            except Exception:
                d = datetime.now()
            out.append(
                CSVRecord(
                    title=row.get("title", "") or "",
                    description=row.get("description", "") or "",
                    date=d,
                    url=row.get("url", "") or "",
                )
            )
        except Exception:
            continue
    return [r for r in out if r.url]

# -------------------------
# CONCURRENT PIPELINE
# -------------------------

# Tune these based on quotas + machine.
FETCH_CONCURRENCY = int(os.getenv("ICE_FETCH_CONCURRENCY", "40"))
LLM_CONCURRENCY   = int(os.getenv("ICE_LLM_CONCURRENCY", "6"))
GEO_CONCURRENCY   = int(os.getenv("ICE_GEO_CONCURRENCY", "20"))
API_CONCURRENCY   = int(os.getenv("ICE_API_CONCURRENCY", "40"))

# Behavior toggles
# Default: mark all articles as processed (both successful and skipped)
# Set ICE_MARK_ONLY_ON_SUCCESS=1 to only mark successfully added articles
MARK_ONLY_ON_SUCCESS = os.getenv("ICE_MARK_ONLY_ON_SUCCESS", "0") != "0"

_fetch_sem = asyncio.Semaphore(FETCH_CONCURRENCY)
_llm_sem   = asyncio.Semaphore(LLM_CONCURRENCY)
_geo_sem   = asyncio.Semaphore(GEO_CONCURRENCY)
_api_sem   = asyncio.Semaphore(API_CONCURRENCY)

# Optional small memo for LLM analysis to avoid repeat calls within a run
# keyed by (url) and/or (text hash). Keeps memory bounded.
_ANALYSIS_MEMO: dict[str, dict] = {}
_ANALYSIS_MEMO_MAX = 10000

async def _process_one(rec: CSVRecord) -> tuple[bool, str]:
    """
    Returns (accepted, reason). Does NOT mark processed.
    """
    try:
        # 1) fetch text
        async with _fetch_sem:
            text = await _to_thread(fast_getText, rec.url)

        if not text:
            return (False, "no_text")

        # 2) one-shot LLM analysis (memoized)
        memo_key = rec.url  # stable
        analysis = _ANALYSIS_MEMO.get(memo_key)
        if analysis is None:
            async with _llm_sem:
                analysis = await _to_thread(analyze_article_once, text, rec.url)
            if analysis and len(_ANALYSIS_MEMO) < _ANALYSIS_MEMO_MAX:
                _ANALYSIS_MEMO[memo_key] = analysis

        if not analysis or not analysis.get("relevant"):
            return (False, "not_relevant")

        address_query = analysis.get("address_query")
        if not address_query:
            return (False, "no_address")

        # 3) geocode
        async with _geo_sem:
            coords = await _to_thread(fast_geoTag, address_query)

        if not coords:
            return (False, "no_coords")

        publisher = (analysis.get("publisher") or "").strip()
        if not publisher:
            publisher = _domain_publisher(rec.url)

        payload = {
            "title": rec.title,
            "date": rec.date.isoformat(),
            "url": rec.url,
            "text": text,
            "coordinates": {"lat": coords[0], "lon": coords[1]},
            "category": (analysis.get("category") or "unknown").strip().lower(),
            "publisher": publisher,
            "address": address_query,
            "parsed_location": analysis.get("parsed_location") or {
                "city": "", "state": "", "country": "", "address": "", "location_details": ""
            },
        }

        # 4) persist
        async with _api_sem:
            await _to_thread(addArticle, payload)

        # 5) append to local CSV cache for static fallback
        _append_to_local_csv(payload)

        return (True, "ok")
    except Exception as e:
        # Return error reason for debugging
        return (False, f"error: {str(e)[:50]}")

async def process_api_articles_concurrent(max_articles: int = 100) -> tuple[int, int]:
    """
    Concurrent version of process_api_articles:
    - fetch CSV from API
    - process N records concurrently with semaphores
    - mark processed in batches (best-effort)
    """
    accepted = 0
    ignored = 0
    to_mark_success: list[str] = []
    to_mark_any: list[str] = []

    # Get CSV from API (blocking)
    csv_data = await _to_thread(getUnprocessedArticles)
    if not (csv_data or "").strip():
        return (0, 0)

    records = _parse_csv_records(csv_data, max_articles)
    if not records:
        return (0, 0)

    # Worker wrapper
    lock = asyncio.Lock()

    async def worker(rec: CSVRecord):
        nonlocal accepted, ignored
        ok = False
        reason = "unknown"
        try:
            ok, reason = await _process_one(rec)
            async with lock:
                if ok:
                    accepted += 1
                    to_mark_success.append(rec.url)
                    print(f"✓ Added: {rec.title[:50]}")
                else:
                    ignored += 1
                    to_mark_any.append(rec.url)
                    print(f"✗ Skipped ({reason}): {rec.title[:50]}")
        except Exception as e:
            async with lock:
                ignored += 1
                to_mark_any.append(rec.url)
                print(f"✗ Error: {str(e)[:100]} - {rec.title[:50]}")

    await asyncio.gather(*(worker(r) for r in records))

    # Mark processed - combine all URLs (successful and skipped)
    all_processed_urls = list({*to_mark_success, *to_mark_any})
    try:
        if MARK_ONLY_ON_SUCCESS:
            # Only mark successfully persisted articles
            await _to_thread(markArticlesAsProcessed_batch, to_mark_success)
        else:
            # Mark everything we attempted (default behavior)
            await _to_thread(markArticlesAsProcessed_batch, all_processed_urls)
    except Exception as e:
        print(f"Warning: Failed to mark articles as processed: {e}")

    print(f"\nBatch complete: {accepted} added, {ignored} skipped")
    return (accepted, ignored)

def process_api_articles(max_articles: int = 100, **_kwargs) -> tuple[int, int]:
    """
    Drop-in replacement maintaining your old signature.
    Ignores injected toolchain kwargs (because this accelerated path is integrated).
    """
    return asyncio.run(process_api_articles_concurrent(max_articles=max_articles))

# -------------------------
# Continuous runner: keep your existing signature, but uses fast concurrent batches
# -------------------------

def run_continuous_processing(
    max_articles_per_batch: int = 250,
    wait_minutes: int = 1,
    **_kwargs,
) -> None:
    """
    Faster continuous mode:
    - processes bigger batches
    - minimal sleeping when backlog exists
    """
    from datetime import datetime

    print("=" * 80)
    print("ICE Agent - Continuous Processing Mode (FAST)")
    print("=" * 80)
    print(f"Batch size: {max_articles_per_batch}")
    print(f"Wait when empty: {wait_minutes} minutes")
    print(f"Mark only on success: {MARK_ONLY_ON_SUCCESS}")
    print(f"Concurrency fetch/llm/geo/api: {FETCH_CONCURRENCY}/{LLM_CONCURRENCY}/{GEO_CONCURRENCY}/{API_CONCURRENCY}")
    print(f"Started at: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 80)

    batch = 0
    total_a = 0
    total_i = 0

    while True:
        batch += 1
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        print(f"\n{'='*80}\nBATCH #{batch} - {now}\n{'='*80}")

        try:
            # Quick check
            csv_data = getUnprocessedArticles()
            if not (csv_data or "").strip():
                print(f"No unprocessed articles. Sleeping {wait_minutes} minutes...")
                time.sleep(wait_minutes * 60)
                continue

            # Process batch (concurrent)
            a, i = process_api_articles(max_articles=max_articles_per_batch)
            total_a += a
            total_i += i

            print(f"\nBatch results: {a} accepted, {i} ignored")
            print(f"Running totals: {total_a} accepted, {total_i} ignored (total {total_a + total_i})")
            if (total_a + total_i) > 0:
                print(f"Overall success rate: {100.0 * total_a / (total_a + total_i):.1f}%")

            # If backlog exists, continue immediately.
            print("Continuing immediately...")

        except KeyboardInterrupt:
            print("\nStopped by user.")
            print(f"Final totals: {total_a} accepted, {total_i} ignored (total {total_a + total_i})")
            break
        except Exception as e:
            print(f"Error in batch: {e}")
            print(f"Sleeping {wait_minutes} minutes before retry...")
            time.sleep(wait_minutes * 60)


async def process_csv_file_concurrent(
    csv_path: str,
    max_articles: int = 5000,
    skip_urls: Optional[set] = None,
) -> tuple[int, int]:
    """
    Read local CSV (title,description,date,url) and process concurrently.
    skip_urls: set of URLs already in the database — will be skipped silently.
    """
    import csv as _csv

    skip_urls = skip_urls or set()
    accepted = 0
    ignored = 0
    to_mark_success: list[str] = []

    try:
        with open(csv_path, "r", encoding="utf-8") as fh:
            reader = _csv.DictReader(fh)
            rows = [r for r in reader if r.get("url") and r["url"] not in skip_urls]
    except Exception as e:
        print(f"Failed to read CSV: {e}")
        return (0, 0)

    records = _parse_csv_records(
        "title,description,date,url\n" + "\n".join(
            f'{r.get("title","")},{r.get("description","")},{r.get("date","")},{r.get("url","")}'
            for r in rows[:max_articles]
        ),
        max_articles,
    )
    # Re-parse properly with quoting preserved
    try:
        import io as _io
        with open(csv_path, "r", encoding="utf-8") as fh:
            content = fh.read()
        records = _parse_csv_records(content, max_articles)
        if skip_urls:
            records = [r for r in records if r.url not in skip_urls]
    except Exception as e:
        print(f"CSV re-parse failed: {e}")
        return (0, 0)

    if not records:
        return (0, 0)

    lock = asyncio.Lock()

    async def worker(rec: CSVRecord):
        nonlocal accepted, ignored
        try:
            ok, reason = await _process_one(rec)
            async with lock:
                if ok:
                    accepted += 1
                    to_mark_success.append(rec.url)
                    print(f"✓ Added: {rec.title[:60]}")
                else:
                    ignored += 1
                    print(f"✗ Skipped ({reason}): {rec.title[:60]}")
        except Exception as e:
            async with lock:
                ignored += 1
                print(f"✗ Error: {str(e)[:80]} - {rec.title[:60]}")

    await asyncio.gather(*(worker(r) for r in records))
    print(f"\nCSV batch complete: {accepted} added, {ignored} skipped")
    return (accepted, ignored)


def run_csv_processing(
    csv_path: str = "data/mediacloud_articles.csv",
    max_articles: int = 5000,
    batch_size: int = 500,
) -> None:
    """
    Process a local CSV file in batches, printing running totals.
    Reads the entire CSV and processes batch_size articles at a time.
    """
    import csv as _csv
    from datetime import datetime

    print("=" * 80)
    print("ICE Agent - Local CSV Processing Mode")
    print("=" * 80)
    print(f"CSV: {csv_path}")
    print(f"Batch size: {batch_size}")
    print(f"Max articles: {max_articles}")
    print(f"Started at: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 80)

    # Load all rows
    try:
        with open(csv_path, "r", encoding="utf-8") as fh:
            reader = _csv.DictReader(fh)
            all_rows = [r for r in reader if r.get("url")]
    except Exception as e:
        print(f"Failed to read {csv_path}: {e}")
        return

    all_rows = all_rows[:max_articles]
    total = len(all_rows)
    print(f"Loaded {total:,} rows from CSV")

    total_a = 0
    total_i = 0
    batch_num = 0

    for start in range(0, total, batch_size):
        batch_num += 1
        chunk = all_rows[start:start + batch_size]
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        print(f"\n{'='*80}\nBATCH #{batch_num} [{start+1}–{start+len(chunk)}/{total}] - {now}\n{'='*80}")

        # Build mini CSV blob from chunk
        import io as _io
        import csv as _csv2
        buf = _io.StringIO()
        writer = _csv2.DictWriter(buf, fieldnames=["title", "description", "date", "url"], extrasaction="ignore")
        writer.writeheader()
        writer.writerows(chunk)
        blob = buf.getvalue()

        records = _parse_csv_records(blob, batch_size)
        if not records:
            continue

        try:
            a, i = asyncio.run(process_api_articles_concurrent.__wrapped__(records) if hasattr(process_api_articles_concurrent, '__wrapped__') else _run_records(records))
        except Exception as e:
            print(f"Batch error: {e}")
            continue

        total_a += a
        total_i += i
        print(f"Running totals: {total_a} accepted, {total_i} ignored ({total_a+total_i} total)")
        if (total_a + total_i) > 0:
            print(f"Overall success rate: {100.0*total_a/(total_a+total_i):.1f}%")


async def _run_records(records: list) -> tuple[int, int]:
    """Run _process_one on a list of records concurrently, no mark-as-processed."""
    accepted = 0
    ignored = 0
    lock = asyncio.Lock()

    async def worker(rec):
        nonlocal accepted, ignored
        try:
            ok, reason = await _process_one(rec)
            async with lock:
                if ok:
                    accepted += 1
                    print(f"✓ Added: {rec.title[:60]}")
                else:
                    ignored += 1
                    print(f"✗ Skipped ({reason}): {rec.title[:60]}")
        except Exception as e:
            async with lock:
                ignored += 1
                print(f"✗ Error: {str(e)[:80]}")

    await asyncio.gather(*(worker(r) for r in records))
    return (accepted, ignored)


if __name__ == "__main__":
    import sys
    mode = sys.argv[1] if len(sys.argv) > 1 else "api"

    if mode == "csv":
        csv_path = sys.argv[2] if len(sys.argv) > 2 else "data/mediacloud_articles.csv"
        max_articles = int(sys.argv[3]) if len(sys.argv) > 3 else 10000
        run_csv_processing(csv_path=csv_path, max_articles=max_articles, batch_size=500)
    else:
        # Run continuous API processing (default)
        try:
            run_continuous_processing(
                max_articles_per_batch=250,
                wait_minutes=1,
            )
        except Exception as e:
            print(f"Fatal error: {e}")
            import traceback
            traceback.print_exc()
            raise

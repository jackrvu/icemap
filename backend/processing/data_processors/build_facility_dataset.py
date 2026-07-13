#!/usr/bin/env python3
"""
Build the detention facility dataset served by the frontend.

Replaces the missing_facilities.py + summary_generator.py + compress_facilities_data.py
chain with a single pipeline that is:

  - Complete: uses ICE's official facility-level detention statistics
    (data/FY26_detentionStats.xlsx, "Facilities FY26" sheet) as the canonical
    facility list, so every dedicated ICE facility appears — not just the ones
    that happened to fuzzy-match a scraped list.
  - Accurate: detention centers from ODO inspection reports are located using
    the city/state embedded in the inspection PDF URLs (ground truth), and all
    name matches are rejected unless the states agree.
  - Objective: pins and metrics are driven by counts taken directly from the
    inspection reports (total deficiencies, deficiencies per standard) and by
    official ICE statistics (average daily population, guaranteed minimum beds,
    average length of stay). No LLM-invented quality scores.
  - Transparent: every record carries provenance (which sources it came from,
    how the name match was made and validated, geocoding precision).

Usage (from the project root):
    PYTHONUNBUFFERED=1 python3 backend/processing/data_processors/build_facility_dataset.py
        [--skip-geocode]    # only use cached geocodes; never call Google
        [--skip-summaries]  # skip DeepSeek summary generation (reuse cached)

Inputs:
    data/FY26_detentionStats.xlsx                    official ICE statistics
    data/distilled_data/merged_by_center.jsonl       parsed ODO inspection reports
    data/all_facilities_with_coordinates.csv         scraped ice.gov directory (fallback coords)
    data/facility_geocode_cache.json                 geocode cache (created/updated)
    data/facility_summaries_cache.json               AI summary cache (created/updated)

Outputs:
    data/distilled_data/detention_facilities.json    full dataset (readable)
    frontend/public/detention_facilities.json.gz     gzipped copy served by the app
"""

import argparse
import csv
import gzip
import json
import os
import re
import sys
import time
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timezone
from difflib import SequenceMatcher

# ---------------------------------------------------------------------------
# Paths (run from project root)
# ---------------------------------------------------------------------------
FY26_XLSX = "data/FY26_detentionStats.xlsx"
ODO_JSONL = "data/distilled_data/merged_by_center.jsonl"
SCRAPED_CSV = "data/all_facilities_with_coordinates.csv"
GEOCODE_CACHE = "data/facility_geocode_cache.json"
SUMMARY_CACHE = "data/facility_summaries_cache.json"
OUT_JSON = "data/distilled_data/detention_facilities.json"
OUT_GZ = "frontend/public/detention_facilities.json.gz"

DATASET_VERSION = 2

VALID_STATES = set(
    "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS "
    "MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV "
    "WI WY DC PR GU VI MP".split()
)

AOR_NAMES = {
    "ATL": "Atlanta", "BAL": "Baltimore", "BOS": "Boston", "BUF": "Buffalo",
    "CHI": "Chicago", "DAL": "Dallas", "DEN": "Denver", "DET": "Detroit",
    "ELP": "El Paso", "HLG": "Harlingen", "HOU": "Houston",
    "LOS": "Los Angeles", "MIA": "Miami", "NEW": "Newark",
    "NOL": "New Orleans", "NYC": "New York City", "PHI": "Philadelphia",
    "PHO": "Phoenix", "SLC": "Salt Lake City", "SNA": "San Antonio",
    "SND": "San Diego", "SFR": "San Francisco", "SEA": "Seattle",
    "SPM": "St. Paul", "MSP": "St. Paul", "WAS": "Washington",
}

FACILITY_TYPE_LABELS = {
    "SPC": "ICE Service Processing Center (ICE-owned)",
    "CDF": "Contract Detention Facility",
    "DIGSA": "Dedicated Intergovernmental Service Agreement facility",
    "IGSA": "Intergovernmental Service Agreement facility (shared with other agencies)",
    "USMS IGA": "U.S. Marshals Service Intergovernmental Agreement facility",
    "USMS CDF": "U.S. Marshals Service Contract Detention Facility",
    "USMS": "U.S. Marshals Service facility",
    "BOP": "Federal Bureau of Prisons facility",
    "FRC": "Family Residential Center",
    "FAMILY": "Family Residential Center",
    "STAGING": "Staging facility (short-term transfers)",
    "STATE": "State-operated facility",
    "DOD": "Department of Defense facility",
}

# ERO field office -> states it covers. Used only as a *soft* validation
# signal when no state could be read from the inspection report URLs.
ERO_FIELD_OFFICE_STATES = {
    "atlanta": {"GA"}, "baltimore": {"MD"},
    "boston": {"MA", "ME", "NH", "RI", "VT", "CT"},
    "buffalo": {"NY"}, "chicago": {"IL", "IN", "WI", "KY", "KS", "MO"},
    "dallas": {"TX", "OK"}, "denver": {"CO", "WY"},
    "detroit": {"MI", "OH"}, "el paso": {"TX", "NM"},
    "harlingen": {"TX"}, "houston": {"TX"}, "los angeles": {"CA"},
    "miami": {"FL"}, "newark": {"NJ"},
    "new orleans": {"LA", "MS", "AL", "AR", "TN"}, "new york": {"NY"},
    "philadelphia": {"PA", "WV", "DE"}, "phoenix": {"AZ"},
    "st. paul": {"MN", "ND", "SD", "IA", "NE"},
    "saint paul": {"MN", "ND", "SD", "IA", "NE"},
    "minneapolis": {"MN", "ND", "SD", "IA", "NE"},
    "salt lake city": {"UT", "ID", "MT", "NV"},
    "san antonio": {"TX"}, "san diego": {"CA"},
    "san francisco": {"CA", "HI", "GU", "MP"},
    "seattle": {"WA", "OR", "AK"}, "washington": {"DC", "VA"},
}

# The per-standard deficiency-count columns in the parsed ODO reports.
STANDARD_FIELDS = [
    "Environmental Health and Safety", "Admission and Release",
    "Custody Classification", "System Facility", "Security and Control",
    "Funds and Personal Property", "Post Orders", "Searches of Detainees",
    "Use of Force and Restraints", "Special Management Units",
    "Staff-Detainee Communication",
    "Sexual Abuse and Assault Prevention and Intervention", "Food Service",
    "Hunger Strikes", "Medical Care", "Personal Hygiene Significant",
    "Self-Harm and Suicide Prevention and Intervention",
    "Correspondence and Other Mail", "Religious Practices",
    "Telephone Access", "Voluntary Work Program", "Grievance System",
    "Law Libraries and Legal Materials", "Detention Files Detainee Transfers",
]

NARRATIVE_FIELDS = ["SAFETY", "SECURITY", "CARE", "ACTIVITIES", "JUSTICE", "CONCLUSION"]

MONTHS = {m.lower(): i + 1 for i, m in enumerate([
    "January", "February", "March", "April", "May", "June", "July",
    "August", "September", "October", "November", "December"])}
MONTHS.update({m[:3].lower(): v for m, v in list(MONTHS.items())})

GENERIC_NAME_WORDS = {
    "detention", "center", "centre", "facility", "correctional",
    "processing", "jail", "prison", "complex", "ice", "service", "the",
    "adult", "det", "ctr", "fac", "cnty", "annex", "and", "of", "s", "co",
    "sheriff", "sheriffs", "office", "dept", "department", "regional",
    "corrections", "corr", "ipc",
    "processsing",  # ICE's own typo in the FY26 statistics ("Processsing")
}

# Facilities that ICE renamed: ODO reports use the old name, the FY26
# statistics use the new one. Keyed by (normalized core name, state).
KNOWN_RENAMES = {
    ("lasalle", "LA"): "CENTRAL LOUISIANA ICE PROCESSING CENTER (CLIPC)",
    ("lasalle jena", "LA"): "CENTRAL LOUISIANA ICE PROCESSING CENTER (CLIPC)",
    # ODO inspects the Folkston main facility and its annex together; FY26
    # statistics list them separately. Attach the history to the main site.
    ("folkston", "GA"): "FOLKSTON MAIN IPC",
    # Tacoma ICE Processing Center = Northwest ICE Processing Center
    # (formerly Northwest Detention Center).
    ("tacoma", "WA"): "NORTHWEST ICE PROCESSSING CENTER",
    ("tacoma northwest", "WA"): "NORTHWEST ICE PROCESSSING CENTER",
}


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------
def to_int(v):
    try:
        return int(str(v).strip())
    except (ValueError, TypeError):
        return None


def to_float(v):
    try:
        return float(v)
    except (ValueError, TypeError):
        return None


def parse_inspection_date(s):
    """Parse dates like 'May 13, 2025', 'September 24-26, 2024',
    'January 30-February 1, 2024'. Returns ISO date string or None."""
    if not s or str(s).strip().upper() in ("N/A", ""):
        return None
    s = str(s)
    year_m = re.search(r"\b(19|20)\d{2}\b", s)
    if not year_m:
        return None
    year = int(year_m.group(0))
    month, day = 1, 1
    m = re.search(r"([A-Za-z]{3,9})\.?\s*(\d{1,2})?", s)
    if m and m.group(1).lower() in MONTHS:
        month = MONTHS[m.group(1).lower()]
        if m.group(2):
            day = min(int(m.group(2)), 28) if int(m.group(2)) > 31 else int(m.group(2))
    try:
        return date(year, month, day).isoformat()
    except ValueError:
        return date(year, month, 1).isoformat()


def norm_core(name):
    """Normalize a facility name to its distinguishing core tokens."""
    n = re.sub(r"[^a-z0-9 ]", " ", name.lower())
    tokens = [t for t in n.split() if t not in GENERIC_NAME_WORDS]
    return " ".join(tokens)


def title_case_name(name):
    """ADAMS COUNTY CORRECTIONAL CENTER -> Adams County Correctional Center,
    keeping known acronyms uppercase."""
    keep_upper = {"ICE", "USMS", "USP", "FCI", "FDC", "MDC", "SPC", "IPC", "II", "III", "US", "U.S."}
    small = {"of", "and", "the", "at", "for"}
    out = []
    for i, w in enumerate(name.split()):
        wu = w.upper().strip(",.")
        if wu in keep_upper:
            out.append(wu + (w[len(wu):] if len(w) > len(wu) else ""))
        elif w.lower() in small and i > 0:
            out.append(w.lower())
        else:
            out.append(w.capitalize())
    return " ".join(out)


def slugify(s):
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", s.lower())).strip("-")


def split_camel(s):
    """LaVilla -> La Villa, BowlingGreen -> Bowling Green."""
    return re.sub(r"(?<=[a-z])(?=[A-Z])", " ", s)


# ---------------------------------------------------------------------------
# 1. Official ICE FY26 facility statistics
# ---------------------------------------------------------------------------
def load_fy26(path):
    import openpyxl
    wb = openpyxl.load_workbook(path, read_only=True)
    ws = wb["Facilities FY26"]
    rows = list(ws.iter_rows(values_only=True))

    # Capture ICE's own caveat text from the sheet header for transparency.
    notes = [str(r[0]).strip() for r in rows[:8]
             if r[0] and len(str(r[0]).strip()) > 20]

    header = [str(c).strip() if c else "" for c in rows[9]]
    col = {name: i for i, name in enumerate(header)}
    facilities = []
    for r in rows[10:]:
        if not r[0]:
            continue
        adp_levels = [to_float(r[col[c]]) for c in ("Level A", "Level B", "Level C", "Level D")]
        adp = sum(v for v in adp_levels if v) if any(adp_levels) else None
        last_date = r[col["Last Inspection End Date"]]
        if isinstance(last_date, datetime):
            last_date = last_date.date().isoformat()
        elif last_date:
            last_date = str(last_date)[:10]
        facilities.append({
            "name": str(r[col["Name"]]).strip(),
            "address": str(r[col["Address"]] or "").strip(),
            "city": str(r[col["City"]] or "").strip(),
            "state": str(r[col["State"]] or "").strip().upper(),
            "zip": str(r[col["Zip"]] or "").strip(),
            "aor": str(r[col["AOR"]] or "").strip(),
            "type": str(r[col["Type Detailed"]] or "").strip(),
            "gender": str(r[col["Male/Female"]] or "").strip(),
            "alos_days": to_float(r[col["FY26 ALOS"]]),
            "adp": round(adp, 1) if adp is not None else None,
            "guaranteed_minimum_beds": to_int(r[col["Guaranteed Minimum"]]),
            "last_inspection": {
                "type": str(r[col["Last Inspection Type"]] or "").strip() or None,
                "end_date": last_date or None,
                "standard": str(r[col["Last Inspection Standard"]] or "").strip() or None,
                "rating": str(r[col["Last Final Rating"]] or "").strip() or None,
            },
        })
    return facilities, notes


# ---------------------------------------------------------------------------
# 2. ODO inspection records, with URL-derived locations and deduplication
# ---------------------------------------------------------------------------
URL_CAMEL_LOC = re.compile(r"([A-Z][a-z]+(?:[A-Z][a-z]+)*)([A-Z]{2})(?=[_\-.])")
URL_DASH_LOC = re.compile(r"-([a-z]+)-([a-z]{2})-")
# TitleCase state followed by a month/date, e.g. "...FortPayneAlJune15-17.pdf"
URL_TITLE_LOC = re.compile(
    r"([A-Z][a-z]+(?:[A-Z][a-z]+)*?)([A-Z][a-z])"
    r"(?=(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|\d))")


def clean_url_city(camel_prefix):
    """The camel-case prefix before the state may include the facility name
    ('ChristianCoJailOzark'); keep only the trailing city tokens (after
    'County' and generic facility words)."""
    tokens = split_camel(camel_prefix).split()
    if "County" in tokens:
        tokens = tokens[tokens.index("County") + 1:]
    tokens = [t for t in tokens if t.lower() not in GENERIC_NAME_WORDS]
    return " ".join(tokens[-2:])


def location_from_urls(urls):
    """Extract the (city, state) most consistently embedded in the
    inspection PDF filenames. Returns (city, state, n_votes) or (None, None, 0)."""
    votes = Counter()
    for u in urls:
        fname = u.rsplit("/", 1)[-1]
        for m in URL_CAMEL_LOC.finditer(fname):
            city, st = clean_url_city(m.group(1)), m.group(2)
            if st in VALID_STATES and city and city.lower() not in MONTHS:
                votes[(city, st)] += 1
        for m in URL_DASH_LOC.finditer(fname.lower()):
            city, st = m.group(1).title(), m.group(2).upper()
            if st in VALID_STATES and city.lower() not in MONTHS:
                votes[(city, st)] += 1
        for m in URL_TITLE_LOC.finditer(fname):
            city, st = clean_url_city(m.group(1)), m.group(2).upper()
            if st in VALID_STATES and city and city.lower() not in MONTHS:
                votes[(city, st)] += 1
    if not votes:
        return None, None, 0
    (city, st), n = votes.most_common(1)[0]
    return city, st, n


def field_office_states(inspections):
    states = set()
    for i in inspections:
        fo = str(i.get("Field Office", "")).lower().replace("ero", "").strip()
        for key, sts in ERO_FIELD_OFFICE_STATES.items():
            if key in fo:
                states |= sts
    return states


def canon_key(name):
    """Order-independent name key for deduplication; 'county' is ignored so
    'Contra Costa County West ...' and 'Contra Costa West ...' unify."""
    tokens = set(norm_core(name).split()) - {"county"}
    return " ".join(sorted(tokens))


def load_odo(path):
    """Load ODO centers, extract locations, and merge duplicate centers
    (same canonical name + same state)."""
    raw = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            if line.strip():
                raw.append(json.loads(line))

    merged = {}
    for rec in raw:
        name = rec["Detention Center"].strip()
        inspections = rec.get("Inspections", [])
        urls = [i.get("URL", "") for i in inspections if i.get("URL")]
        city, st, votes = location_from_urls(urls)
        key = (canon_key(name), st)
        if key not in merged:
            merged[key] = {
                "names": [], "inspections": {}, "url_city": city,
                "url_state": st, "url_votes": votes,
                "fo_states": set(),
            }
        m = merged[key]
        m["names"].append(name)
        m["fo_states"] |= field_office_states(inspections)
        for insp in inspections:
            u = insp.get("URL") or f"no-url::{name}::{insp.get('Inspection Date')}"
            prev = m["inspections"].get(u)
            # Keep the copy with more real (non-N/A) content.
            def richness(i):
                return sum(1 for k, v in i.items() if v not in (None, "", "N/A"))
            if prev is None or richness(insp) > richness(prev):
                m["inspections"][u] = insp

    # Fold state-unknown groups into a state-known sibling with the same
    # canonical name, when that sibling is unique.
    states_by_canon = defaultdict(list)
    for (canon, st) in merged:
        states_by_canon[canon].append(st)
    for canon, sts in states_by_canon.items():
        known = [s for s in sts if s]
        if None in sts and len(known) == 1:
            src, dst = merged.pop((canon, None)), merged[(canon, known[0])]
            dst["names"].extend(src["names"])
            dst["fo_states"] |= src["fo_states"]
            for u, insp in src["inspections"].items():
                dst["inspections"].setdefault(u, insp)

    centers = []
    for (canon, st), m in merged.items():
        insp = list(m["inspections"].values())
        for i in insp:
            i["_date_iso"] = parse_inspection_date(i.get("Inspection Date"))
        insp.sort(key=lambda i: i["_date_iso"] or "0000", reverse=True)
        # Prefer the prettiest (mixed-case, longest) name variant for display.
        display = sorted(m["names"], key=lambda n: (n.isupper(), -len(n)))[0]
        centers.append({
            "core": norm_core(display), "display_name": title_case_name(display) if display.isupper() else display,
            "aliases": sorted(set(m["names"])),
            "city": m["url_city"], "state": m["url_state"],
            "state_evidence": "inspection_url" if m["url_state"] else (
                "field_office" if m["fo_states"] else None),
            "fo_states": m["fo_states"],
            "inspections": insp,
        })
    return centers, len(raw)


# ---------------------------------------------------------------------------
# 3. State-validated matching of ODO centers to the FY26 facility list
# ---------------------------------------------------------------------------
def match_center(center, fy26_by_core, fy26_list):
    """Return (fy26_facility, method, score) or (None, None, 0)."""
    core = center["core"]
    st = center["state"]
    city = (center.get("city") or "").lower()

    # Known facility renames (old ODO name -> current official name)
    renamed_to = KNOWN_RENAMES.get((core, st))
    if renamed_to:
        for fac in fy26_list:
            if fac["name"] == renamed_to:
                return fac, "known_rename", 1.0

    def state_ok(fac):
        if not fac["state"]:
            return None  # a few FY26 rows have a blank state cell
        if st:
            return fac["state"] == st
        if center["fo_states"]:
            return fac["state"] in center["fo_states"]
        return None  # unknown

    # Exact core-name match
    candidates = fy26_by_core.get(core, [])
    for fac in candidates:
        if state_ok(fac):
            return fac, "name+state", 1.0
    for fac in candidates:
        if state_ok(fac) is None:
            if city and fac["city"] and fac["city"].lower() == city:
                return fac, "name+city", 0.95
            if len(candidates) == 1:
                return fac, "name_only_unique", 0.9

    # Token-subset match (e.g. "baker county" vs "baker county sheriff dept").
    # Only accepted when unambiguous: a single in-state candidate, with city
    # agreement used to break ties (e.g. "Louisiana ICE Processing" at Angola
    # must not absorb "South Louisiana ICE Processing Center" at Basile).
    core_tokens = set(core.split())
    if core_tokens:
        subset_cands = [fac for fac in fy26_list
                        if set(fac["_core"].split())
                        and (core_tokens <= set(fac["_core"].split())
                             or set(fac["_core"].split()) <= core_tokens)
                        and state_ok(fac)]
        if len(subset_cands) > 1 and city:
            by_city = [f for f in subset_cands if f["city"].lower() == city]
            if by_city:
                subset_cands = by_city
        if len(subset_cands) == 1:
            fac = subset_cands[0]
            if city and fac["city"] and fac["city"].lower() != city and core_tokens < set(fac["_core"].split()):
                pass  # strict-subset match with contradicting city: too risky
            else:
                return fac, "token_subset+state", 0.95

    # Fuzzy match, only ever accepted with an agreeing state
    best, best_score = None, 0.0
    for fac in fy26_list:
        if not state_ok(fac):
            continue
        s = SequenceMatcher(None, core, fac["_core"]).ratio()
        if s > best_score:
            best, best_score = fac, s
    if best is not None and best_score >= 0.85:
        return best, "fuzzy+state", round(best_score, 3)
    return None, None, 0.0


def match_scraped(center, scraped):
    """Fallback coordinates from the scraped ice.gov directory, state-gated."""
    st = center["state"]
    for row in scraped:
        if norm_core(row["name"]) == center["core"]:
            if (st and row["state"] == st) or (not st and center["fo_states"] and row["state"] in center["fo_states"]) or (not st and not center["fo_states"]):
                return row
    return None


# ---------------------------------------------------------------------------
# 4. Geocoding (Google, cached, state-verified)
# ---------------------------------------------------------------------------
class Geocoder:
    def __init__(self, cache_path, allow_network):
        self.cache_path = cache_path
        self.allow_network = allow_network
        self.cache = {}
        if os.path.exists(cache_path):
            with open(cache_path, encoding="utf-8") as f:
                self.cache = json.load(f)
        self._client = None
        self.calls = 0

    def _gmaps(self):
        if self._client is None:
            import googlemaps
            from dotenv import load_dotenv
            load_dotenv()
            key = os.getenv("GOOGLE_PLACES_API_KEY")
            if not key:
                raise RuntimeError("GOOGLE_PLACES_API_KEY not set")
            self._client = googlemaps.Client(key=key)
        return self._client

    def save(self):
        with open(self.cache_path, "w", encoding="utf-8") as f:
            json.dump(self.cache, f, indent=1, sort_keys=True)

    def geocode(self, query, expect_state):
        """Returns dict {lat, lng, formatted, state_verified} or None."""
        if query in self.cache:
            return self.cache[query]
        if not self.allow_network:
            return None
        result = None
        try:
            time.sleep(0.15)
            self.calls += 1
            geo = self._gmaps().geocode(query)
            if geo:
                loc = geo[0]["geometry"]["location"]
                comps = geo[0].get("address_components", [])
                got_state = next((c["short_name"] for c in comps
                                  if "administrative_area_level_1" in c["types"]), None)
                result = {
                    "lat": loc["lat"], "lng": loc["lng"],
                    "formatted": geo[0].get("formatted_address", ""),
                    "state_verified": (got_state == expect_state) if expect_state else None,
                }
        except Exception as e:
            print(f"  geocode error for {query!r}: {e}")
            return None  # transient failure: do not cache
        self.cache[query] = result  # cache hits and definitive misses only
        return result


def locate_facility(geocoder, name, address, city, state, zipc):
    """Try address -> facility name -> city, returning
    (lat, lng, precision, source) or Nones."""
    attempts = []
    if address and city:
        attempts.append((f"{address}, {city}, {state} {zipc}".strip() + ", USA", "address"))
    if name and city:
        attempts.append((f"{name}, {city}, {state}, USA", "facility_name"))
    if city:
        attempts.append((f"{city}, {state}, USA", "city"))
    for query, precision in attempts:
        r = geocoder.geocode(query, state)
        if r and (r["state_verified"] is not False):
            return r["lat"], r["lng"], precision, "google_geocode"
    return None, None, None, None


# ---------------------------------------------------------------------------
# 5. Objective ODO metrics
# ---------------------------------------------------------------------------
def is_substantive(insp):
    """A substantive inspection has actual findings data: numeric standard
    counts or narrative findings — not an all-N/A self-inspection stub."""
    if any(to_int(insp.get(f)) is not None for f in STANDARD_FIELDS):
        return True
    return any(insp.get(f) not in (None, "", "N/A") for f in NARRATIVE_FIELDS)


def odo_metrics(inspections):
    if not inspections:
        return None
    listing = []
    for i in inspections:
        listing.append({
            "type": i.get("Inspection Type") or None,
            "date": i.get("Inspection Date") or None,
            "date_iso": i.get("_date_iso"),
            "url": (i.get("URL") or None) if not str(i.get("URL", "")).startswith("no-url::") else None,
            "total_deficiencies": to_int(i.get("Total Deficiencies")),
            "substantive": is_substantive(i),
        })
    latest_sub = next((i for i in inspections if is_substantive(i)), None)
    latest_block = None
    if latest_sub is not None:
        std = {f: to_int(latest_sub.get(f)) for f in STANDARD_FIELDS}
        std = {k: v for k, v in std.items() if v}
        findings = {f: latest_sub.get(f) for f in NARRATIVE_FIELDS
                    if latest_sub.get(f) not in (None, "", "N/A")}
        latest_block = {
            "type": latest_sub.get("Inspection Type"),
            "date": latest_sub.get("Inspection Date"),
            "date_iso": latest_sub.get("_date_iso"),
            "url": latest_sub.get("URL"),
            "total_deficiencies": to_int(latest_sub.get("Total Deficiencies")),
            "standard_deficiencies": std,
            "interviews_conducted": to_int(latest_sub.get("Interviews Conducted")),
            "findings": findings,
        }
    return {
        "inspection_count": len(inspections),
        "latest_inspection_date": inspections[0].get("_date_iso"),
        "latest_substantive": latest_block,
        "inspections": listing,
    }


# ---------------------------------------------------------------------------
# 6. Neutral AI summaries (DeepSeek), cached
# ---------------------------------------------------------------------------
SUMMARY_SYSTEM = (
    "You summarize U.S. government detention facility inspection records. "
    "Write in a strictly neutral, factual tone, like an encyclopedia. "
    "Use ONLY the data provided. Never speculate, editorialize, praise, or "
    "criticize. Never infer anything from missing data. Do not assign "
    "ratings or scores."
)

SUMMARY_PROMPT = (
    "Summarize the following ICE Office of Detention Oversight inspection "
    "history for {name} in 2-4 sentences. Cover: how many inspections and of "
    "what kinds, the most recent substantive inspection's date and number of "
    "deficiencies (naming the standards with the most deficiencies, if any), "
    "and how the deficiency count changed across inspections if there is more "
    "than one. Plain prose, no markdown, no bullet points.\n\n"
    "Inspection data (JSON):\n{data}"
)


def summary_input(fac):
    odo = fac["odo"]
    rows = [{
        "type": i["type"], "date": i["date"],
        "total_deficiencies": i["total_deficiencies"],
        "substantive": i["substantive"],
    } for i in odo["inspections"]]
    latest = odo["latest_substantive"]
    return json.dumps({
        "inspections": rows,
        "latest_substantive": {
            "date": latest["date"], "type": latest["type"],
            "total_deficiencies": latest["total_deficiencies"],
            "standard_deficiencies": latest["standard_deficiencies"],
            "conclusion": (latest["findings"].get("CONCLUSION") or "")[:1500],
        },
    }, ensure_ascii=False)


def generate_summaries(facilities, cache_path, skip):
    cache = {}
    if os.path.exists(cache_path):
        with open(cache_path, encoding="utf-8") as f:
            cache = json.load(f)

    todo = []
    for fac in facilities:
        if not fac.get("odo") or not fac["odo"]["latest_substantive"]:
            continue
        key = fac["id"]
        if key in cache:
            fac["ai_summary"] = cache[key]
        elif not skip:
            todo.append(fac)

    if not todo:
        return 0

    from dotenv import load_dotenv
    from openai import OpenAI
    load_dotenv()
    key = os.getenv("DEEPSEEK_API_KEY")
    if not key:
        print("DEEPSEEK_API_KEY not set; skipping summary generation")
        return 0
    client = OpenAI(api_key=key, base_url="https://api.deepseek.com")

    def one(fac):
        resp = client.chat.completions.create(
            model="deepseek-chat",
            temperature=0.0,
            max_tokens=400,
            messages=[
                {"role": "system", "content": SUMMARY_SYSTEM},
                {"role": "user", "content": SUMMARY_PROMPT.format(
                    name=fac["name"], data=summary_input(fac))},
            ],
        )
        text = resp.choices[0].message.content.strip()
        return fac, {
            "text": text,
            "model": "deepseek-chat",
            "generated_date": date.today().isoformat(),
        }

    done = 0
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(one, fac): fac for fac in todo}
        for fut in as_completed(futures):
            fac = futures[fut]
            try:
                fac2, summary = fut.result()
                fac2["ai_summary"] = summary
                cache[fac2["id"]] = summary
                done += 1
                if done % 20 == 0:
                    print(f"  summaries: {done}/{len(todo)}")
                    with open(cache_path, "w", encoding="utf-8") as f:
                        json.dump(cache, f, ensure_ascii=False, indent=1)
            except Exception as e:
                print(f"  summary failed for {fac['name']}: {e}")

    with open(cache_path, "w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False, indent=1)
    return done


# ---------------------------------------------------------------------------
# Main assembly
# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--skip-geocode", action="store_true")
    ap.add_argument("--skip-summaries", action="store_true")
    args = ap.parse_args()

    print("Loading ICE FY26 facility statistics...")
    fy26, ice_notes = load_fy26(FY26_XLSX)
    for fac in fy26:
        fac["_core"] = norm_core(fac["name"])
    fy26_by_core = {}
    for fac in fy26:
        fy26_by_core.setdefault(fac["_core"], []).append(fac)
    print(f"  {len(fy26)} facilities in official statistics")

    print("Loading ODO inspection records...")
    centers, raw_count = load_odo(ODO_JSONL)
    with_state = sum(1 for c in centers if c["state"])
    print(f"  {raw_count} raw center records -> {len(centers)} after dedup; "
          f"{with_state} with URL-derived state")

    scraped = []
    with open(SCRAPED_CSV, encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if row.get("Latitude") and row.get("Longitude"):
                scraped.append({
                    "name": row["name"].strip(),
                    "street": row.get("street", "").strip(),
                    "city": row.get("city", "").strip(),
                    "state": row.get("state", "").strip().upper(),
                    "zip": row.get("zipcode", "").strip(),
                    "lat": float(row["Latitude"]), "lng": float(row["Longitude"]),
                })

    geocoder = Geocoder(GEOCODE_CACHE, allow_network=not args.skip_geocode)

    print("Matching ODO centers to official facility list (state-validated)...")
    facilities = {}   # id -> record
    matched_fy26_names = set()
    unmatched_centers = []

    for center in centers:
        fac, method, score = match_center(center, fy26_by_core, fy26)
        odo = odo_metrics(center["inspections"])
        if fac is not None:
            matched_fy26_names.add(fac["name"])
            if not fac["state"] and center["state"]:
                fac = {**fac, "state": center["state"]}  # blank FY26 state cell
            fid = slugify(f"{fac['name']}-{fac['state']}")
            name = center["display_name"] if not center["display_name"].isupper() else title_case_name(fac["name"])
            lat, lng, precision, source = locate_facility(
                geocoder, fac["name"], fac["address"], fac["city"], fac["state"], fac["zip"])
            rec = build_record(
                fid, name, center["aliases"], fac, lat, lng, precision, source,
                odo, {
                    "in_fy26_stats": True, "odo_matched": True,
                    "match_method": method, "match_score": score,
                    "matched_fy26_name": fac["name"],
                    "state_evidence": center["state_evidence"],
                })
            merge_into(facilities, fid, rec)
        else:
            unmatched_centers.append((center, odo))

    print(f"  {len(matched_fy26_names)} official facilities matched to ODO records")
    print(f"  {len(unmatched_centers)} ODO centers not in official FY26 list")

    # Official facilities with no ODO records still appear (completeness).
    for fac in fy26:
        if fac["name"] in matched_fy26_names:
            continue
        fid = slugify(f"{fac['name']}-{fac['state']}")
        lat, lng, precision, source = locate_facility(
            geocoder, fac["name"], fac["address"], fac["city"], fac["state"], fac["zip"])
        rec = build_record(
            fid, title_case_name(fac["name"]), [], fac, lat, lng, precision,
            source, None, {
                "in_fy26_stats": True, "odo_matched": False,
                "match_method": None, "match_score": None,
                "matched_fy26_name": fac["name"], "state_evidence": None,
            })
        merge_into(facilities, fid, rec)

    # ODO-only centers (closed facilities, non-dedicated jails below the
    # FY26 reporting threshold, etc.). Located from the inspection URLs.
    odo_only_located, odo_only_unlocated = 0, 0
    for center, odo in unmatched_centers:
        srow = match_scraped(center, scraped)
        lat = lng = None
        precision = source = None
        address = city = state = zipc = ""
        if srow:
            lat, lng = srow["lat"], srow["lng"]
            precision, source = "address", "ice_gov_directory_geocode"
            address, city, state, zipc = srow["street"], srow["city"], srow["state"], srow["zip"]
        elif center["city"] and center["state"]:
            city, state = center["city"], center["state"]
            lat, lng, precision, source = locate_facility(
                geocoder, center["display_name"], "", city, state, "")
        if lat is None:
            odo_only_unlocated += 1
        else:
            odo_only_located += 1
        fid = slugify(f"{center['display_name']}-{state or 'xx'}")
        rec = build_record(
            fid, center["display_name"], center["aliases"],
            {"address": address, "city": city, "state": state or (center["state"] or ""),
             "zip": zipc, "aor": "", "type": "", "gender": "",
             "alos_days": None, "adp": None, "guaranteed_minimum_beds": None,
             "last_inspection": None},
            lat, lng, precision, source, odo, {
                "in_fy26_stats": False, "odo_matched": True,
                "match_method": "unmatched", "match_score": None,
                "matched_fy26_name": None,
                "state_evidence": center["state_evidence"],
            })
        merge_into(facilities, fid, rec)

    geocoder.save()
    out = sorted(facilities.values(), key=lambda r: r["name"])
    print(f"  {geocoder.calls} new geocode lookups (cache: {GEOCODE_CACHE})")
    print(f"  ODO-only centers located: {odo_only_located}, without coordinates: {odo_only_unlocated}")

    print("Generating neutral AI summaries (cached)...")
    n = generate_summaries(out, SUMMARY_CACHE, args.skip_summaries)
    print(f"  {n} new summaries generated")

    mappable = sum(1 for r in out if r["latitude"] is not None)
    with_odo = sum(1 for r in out if r["odo"])
    with_sub = sum(1 for r in out if r["odo"] and r["odo"]["latest_substantive"])
    meta = {
        "dataset_version": DATASET_VERSION,
        "generated_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "sources": [
            {
                "name": "ICE Detention Statistics, FY2026 year-to-date (facility-level sheet)",
                "url": "https://www.ice.gov/detain/detention-management",
                "notes": "Official ICE data: population, capacity, length of stay, last inspection rating.",
            },
            {
                "name": "ICE Office of Detention Oversight (ODO) compliance inspection reports",
                "url": "https://www.ice.gov/foia/odo-foia-library",
                "notes": "Deficiency counts and findings are taken directly from the published reports, linked on each facility.",
            },
            {
                "name": "ice.gov detention facilities directory",
                "url": "https://www.ice.gov/detention-facilities",
                "notes": "Supplemental addresses for facilities not in the FY26 statistics.",
            },
        ],
        "ice_caveats": ice_notes,
        "methodology": (
            "Inspection records are matched to official facilities by name only "
            "when the facility state (read from the inspection report URL or ERO "
            "field office) agrees. Locations are geocoded from official street "
            "addresses; 'location_precision' records whether a pin is at the "
            "address, the named facility, or only the city. Facilities without "
            "verifiable coordinates are excluded from the map but counted here."
        ),
        "counts": {
            "total_facilities": len(out),
            "mappable": mappable,
            "not_mappable": len(out) - mappable,
            "in_official_fy26_stats": sum(1 for r in out if r["provenance"]["in_fy26_stats"]),
            "with_odo_inspections": with_odo,
            "with_substantive_odo_findings": with_sub,
        },
    }

    payload = {"meta": meta, "facilities": out}
    os.makedirs(os.path.dirname(OUT_JSON), exist_ok=True)
    with open(OUT_JSON, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
    with gzip.open(OUT_GZ, "wt", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))

    print("\n==== SUMMARY ====")
    for k, v in meta["counts"].items():
        print(f"  {k}: {v}")
    print(f"  wrote {OUT_JSON}")
    print(f"  wrote {OUT_GZ} ({os.path.getsize(OUT_GZ) // 1024} KB)")


def build_record(fid, name, aliases, fac, lat, lng, precision, source, odo, provenance):
    aor = fac.get("aor", "")
    ftype = fac.get("type", "")
    return {
        "id": fid,
        "name": name,
        "aliases": [a for a in aliases if a != name],
        "address": (fac.get("address").title() if fac.get("address", "").isupper() else fac.get("address")) or None,
        "city": (fac.get("city").title() if fac.get("city", "").isupper() else fac.get("city")) or None,
        "state": fac.get("state") or None,
        "zip": fac.get("zip") or None,
        "aor": ({"code": aor, "name": AOR_NAMES.get(aor, aor)} if aor else None),
        "facility_type": ({"code": ftype, "label": FACILITY_TYPE_LABELS.get(ftype, ftype)} if ftype else None),
        "gender": fac.get("gender") or None,
        "latitude": lat,
        "longitude": lng,
        "location_precision": precision,
        "location_source": source,
        "stats": {
            "adp_fy26": fac.get("adp"),
            "guaranteed_minimum_beds": fac.get("guaranteed_minimum_beds"),
            "avg_length_of_stay_days": (round(fac["alos_days"], 1)
                                        if fac.get("alos_days") is not None else None),
        } if fac.get("adp") is not None or fac.get("guaranteed_minimum_beds") is not None
          or fac.get("alos_days") is not None else None,
        "last_ice_inspection": fac.get("last_inspection"),
        "odo": odo,
        "ai_summary": None,
        "provenance": provenance,
    }


def merge_into(facilities, fid, rec):
    """Two ODO centers can legitimately resolve to the same official
    facility; merge their inspection histories."""
    if fid not in facilities:
        facilities[fid] = rec
        return
    old = facilities[fid]
    old["aliases"] = sorted(set(old["aliases"]) | set(rec["aliases"]) | ({rec["name"]} - {old["name"]}))
    if rec["odo"] and old["odo"]:
        seen = {i["url"] for i in old["odo"]["inspections"] if i["url"]}
        extra = [i for i in rec["odo"]["inspections"] if i["url"] not in seen]
        old["odo"]["inspections"].extend(extra)
        old["odo"]["inspections"].sort(key=lambda i: i["date_iso"] or "0000", reverse=True)
        old["odo"]["inspection_count"] = len(old["odo"]["inspections"])
        old["odo"]["latest_inspection_date"] = old["odo"]["inspections"][0]["date_iso"]
        new_sub, old_sub = rec["odo"]["latest_substantive"], old["odo"]["latest_substantive"]
        if new_sub and (not old_sub or (new_sub["date_iso"] or "") > (old_sub["date_iso"] or "")):
            old["odo"]["latest_substantive"] = new_sub
    elif rec["odo"] and not old["odo"]:
        old["odo"] = rec["odo"]
        old["provenance"]["odo_matched"] = True
        for k in ("match_method", "match_score", "state_evidence"):
            old["provenance"][k] = rec["provenance"][k]


if __name__ == "__main__":
    main()

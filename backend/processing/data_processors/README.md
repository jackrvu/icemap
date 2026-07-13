# Data Processors

## Detention facility dataset — `build_facility_dataset.py`

Builds `frontend/public/detention_facilities.json.gz`, the dataset behind the
detention-center pins on the map. Run from the project root:

```bash
PYTHONUNBUFFERED=1 python3 backend/processing/data_processors/build_facility_dataset.py
# flags: --skip-geocode (cache only, no Google calls)
#        --skip-summaries (no DeepSeek calls; reuse cached summaries)
```

### Design goals

- **Complete** — the canonical facility list is ICE's own facility-level
  detention statistics (`data/FY26_detentionStats.xlsx`, "Facilities FY26"
  sheet, downloaded from https://www.ice.gov/detain/detention-management).
  All ~203 dedicated facilities appear, plus facilities that only exist in
  ODO inspection history (closed sites, small county jails).
- **Accurate** — ODO detention centers are located using the city/state
  embedded in the inspection PDF URLs (e.g. `pinellasCoJail_ClearwaterFL_…`)
  as ground truth. Name matches to the official list are rejected unless the
  states agree. This replaced a pure fuzzy-name match that had pinned
  Pinellas County Jail (FL) in Rolla, Missouri.
- **Objective** — the map shows deficiency counts taken directly from the
  published ODO reports, plus official ICE statistics (average daily
  population, guaranteed minimum beds, average length of stay, last contract
  inspection rating). The old LLM-invented 1–10 "quality score" (which was
  prompted to score facilities 8–10 when data was missing) is gone.
- **Transparent** — each record carries provenance: which sources it came
  from, how the name match was made and validated, and geocoding precision
  (address / facility name / city). Facilities that cannot be located are
  kept in the dataset and counted in `meta.counts` instead of silently
  dropped. The dataset `meta` block lists sources and methodology.

### Inputs

| File | Role |
|------|------|
| `data/FY26_detentionStats.xlsx` | Official ICE facility statistics (refresh from ice.gov periodically) |
| `data/distilled_data/merged_by_center.jsonl` | Parsed ODO inspection reports |
| `data/all_facilities_with_coordinates.csv` | Scraped ice.gov directory (fallback coordinates) |
| `data/facility_geocode_cache.json` | Google geocode cache (auto-managed) |
| `data/facility_summaries_cache.json` | DeepSeek summary cache (auto-managed) |

Requires `GOOGLE_PLACES_API_KEY` and `DEEPSEEK_API_KEY` in `.env`.

AI summaries are generated with a strictly factual prompt (counts, dates,
standards only; no speculation, no inference from missing data, no scores)
and are labeled as AI-generated in the UI.

### Refreshing the data

1. Download the latest detention statistics workbook from
   https://www.ice.gov/detain/detention-management and save it as
   `data/FY26_detentionStats.xlsx` (update the filename/sheet constants in
   the script when a new fiscal year starts).
2. Re-run the ODO scraping/parsing pipeline if new inspection reports are
   expected (updates `merged_by_center.jsonl`).
3. Run `build_facility_dataset.py`. Geocodes and summaries are cached, so
   incremental runs are fast and only new facilities cost API calls.

## Superseded scripts

`missing_facilities.py`, `facility_merge.py`, `summary_generator.py`, and
`../compress_facilities_data.py` were the previous pipeline for
`facilities_with_coordinates_results.jsonl.gz`. They are kept for reference
but are no longer used; `build_facility_dataset.py` replaces all of them.

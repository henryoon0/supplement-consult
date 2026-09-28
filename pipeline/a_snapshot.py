"""Step A: read-only snapshot of ax-hub Supabase tables into data/raw/axhub.duckdb.

How it works
- Every table is split into id ranges (integer min..max split, or UUID first-hex-char
  buckets). Each range is fetched with keyset pagination (order=id, id=gt.<last>).
  Tables without an id column fall back to offset pagination.
- Pages are saved as chunk files under data/raw/staging/<table>/ and a small state
  file per range records the last id. Re-running resumes where it stopped.
- When all ranges of a table are done, the table is (re)built in DuckDB from the
  chunk files. dict/list values are stored as JSON columns.
- data/raw/manifest.json records fetched vs expected row counts.

Only GET requests are sent. Nothing is written to ax-hub.
Usage: .venv/bin/python scripts/a_snapshot.py [table ...]
"""
import sys, os, json, time, gzip, threading, pathlib, datetime
from concurrent.futures import ThreadPoolExecutor, as_completed
import requests
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from _env import load_env, headers, ROOT

EXPECTED = {
    "podcast_channels": 20, "youtube_videos": 3064, "transcript_segments": 5940982,
    "supplement_mentions": 19787, "youtube_video_categories": 3797, "mi_markets": 107,
    "mi_ingredients": 376, "mi_search_keywords": 1080, "mi_keepa_products": 59080,
    "mi_keepa_sales_history": 845073, "mi_keepa_price_history": 714463,
    "mi_amazon_market": 576, "mi_google_trends": 37204, "mi_youtube_videos": 332898,
    "mi_news_articles": 32305, "mi_reddit_posts": 18890, "mi_reddit_analysis": 238,
    "mi_market_scores": 1436, "mi_spike_events": 8530, "mi_listing_usp": 12300,
    "mi_listing_usp_clusters": 2526, "mi_listing_usp_gaps": 376, "mi_brand_strategy": 374,
    "mi_ad_keyword_coverage": 5371, "mi_ad_sponsored_items": 34429, "mi_scan_runs": 2119,
    "trend_signals": 5912, "trend_events": 2960, "trend_forensics_results": 19,
    "api_quota_usage": 4, "opportunity_signals": None,
}
NO_ID = {"youtube_video_categories": "video_id,category"}
PAGE = {"youtube_videos": 50}
SEG_WORKERS = 8
STAGING = ROOT / "data/raw/staging"
DB_PATH = ROOT / "data/raw/axhub.duckdb"
URL, _ = load_env()
H = headers()
_local = threading.local()


def sess():
    if not hasattr(_local, "s"):
        _local.s = requests.Session()
        _local.s.headers.update(H)
    return _local.s


def get(path, params, tries=8):
    for i in range(tries):
        try:
            r = sess().get(f"{URL}/rest/v1/{path}", params=params, timeout=120)
            if r.status_code == 200:
                return r.json()
            err = f"HTTP {r.status_code} {r.text[:200]}"
        except Exception as e:  # network hiccup
            err = repr(e)[:200]
        time.sleep(min(60, 2 ** i))
    raise RuntimeError(f"{path} failed: {err}")


def exact_count(t):
    try:
        r = sess().get(f"{URL}/rest/v1/{t}", params={"select": "*", "limit": 1},
                       headers={"Prefer": "count=exact", "Range": "0-0"}, timeout=60)
        cr = r.headers.get("Content-Range", "")
        return int(cr.split("/")[-1]) if "/" in cr and cr.split("/")[-1].isdigit() else None
    except Exception:
        return None


def ranges_for(t):
    if t in NO_ID:
        return [("offset", None, None)]
    first = get(t, {"select": "id", "order": "id.asc", "limit": 1})
    if not first:
        return [("all", None, None)]
    if isinstance(first[0]["id"], int):
        lo = first[0]["id"] - 1
        hi = get(t, {"select": "id", "order": "id.desc", "limit": 1})[0]["id"]
        n = SEG_WORKERS * 4 if t == "transcript_segments" else (4 if hi - lo > 50000 else 1)
        step = (hi - lo) // n + 1
        return [(f"r{i:02d}", lo + i * step, min(hi, lo + (i + 1) * step)) for i in range(n)]
    # uuid: 16 buckets by first hex char (small tables: one bucket)
    exp = EXPECTED.get(t) or 0
    if exp < 20000:
        return [("all", None, None)]
    hexs = "0123456789abcdef"
    out = []
    for i, c in enumerate(hexs):
        lo = f"{c}0000000-0000-0000-0000-000000000000"
        hi = f"{hexs[i+1]}0000000-0000-0000-0000-000000000000" if i < 15 else None
        out.append((f"u{c}", lo, hi))
    return out


def norm_row(row):
    return {k: (json.dumps(v, ensure_ascii=False) if isinstance(v, (dict, list)) else v)
            for k, v in row.items()}


def fetch_range(t, name, lo, hi):
    d = STAGING / t
    d.mkdir(parents=True, exist_ok=True)
    st_path = d / f"{name}.state.json"
    st = json.loads(st_path.read_text()) if st_path.exists() else {"last": None, "chunks": 0, "rows": 0, "done": False, "jsoncols": []}
    if st["done"]:
        return st["rows"]
    page = PAGE.get(t, 1000)
    buf, jsoncols = [], set(st["jsoncols"])
    while True:
        if t in NO_ID:
            params = {"select": "*", "order": NO_ID[t], "limit": page, "offset": st["last"] or 0}
        else:
            params = [("select", "*"), ("order", "id.asc"), ("limit", page)]
            if st["last"] is not None:
                params.append(("id", f"gt.{st['last']}"))
            elif lo is not None:
                params.append(("id", f"gt.{lo}" if isinstance(lo, int) else f"gte.{lo}"))
            if hi is not None:
                params.append(("id", f"lte.{hi}" if isinstance(hi, int) else f"lt.{hi}"))
        rows = get(t, params)
        for r in rows:
            for k, v in r.items():
                if isinstance(v, (dict, list)):
                    jsoncols.add(k)
        buf.extend(norm_row(r) for r in rows)
        if t in NO_ID:
            st["last"] = (st["last"] or 0) + len(rows)
        elif rows:
            st["last"] = rows[-1]["id"]
        end = len(rows) < page
        if len(buf) >= 20000 or end:
            if buf:
                with gzip.open(d / f"{name}.{st['chunks']:05d}.jsonl.gz", "wt") as f:
                    for r in buf:
                        f.write(json.dumps(r, ensure_ascii=False) + "\n")
                st["chunks"] += 1
                st["rows"] += len(buf)
                buf = []
            st["done"] = end
            st["jsoncols"] = sorted(jsoncols)
            st_path.write_text(json.dumps(st))
        if end:
            return st["rows"]


def build_duckdb(con, t):
    d = STAGING / t
    files = sorted(d.glob("*.jsonl.gz"))
    jsoncols = set()
    for s in d.glob("*.state.json"):
        jsoncols |= set(json.loads(s.read_text())["jsoncols"])
    con.execute(f'DROP TABLE IF EXISTS "{t}"')
    if not files:
        con.execute(f'CREATE TABLE "{t}" (id VARCHAR)')
        return 0
    glob = str(d / "*.jsonl.gz")
    if t == "transcript_segments":
        con.execute(f"""CREATE TABLE "{t}" AS SELECT * FROM read_json('{glob}',
            columns={{'id':'BIGINT','video_id':'VARCHAR','start_seconds':'DOUBLE','text':'VARCHAR'}},
            format='newline_delimited')""")
    else:
        con.execute(f"""CREATE TABLE "{t}" AS SELECT * FROM read_json_auto('{glob}',
            format='newline_delimited', sample_size=-1, union_by_name=true)""")
        cols = {r[0]: r[1] for r in con.execute(f'DESCRIBE "{t}"').fetchall()}
        for c in jsoncols:
            if c in cols and cols[c] != "JSON":
                con.execute(f'ALTER TABLE "{t}" ALTER COLUMN "{c}" TYPE JSON USING "{c}"::VARCHAR::JSON')
    return con.execute(f'SELECT count(*) FROM "{t}"').fetchone()[0]


def main():
    import duckdb
    tables = sys.argv[1:] or list(EXPECTED)
    manifest_path = ROOT / "data/raw/manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {"tables": {}}
    jobs = {}
    with ThreadPoolExecutor(max_workers=10) as ex:
        plan = {}
        for t in tables:
            try:
                plan[t] = ranges_for(t)
            except Exception as e:
                manifest["tables"][t] = {"error": str(e)}
                print("SKIP", t, e, flush=True)
        for t, rs in plan.items():
            for name, lo, hi in rs:
                jobs[ex.submit(fetch_range, t, name, lo, hi)] = t
        errors = {}
        for fu in as_completed(jobs):
            t = jobs[fu]
            try:
                fu.result()
            except Exception as e:
                errors[t] = str(e)
                print("ERR", t, e, flush=True)
    con = duckdb.connect(str(DB_PATH))
    for t in plan:
        if t in errors:
            manifest["tables"][t] = {"error": errors[t], "expected": EXPECTED[t]}
            continue
        n = build_duckdb(con, t)
        exp = EXPECTED[t]
        live = exact_count(t) if t != "transcript_segments" else None
        manifest["tables"][t] = {
            "fetched": n, "expected_brief": exp, "live_exact_count": live,
            "match": (n == (live if live is not None else exp)),
            "fetched_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        }
        print(t, manifest["tables"][t], flush=True)
    manifest["updated_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    manifest_path.write_text(json.dumps(manifest, indent=2))
    con.close()


if __name__ == "__main__":
    main()

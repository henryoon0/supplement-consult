"""Step C-3: claim-card extraction on every transcript (pilot C-2 scaled up).

Same windows, prompt rules and validation as c2_pilot_cards.py, plus one field:
claim_ko, a one-line Korean summary shown in the dashboard next to the English quote.
Doing both in one pass means the transcripts are read by the LLM once.

- Videos: every video in corpus.duckdb (2,567 with transcripts).
- Resumable: per-window results go to data/refined/full_cache.jsonl as they finish;
  a rerun skips windows already there. Safe to stop and start again.
- Progress: data/refined/full_progress.json (done/total batches, rate, ETA).

Outputs: data/refined/full_cards.jsonl, full_rejected_cards.jsonl, full_stats.json.
Usage: c3_full_cards.py [--dry] [--limit N]   (--limit = first N videos, for a smoke test)
"""
import json, pathlib, sys, time
from concurrent.futures import ThreadPoolExecutor, as_completed
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from _env import ROOT, est_tokens, llm_json
import c2_pilot_cards as c2
import duckdb

REF = ROOT / "data/refined"
CACHE = REF / "full_cache.jsonl"
PROGRESS = REF / "full_progress.json"
PROMPT_VERSION = "cards-v2-ko"
WORKERS = 6

SYS = c2.SYS.replace(
    "- quote:",
    "- claim_ko: Korean, one short sentence (under 60 characters) that says the same as claim, "
    "for a Korean reader. Keep names and numbers as in claim. Natural Korean, no English words except names.\n- quote:",
)
SYS += ("\n\nJSON safety: inside any string value, never use a raw double quote. "
        "Write quoted speech inside quote/claim/claim_ko with single quotes ('like this'). No trailing text after the JSON.")
KINDS = ("mechanism", "dose_timing", "caveat", "anecdote", "contradiction", "recommendation")


def all_videos(raw, corp, limit=None):
    ids = [r[0] for r in corp.execute("SELECT DISTINCT video_id FROM words").fetchall()]
    rows = raw.execute(
        "SELECT video_id, title, channel_name, published_at, duration_seconds FROM youtube_videos "
        "WHERE video_id IN (SELECT UNNEST(?)) ORDER BY published_at DESC", [ids]).fetchall()
    vids = [dict(zip(["video_id", "title", "channel", "published_at", "duration"], r)) for r in rows]
    return vids[:limit] if limit else vids


def call_batch(batch, meta):
    blocks = []
    for w in batch:
        v = meta[w["video_id"]]
        hint = c2.CHANNELS.get(v["channel"], v["channel"])
        blocks.append(f"### window_id: {w['window_id']}\nTOPIC: {w['topic_name']} (slug {w['slug']})\n"
                      f"EPISODE: {v['channel']} | {v['title']} | channel host hint: {hint}\n"
                      f"TIME: {w['t0']:.0f}s-{w['t1']:.0f}s\nEXCERPT:\n{w['text']}")
    ids = {w["window_id"] for w in batch}

    def val(d):
        got = {r["window_id"] for r in d["results"]}
        assert ids <= got, f"missing {ids - got}"
        for r in d["results"]:
            assert len(r["cards"]) <= 2
            for c in r["cards"]:
                assert c["speaker_role"] in ("host", "guest", "sponsor_read"), c
                assert c["kind"] in KINDS, c
                assert isinstance(c["is_ad"], bool) and 0 <= float(c["confidence"]) <= 1
                assert c["claim"] and c["quote"] and c.get("claim_ko")

    t0 = time.time()
    return llm_json(SYS, "\n\n".join(blocks), "c3_cards", val, tries=6), time.time() - t0


def load_cache():
    done = {}
    if CACHE.exists():
        for line in CACHE.read_text().splitlines():
            if line.strip():
                r = json.loads(line)
                done[r["window_id"]] = r
    return done


def main():
    dry = "--dry" in sys.argv
    limit = int(sys.argv[sys.argv.index("--limit") + 1]) if "--limit" in sys.argv else None
    raw = duckdb.connect(str(ROOT / "data/raw/axhub.duckdb"), read_only=True)
    corp = duckdb.connect(str(REF / "corpus.duckdb"), read_only=True)
    vids = all_videos(raw, corp, limit)
    meta = {v["video_id"]: v for v in vids}
    rows, terms = c2.build_terms(corp)
    names = {r["slug"]: r["name_en"] for r in rows}

    WIN = REF / ("full_windows.jsonl" if not limit else f"full_windows_limit{limit}.jsonl")
    allw = []
    if WIN.exists():  # 구간 계산은 전체 기준 약 35분이라 한 번만 한다
        allw = [json.loads(l) for l in WIN.read_text().splitlines() if l.strip()]
    for v in ([] if allw else vids):
        wt = corp.execute("SELECT w, t FROM words WHERE video_id = ? ORDER BY i", [v["video_id"]]).fetchall()
        words, times = [x[0] for x in wt], [x[1] for x in wt]
        spans = corp.execute("SELECT i0, i1 FROM repeated_spans WHERE video_id = ?", [v["video_id"]]).fetchall()
        for w in c2.windows_for(v, words, times, spans, terms):
            w["topic_name"] = names[w["slug"]]
            allw.append(w)
    if not WIN.exists():
        with open(WIN, "w") as f:
            for w in allw:
                f.write(json.dumps(w, ensure_ascii=False) + "\n")
    in_tok = sum(est_tokens(w["text"]) for w in allw)
    print(f"videos {len(vids)}, windows {len(allw)}, est input tokens {in_tok:.0f}", flush=True)
    if dry:
        return

    done = load_cache()
    todo = [w for w in allw if w["window_id"] not in done]
    batches, cur, cw = [], [], 0
    for w in sorted(todo, key=lambda x: (x["video_id"], x["t0"])):
        n = w["i1"] - w["i0"]
        if cur and (cw + n > 1000 or len(cur) >= 2):
            batches.append(cur)
            cur, cw = [], 0
        cur.append(w)
        cw += n
    if cur:
        batches.append(cur)
    print(f"already done {len(done)} windows, batches to run {len(batches)}", flush=True)

    t_start, failed, finished = time.time(), 0, 0
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(call_batch, b, meta): b for b in batches}
        for fu in as_completed(futs):
            b = futs[fu]
            finished += 1
            try:
                d, sec = fu.result()
                with open(CACHE, "a") as f:
                    for r in d["results"]:
                        if r["window_id"] in {w["window_id"] for w in b}:
                            r["_sec"] = round(sec, 1)
                            f.write(json.dumps(r, ensure_ascii=False) + "\n")
            except Exception as e:  # a failed batch is simply retried on the next run
                failed += 1
                print("batch failed", repr(e)[:200], flush=True)
            if finished % 25 == 0 or finished == len(batches):
                el = time.time() - t_start
                rate = finished / el * 60 if el else 0
                PROGRESS.write_text(json.dumps({
                    "batches_done": finished, "batches_total": len(batches), "failed": failed,
                    "per_min": round(rate, 1),
                    "eta_min": round((len(batches) - finished) / rate) if rate else None,
                    "updated": time.strftime("%Y-%m-%d %H:%M:%S")}, ensure_ascii=False))
                print(f"  {finished}/{len(batches)} batches, {rate:.0f}/min, failed {failed}", flush=True)

    assemble(allw, corp)


def assemble(allw, corp):
    done = load_cache()
    wmap = {w["window_id"]: w for w in allw}
    cards, rejected, wordcache = [], [], {}
    for wid, r in done.items():
        w = wmap.get(wid)
        if not w:
            continue
        if w["video_id"] not in wordcache:
            wt = corp.execute("SELECT w, t FROM words WHERE video_id = ? ORDER BY i", [w["video_id"]]).fetchall()
            wordcache = {w["video_id"]: ([x[0] for x in wt], [x[1] for x in wt])}  # one video at a time
        words, times = wordcache[w["video_id"]]
        for c in r["cards"]:
            probs = c2.validate_card(c, w)
            card = {"topic_slug": w["slug"], "claim": c["claim"], "claim_ko": c.get("claim_ko", ""),
                    "speaker": c["speaker"], "speaker_role": c["speaker_role"], "kind": c["kind"],
                    "quote": c["quote"], "video_id": w["video_id"],
                    "start_seconds": round(c2.locate(c, w, words, times), 2), "is_ad": c["is_ad"],
                    "confidence": float(c["confidence"]), "window_id": wid,
                    "ad_candidate_window": w["ad_candidate"], "extractor": f"gpt-6-luna/{PROMPT_VERSION}",
                    "validation_problems": probs}
            (rejected if any(p.startswith("number_not") for p in probs) else cards).append(card)
    for name, rows_ in (("full_cards.jsonl", cards), ("full_rejected_cards.jsonl", rejected)):
        with open(REF / name, "w") as f:
            for c in rows_:
                f.write(json.dumps(c, ensure_ascii=False) + "\n")
    stats = {"windows": len(allw), "windows_done": len(done), "cards": len(cards), "rejected": len(rejected),
             "ads": sum(c["is_ad"] for c in cards), "videos_with_cards": len({c["video_id"] for c in cards})}
    (REF / "full_stats.json").write_text(json.dumps(stats, indent=1))
    print(json.dumps(stats), flush=True)


if __name__ == "__main__":
    main()

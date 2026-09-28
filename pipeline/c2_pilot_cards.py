"""Step C-2: pilot claim-card extraction on 20 episodes.

- Picks 2 newest episodes (>= 10 min, with transcript segments) from each of 10 channels.
- Finds mentions of canonical ingredients/protocols (name, cleaned English aliases,
  podcast names) with word-boundary regex over the cleaned word stream (c1_corpus.py).
- Window = mention time +-60 s; overlapping windows of the same topic are merged,
  then split so no window is longer than 300 s.
- Words inside repeated spans (ad candidates) are wrapped in [[REPEATED: ...]].
- The LLM returns 0-2 claim cards per window. Cards are validated in code:
  numbers in the claim must appear in the window, the quote must be (nearly) verbatim.
- Resumable: per-window LLM results are cached in data/refined/pilot_cache.jsonl.

Outputs: data/refined/pilot_cards.jsonl, data/refined/pilot_windows.jsonl,
data/refined/pilot_stats.json.  Usage: c2_pilot_cards.py [--dry]
"""
import sys, json, re, pathlib, time, bisect
from concurrent.futures import ThreadPoolExecutor, as_completed
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from _env import ROOT, llm_json, est_tokens
import duckdb, pyarrow.parquet as pq

CHANNELS = {  # channel_name -> likely host name (hint for the LLM)
    "Huberman Lab": "Andrew Huberman", "Peter Attia": "Peter Attia", "Dr. Rhonda Patrick": "Rhonda Patrick",
    "Dr. Mark Hyman": "Mark Hyman", "Dr. Casey Means": "Casey Means", "Dr. Andy Galpin": "Andy Galpin",
    "Dr. Stacy Sims": "Stacy Sims", "DOAC": "Steven Bartlett", "Joe Rogan Experience": "Joe Rogan",
    "Dr. Tim Spector": "Tim Spector (ZOE; host often Jonathan Wolf)",
}
PER_CHANNEL, HALF, MAX_WIN, WORKERS = 2, 60.0, 300.0, 6
REF = ROOT / "data/refined"
CACHE = REF / "pilot_cache.jsonl"
PROMPT_VERSION = "cards-v1"
_nre = re.compile(r"[^a-z0-9]+")


def normw(w):
    return _nre.sub("", w.lower())


def pick_videos(raw):
    vids = []
    for ch in CHANNELS:
        rows = raw.execute("""SELECT v.video_id, v.title, v.channel_name, v.published_at, v.duration_seconds
            FROM youtube_videos v WHERE v.channel_name = ? AND v.has_transcript AND coalesce(v.duration_seconds, 0) >= 600
              AND EXISTS (SELECT 1 FROM transcript_segments s WHERE s.video_id = v.video_id)
            ORDER BY v.published_at DESC LIMIT ?""", [ch, PER_CHANNEL]).fetchall()
        vids += [dict(zip(["video_id", "title", "channel", "published_at", "duration"], r)) for r in rows]
    return vids


def build_terms(corp):
    """Search terms per canonical row. Two noise guards, added after the first pilot run
    (alias "SAMe" matched the word "same", "acid" matched "amino acid", "flow" ...):
    - a term with 2+ capital letters (acronym-like: SAMe, DHA, NAD) is matched case-sensitively;
    - a single-word English alias (not the canonical name itself) is dropped when it
      appears in more than 10% of all transcripts, i.e. it is an everyday word."""
    rows = pq.read_table(REF / "ingredients.parquet").to_pylist()
    per_row = []
    for r in rows:
        primary = {r["name_en"], *r["podcast_names"]}
        for c in list(primary):
            primary |= {x.strip() for x in re.split(r"\s*/\s*|\s*\(|\)", c) if x.strip()}
        aliases = {a.strip() for a in r["aliases_en"] if a.strip()} - primary
        per_row.append((r, primary, aliases))
    singles = sorted({normw(a) for _, _, al in per_row for a in al if " " not in a and "-" not in a and normw(a)})
    n_vid = corp.execute("SELECT count(DISTINCT video_id) FROM words").fetchone()[0]
    corp.execute("CREATE TEMP TABLE cand AS SELECT unnest(?::VARCHAR[]) AS n", [singles])
    df = dict(corp.execute("""SELECT c.n, count(DISTINCT w.video_id) FROM cand c
        JOIN words w ON regexp_replace(lower(w.w), '[^a-z0-9]', '', 'g') = c.n GROUP BY 1""").fetchall())
    common = {n for n, k in df.items() if k > 0.10 * n_vid}
    terms, dropped = [], []
    for r, primary, aliases in per_row:
        for c in primary | aliases:
            if len(c) < 3 or (len(c) == 3 and not c.isupper()):
                continue
            plural_of_primary = any(abs(len(normw(c)) - len(normw(x))) <= 2 and
                                    (normw(x).startswith(normw(c)) or normw(c).startswith(normw(x))) for x in primary)
            if c in aliases and " " not in c and normw(c) in common and not plural_of_primary:
                dropped.append((r["slug"], c)); continue
            esc = re.escape(c).replace(r"\ ", r"[\s-]+").replace(r"\-", r"[\s-]?")
            flags = 0 if sum(ch.isupper() for ch in c) >= 2 else re.I
            terms.append((re.compile(rf"(?<![A-Za-z0-9]){esc}(?![A-Za-z0-9])", flags), r["slug"], c))
    (REF / "pilot_dropped_aliases.json").write_text(json.dumps(dropped, indent=0))
    print(f"terms {len(terms)}, dropped common-word aliases {len(dropped)}: {dropped[:30]}", flush=True)
    return rows, terms


def windows_for(video, words, times, spans, terms):
    text, starts = "", []
    for w in words:
        starts.append(len(text)); text += w + " "
    hits = {}
    for rx, slug, term in terms:
        for m in rx.finditer(text):
            wi = bisect.bisect_right(starts, m.start()) - 1
            hits.setdefault(slug, set()).add(wi)
    out = []
    for slug, idxs in hits.items():
        ivs = sorted((times[i] - HALF, times[i] + HALF) for i in idxs)
        merged = []
        for a, b in ivs:
            if merged and a <= merged[-1][1]:
                merged[-1][1] = max(merged[-1][1], b)
            else:
                merged.append([a, b])
        for a, b in merged:
            while a < b:
                e = min(b, a + MAX_WIN)
                i0 = bisect.bisect_left(times, a); i1 = bisect.bisect_right(times, e) - 1
                if i1 > i0:
                    out.append({"slug": slug, "i0": i0, "i1": i1, "t0": times[i0], "t1": times[i1],
                                "n_mentions": sum(1 for i in idxs if i0 <= i <= i1)})
                a = e
    for w in out:
        w["video_id"] = video["video_id"]
        w["window_id"] = f"{video['video_id']}:{w['slug']}:{int(w['t0'])}"
        rep = [s for s in spans if s[1] >= w["i0"] and s[0] <= w["i1"]]
        w["ad_candidate"] = bool(rep)
        parts, i = [], w["i0"]
        for s0, s1 in sorted(rep):
            s0c, s1c = max(s0, w["i0"]), min(s1, w["i1"])
            if s0c > i:
                parts.append(" ".join(words[i:s0c]))
            parts.append("[[REPEATED: " + " ".join(words[s0c:s1c + 1]) + "]]")
            i = s1c + 1
        if i <= w["i1"]:
            parts.append(" ".join(words[i:w["i1"] + 1]))
        w["text"] = " ".join(parts)
    return out


SYS = """You extract "claim cards" from podcast transcript excerpts for a health knowledge base.
Each excerpt is about one TOPIC (an ingredient or a protocol). Return 0, 1 or 2 cards per excerpt, only for substantive statements about that topic (what it does, how, dose/timing, caveats, personal experience, disagreement, recommendation). Return no card for passing mentions, jokes, small talk, or when the topic word is used in another sense (e.g. "running a company").

Card fields:
- claim: English, one sentence, neutral paraphrase. Use ONLY numbers that appear in the excerpt.
- speaker: person's name if inferable from the excerpt/episode info, else "host", "guest" or "unknown".
- speaker_role: "host" | "guest" | "sponsor_read".
- kind: "mechanism" | "dose_timing" | "caveat" | "anecdote" | "contradiction" | "recommendation".
- quote: up to 2 sentences copied VERBATIM from the excerpt (keep the words exactly, you may drop the [[REPEATED: ]] markers).
- is_ad: true if the statement is part of a sponsor/advertising read (product promo, discount code, "brought to you by", "go to X.com/..."). Text marked [[REPEATED: ...]] appears word-for-word in 3+ other episodes: it is often a sponsor read or a show intro/disclaimer, but check the content yourself. Sponsor reads get speaker_role "sponsor_read" and is_ad true.
- confidence: 0-1, how sure you are the card is accurate and attributed right.

Return strict JSON only: {"results":[{"window_id":"...","ad_segment_present": true|false,"cards":[{...}]}]} with one result per excerpt, same window_id."""


def call_batch(batch, meta):
    blocks = []
    for w in batch:
        v = meta[w["video_id"]]
        blocks.append(f"### window_id: {w['window_id']}\nTOPIC: {w['topic_name']} (slug {w['slug']})\n"
                      f"EPISODE: {v['channel']} | {v['title']} | channel host hint: {CHANNELS[v['channel']]}\n"
                      f"TIME: {w['t0']:.0f}s-{w['t1']:.0f}s\nEXCERPT:\n{w['text']}")
    ids = {w["window_id"] for w in batch}

    def val(d):
        got = {r["window_id"] for r in d["results"]}
        assert ids <= got, f"missing {ids - got}"
        for r in d["results"]:
            assert len(r["cards"]) <= 2
            for c in r["cards"]:
                assert c["speaker_role"] in ("host", "guest", "sponsor_read"), c
                assert c["kind"] in ("mechanism", "dose_timing", "caveat", "anecdote", "contradiction", "recommendation"), c
                assert isinstance(c["is_ad"], bool) and 0 <= float(c["confidence"]) <= 1
                assert c["claim"] and c["quote"]
    t0 = time.time()
    d = llm_json(SYS, "\n\n".join(blocks), "c_cards", val)
    return d, time.time() - t0


# standalone numbers only: "SIRT1", "omega-3", "PARP1" are names, not numbers
NUM_RX = r"(?<![A-Za-z0-9\-])\d+(?:\.\d+)?(?![A-Za-z0-9])"
NUM_WORDS = {w: i for i, w in enumerate("zero one two three four five six seven eight nine ten eleven twelve thirteen "
                                         "fourteen fifteen sixteen seventeen eighteen nineteen twenty".split())}
NUM_WORDS.update({"thirty": 30, "forty": 40, "fifty": 50, "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90,
                  "hundred": 100, "thousand": 1000, "half": 50})


def validate_card(c, w):
    wtext = w["text"].replace("[[REPEATED: ", "").replace("]]", "")
    problems = []
    src_nums = set(re.findall(NUM_RX, wtext.replace(",", ""))) | {
        str(v) for k, v in NUM_WORDS.items() if re.search(rf"\b{k}\b", wtext, re.I)}
    for n in re.findall(NUM_RX, c["claim"].replace(",", "")):
        if n not in src_nums:
            problems.append(f"number_not_in_source:{n}")
    nq = " ".join(normw(x) for x in c["quote"].split() if normw(x))
    nw = " ".join(normw(x) for x in wtext.split() if normw(x))
    if nq not in nw:
        qw = nq.split()
        hit = sum(1 for k in range(0, max(1, len(qw) - 4)) if " ".join(qw[k:k + 5]) in nw)
        if hit < max(1, (len(qw) - 4) * 0.6):
            problems.append("quote_not_verbatim")
    return problems


def locate(c, w, words, times):
    qw = [normw(x) for x in c["quote"].split() if normw(x)][:5]
    ws = [normw(x) for x in words[w["i0"]:w["i1"] + 1]]
    for k in range(len(ws) - len(qw) + 1):
        if ws[k:k + len(qw)] == qw:
            return times[w["i0"] + k]
    return w["t0"]


def main():
    dry = "--dry" in sys.argv
    raw = duckdb.connect(str(ROOT / "data/raw/axhub.duckdb"), read_only=True)
    corp = duckdb.connect(str(REF / "corpus.duckdb"), read_only=True)
    vids = pick_videos(raw)
    meta = {v["video_id"]: v for v in vids}
    rows, terms = build_terms(corp)
    names = {r["slug"]: r["name_en"] for r in rows}
    allw, data = [], {}
    for v in vids:
        wt = corp.execute("SELECT w, t FROM words WHERE video_id = ? ORDER BY i", [v["video_id"]]).fetchall()
        words, times = [x[0] for x in wt], [x[1] for x in wt]
        spans = corp.execute("SELECT i0, i1 FROM repeated_spans WHERE video_id = ?", [v["video_id"]]).fetchall()
        data[v["video_id"]] = (words, times)
        ws = windows_for(v, words, times, spans, terms)
        for w in ws:
            w["topic_name"] = names[w["slug"]]
        v["n_words"], v["n_windows"], v["n_topics"] = len(words), len(ws), len({w["slug"] for w in ws})
        allw += ws
        print(f"{v['channel'][:20]:20} {v['video_id']} {v['duration']:>6}s words={len(words):>6} topics={v['n_topics']:>3} windows={len(ws):>4}", flush=True)
    in_tok = sum(est_tokens(w["text"]) for w in allw)
    print(f"TOTAL windows {len(allw)}, ad-candidate windows {sum(w['ad_candidate'] for w in allw)}, est input tokens (excerpts only) {in_tok:.0f}")
    with open(REF / "pilot_windows.jsonl", "w") as f:
        for w in allw:
            f.write(json.dumps(w, ensure_ascii=False) + "\n")
    if dry:
        return
    done = {}
    if CACHE.exists():
        for line in CACHE.read_text().splitlines():
            r = json.loads(line); done[r["window_id"]] = r
    todo = [w for w in allw if w["window_id"] not in done]
    # batch small windows together (max ~1500 words per call)
    batches, cur, cw = [], [], 0
    for w in sorted(todo, key=lambda x: (x["video_id"], x["t0"])):
        n = w["i1"] - w["i0"]
        if cur and (cw + n > 1000 or len(cur) >= 2):
            batches.append(cur); cur, cw = [], 0
        cur.append(w); cw += n
    if cur:
        batches.append(cur)
    print(f"LLM batches to run: {len(batches)}", flush=True)
    t_start = time.time()
    failed = []
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(call_batch, b, meta): b for b in batches}
        for k, fu in enumerate(as_completed(futs)):
            b = futs[fu]
            try:
                d, sec = fu.result()
            except Exception as e:
                failed += [w["window_id"] for w in b]
                print("batch failed", e, flush=True)
                continue
            with open(CACHE, "a") as f:
                for r in d["results"]:
                    if r["window_id"] in {w["window_id"] for w in b}:
                        r["_sec"] = sec
                        f.write(json.dumps(r, ensure_ascii=False) + "\n")
                        done[r["window_id"]] = r
            if k % 10 == 0:
                print(f"  {k+1}/{len(batches)} batches, {time.time()-t_start:.0f}s", flush=True)
    wall = time.time() - t_start
    # assemble cards
    wmap = {w["window_id"]: w for w in allw}
    cards, rejected = [], []
    for wid, r in done.items():
        w = wmap.get(wid)
        if not w:
            continue
        words, times = data[w["video_id"]]
        for c in r["cards"]:
            probs = validate_card(c, w)
            card = {"topic_slug": w["slug"], "claim": c["claim"], "speaker": c["speaker"], "speaker_role": c["speaker_role"],
                    "kind": c["kind"], "quote": c["quote"], "video_id": w["video_id"],
                    "start_seconds": round(locate(c, w, words, times), 2), "is_ad": c["is_ad"],
                    "confidence": float(c["confidence"]), "window_id": wid, "ad_candidate_window": w["ad_candidate"],
                    "ad_segment_present": r.get("ad_segment_present"), "extractor": f"gpt-6-luna/{PROMPT_VERSION}",
                    "validation_problems": probs}
            (rejected if any(p.startswith("number_not") for p in probs) else cards).append(card)
    with open(REF / "pilot_cards.jsonl", "w") as f:
        for c in cards:
            f.write(json.dumps(c, ensure_ascii=False) + "\n")
    with open(REF / "pilot_rejected_cards.jsonl", "w") as f:
        for c in rejected:
            f.write(json.dumps(c, ensure_ascii=False) + "\n")
    stats = {"videos": vids, "n_windows": len(allw), "n_windows_done": len(done), "failed_windows": failed,
             "n_batches": len(batches), "wall_sec_this_run": wall, "n_cards": len(cards), "n_rejected": len(rejected),
             "est_excerpt_tokens": in_tok, "workers": WORKERS}
    (REF / "pilot_stats.json").write_text(json.dumps(stats, indent=1, ensure_ascii=False, default=str))
    print(json.dumps({k: v for k, v in stats.items() if k != "videos"}, default=str))


if __name__ == "__main__":
    main()

"""Step C-1: clean transcript word streams + repeated-span (ad candidate) detection.

1. Rolling YouTube captions repeat the previous line in every cue. Per video we
   order cues by (start_seconds, id) and append only the words that do not
   overlap the tail of the text so far (overlap >= 2 words, or the whole cue).
   Each word keeps the start time of the cue that added it.
2. Every 8-word window (normalized: lowercase, letters/digits only) is hashed.
   A hash seen in >= 3 different videos is "repeated".
3. A repeated span = a run of >= 12 consecutive words that are all covered by
   repeated 8-word windows. This approximates "a sentence of >= 8 words that
   appears verbatim in >= 3 videos" and also works for transcripts that have no
   punctuation (e.g. Jay Shetty, JRE). Spans are ad CANDIDATES only (show intros
   and disclaimers repeat too); the LLM confirms later.

Output: data/refined/corpus.duckdb with tables words(video_id,i,w,t) and
repeated_spans(video_id,i0,i1,t0,t1,n_words,text). Re-run rebuilds from scratch.
"""
import sys, pathlib, re, time
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from _env import ROOT
import duckdb, pyarrow as pa

K, MIN_VIDEOS, MIN_SPAN = 8, 3, 12
RAW = ROOT / "data/raw/axhub.duckdb"
OUT = ROOT / "data/refined/corpus.duckdb"
_nre = re.compile(r"[^a-z0-9]+")


def normw(w):
    return _nre.sub("", w.lower())


def dedup(cues):
    words, norms, times = [], [], []
    for t, text in cues:
        c = (text or "").split()
        cn = [normw(x) for x in c]
        k_best = 0
        for k in range(min(len(cn), len(norms), 60), 0, -1):
            if norms[-k:] == cn[:k] and (k >= 2 or k == len(cn)):
                k_best = k
                break
        for w, n in zip(c[k_best:], cn[k_best:]):
            words.append(w); norms.append(n); times.append(t)
    return words, norms, times


def main():
    t0 = time.time()
    src = duckdb.connect(str(RAW), read_only=True)
    if OUT.exists():
        OUT.unlink()
    out = duckdb.connect(str(OUT))
    out.execute("CREATE TABLE words (video_id VARCHAR, i INTEGER, w VARCHAR, t DOUBLE)")
    out.execute("CREATE TABLE shingles (video_id VARCHAR, i INTEGER, h BIGINT)")
    vids = [r[0] for r in src.execute("SELECT DISTINCT video_id FROM transcript_segments ORDER BY 1").fetchall()]
    buf_w, buf_s = [], []

    def flush():
        if buf_w:
            out.register("bw", pa.Table.from_pylist(buf_w)); out.execute("INSERT INTO words SELECT * FROM bw"); out.unregister("bw")
            out.register("bs", pa.Table.from_pylist(buf_s)); out.execute("INSERT INTO shingles SELECT * FROM bs"); out.unregister("bs")
        buf_w.clear(); buf_s.clear()

    # read all cues once, grouped by video
    cur = src.execute("SELECT video_id, start_seconds, text FROM transcript_segments ORDER BY video_id, start_seconds, id")
    current, cues = None, []

    def handle(vid, cues):
        words, norms, times = dedup(cues)
        for i, (w, tt) in enumerate(zip(words, times)):
            buf_w.append({"video_id": vid, "i": i, "w": w, "t": tt})
        for i in range(len(norms) - K + 1):
            win = norms[i:i + K]
            if all(win):
                buf_s.append({"video_id": vid, "i": i, "h": hash(" ".join(win)) & 0x7FFFFFFFFFFFFFFF})

    n_done = 0
    while True:
        rows = cur.fetchmany(200000)
        if not rows:
            break
        for vid, t, text in rows:
            if vid != current:
                if current is not None:
                    handle(current, cues); n_done += 1
                    if len(buf_w) > 2_000_000:
                        flush()
                current, cues = vid, []
            cues.append((t, text))
    if current is not None:
        handle(current, cues); n_done += 1
    flush()
    print(f"videos {n_done}, words {out.execute('select count(*) from words').fetchone()[0]}, {time.time()-t0:.0f}s", flush=True)

    out.execute(f"""CREATE TABLE rep AS SELECT h FROM shingles GROUP BY h HAVING count(DISTINCT video_id) >= {MIN_VIDEOS}""")
    # word covered if any repeated shingle starts in [i-K+1, i]
    out.execute(f"""
      CREATE TABLE covered AS
      SELECT DISTINCT s.video_id, s.i + r.o AS i
      FROM shingles s JOIN rep USING (h), range({K}) r(o)""")
    out.execute(f"""
      CREATE TABLE repeated_spans AS
      WITH g AS (SELECT video_id, i, i - row_number() OVER (PARTITION BY video_id ORDER BY i) AS grp FROM covered),
           sp AS (SELECT video_id, min(i) i0, max(i) i1, count(*) n FROM g GROUP BY video_id, grp HAVING count(*) >= {MIN_SPAN})
      SELECT sp.video_id, i0, i1, n AS n_words,
             (SELECT min(t) FROM words w WHERE w.video_id = sp.video_id AND w.i = i0) AS t0,
             (SELECT max(t) FROM words w WHERE w.video_id = sp.video_id AND w.i = i1) AS t1,
             (SELECT string_agg(w, ' ' ORDER BY w.i) FROM words w WHERE w.video_id = sp.video_id AND w.i BETWEEN i0 AND i1) AS text
      FROM sp""")
    out.execute("DROP TABLE covered")
    print(out.execute("SELECT count(*), count(DISTINCT video_id), sum(n_words) FROM repeated_spans").fetchone(), f"{time.time()-t0:.0f}s")
    out.close()


if __name__ == "__main__":
    main()

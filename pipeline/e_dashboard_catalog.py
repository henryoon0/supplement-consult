"""Export a compact recommendation catalog for the dashboard PoC.

Output: dashboard/data/domains/wellness/body-brain/catalog.json
One entry per top ingredient that has evidence and at least one decent product.
"""
import csv, json, pathlib, duckdb

ROOT = pathlib.Path(__file__).resolve().parent
REF = ROOT / "data/refined"
OUT = pathlib.Path(__file__).resolve().parents[1] / "seed" / "catalog.json"

names = {r["slug"]: r for r in csv.DictReader(open(REF / "ingredients.csv"))}
layers = {x["name"]: x for x in json.load(open(REF / "ingredient_layers_v2.json"))}
top = json.load(open(REF / "top94_evidence_availability.json"))
# 전체 추출본(c3, 한국어 요약 포함)이 있으면 그걸, 없으면 시험 추출본을 쓴다.
CARDS_FILE = REF / "full_cards.jsonl" if (REF / "full_cards.jsonl").exists() and (REF / "full_cards.jsonl").stat().st_size > 10_000 else REF / "pilot_cards.jsonl"
cards = [json.loads(l) for l in open(CARDS_FILE)]

db = duckdb.connect(str(ROOT / "data/raw/axhub.duckdb"), read_only=True)

def keywords(t, n):
    """제품 제목에 이 중 하나는 있어야 그 성분 제품으로 본다(원본 표가 성분을 넓게 묶어서)."""
    words = [t["core"], t["name"], n.get("name_en", "")] + (n.get("aliases_en") or "").split("|")
    return [w.lower() for w in words if len(w) >= 3]


def products(slug, kws, multi_ok):
    rows = db.execute("""
        select p.brand, p.title, p.price, p.rating, p.review_count, p.monthly_sold,
               p.form, p.dosage_mg, p.serving_count, p.price_per_serving, p.asin
        from mi_keepa_products p join mi_ingredients i on i.id = p.ingredient_id
        where i.slug = ? and p.rating >= 4.2 and p.review_count >= 200 and p.price > 0
        order by p.monthly_sold desc nulls last limit 40""", [slug]).fetchall()
    rows = [r for r in rows
            if any(k in r[1].lower()[:60] for k in kws)
            and (multi_ok or "multivitamin" not in r[1].lower())
            and not any(w in r[1].lower() for w in ("serum", "cream", "lotion", "for face", "shampoo"))]
    seen_titles, uniq = set(), []
    for r in rows:
        key = r[1].lower()[:35]
        if key not in seen_titles:
            seen_titles.add(key)
            uniq.append(r)
    rows = uniq[:3]
    keys = ["brand", "title", "price", "rating", "reviews", "monthlySold", "form",
            "doseMg", "servings", "pricePerServing", "asin"]
    return [dict(zip(keys, r)) for r in rows]

def reddit(slug):
    r = db.execute("""select a.overall_narrative from mi_reddit_analysis a
        join mi_ingredients i on i.id = a.ingredient_id where i.slug = ? limit 1""", [slug]).fetchone()
    return (r[0] or "")[:400] if r else ""

videos = {r[0]: {"title": r[1], "channel": r[2], "duration": r[3]} for r in db.execute(
    "select video_id, title, channel_name, duration_seconds from youtube_videos").fetchall()}


def podcast_for(slug, core):
    """GBrain 페이지(f_gbrain_pages.card_topics)와 같은 규칙으로 발언을 고른다."""
    core_slug = core.replace(" ", "-")
    items = [c for c in cards if not c["is_ad"] and (
        c["topic_slug"] in (slug, core_slug) or c["topic_slug"].startswith(core_slug + "-")
        or slug.startswith(c["topic_slug"] + "-"))]
    out = []
    for c in sorted(items, key=lambda c: -c.get("confidence", 0))[:6]:
        v = videos.get(c["video_id"], {})
        out.append({"speaker": c["speaker"], "kind": c["kind"], "claim": c["claim"], "claimKo": c.get("claim_ko", ""),
                    "quote": c.get("quote") or "", "videoId": c["video_id"],
                    "t": int(c["start_seconds"] or 0), "title": v.get("title") or "",
                    "channel": v.get("channel") or "", "duration": v.get("duration") or 0})
    return out


out, seen = [], set()
for t in top:
    lay = layers.get(t["name"])
    if not lay or not (t["nih"] or t["sr"] > 0):
        continue
    slug = lay["slug"]
    core = t["core"].lower()
    if core in seen:
        continue
    n = names.get(slug, {})
    prods = products(slug, keywords(t, n), "multi" in core)
    if not prods:
        continue
    seen.add(core)
    out.append({
        "slug": slug,
        "nameEn": t["name"],
        "nameKo": n.get("name_ko") or t["name"],
        "aliasesKo": [a for a in (n.get("aliases_ko") or "").split("|") if a],
        "evidence": {"nihFactSheet": t["nih"], "systematicReviews": t["sr"]},
        "monthlyRevenueUsd": t["rev"],
        "podcastMentions": t["pod"],
        "podcast": podcast_for(slug, core),
        "reddit": reddit(slug),
        "products": prods,
    })

OUT.parent.mkdir(parents=True, exist_ok=True)
json.dump({"builtAt": __import__("datetime").date.today().isoformat(), "count": len(out),
           "ingredients": out}, open(OUT, "w"), ensure_ascii=False, indent=1)
print(len(out), "ingredients ->", OUT)

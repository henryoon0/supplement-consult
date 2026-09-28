"""Write GBrain pages (markdown) from the refined body-brain data.

Knowledge goes to GBrain; numbers (price, sales) stay in the catalog table.
One page per ingredient (ingredients/<slug>) and per habit/other topic
(topics/<slug>). Import with:
  GBRAIN_HOME=~/.local/share/body-brain-gbrain gbrain import data/refined/gbrain_pages --no-embed
"""
import collections, json, pathlib, shutil

ROOT = pathlib.Path(__file__).resolve().parent
REF = ROOT / "data/refined"
OUT = REF / "gbrain_pages"
CATALOG = pathlib.Path(__file__).resolve().parents[1] / "seed" / "catalog.json"

KIND_KO = {"mechanism": "원리", "dose_timing": "용량·타이밍", "caveat": "주의점",
           "anecdote": "경험담", "contradiction": "반론", "recommendation": "추천"}

catalog = {i["slug"]: i for i in json.load(open(CATALOG))["ingredients"]}
kw = json.load(open(REF / "ko_keywords.json"))
# 전체 추출본(c3, 한국어 요약 포함)이 있으면 그걸, 없으면 시험 추출본을 쓴다.
CARDS_FILE = REF / "full_cards.jsonl" if (REF / "full_cards.jsonl").exists() and (REF / "full_cards.jsonl").stat().st_size > 10_000 else REF / "pilot_cards.jsonl"
cards = [json.loads(l) for l in open(CARDS_FILE)]
by_topic = collections.defaultdict(list)
for c in cards:
    if not c["is_ad"]:
        by_topic[c["topic_slug"]].append(c)


def card_topics(slug, name_en):
    core = name_en.lower().split(" (")[0].replace(" ", "-")
    return [t for t in by_topic if t in (slug, core) or t.startswith(core + "-") or slug.startswith(t + "-")]


def claims_md(items):
    lines = []
    for c in items:
        who = c["speaker"] or "출연자"
        t = int(c["start_seconds"] or 0)
        ko = f"{c['claim_ko']} / " if c.get("claim_ko") else ""
        lines.append(f"- [{KIND_KO.get(c['kind'], c['kind'])}] {who}: {ko}{c['claim']} "
                     f"([영상 {t // 60}분](https://youtu.be/{c['video_id']}?t={t}))")
    return "\n".join(lines)


def yaml_list(xs):
    return "[" + ", ".join(json.dumps(x, ensure_ascii=False) for x in xs) + "]"


shutil.rmtree(OUT, ignore_errors=True)
(OUT / "ingredients").mkdir(parents=True)
(OUT / "topics").mkdir(parents=True)
used = set()

for slug, ing in catalog.items():
    k = kw.get(slug, {})
    topics = card_topics(slug, ing["nameEn"])
    used.update(topics)
    claims = [c for t in topics for c in by_topic[t]][:12]
    ev = ing["evidence"]
    body = [
        f"# {ing['nameKo']} ({ing['nameEn']})",
        "",
        f"별칭: {', '.join(ing['aliasesKo']) or '없음'}",
        f"이럴 때 찾는다: {', '.join(k.get('keywords', []))}",
        "",
        "## 근거",
        f"- NIH 영양제 안내서: {'있음' if ev['nihFactSheet'] else '없음'}",
        f"- PubMed 체계적 문헌고찰: {ev['systematicReviews']}건",
        "",
        "## 팟캐스트에서 나온 말 (관점일 뿐, 추천 근거 아님)",
        claims_md(claims) or "- 아직 추출된 발언 없음 (시험 추출 20편 기준)",
    ]
    if ing.get("reddit"):
        body += ["", "## 커뮤니티 반응 (Reddit 요약)", ing["reddit"]]
    body += ["", "## 제품 데이터",
             f"가격·판매량은 카탈로그 표에 있다 (slug: {slug}, 아마존 예시 {len(ing['products'])}개)."]
    fm = ["---", "type: ingredient", f"title: {json.dumps(ing['nameKo'] + ' (' + ing['nameEn'] + ')', ensure_ascii=False)}",
          f"catalog_slug: {slug}", f"tags: {yaml_list(k.get('keywords', [])[:8])}", "---", ""]
    (OUT / "ingredients" / f"{slug}.md").write_text("\n".join(fm + body) + "\n")

for topic, items in by_topic.items():
    if topic in used or topic in catalog:
        continue
    k = kw.get(topic, {})
    name = k.get("nameKo") or topic
    body = [f"# {name} ({topic})", "",
            f"이럴 때 찾는다: {', '.join(k.get('keywords', []))}", "",
            "## 팟캐스트에서 나온 말 (관점일 뿐, 추천 근거 아님)", claims_md(items[:12])]
    fm = ["---", f"type: {k.get('kind', 'other')}", f"title: {json.dumps(name, ensure_ascii=False)}",
          f"tags: {yaml_list(k.get('keywords', [])[:8])}", "---", ""]
    (OUT / "topics" / f"{topic}.md").write_text("\n".join(fm + body) + "\n")

# 대시보드 검색어 거름망: 뇌가 아는 말(이름·별칭·키워드). 여기 없는 단어는 검색하지 않는다.
vocab = set()
for slug, ing in catalog.items():
    vocab.update([ing["nameKo"], ing["nameEn"].split(" (")[0], *ing["aliasesKo"], *kw.get(slug, {}).get("keywords", [])])
for topic in by_topic:
    k = kw.get(topic, {})
    vocab.update([k.get("nameKo", ""), *k.get("keywords", [])])
vocab = sorted(v for v in vocab if v and len(v) >= 2)
(CATALOG.parent / "vocab.json").write_text(json.dumps(vocab, ensure_ascii=False))
print(len(vocab), "vocab words")

print(len(list((OUT / "ingredients").glob("*.md"))), "ingredients,",
      len(list((OUT / "topics").glob("*.md"))), "topics ->", OUT)

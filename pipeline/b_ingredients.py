"""Step B: build the canonical ingredient/protocol table in data/refined/.

1. Base = mi_ingredients (376 rows).
2. Every distinct supplement_mentions.supplement_name is mapped to a canonical row:
   exact name/slug -> alias -> normalized match first, then the LLM for leftovers.
   Names with no ingredient get new rows (kind = ingredient | protocol | topic).
3. The LLM adds name_ko, aliases_ko and a cleaned aliases_en list (true synonyms
   only, used later for regex mention search) for every canonical row.
4. Outputs: data/refined/ingredients.parquet + .csv, unmapped.csv, sql/refined_schema.sql.

Resumable: LLM results are cached in data/refined/cache_b_*.json.
Reads only local snapshot files (data/raw/staging). No network writes.
"""
import sys, json, re, pathlib, csv
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from _env import ROOT, llm_json
import duckdb, pyarrow as pa, pyarrow.parquet as pq

OUT = ROOT / "data/refined"
OUT.mkdir(parents=True, exist_ok=True)
STG = ROOT / "data/raw/staging"
con = duckdb.connect()


def norm(s):
    return re.sub(r"[^a-z0-9]", "", s.lower())


def load():
    ing = con.sql(f"select id, name, slug, aliases from read_json_auto('{STG}/mi_ingredients/*.jsonl.gz')").fetchall()
    ing = [{"id": i, "name": n, "slug": s, "aliases": json.loads(a) if a else []} for i, n, s, a in ing]
    pods = [r[0] for r in con.sql(f"select distinct supplement_name from read_json_auto('{STG}/supplement_mentions/*.jsonl.gz') order by 1").fetchall()]
    return ing, pods


def cache(name):
    p = OUT / f"cache_b_{name}.json"
    return p, (json.loads(p.read_text()) if p.exists() else {})


# Reviewed by hand after the first run: the alias pass picked a broader row.
OVERRIDES = {"Omega-3": "omega-3-fatty-acids"}


def deterministic(ing, pods):
    by_name = {norm(i["name"]): i["slug"] for i in ing}
    for i in ing:  # "NMN (Nicotinamide Mononucleotide)" -> also index "NMN"
        for part in re.split(r"\(|\)", i["name"]):
            if part.strip():
                by_name.setdefault(norm(part), i["slug"])
    by_slug = {norm(i["slug"]): i["slug"] for i in ing}
    by_alias = {}
    for i in ing:
        for a in i["aliases"]:
            by_alias.setdefault(norm(a), set()).add(i["slug"])
    out = {p: {"slug": s, "method": "manual_override"} for p, s in OVERRIDES.items() if p in pods}
    for p in pods:
        if p in out:
            continue
        variants = [p] + [x.strip() for x in re.split(r"/|\(|\)", p) if x.strip()]
        hit = None
        for v in variants:
            n = norm(v)
            if n in by_name:
                hit = (by_name[n], "exact_name" if v == p else "normalized_part"); break
            if n in by_slug:
                hit = (by_slug[n], "slug"); break
        if not hit:
            for v in variants:
                n = norm(v)
                if len(by_alias.get(n, ())) == 1:
                    hit = (next(iter(by_alias[n])), "alias"); break
        if hit:
            out[p] = {"slug": hit[0], "method": hit[1]}
    return out


SYS_MAP = """You map podcast topic names to a catalog of supplement ingredients.
Return strict JSON only: {"items":[{"podcast_name":..., "match_slug": <catalog slug or null>, "kind": "ingredient"|"protocol"|"topic", "reason": <max 8 words>}]}
Rules:
- match_slug only when the podcast name means the SAME substance as the catalog entry (synonym, spelling, form). A broader or related item is NOT a match (e.g. "Fish Oil" is not "Omega-3" unless the catalog has no better entry; "Protein Powder" may match a generic protein entry).
- kind: ingredient = a substance you can take or eat (supplement, drug, food, hormone, drink). protocol = a habit, practice, diet, therapy, exercise or device-based routine. topic = an abstract concept, not an action (e.g. Neuroplasticity, Gut-Brain Axis).
- Include every input name exactly once, spelled exactly as given."""


def llm_map(leftovers, ing):
    p, c = cache("map")
    todo = [x for x in leftovers if x not in c]
    catalog = "\n".join(f"{i['slug']} | {i['name']}" for i in ing)
    for k in range(0, len(todo), 40):
        batch = todo[k:k + 40]
        def val(d):
            names = {x["podcast_name"] for x in d["items"]}
            assert set(batch) <= names, f"missing {set(batch) - names}"
            slugs = {i["slug"] for i in ing}
            for x in d["items"]:
                assert x["kind"] in ("ingredient", "protocol", "topic")
                assert x["match_slug"] in slugs or x["match_slug"] is None, x
        d = llm_json(SYS_MAP, f"CATALOG (slug | name):\n{catalog}\n\nPODCAST NAMES:\n" + "\n".join(batch), "b_map", val)
        for x in d["items"]:
            if x["podcast_name"] in batch:
                c[x["podcast_name"]] = x
        p.write_text(json.dumps(c, indent=1, ensure_ascii=False))
    return c


SYS_KO = """You are a Korean health-content editor. For each canonical item, give:
- name_ko: the natural Korean name Korean consumers and Korean health media use (e.g. Magnesium -> 마그네슘, Sunlight / Morning Light -> 아침 햇빛, Resistance Training -> 근력 운동). Hangul, not transliteration of brand names.
- aliases_ko: 0-4 other Korean ways people write it (spelling variants, common short names). No duplicates of name_ko.
- aliases_en: 0-6 English true synonyms or spellings that refer to exactly this item, useful for finding it in podcast transcripts (e.g. "vit D", "cholecalciferol"). Drop marketing phrases, product claims, and broader categories (e.g. drop "Stress Relief", "Adaptogen", "Superfood Powder").
Return strict JSON only: {"items":[{"key":..., "name_ko":..., "aliases_ko":[...], "aliases_en":[...]}]}. Include every key exactly once."""


def llm_ko(rows):
    p, c = cache("ko")
    todo = [r for r in rows if r["key"] not in c]
    batches = [todo[k:k + 12] for k in range(0, len(todo), 12)]

    def run(batch):
        keys = {r["key"] for r in batch}
        def val(d):
            got = {x["key"] for x in d["items"]}
            assert keys <= got, f"missing {keys - got}"
            for x in d["items"]:
                assert isinstance(x["name_ko"], str) and x["name_ko"].strip(), x
                assert isinstance(x["aliases_ko"], list) and isinstance(x["aliases_en"], list)
        lines = "\n".join(json.dumps({"key": r["key"], "name_en": r["name_en"], "kind": r["kind"],
                                      "existing_aliases": r["aliases"]}, ensure_ascii=False) for r in batch)
        return llm_json(SYS_KO, lines, "b_ko", val)["items"]

    with ThreadPoolExecutor(max_workers=6) as ex:
        for items in ex.map(run, batches):
            for x in items:
                c[x["key"]] = x
            p.write_text(json.dumps(c, indent=1, ensure_ascii=False))
    return c


def slugify(s):
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", s.lower())).strip("-")


def main():
    ing, pods = load()
    det = deterministic(ing, pods)
    left = [p for p in pods if p not in det]
    lm = llm_map(left, ing)
    # also let the LLM classify kind for deterministic matches (they are ingredients by construction)
    rows = {}
    for i in ing:
        rows[i["slug"]] = {"key": i["slug"], "slug": i["slug"], "name_en": i["name"], "kind": "ingredient",
                          "aliases": i["aliases"], "mi_ingredient_id": str(i["id"]), "podcast_names": []}
    mapping = []
    for p in pods:
        if p in det:
            rows[det[p]["slug"]]["podcast_names"].append(p)
            mapping.append({"podcast_name": p, "slug": det[p]["slug"], "method": det[p]["method"]})
            continue
        x = lm.get(p)
        if x is None:
            mapping.append({"podcast_name": p, "slug": None, "method": "unmapped"})
            continue
        if x["match_slug"]:
            rows[x["match_slug"]]["podcast_names"].append(p)
            mapping.append({"podcast_name": p, "slug": x["match_slug"], "method": "llm"})
        else:
            s = slugify(p)
            if s in rows:
                s = s + "-p"
            rows[s] = {"key": s, "slug": s, "name_en": p, "kind": x["kind"], "aliases": [],
                       "mi_ingredient_id": None, "podcast_names": [p]}
            mapping.append({"podcast_name": p, "slug": s, "method": f"new_{x['kind']}"})
    ko = llm_ko(list(rows.values()))
    recs = []
    for n, (k, r) in enumerate(sorted(rows.items())):
        kx = ko.get(k)
        recs.append({
            "canonical_id": k, "slug": r["slug"], "name_en": r["name_en"],
            "name_ko": kx["name_ko"] if kx else None, "kind": r["kind"],
            "aliases_en": sorted({a.strip() for a in (kx["aliases_en"] if kx else []) if a.strip() and a.strip().lower() != r["name_en"].lower()}),
            "aliases_ko": sorted({a.strip() for a in (kx["aliases_ko"] if kx else []) if a.strip() and a.strip() != (kx or {}).get("name_ko")}),
            "mi_ingredient_id": r["mi_ingredient_id"], "podcast_names": sorted(r["podcast_names"]),
            "mi_aliases_raw": r["aliases"],
        })
    schema = pa.schema([("canonical_id", pa.string()), ("slug", pa.string()), ("name_en", pa.string()),
                        ("name_ko", pa.string()), ("kind", pa.string()), ("aliases_en", pa.list_(pa.string())),
                        ("aliases_ko", pa.list_(pa.string())), ("mi_ingredient_id", pa.string()),
                        ("podcast_names", pa.list_(pa.string())), ("mi_aliases_raw", pa.list_(pa.string()))])
    pq.write_table(pa.Table.from_pylist(recs, schema), OUT / "ingredients.parquet")
    with open(OUT / "ingredients.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(schema.names)
        for r in recs:
            w.writerow([("|".join(v) if isinstance(v, list) else ("" if v is None else v)) for v in r.values()])
    with open(OUT / "podcast_name_mapping.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["podcast_name", "slug", "method"]); w.writeheader(); w.writerows(mapping)
    unm = [m for m in mapping if m["slug"] is None] + [{"podcast_name": r["name_en"], "slug": r["slug"], "method": "missing_korean"} for r in recs if not r["name_ko"]]
    with open(OUT / "unmapped.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["podcast_name", "slug", "method"]); w.writeheader(); w.writerows(unm)
    from collections import Counter
    print("canonical rows", len(recs), Counter(r["kind"] for r in recs))
    print("mapping methods", Counter(m["method"] for m in mapping))
    print("unmapped", len(unm))


if __name__ == "__main__":
    main()

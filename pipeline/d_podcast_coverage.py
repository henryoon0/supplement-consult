"""Count, per mi ingredient, how many transcripts mention it (name, aliases, and name with generic qualifiers stripped). Writes data/refined/ingredient_podcast_coverage_v2.json."""
import duckdb, re, json
QUAL = r'\b(peptides?|extract|complex|supplement|powder|oil|capsules?|gummies|blend|support|formula|root|leaf|seed)\b'
GENERIC = {'vitamin','liver','sleep','heart','joint','brain','immune','energy','black','green','red','white','sea','fish','whole','super','daily','natural','organic'}
c = duckdb.connect('data/raw/axhub.duckdb', read_only=True)
c.execute("create temp table t as select video_id, lower(transcript_text) tx from youtube_videos where has_transcript and transcript_text is not null")
ing = c.execute("select slug,name_en,aliases_en,mi_ingredient_id from read_parquet('data/refined/ingredients.parquet') where mi_ingredient_id is not null").fetchall()
res = {}
for slug, name, al, mid in ing:
    terms = {name.lower()} | {a.lower() for a in (al or [])}
    stripped = re.sub(r'\s+', ' ', re.sub(QUAL, ' ', name.lower())).strip(' ()-')
    if stripped and stripped not in GENERIC and len(stripped) >= 4: terms.add(stripped)
    terms = {x for x in terms if len(x) >= 4 and x != 'same'}
    if not terms: res[mid] = [slug, 0, []]; continue
    pat = r'\b(' + '|'.join(re.escape(x) for x in sorted(terms)) + r')\b'
    n = c.execute("select count(*) from t where regexp_matches(tx, ?)", [pat]).fetchone()[0]
    res[mid] = [slug, n, sorted(terms)]
json.dump(res, open('data/refined/ingredient_podcast_coverage_v2.json', 'w'))
print('done', len(res))

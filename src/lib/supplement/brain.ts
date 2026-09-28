import { promises as fs } from "fs";
import path from "path";

// 보충제 지식 뇌(GBrain) 검색. 지식(성분·근거·팟캐스트 발언)은 GBrain 페이지에 있고,
// 숫자(가격·판매량)는 catalog.json 에 있다. 페이지는 body-brain/scripts/f_gbrain_pages.py 가 만든다.
//
// GBrain 의 한국어 검색은 단어별 부분 일치(ILIKE)를 "모두 포함(AND)"으로 묶는다.
// "잠이 얕아서 밤에 깨요"를 그대로 넣으면 0건이라, 질문을 단어로 쪼개 조사·어미를 떼고
// 단어마다 따로 검색해 합친다(OR).

export type BrainPage = { slug: string; title: string; text: string; hits: number };


// 긴 것부터 떼야 "먹으면"이 "면"만 떨어지고 끝나지 않는다.
const ENDINGS = [
  "이에요", "예요", "이라", "해서", "아서", "어서", "하고", "하면", "으면", "는데", "한데", "지만", "니까",
  "해요", "어요", "아요", "해", "이랑", "랑", "에서", "에게", "한테", "까지", "부터", "으로", "로",
  "이", "가", "을", "를", "은", "는", "에", "도", "만", "요", "고", "게", "면", "서", "나", "야", "지",
];

const STOP = new Set([
  "요즘", "너무", "진짜", "그냥", "먹어", "먹으", "먹는", "먹을", "먹고", "먹어도", "뭐", "뭘", "사면", "사", "돼",
  "되", "좋", "좋아", "추천", "어떤", "어떻", "얼마", "얼마나", "하나", "좀", "자주", "많이", "있어", "있", "없",
  "나아", "나아져", "궁금", "좋을까", "좋을", "조금", "챙겨", "번씩", "안좋아", "남편", "아내", "엄마", "아빠", "하는", "해도", "같", "때", "것", "거", "이거", "그거", "영양제", "제품",
]);

// 흔한 말 → 페이지 키워드로 쓴 말.
const SYNONYM: Record<string, string> = { 잠: "수면", 입병: "구내염", 헬스: "근육", 피곤: "피로", 피곤해: "피로", 기운: "피로", 웨이트: "근육", 살: "다이어트" };

/**
 * 뇌가 아는 말(페이지 이름·별칭·키워드)로 검색어를 거른다.
 * "오후", "3시", "3년째" 같은 말이 검색 칸을 차지해 정작 성분 이름이 잘리던 문제(09-28 실측, 30문항).
 * 단어가 어휘를 품으면("마그네슘글리시네이트") 어휘 쪽 말로, 어휘가 단어를 품으면 단어 그대로 쓴다.
 */
export function filterByVocab(terms: string[], vocab: readonly string[]): string[] {
  const out: string[] = [];
  for (const t of terms) {
    const lower = t.toLowerCase();
    const inside = vocab.find((v) => v.toLowerCase().includes(lower));
    const contains = inside ? undefined : vocab.filter((v) => lower.includes(v.toLowerCase())).sort((a, b) => b.length - a.length)[0];
    const pick = inside ? t : contains;
    if (pick && !out.includes(pick)) out.push(pick);
  }
  return out;
}

let vocabCache: string[] | null = null;
async function readVocab(): Promise<string[]> {
  if (vocabCache) return vocabCache;
  const file =
    process.env.SUPPLEMENT_VOCAB_PATH ??
    path.join(process.cwd(), "seed", "vocab.json");
  try {
    vocabCache = JSON.parse(await fs.readFile(file, "utf8")) as string[];
  } catch {
    vocabCache = []; // 어휘가 없으면 거르지 않는다(아래에서 원래 단어를 쓴다)
  }
  return vocabCache;
}

export function queryTerms(question: string, max = 5, known?: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const raw of question.replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/)) {
    let w = raw.trim();
    if (!w) continue;
    // "피곤해도"처럼 어미가 겹치면 두 번까지 뗀다.
    for (let pass = 0; pass < 2; pass++) {
      if (known?.has(w)) break; // "수면"의 "면"을 어미로 잘라 "수"만 남던 문제
      const e = ENDINGS.find((x) => w.endsWith(x) && w.length - x.length >= 1);
      if (!e) break;
      w = w.slice(0, -e.length);
    }
    w = SYNONYM[w] ?? w;
    const isAscii = /^[\x00-\x7f]+$/.test(w);
    if (STOP.has(w) || (!isAscii && w.length < 2) || (isAscii && w.length < 3)) continue;
    if (!out.includes(w)) out.push(w);
  }
  return out.slice(0, max);
}

/**
 * 거름망까지 거친 검색어. 어휘에 걸린 게 없으면 검색하지 않는다(빈 배열).
 * 아무 단어로나 찾으면 엉뚱한 페이지가 "찾은 페이지"로 떠서 오히려 믿음을 깎는다.
 */
async function searchTerms(question: string): Promise<string[]> {
  const vocab = await readVocab();
  const raw = queryTerms(question, 12, new Set(vocab));
  if (!vocab.length) return raw.slice(0, 5);
  const kept = filterByVocab(raw, vocab);
  return kept.slice(0, 5);
}

type RawHit = { slug: string; title: string; chunk_text: string };

// ── 지식 페이지 검색 (앱 안) ──
// 원래는 GBrain(별도 설치 프로그램)으로 찾았다. 공유본은 설치를 줄이려고 같은 페이지(seed/pages/*.md)를
// 앱 안에서 찾는다. GBrain 과 같게: 단어 하나가 제목·본문에 들어간 페이지를 최대 5개, 제목에 든 것이 먼저.

type Page = { slug: string; title: string; tags: string; body: string; haystack: string };

let pagesCache: Page[] | null = null;

export function pagesDir(): string {
  return process.env.SUPPLEMENT_PAGES_DIR ?? path.join(process.cwd(), "seed", "pages");
}

/** "---\n...\n---" 머리 정보를 떼고 제목을 꺼낸다. */
export function parsePage(slug: string, raw: string): Page {
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  const body = (fm ? raw.slice(fm[0].length) : raw).trim();
  const title = fm?.[1].match(/^title:\s*"?(.*?)"?\s*$/m)?.[1] ?? slug;
  const tags = fm?.[1].match(/^tags:\s*(.*)$/m)?.[1] ?? "";
  return { slug, title, tags: tags.toLowerCase(), body, haystack: `${title}\n${tags}\n${body}`.toLowerCase() };
}

async function loadPages(): Promise<Page[]> {
  if (pagesCache) return pagesCache;
  const out: Page[] = [];
  for (const kind of ["ingredients", "topics"]) {
    const dir = path.join(pagesDir(), kind);
    for (const f of await fs.readdir(dir).catch(() => [] as string[])) {
      if (!f.endsWith(".md")) continue;
      out.push(parsePage(`${kind}/${f.slice(0, -3)}`, await fs.readFile(path.join(dir, f), "utf8")));
    }
  }
  pagesCache = out;
  return out;
}

/** 단어 하나로 찾은 페이지 최대 5개: 제목에 든 것 → "이럴 때 찾는다" 태그에 든 것 → 많이 나온 것 순. */
export function searchPages(pages: readonly Page[], term: string, limit = 5): RawHit[] {
  const t = term.toLowerCase();
  const count = (s: string) => s.split(t).length - 1;
  return pages
    .filter((p) => p.haystack.includes(t))
    .map((p) => ({ p, score: (p.title.toLowerCase().includes(t) ? 100 : 0) + (p.tags.includes(t) ? 50 : 0) + count(p.haystack) }))
    .sort((a, b) => b.score - a.score || a.p.slug.localeCompare(b.p.slug))
    .slice(0, limit)
    .map(({ p }) => ({ slug: p.slug, title: p.title, chunk_text: p.body }));
}

async function searchOne(term: string): Promise<RawHit[]> {
  return searchPages(await loadPages(), term);
}

/** 페이지 원문(마크다운). 화면에서 "이 페이지 보기"에 쓴다. */
export async function getBrainPage(slug: string): Promise<string | null> {
  if (!/^(ingredients|topics)\/[a-z0-9-]+$/.test(slug)) return null;
  return fs.readFile(path.join(pagesDir(), `${slug}.md`), "utf8").catch(() => null);
}

/** 단어별로 검색해 합친다. 여러 단어에 걸린 페이지가 위로 온다. */
export async function searchBrain(question: string, limit = 5): Promise<{ terms: string[]; pages: BrainPage[] }> {
  const terms = await searchTerms(question);
  const results = await Promise.all(terms.map(searchOne));
  const merged = new Map<string, BrainPage>();
  results.forEach((hits) =>
    hits.forEach((h, rank) => {
      const prev = merged.get(h.slug);
      const bonus = 1 + (5 - rank) / 10; // 같은 단어 안에서는 순위가 높을수록 조금 더
      if (prev) prev.hits += bonus;
      else merged.set(h.slug, { slug: h.slug, title: h.title, text: h.chunk_text.slice(0, 1600), hits: bonus });
    })
  );
  const pages = [...merged.values()].sort((a, b) => b.hits - a.hits).slice(0, limit);
  return { terms, pages };
}

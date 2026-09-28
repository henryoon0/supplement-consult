import { promises as fs } from "fs";
import path from "path";

// 말투 원천: @glp1.pharmacy(박약사) 스레드의 실제 질문·답글 쌍.
// 수집본 = data/domains/wellness/threads-comments/glp1-pharmacy-qa-pairs.json
// 처방약(주사제) 권유와 특정 회사 제품 언급은 규제 위험이 있어 예시에서 뺀다.

export type QaPair = { q: string; a: string };

const EXCLUDE = /마운자로|위고비|삭센다|젭바운드|글리프|주사|펜/;

function pairsPath(): string {
  return (
    process.env.SUPPLEMENT_VOICE_PATH ??
    path.join(process.cwd(), "seed", "voice-pairs.json")
  );
}

let cached: QaPair[] | null = null;

export async function readVoicePairs(): Promise<QaPair[]> {
  if (cached) return cached;
  const raw = JSON.parse(await fs.readFile(pairsPath(), "utf8")) as { pairs: QaPair[] };
  cached = raw.pairs.filter((p) => p.a.length >= 30 && !EXCLUDE.test(p.q + p.a));
  return cached;
}

function bigrams(text: string): Set<string> {
  const s = text.replace(/\s+/g, "");
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

/** 질문과 글자가 가장 많이 겹치는 예시 k개. 말투는 주제가 비슷할 때 가장 잘 옮는다. */
export function pickExamples(pairs: QaPair[], question: string, k = 6): QaPair[] {
  const target = bigrams(question);
  return pairs
    .map((p) => {
      const b = bigrams(p.q);
      let hit = 0;
      for (const g of b) if (target.has(g)) hit++;
      return { p, score: hit / Math.sqrt(b.size + 1) };
    })
    .sort((x, y) => y.score - x.score)
    .slice(0, k)
    .map((x) => x.p);
}

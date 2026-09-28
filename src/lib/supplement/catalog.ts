import { promises as fs } from "fs";
import path from "path";

// 보충제 추천 PoC의 카탈로그. 원본은 body-brain 저장소가 만든다
// (body-brain/scripts/e_dashboard_catalog.py → 아래 기본 경로).
// 숫자(가격·판매량)는 전부 그 파일에서 오고, AI는 여기 없는 제품을 말할 수 없다.

export type CatalogProduct = {
  brand: string;
  title: string;
  price: number;
  rating: number;
  reviews: number;
  monthlySold: number | null;
  form: string | null;
  servings: number | null;
  asin: string;
};

export type PodcastClaim = {
  speaker: string;
  kind: string;
  claim: string;
  /** 한국어 한 줄 요약 (전체 추출 c3 부터). 없으면 claim 을 쓴다. */
  claimKo?: string;
  /** 자막 원문(영어) 인용. */
  quote: string;
  videoId: string;
  /** 발언 시작 초 */
  t: number;
  title: string;
  channel: string;
  /** 영상 길이(초). 모르면 0 */
  duration: number;
};

export type CatalogIngredient = {
  slug: string;
  nameEn: string;
  nameKo: string;
  aliasesKo: string[];
  evidence: { nihFactSheet: boolean; systematicReviews: number };
  podcast: PodcastClaim[];
  reddit: string;
  products: CatalogProduct[];
};

export type Catalog = { builtAt: string; ingredients: CatalogIngredient[] };

function catalogPath(): string {
  return (
    process.env.SUPPLEMENT_CATALOG_PATH ??
    path.join(process.cwd(), "seed", "catalog.json")
  );
}

let cached: { mtimeMs: number; catalog: Catalog } | null = null;

export async function readCatalog(): Promise<Catalog> {
  const file = catalogPath();
  const stat = await fs.stat(file);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.catalog;
  const catalog = JSON.parse(await fs.readFile(file, "utf8")) as Catalog;
  cached = { mtimeMs: stat.mtimeMs, catalog };
  return catalog;
}

/** 근거 강도를 사람이 읽는 한 줄로. 등급을 지어내지 않고 있는 사실만 말한다. */
export function evidenceLabel(e: CatalogIngredient["evidence"]): string {
  const parts: string[] = [];
  if (e.nihFactSheet) parts.push("NIH 안내서 있음");
  if (e.systematicReviews > 0) parts.push(`문헌고찰 ${e.systematicReviews.toLocaleString()}건`);
  return parts.join(" · ") || "근거 자료 적음";
}

/** 프롬프트에 싣는 성분 목록. 한 줄 = slug|한국어명|근거. */
export function catalogIndex(catalog: Catalog): string {
  return catalog.ingredients
    .map((i) => `${i.slug}|${i.nameKo}|${evidenceLabel(i.evidence)}`)
    .join("\n");
}

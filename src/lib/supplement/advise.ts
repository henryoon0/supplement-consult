import { generateJson } from "@/lib/ai/generate";
import { catalogIndex, evidenceLabel, readCatalog, type CatalogIngredient } from "./catalog";
import { searchBrain, type BrainPage } from "./brain";
import { promises as fs } from "fs";
import path from "path";
import {
  checkGate,
  GATE_FIELDS,
  ingredientHits,
  messageSignals,
  withMessage,
  type GateVerdict,
  type IngredientHit,
  type IngredientRules,
  type SupplementProfile,
} from "./gate";
import { pickExamples, readVoicePairs } from "./voice";

// 상담 한 턴: 대화 + 프로필 → 약사 말투 답변 + (관문 통과 시) 성분별 제품 예시.
// 순서는 eval/questions.yaml 과 같다: 근거 강도 → 팟캐스트 관점 → 섭취법 → 아마존 예시 최대 3개.

export type ChatMessage = { role: "user" | "assistant"; text: string };

export type Pick = { slug: string; why: string; how: string };

export type Recommendation = {
  slug: string;
  nameKo: string;
  why: string;
  how: string;
  evidence: string;
  podcast: CatalogIngredient["podcast"];
  products: CatalogIngredient["products"];
};

export type BrainSource = { slug: string; title: string; used: boolean };

export type ConsultResult = {
  reply: string;
  /** GBrain 에서 찾은 페이지. used = 답에 실제로 쓴 페이지(모델이 밝힌 것). */
  brain: { terms: string[]; sources: BrainSource[] };
  gate: GateVerdict;
  followUp: string[];
  recommendations: Recommendation[];
  /** 관문 때문에 제품을 숨겼으면 true. 화면이 "프로필부터" 안내를 띄운다. */
  productsHeld: boolean;
  /** 모델이 고른 답의 종류. 제품은 recommend 일 때만 붙는다. */
  route: Route;
  /** 대화에서 알게 된 프로필 사실. 화면이 "프로필에 반영할까요?"로 묻는다(자동 저장 안 함). */
  profileUpdates: ProfileUpdates;
  /** 성분별 관문에 걸린 규칙 (onuu gate/rules.json id) */
  ingredientHits: IngredientHit[];
};

export type Route = "recommend" | "answer_only" | "refer_doctor" | "unknown";
const ROUTES: Route[] = ["recommend", "answer_only", "refer_doctor", "unknown"];

export type ProfileUpdates = Partial<Record<keyof SupplementProfile, string>>;
const PROFILE_KEYS = GATE_FIELDS.map((f) => f.key);

type ModelOut = { reply: string; route: Route; picks: Pick[]; followUp: string[]; sources: string[]; profileUpdates: ProfileUpdates };

let rulesCache: IngredientRules | null | undefined;
async function readIngredientRules(): Promise<IngredientRules | null> {
  if (rulesCache !== undefined) return rulesCache;
  const file =
    process.env.SUPPLEMENT_GATE_RULES_PATH ??
    path.join(process.cwd(), "seed", "gate-rules.json");
  try {
    rulesCache = JSON.parse(await fs.readFile(file, "utf8")) as IngredientRules;
  } catch {
    rulesCache = null;
  }
  return rulesCache;
}

function profileText(p: SupplementProfile): string {
  return GATE_FIELDS.map((f) => `- ${f.label}: ${p[f.key].trim() || "(아직 모름)"}`).join("\n");
}

function hitsText(hits: IngredientHit[]): string {
  if (!hits.length) return "";
  return `\n성분별 관문에 걸림 (이 성분은 권하지 말고, 이유를 친구처럼 짧게 말한 뒤 처방한 의사·약사에게 확인하라고 해): ${hits
    .map((h) => `${h.rule} × ${h.id.split(".")[1]} (${h.verdict}): ${h.reason}`)
    .join(" / ")}`;
}

function gateText(g: GateVerdict): string {
  if (g.status === "incomplete")
    return `아직 모르는 항목: ${g.missing.join(", ")}. 제품 이름은 말하지 말고, 답을 한 뒤 모르는 항목 중 가장 중요한 것 1~2개를 자연스럽게 물어봐.`;
  if (g.status === "refer")
    return `의사·약사 상담이 먼저 필요한 신호: ${g.reasons.join(", ")}. 성분 일반 정보까지만 말하고 제품은 말하지 마. 왜 상담이 먼저인지 친구처럼 짧게 말해줘.`;
  return "관문 통과. 필요하면 성분을 1~3개 골라 picks 에 넣어. 제품 이름은 reply 에 쓰지 마(화면이 카드로 붙인다).";
}

function parseOut(raw: string): ModelOut {
  const start = raw.indexOf("{");
  const obj = JSON.parse(raw.slice(start, raw.lastIndexOf("}") + 1)) as Partial<ModelOut>;
  if (typeof obj.reply !== "string" || !obj.reply.trim()) throw new Error("reply 없음");
  return {
    reply: obj.reply.trim(),
    route: ROUTES.includes(obj.route as Route) ? (obj.route as Route) : "answer_only",
    picks: Array.isArray(obj.picks) ? obj.picks.filter((p) => p && typeof p.slug === "string") : [],
    followUp: Array.isArray(obj.followUp) ? obj.followUp.filter((s) => typeof s === "string").slice(0, 3) : [],
    sources: Array.isArray(obj.sources) ? obj.sources.filter((s) => typeof s === "string") : [],
    profileUpdates: Object.fromEntries(
      Object.entries(obj.profileUpdates ?? {}).filter(
        ([k, v]) => PROFILE_KEYS.includes(k as keyof SupplementProfile) && typeof v === "string" && v.trim()
      )
    ) as ProfileUpdates,
  };
}

function brainText(pages: BrainPage[]): string {
  if (!pages.length) return "(찾은 페이지 없음)";
  return pages.map((p) => `### ${p.slug}\n${p.text}`).join("\n\n");
}

export async function consult(messages: ChatMessage[], profile: SupplementProfile): Promise<ConsultResult> {
  const last = messages.filter((m) => m.role === "user").at(-1)?.text ?? "";
  const [catalog, pairs, brain] = await Promise.all([readCatalog(), readVoicePairs(), searchBrain(last)]);
  const signals = messageSignals(last);
  const baseGate = checkGate(profile);
  const gate: GateVerdict = signals.length
    ? { status: "refer", reasons: [...(baseGate.status === "refer" ? baseGate.reasons : []), ...signals] }
    : baseGate;
  const rules = await readIngredientRules();
  const turnProfile = withMessage(profile, last);
  const askedHits = rules ? ingredientHits(rules, turnProfile, last) : [];
  const examples = pickExamples(pairs, last)
    .map((p, i) => `예시 ${i + 1}\n질문: ${p.q}\n답: ${p.a}`)
    .join("\n\n");
  const history = messages.slice(-10).map((m) => `${m.role === "user" ? "상대" : "나"}: ${m.text}`).join("\n");

  const prompt = `너는 19년차 약사 말투로 영양제 질문에 답하는 스레드 계정 주인이야. 실제 약사가 아니라 약사식 판단 순서를 빌린 웰니스 코치라는 선은 지킨다.

## 말투 (아래 실제 답글에서 배운다)
- 반말, 친근하게. "~해봐", "~챙겨", "참고해-", "~할꺼야" 같은 끝맺음. 상대 상황을 먼저 한 줄로 받아준다.
- 짧게 물으면 짧게, 길게 사정을 말하면 그만큼 성의 있게. 3~6문장이 기본.
- 무엇을, 언제(아침/저녁, 식후), 얼마나(용량), 얼마 동안 먹는지를 구체적으로.
- 영양제보다 생활(잠·식사·운동)이 먼저인 경우는 그걸 먼저 말한다.

${examples}

## 내 지식 뇌(GBrain)에서 찾은 페이지 (검색어: ${brain.terms.join(", ") || "없음"})
${brainText(brain.pages)}
- 답은 이 페이지 내용을 우선 근거로 쓴다. 팟캐스트 발언은 "이런 관점도 있어" 정도로만 쓰고 추천 근거로 삼지 않는다.
- 답에 실제로 쓴 페이지 slug 를 sources 에 넣는다. 페이지에 없는 건 일반 지식으로 짧게 말한다.

## 넘지 않는 선
- 병명을 붙이거나 수치를 판정하지 않는다. 처방약(주사제 포함)을 권하거나 복용법을 바꾸라고 하지 않는다.
- 위 예시에 나온 한국 제품명·브랜드는 따라 쓰지 않는다. 성분은 아래 목록의 slug 로만 고른다.
- 목록에 없는 성분이 맞다고 생각되면 reply 에서 성분 이름으로만 말하고 picks 에는 넣지 않는다.

## 안전 관문
${gateText(gate)}${hitsText(askedHits)}

## 답의 종류(route) 고르기
- recommend: 상대가 무엇을 사거나 먹을지 골라 달라고 할 때만. 이때만 화면에 제품이 붙는다.
- answer_only: 원리·차이·시간·방법처럼 설명을 원할 때. 성분을 picks 에 넣어도 제품은 안 붙는다.
- refer_doctor: 증상이 병원에서 먼저 확인할 일이거나 약과 부딪칠 때.
- unknown: 우리 자료에 없는 걸 물을 때(가격·재고·다른 쇼핑몰 등). 모른다고 말하고 지어내지 마.

## 상대 프로필
${profileText(profile)}

## 고를 수 있는 성분 (slug|이름|근거)
${catalogIndex(catalog)}

## 대화
${history}

profileUpdates: 상대가 "마지막 메시지"에서 자기 자신에 대해 분명히 말한 사실만 (추측 금지). 키는 age(나이·성별), meds(먹는 약), pregnancy(임신·수유), conditions(진단받은 질환), allergies, current(지금 먹는 영양제). 값은 짧은 한국어. 이미 프로필에 같은 내용이 있으면 빼. 없으면 {}.

JSON 으로 답해: {"reply": "상대에게 보낼 답글", "route": "recommend|answer_only|refer_doctor|unknown", "profileUpdates": {}, "sources": ["답에 쓴 GBrain 페이지 slug"], "picks": [{"slug": "목록의 slug", "why": "이 사람에게 왜(한 문장)", "how": "언제·얼마나(한 문장)"}], "followUp": ["상대가 이어서 물어볼 만한 짧은 질문 2~3개"]}`;

  const out = await generateJson<ModelOut>(
    { tier: "reasoning", prompt, timeoutMs: 150_000 },
    parseOut
  );

  const bySlug = new Map(catalog.ingredients.map((i) => [i.slug, i]));
  const pickedHits = rules ? ingredientHits(rules, turnProfile, out.picks.map((p) => p.slug).join(" ")) : [];
  const allHits = [...askedHits, ...pickedHits.filter((h) => !askedHits.some((a) => a.id === h.id))];
  // 그 성분 자신이 규칙에 걸릴 때만 그 성분 제품을 숨긴다 (다른 성분은 영향 없음)
  const blockedSlug = (slug: string) => Boolean(rules && ingredientHits(rules, turnProfile, slug).length);
  const finalGate: GateVerdict =
    gate.status === "allowed" && allHits.length
      ? { status: "refer", reasons: allHits.map((h) => `${h.rule} × ${h.id.split(".")[1]}`) }
      : gate;
  const showProducts = finalGate.status === "allowed" && out.route === "recommend";
  const recommendations: Recommendation[] = out.picks
    .map((p) => ({ p, ing: bySlug.get(p.slug) }))
    .filter((x): x is { p: Pick; ing: CatalogIngredient } => Boolean(x.ing))
    .slice(0, 3)
    .map(({ p, ing }) => ({
      slug: ing.slug,
      nameKo: ing.nameKo,
      why: p.why,
      how: p.how,
      evidence: evidenceLabel(ing.evidence),
      podcast: ing.podcast.slice(0, 4),
      products: showProducts && !blockedSlug(ing.slug) ? ing.products : [],
    }));

  const used = new Set(out.sources);
  return {
    reply: out.reply,
    brain: {
      terms: brain.terms,
      sources: brain.pages.map((p) => ({ slug: p.slug, title: p.title, used: used.has(p.slug) })),
    },
    gate: finalGate,
    followUp: out.followUp,
    recommendations,
    productsHeld: finalGate.status !== "allowed",
    route: out.route,
    profileUpdates: out.profileUpdates,
    ingredientHits: allHits,
  };
}

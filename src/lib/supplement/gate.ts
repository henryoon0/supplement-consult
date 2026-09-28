// 안전 관문(Safety Gate). 제품 이름을 말하기 전에 꼭 확인할 다섯 가지.
// 판정은 AI가 아니라 이 코드가 한다: 빈칸이 있으면 제품을 붙이지 않고,
// 의사와 먼저 상의해야 하는 단어가 보이면 제품 대신 의사 상담으로 돌린다.
// 규칙 초안은 onuu gate/rules.json(약사 검토 전)과 같은 방향이다.

export type SupplementProfile = {
  age: string;
  meds: string; // 복용 중인 약
  pregnancy: string; // 임신·수유·임신 준비
  conditions: string; // 진단받은 질환
  allergies: string;
  current: string; // 지금 먹는 영양제
};

export const GATE_FIELDS: ReadonlyArray<{ key: keyof SupplementProfile; label: string; hint: string }> = [
  { key: "age", label: "나이·성별", hint: "예: 34 남" },
  { key: "meds", label: "먹는 약", hint: "없으면 없음" },
  { key: "pregnancy", label: "임신·수유", hint: "해당 없음 / 임신 준비 중 …" },
  { key: "conditions", label: "진단받은 질환", hint: "없으면 없음" },
  { key: "allergies", label: "알레르기", hint: "없으면 없음" },
  { key: "current", label: "먹는 영양제", hint: "없으면 없음" },
];

export const EMPTY_PROFILE: SupplementProfile = {
  age: "",
  meds: "",
  pregnancy: "",
  conditions: "",
  allergies: "",
  current: "",
};

// 이 단어가 약·질환·임신 칸에 있으면 제품 대신 의사·약사 상담으로 보낸다.
const REFER_WORDS = [
  "와파린", "항응고", "아스피린", "엘리퀴스", "자렐토",
  "임신", "수유", "모유",
  "신장", "콩팥", "투석", "간경화", "간질환",
  "항암", "이식", "면역억제",
  "갑상선약", "씬지로이드", "리튬",
  // 영어 약·질환명 (eval 가상 프로필과 영문 처방전). 09-28 채점에서 이 빈틈으로 위험군에 제품이 나갔다.
  "warfarin", "coumadin", "apixaban", "eliquis", "rivaroxaban", "xarelto", "clopidogrel", "anticoagul", "blood thinner",
  "pregnan", "breastfeed", "breast-feed", "lactat", "trying to conceive", "ttc", "ivf",
  "kidney", "ckd", "dialysis", "cirrhosis", "liver disease", "hepatitis",
  "chemo", "transplant", "tacrolimus", "cyclosporine", "immunosuppress", "lithium",
  "sertraline", "fluoxetine", "escitalopram", "citalopram", "paroxetine", "ssri", "snri", "maoi",
  "levothyroxine", "synthroid",
];

const NEGATIONS = ["없음", "없어", "없다", "해당 없음", "해당없음", "no", "none", "x", "-"];

function isNegation(value: string): boolean {
  const v = value.trim().toLowerCase();
  return NEGATIONS.some((n) => v === n || v.startsWith(`${n} `));
}

export type GateVerdict =
  | { status: "incomplete"; missing: string[] }
  | { status: "refer"; reasons: string[] }
  | { status: "allowed" };

/**
 * 이번 메시지에 쓴 약·질환을 이번 턴 판정에 바로 넣은 프로필. "와파린 먹는데 …"라고 말하면
 * 프로필 칸을 채우기 전이라도 관문이 작동한다. "없음" 칸은 메시지로 덮어쓴다.
 * 부정문("와파린 안 먹어")도 걸릴 수 있지만, 안전 쪽으로 틀리는 편을 고른다.
 */
export function withMessage(profile: SupplementProfile, message: string): SupplementProfile {
  const add = (v: string) => (isNegation(v) || !v.trim() ? message : `${v} / ${message}`);
  return { ...profile, meds: add(profile.meds), conditions: add(profile.conditions) };
}

/** 메시지 글에서만 찾은 위험 신호. 프로필이 비어 있어도(incomplete) 이게 있으면 의사 상담이 먼저다. */
export function messageSignals(message: string): string[] {
  const lower = message.toLowerCase();
  return REFER_WORDS.filter((w) => lower.includes(w)).map((w) => `${w}(대화)`);
}

export function checkGate(profile: SupplementProfile): GateVerdict {
  const missing = GATE_FIELDS.filter((f) => !profile[f.key].trim()).map((f) => f.label);
  if (missing.length) return { status: "incomplete", missing };

  const reasons: string[] = [];
  for (const key of ["meds", "pregnancy", "conditions"] as const) {
    const value = profile[key];
    if (isNegation(value)) continue;
    const lower = value.toLowerCase();
    for (const word of REFER_WORDS) {
      if (lower.includes(word)) reasons.push(`${word}(${GATE_FIELDS.find((f) => f.key === key)?.label})`);
    }
  }
  return reasons.length ? { status: "refer", reasons } : { status: "allowed" };
}

// ---- 성분별 관문: onuu gate/rules.json (약사 검토 전 초안) 을 그대로 쓴다 ----
// 파일: data/domains/wellness/body-brain/gate-rules.json (onuu 에서 복사). 없으면 성분별 검사는 건너뛴다.

export type IngredientRules = {
  pregnancy: { synonyms: string[] };
  ingredients: Record<
    string,
    {
      synonyms: string[];
      medications: { id: string; synonyms: string[]; verdict: "hold" | "refer_to_doctor"; reason: string }[];
      conditions?: { id: string; synonyms: string[]; verdict: "hold" | "refer_to_doctor"; reason: string }[];
    }
  >;
};

// 카탈로그 slug·한국어 이름 → 규칙 키
const RULE_ALIASES: Record<string, string[]> = {
  "magnesium-glycinate": ["magnesium", "magnesium-threonate", "마그네슘"],
  glycine: ["glycine", "글리신"],
  "l-theanine": ["l-theanine", "theanine", "테아닌"],
  ashwagandha: ["ashwagandha", "아쉬와간다", "아슈와간다"],
};

export type IngredientHit = { rule: string; id: string; verdict: "hold" | "refer_to_doctor"; reason: string };

/** 성분(질문 글 또는 고른 slug)에 걸리는 약·질환 규칙. 프로필의 약·질환 칸을 부분 일치로 본다. */
export function ingredientHits(rules: IngredientRules, profile: SupplementProfile, mentioned: string): IngredientHit[] {
  const text = mentioned.toLowerCase();
  const meds = isNegation(profile.meds) ? "" : profile.meds.toLowerCase();
  const conds = isNegation(profile.conditions) ? "" : profile.conditions.toLowerCase();
  const hits: IngredientHit[] = [];
  for (const [key, rule] of Object.entries(rules.ingredients)) {
    const names = [...rule.synonyms, ...(RULE_ALIASES[key] ?? [])].map((x) => x.toLowerCase());
    if (!names.some((n) => text.includes(n))) continue;
    for (const m of rule.medications) if (m.synonyms.some((s) => meds.includes(s.toLowerCase()))) hits.push({ rule: key, id: `${key}.${m.id}`, verdict: m.verdict, reason: m.reason });
    for (const c of rule.conditions ?? []) if (c.synonyms.some((s) => conds.includes(s.toLowerCase()))) hits.push({ rule: key, id: `${key}.${c.id}`, verdict: c.verdict, reason: c.reason });
  }
  return hits;
}

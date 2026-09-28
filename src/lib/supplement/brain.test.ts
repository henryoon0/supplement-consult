import { describe, expect, it } from "vitest";
import { filterByVocab, queryTerms } from "./brain";

describe("queryTerms", () => {
  it("조사·어미를 떼고 흔한 말을 페이지 키워드로 바꾼다", () => {
    expect(queryTerms("요즘 잠이 얕아서 밤에 두 번씩 깨. 마그네슘 먹으면 나아져?")).toEqual(
      expect.arrayContaining(["수면", "마그네슘"])
    );
  });

  it("구내염 질문에서 구내염과 피로(피곤의 페이지 키워드)를 남긴다", () => {
    const t = queryTerms("조금만 피곤해도 구내염이 자주 나. 뭐 챙겨 먹어?");
    expect(t).toContain("구내염");
    expect(t).toContain("피로");
  });

  it("영어 성분 이름은 그대로 둔다", () => {
    expect(queryTerms("creatine 먹어도 돼?")).toContain("creatine");
  });
});

describe("filterByVocab", () => {
  const vocab = ["수면", "마그네슘", "철분", "크레아틴"];
  it("뇌가 모르는 말(시간·숫자·일상어)은 버린다", () => {
    expect(filterByVocab(["오후", "3시", "마그네슘"], vocab)).toEqual(["마그네슘"]);
  });
  it("단어가 어휘를 품으면 어휘 쪽 말로 바꾼다", () => {
    expect(filterByVocab(["철분제"], vocab)).toEqual(["철분"]);
  });
  it("아는 단어는 어미로 착각해 자르지 않는다", () => {
    expect(queryTerms("후버먼이 수면 영양제 뭐 먹으라고 했었죠", 12, new Set(vocab))).toContain("수면");
  });
});

import { parsePage, searchPages } from "./brain";

describe("앱 안 지식 페이지 검색 (GBrain 대신)", () => {
  const pages = [
    parsePage("ingredients/magnesium", '---\ntitle: "마그네슘 (Magnesium)"\ntags: ["수면", "근육"]\n---\n# 마그네슘\n수면에 도움.'),
    parsePage("ingredients/acai", '---\ntitle: "아사이"\ntags: ["항산화"]\n---\n# 아사이\n수면 이야기는 없다. 수면 수면.'),
    parsePage("topics/sleep-routine", '---\ntitle: "수면 루틴"\ntags: []\n---\n# 수면 루틴'),
  ];

  it("제목에 든 페이지 → 태그에 든 페이지 → 본문에만 든 페이지 순", () => {
    expect(searchPages(pages, "수면").map((h) => h.slug)).toEqual(["topics/sleep-routine", "ingredients/magnesium", "ingredients/acai"]);
  });

  it("머리 정보는 떼고 본문만 돌려준다", () => {
    const [hit] = searchPages(pages, "마그네슘");
    expect(hit.title).toBe("마그네슘 (Magnesium)");
    expect(hit.chunk_text.startsWith("# 마그네슘")).toBe(true);
  });
});

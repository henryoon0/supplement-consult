import { describe, expect, it } from "vitest";
import { checkGate, EMPTY_PROFILE, messageSignals, withMessage } from "./gate";

const full = { age: "34 남", meds: "없음", pregnancy: "해당 없음", conditions: "없음", allergies: "없음", current: "없음" };

describe("checkGate", () => {
  it("빈칸이 있으면 제품을 보류한다", () => {
    const v = checkGate({ ...EMPTY_PROFILE, age: "30 여" });
    expect(v.status).toBe("incomplete");
  });

  it("모두 '없음'이면 통과한다", () => {
    expect(checkGate(full).status).toBe("allowed");
  });

  it("항응고제를 먹으면 의사 상담으로 보낸다", () => {
    const v = checkGate({ ...full, meds: "와파린 5mg" });
    expect(v.status).toBe("refer");
  });

  it("'해당 없음'의 임신 단어는 신호로 보지 않는다", () => {
    expect(checkGate({ ...full, pregnancy: "해당 없음" }).status).toBe("allowed");
  });

  it("임신 준비 중이면 의사 상담으로 보낸다", () => {
    expect(checkGate({ ...full, pregnancy: "임신 준비 중" }).status).toBe("refer");
  });
});

describe("대화로 알게 된 위험 신호", () => {
  it("프로필이 비어 있어도 메시지에 와파린이 있으면 신호로 잡는다", () => {
    expect(messageSignals("와파린 먹는데 오메가3 먹어도 돼?")).toEqual(["와파린(대화)"]);
  });

  it("'없음' 칸은 메시지로 덮어써서 이번 턴 판정에 넣는다", () => {
    const p = withMessage(full, "levothyroxine 먹어요");
    expect(p.meds).toBe("levothyroxine 먹어요");
    expect(checkGate(p).status).toBe("refer");
  });

  it("채워진 칸은 지우지 않고 뒤에 붙인다", () => {
    expect(withMessage({ ...full, meds: "오메프라졸" }, "요즘 피곤해").meds).toBe("오메프라졸 / 요즘 피곤해");
  });
});

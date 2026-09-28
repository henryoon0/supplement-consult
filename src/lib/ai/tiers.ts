// 텍스트 생성 티어 (SSOT).
//
// 호출처는 모델 문자열을 박지 않고 티어만 선언한다. 라우터(ai/generate.ts)가
// 티어 → 트랜스포트로 매핑한다:
//   - "fast"      : 빠른 분류·autofill·추출 → codex exec (ChatGPT 구독 OAuth)
//   - "reasoning" : 커리큘럼·제안서·시냅스 등 깊은 추론·글쓰기 → claude -p (Claude 구독)

export type AiTier = "reasoning" | "fast";

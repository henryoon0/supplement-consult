import { generateViaClaude, runClaudeCLI } from "./claude-cli";
import { execCodex } from "../codex-exec";
import { aiConfigError } from "../ai-error";
import type { AiTier } from "./tiers";

// 프로바이더 중립 텍스트 생성 — 전부 구독으로 돈다(per-token API 과금 없음).
//
// 호출처는 티어(fast/reasoning)와 prompt 만 선언하고, 라우터가 트랜스포트를 고른다:
//   - reasoning(글쓰기·깊은 추론) → claude -p (Claude 구독, opus)
//   - fast(분류·추출·자동완성)     → codex exec (ChatGPT 구독 OAuth, gpt-5.5)
//
// plain-text in / text out 전용. 오디오·영상은 이 함수를 쓰지 않는다.
//
// CLI 트랜스포트는 네이티브 구조화 출력·온도·토큰상한·취소시그널이 없다:
//   - json/jsonSchema → 프롬프트로 강제(withJsonInstruction), 파싱은 호출처(ai/json.ts).
//   - 온도·출력 토큰 상한은 지정할 수 없다. 그런 필드를 다시 만들지 말 것(2026-09-04
//     감사에서 no-op 필드 16곳을 걷어냈다 — 값이 남으면 안 먹는 설정을 만졌다고 착각한다).
//   - 타임아웃 → timeoutMs(호출 하나) + deadlineMs(슬롯 대기 포함 전체). 자세한 건 각 필드 주석.

export interface TextGenRequest {
  tier: AiTier;
  prompt: string;
  /** JSON 응답 강제 (프롬프트에 "순수 JSON만" 지시 부착). */
  json?: boolean;
  /** JSON 스키마 강제 (스키마를 프롬프트에 부착). json 보다 강함. */
  jsonSchema?: Record<string, unknown>;
  // 옛 abortSignal 은 없앴다(2026-07-26). CLI 가 조용히 무시하는데 12곳이 타임아웃
  // 의도를 거기 적어두고 있었다. 아래 signal 은 그 자리를 대신하되 **진짜로 먹는다**.
  /**
   * 취소 신호. abort 되면 CLI 자식 프로세스를 SIGKILL 하고 CancelledError 를 던진다.
   * 타임아웃 용도로 쓰지 말 것(그건 timeoutMs) — 이건 "사용자가 그만두기" 전용이다.
   */
  signal?: AbortSignal;
  /**
   * CLI 호출 하나의 하드 타임아웃(ms). 미지정이면 티어 기본값(fast 120초 / reasoning 300초).
   * 티어 기본값은 분류·추출 같은 **짧은** 호출 기준이라, 긴 생성(플래시카드 세트·
   * 해설 노트 등)은 여기서 넉넉히 올려야 한다. 두 트랜스포트(codex/claude) 모두 반영된다.
   *
   * 주의: 이건 자식 프로세스가 **뜬 뒤부터** 재는 시간이다. 동시성 캡에서 슬롯을
   * 기다린 시간은 안 들어간다 — 전체 벽시계를 묶으려면 deadlineMs 를 같이 준다.
   */
  timeoutMs?: number;
  /**
   * 이 호출이 끝나야 하는 절대 시각(epoch ms). 슬롯 대기까지 포함한 전체 벽시계를 묶는다.
   * 실효 타임아웃 = min(timeoutMs, deadlineMs − 슬롯 획득 시각). 이미 지났으면 즉시 실패한다.
   * (timeoutMs 만 주면 "슬롯 대기 + timeoutMs" 라 상한이 안 잡힌다.)
   */
  deadlineMs?: number;
  /**
   * fast 티어를 Claude(sonnet)로 강제한다. 분류·매칭이 Codex 대신 Claude 구독을
   * 타야 할 때 쓴다(벤치마크 카테고리·노트 매칭 등). reasoning 티어에선 무의미
   * (이미 Claude).
   */
  transport?: "claude";
}

// fast(codex) 호출 타임아웃. 분류·추출은 짧게.
const CODEX_FAST_TIMEOUT_MS = 120_000;

/** json/jsonSchema 가 켜지면 프롬프트 끝에 "순수 JSON만" 지시를 붙인다. */
function withJsonInstruction(req: TextGenRequest): string {
  if (!req.json && !req.jsonSchema) return req.prompt;
  let suffix =
    "\n\n출력은 순수 JSON 하나만 반환하세요. 마크다운 코드펜스(```), 설명, 머리말·꼬리말 없이 JSON 값만 출력합니다.";
  if (req.jsonSchema) {
    suffix += `\n다음 JSON 스키마를 따르세요:\n${JSON.stringify(req.jsonSchema)}`;
  }
  return req.prompt + suffix;
}

export async function generateText(req: TextGenRequest): Promise<string> {
  const prompt = withJsonInstruction(req);
  try {
    // 동시성 캡(withCliSlot)과 deadlineMs 반영은 트랜스포트 안쪽(claude-cli·codex-exec)
    // 이 스폰 직전에 한다(2026-08-30). 여기서 또 감싸면 슬롯을 쥔 채 슬롯을 기다리는
    // 중첩 획득이 되어 포화 시 교착한다.
    if (req.tier === "reasoning" || req.transport === "claude") {
      return await generateViaClaude({ ...req, prompt });
    }
    return await generateViaCodex(prompt, req);
  } catch (e) {
    // 바이너리 미설치/미로그인은 설정 안내로 바꿔 던진다.
    if (e instanceof Error && /ENOENT|not logged in|로그인/i.test(e.message)) {
      throw aiConfigError(
        "AI CLI(claude/codex)를 찾을 수 없거나 로그인되어 있지 않아요. 구독 로그인(claude / codex)을 확인하세요."
      );
    }
    throw e;
  }
}

/** fast 티어 = ChatGPT 구독 codex exec. */
async function generateViaCodex(
  prompt: string,
  req: TextGenRequest
): Promise<string> {
  return execCodex(prompt, {
    tmpPrefix: "gen-codex-",
    timeoutMs: req.timeoutMs ?? CODEX_FAST_TIMEOUT_MS,
    deadlineMs: req.deadlineMs,
    signal: req.signal,
  });
}

/**
 * JSON 응답을 파싱까지 책임지는 헬퍼. 1회 reparse 재시도 포함 — 자체 재시도가 없는
 * 호출처(visualize·synapse·videos 등)에서 모델 전환 리스크를 줄인다.
 */
export async function generateJson<T>(
  req: TextGenRequest,
  parse: (raw: string) => T
): Promise<T> {
  const first = await generateText({ ...req, json: req.json ?? true });
  try {
    return parse(first);
  } catch {
    const retry = await generateText({
      ...req,
      json: req.json ?? true,
      prompt:
        req.prompt +
        "\n\n직전 응답이 유효한 JSON이 아니었습니다. 코드펜스·설명 없이 순수 JSON 하나만 다시 출력하세요.",
    });
    return parse(retry);
  }
}

// search 가 필요한 "글쓰기+리서치"(viral-digest 등)는 claude -p WebSearch 를 직접 쓴다.
export { runClaudeCLI };

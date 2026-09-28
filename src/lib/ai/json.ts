// CLI 트랜스포트(claude -p / codex exec)는 네이티브 구조화 출력(response_format)이
// 없어서, JSON 응답은 프롬프트로 강제하고 텍스트에서 직접 뽑아낸다. 모델이 코드펜스나
// 머리말을 붙여도 견디도록 brace/bracket 깊이를 세어 첫 완결 JSON 값만 추출한다.
//
// 여기가 모델 JSON 수리 규칙의 유일한 자리다(2026-08-30). 그 전엔 고민함이 자기
// 파서를 따로 갖고 있어서 배운 교훈이 서로에게 안 넘어갔다 — 고민함은 "문자열 안 생
// 줄바꿈" 복구를 배웠고 여기는 "문자열 인식 중괄호 짝맞추기"를 갖고 있었는데, 어느
// 쪽도 둘 다 갖지 못했다. 새 깨짐 유형을 만나면 이 파일만 고친다.
//
// ⚠ 수리는 **JSON.parse 가 이미 실패한 뒤에만** 돈다. 멀쩡한 응답은 수리 경로에
// 구조적으로 못 들어가므로, 규칙을 더해도 정상 출력이 조용히 변형될 일이 없다.
// 이 성질을 깨는 수리(파싱 전에 손대는 정규화 등)는 추가하지 말 것.

/**
 * ```json … ``` 펜스를 벗긴다.
 *
 * 펜스는 응답 **전체**를 감쌌을 때만 벗긴다. 본문 문자열 안에 예시로 들어간 ``` 를
 * 펜스로 오인하면 JSON 한가운데를 잘라 먹는다(2026-08-22 고민함 실측).
 */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  const whole = trimmed.match(/^```(?:json|html)?\s*([\s\S]*?)```\s*$/i);
  return (whole ? whole[1] : trimmed).trim();
}

/** JSON 텍스트에서 따옴표 안에 있는 생 줄바꿈(\n, \r)과 탭을 이스케이프한다. */
export function escapeRawNewlinesInStrings(text: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (ch === "\\") {
        out += ch + (text[i + 1] ?? "");
        i += 1;
        continue;
      }
      if (ch === '"') inStr = false;
      else if (ch === "\n") {
        out += "\\n";
        continue;
      } else if (ch === "\r") continue;
      else if (ch === "\t") {
        out += "\\t";
        continue;
      }
      out += ch;
    } else {
      if (ch === '"') inStr = true;
      out += ch;
    }
  }
  return out;
}

// open/close 문자쌍에 맞춰 첫 완결 블록을 깊이 매칭으로 잘라낸다(문자열·이스케이프 인식).
function extractBalanced(raw: string, open: string, close: string): string {
  const cleaned = stripCodeFence(raw);
  const start = cleaned.indexOf(open);
  if (start === -1) {
    throw new Error("LLM 응답에서 JSON을 찾지 못했습니다");
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < cleaned.length; i += 1) {
    const char = cleaned[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = inString;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === open) depth += 1;
    if (char === close) {
      depth -= 1;
      if (depth === 0) return cleaned.slice(start, i + 1);
    }
  }

  throw new Error("LLM 응답의 JSON 블록이 닫히지 않았습니다");
}

/** 첫 완결 JSON 객체 문자열을 추출한다. */
export function extractJsonObject(raw: string): string {
  return extractBalanced(raw, "{", "}");
}

/** 첫 완결 JSON 배열 문자열을 추출한다. */
export function extractJsonArray(raw: string): string {
  return extractBalanced(raw, "[", "]");
}

/**
 * 추출한 JSON 조각을 읽는다. 그대로 안 읽히면 **그때만** 문자열 안 생 줄바꿈을
 * 이스케이프해 한 번 더 시도한다(본문이 여러 문단인 필드에서 모델이 흔히 내는 깨짐).
 */
function parseWithRepair<T>(chunk: string): T {
  try {
    return JSON.parse(chunk) as T;
  } catch (first) {
    try {
      return JSON.parse(escapeRawNewlinesInStrings(chunk)) as T;
    } catch {
      throw first;
    }
  }
}

/** 객체를 파싱(추출 후 JSON.parse, 실패 시 1회 수리). */
export function parseJsonObject<T = unknown>(raw: string): T {
  return parseWithRepair<T>(extractJsonObject(raw));
}

/** 배열을 파싱(추출 후 JSON.parse, 실패 시 1회 수리). */
export function parseJsonArray<T = unknown>(raw: string): T {
  return parseWithRepair<T>(extractJsonArray(raw));
}

/**
 * 객체든 배열이든 먼저 나오는 쪽을 읽는다. 모델이 어느 형태로 답할지 확실하지 않은
 * 호출처용. 못 읽으면 던진다(조용한 null 이 필요하면 tryParseModelJson).
 */
export function parseModelJson<T = unknown>(raw: string): T {
  const cleaned = stripCodeFence(raw);
  const obj = cleaned.indexOf("{");
  const arr = cleaned.indexOf("[");
  if (obj === -1 && arr === -1) {
    throw new Error("LLM 응답에서 JSON을 찾지 못했습니다");
  }
  const objectFirst = obj !== -1 && (arr === -1 || obj < arr);
  return objectFirst ? parseJsonObject<T>(cleaned) : parseJsonArray<T>(cleaned);
}

/** parseModelJson 의 조용한 판. 못 읽으면 null — 호출부 폴백이 그대로 산다. */
export function tryParseModelJson<T = unknown>(raw: string): T | null {
  try {
    return parseModelJson<T>(raw);
  } catch {
    return null;
  }
}

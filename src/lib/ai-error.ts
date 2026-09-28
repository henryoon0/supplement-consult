export type AiErrorKind =
  | "quota"
  | "auth"
  | "timeout"
  | "network"
  | "server"
  | "bad_request"
  | "url_fetch"
  | "unknown";

export interface AiErrorInfo {
  /** Short Korean message, safe to render in the UI. */
  message: string;
  kind: AiErrorKind;
  /** Whether retrying the same request might succeed. */
  retryable: boolean;
}

/**
 * Marker for configuration errors we raise ourselves (e.g. missing CLI login).
 * These carry a user-ready message that should be surfaced verbatim instead of
 * a canned one.
 */
const AI_CONFIG_MARKER = "__aiConfigError";

/** Build an error whose message is surfaced as-is by classifyAiError. */
export function aiConfigError(message: string): Error {
  const err = new Error(message);
  (err as unknown as Record<string, unknown>)[AI_CONFIG_MARKER] = true;
  return err;
}

function isAiConfigError(e: unknown): e is Error {
  return Boolean(
    e &&
      typeof e === "object" &&
      (e as Record<string, unknown>)[AI_CONFIG_MARKER] === true
  );
}

function rawText(e: unknown): string {
  if (!e) return "";
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/** Pull an HTTP-ish status code out of an error object or its message. */
function extractStatus(e: unknown, text: string): number | null {
  if (e && typeof e === "object") {
    const anyE = e as Record<string, unknown>;
    for (const key of ["status", "code", "statusCode"]) {
      const v = anyE[key];
      if (typeof v === "number" && v >= 100 && v < 600) return v;
    }
  }
  const m = text.match(/"code"\s*:\s*(\d{3})/) || text.match(/\b(4\d\d|5\d\d)\b/);
  return m ? Number(m[1]) : null;
}

export function classifyAiError(e: unknown): AiErrorInfo {
  const text = rawText(e);
  const lower = text.toLowerCase();
  const status = extractStatus(e, text);

  // Our own config errors carry a ready-to-show message.
  if (isAiConfigError(e)) {
    return { message: text, kind: "bad_request", retryable: false };
  }

  // URL fetch failures from url-meta ("fetch failed: 404", "fetch failed: 본문을
  // 가져오지 못했습니다"). undici 의 bare "fetch failed"(콜론 없음)는 진짜 네트워크
  // 오류라 아래 network 분기로 보낸다.
  if (/fetch failed:\s*\S/.test(lower)) {
    return {
      message: "URL을 가져오지 못했어요 (페이지가 없거나 봇 차단). 내용을 직접 입력하세요.",
      kind: "url_fetch",
      retryable: false,
    };
  }

  // Quota / billing / rate limit
  if (
    status === 429 ||
    /resource_exhausted|prepayment|credits? (are )?depleted|insufficient_quota|quota|rate limit|usage limit|too many requests|exhausted/.test(
      lower
    )
  ) {
    return {
      message:
        "AI 사용량 한도에 걸렸어요 (크레딧/쿼터 소진). 잠시 후 다시 시도하거나 아래 칸을 직접 채우세요.",
      kind: "quota",
      retryable: true,
    };
  }

  // Auth / key problems
  if (
    status === 401 ||
    status === 403 ||
    /api[_ ]?key|permission_denied|unauthenticated|invalid authentication|api key not valid|incorrect api key|invalid_api_key|not logged in|로그인|please run.*login/.test(
      lower
    )
  ) {
    return {
      message:
        "AI 인증 문제로 호출이 안 돼요. 구독 CLI 로그인을 확인하세요 (직접 입력은 가능).",
      kind: "auth",
      retryable: false,
    };
  }

  // Timeout / abort
  if (
    e instanceof Error && e.name === "AbortError" ||
    /timed? ?out|timeout|deadline|시간 초과/.test(lower)
  ) {
    return {
      message: "URL을 가져오거나 AI 호출이 시간 초과됐어요. 다시 시도해 보세요.",
      kind: "timeout",
      retryable: true,
    };
  }

  // Server-side instability
  if (
    (status !== null && status >= 500) ||
    /unavailable|internal error|backend error|overloaded/.test(lower)
  ) {
    return {
      message: "AI 서버가 잠시 불안정해요. 잠시 후 다시 시도하세요.",
      kind: "server",
      retryable: true,
    };
  }

  // Network
  if (
    /fetch failed|network|enotfound|econnrefused|econnreset|getaddrinfo|socket hang up|stream disconnected|sending request for url/.test(
      lower
    )
  ) {
    return {
      message: "네트워크 문제로 가져오지 못했어요. 연결을 확인하고 다시 시도하세요.",
      kind: "network",
      retryable: true,
    };
  }

  // Bad request (model name, params, body)
  if (
    status === 400 ||
    /invalid_argument|failed_precondition|bad request/.test(lower)
  ) {
    return {
      message: "AI 요청이 거부됐어요 (모델/요청 형식 확인 필요). 직접 입력하세요.",
      kind: "bad_request",
      retryable: false,
    };
  }

  return {
    message: "자동 채움에 실패했어요. 다시 시도하거나 직접 입력하세요.",
    kind: "unknown",
    retryable: true,
  };
}

/** Convenience: short safe message only. */
export function friendlyAiError(e: unknown): string {
  return classifyAiError(e).message;
}

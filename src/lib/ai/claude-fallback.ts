import { classifyAiError } from "../ai-error";
import { execCodex, isCancelled } from "../codex-exec";

export interface ClaudeCodexFallbackOptions {
  readonly timeoutMs?: number;
  /** 슬롯 대기까지 포함한 절대 마감(epoch ms). Codex 폴백도 같은 예산을 쓴다. */
  readonly deadlineMs?: number;
  readonly tmpPrefix?: string;
  /** 취소 신호 — 폴백 경로(codex)까지 자식 프로세스를 죽인다. */
  readonly signal?: AbortSignal;
}

const DEFAULT_TMP_PREFIX = "claude-fallback-";
const CLAUDE_EXIT_CODE_ONE_RE = /^(?:Claude CLI )?종료 코드 1(?:\D|$)/;
const MAX_EXIT_PAYLOAD_CHARS = 500;

// Codex 전용 모드의 유효 시한. sticky 플래그가 영구면 일시 장애 한 번에 이후
// 모든 Claude 요청이 서버 재시작 전까지 Codex 로만 가고, Codex 네트워크가 잠깐
// 끊기는 날 생성이 전멸한다 (2026-08-13 실측: 시안 3벌이 같은 초에
// "stream disconnected" 로 동시 실패). 시한이 지나면 다음 호출이 Claude 를
// 다시 시도하고, 여전히 죽어 있으면 시한이 다시 걸린다.
const DEFAULT_STICKY_MS = 5 * 60_000;

function stickyMs(): number {
  const v = Number(process.env.CLAUDE_FALLBACK_STICKY_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_STICKY_MS;
}

let codexModeUntil = 0;

function hasErrorCode(err: unknown): err is { readonly code: unknown } {
  return typeof err === "object" && err !== null && "code" in err;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

function payloadFromClaudeJson(value: unknown): string {
  if (!isRecord(value)) return "";
  const result = stringField(value, "result");
  if (result) return result;
  const message = stringField(value, "message");
  if (message) return message;
  const error = value["error"];
  if (typeof error === "string") return error.trim();
  if (isRecord(error)) return stringField(error, "message");
  return "";
}

function parseClaudeJsonPayload(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const candidates = [trimmed, ...trimmed.split(/\r?\n/).reverse()];
  for (const candidate of candidates) {
    const json = candidate.trim();
    if (!json) continue;
    try {
      const payload = payloadFromClaudeJson(JSON.parse(json));
      if (payload) return payload;
    } catch (err) {
      if (err instanceof SyntaxError) continue;
      throw err;
    }
  }
  return "";
}

function truncatePayload(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > MAX_EXIT_PAYLOAD_CHARS
    ? `${trimmed.slice(0, MAX_EXIT_PAYLOAD_CHARS)}...`
    : trimmed;
}

function claudeExitPayload(out: string, err: string): string {
  return (
    parseClaudeJsonPayload(out) ||
    err.trim() ||
    out.trim()
  );
}

export function claudeCliExitErrorMessage(
  code: number | null,
  out: string,
  err: string
): string {
  const payload = claudeExitPayload(out, err);
  const suffix = payload ? `: ${truncatePayload(payload)}` : "";
  return `Claude CLI 종료 코드 ${code ?? "unknown"}${suffix}`;
}

export function shouldUseClaudeCodexFallback(): boolean {
  return Date.now() < codexModeUntil;
}

export function isClaudeUnavailable(err: unknown): boolean {
  if (hasErrorCode(err) && err.code === "ENOENT") return true;
  if (CLAUDE_EXIT_CODE_ONE_RE.test(errorMessage(err))) return true;
  const kind = classifyAiError(err).kind;
  return kind === "quota" || kind === "auth";
}

export function markClaudeUnavailableForCodexFallback(err: unknown): boolean {
  if (!isClaudeUnavailable(err)) return false;
  codexModeUntil = Date.now() + stickyMs();
  console.warn(
    `[ai] Claude CLI 사용 불가 — ${Math.round(stickyMs() / 60_000)}분간 Claude 요청을 Codex 폴백으로 실행: ${errorMessage(err)}`
  );
  return true;
}

export async function runCodexFallbackForClaude(
  prompt: string,
  opts: ClaudeCodexFallbackOptions = {}
): Promise<string> {
  return execCodex(prompt, {
    tmpPrefix: opts.tmpPrefix ?? DEFAULT_TMP_PREFIX,
    timeoutMs: opts.timeoutMs,
    deadlineMs: opts.deadlineMs,
    signal: opts.signal,
    noClaudeFallback: true,
  });
}

function throwClaudeRecoveryFailure(codexErr: unknown, claudeErr: unknown): never {
  if (isCancelled(claudeErr)) throw claudeErr;
  throw new Error(
    `Codex 실패(${errorMessage(codexErr)}), Claude 도 실패했습니다: ${errorMessage(claudeErr)}`
  );
}

export async function runWithClaudeCodexFallback(
  prompt: string,
  opts: ClaudeCodexFallbackOptions,
  runClaude: () => Promise<string>
): Promise<string> {
  if (shouldUseClaudeCodexFallback()) {
    try {
      return await runCodexFallbackForClaude(prompt, opts);
    } catch (codexErr) {
      // Codex 전용 모드에서 Codex 가 죽어도(네트워크 끊김 등) 바로 실패하지
      // 않는다 — Claude 가 그새 살아났을 수 있으니 역방향으로 한 번 시도한다.
      if (isCancelled(codexErr)) throw codexErr;
      try {
        const out = await runClaude();
        codexModeUntil = 0; // Claude 가 살아 있다 — Codex 전용 모드 해제.
        return out;
      } catch (claudeErr) {
        throwClaudeRecoveryFailure(codexErr, claudeErr);
      }
    }
  }

  try {
    return await runClaude();
  } catch (err) {
    // 사용자가 취소한 건 "Claude 사용 불가"가 아니다 — 폴백으로 다시 돌리면 안 된다.
    if (isCancelled(err)) throw err;
    if (!markClaudeUnavailableForCodexFallback(err)) throw err;
    try {
      return await runCodexFallbackForClaude(prompt, opts);
    } catch (codexErr) {
      if (isCancelled(codexErr)) throw codexErr;
      throw new Error(
        `Claude 사용 불가(${errorMessage(err)}), Codex 폴백도 실패했습니다: ${errorMessage(codexErr)}`
      );
    }
  }
}

function emitFallbackProgress(
  onText: (accumulated: string) => void,
  raw: string
): void {
  try {
    onText(raw);
  } catch (err) {
    console.warn(`[ai] Codex 폴백 progress 콜백 실패: ${errorMessage(err)}`);
  }
}

async function runCodexFallbackForStream(
  prompt: string,
  opts: ClaudeCodexFallbackOptions,
  onText: (accumulated: string) => void
): Promise<string> {
  const raw = await runCodexFallbackForClaude(prompt, opts);
  emitFallbackProgress(onText, raw);
  return raw;
}

export async function runWithClaudeCodexFallbackStream(
  prompt: string,
  opts: ClaudeCodexFallbackOptions,
  onText: (accumulated: string) => void,
  runClaude: () => Promise<string>
): Promise<string> {
  if (shouldUseClaudeCodexFallback()) {
    try {
      return await runCodexFallbackForStream(prompt, opts, onText);
    } catch (codexErr) {
      // 비스트리밍 경로와 같은 역방향 폴백 — Codex 가 죽어도 Claude 를 한 번 본다.
      if (isCancelled(codexErr)) throw codexErr;
      try {
        const out = await runClaude();
        codexModeUntil = 0;
        return out;
      } catch (claudeErr) {
        throwClaudeRecoveryFailure(codexErr, claudeErr);
      }
    }
  }

  try {
    return await runClaude();
  } catch (err) {
    // 사용자가 취소한 건 "Claude 사용 불가"가 아니다 — 폴백으로 다시 돌리면 안 된다.
    if (isCancelled(err)) throw err;
    if (!markClaudeUnavailableForCodexFallback(err)) throw err;
    return runCodexFallbackForStream(prompt, opts, onText);
  }
}

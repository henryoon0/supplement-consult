import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { augmentedPath, killProcessTree, resolveCliBin } from "./cli-bin";
import { effectiveTimeoutAfterSlot, withCliSlot } from "./ai/cli-concurrency";

// ── 공용 Transport: ChatGPT 구독(OAuth)으로 도는 헤드리스 `codex exec` ──
//
// API 키 per-token 과금 대신 henry 의 ChatGPT 구독으로 모델을 돌린다(이미 결제 중인
// 요금제라 한계비용 0). content-ideas 의 `claude -p` 구독 CLI 패턴과 1:1 대응 —
// 거기선 claude, 여기선 codex.
//
// 안전·예측가능성을 위해:
// - `--sandbox read-only` + 임시 작업루트(`-C`): 모델이 레포/파일을 못 건드린다.
// - `--ignore-user-config`: 전역 codex hook/모델 설정을 안 탄다(서버가 반복 호출하므로
//   부작용·지연 제거. 인증은 CODEX_HOME 을 그대로 써서 유지된다).
// - `--output-last-message <FILE>`: 에이전트 로그를 stdout 으로 흘리지 않고 최종
//   메시지만 파일로 받는다 → 파싱이 깨끗하다.
//
// 자막 번역(subtitles)·회의 분석(meetings)이 이 한 파일을 공유한다. 호출처는
// 환경변수·타임아웃·tmp prefix 만 골라 넘기고, spawn·타임아웃·에러 분류는 여기 한 곳뿐.

/** codex 호출이 "이 잡 내내 다시 시도해도 소용없는" 종류의 실패인지 구분한다. */
export class CodexError extends Error {
  unavailable: boolean;
  constructor(message: string, unavailable: boolean) {
    super(message);
    this.name = "CodexError";
    this.unavailable = unavailable;
  }
}

const UNAVAILABLE_RE =
  /usage limit|rate limit|too many requests|quota|insufficient_quota|429|unauthor|not logged in|please (?:run )?.*login|forbidden|\b401\b|\b403\b/i;

/**
 * 폴백을 "이 배치만" vs "이 잡 내내" 로 가를 분류기.
 * - true: 한도/인증/미설치 → 호출부가 codex 를 스티키로 끄고 API 로만 간다.
 * - false: 일시 오류(타임아웃·파싱 등) → 이 배치만 폴백, codex 는 계속 시도.
 */
export function isCodexUnavailable(err: unknown): boolean {
  if (err instanceof CodexError) return err.unavailable;
  const e = err as { code?: string; message?: string };
  if (e?.code === "ENOENT") return true; // codex 바이너리가 PATH 에 없음
  return UNAVAILABLE_RE.test(e?.message ?? String(err));
}

export interface CodexExecOptions {
  /** codex 바이너리 경로(미지정 시 "codex"). */
  bin?: string;
  /** 모델 핀(미지정 시 codex 기본 모델 — 현재 gpt-5.5). */
  model?: string;
  /** 임시 작업루트 prefix(잡 구분용 로깅 편의). */
  tmpPrefix?: string;
  /** 호출 타임아웃(ms). 자식 프로세스가 뜬 뒤부터 잰다(슬롯 대기는 미포함). */
  timeoutMs?: number;
  /**
   * 이 호출이 끝나야 하는 절대 시각(epoch ms). 전역 동시성 캡의 슬롯 대기까지 포함한
   * 전체 벽시계를 묶는다. 실효 타임아웃 = min(timeoutMs, 남은 예산).
   */
  deadlineMs?: number;
  /**
   * 취소 신호. abort 되면 **자식 프로세스를 실제로 죽이고** CancelledError 를 던진다.
   * (예전 generateText 의 abortSignal 처럼 받아만 놓고 무시하는 필드가 아니다.)
   */
  signal?: AbortSignal;
  /**
   * true 면 Codex 한도 초과 시 Claude 로 넘기지 않는다. Claude→Codex 폴백 경로
   * (claude-fallback.ts)가 쓴다 — 이미 Claude 가 죽어서 온 호출이라 되돌려 보내면 헛돈다.
   */
  noClaudeFallback?: boolean;
}

/** 사용자가 취소해서 죽은 호출. 실패로 기록하면 안 되는 케이스를 구분한다. */
export class CancelledError extends Error {
  constructor(message = "취소됨") {
    super(message);
    this.name = "CancelledError";
  }
}

export function isCancelled(err: unknown): boolean {
  return err instanceof CancelledError;
}

const DEFAULT_TIMEOUT_MS = 6 * 60 * 1000;

/**
 * 프롬프트를 헤드리스 `codex exec` 로 보내 최종 메시지(문자열)를 반환한다.
 * 출력 파싱은 호출부가 한다 — claude CLI 경로와 동일하게 raw 텍스트만 돌려준다.
 */
export async function execCodex(
  prompt: string,
  opts: CodexExecOptions = {}
): Promise<string> {
  if (opts.noClaudeFallback) return execCodexOnly(prompt, opts);
  if (Date.now() < codexLimitedUntil) return runClaudeForCodex(prompt, opts);
  try {
    return await execCodexOnly(prompt, opts);
  } catch (err) {
    if (isCancelled(err) || !isCodexUsageLimit(err)) throw err;
    codexLimitedUntil = limitResetAt(errMessage(err), Date.now());
    console.warn(
      `[ai] Codex 한도 초과 — ${new Date(codexLimitedUntil).toLocaleTimeString("ko-KR")}까지 Claude(${CLAUDE_FALLBACK_MODEL}, effort ${CLAUDE_FALLBACK_EFFORT})로 실행`
    );
    return runClaudeForCodex(prompt, opts);
  }
}

// ── Codex 한도 초과 → Claude 폴백 ──
// ChatGPT 구독 한도를 다 쓰면 codex 가 "You've hit your usage limit ... try again at
// 8:12 PM" 으로 죽는다. 그 시각까지는 Codex 를 건너뛰고 Claude 구독으로 돌린다.
// fast 티어 대체라 사고 시간이 짧은 effort low 를 쓴다(품질은 opus 가 받친다).
const CLAUDE_FALLBACK_MODEL = "opus";
const CLAUDE_FALLBACK_EFFORT = "low";
// 오류 문구에서 재개 시각을 못 읽으면 이만큼 Codex 를 쉰다.
const DEFAULT_LIMIT_PAUSE_MS = 30 * 60_000;
// 재개 시각이 이상하게 멀면(파싱 오류 등) 여기서 자른다 — 스티키가 영원히 굳지 않게.
const MAX_LIMIT_PAUSE_MS = 24 * 60 * 60_000;

let codexLimitedUntil = 0;

const USAGE_LIMIT_RE = /usage limit|insufficient_quota|quota|rate limit|too many requests|\b429\b/i;

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 인증·미설치가 아닌 "한도" 실패만 Claude 로 넘긴다(로그인 문제는 알려야 고친다). */
export function isCodexUsageLimit(err: unknown): boolean {
  return USAGE_LIMIT_RE.test(errMessage(err));
}

/** "try again at 8:12 PM" 을 다음 도래 시각(epoch ms)으로. 못 읽으면 now+30분. */
export function limitResetAt(message: string, now: number): number {
  const m = /try again at (\d{1,2}):(\d{2})\s*(AM|PM)?/i.exec(message);
  if (!m) return now + DEFAULT_LIMIT_PAUSE_MS;
  let hour = Number(m[1]) % 12;
  if (!m[3]) hour = Number(m[1]);
  else if (m[3].toUpperCase() === "PM") hour += 12;
  const at = new Date(now);
  at.setHours(hour, Number(m[2]), 0, 0);
  if (at.getTime() <= now) at.setDate(at.getDate() + 1);
  return Math.min(at.getTime(), now + MAX_LIMIT_PAUSE_MS);
}

async function runClaudeForCodex(
  prompt: string,
  opts: CodexExecOptions
): Promise<string> {
  // 정적 import 는 순환이 된다(claude-cli → claude-fallback → codex-exec).
  const { runClaudeCLI } = await import("./ai/claude-cli");
  return runClaudeCLI(prompt, {
    model: CLAUDE_FALLBACK_MODEL,
    effort: CLAUDE_FALLBACK_EFFORT,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    deadlineMs: opts.deadlineMs,
    signal: opts.signal,
    // Claude 가 실패해도 다시 Codex 로 되돌리지 않는다(핑퐁 방지).
    requireClaude: true,
  });
}

async function execCodexOnly(
  prompt: string,
  opts: CodexExecOptions
): Promise<string> {
  const bin = opts.bin || "codex";
  const tmpPrefix = opts.tmpPrefix || "codex-";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const workDir = await mkdtemp(path.join(os.tmpdir(), tmpPrefix));
  const outFile = path.join(workDir, "last-message.txt");
  try {
    // 전역 CLI 동시성 캡은 스폰 직전 한 곳에서만 지난다(claude-cli 와 같은 규칙).
    // 타임아웃은 슬롯 획득 후 계산해 대기로 까먹은 예산을 반영한다.
    await withCliSlot(() =>
      runCodexExec(prompt, {
        bin,
        model: opts.model,
        workDir,
        outFile,
        timeoutMs: effectiveTimeoutAfterSlot(timeoutMs, opts.deadlineMs),
        signal: opts.signal,
      })
    );
    const msg = await readFile(outFile, "utf8").catch(() => "");
    if (!msg.trim()) throw new CodexError("codex 빈 결과", false);
    return msg;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

interface RunArgs {
  bin: string;
  model?: string;
  workDir: string;
  outFile: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

function runCodexExec(prompt: string, run: RunArgs): Promise<void> {
  const args = [
    "exec",
    "--ignore-user-config",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "-C",
    run.workDir,
    "--output-last-message",
    run.outFile,
    "--color",
    "never",
  ];
  if (run.model) args.push("-m", run.model);
  args.push("-"); // 프롬프트는 stdin 으로 (셸 따옴표 이스케이프 회피)

  return new Promise((resolve, reject) => {
    if (run.signal?.aborted) {
      reject(new CancelledError());
      return;
    }
    let child;
    try {
      child = spawn(resolveCliBin(run.bin), args, {
        cwd: run.workDir,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PATH: augmentedPath() },
        // 그룹 리더로 띄운다 — npm 래퍼 뒤의 진짜 바이너리까지 한 번에 죽이려면 필요.
        detached: true,
      });
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }

    let err = "";
    let out = "";
    const timer = setTimeout(() => {
      killProcessTree(child);
      reject(new CodexError(`시간 초과(${Math.round(run.timeoutMs / 1000)}초)`, false));
    }, run.timeoutMs);

    // 취소는 자식을 실제로 죽인다 — 안 그러면 슬롯을 붙잡은 채 끝까지 돈다.
    const onAbort = () => {
      killProcessTree(child);
      clearTimeout(timer);
      reject(new CancelledError());
    };
    run.signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      run.signal?.removeEventListener("abort", onAbort);
    };

    child.on("error", (e) => {
      cleanup();
      // ENOENT = codex 바이너리가 서버 PATH 에 없음 → isCodexUnavailable 이 잡아낸다.
      reject(e);
    });
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("close", (code) => {
      cleanup();
      if (run.signal?.aborted) {
        reject(new CancelledError());
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      const blob = `${err}\n${out}`;
      const tail = err.trim() ? `: ${err.trim().slice(-200)}` : "";
      reject(new CodexError(`종료 코드 ${code}${tail}`, UNAVAILABLE_RE.test(blob)));
    });

    child.stdin.on("error", () => {
      // 자식이 먼저 끝나면 EPIPE 가 날 수 있다 — 무시.
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

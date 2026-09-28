import { spawn } from "node:child_process";
import os from "node:os";
import { augmentedPath, killProcessTree, resolveCliBin } from "../cli-bin";
import { CancelledError } from "../codex-exec";
import { effectiveTimeoutAfterSlot, withCliSlot } from "./cli-concurrency";
import type { TextGenRequest } from "./generate";
import {
  claudeCliExitErrorMessage,
  runWithClaudeCodexFallback,
  runWithClaudeCodexFallbackStream,
} from "./claude-fallback";

// Claude 구독 OAuth 경로: 헤드리스 `claude -p` 로 호출한다. content-ideas-ai.ts 의
// runClaudeCLI 와 같은 방식 — 소유자의 Claude 구독으로 돌아 per-token API 과금이
// 없다. 벤치마크 요약·매칭·분류가 OpenAI API 대신 이걸 쓴다(크레딧 절약).
// 기본 cwd 는 CLAUDE.md(개발 지침)를 프로젝트 컨텍스트로 빨아들이지 않도록
// tmpdir 로 둔다. 프로젝트 스킬이 필요한 호출만 cwd 를 명시한다.
//
// generateViaClaude 는 TextGenRequest 를 받아 generateText 와 시그니처를 맞춘다
// (호출처는 generate 의존성만 갈아끼우면 됨). json/jsonSchema/abortSignal/provider
// 필드는 무시한다 — CLI 는 텍스트를 반환하고 호출처가 파싱하며, 타임아웃은 여기서
// 자체 관리한다.

export interface ClaudeCliOpts {
  model?: string;
  timeoutMs?: number;
  effort?: string;
  allowWebSearch?: boolean;
  /** 추가로 허용할 도구 (예: ["Read"] — 로컬 이미지를 읽혀 비전 입력으로 쓸 때). */
  allowedTools?: string[];
  /** --append-system-prompt 문구 오버라이드 (기본: 단발 텍스트 생성기 지시). */
  systemAppend?: string;
  /** Codex 폴백 임시파일 접두사 (기본 "claude-codex-"). */
  tmpPrefix?: string;
  /** 프로젝트 CLAUDE.md·스킬을 발견해야 할 때만 지정하는 Claude 실행 위치. */
  cwd?: string;
  /** true면 Claude 실패를 Codex로 대체하지 않는다(Claude 전용 스킬 호출용). */
  requireClaude?: boolean;
  /** 취소 신호. abort 되면 자식 프로세스를 실제로 죽이고 CancelledError 를 던진다. */
  signal?: AbortSignal;
  /**
   * 이 호출이 끝나야 하는 절대 시각(epoch ms). 전역 동시성 캡(withCliSlot)의 슬롯
   * 대기까지 포함한 전체 벽시계를 묶는다. 실효 타임아웃 = min(timeoutMs, 남은 예산).
   * timeoutMs 는 자식 프로세스가 뜬 뒤부터 재는 시간이라, 슬롯 대기가 길어질 수 있는
   * 경로(배치·크론 동시 발사)는 이걸 같이 줘야 상한이 잡힌다.
   */
  deadlineMs?: number;
  /**
   * 무응답(stall) 상한 — 마지막 출력 이후 이만큼 아무것도 안 오면 죽인다.
   * 스트리밍 경로에서만 의미가 있다(비스트리밍은 출력이 끝에 한 번에 온다).
   *
   * 벽시계 timeoutMs 는 "잘 돌고 있는 긴 생성"과 "행 걸린 호출"을 구분하지 못한다 —
   * 둘 다 시간만 흐른다. 그래서 상한을 낮추면 정상 생성이 잘리고 높이면 죽은 호출이
   * 슬롯을 오래 문다(2026-08-19 수집노트 540초 실패). 진행 신호로 판정하면 그 트레이드
   * 오프가 사라진다: 글자가 흐르는 한 살려두고, 멈춘 것만 죽인다.
   */
  stallTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 360_000;

// 사고(thinking) effort 는 CLI 지연의 가장 큰 레버다: opus 는 기본값이 high 라
// 제약된 텍스트 생성에도 수십 초를 사고에 태우다 240~300초 하드 타임아웃을 넘긴다
// (수집노트·네이버 블로그 등 긴 글에서 실측). content-ideas 가 같은 이유로 medium 을
// 쓴다. medium 은 opus 품질을 유지하면서 그 사고 시간을 2~3배 깎는다. 호출처가
// effort 를 명시하지 않으면 이 기본값을 쓴다(CLAUDE_CLI_EFFORT 로 전역 오버라이드).
const VALID_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const DEFAULT_EFFORT = (() => {
  const v = (process.env.CLAUDE_CLI_EFFORT || "").trim().toLowerCase();
  return VALID_EFFORTS.includes(v) ? v : "medium";
})();

export function runClaudeCLI(
  prompt: string,
  opts: ClaudeCliOpts = {}
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const runClaude = () => runClaudeCLIOnce(prompt, opts);
  if (opts.requireClaude === true) return runClaude();
  return runWithClaudeCodexFallback(
    prompt,
    {
      tmpPrefix: opts.tmpPrefix ?? "claude-codex-",
      timeoutMs,
      deadlineMs: opts.deadlineMs,
      signal: opts.signal,
    },
    runClaude
  );
}

// 웹 검색 트랜스포트. 기본은 Exa MCP(호스팅 서버, 이 spawn 에만 --mcp-config 로 꽂는다).
// Claude 내장 WebSearch 로 되돌리려면 WEB_SEARCH_PROVIDER=claude. EXA_API_KEY 는
// 선택 — 없으면 무료 한도로 돌고, 있으면 x-api-key 헤더로 붙는다.
const EXA_MCP_URL = "https://mcp.exa.ai/mcp";

function webSearchProvider(): "exa" | "claude" {
  return process.env.WEB_SEARCH_PROVIDER === "claude" ? "claude" : "exa";
}

// TODO(human): Exa 에서 허용할 도구 목록을 정한다.
// 후보: "mcp__exa__web_search_exa"(검색, 결과에 본문 요약 포함), "mcp__exa__web_fetch_exa"(URL 전문 읽기).
// 검색만 주면 호출당 1~2회로 끝나 빠르고 싸다. fetch 까지 주면 팩트체크·세무처럼
// 원문 확인이 필요한 곳에서 정확도가 오르지만 왕복이 늘어 timeoutMs 를 더 먹는다.
function exaAllowedTools(): string[] {
  return ["mcp__exa__web_search_exa"];
}

/** allowWebSearch 일 때 spawn args 에 붙일 [허용 도구 목록, 추가 CLI 인자]. */
function webSearchCliArgs(opts: ClaudeCliOpts): { tools: string[]; extraArgs: string[] } {
  if (opts.allowWebSearch !== true) return { tools: [], extraArgs: [] };
  if (webSearchProvider() === "claude") return { tools: ["WebSearch"], extraArgs: [] };
  const apiKey = process.env.EXA_API_KEY?.trim();
  const server = {
    type: "http",
    url: EXA_MCP_URL,
    ...(apiKey ? { headers: { "x-api-key": apiKey } } : {}),
  };
  const config = JSON.stringify({ mcpServers: { exa: server } });
  return {
    tools: exaAllowedTools(),
    extraArgs: ["--mcp-config", config, "--strict-mcp-config"],
  };
}

// 텍스트 생성 호출은 henry의 전역 Claude Code 설정을 읽지 않는다. 기본 상태의
// `claude -p`는 전역 CLAUDE.md·PROFILE, 시작 훅, 플러그인, MCP 서버, 스킬 목록을
// 매번 불러와 시동만 5~7초를 쓰고, 글쓰기와 무관한 개발 지침을 프롬프트에 섞었다
// (2026-09-25 실측: "OK" 한 마디 8~10초 → 2.8초, 문맥 49.7k → 31.4k 토큰).
// --bare는 구독(OAuth) 로그인을 안 읽어서 못 쓴다. cwd를 지정한 호출은 그 폴더의
// 스킬이 필요한 경우라 제외하고, CLAUDE_CLI_LOAD_USER_SETTINGS=1이면 예전처럼 돈다.
function isolationCliArgs(opts: ClaudeCliOpts, searchArgs: readonly string[]): string[] {
  if (opts.cwd || process.env.CLAUDE_CLI_LOAD_USER_SETTINGS === "1") return [];
  const args = ["--setting-sources=", "--disable-slash-commands", "--no-session-persistence"];
  if (!searchArgs.includes("--strict-mcp-config")) args.push("--strict-mcp-config");
  return args;
}

function resolveSysAppend(opts: ClaudeCliOpts): string {
  if (opts.systemAppend) return opts.systemAppend;
  return opts.allowWebSearch === true
    ? "당신은 한 번의 호출로 끝나는 텍스트 생성기입니다. 웹 검색 도구 외의 도구는 쓰지 말고, 다른 워크플로우나 에이전트를 시작하지 마세요. 요청된 형식의 최종 출력만 다른 텍스트 없이 반환하세요."
    : "당신은 한 번의 호출로 끝나는 텍스트 생성기입니다. 어떤 도구도 쓰지 말고(웹검색 포함), 다른 워크플로우나 에이전트를 시작하지 마세요. 요청된 형식의 최종 출력만 다른 텍스트 없이 반환하세요.";
}

function runClaudeCLIOnce(
  prompt: string,
  opts: ClaudeCliOpts = {}
): Promise<string> {
  // 스폰 직전 단일 지점에서 전역 캡을 지난다 — runClaudeCLI 를 직접 import 하는
  // 호출처도 전부 여기로 수렴하므로 캡 우회가 구조적으로 불가능하다.
  // 타임아웃은 슬롯 획득 "후" 계산: 대기 시간이 deadlineMs 예산에서 깎인다.
  return withCliSlot(async () => {
    const timeoutMs = effectiveTimeoutAfterSlot(
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      opts.deadlineMs
    );
    return runClaudeCLISpawn(prompt, { ...opts, timeoutMs });
  });
}

function runClaudeCLISpawn(
  prompt: string,
  opts: ClaudeCliOpts = {}
): Promise<string> {
  const model = opts.model || "opus";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const effort = opts.effort ?? DEFAULT_EFFORT;
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new CancelledError());
      return;
    }
    const sysAppend = resolveSysAppend(opts);
    const search = webSearchCliArgs(opts);
    const args = [
      "-p",
      "--model",
      model,
      ...search.extraArgs,
      ...isolationCliArgs(opts, search.extraArgs),
    ];
    if (effort) args.push("--effort", effort);
    const allowed = [...search.tools, ...(opts.allowedTools ?? [])];
    if (allowed.length) args.push("--allowedTools", allowed.join(","));
    args.push("--output-format", "json", "--append-system-prompt", sysAppend);

    let child;
    try {
      child = spawn(resolveCliBin("claude"), args, {
        cwd: opts.cwd ?? os.tmpdir(),
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PATH: augmentedPath() },
        // 그룹 리더로 띄운다 — 래퍼 뒤의 진짜 바이너리까지 한 번에 죽이기 위해.
        detached: true,
      });
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }

    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      killProcessTree(child);
      reject(new Error(`Claude CLI 시간 초과(${Math.round(timeoutMs / 1000)}초)`));
    }, timeoutMs);

    // 취소는 자식을 실제로 죽인다 — 안 그러면 슬롯을 붙잡은 채 끝까지 돈다.
    const onAbort = () => {
      killProcessTree(child);
      clearTimeout(timer);
      reject(new CancelledError());
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    };

    child.on("error", (e) => {
      cleanup();
      // ENOENT = `claude` 바이너리가 서버 PATH에 없음(로그인/설치 안 됨).
      reject(e);
    });
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("close", (code) => {
      cleanup();
      if (opts.signal?.aborted) {
        reject(new CancelledError());
        return;
      }
      if (code !== 0) {
        reject(new Error(claudeCliExitErrorMessage(code, out, err)));
        return;
      }
      try {
        const env = JSON.parse(out);
        if (env?.is_error) {
          reject(new Error(String(env?.result || "is_error")));
          return;
        }
        const result = typeof env?.result === "string" ? env.result : "";
        if (!result.trim()) {
          reject(new Error("빈 결과"));
          return;
        }
        resolve(result);
      } catch {
        if (out.trim()) resolve(out);
        else reject(new Error("CLI 출력 파싱 실패"));
      }
    });

    child.stdin.on("error", () => {});
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// ── 스트리밍 변형 ────────────────────────────────────────────────────────────
// 같은 구독 `claude -p` 를 --output-format stream-json 으로 돌려 최종 답변 텍스트를
// 토큰 단위로 받는다(thinking delta 는 무시). onText 는 델타마다 "누적" 텍스트로
// 호출된다. 최종 확정 텍스트(result 이벤트)로 resolve 하므로 파싱은 비스트리밍
// 경로와 동일. Claude 사용 불가 시 Codex 폴백(비스트리밍, 완료 시 onText 1회).

export function runClaudeCLIStream(
  prompt: string,
  opts: ClaudeCliOpts,
  onText: (accumulated: string) => void
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const runClaude = () => runClaudeCLIStreamOnce(prompt, opts, onText);
  if (opts.requireClaude === true) return runClaude();
  return runWithClaudeCodexFallbackStream(
    prompt,
    {
      tmpPrefix: opts.tmpPrefix ?? "claude-codex-",
      timeoutMs,
      deadlineMs: opts.deadlineMs,
      signal: opts.signal,
    },
    onText,
    runClaude
  );
}

function runClaudeCLIStreamOnce(
  prompt: string,
  opts: ClaudeCliOpts,
  onText: (accumulated: string) => void
): Promise<string> {
  // 비스트리밍 경로(runClaudeCLIOnce)와 같은 규칙: 캡은 스폰 직전 한 곳.
  return withCliSlot(async () => {
    const timeoutMs = effectiveTimeoutAfterSlot(
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      opts.deadlineMs
    );
    return runClaudeCLIStreamSpawn(prompt, { ...opts, timeoutMs }, onText);
  });
}

function runClaudeCLIStreamSpawn(
  prompt: string,
  opts: ClaudeCliOpts,
  onText: (accumulated: string) => void
): Promise<string> {
  const model = opts.model || "opus";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const effort = opts.effort ?? DEFAULT_EFFORT;
  return new Promise((resolve, reject) => {
    const sysAppend = resolveSysAppend(opts);
    const search = webSearchCliArgs(opts);
    const args = [
      "-p",
      "--model",
      model,
      ...search.extraArgs,
      ...isolationCliArgs(opts, search.extraArgs),
    ];
    if (effort) args.push("--effort", effort);
    const allowed = [...search.tools, ...(opts.allowedTools ?? [])];
    if (allowed.length) args.push("--allowedTools", allowed.join(","));
    args.push(
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--append-system-prompt",
      sysAppend
    );

    let child;
    try {
      child = spawn(resolveCliBin("claude"), args, {
        cwd: opts.cwd ?? os.tmpdir(),
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PATH: augmentedPath() },
        // 그룹 리더로 띄운다 — 래퍼 뒤의 진짜 바이너리까지 한 번에 죽이기 위해.
        detached: true,
      });
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }

    let accumulated = "";
    let finalText = "";
    let isError = false;
    let buf = "";
    let err = "";
    let settled = false;
    // 벽시계 상한은 최후 방어선으로만 남긴다. 실사용 판정은 아래 stall 타이머가 한다.
    const timer = setTimeout(() => {
      killProcessTree(child);
      clearTimers();
      reject(new Error(`Claude CLI 시간 초과(${Math.round(timeoutMs / 1000)}초)`));
    }, timeoutMs);

    // 무응답 감시: 출력이 올 때마다 리셋한다. 사고(thinking) 델타도 출력이라
    // 리셋에 포함된다 — "정말 아무것도 안 오는" 상태만 죽음으로 본다.
    const stallMs = opts.stallTimeoutMs ?? 0;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    const armStall = () => {
      if (!stallMs || settled) return;
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        killProcessTree(child);
        clearTimers();
        reject(
          new Error(
            `Claude CLI 무응답(${Math.round(stallMs / 1000)}초간 출력 없음)`
          )
        );
      }, stallMs);
    };
    const clearTimers = () => {
      settled = true;
      clearTimeout(timer);
      if (stallTimer) clearTimeout(stallTimer);
      opts.signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      killProcessTree(child);
      clearTimers();
      reject(new CancelledError());
    };
    if (opts.signal?.aborted) {
      killProcessTree(child);
      clearTimeout(timer);
      reject(new CancelledError());
      return;
    }
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    armStall();

    const handleLine = (line: string) => {
      const s = line.trim();
      if (!s) return;
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(s);
      } catch {
        return; // non-JSON noise — ignore
      }
      // 최종 답변의 토큰 델타 (thinking_delta 는 무시).
      if (ev.type === "stream_event") {
        const inner = (ev.event ?? {}) as Record<string, unknown>;
        if (inner.type === "content_block_delta") {
          const delta = (inner.delta ?? {}) as Record<string, unknown>;
          if (delta.type === "text_delta" && typeof delta.text === "string") {
            accumulated += delta.text;
            try {
              onText(accumulated);
            } catch {
              /* UI 콜백이 스트림을 죽이지 않게 */
            }
          }
        }
        return;
      }
      // 확정 최종 결과.
      if (ev.type === "result") {
        if (typeof ev.result === "string") finalText = ev.result;
        if (ev.is_error === true) isError = true;
      }
    };

    child.stdout.on("data", (d) => {
      armStall();
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        handleLine(line);
      }
    });
    child.stderr.on("data", (d) => {
      armStall();
      err += d.toString();
    });
    child.on("error", (e) => {
      clearTimers();
      reject(e);
    });
    child.on("close", (code) => {
      if (settled) return; // 타임아웃·무응답·취소로 이미 reject 됐다
      clearTimers();
      if (buf.trim()) handleLine(buf); // 마지막 부분 라인 flush
      if (code !== 0) {
        reject(new Error(claudeCliExitErrorMessage(code, finalText, err)));
        return;
      }
      const result = (finalText || accumulated).trim();
      if (isError) {
        reject(new Error(result || "is_error"));
        return;
      }
      if (!result) {
        reject(new Error("빈 결과"));
        return;
      }
      resolve(result);
    });

    child.stdin.on("error", () => {});
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// 티어 → CLI 모델/타임아웃/effort. reasoning(요약)=opus, fast(매칭·분류)=sonnet.
const MODEL_FOR_TIER: Record<string, string> = {
  reasoning: process.env.BENCHMARK_CLI_MODEL_REASONING || "opus",
  fast: process.env.BENCHMARK_CLI_MODEL_FAST || "sonnet",
};
const TIMEOUT_FOR_TIER: Record<string, number> = {
  reasoning: 300_000,
  fast: 120_000,
};
const EFFORT_FOR_TIER: Record<string, string | undefined> = {
  reasoning: "medium", // 기본 high 사고가 요약을 타임아웃까지 끌고 가는 걸 막는다.
  fast: "low",
};

/** generateText 와 같은 시그니처의 Claude-OAuth 어댑터. tier·prompt·timeoutMs 만 사용. */
export async function generateViaClaude(req: TextGenRequest): Promise<string> {
  return runClaudeCLI(req.prompt, {
    model: MODEL_FOR_TIER[req.tier],
    // 긴 생성은 호출처가 티어 기본값을 덮어쓴다 (짧은 분류 기준 기본값이 이기면 안 됨).
    timeoutMs: req.timeoutMs ?? TIMEOUT_FOR_TIER[req.tier],
    deadlineMs: req.deadlineMs,
    effort: EFFORT_FOR_TIER[req.tier],
    signal: req.signal,
  });
}

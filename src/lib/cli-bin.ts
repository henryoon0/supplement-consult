import { accessSync, constants } from "node:fs";
import os from "node:os";
import path from "node:path";

// 구독 CLI(claude·codex 등) 바이너리를 절대경로로 해석한다.
//
// 왜 필요한가: dev 서버가 비인터랙티브 컨텍스트(GUI 런치·launchd·CLI 설치 전에 시작된
// 세션)에서 뜨면 `~/.local/bin`(claude 설치 위치)이 PATH 에 없어 `spawn("claude")` 가
// `ENOENT` 로 죽는다. 그 경로는 `.zshrc` 에서만 PATH 에 추가되는데 `.zshrc` 는
// 인터랙티브 셸 전용이라, 상속된 PATH 에만 의존하면 깨진다. 그래서 흔한 설치 위치를
// 직접 훑어 절대경로를 찾고, 자식 프로세스 PATH 도 같은 디렉터리들로 보강한다.

const HOME = os.homedir();

// PATH 에 없을 수 있는 흔한 사용자/시스템 설치 디렉터리.
const EXTRA_DIRS = [
  path.join(HOME, ".local/bin"), // claude 공식 설치 (~/.local/share/claude/versions/*)
  path.join(HOME, ".claude/local"), // claude 구버전 로컬 설치
  "/opt/homebrew/bin", // Apple Silicon homebrew (codex 등)
  "/usr/local/bin", // Intel homebrew / 일반
  path.join(HOME, ".bun/bin"),
  path.join(HOME, ".cargo/bin"),
];

function candidateDirs(): string[] {
  const fromPath = (process.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean);
  // 라이브 PATH 를 먼저 본다(이미 맞게 떴으면 그대로 쓰고), 그다음 알려진 위치.
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const d of [...fromPath, ...EXTRA_DIRS]) {
    if (!seen.has(d)) {
      seen.add(d);
      dirs.push(d);
    }
  }
  return dirs;
}

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * bin 이름을 절대경로로 해석한다. 못 찾으면 원래 이름을 그대로 돌려준다
 * (그 경우 spawn 이 ENOENT 로 surface 하므로 동작이 더 나빠지지 않는다).
 */
export function resolveCliBin(name: string): string {
  if (name.includes("/")) return name; // 이미 경로면 그대로.
  for (const dir of candidateDirs()) {
    const full = path.join(dir, name);
    if (isExecutable(full)) return full;
  }
  return name;
}

/**
 * 자식 프로세스에 줄 PATH. 알려진 설치 디렉터리까지 합쳐서, spawn 된 CLI 가 스스로
 * 다른 도구(node·git 등)를 부를 때도 깨지지 않게 한다.
 */
export function augmentedPath(): string {
  return candidateDirs().join(path.delimiter);
}

/**
 * CLI 자식을 **프로세스 그룹째** 죽인다.
 *
 * codex·claude 는 npm 래퍼(node)가 진짜 바이너리를 다시 spawn 하는 구조라,
 * child.kill() 은 래퍼만 죽이고 손자는 PPID 1 로 재부모화되어 끝까지 돈다
 * (2026-07-26 실측: 취소 뒤에도 codex 바이너리가 고아로 살아 토큰을 태움).
 * spawn 에 detached:true 를 주면 자식이 그룹 리더가 되고, 음수 pid 로 그룹 전체에
 * 시그널을 보낼 수 있다.
 */
export function killProcessTree(child: { pid?: number; kill: (s: NodeJS.Signals) => boolean }): void {
  if (typeof child.pid !== "number") return;
  try {
    process.kill(-child.pid, "SIGKILL"); // 그룹 전체
  } catch {
    try {
      child.kill("SIGKILL"); // 그룹이 없으면(이미 죽었거나 detached 실패) 직접
    } catch {
      // 이미 죽음
    }
  }
}

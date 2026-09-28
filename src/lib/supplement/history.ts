import { promises as fs } from "fs";
import path from "path";

// 보충제 상담 대화 기록 (한 사람용 로컬 앱이라 파일 하나). 새로고침·다른 창에서도 이어진다.
// 결과 모양은 화면이 그대로 다시 그리므로 ConsultResult 를 통째로 둔다.

const MAX_TURNS = 100;

function historyPath(): string {
  return (
    process.env.SUPPLEMENT_HISTORY_PATH ??
    path.join(process.cwd(), "data", "consult-history.json")
  );
}

export type StoredTurn = { user: string; result?: unknown; error?: string; at: string };

export async function readHistory(): Promise<StoredTurn[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(historyPath(), "utf8")) as { turns?: StoredTurn[] };
    return Array.isArray(parsed.turns) ? parsed.turns : [];
  } catch {
    return [];
  }
}

export async function writeHistory(turns: StoredTurn[]): Promise<void> {
  const file = historyPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ turns: turns.slice(-MAX_TURNS) }));
  await fs.rename(tmp, file);
}

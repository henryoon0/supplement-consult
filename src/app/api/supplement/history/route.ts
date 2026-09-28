import { NextResponse, type NextRequest } from "next/server";
import { readHistory, writeHistory, type StoredTurn } from "@/lib/supplement/history";

export async function GET() {
  return NextResponse.json({ turns: await readHistory() });
}

export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  if (!Array.isArray(body.turns)) return NextResponse.json({ error: "turns 가 필요해요." }, { status: 400 });
  const turns: StoredTurn[] = body.turns
    .filter((t: unknown) => t && typeof (t as StoredTurn).user === "string")
    .map((t: StoredTurn) => ({ user: t.user.slice(0, 2000), result: t.result, error: t.error, at: t.at ?? new Date().toISOString() }));
  await writeHistory(turns);
  return NextResponse.json({ ok: true, count: turns.length });
}

import { NextResponse, type NextRequest } from "next/server";
import { consult, type ChatMessage } from "@/lib/supplement/advise";
import { EMPTY_PROFILE, type SupplementProfile } from "@/lib/supplement/gate";
import { classifyAiError } from "@/lib/ai-error";

export const maxDuration = 180;

function toMessages(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.text === "string")
    .map((m) => ({ role: m.role, text: String(m.text).slice(0, 2000) }));
}

function toProfile(raw: unknown): SupplementProfile {
  const out = { ...EMPTY_PROFILE };
  if (raw && typeof raw === "object") {
    for (const key of Object.keys(out) as (keyof SupplementProfile)[]) {
      const v = Reflect.get(raw, key);
      if (typeof v === "string") out[key] = v.slice(0, 300);
    }
  }
  return out;
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const messages = toMessages(body.messages);
  if (!messages.some((m) => m.role === "user")) {
    return NextResponse.json({ error: "질문을 입력해 주세요." }, { status: 400 });
  }
  try {
    return NextResponse.json(await consult(messages, toProfile(body.profile)));
  } catch (err) {
    const info = classifyAiError(err);
    const status = info.kind === "timeout" ? 504 : info.kind === "quota" ? 429 : 502;
    return NextResponse.json({ error: info.message }, { status });
  }
}

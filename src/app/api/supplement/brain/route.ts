import { NextResponse, type NextRequest } from "next/server";
import { getBrainPage } from "@/lib/supplement/brain";

export async function GET(req: NextRequest) {
  const slug = req.nextUrl.searchParams.get("slug") ?? "";
  const text = await getBrainPage(slug);
  if (!text) return NextResponse.json({ error: "페이지를 찾지 못했어요." }, { status: 404 });
  return NextResponse.json({ slug, text });
}

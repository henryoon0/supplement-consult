import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "보충제 상담",
  description: "박약사 말투로 보충제를 추천하고, 팟캐스트 근거와 아마존 제품 예시를 보여줍니다.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}

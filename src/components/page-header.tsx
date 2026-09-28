import type { ReactNode } from "react";

// 모든 최상위 페이지 헤더의 SSOT. 패딩·타이포·하단 구분선을 한 곳에 고정해
// 페이지마다 헤더가 달라 보이던 문제를 없앤다.
// 구분선은 헌법대로 box-shadow 1px (border 금지).
// eyebrow 는 선택. 한국어 UI이므로 영문 eyebrow 는 지양하고 보통 title+subtitle 만 쓴다.
// compact: 칸반·에디터처럼 세로 공간이 귀한 풀스크린 작업 화면용 밀도.
//          두 밀도 모두 이 컴포넌트가 소유한다 (페이지별 임의 헤더 금지).
export function PageHeader({
  eyebrow,
  title,
  subtitle,
  actions,
  compact = false,
  className = "",
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  compact?: boolean;
  className?: string;
}) {
  return (
    <header
      className={`${
        compact ? "px-6 py-3" : "px-6 md:px-8 pt-8 pb-5"
      } shadow-[0_1px_0_0_rgba(10,10,10,0.05)] ${className}`}
    >
      <div
        className={`flex justify-between gap-4 ${
          compact
            ? "items-center"
            : "items-start max-sm:flex-col max-sm:items-stretch"
        }`}
      >
        <div className="min-w-0">
          {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
          <h1
            className={`text-display text-neutral-900 text-balance ${
              compact ? "text-base" : "text-2xl"
            }`}
          >
            {title}
          </h1>
          {subtitle ? (
            <p
              className={`max-w-prose break-keep [overflow-wrap:anywhere] text-neutral-500 ${
                compact ? "text-xs" : "mt-1.5 text-sm"
              }`}
            >
              {subtitle}
            </p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 items-center gap-2">{actions}</div>
        ) : null}
      </div>
    </header>
  );
}

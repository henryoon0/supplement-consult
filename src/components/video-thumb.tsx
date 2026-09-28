"use client";

// 유튜브 썸네일 한 장. 화질 올린 주소부터 시도하고, 없으면 원본으로 되돌아간다.
//
// 왜 컴포넌트인가: hq720(1280x720)은 모든 영상에 있지 않다. 주소만 바꿔치기하면
// 오래된 영상에서 깨진 이미지가 뜬다. 실패를 받아 다음 후보로 넘기는 자리가 필요하다.
// 실측·규칙은 src/lib/youtube/thumb.ts 주석 참고.

import { useState } from "react";
import { cn } from "@/lib/utils";
import { thumbCandidates } from "@/lib/youtube/thumb";

/** 유튜브가 "이 변형 없음"을 알리는 회색 자리표의 폭. 진짜 썸네일은 최소 320px 이다. */
const PLACEHOLDER_W = 120;

export function VideoThumb({
  src,
  alt = "",
  className,
  loading = "lazy",
  onExhausted,
  ref,
  ...rest
}: {
  readonly src: string | null | undefined;
  readonly alt?: string;
  readonly className?: string;
  readonly loading?: "lazy" | "eager";
  /** React 19 에서는 ref 가 그냥 prop 이다. */
  readonly ref?: React.Ref<HTMLImageElement>;
  /** 후보를 다 써도 못 불러왔을 때. 자리를 감추고 싶은 쪽에서 쓴다. */
  readonly onExhausted?: () => void;
} & Omit<
  React.ImgHTMLAttributes<HTMLImageElement>,
  "src" | "alt" | "className" | "loading" | "onError" | "onLoad"
>) {
  const candidates = thumbCandidates(src);
  const [index, setIndex] = useState(0);

  // src 가 바뀌면 후보 순서를 처음으로 되돌린다(렌더 중 조정, effect 아님).
  const [seen, setSeen] = useState(src);
  if (seen !== src) {
    setSeen(src);
    setIndex(0);
  }

  if (candidates.length === 0) return null;
  const current = candidates[Math.min(index, candidates.length - 1)];

  return (
    // eslint-disable-next-line @next/next/no-img-element -- 외부 썸네일(ytimg)
    <img
      ref={ref}
      src={current}
      alt={alt}
      loading={loading}
      decoding="async"
      onError={() => {
        if (index + 1 < candidates.length) setIndex(index + 1);
        else onExhausted?.();
      }}
      // ⚠ 유튜브는 없는 변형에 404 를 주지 않는다. 120x90 회색 자리표를 200 으로 돌려준다.
      //    그래서 onError 로는 절대 못 잡는다 — 불러온 뒤 크기를 재야 한다.
      //    실제 변형은 최소 320px(mqdefault)이라 120 이하면 자리표로 본다.
      onLoad={(e) => {
        const img = e.currentTarget;
        if (img.naturalWidth > 0 && img.naturalWidth <= PLACEHOLDER_W) {
          if (index + 1 < candidates.length) setIndex(index + 1);
          else onExhausted?.();
        }
      }}
      className={cn(className)}
      {...rest}
    />
  );
}

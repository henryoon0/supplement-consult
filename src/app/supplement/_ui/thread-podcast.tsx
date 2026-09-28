import { PlayCircleIcon } from "@heroicons/react/16/solid";
import type { PodcastClaim } from "@/lib/supplement/catalog";
import { VariantTimeline } from "./podcast-views";

// 스레드(박약사) 답글 안에 붙는 팟캐스트 발언.
// henry 픽(2026-09-28) = 영상 타임라인. 원본 시안 5개: /prototypes/supplement-podcast
export function ThreadPodcast({ claims }: { readonly claims: PodcastClaim[] }) {
  if (!claims.length) return null;
  return (
    <section className="mt-2 flex flex-col gap-2">
      <p className="flex items-center gap-1 px-2 text-[11.5px] text-neutral-500">
        <PlayCircleIcon className="size-3.5" aria-hidden />
        팟캐스트에서 나온 말 {claims.length}개 · 관점일 뿐, 추천 근거는 아니에요
      </p>
      <VariantTimeline claims={claims} />
    </section>
  );
}

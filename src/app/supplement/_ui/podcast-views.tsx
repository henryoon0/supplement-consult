import { useState } from "react";
import { ArrowTopRightOnSquareIcon, PlayIcon } from "@heroicons/react/16/solid";
import { VideoThumb } from "@/components/video-thumb";
import type { PodcastClaim } from "@/lib/supplement/catalog";
import { clock, embedUrl, thumbUrl, watchUrl } from "./yt";

// 같은 발언 목록, 영상 위치로 가는 길 다섯 가지.
// 1 새 탭(가장 가벼움) → 2 제자리 재생 → 3 영상을 먼저 보여 줌 → 4 플레이어 하나로 넘겨 듣기 → 5 영상 안의 위치를 지도처럼.

const CARD = "rounded-xl bg-white ring-1 ring-neutral-950/5";

const KIND_KO: Record<string, string> = {
  mechanism: "원리",
  dose_timing: "용량·타이밍",
  caveat: "주의점",
  anecdote: "경험담",
  contradiction: "반론",
  recommendation: "추천",
};

type P = { readonly claims: PodcastClaim[] };

function Who({ c }: { readonly c: PodcastClaim }) {
  return (
    <span className="text-[11.5px] text-neutral-500">
      {c.speaker || "출연자"} · {KIND_KO[c.kind] ?? c.kind}
    </span>
  );
}

function Player({ c, autoplay = true }: { readonly c: PodcastClaim; readonly autoplay?: boolean }) {
  return (
    <div className="aspect-video w-full overflow-hidden rounded-lg bg-neutral-900">
      <iframe
        key={`${c.videoId}-${c.t}`}
        src={embedUrl(c.videoId, c.t, autoplay)}
        title={c.title}
        allow="autoplay; encrypted-media; picture-in-picture"
        allowFullScreen
        className="size-full"
      />
    </div>
  );
}

/* 1. 시간 칩: 발언 옆 "▶ 22:58" 칩. 누르면 유튜브가 새 탭으로 그 초에서 열린다. */
export function VariantChip({ claims }: P) {
  return (
    <ul className={`${CARD} flex flex-col`}>
      {claims.map((c, i) => (
        <li key={i} className={`flex items-start gap-3 p-4 ${i ? "shadow-[0_-1px_0_0_rgba(10,10,10,0.05)]" : ""}`}>
          <div className="min-w-0 flex-1">
            <Who c={c} />
            <p className="mt-1 text-[13.5px] leading-relaxed text-neutral-900">{c.claimKo || c.claim}</p>
          </div>
          <a
            href={watchUrl(c.videoId, c.t)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-neutral-900 px-2.5 py-1 text-[12px] tabular-nums text-white hover:bg-neutral-700"
          >
            <PlayIcon className="size-3" aria-hidden />
            {clock(c.t)}
          </a>
        </li>
      ))}
    </ul>
  );
}

/* 2. 펼쳐서 재생: 발언을 누르면 그 자리에 플레이어가 열리고 해당 초부터 재생. 원문 인용이 아래 붙는다. */
export function VariantInline({ claims }: P) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <ul className="flex flex-col gap-2">
      {claims.map((c, i) => (
        <li key={i} className={`${CARD} p-4`}>
          <button type="button" onClick={() => setOpen(open === i ? null : i)} className="flex w-full items-start gap-3 text-left">
            <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-emerald-700 text-white">
              <PlayIcon className="size-3" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <Who c={c} /> <span className="text-[11.5px] tabular-nums text-emerald-800">· {clock(c.t)}부터</span>
              <span className="mt-1 block text-[13.5px] leading-relaxed text-neutral-900">{c.claimKo || c.claim}</span>
            </span>
          </button>
          {open === i && (
            <div className="mt-3 flex flex-col gap-2 pl-9">
              <Player c={c} />
              <blockquote className="rounded-lg bg-neutral-50 px-3 py-2 text-[12.5px] italic text-neutral-600">“{c.quote}”</blockquote>
              <a href={watchUrl(c.videoId, c.t)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 self-start text-[11.5px] text-neutral-500 hover:text-neutral-800">
                유튜브에서 열기 <ArrowTopRightOnSquareIcon className="size-3" aria-hidden />
              </a>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

/* 3. 썸네일 카드: 영상 표지 위에 시간 배지와 "영상 속 위치" 진행 막대. 누르면 새 탭. */
export function VariantThumbs({ claims }: P) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {claims.map((c, i) => (
        <a key={i} href={watchUrl(c.videoId, c.t)} target="_blank" rel="noreferrer" className={`${CARD} group overflow-hidden hover:ring-neutral-950/15`}>
          <div className="relative aspect-video bg-neutral-100">
            <VideoThumb src={thumbUrl(c.videoId)} alt="" className="size-full object-cover" />
            <span className="absolute bottom-2 right-2 rounded bg-neutral-950/80 px-1.5 py-0.5 text-[11px] tabular-nums text-white">
              {clock(c.t)}
              {c.duration ? ` / ${clock(c.duration)}` : ""}
            </span>
            {c.duration > 0 && (
              <span className="absolute inset-x-0 bottom-0 h-1 bg-white/40">
                <span className="block h-full bg-red-600" style={{ width: `${Math.min(100, (c.t / c.duration) * 100)}%` }} />
              </span>
            )}
            <span className="absolute inset-0 grid place-items-center opacity-0 transition-opacity group-hover:opacity-100">
              <span className="grid size-11 place-items-center rounded-full bg-neutral-950/70 text-white">
                <PlayIcon className="size-5" aria-hidden />
              </span>
            </span>
          </div>
          <div className="flex flex-col gap-1 p-3">
            <Who c={c} />
            <p className="line-clamp-3 text-[13px] leading-snug text-neutral-900">{c.claimKo || c.claim}</p>
            <p className="truncate text-[11px] text-neutral-400">{c.title}</p>
          </div>
        </a>
      ))}
    </div>
  );
}

/* 4. 옆 플레이어: 오른쪽 플레이어 하나. 왼쪽 발언을 누를 때마다 그 영상의 그 초로 넘어간다. */
export function VariantSidePlayer({ claims }: P) {
  const [active, setActive] = useState(0);
  const [started, setStarted] = useState(false);
  const c = claims[active];
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_440px]">
      <ol className="flex flex-col gap-1.5">
        {claims.map((x, i) => (
          <li key={i}>
            <button
              type="button"
              aria-current={i === active ? "true" : undefined}
              onClick={() => {
                setActive(i);
                setStarted(true);
              }}
              className={`flex w-full gap-3 rounded-xl p-3 text-left ring-1 ${
                i === active ? "bg-emerald-50 ring-emerald-700/30" : "bg-white ring-neutral-950/5 hover:bg-neutral-50"
              }`}
            >
              <span className="w-12 shrink-0 pt-0.5 text-[12px] tabular-nums text-emerald-800">{clock(x.t)}</span>
              <span className="min-w-0">
                <Who c={x} />
                <span className="mt-0.5 block text-[13px] leading-snug text-neutral-900">{x.claimKo || x.claim}</span>
              </span>
            </button>
          </li>
        ))}
      </ol>
      <aside className="flex h-fit flex-col gap-2 lg:sticky lg:top-4">
        <Player c={c} autoplay={started} />
        <p className="text-[12px] text-neutral-900">{c.title}</p>
        <blockquote className="rounded-lg bg-white px-3 py-2 text-[12.5px] italic text-neutral-600 ring-1 ring-neutral-950/5">“{c.quote}”</blockquote>
      </aside>
    </div>
  );
}

/* 5. 영상 타임라인: 영상마다 길이 막대 하나, 발언 위치에 점. 점을 누르면 아래 플레이어가 그 초로. */
export function VariantTimeline({ claims }: P) {
  const byVideo = new Map<string, PodcastClaim[]>();
  // 막대 위 점과 목록 순서가 같도록 영상 안에서는 시간순.
  [...claims].sort((a, b) => a.t - b.t).forEach((c) => byVideo.set(c.videoId, [...(byVideo.get(c.videoId) ?? []), c]));
  const [active, setActive] = useState<PodcastClaim | null>(null);
  return (
    <div className="flex flex-col gap-3">
      {[...byVideo.entries()].map(([id, list]) => {
        const dur = list[0].duration || Math.max(...list.map((x) => x.t)) * 1.1 || 1;
        return (
          <section key={id} className={`${CARD} p-4`}>
            <div className="flex items-center gap-3">
              <VideoThumb src={thumbUrl(id)} alt="" className="h-12 w-20 shrink-0 rounded object-cover" />
              <div className="min-w-0">
                <p className="truncate text-[13px] font-medium text-neutral-900">{list[0].title}</p>
                <p className="text-[11.5px] text-neutral-500">
                  {list[0].channel} · {clock(dur)} · 발언 {list.length}개
                </p>
              </div>
            </div>
            <div className="relative mt-4 h-1.5 rounded-full bg-neutral-200">
              {list.map((c, i) => (
                <button
                  key={i}
                  type="button"
                  title={`${clock(c.t)} ${c.claimKo || c.claim}`}
                  aria-label={`${clock(c.t)} 재생`}
                  onClick={() => setActive(c)}
                  style={{ left: `${Math.min(100, (c.t / dur) * 100)}%` }}
                  className={`absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-white ${
                    active === c ? "bg-emerald-700" : "bg-emerald-500 hover:bg-emerald-700"
                  }`}
                />
              ))}
            </div>
            <ul className="mt-3 flex flex-col gap-1">
              {list.map((c, i) => (
                <li key={i}>
                  <button type="button" onClick={() => setActive(c)} className="flex w-full gap-2 rounded-md px-1 py-1 text-left hover:bg-neutral-50">
                    <span className="w-12 shrink-0 text-[12px] tabular-nums text-emerald-800">{clock(c.t)}</span>
                    <span className="text-[12.5px] text-neutral-800">{c.claimKo || c.claim}</span>
                  </button>
                </li>
              ))}
            </ul>
            {active && active.videoId === id && (
              <div className="mt-3">
                <Player c={active} />
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

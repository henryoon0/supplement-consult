import { useState } from "react";
import { checkGate } from "@/lib/supplement/gate";
import type { Consult } from "./use-consult";
import { ThreadPodcast } from "./thread-podcast";
import {
  BrainSources,
  CARD,
  Composer,
  FollowUps,
  GateNotice,
  ProductRow,
  ProfileFields,
  ProfileUpdateBar,
  SampleChips,
  Thinking,
} from "./parts";

// 보충제 상담 정식 화면(/supplement). henry 픽(09-28) = 시안 2 "스레드".
// 시안 원본은 /prototypes/supplement 가 이 파일을 가져다 쓴다.

export function ProfileDrawer({ c }: { readonly c: Consult }) {
  const [open, setOpen] = useState(false);
  const gate = checkGate(c.profile);
  return (
    <div className={`${CARD} p-3`}>
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center justify-between text-[12.5px]">
        <span className="text-neutral-900">내 프로필</span>
        <span className={gate.status === "allowed" ? "text-emerald-700" : "text-amber-700"}>
          {gate.status === "allowed" ? "제품까지 볼 수 있음" : gate.status === "refer" ? "상담 먼저" : `${gate.missing.length}칸 남음`}
        </span>
      </button>
      {open && (
        <div className="mt-3">
          <ProfileFields profile={c.profile} onChange={c.setProfile} compact />
        </div>
      )}
    </div>
  );
}

/* 스레드: 내 질문이 글이 되고, 약사 답글이 그 아래 달린다. 제품은 답글에 붙은 첨부. */
export function ThreadView({ c }: { readonly c: Consult }) {
  return (
    <div className="mx-auto flex max-w-[680px] flex-col gap-4">
      <ProfileDrawer c={c} />
      <Composer onAsk={c.ask} busy={c.busy} placeholder="스레드에 댓글 달듯이 물어봐" />
      {c.turns.length === 0 && <SampleChips onAsk={c.ask} busy={c.busy} />}
      {[...c.turns].reverse().map((t, i) => (
        <article key={i} className={`${CARD} p-4`}>
          <div className="flex gap-3">
            <span className="grid size-8 shrink-0 place-items-center rounded-full bg-neutral-200 text-[11px] text-neutral-600">나</span>
            <p className="pt-1 text-[13.5px] text-neutral-900">{t.user}</p>
          </div>
          <div className="ml-4 mt-3 flex gap-3 border-l-0 pl-7 shadow-[-1px_0_0_0_rgba(10,10,10,0.08)]">
            <span className="grid size-7 shrink-0 place-items-center rounded-full bg-emerald-700 text-[10.5px] font-semibold text-white">약</span>
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <span className="text-[12px] font-medium text-neutral-900">박약사 말투</span>
              {t.result ? (
                <>
                  <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-neutral-800">{t.result.reply}</p>
                  <BrainSources result={t.result} />
                  <ProfileUpdateBar result={t.result} profile={c.profile} onApply={c.setProfile} />
                  <GateNotice result={t.result} />
                  {t.result.recommendations.map((r) => (
                    <div key={r.slug} className="rounded-lg bg-neutral-50 p-2">
                      <p className="px-2 text-[12.5px] font-medium text-neutral-900">
                        {r.nameKo} <span className="font-normal text-neutral-500">· {r.how}</span>
                      </p>
                      {r.products.slice(0, 2).map((p) => (
                        <ProductRow key={p.asin} p={p} />
                      ))}
                      <ThreadPodcast claims={r.podcast} />
                    </div>
                  ))}
                  {i === 0 && <FollowUps result={t.result} onAsk={c.ask} busy={c.busy} />}
                </>
              ) : t.error ? (
                <p className="text-[12px] text-red-600">{t.error}</p>
              ) : (
                <Thinking />
              )}
            </div>
          </div>
        </article>
      ))}
    </div>
  );
}


/** 시안 하네스가 쓰는 옛 이름 */
export const VariantThread = ThreadView;

"use client";

import { ThreadView } from "./_ui/thread-view";
import { useConsult } from "./_ui/use-consult";

export function SupplementClient() {
  const consult = useConsult({ persist: true });
  return (
    <main className="mx-auto max-w-[1180px] px-5 pb-24 pt-6">
      <header className="mb-5 flex items-center justify-between gap-3">
        <h1 className="text-[15px] font-medium text-neutral-900">보충제 상담</h1>
        <button
          type="button"
          onClick={consult.reset}
          className="rounded-lg px-2.5 py-1.5 text-[12px] text-neutral-500 hover:bg-neutral-950/[0.03]"
        >
          대화 비우기
        </button>
      </header>
      <ThreadView c={consult} />
    </main>
  );
}

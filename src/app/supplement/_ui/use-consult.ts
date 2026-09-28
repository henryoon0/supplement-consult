"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage, ConsultResult } from "@/lib/supplement/advise";
import { EMPTY_PROFILE, type SupplementProfile } from "@/lib/supplement/gate";

// 상담 상태. 정식 화면과 다섯 시안이 같이 쓴다. 시안을 바꿔도 대화와 프로필이 그대로 남아야
// "같은 상담을 다른 화면으로 보기"가 된다.

export type Turn = { user: string; result?: ConsultResult; error?: string };

const PROFILE_KEY = "supplement-profile";

/** persist = 대화를 서버 파일(data/…/consult-history.json)에 남긴다. 정식 화면(/supplement)만 켠다. */
export function useConsult({ persist = false }: { persist?: boolean } = {}) {
  // 이 훅은 브라우저에서만 돈다(entry.tsx 가 ssr:false 로 싣는다). 그래서 첫 렌더에 바로 읽는다.
  const [profile, setProfileState] = useState<SupplementProfile>(() => {
    try {
      const saved = localStorage.getItem(PROFILE_KEY);
      return saved ? { ...EMPTY_PROFILE, ...JSON.parse(saved) } : EMPTY_PROFILE;
    } catch {
      return EMPTY_PROFILE;
    }
  });
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);

  const setProfile = useCallback((next: SupplementProfile) => {
    setProfileState(next);
    try {
      localStorage.setItem(PROFILE_KEY, JSON.stringify(next));
    } catch {}
  }, []);

  const ask = useCallback(
    async (text: string) => {
      const q = text.trim();
      if (!q || busy) return;
      const messages: ChatMessage[] = turns.flatMap((t) =>
        t.result
          ? [{ role: "user" as const, text: t.user }, { role: "assistant" as const, text: t.result.reply }]
          : []
      );
      messages.push({ role: "user", text: q });
      setTurns((prev) => [...prev, { user: q }]);
      setBusy(true);
      try {
        const res = await fetch("/api/supplement/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messages, profile }),
        });
        const data = await res.json();
        setTurns((prev) =>
          prev.map((t, i) =>
            i === prev.length - 1 ? (res.ok ? { ...t, result: data } : { ...t, error: data.error ?? "실패" }) : t
          )
        );
      } catch {
        setTurns((prev) => prev.map((t, i) => (i === prev.length - 1 ? { ...t, error: "연결 실패" } : t)));
      } finally {
        setBusy(false);
      }
    },
    [busy, profile, turns]
  );

  const reset = useCallback(() => setTurns([]), []);

  // 저장: 처음 불러오기가 끝난 뒤, 답을 기다리는 중이 아닐 때만 쓴다(반쯤 된 턴을 남기지 않게).
  const loaded = useRef(!persist);
  useEffect(() => {
    if (!persist) return;
    let alive = true;
    fetch("/api/supplement/history")
      .then((r) => r.json())
      .then((d) => {
        if (alive && Array.isArray(d.turns)) setTurns(d.turns);
      })
      .catch(() => {})
      .finally(() => {
        loaded.current = true;
      });
    return () => {
      alive = false;
    };
  }, [persist]);
  useEffect(() => {
    if (!persist || !loaded.current || busy) return;
    void fetch("/api/supplement/history", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ turns: turns.map((t) => ({ ...t, at: new Date().toISOString() })) }),
    }).catch(() => {});
  }, [persist, turns, busy]);
  const latest = [...turns].reverse().find((t) => t.result)?.result;

  return { profile, setProfile, turns, busy, ask, reset, latest };
}

export type Consult = ReturnType<typeof useConsult>;


import { useState } from "react";
import { ArrowUpIcon, CircleStackIcon, PlayCircleIcon, ShieldExclamationIcon, StarIcon } from "@heroicons/react/16/solid";
import type { ConsultResult, Recommendation } from "@/lib/supplement/advise";
import type { CatalogProduct } from "@/lib/supplement/catalog";
import { GATE_FIELDS, type SupplementProfile } from "@/lib/supplement/gate";

export const CARD = "rounded-xl bg-white ring-1 ring-neutral-950/5";

export const SAMPLE_QUESTIONS = [
  "요즘 잠이 얕아서 밤에 두 번씩 깨. 마그네슘 먹으면 나아져?",
  "조금만 피곤해도 구내염이 자주 나. 뭐 챙겨 먹어?",
  "주 3회 웨이트 하는데 크레아틴 먹어도 돼? 얼마나?",
  "종합비타민 하나만 먹는다면 뭘 봐야 해?",
];

export function Composer({
  onAsk,
  busy,
  placeholder = "궁금한 거 던져봐",
}: {
  readonly onAsk: (text: string) => void;
  readonly busy: boolean;
  readonly placeholder?: string;
}) {
  const [text, setText] = useState("");
  const submit = () => {
    if (!text.trim() || busy) return;
    onAsk(text);
    setText("");
  };
  return (
    <form
      className={`${CARD} flex items-end gap-2 p-2`}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        rows={2}
        placeholder={placeholder}
        className="min-h-[44px] flex-1 resize-none bg-transparent px-2 py-1.5 text-[13.5px] outline-none placeholder:text-neutral-400"
      />
      <button
        type="submit"
        disabled={busy || !text.trim()}
        aria-label="보내기"
        className="grid size-8 place-items-center rounded-lg bg-emerald-700 text-white hover:bg-emerald-800 disabled:opacity-40"
      >
        <ArrowUpIcon className="size-4" aria-hidden />
      </button>
    </form>
  );
}

export function SampleChips({ onAsk, busy }: { readonly onAsk: (t: string) => void; readonly busy: boolean }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {SAMPLE_QUESTIONS.map((q) => (
        <button
          key={q}
          type="button"
          disabled={busy}
          onClick={() => onAsk(q)}
          className="rounded-full bg-white px-3 py-1 text-[12px] text-neutral-600 ring-1 ring-neutral-950/5 hover:bg-neutral-50 disabled:opacity-40"
        >
          {q}
        </button>
      ))}
    </div>
  );
}

export function FollowUps({ result, onAsk, busy }: { readonly result: ConsultResult; readonly onAsk: (t: string) => void; readonly busy: boolean }) {
  if (!result.followUp.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {result.followUp.map((q) => (
        <button
          key={q}
          type="button"
          disabled={busy}
          onClick={() => onAsk(q)}
          className="rounded-full bg-neutral-100 px-2.5 py-1 text-[12px] text-neutral-700 hover:bg-neutral-200 disabled:opacity-40"
        >
          {q}
        </button>
      ))}
    </div>
  );
}

export function ProfileFields({
  profile,
  onChange,
  compact = false,
}: {
  readonly profile: SupplementProfile;
  readonly onChange: (p: SupplementProfile) => void;
  readonly compact?: boolean;
}) {
  return (
    <div className={compact ? "grid grid-cols-2 gap-2" : "flex flex-col gap-2.5"}>
      {GATE_FIELDS.map((f) => (
        <label key={f.key} className="flex flex-col gap-1">
          <span className="text-[11.5px] text-neutral-500">{f.label}</span>
          <input
            value={profile[f.key]}
            onChange={(e) => onChange({ ...profile, [f.key]: e.target.value })}
            placeholder={f.hint}
            className="rounded-lg bg-neutral-50 px-2.5 py-1.5 text-[13px] outline-none ring-1 ring-neutral-950/5 focus:bg-white focus:ring-emerald-700/40"
          />
        </label>
      ))}
    </div>
  );
}

export function GateNotice({ result }: { readonly result: ConsultResult }) {
  if (result.gate.status === "allowed") return null;
  const text =
    result.gate.status === "incomplete"
      ? `제품은 프로필을 채우면 보여요 · 남은 칸: ${result.gate.missing.join(", ")}`
      : `의사·약사와 먼저 상의할 신호가 있어 제품은 숨겼어요 · ${result.gate.reasons.join(", ")}`;
  return (
    <p className="flex items-start gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
      <ShieldExclamationIcon className="mt-px size-4 shrink-0" aria-hidden />
      {text}
    </p>
  );
}

const usd = (n: number) => `$${n.toFixed(2)}`;

export function ProductRow({ p }: { readonly p: CatalogProduct }) {
  return (
    <a
      href={`https://www.amazon.com/dp/${p.asin}`}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-neutral-50"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[12.5px] font-medium text-neutral-900">{p.brand}</span>
        <span className="block truncate text-[11.5px] text-neutral-500">{p.title}</span>
      </span>
      <span className="shrink-0 text-right text-[11.5px] tabular-nums text-neutral-600">
        <span className="block text-[12.5px] text-neutral-900">{usd(p.price)}</span>
        <span className="inline-flex items-center gap-0.5">
          <StarIcon className="size-3 text-amber-500" aria-hidden />
          {p.rating} · {p.reviews.toLocaleString()}
        </span>
      </span>
    </a>
  );
}

export function PodcastLine({ r }: { readonly r: Recommendation }) {
  const c = r.podcast[0];
  if (!c) return null;
  return (
    <a
      href={`https://youtu.be/${c.videoId}?t=${c.t}`}
      target="_blank"
      rel="noreferrer"
      className="flex items-start gap-1.5 text-[11.5px] leading-snug text-neutral-500 hover:text-neutral-800"
    >
      <PlayCircleIcon className="mt-px size-3.5 shrink-0" aria-hidden />
      <span>
        {c.speaker}: {c.claim}
      </span>
    </a>
  );
}

export function RecCard({ r }: { readonly r: Recommendation }) {
  return (
    <article className={`${CARD} flex flex-col gap-2 p-3`}>
      <header className="flex items-baseline justify-between gap-2">
        <h3 className="text-[14px] font-semibold text-neutral-900">{r.nameKo}</h3>
        <span className="text-[11px] text-neutral-500">{r.evidence}</span>
      </header>
      <p className="text-[12.5px] text-neutral-700">{r.why}</p>
      <p className="text-[12px] text-emerald-800">{r.how}</p>
      <PodcastLine r={r} />
      {r.products.length > 0 && (
        <div className="-mx-1 shadow-[0_-1px_0_0_rgba(10,10,10,0.05)] pt-1">
          {r.products.map((p) => (
            <ProductRow key={p.asin} p={p} />
          ))}
        </div>
      )}
    </article>
  );
}

export function Thinking() {
  return <p className="animate-pulse text-[12.5px] text-neutral-400">답글 쓰는 중…</p>;
}

/** GBrain 에서 찾은 페이지. 답에 쓴 페이지는 초록 테두리, 누르면 원문을 펼친다. */
export function BrainSources({ result }: { readonly result: ConsultResult }) {
  const [open, setOpen] = useState<{ slug: string; text: string } | null>(null);
  const sources = result.brain?.sources ?? [];
  if (!sources.length) return null;
  const toggle = async (slug: string) => {
    if (open?.slug === slug) return setOpen(null);
    const res = await fetch(`/api/supplement/brain?slug=${encodeURIComponent(slug)}`);
    const data = await res.json().catch(() => ({}));
    setOpen({ slug, text: res.ok ? String(data.text).replace(/^---[\s\S]*?---\n/, "").trim() : "페이지를 못 읽었어요." });
  };
  return (
    <div className="flex flex-col gap-1.5">
      <p className="flex items-center gap-1 text-[11.5px] text-neutral-500">
        <CircleStackIcon className="size-3.5" aria-hidden />
        내 뇌에서 찾은 페이지 · 검색어 {result.brain.terms.join(", ")}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {sources.map((s) => (
          <button
            key={s.slug}
            type="button"
            onClick={() => toggle(s.slug)}
            aria-pressed={open?.slug === s.slug}
            className={`rounded-full px-2.5 py-1 text-[11.5px] ring-1 ${
              s.used ? "bg-emerald-50 text-emerald-800 ring-emerald-700/30" : "bg-white text-neutral-500 ring-neutral-950/5"
            } hover:bg-neutral-50`}
          >
            {s.title}
            {s.used && " · 답에 씀"}
          </button>
        ))}
      </div>
      {open && (
        <pre className="max-h-[320px] overflow-auto whitespace-pre-wrap rounded-lg bg-neutral-50 p-3 font-sans text-[12px] leading-relaxed text-neutral-700">
          {open.text}
        </pre>
      )}
    </div>
  );
}

/** 대화에서 알게 된 프로필 사실. 누르면 프로필 칸에 붙인다(자동 저장 안 함). */
export function ProfileUpdateBar({
  result,
  profile,
  onApply,
}: {
  readonly result: ConsultResult;
  readonly profile: SupplementProfile;
  readonly onApply: (p: SupplementProfile) => void;
}) {
  const [done, setDone] = useState(false);
  const entries = Object.entries(result.profileUpdates ?? {}) as [keyof SupplementProfile, string][];
  if (!entries.length) return null;
  const label = (k: keyof SupplementProfile) => GATE_FIELDS.find((f) => f.key === k)?.label ?? k;
  const apply = () => {
    const next = { ...profile };
    for (const [k, v] of entries) {
      const cur = next[k].trim();
      next[k] = !cur || cur === "없음" || cur === "해당 없음" ? v : cur.includes(v) ? cur : `${cur}, ${v}`;
    }
    onApply(next);
    setDone(true);
  };
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-sky-50 px-3 py-2 text-[12px] text-sky-900">
      <span>대화에서 알게 된 것:</span>
      {entries.map(([k, v]) => (
        <span key={k} className="rounded bg-white px-1.5 py-0.5 ring-1 ring-sky-900/10">
          {label(k)} · {v}
        </span>
      ))}
      <button
        type="button"
        disabled={done}
        onClick={apply}
        className="ml-auto rounded-md bg-emerald-700 px-2 py-1 text-white hover:bg-emerald-800 disabled:bg-emerald-700/15 disabled:text-emerald-800"
      >
        {done ? "반영했어요" : "프로필에 반영"}
      </button>
    </div>
  );
}

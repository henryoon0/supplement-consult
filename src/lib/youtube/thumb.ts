// 유튜브 썸네일 화질 올리기.
//
// 실측(2026-08-18, 표본 WCrnS09vpfo):
//   mqdefault      320x180   16:9
//   hqdefault      480x360   4:3  ← 위아래 검은 띠. 16:9 카드에 넣으면 실효 480x270
//   sddefault      640x480   4:3
//   hq720         1280x720   16:9
//   maxresdefault 1280x720   16:9  (업로더가 HD로 올렸을 때만 존재)
//
// 저장된 데이터는 hqdefault 803건 · hq720 281건 · mqdefault 100+건이라 대부분이 흐렸다.
// 레티나는 CSS 1px 에 실제 2px 를 쓰므로, 300px 폭 카드는 원본 600px 이 필요하다.
//
// 데이터를 마이그레이션하지 않고 **그릴 때** 올린다. 저장분도 즉시 선명해지고,
// hq720 이 없는 영상은 원본으로 되돌아가면 되기 때문(→ VideoThumb 의 onError).

const YT_HOSTS = /^(i\.ytimg\.com|img\.youtube\.com|i\d?\.ytimg\.com)$/;

/** 우리가 올려도 되는 기본 변형들. 이 이름일 때만 손댄다. */
const UPGRADABLE = new Set([
  "default",
  "mqdefault",
  "hqdefault",
  "sddefault",
  "hq720",
  "maxresdefault",
]);

/**
 * ytimg 썸네일 주소를 1280x720(hq720)으로 올린다.
 *
 * 건드리지 않는 것:
 *  - 유튜브가 아닌 주소
 *  - 쿼리가 붙은 주소 (`hqdefault_custom_1.jpg?sqp=...` 같은 서명된 스크랩 썸네일은
 *    주소를 바꾸면 404 가 난다 — flashcards/candidates 라우트 주석 참고)
 *  - 이미 hq720 인 주소
 */
export function hiResThumb(url: string | null | undefined): string | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  if (!YT_HOSTS.test(u.hostname)) return url;
  if (u.search) return url; // 서명된 주소는 그대로
  const m = u.pathname.match(/^\/vi\/([A-Za-z0-9_-]{11})\/([A-Za-z0-9_]+)\.jpg$/);
  if (!m) return url;
  const [, id, variant] = m;
  if (!UPGRADABLE.has(variant)) return url;
  if (variant === "hq720") return url;
  return `${u.protocol}//${u.hostname}/vi/${id}/hq720.jpg`;
}

/**
 * 화면에서 순서대로 시도할 주소들. 앞에서 404 가 나면 다음으로 넘어간다.
 * hq720 은 모든 영상에 있지는 않아서 원본을 반드시 뒤에 둔다.
 */
/**
 * X(트위터) 이미지 주소에 확장자도 format 쿼리도 없으면 pbs.twimg.com 이 404 를 준다
 * (09-24 실측: X 브리핑 썸네일 일부가 `…/media/<id>` 로만 저장돼 TOP 3 카드가 깨졌다).
 * format 을 붙인 주소를 먼저 시도한다. 데이터는 그대로 두고 그릴 때 고친다.
 */
function twimgMediaFixed(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.hostname !== "pbs.twimg.com" || u.search) return null;
  if (!/^\/media\/[A-Za-z0-9_-]+$/.test(u.pathname)) return null;
  return `${u.origin}${u.pathname}?format=jpg&name=medium`;
}

export function thumbCandidates(url: string | null | undefined): string[] {
  if (!url) return [];
  const tw = twimgMediaFixed(url);
  if (tw) return [tw, url];
  const hi = hiResThumb(url);
  return hi && hi !== url ? [hi, url] : [url];
}

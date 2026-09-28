// 영상 위치로 바로 여는 주소들. t 는 초.
export const clock = (t: number) => {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
};
export const watchUrl = (id: string, t: number) => `https://www.youtube.com/watch?v=${id}&t=${t}s`;
export const embedUrl = (id: string, t: number, autoplay = true) =>
  `https://www.youtube-nocookie.com/embed/${id}?start=${t}${autoplay ? "&autoplay=1" : ""}&rel=0`;
export const thumbUrl = (id: string) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;

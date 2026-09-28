"use client";

import dynamic from "next/dynamic";

// 프로필을 localStorage 에서 첫 렌더에 읽으려고 서버 렌더를 끈다.
export const SupplementEntry = dynamic(() => import("./client").then((m) => m.SupplementClient), { ssr: false });

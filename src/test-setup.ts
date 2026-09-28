import path from "node:path";
import os from "node:os";

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// 테스트가 실제 data/ 를 건드리지 않게 모든 저장 경로를 임시 폴더로 고정한다.
// 경로 override 를 지운 테스트가 남긴 백그라운드 작업도 실제 파일로 새지 않는다.
const tmp = (name: string) => path.join(os.tmpdir(), `__supplement-consult.test.${name}`);
process.env.INSTAGRAM_COMMENTS_DIR = tmp("comments");
process.env.INSTAGRAM_DM_DIR = tmp("dm");
process.env.IG_AUTOMATION_DATA_PATH = tmp("rules.json");
process.env.IG_AUTOMATION_ENGINE_LOG_PATH = tmp("engine-log.json");
process.env.IG_AUTOMATION_GATE_PATH = tmp("gate.json");
process.env.INSTAGRAM_SETTINGS_PATH = tmp("settings.json");

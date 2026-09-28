#!/usr/bin/env bash
# 보충제 상담 제거 — install.sh 가 만든 것만 지운다.
# 기록(상담 기록)도 함께 지워진다. 남기려면 먼저 ~/.supplement-consult/data 를 다른 곳에 복사해 두세요.
set -euo pipefail

main() {
  local ROOT="$HOME/.supplement-consult"
  local PLIST="$HOME/Library/LaunchAgents/com.supplement-consult.plist"
  local LAUNCHER="$HOME/Applications/보충제 상담.app"

  if [ "$(uname -s)" = "Darwin" ]; then
    launchctl bootout "gui/$(id -u)/com.supplement-consult" >/dev/null 2>&1 || true
  fi
  rm -f "$PLIST"
  rm -rf "$LAUNCHER" "$ROOT"
  # 설치가 새로 만든 폴더가 비어 있으면 같이 지운다 (원래 있던 폴더는 안에 뭔가 있으니 남는다)
  rmdir "$HOME/Applications" "$HOME/Library/LaunchAgents" 2>/dev/null || true
  echo "보충제 상담를 제거했어요."
}

main "$@"

#!/usr/bin/env bash
# 보충제 상담 설치 (macOS 전용). 다시 실행하면 최신 버전으로 업데이트된다. 기록(data)은 유지된다.
#
#   비공개 저장소라 두 가지 방법이 있다.
#   1) gh(GitHub CLI) 로그인돼 있으면:
#      gh api repos/henryoon0/supplement-consult/contents/install.sh -H "Accept: application/vnd.github.raw" | bash
#   2) GitHub 에서 ZIP 을 받아 푼 폴더에서:  bash install.sh
#
# 만드는 것 (uninstall.sh 가 전부 지운다):
#   ~/.supplement-consult/                   앱·Node·기록·로그
#   ~/Library/LaunchAgents/com.supplement-consult.plist   로그인하면 앱을 켜 두는 설정
#   ~/Applications/보충제 상담.app        누르면 브라우저로 화면을 연다
#
# 선택 환경변수: SC_PORT(기본 3458), SC_REF(받을 브랜치, 기본 main)
set -euo pipefail

main() {
  local REPO="henryoon0/supplement-consult"
  local REF="${SC_REF:-main}"
  local PORT="${SC_PORT:-3458}"
  local NODE_VERSION="v22.23.3"
  local ROOT="$HOME/.supplement-consult"
  local LABEL="com.supplement-consult"
  local PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  local LAUNCHER="$HOME/Applications/보충제 상담.app"

  say() { printf '%s\n' "$*"; }
  fail() {
    say ""
    say "설치를 멈췄어요: $*"
    say "문제가 계속되면 아래 결과를 복사해 공유해 주세요:"
    say "  bash \"$ROOT/bin/doctor.sh\"   (설치가 중간에 멈췄다면 이 파일이 없을 수 있어요)"
    exit 1
  }

  # ── 1. 운영체제 확인: 맥이 아니면 아무것도 바꾸지 않고 멈춘다 ──
  if [ "$(uname -s)" != "Darwin" ]; then
    say "보충제 상담 설치 스크립트는 macOS 전용이에요. 이 컴퓨터에는 아무것도 바꾸지 않았어요."
    say "Windows·Linux 에서는 Node.js 22 를 설치한 뒤 직접 실행할 수 있어요(시험하지 않은 방법):"
    say "  https://github.com/$REPO#맥이-아닌-컴퓨터"
    exit 1
  fi

  local ARCH
  case "$(uname -m)" in
    arm64) ARCH="arm64" ;;
    x86_64) ARCH="x64" ;;
    *) fail "알 수 없는 맥 종류예요: $(uname -m)" ;;
  esac

  say "보충제 상담를 설치합니다 (맥 $ARCH, 포트 $PORT)"
  mkdir -p "$ROOT/data" "$ROOT/logs" "$ROOT/bin"
  # TMP 는 전역으로 둔다 — 함수가 끝난 뒤 EXIT 정리에서도 보여야 한다.
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT

  # ── 2. Node.js: 공식 배포 파일을 버전 고정으로 받는다 (Homebrew·관리자 비밀번호 불필요) ──
  local NODE_DIR="$ROOT/node"
  if [ "$(cat "$NODE_DIR/.version" 2>/dev/null || true)" != "$NODE_VERSION-$ARCH" ]; then
    say "· Node.js $NODE_VERSION 받는 중 (약 50MB)"
    local NAME="node-$NODE_VERSION-darwin-$ARCH"
    local BASE="https://nodejs.org/dist/$NODE_VERSION"
    curl -fsSL "$BASE/$NAME.tar.gz" -o "$TMP/node.tar.gz" ||
      fail "Node.js 를 받지 못했어요. 회사 네트워크라면 nodejs.org 접속이 막혀 있을 수 있어요."
    curl -fsSL "$BASE/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt" || fail "Node.js 확인 파일을 받지 못했어요."
    local want got
    want="$(grep " $NAME.tar.gz\$" "$TMP/SHASUMS256.txt" | cut -d' ' -f1)"
    got="$(shasum -a 256 "$TMP/node.tar.gz" | cut -d' ' -f1)"
    [ -n "$want" ] && [ "$want" = "$got" ] || fail "받은 Node.js 파일이 공식 파일과 달라요. 다시 시도해 주세요."
    rm -rf "$NODE_DIR"
    mkdir -p "$NODE_DIR"
    tar -xzf "$TMP/node.tar.gz" -C "$NODE_DIR" --strip-components 1
    echo "$NODE_VERSION-$ARCH" > "$NODE_DIR/.version"
  fi
  local NODE="$NODE_DIR/bin/node"
  local NPM="$NODE_DIR/bin/npm"

  # ── 3. 앱 소스: 저장소 안에서 파일로 실행했으면 그 폴더를, 아니면(curl | bash) GitHub 에서 받는다 ──
  # curl | bash 로 실행하면 스크립트 파일이 없다 — 현재 폴더를 저장소로 착각하지 않게 BASH_SOURCE 가 진짜 파일일 때만 쓴다.
  local SRC="$TMP/src"
  mkdir -p "$SRC"
  local SELF="${BASH_SOURCE[0]:-}"
  if [ -n "$SELF" ] && [ -f "$SELF" ] && [ -f "$(dirname "$SELF")/package.json" ] && [ -f "$(dirname "$SELF")/src/instrumentation.ts" ]; then
    local HERE
    HERE="$(cd "$(dirname "$SELF")" && pwd)"
    say "· 이 폴더의 앱을 설치합니다: $HERE"
    (cd "$HERE" && tar -cf - --exclude './node_modules' --exclude './.next' --exclude './data' --exclude './data-backup-*' \
      --exclude './.git' --exclude './*.log' --exclude './*.tsbuildinfo' --exclude './next-env.d.ts' .) | tar -xf - -C "$SRC"
  else
    # 비공개 저장소는 로그인 없이 받을 수 없다 — gh 로그인을 쓴다.
    command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1 ||
      fail "비공개 저장소라 GitHub 로그인이 필요해요. https://github.com/$REPO 에서 Code > Download ZIP 으로 받아 푼 뒤, 그 폴더에서 bash install.sh 를 실행해 주세요."
    say "· GitHub 에서 앱을 받는 중 ($REPO@$REF)"
    gh api "repos/$REPO/tarball/$REF" > "$TMP/app.tar.gz" ||
      fail "GitHub 에서 앱을 받지 못했어요. 이 저장소에 초대받은 계정으로 gh 에 로그인했는지 확인해 주세요."
    tar -xzf "$TMP/app.tar.gz" -C "$SRC" --strip-components 1
  fi

  # 소스 지문 — 같은 버전이면 다시 빌드하지 않는다 (두 번 설치해도 결과가 같게)
  local STAMP
  STAMP="$(cd "$SRC" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256 | shasum -a 256 | cut -d' ' -f1)"
  local APP="$ROOT/app"

  local REBUILT=0
  if [ "$(cat "$APP/.stamp" 2>/dev/null || true)" != "$STAMP" ] || [ ! -d "$APP/.next" ]; then
    REBUILT=1
    say "· 앱 준비 중 (패키지 설치·빌드, 1~3분)"
    # 쓰던 버전은 옆으로 비켜 두고 제자리에서 빌드한다. 실패하면 쓰던 버전을 되돌려 놓는다.
    # (Next.js 빌드 결과는 폴더 위치에 묶이므로 다른 곳에서 빌드해 옮기지 않는다.)
    stop_service
    rm -rf "$APP.old"
    [ -d "$APP" ] && mv "$APP" "$APP.old"
    mv "$SRC" "$APP"
    # 기록 폴더 바로가기(data)는 빌드가 끝난 뒤에 만든다. 빌드 도구(Turbopack)가 data 안을 훑다가
    # 앱 폴더 밖을 가리키는 바로가기를 만나면 빌드를 멈춘다 — 기록이 있는 사람의 업데이트가 실패했다.
    if (
      cd "$APP"
      export PATH="$NODE_DIR/bin:$PATH" npm_config_cache="$TMP/npm-cache" npm_config_update_notifier=false \
        npm_config_fund=false npm_config_audit=false NEXT_TELEMETRY_DISABLED=1
      "$NPM" ci --no-progress --loglevel=error >"$ROOT/logs/install.log" 2>&1 &&
        "$NPM" run build >>"$ROOT/logs/install.log" 2>&1
    ); then
      ln -sfn "$ROOT/data" "$APP/data"
      echo "$STAMP" > "$APP/.stamp"
      rm -rf "$APP.old"
    else
      tail -20 "$ROOT/logs/install.log"
      rm -rf "$APP"
      [ -d "$APP.old" ] && mv "$APP.old" "$APP" && start_service
      fail "앱 빌드에 실패했어요. 쓰던 버전은 그대로 두었어요. 자세한 기록: $ROOT/logs/install.log"
    fi
  else
    say "· 이미 최신 버전이에요"
  fi

  # ── 4. 진단·실행 도우미 ──
  write_if_changed "$ROOT/bin/doctor.sh" "$(doctor_script)" || true
  chmod +x "$ROOT/bin/doctor.sh"

  # ── 5. 로그인하면 앱을 켜 두는 설정 (LaunchAgent). 설치 셸의 PATH 를 넘겨 Claude Code·Codex 를 찾게 한다 ──
  mkdir -p "$HOME/Library/LaunchAgents"
  local PLIST_CHANGED=0
  write_if_changed "$PLIST" "$(plist_xml)" && PLIST_CHANGED=1
  # 바뀐 게 없고 이미 돌고 있으면 건드리지 않는다 (다시 설치해도 자동화가 끊기지 않게)
  if [ "$REBUILT" = 1 ] || [ "$PLIST_CHANGED" = 1 ] || ! service_loaded; then
    start_service
  fi

  # ── 6. 응용 프로그램 폴더의 실행 아이콘 (누르면 브라우저로 화면을 연다) ──
  if [ ! -d "$LAUNCHER" ]; then
    mkdir -p "$HOME/Applications"
    osacompile -o "$LAUNCHER" -e "open location \"http://localhost:$PORT\"" >/dev/null 2>&1 ||
      say "  (실행 아이콘은 만들지 못했어요. 브라우저에서 http://localhost:$PORT 를 열면 돼요)"
  fi

  # ── 7. 켜졌는지 확인하고 화면을 연다 ──
  say "· 앱이 켜지기를 기다리는 중"
  local up=0
  for _ in $(seq 1 45); do
    if curl -fsS -o /dev/null "http://localhost:$PORT/api/supplement/history" 2>/dev/null; then up=1; break; fi
    sleep 1
  done

  say ""
  if [ "$up" = 1 ]; then
    say "설치 완료. 브라우저에서 http://localhost:$PORT 를 열었어요."
    open "http://localhost:$PORT" >/dev/null 2>&1 || true
  else
    say "설치는 끝났지만 앱이 아직 응답하지 않아요. 1분 뒤 http://localhost:$PORT 를 열어 보세요."
    say "그래도 안 열리면: bash \"$ROOT/bin/doctor.sh\""
  fi
  say ""
  say "다음에 할 일:"
  say "  1. (필수) AI 답변: 이 맥에 Claude Code 나 Codex 가 로그인돼 있어야 상담 답이 나와요"
  say "  2. (선택) 데이터 새로 받기: ax-hub 팀원이면 pipeline/README 대로 내 키를 넣고 돌려요"
  say ""
  say "다시 열 때: 응용 프로그램(Applications) 폴더의 '보충제 상담', 또는 http://localhost:$PORT"
  say "업데이트: 설치 명령을 한 번 더 실행 · 제거: bash \"$ROOT/app/uninstall.sh\""
}

write_if_changed() { # 내용이 같으면 파일을 건드리지 않는다. 바꿨으면 0, 그대로면 1 을 돌려준다.
  if [ "$(cat "$1" 2>/dev/null || true)" != "$2" ]; then printf '%s\n' "$2" > "$1"; return 0; fi
  return 1
}

service_loaded() {
  launchctl print "gui/$(id -u)/com.supplement-consult" >/dev/null 2>&1
}

stop_service() {
  launchctl bootout "gui/$(id -u)/com.supplement-consult" >/dev/null 2>&1 || true
  # bootout 은 끝나기 전에 돌아온다 — 앱이 실제로 내려갈 때까지 최대 10초 기다린다.
  # 바로 다시 올리면 "Bootstrap failed: 5" 로 거절당하는 경우가 있다 (2026-09-26 실측).
  for _ in $(seq 1 20); do service_loaded || return 0; sleep 0.5; done
}

start_service() {
  stop_service
  local err=""
  for _ in 1 2 3 4 5; do
    if err="$(launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.supplement-consult.plist" 2>&1)"; then return 0; fi
    service_loaded && return 0
    sleep 1
  done
  printf '%s\n' "launchctl bootstrap: $err" >> "$HOME/.supplement-consult/logs/install.log"
  printf '%s\n' "  (백그라운드 실행 등록에 실패했어요: $err)"
}

xml_escape() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' <<<"$1"; }

plist_xml() {
  local ROOT="$HOME/.supplement-consult" PORT="${SC_PORT:-3458}"
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.supplement-consult</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$ROOT/node/bin/node")</string>
    <string>$(xml_escape "$ROOT/app/node_modules/next/dist/bin/next")</string>
    <string>start</string>
    <string>-p</string>
    <string>$PORT</string>
    <string>-H</string>
    <string>127.0.0.1</string>
  </array>
  <key>WorkingDirectory</key><string>$(xml_escape "$ROOT/app")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(xml_escape "$ROOT/node/bin:$PATH")</string>
    <key>NEXT_TELEMETRY_DISABLED</key><string>1</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$(xml_escape "$ROOT/logs/server.log")</string>
  <key>StandardErrorPath</key><string>$(xml_escape "$ROOT/logs/server.log")</string>
</dict>
</plist>
EOF
}

doctor_script() {
  cat <<'EOF'
#!/usr/bin/env bash
# 보충제 상담 진단 — 이 결과를 복사해 공유해 주세요. 토큰 값은 출력하지 않아요.
ROOT="$HOME/.supplement-consult"
PORT="$(grep -A1 '<string>-p</string>' "$HOME/Library/LaunchAgents/com.supplement-consult.plist" 2>/dev/null | tail -1 | sed 's/.*<string>\(.*\)<\/string>.*/\1/')"
PORT="${PORT:-3458}"
echo "macOS: $(sw_vers -productVersion 2>/dev/null) $(uname -m)"
echo "Node: $(cat "$ROOT/node/.version" 2>/dev/null || echo 없음)"
echo "앱 버전 지문: $(cut -c1-12 "$ROOT/app/.stamp" 2>/dev/null || echo 없음)"
echo "백그라운드 실행: $(launchctl print "gui/$(id -u)/com.supplement-consult" >/dev/null 2>&1 && echo 등록됨 || echo 등록 안 됨)"
echo "화면 응답(포트 $PORT): $(curl -fsS -o /dev/null -w '%{http_code}' "http://localhost:$PORT/api/supplement/history" 2>/dev/null || echo 응답 없음)"
echo "상담 데이터: $(ls "$ROOT/app/seed/pages/ingredients" 2>/dev/null | wc -l | tr -d ' ')개 성분 페이지"
echo "AI 도구: claude=$(command -v claude >/dev/null && echo 있음 || echo 없음) codex=$(command -v codex >/dev/null && echo 있음 || echo 없음)"
echo "--- 최근 서버 기록 ---"
tail -15 "$ROOT/logs/server.log" 2>/dev/null | cat
EOF
}

main "$@"

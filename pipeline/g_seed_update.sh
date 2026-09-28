#!/usr/bin/env bash
# 카탈로그와 지식 페이지를 다시 만들어 앱의 seed/ 에 넣는다 (GBrain 없이 앱이 바로 읽는다).
set -euo pipefail
cd "$(dirname "$0")"
PY="${PYTHON:-python3}"
"$PY" e_dashboard_catalog.py
"$PY" f_gbrain_pages.py
rm -rf ../seed/pages && cp -R data/refined/gbrain_pages ../seed/pages
echo "seed/ 갱신 완료. 앱을 다시 켜면 반영돼요."

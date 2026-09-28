# 보충제 상담 (박약사 말투)

스레드에 댓글 달듯이 물어보면, 박약사 말투로 보충제를 추천해 주는 맥 앱입니다. 답마다 근거 페이지, 해외 건강 팟캐스트에서 나온 말(영상 시각 포함), 아마존 제품 예시(가격·별점·판매량)를 같이 보여줘요.

내 컴퓨터에서만 돌아요. 상담 데이터(지식 페이지·제품 카탈로그·말투)는 이 저장소에 들어 있어서 설치하면 바로 쓸 수 있어요.

> ⚠ **외부 공개 금지.** 말투 데이터(`seed/voice-pairs.json`)에는 스레드 댓글 단 사람들의 건강 고민 질문이 들어 있어요. 이 저장소는 비공개로만 두세요.

## 들어 있는 것

| 폴더 | 내용 |
| --- | --- |
| `seed/pages/` | 성분·주제 지식 페이지 122개 (근거 강도, 팟캐스트 발언, 커뮤니티 반응) |
| `seed/catalog.json` | 성분별 아마존 제품 예시와 판매·근거 숫자 |
| `seed/gate-rules.json` | 안전 관문 규칙 (복용 약·임신·질환에 따라 추천을 막는 조건) |
| `seed/voice-pairs.json` | 박약사 스레드의 실제 질문·답글 쌍 (말투 원천. 처방약·특정 제품 언급은 앱이 예시에서 뺌) |
| `seed/vocab.json` | 검색 어휘 |
| `pipeline/` | ax-hub DB에서 데이터를 새로 받아 `seed/`를 다시 만드는 스크립트 |

## 설치 (5분)

비공개 저장소라 먼저 **GitHub 초대를 수락**하고, 브라우저가 그 GitHub 계정으로 로그인돼 있어야 해요.

1. 이 저장소 페이지에서 초록색 **Code** 버튼 > **Download ZIP**. **다운로드** 폴더에 생긴 zip을 더블클릭해 풀어요.
2. **터미널**을 엽니다(`⌘ + 스페이스` > "터미널" > Enter).
3. `cd `(뒤에 한 칸)를 치고, 푼 폴더를 터미널 창으로 끌어다 놓은 뒤 Enter.
4. `bash install.sh` 입력 후 Enter.

Homebrew, 관리자 비밀번호는 필요 없어요. `설치 완료`가 나오면 브라우저에 `http://localhost:3458`이 열려요.

`gh`(GitHub 명령줄 도구)에 로그인된 개발자라면 한 줄로도 됩니다.

```bash
gh api repos/henryoon0/supplement-consult/contents/install.sh -H "Accept: application/vnd.github.raw" | bash
```

**필수:** 답을 쓰는 AI로 이 맥에 [Claude Code](https://claude.com/claude-code)나 Codex가 로그인돼 있어야 해요. 없으면 질문을 보내도 답이 나오지 않아요.

## 사용법

1. 응용 프로그램 폴더의 **보충제 상담**을 누르거나 `http://localhost:3458`을 엽니다.
2. **내 프로필**에 나이·복용 중인 약·임신 여부 등을 채우면 안전 관문이 그 조건으로 추천을 걸러요. 대화 중에 말한 내용으로도 채워져요.
3. 질문을 보내면 박약사 말투 답 → 근거 페이지 칩 → 성분별 제품 예시 → 팟캐스트 발언 순으로 보여요.

## 데이터 새로 받기 (ax-hub 팀원)

`seed/`는 만든 날의 스냅숏이에요. 최신 데이터로 다시 만들려면 ax-hub Supabase 권한이 있는 사람이 **자기 키로** 돌립니다. 키는 저장소에 넣지 않아요.

```bash
cd pipeline
cp .env.example .env          # 열어서 내 ax-hub 주소와 키를 넣기 (git 에 안 올라감)
python3 -m venv .venv && .venv/bin/pip install duckdb pyarrow requests
.venv/bin/python a_snapshot.py        # ax-hub → 로컬 스냅숏
.venv/bin/python b_ingredients.py     # 성분표
.venv/bin/python c1_corpus.py         # 팟캐스트 자막 정리
.venv/bin/python c3_full_cards.py     # 주장 카드 (AI 사용, 몇 시간)
PYTHON=.venv/bin/python bash g_seed_update.sh   # 카탈로그·페이지 → ../seed
```

- 카드 뽑기(`c2`·`c3`)는 AI를 부르는데, 기본값은 만든 사람 맥의 로컬 AI 프록시(`localhost:8787`)예요. 다른 AI를 쓰려면 `.env`나 터미널에 `PIPELINE_LLM_URL`, `PIPELINE_LLM_MODEL`을 지정하세요(OpenAI 호환 주소).
- 중간 데이터는 `pipeline/data/`에 쌓이고 수백 MB라 git에 올라가지 않아요.

## 알아두면 좋은 점

- **의학 조언이 아니에요.** 안전 관문이 복용 약·질환·임신 조건을 거르지만, 최종 판단은 의사·약사와 하도록 답에서도 안내해요.
- **만든 사람의 대시보드와 다른 점:** 대시보드는 지식 검색에 GBrain(별도 설치 프로그램)을 쓰고, 이 앱은 같은 페이지를 앱 안에서 찾아요. 평가 질문 40개로 비교했을 때 검색어 42개 중 32개는 같은 페이지가 나왔고, 나머지 10개는 "스트레스"·"피로"처럼 흔한 단어에서 순서가 달라요(이 앱은 성분 페이지를, GBrain은 생활 습관 페이지를 더 앞에 둠).
- **시험한 것:** 만든 사람의 맥에서 이 앱으로 실제 질문 1개("잠이 얕아서 밤에 자꾸 깨요")에 박약사 말투 답과 추천(마그네슘·캐모마일)이 나오는 것을 확인했어요. 단위 시험 16개.
- **시험하지 않은 것:** 새 맥에서의 설치(GitHub Actions에서 매번 시험하도록 설정만 해 둠), `pipeline/` 전체 다시 돌리기, 화면에서 답이 그려지는 것.
- **만드는 것:** `~/.supplement-consult`(앱·Node.js·상담 기록·로그), 로그인 자동 실행 설정 1개, 응용 프로그램 폴더의 실행 아이콘 1개.

## 업데이트 · 제거

- 업데이트: 설치 방법을 한 번 더 실행. 상담 기록은 유지돼요.
- 제거: `bash ~/.supplement-consult/app/uninstall.sh`
- 문제가 생기면 `bash ~/.supplement-consult/bin/doctor.sh` 결과를 공유해 주세요.

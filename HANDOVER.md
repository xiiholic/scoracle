# Scoracle 인수인계 문서

작성일: 2026-07-23
대상: 프로젝트를 이어받는 개발자
현행 코드 버전: v9.6 (배포 완료, 2026-07-23) / 실전 검증 표본은 v9.2 기준

---

## 0. 먼저 읽어야 할 것 (⚠️ 현안)

> **2026-07-26 업데이트**: 현안 1·2 모두 해결됨. 상세는 [Logs/Analysis/20260726_공백기간백필_v96검증_홈어드밴티지AB.md](Logs/Analysis/20260726_공백기간백필_v96검증_홈어드밴티지AB.md) 참고.
> - 현안 1 원인: KBO POST API가 XHR 헤더 없는 요청에 HTML 반환(봇 차단) → 크롤러 5종에 헤더 추가, 침묵 실패 fallback 제거. 예측 2026-07-26부터 재개.
> - 현안 2: 공백 기간(5/20~7/25) D-1 스냅샷 시점 예측 249경기로 v9.6 검증 완료 → **v9.6 구성 유지** (calibration RMSE 11.5→7.1%, ★★★ 61%). 단, 2026 시즌 방향 신호 자체가 약함(Top-1 52~56%) — 다음 개선은 승자 신호 강화.

<details>
<summary>(해결됨) 인수 시점 원본 현안 내용</summary>

### ⚠️ 1. 일일 예측 파이프라인이 2026-05-19 이후 멈춰 있음

GitHub Actions는 매일 정상 실행되고 `auto: predict` 커밋도 매일 쌓이고 있지만, **새 예측이 생성되지 않고 있습니다.**

| 지표 | 상태 |
|------|------|
| 마지막 auto 커밋 | 2026-07-23 (정상) |
| `prediction-log.json` 마지막 예측 | **2026-05-19** (약 2개월 정지) |
| `schedule-today.json` 날짜 | **2026-05-19** (고정됨) |
| `team-stats-snapshots/` | 매일 정상 축적 중 |

**원인**: [crawl-schedule.mjs:108-115](crawl-schedule.mjs#L108)

```js
} catch (e) {
  console.error('❌ 일정 크롤링 실패:', e.message);
  if (fs.existsSync(OUT_FILE)) {
    console.log(`⚠️  기존 캐시(${OUT_FILE}) 유지`);
    return;          // ← exit 0. 워크플로우가 실패를 감지하지 못함
  }
  process.exit(1);
}
```

일정 크롤링이 `fetch failed`로 실패하면 **기존 캐시를 그대로 두고 정상 종료**합니다. 그 결과 `sim-today.mjs`가 매일 같은 5/19 경기를 다시 예측하고 로그의 같은 항목을 덮어쓰기만 합니다. 커밋 diff는 매일 발생하므로 겉보기에는 파이프라인이 건강해 보입니다.

재현 (로컬):
```bash
node crawl-schedule.mjs
# → ❌ 일정 크롤링 실패: fetch failed
# → ⚠️  기존 캐시(schedule-today.json) 유지
# → 종료코드 0
```

**수정 방향** (권장 순서):
1. KBO 일정 API(`Schedule.asmx` / GameList) 응답을 직접 확인 — 엔드포인트·파라미터·차단 여부 점검
2. 캐시 fallback 시 **캐시 날짜가 오늘이 아니면 exit 1** 로 바꿔 워크플로우가 실패하도록 (침묵 실패 제거)
3. 같은 패턴이 `crawl-recent.mjs`(워크플로우에서 `continue-on-error: true`)에도 있는지 점검

### ⚠️ 2. v9.6 효과가 아직 실전 검증되지 않음

v9.6(calibration fix + 경기 해설)은 2026-04-10에 개발되었으나 **2026-07-23에야 배포**되었습니다. 그 사이 운영은 v9.2 엔진으로 돌았습니다.

- 누적 실전 로그 189건은 **전부 v9.2 기준**
- `prediction-log.json`의 v9.6 항목: 1건 (로컬 테스트분)

→ v9.6의 세 파라미터(temp 0.7 / prior g/15 / threshold 65%)가 calibration 역전을 실제로 고쳤는지는 **표본이 없어 알 수 없습니다.** 현안 1(일정 크롤러)을 고쳐 예측이 다시 쌓이기 시작하면, 50경기 이상 누적 후 `node stats-report.mjs --calibration`으로 재분석해야 합니다.

</details>

### ✅ 3. 리브랜딩 (2026-07-23 완료)

리포지토리가 `scoracle`로 rename되었고 v9.6 + 리브랜딩 코드가 배포되었습니다. Pages 자산·매니페스트·데이터 fetch 모두 200 확인.

| 항목 | 현재 |
|------|------|
| 리포 | `github.com/ldh-mini/scoracle` (구 URL은 301 리다이렉트) |
| Pages | `https://ldh-mini.github.io/scoracle/` |

> ⚠️ **구 Pages URL(`/baseball-sim/`)은 404입니다.** GitHub은 리포지토리 URL만 리다이렉트하고 Pages 경로는 리다이렉트하지 않습니다. 기존 링크·북마크, 그리고 구 URL에서 설치된 PWA는 동작하지 않으므로 신 URL로 재설치가 필요합니다.
>
> 로컬 폴더명(`야구시뮬레이션`)은 아직 그대로입니다. 필요 시 수동 rename하세요 (동작에는 영향 없음).

---

## 1. 프로젝트 개요

**Scoracle** (Score + Oracle) — KBO 경기 예측 엔진. 세이버메트릭스 + 베이지안 블렌딩 + 모멘텀 + calibration 보정.

| 항목 | 내용 |
|------|------|
| 리포지토리 | `github.com/ldh-mini/scoracle` |
| 배포 | GitHub Pages — https://ldh-mini.github.io/scoracle/ |
| 자동화 | GitHub Actions — 매일 09시/17시 KST |
| 기술 스택 | React 19 + Vite 8 + Tailwind 3 / Node.js 크롤러 / cheerio + Playwright |
| 데이터 출처 | KBO 공식 사이트, Statiz (2025 시즌 prior) |

상세 문서:
- [README.md](README.md) — 명령어 / 아키텍처 요약
- [프로젝트_개요서.md](프로젝트_개요서.md) — 비전, 비즈니스 모델, 엔진 상세, 로드맵, 백테스트 결과 (가장 상세)
- [Logs/Plans/](Logs/Plans/) — 버전별 구현 플랜 (왜 그렇게 만들었는지의 근거)
- [Logs/Analysis/](Logs/Analysis/) — calibration 이상 케이스 분석

---

## 2. 이양해야 할 자산 (코드 밖)

코드는 git으로 넘어가지만, 아래는 **별도 이양 절차가 필요**합니다.

| 자산 | 현재 소유 | 이양 방법 | 비고 |
|------|----------|----------|------|
| GitHub 리포지토리 | `ldh-mini` | Settings → Transfer ownership | Actions/Pages 설정은 이전 후 재확인 필요 |
| GitHub Pages | 리포 설정 | 이전 후 **재활성화 필요** | Source: GitHub Actions |
| Actions 스케줄 | `.github/workflows/` | 코드에 포함 | 이전 후 첫 실행 성공 확인 필수 |
| Claude API 키 | 로컬 `.env` | **이양하지 않음** — 인수자가 신규 발급 | 아래 참조 |
| 도메인 | 없음 | — | 커스텀 도메인 미사용 |

### 🔐 API 키 취급 (중요)

`.env`의 `VITE_CLAUDE_API_KEY`는 **절대 전달하지 마세요.** 인수자가 https://console.anthropic.com/settings/keys 에서 본인 키를 발급받습니다.

더 중요한 구조적 이슈: 이 키는 [kbo-simulation.jsx:1258](kbo-simulation.jsx#L1258)에서 `import.meta.env.VITE_CLAUDE_API_KEY`로 읽습니다.

```js
const CLAUDE_API_KEY = import.meta.env.VITE_CLAUDE_API_KEY || "";
```

Vite의 `VITE_` 접두사 변수는 **클라이언트 번들에 평문으로 포함**됩니다. 즉 키를 넣은 채 Pages에 빌드·배포하면 누구나 볼 수 있습니다.

- 현재 상태: Actions에 해당 시크릿이 등록되어 있지 않아 배포 번들에는 빈 값이 들어감 (유출 없음)
- **지켜야 할 규칙**: 이 키는 로컬 개발 전용. Actions 시크릿에 등록하지 말 것
- 근본 해결: LLM 호출을 서버사이드(프록시/Functions)로 옮긴 뒤에야 운영에서 사용 가능

---

## 3. 일일 운영 런북

### 자동 (GitHub Actions)

[.github/workflows/daily-predict.yml](.github/workflows/daily-predict.yml)

| 시각(KST) | 모드 | 동작 |
|-----------|------|------|
| 09:00 | verify | 어제 예측 vs KBO 실제 결과 매칭 → 적중 여부 기록 |
| 17:00 | predict | 크롤링 → 블렌딩 → MC 시뮬레이션 → 로그 append |

수동 실행: Actions 탭 → `Daily KBO Predict + Verify` → Run workflow (`predict` / `verify` / `both` 선택)

[.github/workflows/deploy-pages.yml](.github/workflows/deploy-pages.yml)는 데이터 파일이 커밋되면 자동으로 Pages를 재배포합니다.

### 수동 (로컬)

```bash
npm install
npx playwright install chromium   # 백필 기능용

npm run dev        # UI 개발 서버 → http://localhost:5173
npm run predict    # 오늘 경기 예측 (크롤링→블렌딩→시뮬→로그)
npm run verify     # 어제 결과 검증
npm run report     # 누적 적중률 리포트
```

### 매일/매주 확인할 것

1. **`prediction-log.json`의 마지막 항목 날짜가 어제/오늘인가** ← 현안 1의 재발 감지 지표
2. Actions 실행이 초록색인가 (초록이어도 1번을 반드시 같이 볼 것)
3. 주 1회 `npm run report`로 적중률 추이 확인

---

## 4. 장애 대응

이 프로젝트의 최대 리스크는 **외부 사이트(KBO/Statiz) DOM·API 변경으로 크롤러가 깨지는 것**입니다. 코드 버그보다 이쪽이 훨씬 자주 발생합니다.

| 증상 | 의심 파일 | 확인 방법 |
|------|----------|----------|
| 일정/선발투수가 안 갱신됨 | [crawl-schedule.mjs](crawl-schedule.mjs) | `node crawl-schedule.mjs` → 결과 날짜가 오늘인지 |
| 팀 전적/순위가 안 갱신됨 | [crawl-teamrank.mjs](crawl-teamrank.mjs) | `node crawl-teamrank.mjs` 후 `team-stats.json` 확인 |
| 최근 10경기 스탯 이상 | [crawl-recent.mjs](crawl-recent.mjs) | `recent-stats.json`의 `crawlDate` 확인 |
| 과거 스냅샷 백필 실패 | [backfill-snapshots-pw.mjs](backfill-snapshots-pw.mjs) | Playwright 브라우저 설치 여부 |
| 예측은 되는데 값이 이상 | [blend-stats.mjs](blend-stats.mjs) | 블렌딩 로그의 레이어별 출력 확인 |

**침묵 실패 주의**: 여러 크롤러가 실패 시 캐시로 fallback하거나 워크플로우에서 `continue-on-error: true`로 실행됩니다. Actions가 초록색인 것은 **정상 동작의 증거가 아닙니다.** 반드시 산출 데이터의 날짜를 확인하세요.

---

## 5. 데이터 자산 (재생성 불가)

| 파일/디렉토리 | 내용 | 중요도 |
|--------------|------|--------|
| `prediction-log.json` | 누적 예측·결과 로그 (190건) | **최상 — 소실 시 복구 불가** |
| `team-stats-snapshots/` | 일별 팀 전적 스냅샷 (119개+) | **높음 — 시점기반 백테스트의 근거** |
| `h1_2025.json` / `h2_2025.json` / `p1_2025.json` | 2025 시즌 prior (Statiz) | 높음 — `crawl-2025.mjs`로 재생성 가능하나 원본 사이트 의존 |
| `team-stats.json` / `recent-stats.json` | 일별 캐시 | 낮음 — 재생성 가능 |

`prediction-log.json`은 **시간이 지나야만 쌓이는 자산**입니다. 스크립트를 실험할 때 이 파일을 직접 덮어쓰지 마세요. 백테스트는 `predict-snapshot.mjs`로 별도 tag를 써서 돌립니다.

> ⚠️ 로컬 작업본과 원격이 어긋날 수 있습니다. 데이터 파일은 **원격(GitHub Actions가 매일 커밋하는 것)이 정본**입니다. 로컬에서 오래된 데이터 파일을 푸시하면 누적 로그가 유실됩니다. 작업 전 반드시 `git pull` 하세요.

---

## 6. 튜닝 파라미터의 근거

파라미터 값이 임의로 보일 수 있으나 **분석에 근거해 정해진 값**입니다. 되돌리기 전에 아래 배경을 확인하세요.

### v9.6 calibration fix (2026-04-10)

배경: v9.5 운영 중 **calibration 역전**이 발견되었습니다 — 신뢰도 ★★★(고확신) 적중률 **33%**, ★(저확신) **82%**. 확신할수록 틀리는 상태였습니다.

원인 진단 ([20260409_v96_overconfident_케이스분석.md](Logs/Plans/20260409_v96_overconfident_케이스분석.md), [20260410_v96_calibration_fix.md](Logs/Plans/20260410_v96_calibration_fix.md)):
- `env = dm × oF × h2 × mu × eF` — 중간 수준 우위들이 **곱셈으로 누적**되어 과신 발생
- 시즌 초 5~7경기 구간에서 2025 prior가 확률의 77~83%를 지배

| 파라미터 | 값 | 위치 | 이유 |
|----------|-----|------|------|
| `TEMPERATURE` | **0.7** | [sim-today.mjs:215](sim-today.mjs#L215) | MC 출력 확률을 50% 쪽으로 30% 압축 → 가짜 ★★★ 억제 |
| `priorGames` | **15** (기존 30) | [blend-stats.mjs:393](blend-stats.mjs#L393) | 시즌 초 prior→현재시즌 전환 속도 2배 가속 |
| `THRESH_3` (★★★) | **65** (기존 60) | [sim-today.mjs:220](sim-today.mjs#L220) | 경계 상향 — 진짜 확신할 때만 ★★★ 부여 |
| `REG_PA` / `REG_IP` | 120 / 40 | [blend-stats.mjs:17-18](blend-stats.mjs#L17) | 약 한 달 분량에서 prior:실측 = 50:50이 되도록 설정 |

**주의**: 이 세 값의 효과는 아직 실전 검증되지 않았습니다(현안 2 참조). v9.6 배포 후 표본을 쌓고 `node stats-report.mjs --calibration`으로 재분석해야 합니다.

### 검증 이력

| 버전 | 백테스트 | 실전/시점 | 비고 |
|------|---------|-----------|------|
| v9.0~v9.4 | 75.0% (2025 60경기) | 시점 68~84% | 3-Layer 블렌딩, 모멘텀 +8%p |
| v9.5 | — | 42경기 61.9% | **calibration 역전 발견** ★★★ 33% / ★ 82% |
| v9.6 | — | **미검증** | 배포되지 않아 표본 없음 |

---

## 7. 저장소 구조

```
scoracle/
├── kbo-simulation.jsx          메인 앱 (MC 엔진 + React UI, ~1800줄)
├── src/                        엔트리 / 글로벌 스타일
├── crawl-*.mjs                 크롤러 (stats / recent / teamrank / schedule)
├── blend-stats.mjs             3-Layer 베이지안 블렌딩
├── sim-today.mjs               당일 예측 + 로그 append
├── verify-yesterday.mjs        어제 결과 자동 검증
├── stats-report.mjs            누적 통계 / calibration / McNemar
├── predict-snapshot.mjs        시점기반 백테스트 러너
├── grid-search.mjs             가중치 그리드 서치
├── backfill-snapshots-pw.mjs   Playwright 과거 스냅샷 백필
├── prediction-log.json         ★ 누적 예측 로그
├── team-stats-snapshots/       ★ 일별 스냅샷
├── HANDOVER.md                 이 문서
├── README.md / 프로젝트_개요서.md
├── Logs/Plans/, Logs/Analysis/ 설계 근거 기록
└── archive/                    현행 미사용 (이력 보존)
    ├── legacy-python/          statiz_crawler.py 등 초기 Python 크롤러
    ├── legacy-scripts/         sim-yesterday.mjs 등 대체된 스크립트
    ├── unrelated/              UE5 유니폼 데모 등 타 주제
    ├── docs-v8/                구버전 docx 개요서
    └── data-snapshots/         로컬 데이터 백업 (gitignore)
```

`archive/` 내 파일은 **현행 파이프라인에서 참조되지 않습니다.** 삭제해도 동작에 영향이 없으나 이력 참고용으로 보존했습니다.

---

## 8. 인수인계 체크리스트

### 1단계 — 인계자 준비

- [x] 미커밋 작업 정리 및 원격 기준 정합화
- [x] 사용하지 않는 파일 `archive/`로 분리
- [x] 인수인계 문서 작성 (이 문서)
- [x] 리포지토리 rename (`baseball-sim` → `scoracle`) + Pages 동작 확인
- [x] v9.6 + 리브랜딩 코드 원격 푸시
- [ ] `v9.6` 태그 생성

### 2단계 — 병행 운영 (1~2주 권장)

- [ ] 인수자를 리포지토리 Collaborator로 추가
- [ ] 인수자 로컬 환경 구축 (`npm install` + Playwright + 본인 API 키)
- [ ] 인수자가 `npm run predict` / `npm run verify` **직접 실행 성공**
- [ ] **현안 1(일정 크롤러) 수정을 인수자가 주도** — 크롤러 장애 대응을 한 번 겪는 것이 인수의 핵심
- [ ] 아키텍처 워크스루 1회 (엔진 레이어 구조 + 로그 스키마)

### 3단계 — 완전 이양

- [ ] 리포지토리 소유권 Transfer
- [ ] GitHub Pages 재활성화 및 URL 확인
- [ ] Actions 첫 자동 실행 성공 확인 (+ `prediction-log.json` 날짜 갱신 확인)
- [ ] 인계자 권한 회수, 로컬 `.env` 폐기
- [ ] 데이터 출처(KBO/Statiz) 이용 조건 재확인 — 외부 공개 시 필요

---

## 9. 미해결 과제 / 다음 작업 후보

[Logs/Plans/20260410_다음작업.md](Logs/Plans/20260410_다음작업.md) 기준, 현안 반영해 재정렬:

| 우선순위 | 작업 | 비고 |
|---------|------|------|
| **1** | 일정 크롤러 복구 + 침묵 실패 제거 | 현안 1 — 이것 없이는 나머지 무의미 |
| **2** | v9.6 calibration 재검증 (배포는 완료) | 현안 2 — 1번 해결 후 표본 50경기 누적 필요 |
| 3 | Discord webhook 일일 알림 | 원 플랜 1순위, ROI 높음 |
| 4 | LLM 해설 서버사이드화 | API 키 구조 문제 동시 해결 |
| 5 | 모멘텀 가중치 재검증 | 표본 200경기+ 필요 |
| — | MLB / 타 종목 확장, 구독 시스템 | 장기 로드맵 ([프로젝트_개요서.md](프로젝트_개요서.md) 8장) |

---

## 10. 라이선스 / 법적 확인 사항

Private 프로젝트입니다. 외부 공개·상용화 전 아래를 확인하세요.

- KBO 공식 사이트 / Statiz 데이터의 크롤링 및 재배포 허용 범위
- 크롤링 빈도(현재 1일 2회)가 대상 사이트 이용약관에 저촉되지 않는지
- 예측 결과를 서비스로 제공할 때의 사행성 관련 규제 검토

# PC OFF

보안 포탈에 통합된 업무용 PC OFF 도구입니다. 각 PC의 에이전트가 켜짐, 화면 잠금,
잠금 해제, 종료, 하트비트 이벤트를 보고하고, 보안 포탈 안에서 대시보드와 일별 로그를 확인합니다.

## 보안 포탈 연동

- 포탈 메뉴: `도구 > PC OFF`
- 포탈 내부 화면: `https://example.com/pc-monitoring`
- 공개 에이전트 설치 페이지: `https://pcoff.sanghak.kr`
- 에이전트 보고 API: `https://pcoff.sanghak.kr/api/report`
- 내부 모니터링 서버 기본 포트: `4500`
- 데이터베이스: 보안 포탈 PostgreSQL DB

보안 포탈의 Express 서버가 `/agent`와 `/pc-monitoring`을 프록시합니다. 사용자는 로그인하지 않아도
`/agent` 설치 페이지에 접근할 수 있고, 대시보드는 포탈 로그인 및 서비스 권한을 거쳐 접근합니다.

## 권한

`환경 설정 > 사용자 관리 > 서비스 권한`의 `PC OFF` 항목으로 메뉴 노출을 제어합니다.
기본값은 superadmin만 활성화이며, 일반 사용자는 권한을 부여받기 전까지 비활성화됩니다.

## 데이터베이스

SQLite를 사용하지 않습니다. 보안 포탈이 연결한 PostgreSQL DB에 아래 테이블을 사용합니다.

- `pmon_machines`
- `pmon_events`
- `pmon_ping_targets`

운영 배포 시 `server/schema.js`의 런타임 스키마 보정이 필요한 테이블과 인덱스를 생성합니다.
로컬에서 운영 DB에 직접 접속해 수동 반영하지 않습니다.

## 서버 실행

보안 포탈과 같은 DB 환경변수를 사용합니다.

```bash
cd sub11_pcmon
npm install
PMON_PUBLIC_BASE_URL="https://pcoff.sanghak.kr" npm start
```

주요 환경변수:

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `PORT` | `4500` | 내부 모니터링 서버 포트 |
| `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` | 없음 | 보안 포탈 PostgreSQL 연결 정보 |
| `DATABASE_URL` | 없음 | PostgreSQL 단일 연결 문자열 |
| `AGENT_TOKEN` | `change-me-pmon-token` | 에이전트 공유 토큰 |
| `PMON_PUBLIC_BASE_URL` | `https://pcoff.sanghak.kr` | 에이전트가 사용할 공개 설치/API 기준 주소 |
| `HEARTBEAT_SEC` | `30` | 하트비트 간격 |
| `PING_SEC` | `30` | 핑 감시 대상 확인 간격 |
| `AWAY_LONG_MIN` | `60` | 오래 비움 기준 |
| `AWAY_FREQUENT_COUNT` | `10` | 자주 비움 기준 |
| `AWAY_MIN_COUNT_SEC` | `60` | 짧은 잠금 제외 기준 |

## Firebase / Google OAuth

브라우저는 Firebase Web SDK로 Google 로그인을 초기화합니다. 서버 API 보호는 Firebase Admin
서비스 계정이 있을 때만 활성화됩니다.

1. Firebase Console에서 Google 로그인 제공자를 활성화합니다.
2. 서버에 `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` 또는
   `FIREBASE_SERVICE_ACCOUNT_JSON`을 설정합니다.
3. 접근 제한이 필요하면 `PMON_AUTH_REQUIRED=true`로 바꾸고 `PMON_ALLOWED_EMAILS` 또는
   `PMON_ALLOWED_DOMAINS`를 설정합니다.

`POST /api/report`는 에이전트 호환성을 위해 계속 `AGENT_TOKEN`으로 보호됩니다. Firebase Admin이
설정되면 에이전트 이벤트와 머신 스냅샷을 Firestore의 `pmon_events`, `pmon_machines` 컬렉션에도
미러링합니다. 기존 운영 데이터베이스는 PostgreSQL입니다.

수동 스냅샷 동기화:

```bash
curl -X POST https://pcoff.sanghak.kr/api/firebase/sync \
  -H "Authorization: Bearer <firebase-id-token>"
```

## Cloudflare R2 / DNS

CSV 다운로드(`logs`, `report`, `events`)는 R2 환경변수가 있으면 같은 파일을 R2에도 백업합니다.

| 변수 | 설명 |
|------|------|
| `CLOUDFLARE_ACCOUNT_ID` | R2 계정 ID |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | R2 S3 호환 API 키 |
| `R2_BUCKET` | CSV 백업 버킷 |
| `R2_PREFIX` | R2 객체 prefix, 기본 `pc-off` |

Cloudflare DNS API는 `PMON_AUTH_REQUIRED=true` 환경에서 사용하는 것을 권장합니다.

| 메서드 | 경로 | 설명 |
|--------|------|------|
| `GET` | `/api/cloudflare/dns` | DNS 레코드 목록 |
| `POST` | `/api/cloudflare/dns` | `A`, `AAAA`, `CNAME`, `TXT` 레코드 upsert |

DNS에는 `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID`가 필요합니다. 토큰 권한은 해당 zone의
DNS edit 권한으로 제한하세요.

## 에이전트 설치

설치 페이지에서 OS별 명령을 복사해 실행합니다. 화면의 `에이전트 설치 주소` 값을 바꾸면
macOS/Windows 설치 명령이 해당 주소 기준으로 다시 생성됩니다. 기본값은 서버 환경변수
`PMON_PUBLIC_BASE_URL`입니다.

macOS 설치는 `~/Applications/PC-OFF Agent.app` 앱 번들을 만들고 LaunchAgent로 등록합니다.

Windows 설치는 현재 사용자 로그온 시 자동 시작되는 작업 스케줄러 작업 `pmon-agent`를 등록합니다.

## GitHub Actions 배포

`main` 브랜치에 push하면 `.github/workflows/deploy.yml`이 Docker 이미지를 GHCR에 올리고,
배포 서버에서 `docker compose`로 `https://pcoff.sanghak.kr` 서비스를 갱신합니다.

GitHub Secrets:

| Secret | 설명 |
|--------|------|
| `DEPLOY_HOST` | SSH 접속 대상 서버 |
| `DEPLOY_USER` | SSH 사용자 |
| `DEPLOY_SSH_KEY` | SSH private key |
| `DEPLOY_PORT` | SSH 포트, 없으면 `22` |
| `DEPLOY_DIR` | 서버 배포 디렉터리, 없으면 `/opt/pcoff` |
| `DEPLOY_ENV_B64` | 전체 운영 `.env`를 base64 인코딩한 값. 있으면 아래 개별 환경 Secret보다 우선 |
| `DATABASE_URL` | 운영 PostgreSQL 연결 문자열 |
| `AGENT_TOKEN` | 에이전트 공유 토큰 |
| `FIREBASE_*`, `R2_*` | 사용하는 경우에만 설정 |

서버에는 Docker와 Docker Compose plugin이 설치되어 있어야 합니다. 도메인
`pcoff.sanghak.kr`은 서버의 reverse proxy 또는 Cloudflare Tunnel에서 컨테이너의
`127.0.0.1:4500`으로 연결합니다.

## 수집 정보

- hostname
- 사용자명
- OS
- LAN IP
- MAC 주소
- 서버가 본 접속 IP
- 켜짐, 잠금, 잠금 해제, 종료, 하트비트 시각

## API 요약

| 메서드 | 경로 | 설명 |
|--------|------|------|
| `POST` | `/api/report` | 에이전트 이벤트 보고 |
| `GET` | `/api/machines` | 전체 PC 목록과 현재 상태 |
| `GET` | `/api/machines/:id/events?date=YYYY-MM-DD` | 특정 PC의 하루 타임라인 |
| `GET` | `/api/logs?date=YYYY-MM-DD` | 일별 전체 이벤트 로그 |
| `GET` | `/api/logs.csv?date=YYYY-MM-DD` | 일별 로그 CSV |
| `GET` | `/api/away?date=YYYY-MM-DD` | 자리 비움 분석 |
| `GET` | `/api/targets` | 핑 감시 대상 목록 |
| `POST` | `/api/targets` | 핑 감시 대상 추가 |
| `DELETE` | `/api/targets/:id` | 핑 감시 대상 해제 |
| `GET` | `/api/health` | 헬스체크 |

## 운영 주의

근로자 PC 모니터링은 사전 고지, 목적 제한, 내부 승인 절차가 필요할 수 있습니다. 이 도구의
자리 비움 분석은 법 위반 판정이 아니라 사내 참고 통계입니다.

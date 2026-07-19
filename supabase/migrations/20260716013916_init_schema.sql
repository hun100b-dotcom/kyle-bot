-- =============================================================================
-- 20260716013916_init_schema.sql
-- Capri 데이터 모델 (설계서 2장) — 최초 스키마
-- -----------------------------------------------------------------------------
-- [이 파일이 하는 일]
--   봇이 매매하면서 남기는 모든 데이터를 담을 "표(테이블) 5개"를 만듭니다.
--   Supabase는 내부적으로 PostgreSQL(포스트그레스)이라는 데이터베이스를 씁니다.
--   이 SQL 파일 하나가 그 데이터베이스의 뼈대(스키마)를 정의합니다.
--
-- [테이블 5개 한눈에 보기]
--   1) trade_sessions      매매 세션  — "기법 1회 실행" 단위 (한 판의 설정값)
--   2) orders              개별 주문  — 세션 안에서 실제로 낸 주문들 (삼분할=3개)
--   3) risk_state          일일 리스크 — 하루 단위 손익/연속손절/정지 상태
--   4) orderbook_snapshots 호가벽 기록 — 매수벽 두께를 시간순으로 저장(시계열)
--   5) trade_log           매매일지   — 청산까지 끝난 한 판의 결과(승률·MDD 산출용)
--
-- [테이블 사이의 관계]
--   trade_sessions 1 : N orders     (세션 하나에 주문 여러 개)
--   trade_sessions 1 : N trade_log  (세션 하나에 매매일지 여러 개)
--   → 자세한 이유는 각 테이블 위 주석에서 설명합니다.
--
-- [실제 적용은 아직 안 함]
--   S2 단계에서는 파일만 만들고 문법 검증까지만 합니다.
--   원격 Supabase 프로젝트/키가 정해지면 그때 `supabase db push`로 올립니다.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 0) 사전 준비: 확장(extension)과 공용 함수
-- -----------------------------------------------------------------------------

-- gen_random_uuid() 로 무작위 UUID(고유 식별자)를 만들기 위한 확장.
-- [왜 UUID인가?] 1,2,3... 순번 대신 절대 겹치지 않는 긴 무작위 ID를 쓰면,
--   여러 곳에서 동시에 행을 만들어도 충돌이 없고 ID로 개수를 추측당하지 않습니다.
create extension if not exists pgcrypto;

-- updated_at(마지막 수정 시각)을 행이 바뀔 때마다 자동으로 지금 시각으로 채워주는 함수.
-- [왜 함수로 빼나?] 5개 테이블에서 똑같이 재사용하려고 한 번만 정의합니다.
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();  -- 저장 직전에 updated_at 을 현재 시각으로 덮어씀
  return new;
end;
$$;


-- -----------------------------------------------------------------------------
-- 1) trade_sessions — 매매 세션 (기법 1회 실행 단위)
-- -----------------------------------------------------------------------------
-- [무엇인가?] "이 종목을, 이 기법으로, 이 설정값(익절/손절/시드)으로 한 판 돌린다"
--   는 계획 한 건을 나타냅니다. 실제 주문(orders)은 이 세션에 매달립니다.
-- [상태 흐름] draft(초안) → armed(장전) → active(체결진행) → closed(종료)
--   중간에 취소하면 cancelled. 이렇게 상태를 두면 "지금 어느 단계인지" 한눈에 압니다.
create table trade_sessions (
  id           uuid primary key default gen_random_uuid(),

  -- 상태: 아래 5개 값만 허용(check 제약). 오타나 엉뚱한 값이 들어가는 걸 DB가 막아줍니다.
  status       text not null default 'draft'
               check (status in ('draft', 'armed', 'active', 'closed', 'cancelled')),

  -- 대상 종목 심볼(예: 'AAPL'). 설계서 나열에는 없지만 "무슨 종목인지"는 필수라 추가.
  symbol       text not null,

  -- 어떤 기법인지: 삼분할 / 호가창(매수벽) / 캔들. 시드 비율이 기법마다 달라 구분이 필요.
  strategy     text not null
               check (strategy in ('split3', 'orderbook', 'candle')),

  -- 계산에 쓰는 기준값들(설계서 M1 입력). 가격은 소수 4자리까지($1 미만 0.0001 틱 대응).
  base_price   numeric(12, 4),   -- 전봉 종가
  ema200       numeric(12, 4),   -- 200일 지수이동평균(추세 기준선)
  wall_price   numeric(12, 4),   -- 매수벽 가격(호가창 기법에서 사용)
  tick_size    numeric(12, 4),   -- 이 종목의 최소 호가 단위(틱)

  -- 익절/손절 퍼센트. 설계서 기본값: 익절 2%, 손절 10%.
  tp_pct       numeric(5, 2) not null default 2,
  sl_pct       numeric(5, 2) not null default 10,

  -- 시드 비율(%): 전체 시드 중 이 세션에 얼마를 넣는지. 삼분할·캔들 50, 호가창 90.
  seed_pct     numeric(5, 2),

  -- 드라이런(모의 실행) 여부. 기본 true = 실제 주문 안 나감(안전장치 우선 원칙).
  --   실거래로 바꿀 때만 명시적으로 false 로 둡니다.
  dry_run      boolean not null default true,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table  trade_sessions            is '매매 세션: 기법 1회 실행 단위(한 판의 설정값과 상태)';
comment on column trade_sessions.status     is '상태: draft(초안)|armed(장전)|active(진행)|closed(종료)|cancelled(취소)';
comment on column trade_sessions.symbol     is '대상 종목 심볼(예: AAPL)';
comment on column trade_sessions.strategy   is '기법: split3(삼분할)|orderbook(호가창/매수벽)|candle(캔들)';
comment on column trade_sessions.base_price is '전봉 종가(달러)';
comment on column trade_sessions.ema200     is '200일 지수이동평균(추세 기준선, 달러)';
comment on column trade_sessions.wall_price is '매수벽 가격(호가창 기법용, 달러)';
comment on column trade_sessions.tick_size  is '이 종목의 최소 호가 단위(틱)';
comment on column trade_sessions.tp_pct     is '익절 퍼센트(기본 2)';
comment on column trade_sessions.sl_pct     is '손절 퍼센트(기본 10)';
comment on column trade_sessions.seed_pct   is '시드 투입 비율 %(삼분할·캔들 50 / 호가창 90)';
comment on column trade_sessions.dry_run    is '드라이런(모의) 여부. 기본 true=실주문 안 나감';


-- -----------------------------------------------------------------------------
-- 2) orders — 개별 주문
-- -----------------------------------------------------------------------------
-- [왜 세션과 따로 두나?]
--   삼분할 기법은 한 세션 안에서 1분할·2분할·3분할 "각각 독립된 한 판"처럼 굴러갑니다.
--   각 레벨마다 진입·익절·손절 주문이 따로 나가고, 체결/취소도 제각각입니다.
--   그래서 주문을 세션에 다 욱여넣지 않고 별도 테이블로 분리해, 한 세션에 여러 주문(N개)을
--   매다는 1:N 구조로 만듭니다. (세션 1 : 주문 N)
--
-- [client_order_id 가 왜 unique(중복 불가)인가? = 멱등키]
--   네트워크가 끊겨 "주문 요청이 갔는지 안 갔는지" 모를 때 봇이 재시도를 합니다.
--   이때 같은 주문이 두 번 들어가면 돈이 두 배로 나갈 수 있습니다.
--   그래서 봇이 주문마다 고유한 client_order_id 를 미리 붙이고, DB가 이 값의 중복을
--   막아줍니다(unique). 같은 키로 또 넣으면 실패 → "이미 처리된 주문"임을 알 수 있습니다.
--   이렇게 "몇 번을 눌러도 결과가 한 번과 같은" 성질을 멱등성(idempotency)이라 합니다.
create table orders (
  id             uuid primary key default gen_random_uuid(),

  -- 어느 세션의 주문인지. 세션이 삭제되면 그 주문들도 같이 삭제(cascade).
  --   주문은 세션에 종속된 실행 내역이라, 세션이 사라지면 남겨둘 의미가 없습니다.
  session_id     uuid not null references trade_sessions(id) on delete cascade,

  -- 삼분할 레벨(1|2|3). 호가창·캔들 기법은 분할이 없어 NULL 허용.
  level          smallint check (level in (1, 2, 3)),

  -- 이 주문의 역할: 진입 / 익절 / 손절.
  role           text not null check (role in ('entry', 'take_profit', 'stop_loss')),

  -- 매수/매도 방향.
  side           text not null check (side in ('BUY', 'SELL')),

  -- 주문 유형: 지정가(LIMIT) / 시장가(MARKET). 기본은 지정가(가격을 못 박아 안전).
  order_type     text not null default 'LIMIT' check (order_type in ('LIMIT', 'MARKET')),

  -- 주문 가격(달러). 소수 4자리까지. 시장가 주문이면 NULL 일 수 있음.
  price          numeric(12, 4),

  -- 멱등키(중복 주문 방지용 고유 문자열). 봇이 생성. 위 설명 참고.
  client_order_id text not null unique,

  -- 토스가 접수 후 부여하는 주문번호. 접수 전에는 아직 없으므로 NULL.
  toss_order_id  text,

  -- 주문 상태 흐름.
  status         text not null default 'pending'
                 check (status in ('pending', 'submitted', 'filled', 'partial', 'cancelled', 'failed')),

  -- 체결 결과(체결되면 채워짐). 달러 주문이라 수량이 소수일 수 있어 numeric.
  filled_qty     numeric(18, 6),
  filled_price   numeric(12, 4),
  filled_at      timestamptz,

  -- 실패 시 에러 코드(토스가 준 코드 등). 원인 추적용.
  error_code     text,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

comment on table  orders                 is '개별 주문: 세션 안에서 실제로 낸 주문(삼분할이면 레벨별로 여러 건)';
comment on column orders.session_id      is '소속 세션 FK(세션 삭제 시 함께 삭제)';
comment on column orders.level           is '삼분할 레벨 1|2|3 (호가창·캔들은 NULL)';
comment on column orders.role            is '역할: entry(진입)|take_profit(익절)|stop_loss(손절)';
comment on column orders.side            is '방향: BUY(매수)|SELL(매도)';
comment on column orders.order_type      is '유형: LIMIT(지정가)|MARKET(시장가), 기본 LIMIT';
comment on column orders.price           is '주문 가격(달러, 소수 4자리). 시장가면 NULL 가능';
comment on column orders.client_order_id is '멱등키(중복 주문 방지용 고유 문자열). 봇이 생성, unique';
comment on column orders.toss_order_id   is '토스가 접수 후 부여하는 주문번호(접수 전 NULL)';
comment on column orders.status          is '상태: pending|submitted|filled|partial|cancelled|failed';
comment on column orders.filled_qty      is '체결 수량(달러 주문이라 소수 가능)';
comment on column orders.filled_price    is '체결 가격(달러)';
comment on column orders.filled_at       is '체결 시각';
comment on column orders.error_code      is '실패 시 에러 코드(원인 추적용)';


-- -----------------------------------------------------------------------------
-- 3) risk_state — 일일 리스크 상태
-- -----------------------------------------------------------------------------
-- [무엇인가?] "오늘 하루" 단위로 손익과 위험 상태를 한 줄로 관리합니다.
--   날짜(trade_date)를 기본키로 써서 하루에 한 행만 존재합니다(하루=한 줄).
-- [안전장치의 핵심] 하루 손실이 크거나 손절이 연속되면 halted(거래정지) 를 켜서
--   봇이 더 이상 새 주문을 못 내게 막습니다. "안전장치 우선" 원칙의 저장소입니다.
create table risk_state (
  -- 거래일(KST 기준 날짜). 하루당 한 행이라 이 날짜 자체가 기본키.
  trade_date          date primary key,

  -- 그날 실현 손익률(%). 확정된(청산 끝난) 손익만 누적.
  realized_pnl_pct    numeric(8, 4) not null default 0,

  -- 그날 낸 주문 수(과도한 주문 감시용).
  order_count         integer not null default 0,

  -- 연속 손절 횟수(연달아 손절이 나면 컷하기 위한 카운터).
  consecutive_losses  integer not null default 0,

  -- 거래 정지 여부. true면 오늘은 신규 진입 금지.
  halted              boolean not null default false,

  -- 정지 사유(예: '일일 손실 한도 초과', '연속 손절 3회'). 왜 멈췄는지 기록.
  halt_reason         text,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on table  risk_state                    is '일일 리스크: 하루 단위 손익/연속손절/거래정지 상태(안전장치 저장소)';
comment on column risk_state.trade_date         is '거래일(KST 날짜). 하루당 한 행 → 기본키';
comment on column risk_state.realized_pnl_pct   is '그날 실현 손익률 %(청산 확정분 누적)';
comment on column risk_state.order_count        is '그날 낸 주문 수';
comment on column risk_state.consecutive_losses is '연속 손절 횟수(연속 손절 컷 판정용)';
comment on column risk_state.halted             is '거래 정지 여부(true=신규 진입 금지)';
comment on column risk_state.halt_reason        is '정지 사유(왜 멈췄는지)';

-- TODO(S2 이후): 일일 손실 한도 %와 연속 손절 컷 횟수의 구체 수치는 아직 미확정.
--   확정되면 애플리케이션 로직(또는 트리거)에서 halted 자동 전환을 구현.


-- -----------------------------------------------------------------------------
-- 4) orderbook_snapshots — 호가벽 시계열
-- -----------------------------------------------------------------------------
-- [무엇인가?] 특정 종목의 특정 가격에 "매수벽(대기 매수 물량)이 얼마나 두꺼운지"를
--   시간순으로 계속 찍어 저장합니다. 호가창 기법이 "이 벽이 진짜인지, 유지되는지"를
--   판단하는 근거 데이터입니다. 시계열이라 행이 아주 많이 쌓입니다.
-- [id 를 UUID 대신 정수(identity)로 둔 이유]
--   대량으로 순차 삽입되는 로그성 데이터는 자동 증가 정수가 저장·인덱스 효율이 좋습니다.
create table orderbook_snapshots (
  id          bigint generated always as identity primary key,
  symbol      text not null,               -- 종목 심볼
  price       numeric(12, 4) not null,     -- 벽이 있는 가격대
  quantity    numeric(18, 6) not null,     -- 그 가격의 매수 대기 물량(벽 두께)
  captured_at timestamptz not null default now()  -- 이 스냅샷을 찍은 시각
);

-- 조회 패턴: "특정 종목의 특정 가격대를 최신순으로" 자주 봅니다.
--   그래서 (symbol, price, captured_at 내림차순) 복합 인덱스를 만들어 빠르게 찾습니다.
--   [인덱스란?] 책 뒤 '찾아보기'처럼, 전체를 훑지 않고 원하는 행을 바로 찾게 해주는 색인.
create index idx_orderbook_symbol_price_time
  on orderbook_snapshots (symbol, price, captured_at desc);

comment on table  orderbook_snapshots             is '호가벽 시계열: 종목·가격별 매수벽 두께를 시간순으로 저장';
comment on column orderbook_snapshots.symbol      is '종목 심볼';
comment on column orderbook_snapshots.price       is '벽이 있는 가격대(달러)';
comment on column orderbook_snapshots.quantity    is '그 가격의 매수 대기 물량(벽 두께)';
comment on column orderbook_snapshots.captured_at is '스냅샷을 찍은 시각';


-- -----------------------------------------------------------------------------
-- 5) trade_log — 매매일지
-- -----------------------------------------------------------------------------
-- [무엇인가?] 진입부터 청산까지 "끝난 한 판"의 결과를 한 줄로 남깁니다.
--   여기 쌓인 데이터로 승률, MDD(최대낙폭) 같은 성과 지표를 자동 산출합니다.
-- [세션과의 관계] 한 세션에서 여러 번(삼분할 레벨별로) 진입·청산이 일어날 수 있어
--   세션 1 : 매매일지 N 구조입니다.
-- [세션 삭제 시 on delete set null 인 이유]
--   매매일지는 "실적 기록"이라 세션이 지워져도 남아야 합니다. 그래서 세션이 삭제되면
--   session_id 만 NULL 로 비우고 일지 행 자체는 보존합니다(주문 orders 와 다른 정책).
create table trade_log (
  id           uuid primary key default gen_random_uuid(),

  -- 소속 세션(삭제되면 이 값만 NULL, 일지는 보존).
  session_id   uuid references trade_sessions(id) on delete set null,

  symbol       text not null,             -- 종목 심볼

  entry_price  numeric(12, 4) not null,   -- 진입가
  exit_price   numeric(12, 4),            -- 청산가(아직 청산 전이면 NULL)

  pnl_pct      numeric(8, 4),             -- 손익률 %(승률 계산의 재료)
  pnl_usd      numeric(14, 4),            -- 손익 금액(달러)

  -- 청산 사유: 익절 / 손절 / 장마감청산 / 매수벽붕괴 / 수동.
  exit_reason  text check (exit_reason in ('take_profit', 'stop_loss', 'eod_close', 'wall_break', 'manual')),

  entered_at   timestamptz not null,      -- 진입 시각
  exited_at    timestamptz,               -- 청산 시각(청산 전이면 NULL)

  created_at   timestamptz not null default now()
);

comment on table  trade_log             is '매매일지: 진입~청산이 끝난 한 판의 결과(승률·MDD 자동 산출용)';
comment on column trade_log.session_id  is '소속 세션 FK(세션 삭제 시 NULL로 비우고 일지는 보존)';
comment on column trade_log.symbol      is '종목 심볼';
comment on column trade_log.entry_price is '진입가(달러)';
comment on column trade_log.exit_price  is '청산가(달러, 청산 전 NULL)';
comment on column trade_log.pnl_pct     is '손익률 %(승률 계산 재료)';
comment on column trade_log.pnl_usd     is '손익 금액(달러)';
comment on column trade_log.exit_reason is '청산 사유: take_profit|stop_loss|eod_close|wall_break|manual';
comment on column trade_log.entered_at  is '진입 시각';
comment on column trade_log.exited_at   is '청산 시각(청산 전 NULL)';

-- 조회 편의 인덱스: 특정 종목의 일지를 진입 시각순으로 자주 봅니다.
create index idx_trade_log_symbol_time on trade_log (symbol, entered_at desc);
-- 세션별 일지 묶어보기용.
create index idx_trade_log_session on trade_log (session_id);


-- -----------------------------------------------------------------------------
-- 6) updated_at 자동 갱신 트리거
-- -----------------------------------------------------------------------------
-- [트리거란?] 특정 사건(여기서는 UPDATE)이 일어날 때 자동으로 실행되는 규칙입니다.
--   행을 수정할 때마다 위에서 만든 set_updated_at() 이 돌아 updated_at 을 지금 시각으로
--   바꿔줍니다. 사람이 매번 손대지 않아도 "마지막 수정 시각"이 항상 정확해집니다.
--   (risk_state 처럼 자주 갱신되는 테이블에 특히 유용)
create trigger trg_trade_sessions_updated_at
  before update on trade_sessions
  for each row execute function set_updated_at();

create trigger trg_orders_updated_at
  before update on orders
  for each row execute function set_updated_at();

create trigger trg_risk_state_updated_at
  before update on risk_state
  for each row execute function set_updated_at();


-- -----------------------------------------------------------------------------
-- 7) RLS(행 수준 보안) 활성화
-- -----------------------------------------------------------------------------
-- [RLS란?] Row Level Security. "어떤 사용자가 어떤 행을 읽고/쓸 수 있는가"를
--   행 단위로 통제하는 Supabase의 기본 보안 장치입니다.
-- [지금 정책(policy)을 안 만드는 이유]
--   봇 서버는 service_role 키로 접속하는데, service_role 은 RLS를 우회합니다(정상).
--   반면 익명(anon) 접근은 정책이 없으면 전부 차단됩니다 → 지금은 그게 안전합니다.
--   대시보드 로그인 사용자에게 열어줄 구체적 정책은 인증을 붙이는 다음 단계에서 추가합니다.
alter table trade_sessions      enable row level security;
alter table orders              enable row level security;
alter table risk_state          enable row level security;
alter table orderbook_snapshots enable row level security;
alter table trade_log           enable row level security;

-- TODO(S2 이후): 대시보드용 select 정책 등 세부 RLS policy 정의.

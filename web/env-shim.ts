// =============================================================================
// web/env-shim.ts — 브라우저에서 'process.env' 를 진짜처럼 쓰게 해 주는 껍데기
// -----------------------------------------------------------------------------
// [왜 필요한가 — 실제로 당한 버그]
//   데스크톱 엔진은 설정(토스 키·계좌·토글)을 process.env 에 담아 씁니다.
//   그런데 웹으로 빌드하면 번들러가 `process.env` 를 **빈 객체 {}** 로 바꿔치기해서,
//   저장한 값이 그대로 사라졌습니다(키를 저장해도 "키 없음"으로 나옴).
//   그래서 빌드 설정에서 `process.env` → `globalThis.__capriEnv` 로 바꾸고,
//   여기서 그 객체를 미리 만들어 둡니다. 이제 읽기·쓰기가 정상 동작합니다.
//
// [덤으로 안전장치 하나]
//   엔진은 실서버 모드가 되면 토스 주소를 공식 도메인으로 되돌립니다(데스크톱에선 맞는 동작).
//   하지만 브라우저에서는 토스를 직접 부를 수 없습니다(CORS). 그래서 이 객체는
//   **TOSS_BASE_URL 을 항상 우리 프록시로 고정**합니다. 엔진이 무엇을 하든 새지 않습니다.
// =============================================================================

const store: Record<string, string | undefined> = {};

/** 프록시 주소(=/api/toss 까지 포함). 설정 전이면 빈 문자열. */
let proxyBase = "";

export function setProxyBase(url: string): void {
  proxyBase = url;
  if (url) store.TOSS_BASE_URL = url;
}

const env = new Proxy(store, {
  get(target, prop: string) {
    // 토스 주소는 언제 물어도 프록시를 돌려준다(엔진이 바꿔 놨더라도).
    if (prop === "TOSS_BASE_URL" && proxyBase) return proxyBase;
    return target[prop];
  },
  set(target, prop: string, value: string) {
    // 엔진이 토스 공식 주소로 되돌리려 해도 무시하고 프록시를 유지한다.
    if (prop === "TOSS_BASE_URL" && proxyBase) {
      target[prop] = proxyBase;
      return true;
    }
    target[prop] = value;
    return true;
  },
});

const g = globalThis as unknown as { __capriEnv?: Record<string, string | undefined>; process?: unknown };
g.__capriEnv = env;
// 혹시 남아 있는 `process` 참조(치환되지 않은 것)를 위해 최소한의 모양도 만들어 둔다.
if (!g.process) g.process = { env, platform: "browser" };

export default env;

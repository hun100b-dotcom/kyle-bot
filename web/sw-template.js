// =============================================================================
// web/sw.js  —  서비스 워커 (아이폰 웹앱의 '설치 없이 자동 업데이트'를 담당)
// -----------------------------------------------------------------------------
// [서비스 워커가 뭔가요? — 비전공자용]
//   웹앱을 홈 화면에 추가하면, 브라우저가 이 작은 프로그램을 **폰 안에** 심어 둡니다.
//   이 프로그램이 (1) 화면 파일을 폰에 저장해 두었다가 인터넷이 느려도 바로 띄우고,
//   (2) 새 버전이 올라왔는지 확인해서 "업데이트" 배너를 띄웁니다.
//   → 앱스토어 심사도, 재설치도 필요 없습니다. 이게 사장님이 원하신 "앱 안에서 업데이트"입니다.
//
// [업데이트가 되는 원리 — skipWaiting 패턴]
//   1) 새 버전을 배포하면 이 파일의 CACHE 이름(아래 상수)이 바뀝니다.
//   2) 브라우저가 파일이 달라진 걸 알아채고 새 서비스 워커를 '대기(waiting)' 상태로 둡니다.
//   3) 화면이 그 사실을 감지해 "새 버전이 있습니다" 배너를 띄웁니다.
//   4) 사장님이 [업데이트]를 누르면 화면이 SKIP_WAITING 메시지를 보내고,
//      새 워커가 즉시 활성화된 뒤 화면이 새로고침되어 최신 버전이 됩니다.
//
//   ※ 이 파일 자체는 브라우저가 항상 서버에서 새로 확인합니다(캐시하지 않음).
//     그래서 "새 버전 있음"을 놓치지 않습니다.
// =============================================================================

// 배포할 때마다 값이 바뀝니다(빌드 스크립트가 __BUILD_ID__ 를 실제 값으로 치환).
const BUILD_ID = "__BUILD_ID__";
const CACHE = `capri-${BUILD_ID}`;

// 설치: 지금 버전의 화면 파일들을 폰에 저장해 둔다(오프라인에서도 열리게).
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // 최소한 첫 화면은 저장해 둔다. 나머지는 아래 fetch 에서 쓰는 대로 채운다.
      await cache.addAll(["./", "./index.html", "./manifest.webmanifest"]).catch(() => {});

      // ★★ [v0.9.4 중요] 새 버전을 '대기'시키지 않고 **곧바로** 켠다. ★★
      //   예전에는 화면의 [지금 업데이트] 배너를 눌러야만 교체됐다. 그런데 폰에서
      //   그 배너가 노치(상태바) 아래에 깔려 **눌리지 않는 사고**가 났고, 그러면
      //   새 버전을 영영 받을 수 없다(고칠 방법이 앱 안에 없음).
      //   이제는 앱을 **다시 열기만 하면** 새 버전이 스스로 켜지고 화면이 새로고침된다.
      await self.skipWaiting();
    })(),
  );
});

// 활성화: 옛 버전 캐시를 정리한다(폰 용량이 계속 늘지 않게).
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
      await self.clients.claim(); // 열려 있는 화면들을 새 워커가 곧바로 담당
    })(),
  );
});

// 화면에서 "지금 업데이트" 를 누르면 이 메시지가 온다 → 대기 중인 새 워커를 즉시 가동.
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

// 요청 처리 전략
//   · 화면 이동(navigate): 네트워크 먼저 → 실패하면 저장해 둔 화면(오프라인 대응)
//   · 그 외 정적 파일: 저장된 것 먼저(빠름) → 없으면 받아서 저장
//   · API 호출(/api/): 항상 네트워크(시세·환율은 최신이어야 하므로 캐시 금지)
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.pathname.includes("/api/")) return; // 시세·환율은 절대 캐시하지 않는다

  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          // [v0.60.7 긴급 수정 — 오너 실사용 보고 "폰에서는 껐다 켜도 업데이트가 안 됨"]
          //   fetch(req)만 쓰면 이 요청도 평범한 fetch라 브라우저의 보통 HTTP 캐시 규칙을
          //   그대로 따른다 — GitHub Pages가 index.html에도 Cache-Control: max-age=600(10분)을
          //   붙여 보내므로(실측 확인), "네트워크 먼저"라고 적힌 주석과 달리 실제로는 10분
          //   안이면 로컬에 저장된 옛 index.html을 그대로 돌려줄 수 있었다 — 새 서비스워커가
          //   활성화돼 reload()가 일어나도 정작 받아오는 화면이 옛 버전이면 소용없다.
          //   cache: "no-store"로 명시해 이 요청만큼은 항상 서버에서 진짜 새로 받는다.
          return await fetch(new Request(req, { cache: "no-store" }));
        } catch {
          const cache = await caches.open(CACHE);
          return (await cache.match("./index.html")) ?? Response.error();
        }
      })(),
    );
    return;
  }

  if (url.origin !== self.location.origin) return; // 외부 자원은 건드리지 않음

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    })(),
  );
});

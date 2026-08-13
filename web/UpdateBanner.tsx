// =============================================================================
// web/UpdateBanner.tsx — 웹 전용 "새 버전이 준비됐습니다" 배너
//   데스크톱은 설치파일을 받아 업데이트하지만, 웹앱은 서비스 워커가 처리합니다.
//   화면 맨 위에 떠서 누르면 즉시 최신 버전으로 바뀝니다(재설치 없음).
// =============================================================================

import { useUpdate } from "./useUpdate";

export default function UpdateBanner() {
  const update = useUpdate();
  if (!update.ready) return null;
  return (
    <div className="update-banner">
      <span>새 버전이 준비됐습니다.</span>
      <button onClick={update.apply}>지금 업데이트</button>
    </div>
  );
}

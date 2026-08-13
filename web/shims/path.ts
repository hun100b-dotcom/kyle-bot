// =============================================================================
// web/shims/path.ts — 브라우저에서 'node:path' 흉내내기
//   엔진은 join(폴더, 파일명) 으로 저장 경로를 만든다. 그 한 가지만 있으면 된다.
// =============================================================================

export function join(...parts: string[]): string {
  return parts
    .filter(Boolean)
    .join("/")
    .replace(/\/{2,}/g, "/"); // 슬래시 중복 정리
}

export function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

export default { join, dirname };

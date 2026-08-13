// =============================================================================
// web/shims/fs.ts — 브라우저에서 'node:fs' 흉내내기 (localStorage 저장소)
// -----------------------------------------------------------------------------
// [왜 이런 게 필요한가?]
//   데스크톱 엔진(electron/tool-engine.ts)은 매매일지·삼분할 기록·설정을
//   **파일로** 저장합니다. 브라우저에는 파일 시스템이 없죠.
//   그래서 "파일처럼 보이지만 실제로는 폰(브라우저) 저장소에 넣는" 껍데기를 만듭니다.
//
//   이렇게 하면 **엔진 코드를 한 줄도 고치지 않고** 그대로 웹에서 돌릴 수 있습니다.
//   (엔진 2,675줄을 다시 짜지 않아도 되고, PC와 웹의 동작이 어긋날 일도 없습니다)
//
// [저장 위치] localStorage 의 "capri-fs:<경로>" 키. 폰 안에만 남고 서버로 안 갑니다.
// =============================================================================

const PREFIX = "capri-fs:";

/** 엔진이 임시파일 → 진짜파일로 바꾸는(rename) 패턴을 쓰므로 그것도 흉내낸다 */
export function existsSync(path: string): boolean {
  return localStorage.getItem(PREFIX + path) !== null;
}

export function readFileSync(path: string, _enc?: string): string {
  const v = localStorage.getItem(PREFIX + path);
  if (v === null) {
    // node:fs 와 같은 모양의 오류를 던져야 엔진의 try/catch 가 똑같이 동작한다.
    const err = new Error(`ENOENT: no such file or directory, open '${path}'`) as Error & { code?: string };
    err.code = "ENOENT";
    throw err;
  }
  return v;
}

export function writeFileSync(path: string, data: string, _enc?: string): void {
  try {
    localStorage.setItem(PREFIX + path, data);
  } catch {
    // 저장 공간이 꽉 찬 경우: 앱이 멈추면 안 되므로 조용히 넘어간다(기록만 못 남을 뿐).
    console.warn("[capri] 저장 공간이 부족해 기록을 저장하지 못했습니다:", path);
  }
}

export function renameSync(from: string, to: string): void {
  const v = localStorage.getItem(PREFIX + from);
  if (v !== null) {
    localStorage.setItem(PREFIX + to, v);
    localStorage.removeItem(PREFIX + from);
  }
}

/** 폴더 개념이 없으므로 아무것도 하지 않는다(엔진은 만들어졌다고 가정하고 진행) */
export function mkdirSync(_path: string, _opts?: unknown): void {}

/** 파일 권한(600)도 브라우저엔 없다 — 무시 */
export function chmodSync(_path: string, _mode: number): void {}

export default { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync };

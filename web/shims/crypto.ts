// =============================================================================
// web/shims/crypto.ts — 'node:crypto' 의 webcrypto 를 브라우저 것으로 연결
//   lib/keysync.ts(키 암호화)는 webcrypto 를 쓰는데, 브라우저에는 같은 규격이
//   globalThis.crypto 로 이미 들어 있다. 이름만 이어 주면 코드 수정이 필요 없다.
//   → 마스터 비밀번호로 키를 풀고 잠그는 로직이 PC와 100% 동일하게 동작한다.
// =============================================================================

export const webcrypto = globalThis.crypto;
export default { webcrypto };

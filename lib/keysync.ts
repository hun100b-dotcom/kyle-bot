// =============================================================================
// lib/keysync.ts — 토스 키 기기 간 동기화용 "클라이언트 암호화" (v0.8.0)
// -----------------------------------------------------------------------------
// [무엇을 하나?]
//   맥·윈도우가 토스 키(Client ID/Secret/계좌)를 한 곳(Supabase)에 두고 공유하되,
//   ⚠️ **평문은 절대 클라우드에 올리지 않는다.** 오너만 아는 마스터 비밀번호(passphrase)로
//   기기에서 암호화(AES-GCM 256)한 뒤 "암호문만" 저장한다. 복호화도 기기에서 passphrase 로만.
//
// [왜 안전한가?]
//   - Supabase 에는 { 암호문, salt, iv } 만 저장된다. passphrase 는 어디에도 저장 안 한다.
//   - 행 식별자(sync_id)도 passphrase 에서 유도한다 → passphrase 를 모르면 "어느 행인지"조차 모른다.
//   - AES-GCM 은 인증 태그가 있어, 틀린 passphrase 로 복호화하면 조용히 깨지지 않고 '실패'로 드러난다.
//
// [표준 라이브러리만 사용] Web Crypto(node:crypto webcrypto) — 외부 의존성 없음, 검증 쉬움.
// =============================================================================

import { webcrypto } from "node:crypto";

const subtle = webcrypto.subtle;

// PBKDF2 반복 횟수: 높을수록 무차별 대입이 느려진다(보안↑). 20만회는 데스크톱에서 체감 지연 없이 안전.
const PBKDF2_ITERATIONS = 200_000;
const SALT_BYTES = 16; // PBKDF2 솔트 길이
const IV_BYTES = 12; //   AES-GCM 권장 IV 길이

/** 암호화해서 클라우드에 올릴 민감 데이터(평문 형태 — 이 객체는 절대 그대로 저장하지 않는다). */
export interface SecretPayload {
  clientId: string;
  clientSecret: string;
  account: string;
}

/** 클라우드에 저장되는 것(전부 암호문/공개 파라미터 — 평문 키 없음). */
export interface EncryptedRecord {
  syncId: string; //     passphrase 유도 식별자(행 자체가 비밀)
  ciphertext: string; // base64
  salt: string; //       base64 (PBKDF2)
  iv: string; //         base64 (AES-GCM)
}

// --- base64 유틸(Node Buffer 사용; 이 모듈은 main/테스트=Node 환경에서만 쓴다) ---
function toB64(buf: ArrayBuffer | Uint8Array): string {
  return Buffer.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf)).toString("base64");
}
function fromB64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64"));
}
const enc = new TextEncoder();
const dec = new TextDecoder();

/** passphrase + salt → AES-GCM 256bit 키 (PBKDF2-SHA256). */
async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const baseKey = await subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * deriveSyncId — passphrase 에서 행 식별자를 만든다(양쪽 기기가 같은 값을 계산하도록 고정 규칙).
 *   무작위 솔트를 쓰지 않는 이유: 다른 기기에서도 passphrase 만으로 같은 id 를 재현해야 하기 때문.
 *   대신 고정 컨텍스트 문자열을 섞어, 다른 용도의 해시와 충돌하지 않게 한다.
 */
export async function deriveSyncId(passphrase: string): Promise<string> {
  const h = await subtle.digest("SHA-256", enc.encode(`capri-sync-id-v1|${passphrase}`));
  // URL/DB 안전한 형태로(영숫자), 앞 32자만.
  return toB64(h).replace(/[+/=]/g, "").slice(0, 32);
}

/** 민감 데이터를 passphrase 로 암호화 → 클라우드에 올릴 레코드(암호문만). */
export async function encryptSecret(payload: SecretPayload, passphrase: string): Promise<EncryptedRecord> {
  if (!passphrase || passphrase.length < 6) throw new Error("마스터 비밀번호는 6자 이상이어야 합니다.");
  const salt = webcrypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = webcrypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(passphrase, salt);
  const ctBuf = await subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(payload)));
  return { syncId: await deriveSyncId(passphrase), ciphertext: toB64(ctBuf), salt: toB64(salt), iv: toB64(iv) };
}

/**
 * 암호문을 passphrase 로 복호화 → 민감 데이터.
 *   ⚠️ 틀린 passphrase 면 AES-GCM 인증 실패로 예외가 난다(조용히 쓰레기값을 내지 않는다).
 */
export async function decryptSecret(rec: { ciphertext: string; salt: string; iv: string }, passphrase: string): Promise<SecretPayload> {
  const key = await deriveKey(passphrase, fromB64(rec.salt));
  let plainBuf: ArrayBuffer;
  try {
    plainBuf = await subtle.decrypt({ name: "AES-GCM", iv: fromB64(rec.iv) }, key, fromB64(rec.ciphertext));
  } catch {
    throw new Error("복호화 실패 — 마스터 비밀번호가 틀렸거나 데이터가 손상됐습니다.");
  }
  const obj = JSON.parse(dec.decode(plainBuf)) as SecretPayload;
  if (typeof obj?.clientId !== "string" || typeof obj?.clientSecret !== "string") {
    throw new Error("복호화된 데이터 형식이 올바르지 않습니다.");
  }
  return obj;
}

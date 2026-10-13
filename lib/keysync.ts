// =============================================================================
// lib/keysync.ts — 토스 키 기기 간 동기화용 "클라이언트 암호화" (v0.8.0)
// -----------------------------------------------------------------------------
// [무엇을 하나?]
//   여러 사람·여러 기기가 토스 키(Client ID/Secret/계좌)를 한 곳(Supabase)에 두고
//   공유하되, ⚠️ **평문은 절대 클라우드에 올리지 않는다.** 로그인한 본인만 아는
//   비밀번호(passphrase)로 기기에서 암호화(AES-GCM 256)한 뒤 "암호문만" 저장한다.
//   복호화도 기기에서 passphrase 로만.
//
// [왜 안전한가?]
//   - Supabase 에는 { 암호문, salt, iv } 만 저장된다. passphrase 는 어디에도 저장 안 한다.
//   - 행은 로그인 계정(user_id)으로 구분하고, RLS(행 수준 보안)가 "내 행만" 보이게 막는다.
//   - AES-GCM 은 인증 태그가 있어, 틀린 passphrase 로 복호화하면 조용히 깨지지 않고 '실패'로 드러난다.
//
// [v0.24.0] passphrase 에서 행 식별자를 만드는 deriveSyncId 는 삭제했다. 예전(GitHub
//   공개 저장소 방식)에는 "어느 파일이 내 것인지" 비밀번호로 숨겨야 했지만, 지금은
//   Supabase RLS가 로그인 계정(user_id)으로 행을 이미 격리하므로 더 필요 없다.
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
  ciphertext: string; // base64
  salt: string; //       base64 (PBKDF2)
  iv: string; //         base64 (AES-GCM)
}

// --- base64 유틸 ---
//   [왜 Buffer 를 안 쓰나?] 예전에는 Node 의 Buffer 를 썼는데, 이 모듈이 **브라우저(웹앱)에서도**
//   쓰이게 되면서 Buffer 가 없는 환경을 만나면 그대로 깨진다.
//   atob/btoa 는 브라우저와 Node(18+) 양쪽에 모두 있는 표준이라 어디서든 같은 결과를 낸다.
function toB64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = "";
  // 한 번에 넘기면 인자 수 제한에 걸릴 수 있어 조각내어 문자로 바꾼다.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const enc = new TextEncoder();
const dec = new TextDecoder();

/** passphrase + salt → AES-GCM 256bit 키 (PBKDF2-SHA256). */
// [타입 주의] 반환형을 CryptoKey 로 못 박지 않는다. Node 의 webcrypto 타입과 브라우저의
//   CryptoKey 타입이 미세하게 달라(키 용도 목록) 웹 빌드에서 충돌하기 때문이다. 추론에 맡긴다.
async function deriveKey(passphrase: string, salt: Uint8Array) {
  const baseKey = await subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** 민감 데이터를 passphrase 로 암호화 → 클라우드에 올릴 레코드(암호문만). */
export async function encryptSecret(payload: SecretPayload, passphrase: string): Promise<EncryptedRecord> {
  if (!passphrase || passphrase.length < 6) throw new Error("비밀번호는 6자 이상이어야 합니다.");
  const salt = webcrypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = webcrypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(passphrase, salt);
  const ctBuf = await subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(payload)));
  return { ciphertext: toB64(ctBuf), salt: toB64(salt), iv: toB64(iv) };
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

// =============================================================================
// [v0.10.0] 아무 데이터나 암호화하기 — 매매 이력 동기화에 재사용
// -----------------------------------------------------------------------------
// 위의 encryptSecret/decryptSecret 은 '토스 키' 전용 모양(clientId 등)이라 그대로 못 쓴다.
// 같은 자물쇠(PBKDF2 20만회 + AES-GCM 256)를 쓰되, **어떤 JSON이든** 담을 수 있게 한다.
//   매매 이력(체결 결과)을 여기 담아 Supabase(내 계정 전용 행)에 올려도, 비밀번호 없이는
//   아무 의미 없는 글자다.
// =============================================================================

/** 아무 JSON 데이터나 passphrase 로 암호화한다. */
export async function encryptJson(data: unknown, passphrase: string): Promise<EncryptedRecord> {
  if (!passphrase || passphrase.length < 6) throw new Error("비밀번호는 6자 이상이어야 합니다.");
  const salt = webcrypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = webcrypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(passphrase, salt);
  const ctBuf = await subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(data)));
  return { ciphertext: toB64(ctBuf), salt: toB64(salt), iv: toB64(iv) };
}

/** 암호문을 passphrase 로 풀어 원래 JSON 으로 되돌린다(틀린 비밀번호면 예외). */
export async function decryptJson<T>(rec: { ciphertext: string; salt: string; iv: string }, passphrase: string): Promise<T> {
  const key = await deriveKey(passphrase, fromB64(rec.salt));
  let plainBuf: ArrayBuffer;
  try {
    plainBuf = await subtle.decrypt({ name: "AES-GCM", iv: fromB64(rec.iv) }, key, fromB64(rec.ciphertext));
  } catch {
    throw new Error("복호화 실패 — 동기화 비밀번호가 틀렸거나 데이터가 손상됐습니다.");
  }
  return JSON.parse(dec.decode(plainBuf)) as T;
}

// =============================================================================
// [v0.88.0] "데이터 키" 방식 — 비밀번호를 저장하지 않고도 PC가 계속 올릴 수 있게 한다
// -----------------------------------------------------------------------------
// [사고 원인(2026-10-13 확인)] 위 encryptJson/decryptJson은 매번 "로그인 비밀번호"로 잠근다. 그런데 PC 앱은 재시작하면 비밀번호 없이
//   저장된 토큰(refresh token)으로만 로그인을 복원한다 → 비밀번호가 메모리에 없다 → 암호화 동기화(capri_trades·capri_auto_state·
//   capri_splits)가 **조용히 통째로 건너뛰어졌다**(자동 업데이트·재시작이 잦을수록 더). 폰은 새로 비밀번호를 치고 로그인하니 읽기는 되는데,
//   PC가 안 올린 데이터는 9월에서 멈춰 있었다.
// [해결] 비밀번호로부터 **고정 솔트(계정 id)로 한 번 만든 32바이트 "데이터 키"**로 잠근다. PC는 비밀번호를 한 번 입력받을 때 이 키만 로컬에 저장하고
//   (비밀번호 자체는 여전히 저장 안 함), 그 뒤로는 재시작해도 이 키로 계속 올린다. 폰은 로그인 때 친 비밀번호에서 같은 키를 다시 만들어 푼다.
//   레코드의 salt 칸이 "k1"이면 이 방식, 아니면 예전 방식(레코드마다 다른 솔트 — 비밀번호가 있어야 풀림).
// =============================================================================

const DATAKEY_SALT_PREFIX = "capri-datakey-v1:";
export const DATA_KEY_SCHEME = "k1";

/** 비밀번호 + 계정 id → 데이터 키(base64 32바이트). 같은 입력이면 항상 같은 값(어느 기기에서든). */
export async function deriveDataKey(password: string, userId: string): Promise<string> {
  if (!password || password.length < 6) throw new Error("비밀번호는 6자 이상이어야 합니다.");
  if (!userId) throw new Error("계정 정보가 없습니다.");
  const baseKey = await subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await subtle.deriveBits({ name: "PBKDF2", salt: enc.encode(DATAKEY_SALT_PREFIX + userId), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" }, baseKey, 256);
  return toB64(bits);
}

async function importDataKey(dataKeyB64: string) {
  return subtle.importKey("raw", fromB64(dataKeyB64), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** 데이터 키로 아무 JSON이나 암호화한다(레코드 salt = "k1"). */
export async function encryptJsonWithDataKey(data: unknown, dataKeyB64: string): Promise<EncryptedRecord> {
  const iv = webcrypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await importDataKey(dataKeyB64);
  const ctBuf = await subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(data)));
  return { ciphertext: toB64(ctBuf), salt: DATA_KEY_SCHEME, iv: toB64(iv) };
}

/** 레코드가 데이터 키 방식인가. */
export function isDataKeyRecord(rec: { salt: string }): boolean {
  return rec.salt === DATA_KEY_SCHEME;
}

/**
 * 어떤 방식으로 잠겼든 푼다. k1이면 데이터 키(또는 비밀번호+userId로 다시 만든 키), 예전 방식이면 비밀번호가 필요하다.
 *   필요한 열쇠가 없으면 "NEED_KEY" 예외(호출부가 '잠김' 표시를 띄우는 데 쓴다).
 */
export async function decryptJsonAuto<T>(
  rec: { ciphertext: string; salt: string; iv: string },
  keys: { password?: string | null; dataKey?: string | null; userId?: string | null },
): Promise<T> {
  let plainBuf: ArrayBuffer;
  if (isDataKeyRecord(rec)) {
    let dk = keys.dataKey ?? null;
    if (!dk && keys.password && keys.userId) dk = await deriveDataKey(keys.password, keys.userId);
    if (!dk) throw new Error("NEED_KEY");
    const key = await importDataKey(dk);
    try {
      plainBuf = await subtle.decrypt({ name: "AES-GCM", iv: fromB64(rec.iv) }, key, fromB64(rec.ciphertext));
    } catch {
      throw new Error("복호화 실패 — 동기화 키가 맞지 않거나 데이터가 손상됐습니다.");
    }
    return JSON.parse(dec.decode(plainBuf)) as T;
  }
  if (!keys.password) throw new Error("NEED_KEY");
  return decryptJson<T>(rec, keys.password);
}

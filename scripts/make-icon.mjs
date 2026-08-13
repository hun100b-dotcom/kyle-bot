// =============================================================================
// scripts/make-icon.mjs  —  앱 아이콘(build/icon.png, 1024×1024) 생성기
// -----------------------------------------------------------------------------
// [왜 이 스크립트가 있나?]
//   지금까지 카프리는 **일렉트론 기본 아이콘**(회색 원자 모양)으로 설치됐습니다.
//   빌드 로그에도 "default Electron icon is used"라고 찍혔죠. 맥 dmg를 만들 때는
//   아이콘이 없으면 더 어색합니다(런치패드·Dock에 기본 아이콘이 그대로 뜸).
//
//   그런데 PNG를 만들려면 보통 이미지 라이브러리(sharp 등)를 설치해야 합니다.
//   실계좌를 다루는 앱이라 **의존성을 늘리지 않는 편이 안전**하므로,
//   Node에 원래 들어 있는 zlib만 써서 PNG를 직접 그립니다(외부 패키지 0개).
//
// [실행] node scripts/make-icon.mjs   →   build/icon.png 생성
//   electron-builder가 build/icon.png 를 자동으로 찾아
//   윈도우(.ico)·맥(.icns) 아이콘으로 변환해 줍니다(플랫폼 무관).
// =============================================================================

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 아이콘을 여러 크기로 뽑는다.
//   · build/icon.png(1024) — electron-builder 가 윈도우 .ico / 맥 .icns 로 변환
//   · web/public/icons/*.png — 아이폰 홈 화면(PWA) 아이콘(그대로 복사되는 폴더)
const OUTPUTS = [
  { size: 1024, path: ["build", "icon.png"] },
  { size: 512, path: ["web", "public", "icons", "icon-512.png"] },
  { size: 192, path: ["web", "public", "icons", "icon-192.png"] },
];
const SS = 3; //     한 픽셀을 3×3으로 잘게 찍어 평균 내면 가장자리가 매끄럽다(안티에일리어싱)

// ---- 색 (카프리 화면과 같은 계열: 남색 배경 + 초록 강조) -------------------
const BG_TOP = [15, 23, 42]; //    #0F172A
const BG_BOTTOM = [30, 41, 59]; // #1E293B
const GREEN = [34, 197, 94]; //    #22C55E
const LIGHT = [226, 232, 240]; //  #E2E8F0

/** 두 색을 t(0~1) 비율로 섞는다 */
function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** 둥근 사각형 안쪽인가? (r = 모서리 반지름) */
function inRoundedRect(x, y, w, h, r) {
  const cx = Math.min(Math.max(x, r), w - r);
  const cy = Math.min(Math.max(y, r), h - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** 링(C자) 안쪽인가? 오른쪽에 입을 벌린 'C' 모양을 만든다 (좌표는 1024 기준) */
function inCArc(x, y) {
  const dx = x - 512;
  const dy = y - 512;
  const dist = Math.hypot(dx, dy);
  if (dist < 232 || dist > 330) return false; // 링 두께(안쪽 232 ~ 바깥 330)
  const deg = (Math.atan2(dy, dx) * 180) / Math.PI; // -180 ~ 180 (0 = 오른쪽)
  return Math.abs(deg) > 46; // 오른쪽 ±46도는 비워서 'C'로 보이게
}

/** 안쪽 막대그래프(오르는 3개) 안인가? — '상승'을 뜻하는 표시 */
function inBars(x, y) {
  const bars = [
    { cx: 432, top: 600 },
    { cx: 512, top: 528 },
    { cx: 592, top: 452 },
  ];
  const halfW = 26;
  const bottom = 648;
  for (const b of bars) {
    if (Math.abs(x - b.cx) <= halfW && y >= b.top && y <= bottom) return true;
  }
  return false;
}

// ---- 픽셀 채우기 -----------------------------------------------------------
// RGBA 순서로 한 줄씩 만든다. PNG는 각 줄 앞에 '필터 바이트'(0=필터 없음)가 붙는다.
// 그림은 1024 기준 좌표로 그리고, 원하는 크기(SIZE)로 축소해 샘플링한다.
function renderRaw(SIZE) {
const scale = 1024 / SIZE; // 화면 픽셀 → 1024 기준 좌표 변환 배율
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
let p = 0;
for (let y = 0; y < SIZE; y++) {
  raw[p++] = 0; // 필터 타입 0(None)
  for (let x = 0; x < SIZE; x++) {
    let rSum = 0,
      gSum = 0,
      bSum = 0,
      aSum = 0;

    // 한 픽셀을 SS×SS로 잘게 나눠 평균 → 곡선 가장자리가 부드러워진다.
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const px = (x + (sx + 0.5) / SS) * scale; // 1024 기준 좌표로 환산
        const py = (y + (sy + 0.5) / SS) * scale;

        if (!inRoundedRect(px, py, 1024, 1024, 190)) continue; // 아이콘 바깥(투명)

        // 배경: 위→아래 그라데이션
        let color = mix(BG_TOP, BG_BOTTOM, py / 1024);
        if (inCArc(px, py)) color = GREEN; //  'C' 링
        else if (inBars(px, py)) color = LIGHT; // 상승 막대

        rSum += color[0];
        gSum += color[1];
        bSum += color[2];
        aSum += 255;
      }
    }

    const n = SS * SS;
    const a = aSum / n;
    // 투명한 부분은 색이 없으니, 실제로 칠해진 표본들의 평균색을 쓴다.
    const filled = aSum / 255 || 1;
    raw[p++] = Math.round(rSum / filled);
    raw[p++] = Math.round(gSum / filled);
    raw[p++] = Math.round(bSum / filled);
    raw[p++] = Math.round(a);
  }
}
return raw;
}

// ---- PNG 파일 조립 ---------------------------------------------------------
// PNG는 [시그니처][IHDR][IDAT][IEND] 구조이고, 각 청크 끝에 CRC32가 붙는다.
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function buildPng(SIZE) {
const raw = renderRaw(SIZE);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); //  가로
ihdr.writeUInt32BE(SIZE, 4); //  세로
ihdr[8] = 8; //                  비트 깊이 8
ihdr[9] = 6; //                  색 타입 6 = RGBA
// 10,11,12 = 압축/필터/인터레이스 방식 기본값(0)

return Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG 시그니처
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
for (const { size, path } of OUTPUTS) {
  const png = buildPng(size);
  const out = resolve(ROOT, ...path);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, png);
  console.log(`아이콘 생성: ${path.join("/")} (${size}×${size}, ${(png.length / 1024).toFixed(1)}KB)`);
}

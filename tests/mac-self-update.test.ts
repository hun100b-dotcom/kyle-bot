// =============================================================================
// tests/mac-self-update.test.ts — macOS 직접 교체 자동업데이트(electron/mac-self-update.ts)
// -----------------------------------------------------------------------------
// [무엇을 검증하나 / 왜 이만큼만?]
//   이 파일의 핵심 로직(GitHub 릴리스 다운로드, unzip/xattr 실행, 앱 종료 훅, 실제 셸
//   스크립트 실행)은 macOS 전용이라 이 프로젝트의 개발/CI 환경(Windows)에서는 애초에
//   실행되지 않는다(모든 함수가 process.platform !== "darwin"이면 조용히 null을
//   돌려주도록 짜여 있다) — 그래서 실제 다운로드·압축해제·번들교체·재실행은 이 테스트
//   스위트로 검증할 수 없다(맥 실기기가 없어 이번 세션에서 실행 검증 자체가 불가능했다
//   — 정직하게 기록해 둔다).
//
//   대신 macOS 유무와 무관하게 100% 결정적으로 동작하는 "순수 함수" 부분(버전 비교,
//   자산 선택, YAML 파싱, 경로 계산, sha512 계산, 스크립트 문자열 생성)은 전부 검증한다
//   — 이 부분에 버그가 있으면 실제 맥에서도 100% 재현될 로직 오류이므로, 여기서 잡아내는
//   의미가 크다.
// =============================================================================

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  isNewerVersion,
  pickMacZipAsset,
  parseLatestMacYmlSha512,
  resolveAppBundleRoot,
  sha512Base64OfFile,
  buildSwapScript,
  type ReleaseAsset,
} from "../electron/mac-self-update";

describe("isNewerVersion", () => {
  it("패치 버전이 더 높으면 최신으로 판정한다", () => {
    expect(isNewerVersion("0.60.1", "0.60.0")).toBe(true);
    expect(isNewerVersion("0.60.0", "0.60.0")).toBe(false);
    expect(isNewerVersion("0.60.0", "0.60.1")).toBe(false);
  });
  it("자릿수가 다르거나(1.0 vs 1.0.0) 상위 버전이 다를 때도 올바르게 비교한다", () => {
    expect(isNewerVersion("1.0.0", "0.99.9")).toBe(true);
    expect(isNewerVersion("1.0", "1.0.0")).toBe(false);
  });
});

describe("pickMacZipAsset", () => {
  const assets: ReleaseAsset[] = [
    { name: "Capri-0.60.0-mac.zip", browser_download_url: "https://x/Capri-0.60.0-mac.zip" },
    { name: "Capri-0.60.0-arm64-mac.zip", browser_download_url: "https://x/Capri-0.60.0-arm64-mac.zip" },
    { name: "Capri-0.60.0.dmg", browser_download_url: "https://x/Capri-0.60.0.dmg" },
    { name: "Capri-0.60.0-arm64.dmg", browser_download_url: "https://x/Capri-0.60.0-arm64.dmg" },
    { name: "latest-mac.yml", browser_download_url: "https://x/latest-mac.yml" },
  ];

  it("arm64면 -arm64-mac.zip을, x64면 (arm64가 안 붙은) -mac.zip을 고른다", () => {
    expect(pickMacZipAsset(assets, "arm64")?.name).toBe("Capri-0.60.0-arm64-mac.zip");
    expect(pickMacZipAsset(assets, "x64")?.name).toBe("Capri-0.60.0-mac.zip");
  });

  it("dmg나 yml은 절대 고르지 않는다(zip만)", () => {
    const picked = pickMacZipAsset(assets, "x64");
    expect(picked?.name.endsWith(".zip")).toBe(true);
  });

  it("맞는 zip이 없으면 null", () => {
    expect(pickMacZipAsset([{ name: "Capri-0.60.0.dmg", browser_download_url: "x" }], "arm64")).toBeNull();
  });
});

describe("parseLatestMacYmlSha512", () => {
  // 실제 v0.60.0 릴리스에서 그대로 받아온 latest-mac.yml 원문(GitHub Releases API로
  // 실제 다운로드해 확인한 값 — 지어낸 샘플이 아니다).
  const REAL_YML = `version: 0.60.0
files:
  - url: Capri-0.60.0-mac.zip
    sha512: CYSSHlvB2Oavgv0bibGFJBndAWXK5tUJNFNer4dF6COdY+VovojrFLI0DJssQ0yWTw8u84L92z5iFAAFPeAJpg==
    size: 126703116
  - url: Capri-0.60.0-arm64-mac.zip
    sha512: e/A1ckUyTyGFvH+Hvvfm81undbpaj37ic+fw3xVo9f9EHrOuDOwRfBVIMIUj9wld7KPfCkPbrPIb+jc9Ea6eTQ==
    size: 121954120
  - url: Capri-0.60.0.dmg
    sha512: U7+yVBdQwVlmz5U21q6vptjiBEQp935pUw2bPg4OrWV6820yVfiJV4aNNarOjk4J+uq488XKc/mKIYn2/p/y3A==
    size: 126657484
  - url: Capri-0.60.0-arm64.dmg
    sha512: m7V0vmRiMfJDunMrb7Y/0f2aFNbPXtRzB8QO5PHSkAtBdgrosxxkwj2ImFclPtubodsEJSLTUCZ2QytXavi6RQ==
    size: 121939083
path: Capri-0.60.0-mac.zip
sha512: CYSSHlvB2Oavgv0bibGFJBndAWXK5tUJNFNer4dF6COdY+VovojrFLI0DJssQ0yWTw8u84L92z5iFAAFPeAJpg==
releaseDate: '2026-09-30T13:02:06.701Z'
`;

  it("x64 zip의 sha512를 정확히 뽑는다", () => {
    expect(parseLatestMacYmlSha512(REAL_YML, "Capri-0.60.0-mac.zip")).toBe(
      "CYSSHlvB2Oavgv0bibGFJBndAWXK5tUJNFNer4dF6COdY+VovojrFLI0DJssQ0yWTw8u84L92z5iFAAFPeAJpg==",
    );
  });

  it("arm64 zip의 sha512를 정확히 뽑는다(x64와 달라야 함)", () => {
    expect(parseLatestMacYmlSha512(REAL_YML, "Capri-0.60.0-arm64-mac.zip")).toBe(
      "e/A1ckUyTyGFvH+Hvvfm81undbpaj37ic+fw3xVo9f9EHrOuDOwRfBVIMIUj9wld7KPfCkPbrPIb+jc9Ea6eTQ==",
    );
  });

  it("[중요] files: 블록 바깥(최상위 path:/sha512: 쌍)은 무시한다 — 마지막 항목을 잘못 덮어쓰지 않는지 확인", () => {
    // 최상위 sha512(맨 아래 줄)는 x64 zip 것과 우연히 값이 같다(electron-builder가 그렇게
    // 만듦 — path가 x64 zip이라서). 그래서 이 테스트는 "마지막 files 항목"인 arm64 dmg가
    // 최상위 sha512로 오염되지 않는지로 확인한다.
    expect(parseLatestMacYmlSha512(REAL_YML, "Capri-0.60.0-arm64.dmg")).toBe(
      "m7V0vmRiMfJDunMrb7Y/0f2aFNbPXtRzB8QO5PHSkAtBdgrosxxkwj2ImFclPtubodsEJSLTUCZ2QytXavi6RQ==",
    );
  });

  it("없는 파일명이면 null", () => {
    expect(parseLatestMacYmlSha512(REAL_YML, "Capri-9.9.9-mac.zip")).toBeNull();
  });
});

describe("resolveAppBundleRoot", () => {
  it("실행파일 경로에서 .app 번들 루트를 찾는다", () => {
    expect(resolveAppBundleRoot("/Applications/Capri.app/Contents/MacOS/Capri")).toBe("/Applications/Capri.app");
  });
  it("경로에 공백이 있어도(예: 사용자 이름) 정확히 찾는다", () => {
    expect(resolveAppBundleRoot("/Users/Kail Kim/Applications/Capri.app/Contents/MacOS/Capri")).toBe(
      "/Users/Kail Kim/Applications/Capri.app",
    );
  });
  it(".app이 경로에 없으면(패키징 안 된 개발 실행 등) null", () => {
    expect(resolveAppBundleRoot("/usr/local/bin/electron")).toBeNull();
  });
});

describe("sha512Base64OfFile", () => {
  it("Node crypto로 직접 계산한 값과 일치한다(실제 파일 I/O 포함)", () => {
    const dir = mkdtempSync(join(tmpdir(), "capri-mac-update-"));
    try {
      const file = join(dir, "sample.bin");
      const content = Buffer.from("capri-mac-self-update-checksum-test");
      writeFileSync(file, content);
      const expected = createHash("sha512").update(content).digest("base64");
      expect(sha512Base64OfFile(file)).toBe(expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildSwapScript", () => {
  const script = buildSwapScript();

  it("PID가 완전히 종료될 때까지 기다리는 루프를 포함한다(실행 중 교체 금지 안전장치)", () => {
    expect(script).toContain('kill -0 "$PID"');
  });
  it("실패 시 기존 앱으로 되돌리는 롤백 경로를 포함한다(자리 비워둔 채 끝나지 않음)", () => {
    expect(script).toContain('mv "$BACKUP" "$OLD_APP"');
  });
  it("교체 후 다시 여는(open) 재실행 단계를 포함한다", () => {
    expect(script).toContain('open "$OLD_APP"');
  });
  it("새 앱을 옮기기 전에 기존 앱을 먼저 지우지 않는다(백업 이름으로만 옮김 — rm은 옮긴 뒤에만)", () => {
    const mvOldIdx = script.indexOf('mv "$OLD_APP" "$BACKUP"');
    const mvNewIdx = script.indexOf('mv "$NEW_APP" "$OLD_APP"');
    expect(mvOldIdx).toBeGreaterThan(-1);
    expect(mvNewIdx).toBeGreaterThan(mvOldIdx); // 기존 앱을 먼저 백업한 뒤에야 새 앱을 들여놓는다
  });
});

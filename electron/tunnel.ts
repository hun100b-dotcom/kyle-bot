// =============================================================================
// electron/tunnel.ts — 집 PC의 릴레이를 인터넷에서 접속 가능하게 만드는 '터널'
// -----------------------------------------------------------------------------
// [무슨 문제를 푸나?]
//   릴레이는 집 PC 안(127.0.0.1)에서만 열립니다. 밖에 있는 폰은 그 주소로 못 옵니다.
//   공유기 포트를 여는 건 위험하고 어렵습니다. 그래서 **터널**을 씁니다.
//   터널은 "밖에서 접속할 수 있는 임시 https 주소"를 만들어 집 PC로 연결해 줍니다.
//
// [무엇을 쓰나 — cloudflared quick tunnel]
//   Cloudflare 가 제공하는 무료 터널로, **계정도 결제도 필요 없습니다.**
//   주소는 https://무작위이름.trycloudflare.com 형태이며, 켤 때마다 바뀝니다.
//   그래서 데스크톱 앱이 그 주소를 화면에 크게 보여 주고 QR로도 만들어 줍니다.
//
// [프로그램이 없으면?]
//   이 파일이 **알아서 내려받습니다.**(사장님이 설치할 일 없음)
//   내려받은 파일은 앱 데이터 폴더에 두고 다음부터 재사용합니다.
// =============================================================================

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, createWriteStream, chmodSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** 이 컴퓨터에 맞는 cloudflared 내려받기 주소 */
function downloadUrl(): { url: string; isArchive: boolean; fileName: string } {
  const base = "https://github.com/cloudflare/cloudflared/releases/latest/download";
  if (process.platform === "win32") {
    return { url: `${base}/cloudflared-windows-amd64.exe`, isArchive: false, fileName: "cloudflared.exe" };
  }
  if (process.platform === "darwin") {
    // 애플 실리콘/인텔 구분 (arm64 파일이 없던 시절 대비해 x64 로 폴백)
    const arch = process.arch === "arm64" ? "arm64" : "amd64";
    return { url: `${base}/cloudflared-darwin-${arch}.tgz`, isArchive: true, fileName: "cloudflared" };
  }
  return { url: `${base}/cloudflared-linux-amd64`, isArchive: false, fileName: "cloudflared" };
}

/**
 * ensureCloudflared — 터널 프로그램이 없으면 내려받는다. 있으면 그 경로만 돌려준다.
 * @param dir 저장할 폴더(앱 데이터 폴더 권장)
 */
export async function ensureCloudflared(dir: string, onProgress?: (msg: string) => void): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const { url, isArchive, fileName } = downloadUrl();
  const target = join(dir, fileName);
  if (existsSync(target)) return target;

  onProgress?.("터널 프로그램을 처음 한 번만 내려받는 중…");

  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`터널 프로그램 내려받기 실패(HTTP ${res.status})`);

  if (!isArchive) {
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(target));
    if (process.platform !== "win32") chmodSync(target, 0o755); // 실행 권한
    return target;
  }

  // macOS 는 압축(tgz)으로 제공된다 → 시스템 tar 로 푼다(맥에는 기본 설치돼 있음).
  const tgz = join(dir, "cloudflared.tgz");
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tgz));
  await new Promise<void>((resolve, reject) => {
    const p = spawn("tar", ["-xzf", tgz, "-C", dir]);
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`압축 풀기 실패(코드 ${code})`))));
  });
  if (existsSync(target)) chmodSync(target, 0o755);
  return target;
}

export interface TunnelHandle {
  /** 밖에서 접속 가능한 https 주소(예: https://xxx.trycloudflare.com) */
  publicUrl: string;
  stop: () => void;
}

/**
 * startTunnel — 로컬 포트를 인터넷에 임시 공개한다.
 * @param port 릴레이가 열려 있는 포트
 * @param binDir 터널 프로그램을 둘 폴더
 */
export async function startTunnel(
  port: number,
  binDir: string,
  onProgress?: (msg: string) => void,
): Promise<TunnelHandle> {
  const bin = await ensureCloudflared(binDir, onProgress);
  onProgress?.("인터넷 접속 주소를 만드는 중…");

  const child: ChildProcess = spawn(
    bin,
    [
      "tunnel",
      "--no-autoupdate",
      "--url",
      `http://127.0.0.1:${port}`,
      // 로그를 표준출력으로 보내 주소를 읽는다.
      "--logfile",
      "",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  return new Promise<TunnelHandle>((resolve, reject) => {
    let settled = false;
    let buffer = "";

    // 60초 안에 주소가 안 나오면 실패로 본다(앱이 영영 기다리지 않게).
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error("터널 주소를 받지 못했습니다(60초 초과). 인터넷 연결을 확인해 주세요."));
    }, 60_000);

    const scan = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      // cloudflared 는 로그 중간에 https://…trycloudflare.com 주소를 출력한다.
      const m = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({
          publicUrl: m[0],
          stop: () => child.kill(),
        });
      }
    };

    child.stdout?.on("data", scan);
    child.stderr?.on("data", scan); // cloudflared 는 주소를 stderr 로도 낸다
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`터널이 예기치 않게 종료됐습니다(코드 ${code}).`));
    });
  });
}

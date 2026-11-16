import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord, readNumber } from "../model/index.ts";
import type {
  FailurePhase,
  Mode,
  ObjectEntry,
  TransferSample,
} from "../model/index.ts";

export function makeTransfers(
  base: URL,
  socksPort: number,
  ca: string | undefined,
) {
  async function request(
    path: string,
    mode: Mode,
    expected?: number,
    output = devNull,
    timeout = 12,
  ): Promise<TransferSample> {
    const proxy =
      mode === "proxy"
        ? ["--noproxy", "", "--proxy", "socks5h://127.0.0.1:" + socksPort]
        : ["--proxy", ""];
    const args = [
      "-q",
      "--silent",
      "--http1.1",
      "--proto",
      "=http,https",
      "--header",
      "Accept-Encoding: identity",
      "--connect-timeout",
      "5",
      "--max-time",
      String(timeout),
      "--output",
      output,
      "--write-out",
      "%{json}",
      ...proxy,
    ];
    if (ca) args.push("--cacert", ca);
    args.push(new URL(path, base).href);
    const { exit, data } = await new Promise<{ exit: number; data: string }>(
      (resolve, reject) => {
        const child = spawn("curl", args, {
          shell: false,
          stdio: ["ignore", "pipe", "ignore"],
        });
        let data = "";
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
          data += chunk;
        });
        child.once("error", reject);
        child.once("close", (code) => resolve({ exit: code ?? 1, data }));
      },
    );
    const timing: unknown = data ? JSON.parse(data) : {};
    if (!isRecord(timing)) throw Error("curl timing output is invalid");
    const value = (key: string) => readNumber(timing[key] ?? 0, key);
    const bytes = value("size_download");
    const status = value("http_code");
    const ttfbMs = value("time_starttransfer") * 1000;
    let failure: FailurePhase | null = null;
    if (
      exit !== 0 ||
      status !== 200 ||
      (expected !== undefined && bytes !== expected)
    ) {
      if (exit === 5 || exit === 6) failure = "dns";
      else if (exit === 97) failure = "socks";
      else if ([35, 51, 60].includes(exit)) failure = "tls";
      else if (!value("time_connect")) failure = "tcp";
      else if (base.protocol === "https:" && !value("time_appconnect"))
        failure = "tls";
      else if (!ttfbMs || (status !== 0 && status !== 200)) failure = "request";
      else failure = "response";
    }
    return {
      bytes,
      status,
      exit,
      failure,
      ttfbMs,
      totalMs: value("time_total") * 1000,
    };
  }

  async function body(
    path: string,
    mode: Mode,
    expected?: ObjectEntry,
  ): Promise<Buffer> {
    const directory = await mkdtemp(join(tmpdir(), "anymodel-transfer-"));
    try {
      const file = join(directory, "body");
      const result = await request(path, mode, expected?.bytes, file);
      if (result.failure)
        throw Error(
          mode +
            " " +
            path +
            " failed at " +
            result.failure +
            " (curl " +
            result.exit +
            ")",
        );
      const payload = await readFile(file);
      if (
        expected &&
        createHash("sha256").update(payload).digest("hex") !== expected.sha256
      ) {
        throw Error(mode + " " + path + " does not match the manifest SHA-256");
      }
      return payload;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  return { request, body };
}

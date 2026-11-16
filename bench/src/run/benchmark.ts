import { closeSync, writeSync } from "node:fs";
import { isIP } from "node:net";
import { setTimeout } from "node:timers/promises";
import { parseArgs } from "node:util";
import {
  benchmarkLevels,
  boundedInteger,
  isRecord,
  objectSizes,
  openPrivateOutput,
  sustainedRates,
} from "../model/index.ts";
import type {
  Mode,
  ObjectEntry,
  TransferSample,
  WindowSample,
} from "../model/index.ts";
import { makeTransfers } from "./transfer.ts";

type Transfers = ReturnType<typeof makeTransfers>;
const modes: Mode[] = ["direct", "proxy"];
const shortRequestInterval = 250;

async function window(
  transfers: Transfers,
  mode: Mode,
  workers: number,
  seconds: number,
  repeat: number,
): Promise<WindowSample> {
  const startUtc = new Date().toISOString();
  const start = performance.now();
  const deadline = start + seconds * 1000;
  async function collect(size: number, period = 0): Promise<TransferSample[]> {
    const rows: TransferSample[] = [];
    while (performance.now() < deadline) {
      const tick = performance.now();
      rows.push(await transfers.request("/blob/" + size, mode, size * 1024));
      const wait = Math.min(tick + period, deadline) - performance.now();
      if (wait > 0) await setTimeout(wait);
    }
    return rows;
  }
  const shortPromise = collect(4, shortRequestInterval);
  const bulkPromise = Promise.all(
    Array.from({ length: workers }, () => collect(8192)),
  );
  const [short, bulk] = await Promise.all([shortPromise, bulkPromise]);
  return {
    kind: "window",
    mode,
    workers,
    repeat,
    startUtc,
    endUtc: new Date().toISOString(),
    seconds: (performance.now() - start) / 1000,
    bulk: bulk.flat(),
    short,
  };
}

function manifestFrom(payload: Buffer): Map<number, ObjectEntry> {
  const result: unknown = JSON.parse(payload.toString("utf8"));
  if (!isRecord(result)) throw Error("Invalid origin manifest");
  const entries = new Map<number, ObjectEntry>();
  for (const size of objectSizes) {
    const object = result[String(size)];
    if (
      !isRecord(object) ||
      object.bytes !== size * 1024 ||
      typeof object.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(object.sha256)
    )
      throw Error("Invalid manifest entry " + size);
    entries.set(size, { bytes: object.bytes, sha256: object.sha256 });
  }
  return entries;
}

async function verifyOrigin(transfers: Transfers, expectedPeer: string) {
  const direct = (await transfers.body("/peer", "direct")).toString().trim();
  const proxy = (await transfers.body("/peer", "proxy")).toString().trim();
  if (!isIP(direct) || proxy !== expectedPeer || proxy === direct) {
    throw Error("Origin did not see the expected distinct VPS egress peer");
  }
  const manifest = await transfers.body("/manifest", "direct");
  if (!manifest.equals(await transfers.body("/manifest", "proxy")))
    throw Error("Origin instances differ");
  const entries = manifestFrom(manifest);
  const short = entries.get(4);
  if (!short) throw Error("Missing short object");
  for (const mode of modes) await transfers.body("/blob/4", mode, short);
  return entries;
}

async function probes(transfers: Transfers, emit: (row: object) => void) {
  for (let repeat = 1; repeat <= 3; repeat += 1) {
    for (const size of objectSizes.filter((size) => size <= 256)) {
      for (const mode of modes) {
        const utc = new Date().toISOString();
        emit({
          kind: "probe",
          utc,
          mode,
          repeat,
          sizeKiB: size,
          rateBytesPerSecond: 0,
          ...(await transfers.request("/blob/" + size, mode, size * 1024)),
        });
      }
    }
  }
  for (const rate of sustainedRates) {
    for (const mode of modes) {
      const utc = new Date().toISOString();
      emit({
        kind: "probe",
        utc,
        mode,
        repeat: 1,
        sizeKiB: 256,
        rateBytesPerSecond: rate,
        ...(await transfers.request(
          "/blob/256?rate=" + rate,
          mode,
          256 * 1024,
          undefined,
          45,
        )),
      });
    }
  }
}

export async function runMain(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      origin: { type: "string" },
      "proxy-peer": { type: "string" },
      output: { type: "string" },
      "socks-port": { type: "string", default: "1080" },
      cacert: { type: "string" },
      seconds: { type: "string", default: "25" },
      "max-streams": { type: "string", default: "32" },
      "probe-only": { type: "boolean", default: false },
    },
  });
  const expectedPeer = values["proxy-peer"];
  if (
    !values.origin ||
    !expectedPeer ||
    !isIP(expectedPeer) ||
    !values.output
  ) {
    throw Error("Supply --origin URL, --proxy-peer IP and --output FILE");
  }
  const origin = new URL(values.origin);
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw Error("Use a base HTTP(S) URL");
  const seconds = boundedInteger(values.seconds, "seconds", 20, 30);
  const socksPort = boundedInteger(
    values["socks-port"],
    "socks port",
    1,
    65535,
  );
  const maxStreams = boundedInteger(
    values["max-streams"],
    "max streams",
    1,
    64,
  );
  if (!benchmarkLevels.includes(maxStreams))
    throw Error("Max streams must match a measured level");
  const transfers = makeTransfers(origin, socksPort, values.cacert);
  const manifest = await verifyOrigin(transfers, expectedPeer);
  const log = openPrivateOutput(values.output);
  const emit = (row: object) => {
    writeSync(log, JSON.stringify(row) + "\n");
  };
  try {
    emit({
      kind: "session",
      utc: new Date().toISOString(),
      originProtocol: origin.protocol,
      objectHashes: Object.fromEntries(manifest),
      mux: false,
      windowSeconds: seconds,
      shortRequestIntervalMs: shortRequestInterval,
    });
    console.log(
      "Origin verified via both paths. Running size and duration probes.",
    );
    await probes(transfers, emit);
    if (values["probe-only"]) return;
    const bulk = manifest.get(8192);
    if (!bulk) throw Error("Missing bulk object");
    for (const mode of modes) await transfers.body("/blob/8192", mode, bulk);
    for (let repeat = 1; repeat <= 3; repeat += 1) {
      const sequence = repeat % 2 ? modes : [...modes].reverse();
      for (const workers of [
        0,
        ...benchmarkLevels.filter((level) => level <= maxStreams),
      ]) {
        for (const mode of sequence) {
          console.log(
            "Repeat %d/3, %s, %d bulk + 1 short",
            repeat,
            mode,
            workers,
          );
          emit(await window(transfers, mode, workers, seconds, repeat));
          await setTimeout(3000);
        }
      }
    }
  } finally {
    closeSync(log);
  }
}

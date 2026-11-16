import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { benchmarkLevels, isRecord, readNumber } from "../model/index.ts";
import type { TransferSample, WindowSample } from "../model/index.ts";

function records(file: string): Record<string, unknown>[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line, index) => {
      const data: unknown = JSON.parse(line);
      if (!isRecord(data)) throw Error("Invalid record at line " + (index + 1));
      return data;
    });
}

function isTransfer(value: unknown): value is TransferSample {
  return (
    isRecord(value) &&
    ["bytes", "status", "exit", "ttfbMs", "totalMs"].every((key) => {
      const number = value[key];
      return typeof number === "number" && Number.isFinite(number) && number >= 0;
    }) &&
    (value.failure === null ||
      (typeof value.failure === "string" &&
        ["dns", "tcp", "socks", "tls", "request", "response"].includes(
          value.failure,
        )))
  );
}

function timestamp(value: unknown) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    throw Error("Invalid timestamp");
  return value;
}

function readWindow(data: Record<string, unknown>): WindowSample {
  if (
    (data.mode !== "direct" && data.mode !== "proxy") ||
    !Array.isArray(data.bulk) ||
    !Array.isArray(data.short) ||
    !data.bulk.every(isTransfer) ||
    !data.short.every(isTransfer)
  ) {
    throw Error("Invalid benchmark window");
  }
  const seconds = readNumber(data.seconds, "seconds");
  const workers = readNumber(data.workers, "workers");
  const repeat = readNumber(data.repeat, "repeat");
  const startUtc = timestamp(data.startUtc);
  const endUtc = timestamp(data.endUtc);
  if (
    seconds <= 0 ||
    (workers !== 0 && !benchmarkLevels.includes(workers)) ||
    !Number.isInteger(repeat) ||
    repeat < 1 ||
    repeat > 3 ||
    Date.parse(endUtc) < Date.parse(startUtc)
  ) {
    throw Error("Invalid benchmark window metadata");
  }
  return {
    kind: "window",
    mode: data.mode,
    workers,
    repeat,
    seconds,
    startUtc,
    endUtc,
    bulk: data.bulk,
    short: data.short,
  };
}

function quantile(values: number[], fraction: number): number | undefined {
  if (!values.length) return undefined;
  const ordered = [...values].sort((first, second) => first - second);
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)];
}

function errors(rows: TransferSample[]) {
  return rows.length
    ? (rows.filter((row) => row.failure !== null).length * 100) / rows.length
    : undefined;
}

function latency(
  rows: TransferSample[],
  key: "ttfbMs" | "totalMs",
  fraction: number,
) {
  return quantile(
    rows.filter((row) => row.failure === null).map((row) => row[key]),
    fraction,
  );
}

function goodput(window: WindowSample) {
  return (
    (window.bulk
      .filter((row) => row.failure === null)
      .reduce((sum, row) => sum + row.bytes, 0) *
      8) /
    window.seconds /
    1e6
  );
}

function stability(
  set: WindowSample[],
  reference: WindowSample[],
  tcp: number | undefined,
) {
  if (!set[0].workers) return "baseline";
  const base = reference.flatMap((window) => window.short);
  const short = set.flatMap((window) => window.short);
  const bulk = set.flatMap((window) => window.bulk);
  if (
    new Set(set.map((row) => row.repeat)).size !== 3 ||
    new Set(reference.map((row) => row.repeat)).size !== 3 ||
    base.length < 100 ||
    short.length < 100 ||
    bulk.length < 30
  )
    return "insufficient";
  const baseline = latency(base, "totalMs", 0.95);
  if (baseline === undefined || (errors(base) ?? Infinity) > 1)
    return "invalid-baseline";
  if (
    set.some(
      (window) =>
        (errors(window.bulk) ?? Infinity) > 1 ||
        (errors(window.short) ?? Infinity) > 1 ||
        (latency(window.short, "totalMs", 0.95) ?? Infinity) > 2 * baseline,
    )
  )
    return "fail";
  if (
    set[0].mode === "proxy" &&
    (tcp === undefined || tcp < set[0].workers + 1)
  )
    return "tcp-unconfirmed";
  return "pass";
}

export function resultsMain(args: string[]) {
  const { values } = parseArgs({
    args,
    options: { input: { type: "string" }, metrics: { type: "string" } },
  });
  if (!values.input) throw Error("Supply --input FILE");
  const windows = records(values.input)
    .filter((row) => row.kind === "window")
    .map(readWindow);
  if (!windows.length) throw Error("No completed load windows");
  const metrics = values.metrics
    ? records(values.metrics).map((row) => ({
        ...row,
        time: Date.parse(timestamp(row.utc)),
      }))
    : [];
  const groups = new Map<string, WindowSample[]>();
  for (const window of windows) {
    const key = window.mode + ":" + window.workers;
    const group = groups.get(key) ?? [];
    if (group.some((entry) => entry.repeat === window.repeat))
      throw Error("Duplicate benchmark repeat for " + key);
    group.push(window);
    groups.set(key, group);
  }
  const columns =
    "mode,bulk_workers,short_workers,repeats,bulk_requests,short_requests,bulk_success_pct,short_success_pct," +
    "median_mbps,min_mbps,max_mbps,p50_ttfb_ms,p95_ttfb_ms,p50_full_ms,p95_full_ms,metrics_samples,peak_xray_tcp," +
    "median_xray_cpu_host_pct,peak_xray_ram_mib,peak_host_cpu_pct,peak_host_steal_pct,min_host_ram_available_mib,stability";
  console.log(columns);
  let stableStreams = 0;
  for (const set of groups.values()) {
    const { mode, workers } = set[0];
    const bulk = set.flatMap((window) => window.bulk);
    const short = set.flatMap((window) => window.short);
    const mbps = set.map(goodput);
    const samples = metrics.filter((row) =>
      set.some(
        (window) =>
          row.time >= Date.parse(window.startUtc) &&
          row.time <= Date.parse(window.endUtc),
      ),
    );
    const metric = (key: string, fraction: number, divisor = 1) =>
      quantile(
        samples.flatMap((row) => {
          const value: unknown = Object.entries(row).find(
            ([name]) => key === name,
          )?.[1];
          return typeof value === "number" && Number.isFinite(value)
            ? [value / divisor]
            : [];
        }),
        fraction,
      );
    const tcp = metric("xrayTcpEstablished", 1);
    const status = stability(set, groups.get(mode + ":0") ?? [], tcp);
    if (mode === "proxy" && status === "pass")
      stableStreams = Math.max(stableStreams, workers);
    const bulkError = errors(bulk);
    const shortError = errors(short);
    const output = [
      mode,
      workers,
      1,
      set.length,
      bulk.length,
      short.length,
      bulkError === undefined ? undefined : 100 - bulkError,
      shortError === undefined ? undefined : 100 - shortError,
      quantile(mbps, 0.5),
      Math.min(...mbps),
      Math.max(...mbps),
      latency(short, "ttfbMs", 0.5),
      latency(short, "ttfbMs", 0.95),
      latency(short, "totalMs", 0.5),
      latency(short, "totalMs", 0.95),
      samples.length,
      tcp,
      metric("containerCpuHostPct", 0.5),
      metric("containerRamBytes", 1, 1024 ** 2),
      metric("hostCpuBusyPct", 1),
      metric("hostCpuStealPct", 1),
      metric("hostRamAvailableBytes", 0, 1024 ** 2),
      status,
    ];
    console.log(
      output
        .map((value) =>
          typeof value === "number" ? Number(value.toFixed(3)) : (value ?? ""),
        )
        .join(","),
    );
  }
  console.error(
    stableStreams
      ? "Maximum confirmed stable proxy load: " +
          stableStreams +
          " bulk TCP streams"
      : "Maximum stable proxy load could not be confirmed",
  );
}

import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, readFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs, stripVTControlCharacters } from "node:util";
import {
  boundedInteger,
  isRecord,
  openPrivateOutput,
  projectRoot,
} from "../model/index.ts";

const units = new Map<string, number>([
  ["B", 1],
  ["kB", 1000],
  ["KB", 1000],
  ["MB", 1000 ** 2],
  ["GB", 1000 ** 3],
  ["KiB", 1024],
  ["MiB", 1024 ** 2],
  ["GiB", 1024 ** 3],
]);

function containerStats(line: string) {
  const row: unknown = JSON.parse(line);
  if (
    !isRecord(row) ||
    typeof row.CPUPerc !== "string" ||
    typeof row.MemUsage !== "string"
  ) {
    throw Error("Unexpected Compose stats output");
  }
  const cpu = /^(\d+(?:\.\d+)?)%$/.exec(row.CPUPerc)?.[1];
  const memory = /^([0-9.]+)([A-Za-z]+) \//.exec(row.MemUsage);
  const unit = memory && units.get(memory[2]);
  if (!cpu || !memory || !unit || !Number.isFinite(Number(memory[1]))) {
    throw Error("Invalid units in Compose stats");
  }
  return { cpu: Number(cpu), ram: Math.round(Number(memory[1]) * unit) };
}

function readCpu() {
  const line = readFileSync("/proc/stat", "utf8").split("\n", 1)[0];
  const fields = line.trim().split(/\s+/).slice(1, 9).map(Number);
  if (fields.length !== 8 || fields.some((value) => !Number.isFinite(value))) {
    throw Error("Invalid aggregate CPU counters");
  }
  return fields;
}

function hostSampler(pid: number, nic: string) {
  let previous = readCpu();
  return () => {
    const cpu = readCpu();
    const delta = cpu.map((value, index) => value - previous[index]);
    previous = cpu;
    const total = delta.reduce((sum, value) => sum + value, 0);
    const ram = readFileSync("/proc/meminfo", "utf8");
    function memory(key: string) {
      const value = new RegExp("^" + key + ":\\s+(\\d+)\\s+kB$", "m").exec(
        ram,
      )?.[1];
      if (!value) throw Error("Missing memory counter " + key);
      return Number(value) * 1024;
    }
    const sockets = execFileSync(
      "nsenter",
      [
        "--target",
        String(pid),
        "--net",
        "ss",
        "-Htn",
        "state",
        "established",
        "( sport = :8443 )",
      ],
      { encoding: "utf8" },
    ).trim();
    return {
      hostCpuBusyPct:
        total > 0
          ? (100 * (total - delta[3] - delta[4] - delta[7])) / total
          : null,
      hostCpuStealPct: total > 0 ? (100 * delta[7]) / total : null,
      hostRamTotalBytes: memory("MemTotal"),
      hostRamAvailableBytes: memory("MemAvailable"),
      ifaceRxBytes: Number(readFileSync(join(nic, "rx_bytes"), "utf8")),
      ifaceTxBytes: Number(readFileSync(join(nic, "tx_bytes"), "utf8")),
      xrayTcpEstablished: sockets ? sockets.split("\n").length : 0,
    };
  };
}

export async function metricsMain(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      iface: { type: "string" },
      state: { type: "string", default: join(homedir(), ".anymodel-tunnel") },
      output: { type: "string" },
      "container-only": { type: "boolean", default: false },
      samples: { type: "string" },
    },
  });
  if (!values.output) throw Error("Supply --output FILE");
  if (
    !values["container-only"] &&
    (process.platform !== "linux" || process.getuid?.() !== 0)
  ) {
    throw Error("Host statistics require root on the Linux VPS");
  }
  const nic = join("/sys/class/net", values.iface ?? "", "statistics");
  if (
    !values["container-only"] &&
    (!values.iface ||
      !/^[A-Za-z0-9_.-]+$/.test(values.iface) ||
      !existsSync(nic))
  ) {
    throw Error("Supply the VPS network interface with --iface");
  }
  const state = resolve(values.state);
  const identity: unknown = JSON.parse(
    readFileSync(join(state, "identity.json"), "utf8"),
  );
  if (
    !isRecord(identity) ||
    (identity.mode !== "local" && identity.mode !== "server")
  ) {
    throw Error("Invalid deployment state");
  }
  const local = identity.mode === "local";
  const env = {
    ...process.env,
    ANYMODEL_CONFIG: join(state, "xray.json"),
    ANYMODEL_BIND: local ? "127.0.0.1" : "0.0.0.0",
    ANYMODEL_PORT: local ? "9443" : "443",
  };
  const compose = [
    "compose",
    "--env-file",
    "/dev/null",
    "-p",
    "anymodel-tunnel",
    "-f",
    join(projectRoot, "deploy/compose.yaml"),
  ];
  const command = (parameters: string[]) =>
    execFileSync("docker", parameters, {
      encoding: "utf8",
      env,
    }).trim();
  const vcpus = boundedInteger(
    command(["info", "--format", "{{.NCPU}}"]),
    "Docker vCPUs",
    1,
    4096,
  );
  const container = command([...compose, "ps", "-q", "xray"]);
  if (!container) throw Error("Xray is not running");
  const pid = Number(
    command(["inspect", "--format", "{{.State.Pid}}", container]),
  );
  const readHost = values["container-only"] ? undefined : hostSampler(pid, nic);
  const limit = values.samples
    ? boundedInteger(values.samples, "samples", 1, 86400)
    : Infinity;
  const log = openPrivateOutput(values.output);
  const child = spawn(
    "docker",
    [...compose, "stats", "--format", "json", "xray"],
    {
      env,
      shell: false,
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  const exited = new Promise((done) => {
    child.once("error", done);
    child.once("close", done);
  });
  let interrupted = false;
  const stop = () => {
    interrupted = true;
    child.kill();
  };
  process.once("SIGINT", stop);
  try {
    console.log("Collecting Compose metrics. Ctrl+C to stop.");
    let tick = performance.now();
    let count = 0;
    for await (const line of createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    })) {
      const data = stripVTControlCharacters(line).trim();
      if (!data.startsWith("{")) continue;
      const stats = containerStats(data);
      const timestamp = performance.now();
      writeSync(
        log,
        JSON.stringify({
          utc: new Date().toISOString(),
          sampleSeconds: (timestamp - tick) / 1000,
          vcpus,
          containerCpuOneCorePct: stats.cpu,
          containerCpuHostPct: stats.cpu / vcpus,
          containerRamBytes: stats.ram,
          ...readHost?.(),
        }) + "\n",
      );
      tick = timestamp;
      if (++count >= limit) break;
    }
    if (!interrupted && count < limit)
      throw Error("Compose stats stream stopped");
  } finally {
    process.removeListener("SIGINT", stop);
    child.kill();
    await exited;
    closeSync(log);
  }
}

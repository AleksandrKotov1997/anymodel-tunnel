import { closeSync, readFileSync, writeSync } from "node:fs";
import { parseArgs } from "node:util";
import { openPrivateOutput } from "../model/index.ts";

export function clientMain(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      profile: { type: "string" },
      output: { type: "string" },
      "server-address": { type: "string" },
      listen: { type: "string", default: "127.0.0.1" },
    },
  });
  if (!values.profile || !values.output)
    throw Error("Supply --profile FILE and --output FILE");
  if (values.listen !== "127.0.0.1" && values.listen !== "0.0.0.0")
    throw Error("Invalid SOCKS bind");
  const uri = new URL(readFileSync(values.profile, "utf8").trim());
  const options = uri.searchParams;
  const required = {
    type: "tcp",
    security: "reality",
    encryption: "none",
    flow: "xtls-rprx-vision",
    fp: "chrome",
  };
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (
    uri.protocol !== "vless:" ||
    !uri.hostname ||
    !uri.port ||
    uri.password ||
    !uuid.test(uri.username) ||
    Object.entries(required).some(
      ([key, value]) =>
        options.getAll(key).length !== 1 || options.get(key) !== value,
    )
  ) {
    throw Error("Expected a VLESS TCP REALITY Vision profile");
  }
  function parameter(key: string, pattern: RegExp) {
    const value = options.get(key);
    if (!value || options.getAll(key).length !== 1 || !pattern.test(value))
      throw Error("Invalid profile field " + key);
    return value;
  }
  const config = {
    log: { access: "none", loglevel: "warning" },
    inbounds: [
      {
        listen: values.listen,
        port: 1080,
        protocol: "socks",
        settings: { auth: "noauth", udp: false },
      },
    ],
    outbounds: [
      {
        protocol: "vless",
        settings: {
          vnext: [
            {
              address: values["server-address"] ?? uri.hostname,
              port: Number(uri.port),
              users: [
                {
                  id: uri.username,
                  encryption: "none",
                  flow: "xtls-rprx-vision",
                },
              ],
            },
          ],
        },
        streamSettings: {
          network: "raw",
          security: "reality",
          realitySettings: {
            fingerprint: "chrome",
            serverName: parameter("sni", /^[A-Za-z0-9.-]+$/),
            password: parameter("pbk", /^[A-Za-z0-9_-]{43}$/),
            shortId: parameter("sid", /^[a-f0-9]{16}$/),
            spiderX: options.get("spx") ?? "/",
          },
        },
        mux: { enabled: false },
      },
    ],
  };
  const file = openPrivateOutput(values.output);
  try {
    writeSync(file, JSON.stringify(config, null, 2) + "\n");
  } finally {
    closeSync(file);
  }
}

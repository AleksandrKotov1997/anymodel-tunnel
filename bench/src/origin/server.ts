import { randomBytes, createHash, randomUUID } from "node:crypto";
import { closeSync, readFileSync, writeSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import { setTimeout } from "node:timers/promises";
import { parseArgs } from "node:util";
import {
  boundedInteger,
  objectSizes,
  openPrivateOutput,
  sustainedRates,
} from "../model/index.ts";

interface FieldCheck {
  token: string;
  expectedPeer: string;
  log: number;
}

function peerList(entries: string[]): BlockList {
  const list = new BlockList();
  for (const entry of entries) {
    const [address, prefix] = entry.split("/");
    const version = isIP(address);
    if (!version || entry.split("/").length > 2)
      throw Error("Invalid allowed address");
    const family = version === 4 ? "ipv4" : "ipv6";
    if (prefix === undefined) list.addAddress(address, family);
    else
      list.addSubnet(
        address,
        boundedInteger(prefix, "prefix", 0, version === 4 ? 32 : 128),
        family,
      );
  }
  return list;
}

function send(
  response: ServerResponse,
  payload: Buffer,
  type: string,
  rate = 0,
): void {
  response.writeHead(200, {
    "Content-Type": type,
    "Content-Length": payload.length,
    "Cache-Control": "no-store",
    Connection: "close",
  });
  if (!rate) {
    response.end(payload);
    return;
  }
  async function pacedResponse() {
    const start = performance.now();
    for (
      let offset = 0;
      offset < payload.length && !response.destroyed;
      offset += 4096
    ) {
      const end = Math.min(offset + 4096, payload.length);
      await setTimeout(
        Math.max(0, start + (end * 1000) / rate - performance.now()),
      );
      if (!response.destroyed) response.write(payload.subarray(offset, end));
    }
    if (!response.destroyed) response.end();
  }
  void pacedResponse().catch(() => response.destroy());
}

function handler(allow: BlockList, fieldCheck: FieldCheck | undefined) {
  const objects = new Map(
    objectSizes.map((size) => {
      const bytes = randomBytes(size * 1024);
      return [
        size,
        { bytes, sha256: createHash("sha256").update(bytes).digest("hex") },
      ];
    }),
  );
  const manifest = Buffer.from(
    JSON.stringify(
      Object.fromEntries(
        Array.from(objects, ([size, data]) => [
          size,
          { bytes: data.bytes.length, sha256: data.sha256 },
        ]),
      ),
    ),
  );
  const control = objects.get(256);
  if (!control) throw Error("Missing control object");

  return (request: IncomingMessage, response: ServerResponse) => {
    const method = request.method;
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://origin.invalid");
    } catch {
      response.writeHead(400).end();
      return;
    }
    const peer = request.socket.remoteAddress?.replace(/^::ffff:/, "") ?? "";
    if (method !== "GET" || !isIP(peer)) {
      response.writeHead(404).end();
      return;
    }

    if (
      fieldCheck &&
      !url.search &&
      url.pathname.startsWith("/check/" + fieldCheck.token + "/")
    ) {
      const markedRoute = url.pathname.split("/").at(-1);
      if (
        url.pathname === "/check/" + fieldCheck.token + "/" + markedRoute &&
        (markedRoute === "direct" || markedRoute === "tunnel")
      ) {
        const requestId = randomUUID();
        const observedRoute =
          peer === fieldCheck.expectedPeer ? "vps" : "other";
        response.once("finish", () =>
          writeSync(
            fieldCheck.log,
            JSON.stringify({
              utc: new Date().toISOString(),
              requestId,
              markedRoute,
              observedRoute,
              bytes: control.bytes.length,
              sha256: control.sha256,
            }) + "\n",
          ),
        );
        response.setHeader(
          "Content-Disposition",
          'attachment; filename="anymodel-control.bin"',
        );
        response.setHeader("X-AnyModel-Request-ID", requestId);
        response.setHeader("X-Content-SHA256", control.sha256);
        send(response, control.bytes, "application/octet-stream");
        return;
      }
    }

    if (!allow.check(peer, isIP(peer) === 4 ? "ipv4" : "ipv6")) {
      response.writeHead(404).end();
      return;
    }
    if (url.pathname === "/peer" && !url.search) {
      send(response, Buffer.from(peer), "text/plain");
      return;
    }
    if (url.pathname === "/manifest" && !url.search) {
      send(response, manifest, "application/json");
      return;
    }
    const sizeText = /^\/blob\/(\d+)$/.exec(url.pathname)?.[1];
    const size = Number(sizeText);
    const object = objects.get(size);
    const rate = Number(url.searchParams.get("rate") ?? "0");
    const validQuery =
      !url.search ||
      (size === 256 &&
        url.searchParams.size === 1 &&
        sustainedRates.includes(rate));
    if (!object || !validQuery) {
      response.writeHead(404).end();
      return;
    }
    send(response, object.bytes, "application/octet-stream", rate);
  };
}

export async function originMain(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      bind: { type: "string", default: "127.0.0.1" },
      port: { type: "string", default: "18443" },
      allow: { type: "string", multiple: true, default: [] },
      cert: { type: "string" },
      key: { type: "string" },
      "check-secret-file": { type: "string" },
      "expected-vps-peer": { type: "string" },
      "audit-file": { type: "string" },
    },
  });
  const { bind, allow, cert, key } = values;
  const port = boundedInteger(values.port, "port", 1024, 65535);
  if (!isIP(bind) || Boolean(cert) !== Boolean(key))
    throw Error("Invalid bind address or TLS files");
  const secret = values["check-secret-file"];
  const peer = values["expected-vps-peer"];
  const audit = values["audit-file"];
  let fieldCheck: FieldCheck | undefined;
  if (secret || peer || audit) {
    if (!secret || !peer || !isIP(peer) || !audit)
      throw Error("Supply all three field-check options");
    const token = readFileSync(secret, "utf8").trim();
    if (!/^[a-f0-9]{32,64}$/.test(token))
      throw Error("Use a random hexadecimal check token");
    fieldCheck = { token, expectedPeer: peer, log: openPrivateOutput(audit) };
  }
  if (!allow.length && !fieldCheck)
    throw Error("Supply --allow or configure the field check");
  try {
    const handle = handler(peerList(allow), fieldCheck);
    const server =
      cert && key
        ? https.createServer(
            {
              cert: readFileSync(cert),
              key: readFileSync(key),
              minVersion: "TLSv1.2",
            },
            handle,
          )
        : createServer(handle);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, bind, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    if (fieldCheck) {
      const auditLog = fieldCheck.log;
      server.once("close", () => closeSync(auditLog));
    }
    console.log("Origin listening on %s:%s", bind, port);
  } catch (error) {
    if (fieldCheck) closeSync(fieldCheck.log);
    throw error;
  }
}

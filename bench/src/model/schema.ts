export const objectSizes = [4, 8, 16, 32, 64, 256, 8192];
export const sustainedRates = [32768, 16384, 8192];
export const benchmarkLevels = [1, 4, 8, 16, 32, 64];
export type Mode = "direct" | "proxy";
export type FailurePhase =
  | "dns"
  | "tcp"
  | "socks"
  | "tls"
  | "request"
  | "response";

export interface ObjectEntry {
  bytes: number;
  sha256: string;
}

export interface TransferSample {
  bytes: number;
  status: number;
  exit: number;
  ttfbMs: number;
  totalMs: number;
  failure: FailurePhase | null;
}

export interface WindowSample {
  kind: "window";
  mode: Mode;
  workers: number;
  repeat: number;
  startUtc: string;
  endUtc: string;
  seconds: number;
  bulk: TransferSample[];
  short: TransferSample[];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw Error("Invalid numeric field " + label);
  }
  return value;
}

export function boundedInteger(
  input: string,
  label: string,
  min: number,
  max: number,
): number {
  const number = Number(input);
  if (
    !/^\d+$/.test(input) ||
    !Number.isSafeInteger(number) ||
    number < min ||
    number > max
  ) {
    throw Error(label + " must be an integer between " + min + " and " + max);
  }
  return number;
}

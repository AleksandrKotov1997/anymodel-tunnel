import { openSync, realpathSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));

export function openPrivateOutput(path: string): number {
  const file = resolve(path);
  const parent = realpathSync(dirname(file));
  const location = relative(projectRoot, parent);
  if (location !== ".." && !location.startsWith(".." + sep)) {
    throw Error("Working files must be outside the repository");
  }
  return openSync(file, "wx", 0o600);
}

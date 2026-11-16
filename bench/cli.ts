import { clientMain } from "./src/client/index.ts";
import { metricsMain } from "./src/metrics/index.ts";
import { originMain } from "./src/origin/index.ts";
import { resultsMain } from "./src/results/index.ts";
import { runMain } from "./src/run/index.ts";

const commands = new Map<string, (args: string[]) => void | Promise<void>>([
  ["client", clientMain],
  ["metrics", metricsMain],
  ["origin", originMain],
  ["results", resultsMain],
  ["run", runMain],
]);
const [command, ...args] = process.argv.slice(2);
try {
  const main = commands.get(command);
  if (!main) throw Error("Select client, metrics, origin, results or run");
  await main(args);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

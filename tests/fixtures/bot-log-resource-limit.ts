import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WritableFileSystem } from "../../src/assets/writable-files.ts";
import { BotLog } from "../../src/botlib/log.ts";
import type { BotLogIoResult } from "../../src/botlib/log.ts";
import { BotLibVars } from "../../src/botlib/libvars.ts";

const mode = process.argv[2];
if (mode !== "short" && mode !== "large" && mode !== "pending-close") throw new Error("Expected resource-limit fixture mode");
const directory = mkdtempSync(join(tmpdir(), "q3-bot-log-limit-"));
const owner = new WritableFileSystem({ homePath: directory, product: "baseq3", print: () => { throw new Error("Unexpected FS log diagnostic"); } });
const variables = new BotLibVars(), diagnostics: string[] = [];
variables.set("log", "1");
const logger = new BotLog({ variables, globals: { time: 0 }, openFile: path => owner.openBotLog(path),
  print: (_severity, text) => { diagnostics.push(text); return undefined; } });
const outputPath = join(owner.rootPath, "limit.log");
function limit(soft: string): void {
  const result = Bun.spawnSync(["prlimit", "--pid", String(process.pid), `--fsize=${soft}:unlimited`], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`prlimit failed: ${new TextDecoder().decode(result.stderr)}`);
}
const onFileLimit = () => undefined;
process.on("SIGXFSZ", onFileLimit);
try {
  logger.open("limit.log");
  const borrowed = logger.filePointer();
  limit(mode === "large" ? "4100" : "5");
  try {
    if (mode === "pending-close") borrowed?.write("ABCDEFGHIJ");
    else logger.write(mode === "large" ? "Q".repeat(12288) : "ABCDEFGHIJ");
  } finally { if (mode !== "pending-close") limit("unlimited"); }
  if (mode === "pending-close") {
    let result: BotLogIoResult;
    try { result = logger.close(); } finally { limit("unlimited"); }
    console.log(JSON.stringify({ kind: result.kind, bytes: readFileSync(outputPath).toString("hex"), diagnostics }));
  } else {
    const afterError = readFileSync(outputPath);
    logger.write("XY"); const afterRecovery = readFileSync(outputPath);
    const result = logger.close();
    console.log(JSON.stringify({ kind: result.kind, afterError: afterError.toString("hex"), afterRecovery: afterRecovery.toString("hex"), diagnostics }));
  }
} finally {
  limit("unlimited");
  logger.shutdown(); owner.closeAll();
  process.off("SIGXFSZ", onFileLimit);
  rmSync(directory, { recursive: true, force: true });
}

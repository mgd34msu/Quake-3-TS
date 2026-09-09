import { expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

test("analytic CPU benchmark does not require retail data", async () => {
  const missing = join(tmpdir(), `q3-no-retail-${crypto.randomUUID()}`);
  const child = Bun.spawn({ cmd: [process.execPath, "tools/cpu-benchmark.ts", "--case", "opaque", "--data", missing,
    "--width", "2", "--height", "2", "--warmup", "10", "--frames", "20"], stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(exitCode).toBe(0);
  expect(stderr).toBe("");
  const parsed: unknown = JSON.parse(stdout);
  if (!isRecord(parsed)) throw new Error("Benchmark output must be an object");
  expect(parsed["name"]).toBe("opaque");
  expect(parsed["inputChecksumScope"]).toBe("successful backend-request inputs");
  expect(parsed["measuredFrames"]).toBe(20);
  expect(isRecord(parsed["rendererMilliseconds"])).toBeTrue();
  expect(parsed["timingScope"]).toBe("user/system/wall cover the instrumented full pass; renderer covers successful backend calls and excludes observer snapshots, hashing, and frontend work");
});

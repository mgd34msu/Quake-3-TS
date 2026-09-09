import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Product } from "../src/shared/definitions.ts";
import { frameAudioTranscript } from "./frame-audio-fixture.ts";

const products: readonly Product[] = ["baseq3", "missionpack"];
const nativeHash = "88a3b4b5e040892ba865a3473f6c966c68bc915496c5ecd3e93fa853fa224cfa";
const oracleRoot = process.env["Q3_FRAME_AUDIO_ORACLE"];

// Oracle: unchanged cg_view.c at dbe4ddb10315479fc00086f08e25d968b4b43c49, GCC -m32 -O0 -fwrapv; not an actual QVM, native unsafe read withheld.
describe("cgame frame-audio native trace", () => {
  for (const product of products) {
    test(`${product} reproduces the pinned transcript`, () => {
      const transcript = frameAudioTranscript(product);
      expect(transcript.endsWith("\n")).toBe(true);
      expect(transcript.split("\n").length - 1).toBe(107);
      expect(new Bun.CryptoHasher("sha256").update(transcript).digest("hex")).toBe(nativeHash);
    });

    test.skipIf(oracleRoot === undefined)(`${product} matches an explicitly supplied native oracle`, async () => {
      if (oracleRoot === undefined) throw new Error("Q3_FRAME_AUDIO_ORACLE unexpectedly missing");
      const executable = join(oracleRoot, product);
      const child = Bun.spawn([executable], { stdout: "pipe", stderr: "pipe" });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (exitCode !== 0) {
        throw new Error(`Native ${product} oracle ${executable} exited ${exitCode}; stderr: ${stderr.trim() || "<empty>"}`);
      }
      const expected = frameAudioTranscript(product);
      if (stdout !== expected) {
        const actualHash = new Bun.CryptoHasher("sha256").update(stdout).digest("hex");
        const expectedHash = new Bun.CryptoHasher("sha256").update(expected).digest("hex");
        throw new Error(`Native ${product} transcript mismatch: expected ${expectedHash}, got ${actualHash}; stderr: ${stderr.trim() || "<empty>"}`);
      }
    });
  }
});

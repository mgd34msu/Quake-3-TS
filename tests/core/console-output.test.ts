import { expect, test } from "bun:test";
import { ConsoleOutput } from "../../src/core/console-output.ts";

test("normal output preserves source bytes, NUL and Linux MAXPRINTMSG truncation", () => {
  const normal: string[] = [], output = new ConsoleOutput(text => { normal.push(text); });
  output.print("100% é\0ignored"); output.print("x".repeat(5000));
  expect(normal).toEqual(["100% é", "x".repeat(4095)]);
  expect(() => output.print("€")).toThrow("source bytes");
});

test("source redirect accumulation, exact capacity and single-print truncation", async () => {
  const normal: string[] = [], flushed: string[] = [], output = new ConsoleOutput(text => { normal.push(text); });
  await output.redirect(1008, text => { flushed.push(text); }, async () => {
    output.print("a".repeat(600)); output.print("b".repeat(500));
  });
  expect(flushed).toEqual(["a".repeat(600), "b".repeat(500)]);
  flushed.length = 0;
  await output.redirect(1008, text => { flushed.push(text); }, async () => { output.print("x".repeat(5000)); });
  expect(flushed).toEqual(["", "x".repeat(1007)]);
  flushed.length = 0;
  await output.redirect(1008, text => { flushed.push(text); }, async () => { output.print("z".repeat(1007)); });
  expect(flushed).toEqual(["z".repeat(1007)]); expect(normal).toEqual([]);
});

test("awaited redirect owns intervening engine output and always flushes even empty", async () => {
  const trace: string[] = [], gate = Promise.withResolvers<void>();
  const output = new ConsoleOutput(text => { trace.push(`normal:${text}`); });
  const pending = output.redirect(1008, text => { trace.push(`flush:${text}`); }, async () => {
    output.print("before"); await gate.promise; output.print("after");
  });
  output.print("during"); expect(output.redirecting).toBe(true); expect(trace).toEqual([]);
  gate.resolve(); await pending;
  expect(trace).toEqual(["flush:beforeduringafter"]); expect(output.redirecting).toBe(false);
  await output.redirect(1008, text => { trace.push(`flush:${text}`); }, async () => undefined);
  output.print("normal"); expect(trace.slice(1)).toEqual(["flush:", "normal:normal"]);
});

test("operation and flush aborts preserve the reached source redirect state", async () => {
  const normal: string[] = [], flushed: string[] = [], output = new ConsoleOutput(text => { normal.push(text); });
  const commandError = new Error("command failed"), flushError = new Error("send failed");
  await expect(output.redirect(1008, text => { flushed.push(text); }, async () => {
    output.print("before failure"); throw commandError;
  })).rejects.toBe(commandError);
  expect(flushed).toEqual([]); expect(output.redirecting).toBe(true);
  output.endRedirect(); expect(flushed).toEqual(["before failure"]);
  await expect(output.redirect(1008, () => { throw flushError; }, async () => undefined)).rejects.toBe(flushError);
  expect(output.redirecting).toBe(true);
  output.beginRedirect(1008, text => { flushed.push(text); output.print("recursive"); });
  output.endRedirect(); expect(output.redirecting).toBe(false);
  expect(flushed).toEqual(["before failure", ""]);
  output.print("recovered"); expect(normal).toEqual(["recovered"]);
});

test("nested redirects replace globals instead of restoring the outer buffer", async () => {
  const trace: string[] = [], output = new ConsoleOutput(text => { trace.push(`normal:${text}`); });
  await output.redirect(16, text => { trace.push(`outer:${text}`); }, async () => {
    output.print("discarded");
    await output.redirect(16, text => { trace.push(`inner:${text}`); }, async () => { output.print("inner"); });
    output.print("after");
  });
  expect(trace).toEqual(["inner:inner", "normal:after"]);
});

test("overflow flush rereads the buffer and callback globals after reentrant replacement", () => {
  const trace: string[] = [], output = new ConsoleOutput(text => { trace.push(`normal:${text}`); });
  output.beginRedirect(4, text => {
    trace.push(`first:${text}`);
    output.beginRedirect(8, next => { trace.push(`next:${next}`); });
    output.print("discard");
  });
  output.print("abc"); output.print("d"); output.endRedirect();
  expect(trace).toEqual(["first:abc", "next:d"]);
});

test("end callback replacement is cleared only after the callback returns", () => {
  const trace: string[] = [], output = new ConsoleOutput(text => { trace.push(text); });
  output.beginRedirect(8, text => { trace.push(text); output.beginRedirect(8, nested => { trace.push(nested); }); });
  output.print("one"); output.endRedirect(); expect(output.redirecting).toBe(false);
  output.print("two"); expect(trace).toEqual(["one", "two"]);
});

test("redirect capacity guards and independent engine sinks", async () => {
  const first: string[] = [], second: string[] = [];
  const a = new ConsoleOutput(text => { first.push(text); }), b = new ConsoleOutput(text => { second.push(text); });
  for (const size of [-1, 1.5, NaN, Infinity, 2147483648]) {
    await expect(a.redirect(size, () => undefined, async () => undefined)).rejects.toThrow(RangeError);
  }
  a.beginRedirect(0, () => undefined); expect(a.redirecting).toBe(false);
  a.beginRedirect(1, null); expect(a.redirecting).toBe(false);
  await a.redirect(1, text => { first.push(`redirect:${text}`); }, async () => { a.print("x"); b.print("b"); });
  expect(first).toEqual(["redirect:", "redirect:"]); expect(second).toEqual(["b"]);
});

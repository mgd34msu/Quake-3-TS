import { describe, expect, spyOn, test } from "bun:test";
import { finishCalls, runCalls, waitForCall } from "../src/core/call-steps.ts";
import type { CallSteps } from "../src/core/call-steps.ts";

describe("shared call steps", () => {
  test("both runners return immediate results without a Promise", () => {
    const trace: string[] = [];
    function* body(): CallSteps<number> { trace.push("body"); return 17; }
    const direct = body();
    expect(trace).toEqual([]);
    expect(finishCalls(direct)).toBe(17);
    expect(runCalls(body())).toBe(17);
    expect(trace).toEqual(["body", "body"]);
  });

  test("direct rejection neither starts the wait nor invents finally cleanup", () => {
    const trace: string[] = [];
    function* body(): CallSteps {
      try {
        trace.push("before");
        yield* waitForCall(async () => { trace.push("wait"); });
        trace.push("after");
      } finally { trace.push("finally"); }
    }
    expect(() => finishCalls(body())).toThrow("Cannot synchronously finish an asynchronous call");
    expect(trace).toEqual(["before"]);
  });

  test("awaited results resume the body before starting its next wait", async () => {
    const first = Promise.withResolvers<number>(), second = Promise.withResolvers<number>();
    const secondStarted = Promise.withResolvers<undefined>(), trace: string[] = [];
    function* body(): CallSteps<number> {
      const left = yield* waitForCall(() => { trace.push("first"); return first.promise; });
      trace.push(`between:${left}`);
      const right = yield* waitForCall(() => {
        trace.push("second"); secondStarted.resolve(undefined); return second.promise;
      });
      trace.push(`after:${right}`);
      return left + right;
    }
    const result = runCalls(body());
    expect(result).toBeInstanceOf(Promise);
    expect(trace).toEqual(["first"]);
    first.resolve(19);
    await secondStarted.promise;
    expect(trace).toEqual(["first", "between:19", "second"]);
    second.resolve(23);
    expect(await result).toBe(42);
    expect(trace).toEqual(["first", "between:19", "second", "after:23"]);
  });

  test("a rejected wait enters the source catch once and can reach another wait", async () => {
    const failure = new Error("child rejected"), trace: string[] = [];
    function* body(): CallSteps<number> {
      try {
        yield* waitForCall(() => Promise.reject(failure));
        trace.push("unreached");
      } catch (error) {
        expect(error).toBe(failure);
        trace.push("caught");
        return yield* waitForCall(() => { trace.push("recovery"); return Promise.resolve(29); });
      }
      return -1;
    }
    const steps = body(), thrown = spyOn(steps, "throw");
    expect(await runCalls(steps)).toBe(29);
    expect(thrown).toHaveBeenCalledTimes(1);
    expect(trace).toEqual(["caught", "recovery"]);
  });

  test("a wait function's synchronous failure enters the source catch", async () => {
    const failure = new Error("child threw");
    function* body(): CallSteps<number> {
      try { yield () => { throw failure; }; }
      catch (error) { expect(error).toBe(failure); return 31; }
      return -1;
    }
    expect(await runCalls(body())).toBe(31);
  });

  test("a resumed body failure is not injected back into the generator", async () => {
    const failure = new Error("body threw");
    function* body(): CallSteps {
      yield* waitForCall(() => Promise.resolve(undefined));
      throw failure;
    }
    const steps = body(), thrown = spyOn(steps, "throw");
    await expect(runCalls(steps)).rejects.toBe(failure);
    expect(thrown).not.toHaveBeenCalled();
  });

  test("a source catch failure is not injected into the generator a second time", async () => {
    const childFailure = new Error("child rejected"), bodyFailure = new Error("catch threw");
    function* body(): CallSteps {
      try { yield* waitForCall(() => Promise.reject(childFailure)); }
      catch (error) { expect(error).toBe(childFailure); throw bodyFailure; }
    }
    const steps = body(), thrown = spyOn(steps, "throw");
    await expect(runCalls(steps)).rejects.toBe(bodyFailure);
    expect(thrown).toHaveBeenCalledTimes(1);
  });

  test("a body failure before its first wait remains synchronous", () => {
    const failure = new Error("initial body threw");
    function* body(): CallSteps { throw failure; }
    const steps = body(), thrown = spyOn(steps, "throw");
    expect(() => runCalls(steps)).toThrow(failure);
    expect(thrown).not.toHaveBeenCalled();
    expect(() => finishCalls(body())).toThrow(failure);
  });

  test("an undefined awaited value still completes its call", async () => {
    expect(await runCalls(waitForCall(() => Promise.resolve(undefined)))).toBeUndefined();
  });
});

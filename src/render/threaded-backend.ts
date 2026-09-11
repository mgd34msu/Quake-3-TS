// R_IssueRenderCommands/R_SyncRenderThread and GLimp renderer sleep/wake ownership.
// Original renderer copyright (C) 1999-2005 Id Software, Inc.
// SPDX-License-Identifier: GPL-2.0-or-later
import { MessageChannel, MessagePort, receiveMessageOnPort, Worker } from "node:worker_threads";
import { CommonError } from "../core/common-error.ts";

export interface RenderThreadHost {
  request(payload: unknown): unknown;
  completed(payload: unknown): undefined;
}

export interface RenderThreadRuntime {
  readonly description: unknown;
  dispatch(payload: unknown): unknown;
  close(): undefined;
}

type Failure =
  | { readonly kind: "common"; readonly code: CommonError["code"]; readonly message: string }
  | { readonly kind: "error"; readonly name: string; readonly message: string }
  | { readonly kind: "host"; readonly token: number };
type Response = { readonly kind: "success"; readonly payload: unknown }
  | { readonly kind: "failure"; readonly failure: Failure };
type Message =
  | { readonly kind: "request" | "reply" | "complete"; readonly sequence: number; readonly response: Response }
  | { readonly kind: "dispatch" | "initialize"; readonly sequence: number; readonly payload: unknown }
  | { readonly kind: "close"; readonly sequence: number };

function record(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null;
}

function sequence(input: unknown): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input <= 0)
    throw new Error("Invalid render thread message sequence");
  return input;
}

function decodeFailure(input: unknown): Failure {
  if (!record(input)) throw new Error("Invalid render thread failure");
  if (input["kind"] === "host") return { kind: "host", token: sequence(input["token"]) };
  const message = input["message"];
  if (typeof message !== "string") throw new Error("Invalid render thread error message");
  if (input["kind"] === "error" && typeof input["name"] === "string")
    return { kind: "error", name: input["name"], message };
  const code = input["code"];
  if (input["kind"] === "common" && (code === "server-disconnect" || code === "drop" || code === "disconnect"
    || code === "need-cd" || code === "fatal")) return { kind: "common", code, message };
  throw new Error("Invalid render thread error kind");
}

function decodeResponse(input: unknown): Response {
  if (!record(input)) throw new Error("Invalid render thread response");
  if (input["kind"] === "success") return { kind: "success", payload: input["payload"] };
  if (input["kind"] === "failure") return { kind: "failure", failure: decodeFailure(input["failure"]) };
  throw new Error("Invalid render thread response kind");
}

function decodeMessage(input: unknown): Message {
  if (!record(input)) throw new Error("Invalid render thread message");
  const kind = input["kind"], number = sequence(input["sequence"]);
  if (kind === "close") return { kind, sequence: number };
  if (kind === "dispatch" || kind === "initialize") return { kind, sequence: number, payload: input["payload"] };
  if (kind === "request" || kind === "reply" || kind === "complete")
    return { kind, sequence: number, response: decodeResponse(input["response"]) };
  throw new Error("Invalid render thread message kind");
}

class HostFailure extends Error {
  constructor(readonly token: number) { super("Renderer host callback failed"); }
}

function failure(error: unknown): Failure {
  if (error instanceof HostFailure) return { kind: "host", token: error.token };
  if (error instanceof CommonError) return { kind: "common", code: error.code, message: error.message };
  if (error instanceof Error) return { kind: "error", name: error.name, message: error.message };
  return { kind: "error", name: "Error", message: String(error) };
}

function restoreFailure(input: Failure): Error {
  switch (input.kind) {
    case "host": return new HostFailure(input.token);
    case "common": return new CommonError(input.code, input.message);
    case "error": {
      const error = input.name === "RangeError" ? new RangeError(input.message)
        : input.name === "TypeError" ? new TypeError(input.message) : new Error(input.message);
      error.name = input.name;
      return error;
    }
  }
}

function send(port: MessagePort, signal: Int32Array<SharedArrayBuffer>, message: Message): void {
  port.postMessage(message);
  Atomics.add(signal, 0, 1);
  Atomics.notify(signal, 0);
}

function receive(port: MessagePort): Message | null {
  const result: unknown = receiveMessageOnPort(port);
  if (result === undefined) return null;
  if (!record(result) || !("message" in result)) throw new Error("Invalid render thread port result");
  return decodeMessage(result["message"]);
}

interface Pending {
  readonly sequence: number;
  readonly publish: boolean;
  response: Response | null;
}

/** One backend consumes a buffer while its frontend prepares the other buffer. */
export class ThreadedBackend {
  private readonly channel = new MessageChannel();
  private readonly signal = new Int32Array(new SharedArrayBuffer(8));
  private readonly hostFailures = new Map<number, unknown>();
  private nextSequence = 1;
  private nextHostFailure = 1;
  private pending: Pending | null = null;
  private fault: { readonly error: unknown } | null = null;
  private observedFault: { readonly error: unknown } | null = null;
  private inCallback = false;
  private closed = false;
  private closing = false;
  private initialDescription: unknown;

  private constructor(private readonly worker: Worker, private readonly host: RenderThreadHost,
    private readonly timeoutMilliseconds: number) {
    this.channel.port1.on("message", (input: unknown) => {
      try { this.accept(decodeMessage(input)); }
      catch (error: unknown) { this.fault ??= { error }; }
    });
    worker.on("error", error => { this.fault ??= { error }; });
    worker.on("exit", code => {
      if (!this.closed) this.fault ??= { error: new Error(`Render thread exited before shutdown (${code})`) };
    });
  }

  static async open(initialization: unknown, host: RenderThreadHost, timeoutMilliseconds = 30_000): Promise<ThreadedBackend> {
    if (!Number.isFinite(timeoutMilliseconds) || timeoutMilliseconds <= 0) throw new RangeError("Invalid render thread timeout");
    const worker = new Worker(new URL("./threaded-backend-worker.ts", import.meta.url));
    const backend = new ThreadedBackend(worker, host, timeoutMilliseconds);
    worker.postMessage({ port: backend.channel.port2, signal: backend.signal }, [backend.channel.port2]);
    backend.begin("initialize", initialization, false);
    try {
      // Yield during startup so loader errors are delivered without waiting for the timeout.
      const deadline = performance.now() + timeoutMilliseconds;
      while (backend.pending?.response === null && backend.fault === null && performance.now() < deadline) {
        backend.drain();
        if (backend.pending?.response === null) await Bun.sleep(1);
      }
      backend.initialDescription = backend.synchronize();
      return backend;
    } catch (error: unknown) {
      try { backend.close(); }
      catch { /* Preserve startup failure; an unacknowledged context remains borrowed. */ }
      throw error;
    }
  }

  get active(): boolean { return Atomics.load(this.signal, 1) !== 0; }
  get settled(): boolean { return this.closed || this.pending === null || this.pending.response !== null; }
  get retired(): boolean { return this.closed; }
  get description(): unknown { return this.initialDescription; }

  /** R_IssueRenderCommands waits for the previous buffer, then wakes this buffer. */
  issue(payload: unknown): void {
    this.synchronize();
    this.begin("dispatch", payload, true);
  }

  /** Synchronous source calls own the backend until their reply is published. */
  call(payload: unknown): unknown {
    this.synchronize();
    this.begin("dispatch", payload, false);
    return this.synchronize();
  }

  /** Screenshot readback can query the suspended backend at its reached callback. */
  callbackCall(payload: unknown): unknown {
    if (!this.inCallback) return this.call(payload);
    const suspended = this.pending;
    this.pending = null;
    this.inCallback = false;
    try { return this.call(payload); }
    finally { this.pending = suspended; this.inCallback = true; }
  }

  synchronize(): unknown {
    try {
      if (this.inCallback) throw new Error("Reentrant renderer operation during a render thread host callback");
      if (this.closed) throw new Error("Render thread is closed");
      const pending = this.pending;
      if (pending === null) { this.assertHealthy(); return undefined; }
      const deadline = performance.now() + this.timeoutMilliseconds;
      while (pending.response === null) {
        const wake = Atomics.load(this.signal, 0);
        this.drain();
        this.assertHealthy();
        if (pending.response !== null) break;
        if (performance.now() >= deadline) {
          const error = new Error("Render thread did not complete its issued buffer");
          this.fault = { error };
          throw error;
        }
        Atomics.wait(this.signal, 0, wake, Math.min(10, Math.max(0, deadline - performance.now())));
      }
      this.pending = null;
      const response = pending.response;
      if (response.kind === "success") { this.assertHealthy(); return response.payload; }
      const error = response.failure.kind === "host" && this.hostFailures.has(response.failure.token)
        ? this.hostFailures.get(response.failure.token) : restoreFailure(response.failure);
      this.fault ??= { error };
      throw error;
    } catch (error: unknown) {
      if (this.fault !== null && this.fault.error === error) this.observedFault = this.fault;
      throw error;
    }
  }

  /** Common error recovery may retire an already-reported failure, never resume it. */
  retireAfterFailure(): boolean {
    if (this.fault === null || this.observedFault !== this.fault) return false;
    this.fault = null;
    this.observedFault = null;
    this.close();
    return true;
  }

  /** Final retirement remains available after a failed command; commands never replay. */
  close(): undefined {
    if (this.closed) return;
    if (this.inCallback) throw new Error("Reentrant render thread close");
    let first: { readonly error: unknown } | null = this.fault;
    this.fault = null;
    try { this.synchronize(); } catch (error: unknown) { first = { error }; }
    if (this.pending !== null && this.pending.response === null) {
      if (first !== null) throw first.error;
      throw new Error("Renderer cannot retire before its current operation completes");
    }
    if (this.closing) {
      this.retire();
      if (first !== null) throw first.error;
      return;
    }
    this.fault = null;
    const pending: Pending = { sequence: this.nextSequence++, response: null, publish: false };
    this.pending = pending;
    this.closing = true;
    try {
      send(this.channel.port1, this.signal, { kind: "close", sequence: pending.sequence });
      this.synchronize();
    } catch (error: unknown) { first ??= { error }; }
    finally { if (pending.response !== null) this.retire(); }
    if (first !== null) throw first.error;
  }

  private retire(): void {
    this.closed = true;
    this.pending = null;
    this.channel.port1.close();
    void this.worker.terminate();
    this.hostFailures.clear();
  }

  private assertHealthy(): void { if (this.fault !== null) throw this.fault.error; }

  private begin(kind: "initialize" | "dispatch", payload: unknown, publish: boolean): void {
    if (this.closed) throw new Error("Render thread is closed");
    if (this.inCallback) throw new Error("Reentrant renderer operation during a render thread host callback");
    this.assertHealthy();
    if (this.pending !== null) throw new Error("Renderer buffer is still owned by the backend");
    const sequence = this.nextSequence++;
    this.pending = { sequence, publish, response: null };
    try { send(this.channel.port1, this.signal, { kind, sequence, payload }); }
    catch (error: unknown) { this.pending = null; this.fault = { error }; this.observedFault = this.fault; throw error; }
  }

  private drain(): void {
    for (;;) {
      const message = receive(this.channel.port1);
      if (message === null) return;
      this.accept(message);
    }
  }

  private accept(message: Message): void {
    if (message.kind === "request") {
      if (message.response.kind !== "success") throw new Error("Worker request carried an error response");
      let response: Response;
      this.inCallback = true;
      try { response = { kind: "success", payload: this.host.request(message.response.payload) }; }
      catch (error: unknown) {
        const token = this.nextHostFailure++;
        this.hostFailures.set(token, error);
        response = { kind: "failure", failure: { kind: "host", token } };
      } finally { this.inCallback = false; }
      send(this.channel.port1, this.signal, { kind: "reply", sequence: message.sequence, response });
      return;
    }
    if (message.kind !== "complete") throw new Error("Unexpected renderer worker message");
    const pending = this.pending;
    if (pending === null || pending.sequence !== message.sequence || pending.response !== null)
      throw new Error("Renderer completed an unowned command buffer");
    pending.response = message.response;
    if (pending.publish && message.response.kind === "success") {
      try { this.host.completed(message.response.payload); }
      catch (error: unknown) { this.fault ??= { error }; throw error; }
    }
  }
}

/** Worker entry owns the concrete renderer runtime; only messages cross this boundary. */
export function serveRenderThread(port: MessagePort, signal: Int32Array<SharedArrayBuffer>,
  initialize: (payload: unknown, request: (payload: unknown) => unknown) => RenderThreadRuntime): void {
  let runtime: RenderThreadRuntime | null = null;
  let terminal: Failure | null = null;
  let nextRequest = 1;
  const request = (payload: unknown): unknown => {
    const sequence = nextRequest++;
    send(port, signal, { kind: "request", sequence, response: { kind: "success", payload } });
    for (;;) {
      const wake = Atomics.load(signal, 0), reply = receive(port);
      if (reply !== null) {
        if (reply.kind === "dispatch" && runtime !== null) {
          let response: Response;
          try { response = { kind: "success", payload: runtime.dispatch(reply.payload) }; }
          catch (error: unknown) { terminal = failure(error); response = { kind: "failure", failure: terminal }; }
          send(port, signal, { kind: "complete", sequence: reply.sequence, response });
          continue;
        }
        if (reply.kind !== "reply" || reply.sequence !== sequence) throw new Error("Unexpected render thread host reply");
        if (reply.response.kind === "failure") throw restoreFailure(reply.response.failure);
        return reply.response.payload;
      }
      Atomics.wait(signal, 0, wake, 10);
    }
  };
  port.on("message", (input: unknown) => {
    const message = decodeMessage(input);
    let response: Response;
    Atomics.store(signal, 1, 1);
    try {
      if (message.kind === "close") {
        runtime?.close();
        runtime = null;
        response = { kind: "success", payload: undefined };
      } else if (terminal !== null) response = { kind: "failure", failure: terminal };
      else if (message.kind === "initialize" && runtime === null) {
        runtime = initialize(message.payload, request);
        response = { kind: "success", payload: runtime.description };
      } else if (message.kind === "dispatch" && runtime !== null)
        response = { kind: "success", payload: runtime.dispatch(message.payload) };
      else throw new Error("Unexpected render thread command");
    } catch (error: unknown) {
      terminal = failure(error);
      response = { kind: "failure", failure: terminal };
    }
    Atomics.store(signal, 1, 0);
    send(port, signal, { kind: "complete", sequence: message.sequence, response });
    if (message.kind === "close") port.close();
  });
}

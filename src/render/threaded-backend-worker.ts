// Bun thread replacing the GLimp renderer sleep/wake loop from id Software.
// SPDX-License-Identifier: GPL-2.0-or-later
import { MessagePort, parentPort } from "node:worker_threads";
import { serveRenderThread } from "./threaded-backend.ts";
import { createThreadedBackendRuntime } from "./threaded-backend-proxy.ts";
import { createThreadedCommandRuntime } from "./threaded-command-runtime.ts";

if (parentPort === null) throw new Error("Render worker requires its owning frontend");
parentPort.once("message", (input: unknown) => {
  if (typeof input !== "object" || input === null || !("port" in input) || !(input.port instanceof MessagePort)
    || !("signal" in input) || !(input.signal instanceof Int32Array) || !(input.signal.buffer instanceof SharedArrayBuffer)
    || input.signal.length !== 2) throw new Error("Invalid render worker initialization channel");
  const signal = new Int32Array(input.signal.buffer, input.signal.byteOffset, input.signal.length);
  serveRenderThread(input.port, signal, (initialization, request) =>
    createThreadedBackendRuntime(initialization, request, createThreadedCommandRuntime));
  parentPort?.close();
});

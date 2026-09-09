/* SPDX-License-Identifier: GPL-2.0-or-later */
import { decodeTriangleWorkerMessage, triangleWorkerState } from "./triangle-execution.ts";
import { runWorkerTriangleRows } from "./triangle-kernel.ts";

let control: Int32Array<SharedArrayBuffer> | null = null;
let sampledResult: Float64Array<SharedArrayBuffer> | null = null;

function finish(state: number): void {
  if (control === null) return;
  Atomics.store(control, 0, state);
  Atomics.notify(control, 0);
}

function receive(event: MessageEvent<unknown>): void {
  const message = event.data;
  if (message === "close") {
    removeEventListener("message", receive);
    finish(triangleWorkerState.stopped);
    return;
  }
  if (typeof message === "object" && message !== null && "kind" in message && message.kind === "initialize"
    && "control" in message && message.control instanceof Int32Array && message.control.buffer instanceof SharedArrayBuffer
    && message.control.length === 3 && "sampled" in message && message.sampled instanceof Float64Array
    && message.sampled.buffer instanceof SharedArrayBuffer && message.sampled.length === 4 && control === null) {
    control = new Int32Array(message.control.buffer, message.control.byteOffset, message.control.length);
    sampledResult = new Float64Array(message.sampled.buffer, message.sampled.byteOffset, message.sampled.length);
    finish(triangleWorkerState.ready);
    return;
  }
  const status = control, output = sampledResult;
  if (status === null || output === null) return;
  try {
    const job = decodeTriangleWorkerMessage(message);
    if (job === null || job.generation !== Atomics.load(status, 2)
      || Atomics.load(status, 0) !== triangleWorkerState.running) {
      finish(triangleWorkerState.fault);
      return;
    }
    let index = 0, lastSample = -1;
    for (const setup of job.setups) {
      if (runWorkerTriangleRows(setup, job.framebuffer, job.sampled, job.firstY, job.lastY)) lastSample = index;
      index++;
    }
    output[0] = job.sampled.r; output[1] = job.sampled.g; output[2] = job.sampled.b; output[3] = job.sampled.a;
    Atomics.store(status, 1, lastSample);
    finish(triangleWorkerState.complete);
  } catch {
    finish(triangleWorkerState.fault);
  }
}

addEventListener("message", receive);

// Port of id Software's common.c Com_PushEvent/Com_GetEvent/Com_Milliseconds.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { Ipv4Address } from "../platform/network.ts";
import type { CommonEventMemory } from "./event-memory.ts";

export type CommonSystemEvent =
  | { readonly kind: "none"; readonly time: number }
  | { readonly kind: "key"; readonly time: number; readonly key: number; readonly down: boolean }
  | { readonly kind: "character"; readonly time: number; readonly character: number }
  | { readonly kind: "mouse"; readonly time: number; readonly dx: number; readonly dy: number }
  | { readonly kind: "joystick"; readonly time: number; readonly axis: number; readonly value: number }
  | { readonly kind: "console"; readonly time: number; readonly text: string }
  | { readonly kind: "packet"; readonly time: number; readonly from: Ipv4Address; readonly payload: Uint8Array };

export interface CommonEventSource { getEvent(): CommonSystemEvent }

export const MAX_COMMON_PUSHED_EVENTS = 1024;

/** Common clock reads retain real input for later source-ordered dispatch. */
export class CommonEvents {
  private readonly pushed: (CommonSystemEvent | null)[] = Array.from({ length: MAX_COMMON_PUSHED_EVENTS }, () => null);
  private read = 0;
  private write = 0;
  private count = 0;
  private warned = false;
  private frameTime = 0;

  constructor(private readonly input: CommonEventSource, private readonly print: (text: string) => undefined,
    private readonly memory?: CommonEventMemory) {}

  get comFrameTime(): number { return this.frameTime; }

  captureFrameTime(time: number): void {
    if (!Number.isInteger(time) || time < -2147483648 || time > 2147483647) throw new RangeError("Common frame time requires signed-int milliseconds");
    this.frameTime = time;
  }

  milliseconds(): number {
    while (true) {
      const event = this.input.getEvent();
      if (event.kind === "none") return event.time;
      this.push(event);
    }
  }

  getEvent(): CommonSystemEvent {
    if (this.count === 0) return this.input.getEvent();
    const event = this.pushed[this.read];
    if (event === undefined || event === null) throw new Error("Common pushed event slot is empty");
    this.pushed[this.read] = null;
    this.read = (this.read + 1) & (MAX_COMMON_PUSHED_EVENTS - 1);
    this.count--;
    return event;
  }

  private push(event: CommonSystemEvent): void {
    if (this.count === MAX_COMMON_PUSHED_EVENTS) {
      if (!this.warned) { this.warned = true; this.print("WARNING: Com_PushEvent overflow\n"); }
      const discarded = this.pushed[this.write];
      if (discarded === undefined || discarded === null) throw new Error("Common pushed event slot is empty");
      this.memory?.free(discarded);
      this.read = (this.read + 1) & (MAX_COMMON_PUSHED_EVENTS - 1);
    } else { this.warned = false; this.count++; }
    this.pushed[this.write] = this.memory?.copy(event) ?? event;
    this.write = (this.write + 1) & (MAX_COMMON_PUSHED_EVENTS - 1);
  }
}

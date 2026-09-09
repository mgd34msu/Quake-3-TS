// Dedicated-build Sys_GetEvent chronology.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { CommonEventSource, CommonSystemEvent } from "../engine/common-events.ts";
import type { UnixIo } from "./unix-io.ts";

/** The compiled-null client contributes no key or input-device polling step. */
export class DedicatedEventSource implements CommonEventSource {
  constructor(private readonly unix: UnixIo) {}

  getEvent(): CommonSystemEvent {
    const queued = this.unix.takeQueuedEvent();
    if (queued !== null) return queued;
    this.unix.pollConsoleEvent();
    this.unix.pollPacketEvent();
    return this.unix.takeQueuedEvent() ?? this.unix.noneEvent();
  }
}

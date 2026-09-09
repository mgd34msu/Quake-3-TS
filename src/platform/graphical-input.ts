// Graphical unix_main.c Sys_GetEvent chronology.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { CommonEventSource, CommonSystemEvent } from "../engine/common-events.ts";
import type { SdlGameInput } from "./sdl-game-input.ts";
import type { UnixIo } from "./unix-io.ts";

/** Borrows the same Unix queue/network owner used by the client and server. */
export class GraphicalEventSource implements CommonEventSource {
  constructor(private readonly unix: UnixIo, private readonly input: SdlGameInput) {}

  getEvent(): CommonSystemEvent {
    const queued = this.unix.takeQueuedEvent();
    if (queued !== null) return queued;
    this.input.sendKeyEvents();
    this.unix.pollConsoleEvent();
    this.input.frame();
    this.unix.pollPacketEvent();
    return this.unix.takeQueuedEvent() ?? this.unix.noneEvent();
  }
}

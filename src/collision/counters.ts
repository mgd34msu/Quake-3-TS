// Collision statistics from id Software's code/qcommon/cm_load.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.

/** Common-lived source counters, cleared by Com_Frame after com_showtrace prints. */
export class CollisionCounters {
  c_traces = 0;
  c_brush_traces = 0;
  c_patch_traces = 0;
  c_pointcontents = 0;

  reset(): void {
    this.c_traces = 0;
    this.c_brush_traces = 0;
    this.c_patch_traces = 0;
    this.c_pointcontents = 0;
  }
}

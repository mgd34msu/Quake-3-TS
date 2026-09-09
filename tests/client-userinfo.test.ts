import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { CommonError } from "../src/core/common-error.ts";
import { CvarFlag, CvarRegistry } from "../src/core/cvar.ts";
import { ClientAdmission } from "../src/engine/client-admission.ts";
import { ClientAuthorization } from "../src/engine/client-authorization.ts";
import { CommonCdKeyState } from "../src/engine/cd-key.ts";
import { ClientConnectionState, ClientStaticState } from "../src/engine/client-state.ts";
import type { ClientConnectionPhase } from "../src/engine/client-state.ts";
import { UnixSystemClock } from "../src/platform/system-clock.ts";
import { UnixIo } from "../src/platform/unix-io.ts";
import { LoopbackTransport } from "../src/protocol/loopback.ts";

function fixture() {
  const stdin = new PassThrough(), cls = new ClientStaticState(), clc = new ClientConnectionState();
  const cvars = new CvarRegistry(), io = new UnixIo(() => undefined, new UnixSystemClock(), { stdin, signals: "none" });
  let active = true;
  const authorization = new ClientAuthorization({ cvars, cdKey: new CommonCdKeyState(cvars, "client"), io, print: () => undefined });
  const admission = new ClientAdmission({ clientStatic: cls, clientConnection: clc, cvars, io, loopback: new LoopbackTransport(),
    authorization,
    print: () => undefined, assertCurrentOperation: () => { if (!active) throw new Error("Retired client operation"); } });
  cvars.register("name", "First", CvarFlag.UserInfo | CvarFlag.Archive);
  cvars.set("name", "Second");
  return { admission, cls, clc, cvars, retire: () => { active = false; }, close: () => { io.close(); stdin.destroy(); } };
}

test("userinfo leaves changes pending until challenging and while paused", () => {
  const f = fixture();
  try {
    for (const phase of ["uninitialized", "disconnected", "connecting"] satisfies readonly ClientConnectionPhase[]) {
      f.cls.phase = phase; f.admission.checkUserinfo();
      expect(f.clc.reliable.sequence).toBe(0); expect(f.cvars.modifiedFlags & CvarFlag.UserInfo).toBe(CvarFlag.UserInfo);
    }
    f.cls.phase = "challenging";
    expect(() => f.admission.checkUserinfo()).toThrow("registered cl_paused");
    f.cvars.register("cl_paused", "1"); f.admission.checkUserinfo();
    expect(f.clc.reliable.sequence).toBe(0); expect(f.cvars.modifiedFlags & CvarFlag.UserInfo).toBe(CvarFlag.UserInfo);
    f.cvars.set("cl_paused", "0"); f.admission.checkUserinfo();
    expect(f.clc.reliable.pending()).toEqual([{ sequence: 1, text: 'userinfo "\\name\\Second"' }]);
    expect(f.cvars.modifiedFlags & CvarFlag.UserInfo).toBe(0); expect(f.cvars.modifiedFlags & CvarFlag.Archive).toBe(CvarFlag.Archive);
    f.admission.checkUserinfo(); expect(f.clc.reliable.sequence).toBe(1);
  } finally { f.close(); }
});

test("userinfo uses the same reliable ring through every source connected phase, including cinematic", () => {
  const f = fixture();
  try {
    f.cvars.register("cl_paused", "0");
    for (const phase of ["challenging", "connected", "loading", "primed", "active", "cinematic"] satisfies readonly ClientConnectionPhase[]) {
      f.cls.phase = phase; f.cvars.set("name", phase); f.admission.checkUserinfo();
      expect(f.clc.reliable.lookup(f.clc.reliable.sequence)).toBe(`userinfo "\\name\\${phase}"`);
    }
    expect(f.clc.reliable.outstanding).toBe(6);
  } finally { f.close(); }
});

test("userinfo clears only its flag before info serialization and retains that order on failure", () => {
  const f = fixture();
  try {
    f.cls.phase = "active"; f.cvars.register("cl_paused", "0");
    const read = f.cvars.infoString.bind(f.cvars), failure = new CommonError("drop", "Info serialization failed");
    f.cvars.infoString = () => { expect(f.cvars.modifiedFlags & CvarFlag.UserInfo).toBe(0); throw failure; };
    expect(() => f.admission.checkUserinfo()).toThrow(failure);
    expect(f.clc.reliable.sequence).toBe(0); expect(f.cvars.modifiedFlags & CvarFlag.Archive).toBe(CvarFlag.Archive);
    f.cvars.infoString = read; f.admission.checkUserinfo(); expect(f.clc.reliable.sequence).toBe(0);
    f.cvars.set("name", "Third");
    f.cvars.infoString = mask => { f.retire(); return read(mask); };
    expect(() => f.admission.checkUserinfo()).toThrow("Retired client operation");
    expect(f.clc.reliable.sequence).toBe(0); expect(f.cvars.modifiedFlags & CvarFlag.UserInfo).toBe(0);
  } finally { f.close(); }
});

test("userinfo overflow raises the source drop after clearing the modified flag", () => {
  const f = fixture();
  try {
    f.cls.phase = "challenging"; f.cvars.register("cl_paused", "0");
    for (let index = 0; index < 65; index++) f.clc.reliable.add(`say ${index}`);
    expect(() => f.admission.checkUserinfo()).toThrow(new CommonError("drop", "Client command overflow"));
    expect(f.cvars.modifiedFlags & CvarFlag.UserInfo).toBe(0); expect(f.clc.reliable.sequence).toBe(65);
  } finally { f.close(); }
});

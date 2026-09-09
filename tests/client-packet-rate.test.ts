import { expect, test } from "bun:test";
import { CvarFlag, CvarRegistry } from "../src/core/cvar.ts";
import type { ClientPacketAddress } from "../src/engine/client-state.ts";
import { LanAddresses } from "../src/platform/lan.ts";
import type { Product } from "../src/shared/definitions.ts";
import { createProtocolClientSession } from "../tools/client-protocol-fixture.ts";

const remote: ClientPacketAddress = { kind: "ipv4", host: [203, 0, 113, 4], port: 27960 };
const local: ClientPacketAddress = { kind: "loopback" };
const lan = new LanAddresses([[127, 0, 0, 1], [192, 168, 1, 3]]);

function fixture(product: Product) {
  const cvars = new CvarRegistry();
  cvars.register("cl_maxpackets", "30", CvarFlag.Archive);
  const session = createProtocolClientSession({ product, cvars, mode: { kind: "network", challenge: 12, qport: 34 } });
  return { session, cvars, cls: session.lifecycle.clientStatic, clc: session.lifecycle.clientConnection };
}

for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
  test(`${product}: pre-gamestate and download throttles precede the loopback bypass`, () => {
    const f = fixture(product);
    f.clc.lastPacketSentTime = 10;
    f.cls.realtime = 1009; expect(f.session.readyToSendPacket(local, lan)).toBe(false);
    f.cls.realtime = 1010; expect(f.session.readyToSendPacket(local, lan)).toBe(true);
    f.cls.phase = "primed"; f.cls.realtime = 10;
    expect(f.session.readyToSendPacket(local, lan)).toBe(true);
    f.clc.downloadTempName = "pak.tmp";
    f.cls.realtime = 59; expect(f.session.readyToSendPacket(local, lan)).toBe(false);
    f.cls.realtime = 60; expect(f.session.readyToSendPacket(local, lan)).toBe(true);
    f.cls.phase = "loading";
    expect(f.session.readyToSendPacket(local, lan)).toBe(true);
    f.clc.downloadTempName = "\0unused";
    expect(f.session.readyToSendPacket(local, lan)).toBe(false);
  });

  test(`${product}: LAN readiness bypasses cvar clamping but not demo or cinematic suppression`, () => {
    const f = fixture(product);
    f.cls.phase = "active";
    f.cvars.set("cl_maxpackets", "0", true);
    const address: ClientPacketAddress = { kind: "ipv4", host: [192, 168, 99, 8], port: 27961 };
    expect(f.session.readyToSendPacket(address, lan)).toBe(true);
    expect(f.cvars.get("cl_maxpackets")?.value).toBe("0");
    f.clc.demoPlaying = true; expect(f.session.readyToSendPacket(address, lan)).toBe(false);
    f.clc.demoPlaying = false; f.cls.phase = "cinematic";
    expect(f.session.readyToSendPacket(local, lan)).toBe(false);
  });

  test(`${product}: remote pacing uses integer division and the most recently sent packet record`, () => {
    const f = fixture(product), packets: Uint8Array[] = [], traces: string[] = [];
    f.cls.phase = "active";
    f.cls.realtime = 32; expect(f.session.readyToSendPacket(remote, lan)).toBe(false);
    f.cls.realtime = 33; expect(f.session.readyToSendPacket(remote, lan)).toBe(true);
    f.cls.realtime = 100;
    f.cvars.set("cl_packetdup", "0", true); f.cvars.set("cl_nodelta", "1", true);
    f.session.transmit({ send: bytes => { packets.push(bytes); }, trace: text => { traces.push(text); },
      print: () => { throw new Error("Unexpected packet diagnostic"); } });
    expect(packets).toHaveLength(1); expect(traces).toHaveLength(1);
    f.clc.lastPacketSentTime = -1000; // The maxpackets gate reads outPackets, not this connection field.
    f.cls.realtime = 132; expect(f.session.readyToSendPacket(remote, lan)).toBe(false);
    f.cls.realtime = 133; expect(f.session.readyToSendPacket(remote, lan)).toBe(true);
    f.cls.realtime = 99; expect(f.session.readyToSendPacket(remote, lan)).toBe(false);
  });

  test(`${product}: source clamp is forced and takes effect before the current rate decision`, () => {
    const f = fixture(product);
    f.cls.phase = "active";
    f.cvars.register("cl_maxpackets", "30", CvarFlag.ReadOnly | CvarFlag.Latch);
    f.cvars.set("cl_maxpackets", "1", true);
    f.cls.realtime = 65; expect(f.session.readyToSendPacket(remote, lan)).toBe(false);
    expect(f.cvars.get("cl_maxpackets")?.value).toBe("15");
    f.cls.realtime = 66; expect(f.session.readyToSendPacket(remote, lan)).toBe(true);
    f.cvars.set("cl_maxpackets", "999", true);
    f.cls.realtime = 7; expect(f.session.readyToSendPacket(remote, lan)).toBe(false);
    expect(f.cvars.get("cl_maxpackets")?.value).toBe("125");
    f.cls.realtime = 8; expect(f.session.readyToSendPacket(remote, lan)).toBe(true);
  });
}

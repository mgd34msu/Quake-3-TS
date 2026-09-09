import { describe, expect, test } from "bun:test";
import { SnapshotHistory } from "../src/cgame/snapshot-history.ts";
import { MessageReader } from "../src/protocol/message.ts";
import { Netchannel, xorServerMessage } from "../src/protocol/netchan.ts";
import { decodeServerMessage } from "../src/protocol/server-message.ts";
import { EntityStateRecord } from "../src/shared/entity-state.ts";
import type { SourceEntityState } from "../src/shared/entity-state.ts";
import { statSchema } from "../src/shared/definitions.ts";
import { runPeerVerification } from "../tools/verify-peer.ts";
import type { PeerVerificationOptions } from "../tools/verify-peer.ts";

// UDP capture from pinned stock1.32b native peer, executable SHA256
// 8bbc7e262dfa9f5933598d975cb9824f21ab183431aaca2762930dae5812407b.
// Source dbe4ddb10315479fc00086f08e25d968b4b43c49, vm_game1, sv_pure0, q3dm1.
// Expected fields independently decoded with untouched CL_Netchan_Process,
// MSG_ReadDeltaPlayerstate and MSG_ReadDeltaEntity, not TypeScript roundtrips.
const challenge = -1438330891;
const nativePackets = [
  "01000000aa7fef11de901f3baae6a76ff22490f1",
  "02000000aa7f0e44729b0a2ebc959d24f76d5bf7",
  "0300008000001405aa4855b6e83d4d3610900544faca7996312074f3377896fa799706f825490a480c2ef31adef9936017aed16119970c6129a1296edefa36d38ea7d8e99e8659fbdd4a192e0d0b0228162e53b1b76ecab905786b78f3eb07ca33b28f7264cb0088cc60b38ff235b28f7264cb80cc00e20ddf39d5aec04ae6801a825a069ec0cd0d8ee005ae75f531e807e2c406ca74eb954a8a1f2706474afd1a34d562fd68da7a767ff4953e10ebcdeb3d4d3688324502eee5f330663bcd8016ae28f300d56853438e44469551958fe12e79a6eeae54c6cacb80cc6081770b7e917fd3fc35259551958fe12eb76e454561aee83b9097794531707913ab960596943890723a90c6963804aacc80cc006211e77a7711e71a2e9c68caee151395b947e907da37178ff2d5965436ee448f31b831e805e29077b1c6ba62b1de2f95f178cb33907637d8e3041213ebcd3f28e8dd8ac28df7358862f18d8a1a364734b145e1c61ad662d32e53955195b9470534efe885b145fa4536caf4d0fc7ad76d811a82da19f40dfee0f2cd74c7ca70ab943fb51ace68b1464a955d8f04967a6107fc8f7eeb4e190d48190da83b65f1954a7aa13eb51a82da19f40dfee0f2cd74c7ca70ab943fb5da19ae4a46977129953530cd86f931c09ee6000406061f048bda19f4cdf98082f7cdb44f821a36133d3144de79968f798fc69731707913ab96e1f4799631b8317404466904ca74ebad3b65f1954a8ada19f40dc7f1153f10ebcd3fb00cfe6e71040eae28daf53c15ae0cefcae1442fb47996facac1ea68dabac032651aa98e15337de1b9808158103f75c7a87081ae000a6892791b9f0ec28aece8c8fbf9f96970b95117259f8e0ec28acc6bb851251f82cc6bb851651a9f8028da6617e4a8d7d0b9ce1afed91ede6a88f039739ad4cd99e03e86ffd99500fe05e4a8e63ce79a6e88f039731a908128da6617e4a8301ae710d3ca68b15da796faaf4ad31a2fb1defa4536ca0cefcae14499d235471f34fd979dc9c8b4df3a343d049e80c31aae002e1f2e552fbdc63a958fcab1b997314eb14561966e3178cb33c874ab3c348ee8ebcd00e28dc3d0e6607307cacc801a07064795792979eb15e8e9edc86b7893eacdeb35ca80cc603be8cdeb3d94e8cd3f6871f2c4e6956e3b96663b75d23af4794417cab1619259b0e49077b12f866855bd44e9d5ff4536559ace3927d32f6166a670da1ac731059ec31abec0faff933e34e885ca79a0357892f1d757faaf2e957811279c2e671a513e68ca6e6eefca1744cf92b9e8ba3afa68862fde3e68ca6e6eefca17448dd78d0496949006723dd070aa83e06e139295d4a16bf390cfb57119e5d5c77a7a3d03fefcb094bf7667eeb030eb0aee89de0e8b94069ad6d0a12a7796d260f2eecaed7ecfae900e5717017ff7e030148549670e96d260f2ee9697da08967cd5b41f38d1b0f5b04d4ee8b737bedaffc6ecc62cc30e07f85bcd69eede9cfed121d5deee7fd3f7f07cec34cf0ec7d222188a947673776eaa87f17467aee4967673776eb59378fe4bcd69eea997e63b856fd775f9b094bf7607e3f027f5ba9071c449b93a59c64af001ad827767aee496887317c3f03c3adc420f8b948a733777aa795696d260f2eea9978616163165a611017f7713f53d86cb747467aee496960f36c475e925b4a9272db66795cbc438f209b0f4c6a612ae7915baeeef3c3e2830f57b003ecee50aedff368e5627e8316fc6c462308a94d649776eaa87f17467aee496d649776eb59378fe5bc769ee96977ec158b1a6c6e4bdf4fa46c6322d163105712c6eb97af0faf8128cf2f3d547",
  "0300008014051d01d2369e361636377981de5d0e328e8815da8449670e96d260f2ee39996a3337e2b172407cb97af07aa787cb747467aee496c2967a9c0615eb1cdcc8c7363496e121d5deee7fd3f7f0aeee1aec0a8e71487cb9fa46c6c0661de7e27a3264f6f5da7afbea0a8e71c440b9fa46c6b23303fefcb094bf76f7e0705ef0c928577b1b9bc61006cefac6374967f6fa30eae89176ffd5b5eb2d2daec83515c636f209b0f4c6603906cef5baeeef0c2e28f0afee397b57c80ec1e476b7e03085ed1c353ea62005c0e4c668ed958b0699d2f6d5f7154f7b0397929e1d8fedeeea7c3ff6e50aedff363616a63af7d07afa83cb99b52bf8319276ff087bf2965e2d176ef5baeeefcc4395ed7ccf6a96de737b2d492ff6fa33eab8fa535c1cc40de3a7f7",
  "04000000aa115b2dcdb390392fb557fade755c0c09f954c1fade3a5228244184909ee9b2e787f54a8596c8290c6516e0ddbc350ef953771f26fd8a7e21c934016b19cda1b90063df49533eb9777b3ff2f17b52b5fa0063ba9fb2b3b80363d5781f59ca6bee1616e490959d7da7909b22f10387936d13016bdd553190d6da",
  "05000000aa115b2dccb291382eb456fbdf745d0d08f855c0fbdf3b5329254085919fe8b3e686f44b8497c9280d6417e1dcbd344fab78ea4aafc31ccdb213e4339b5203b0d135bb4a107aced3e9dacafff0d87ee2dd34bbde49fdf9d539bb62d44a531e988e6c6fa7746141c1aa7559bdf3382b79817a339b4260f2776d5c94",
  "060000005b8d40aa0f7ba597429937b7762a5addad9aedb4921ae61abc2a17bd7d88d506329f6193a940ea148081da67cab2c5f374f447dca6aaae93d3cf70118648ac175666ca06c067beede263b9768a55deda141a9ac0ca473df8ab949436b31114aa81",
  "070000005bfdebafba37855cb57b6441d69707cfbab9384585f69cb678066d38df",
  "080000005bfd33ff340fc21eb3076838bdcecd3a516a71993f4363c0f0c58cc0c0",
  "090000005bfd317f52eccf713f0d556160c89a2fde2a448f49430b1d93787362a033",
  "0a0000005bfdd7fff9c9d920eb1d2e74d51f8767b1e2002ab946ab3eef",
  "0b0000005bfd01fc370cc15d76373f34e93fff97a41b2c05a6862b59f486c30c361e24ca29a264e3",
  "0c0000005bfd9155fda04ff4eb1a506c4fd9c81eef5584c52a31c5",
  "0d0000005bfda7aa6599cd7a9958bcdddba243980767e3555ffad0",
  "0e0000005bfd83aa669ace793aa750c6f2370d96f9f792c72a86f9",
  "0f0000005bfd57ae3308c55932b751afdb770f47f3d16b2f08918a88"
];

describe("isolated stock1.32b packet evidence", () => {
  test("native fragmented gamestate and full/delta movement snapshots match independent C decoding", () => {
    const channel = new Netchannel("client", 27184);
    const history = new SnapshotHistory();
    const baselines = new Map<number, SourceEntityState>();
    let serverCommandSequence = 0; let parseEntitiesNumber = 0; let fragmented = 0; let inactive = 0; let configCount = 0;
    const commands: string[] = [];
    const snapshots: { sequence: number; time: number; commandTime: number; health: number; weapon: number; origin: number[]; velocity: number[] }[] = [];
    for (const hex of nativePackets) {
      const packet = Buffer.from(hex, "hex");
      const framed = channel.receive(packet);
      if (framed.kind === "rejected") throw new Error(framed.reason);
      if ((packet.readUInt32LE(0) & 0x80000000) !== 0) fragmented++;
      if (framed.kind === "fragment") continue;
      const ack = new MessageReader(framed.payload).readLong();
      expect(ack === 0 || ack === 1).toBe(true);
      const plain = xorServerMessage(framed.payload, challenge, framed.sequence, ack === 0 ? "" : "say typescript-peer-ack");
      const decoded = decodeServerMessage(plain, { product: "baseq3", messageNumber: framed.sequence, reliableSequence: 1,
        serverCommandSequence, parseEntitiesNumber, baseline: number => baselines.get(number) ?? null, history: number => history.readSlot(number) });
      serverCommandSequence = decoded.serverCommandSequence; parseEntitiesNumber = decoded.parseEntitiesNumber;
      expect(decoded.terminal).toBe("eof");
      for (const operation of decoded.operations) {
        if (operation.kind === "gamestate") {
          expect(framed.sequence).toBe(3);
          expect(operation.checksumFeed).toBe(100532654);
          expect(operation.clientNumber).toBe(0);
          expect(operation.commandSequence).toBe(0);
          for (const entry of operation.entries) {
            if (entry.kind === "baseline") {
              const entity = new EntityStateRecord<number>(0);
              entity.copyFrom(entry.entity);
              baselines.set(entry.number, entity);
            }
            else configCount++;
          }
        } else if (operation.kind === "command") commands.push(operation.text);
        else if (operation.kind === "snapshot") {
          expect(operation.validity.kind).toBe("valid");
          if ((operation.snapshot.flags & 2) !== 0) { inactive++; continue; }
          expect(history.publish(operation)).toBe(true);
          const state = operation.snapshot.playerState;
          snapshots.push({ sequence: framed.sequence, time: operation.snapshot.serverTime, commandTime: state.commandTime,
            health: state.stats.get(statSchema(state.product).health), weapon: state.weapon, origin: [state.origin.x, state.origin.y, state.origin.z], velocity: [state.velocity.x, state.velocity.y, state.velocity.z] });
        }
      }
    }
    expect(fragmented).toBe(2); expect(inactive).toBe(2); expect(configCount).toBe(26); expect(baselines.size).toBe(27);
    expect(snapshots.length).toBe(12);
    expect(snapshots[0]).toEqual({ sequence: 4, time: 1650, commandTime: 1500, health: 125, weapon: 2, origin: [1052, 1432, 33], velocity: [0, 0, 0] });
    const nativeOrigins: [number, number, number][] = [
      [1052, 1432, 33], [1052, 1432, 33], [1048.61426, 1435.38574, 24.125], [1045.27417, 1438.72583, 24.125],
      [1040.13416, 1443.86584, 24.125], [1034.43274, 1449.56726, 24.125], [1028.73132, 1455.26868, 24.125],
      [1023.02991, 1460.97009, 24.125], [1017.32849, 1466.67151, 24.125], [1011.62708, 1472.37292, 24.125],
      [1005.92566, 1478.07434, 24.125], [1000.22424, 1483.77576, 24.125],
    ];
    for (const [i, expected] of nativeOrigins.entries()) expect(snapshots[i]?.origin).toEqual(expected.map(Math.fround));
    expect(snapshots[11]).toEqual({ sequence: 15, time: 2200, commandTime: 2158, health: 125, weapon: 2,
      origin: [Math.fround(1000.22424), Math.fround(1483.77576), 24.125], velocity: [-114, 114, 0] });
    expect(commands).toEqual(['print "TypeScript-Probe^7 entered the game\n"', 'chat "TypeScript-Probe^7\x19: ^2typescript-peer-ack"']);
    expect(history.latest?.deltaNumber).toBe(14);
  });

  test("truncated native fragment fails before any gamestate is exposed", () => {
    const firstFragment = nativePackets[2];
    if (firstFragment === undefined) throw new Error("Missing native fragment fixture");
    const packet = Buffer.from(firstFragment, "hex");
    expect(new Netchannel("client").receive(packet.subarray(0, packet.length - 1))).toEqual({ kind: "rejected", reason: "fragment-length" });
  });

  test("probe rejects unbounded runs and nonlocal peers before opening UDP", async () => {
    const options: PeerVerificationOptions = { address: { kind: "ipv4", host: [127, 0, 0, 1], port: 27961 }, product: "baseq3",
      provenance: { executable: "/not-used", executableSha256: "0".repeat(64), sourceCommit: "0".repeat(40), buildDescription: "test boundary", processId: 1, arguments: [] } };
    for (const snapshots of [0, 2, 101, NaN]) await expect(runPeerVerification({ ...options, snapshots })).rejects.toThrow("snapshot count");
    for (const timeoutMilliseconds of [0, 999, 60001, NaN]) await expect(runPeerVerification({ ...options, timeoutMilliseconds })).rejects.toThrow("timeout");
    await expect(runPeerVerification({ ...options, address: { kind: "ipv4", host: [192, 0, 2, 1], port: 27961 } })).rejects.toThrow("127.0.0.1");
    await expect(runPeerVerification({ ...options, address: { kind: "ipv4", host: [127, 0, 0, 1], port: 0 } })).rejects.toThrow("port");
  });
});

import { describe, expect, test } from "bun:test";
import { BinaryError } from "../src/core/binary.ts";
import { UdpTransport } from "../src/platform/network.ts";
import { decodeConnectionless, encodeConnect, encodeConnectionlessText } from "../src/protocol/connectionless.ts";
import { compressAdaptive } from "../src/protocol/huffman.ts";

// Untouched net_chan.c NET_OutOfBandPrint/Data + msg.c/cmd.c/huffman.c at
// dbe4ddb10315479fc00086f08e25d968b4b43c49. Native Sys_SendPacket captured bytes;
// compiler zero-initialized stack storage to make unused Huffman padding defined.
const getchallenge = "ffffffff6765746368616c6c656e6765";
const getinfo = "ffffffff676574696e666f20787878";
const connect = "ffffffff636f6e6e65637420003a4474b08b216cc7945004e64330148a0d826708a70387fdd8372e73306e4dc166708471dc8c7a8169c2fe60946af66261eef665cc2dfdbb3d2c06d6ee02";
const emptyConnect = "ffffffff636f6e6e6563742000024401";
const highBytes = "ffffffff6563686f20618062202263ff6422202f2a222a2f20e965203530250a72657374";
const status = "ffffffff737461747573526573706f6e73650a5c686f73746e616d655c52657461696c0a312032302022506c61796572204f6e65220a322033302022506c617965722054776f220a";
const userinfo = "\\name\\Q3 Player\\protocol\\68\\qport\\27183\\challenge\\123456";

function hex(bytes: Uint8Array): string { return Buffer.from(bytes).toString("hex"); }
function text(bytes: Uint8Array): string { return Buffer.from(bytes).toString("latin1"); }

function compressedPacket(tail: Uint8Array): Uint8Array {
  const prefix = encodeConnectionlessText("connect ");
  const packet = new Uint8Array(prefix.length + tail.length);
  packet.set(prefix); packet.set(tail, prefix.length);
  return packet;
}

async function receive(transport: UdpTransport): Promise<Uint8Array> {
  const deadline = performance.now() + 2000;
  while (performance.now() < deadline) {
    const event = transport.poll();
    if (event !== null) {
      if (event.kind === "error") throw event.error;
      return event.payload;
    }
    await Bun.sleep(2);
  }
  throw new Error("Timed out waiting for connectionless localhost UDP");
}

describe("connectionless native byte fixtures", () => {
  test("getchallenge/getinfo are -1-prefixed Latin-1 without a trailing NUL", () => {
    expect(hex(encodeConnectionlessText("getchallenge"))).toBe(getchallenge);
    expect(hex(encodeConnectionlessText("getinfo xxx"))).toBe(getinfo);
    expect(decodeConnectionless(Buffer.from(getchallenge, "hex"), "server")).toEqual({ command: "getchallenge", arguments: [],
      line: "getchallenge", payload: new Uint8Array(), compression: "none", lineEnding: "end", readCount: 17 });
    expect(decodeConnectionless(Buffer.from(getinfo, "hex"), "server").arguments).toEqual(["xxx"]);
  });

  test("connect compresses the opening quote at packet byte12 and excludes its NUL", () => {
    expect(hex(encodeConnect(userinfo))).toBe(connect);
    expect(hex(encodeConnect(""))).toBe(emptyConnect);
    const parsed = decodeConnectionless(Buffer.from(connect, "hex"), "server");
    expect(parsed.command).toBe("connect");
    expect(parsed.arguments).toEqual([userinfo]);
    expect(parsed.line).toBe(`connect "${userinfo}"`);
    expect(parsed.compression).toBe("adaptive");
    expect(parsed.readCount).toBe(71);
    expect(parsed.lineEnding).toBe("end");
    expect(parsed.payload.length).toBe(0);
  });

  test("native percent, signed high-byte whitespace and quoted high bytes agree", () => {
    const input = 'echo a\x80b "c\xffd" /*"*/ \xe9e 50%\nrest\0ignored';
    expect(hex(encodeConnectionlessText(input))).toBe(highBytes);
    const parsed = decodeConnectionless(Buffer.from(highBytes, "hex"), "client");
    expect(parsed.line).toBe('echo a\x80b "c\xffd" /*"*/ \xe9e 50.');
    expect(parsed.arguments).toEqual(["a", "b", "c\xffd", "e", "50."]);
    expect(parsed.readCount).toBe(32);
    expect(parsed.lineEnding).toBe("newline");
    expect(text(parsed.payload)).toBe("rest");
  });

  test("status/info and unknown extension replies preserve every remaining line", () => {
    const body = '\\hostname\\Retail\n1 20 "Player One"\n2 30 "Player Two"\n';
    expect(hex(encodeConnectionlessText(`statusResponse\n${body}`))).toBe(status);
    const parsed = decodeConnectionless(Buffer.from(status, "hex"), "client");
    expect(parsed.command).toBe("statusResponse");
    expect(parsed.arguments).toEqual([]);
    expect(parsed.readCount).toBe(19);
    expect(text(parsed.payload)).toBe(body);
    for (const command of ["infoResponse", "unknownExtension"]) {
      const response = decodeConnectionless(encodeConnectionlessText(`${command} "argument with spaces"\r\n${body}%\xff`), "client");
      expect(response.command).toBe(command);
      expect(response.arguments).toEqual(["argument with spaces"]);
      expect(response.line.endsWith("\r")).toBe(true);
      expect(text(response.payload)).toBe(`${body}%\xff`);
    }
  });
});

describe("source dispatch, line consumption and ownership", () => {
  test("only the server's exact lowercase raw connect prefix triggers decompression", () => {
    const response = encodeConnectionlessText("connectResponse");
    expect(decodeConnectionless(response, "client").command).toBe("connectResponse");
    expect(() => decodeConnectionless(response, "server")).toThrow("compressed");
    const uppercase = decodeConnectionless(encodeConnectionlessText('CONNECT "plain info"'), "server");
    expect(uppercase.command).toBe("CONNECT");
    expect(uppercase.arguments).toEqual(["plain info"]);
    expect(uppercase.compression).toBe("none");
    expect(decodeConnectionless(encodeConnectionlessText("connect"), "server").line).toBe("connect");
    expect(decodeConnectionless(encodeConnectionlessText("connect "), "server").line).toBe("connect ");
  });

  test("source byte1023 limit does not consume the next delimiter", () => {
    const line = `echo ${"a".repeat(1018)}`;
    const parsed = decodeConnectionless(encodeConnectionlessText(`${line}\nbody`), "server");
    expect(parsed.line).toBe(line);
    expect(parsed.readCount).toBe(1027);
    expect(parsed.lineEnding).toBe("limit");
    expect(text(parsed.payload)).toBe("\nbody");
    const exactEnd = decodeConnectionless(encodeConnectionlessText(line), "server");
    expect(exactEnd.lineEnding).toBe("limit");
    expect(exactEnd.readCount).toBe(1027);
  });

  test("NUL consumes one byte and preserves subsequent binary bytes", () => {
    const packet = Buffer.concat([encodeConnectionlessText("print"), Buffer.from([0, 65, 0, 255, 37, 10])]);
    const parsed = decodeConnectionless(packet, "client");
    expect(parsed.lineEnding).toBe("nul");
    expect(parsed.readCount).toBe(10);
    expect(parsed.payload).toEqual(Uint8Array.of(65, 0, 255, 37, 10));
    packet.fill(0);
    expect(parsed.payload).toEqual(Uint8Array.of(65, 0, 255, 37, 10));
    expect(hex(encodeConnectionlessText("echo\0ignored\u1234"))).toBe("ffffffff6563686f");
    expect(encodeConnect(`${userinfo}\0ignored`)).toEqual(encodeConnect(userinfo));
  });

  test("quotes, adjacent tokens, comments and empty commands retain Cmd behavior", () => {
    const cases: [string, string[]][] = [
      ['echo a"two words"b/*comment*/c // ignored', ["echo", "a", "two words", "b", "c"]],
      ['echo "unterminated', ["echo", "unterminated"]],
      ['echo /*unterminated', ["echo"]],
      ['echo "a\\"b"', ["echo", "a\\", "b", ""]],
      ['echo /*\"\xff*/a\xffb "x\x80y"', ["echo", "a", "b", "x\x80y"]],
    ];
    for (const [line, expected] of cases) {
      const parsed = decodeConnectionless(encodeConnectionlessText(line), "client");
      expect([parsed.command, ...parsed.arguments]).toEqual(expected);
    }
    expect(decodeConnectionless(Uint8Array.of(255, 255, 255, 255), "server").command).toBe("");
    expect(decodeConnectionless(encodeConnectionlessText(" /* ignored */"), "server").arguments).toEqual([]);
  });
});

describe("connectionless corruption and allocation boundaries", () => {
  test("short/bad markers and oversized datagrams fail with structured locations", () => {
    for (let length = 0; length < 4; length++) expect(() => decodeConnectionless(new Uint8Array(length).fill(255), "client")).toThrow(BinaryError);
    for (let i = 0; i < 4; i++) {
      const packet = encodeConnectionlessText("getinfo"); packet[i] = 0;
      expect(() => decodeConnectionless(packet, "server", "packet-test")).toThrow(`packet-test:${i}`);
    }
    expect(encodeConnectionlessText("a".repeat(16379)).length).toBe(16383);
    expect(() => encodeConnectionlessText("a".repeat(16380))).toThrow("source bytes");
    expect(() => decodeConnectionless(new Uint8Array(16384).fill(255), "server")).toThrow("receive limit");
    expect(() => encodeConnectionlessText("echo \u0100")).toThrow("Latin-1");
  });

  test("connect input stays inside the source1024-byte buffer and preserves quoted Latin-1", () => {
    const maximum = encodeConnect("x".repeat(1013));
    const parsed = decodeConnectionless(maximum, "server");
    expect(parsed.arguments).toEqual(["x".repeat(1013)]);
    expect(parsed.lineEnding).toBe("limit");
    expect(() => encodeConnect("x".repeat(1014))).toThrow("1013");
    for (const invalid of ['a"b', "a\nb", "\u0100"]) expect(() => encodeConnect(invalid)).toThrow(RangeError);
    expect(decodeConnectionless(encodeConnect("\\name\\\xff"), "server").arguments).toEqual(["\\name\\\xff"]);
  });

  test("truncated native connect and oversized advertised Huffman output reject", () => {
    const packet = Buffer.from(connect, "hex");
    for (let length = 13; length < packet.length; length++) {
      expect(() => decodeConnectionless(packet.subarray(0, length), "server")).toThrow("compressed");
    }
    expect(() => decodeConnectionless(compressedPacket(Uint8Array.of(255, 255, 0)), "server")).toThrow("limit");
    expect(() => decodeConnectionless(compressedPacket(Uint8Array.of(0, 1)), "server")).toThrow("Truncated Huffman symbol");
    expect(() => decodeConnectionless(compressedPacket(Uint8Array.of(0, 2, 0, 0, 0)), "server")).toThrow(BinaryError);
    expect(() => decodeConnectionless(compressedPacket(Uint8Array.of(0, 2, 0, 0, 0)), "server")).toThrow("NYT repeats");
    const empty = decodeConnectionless(compressedPacket(Uint8Array.of(0, 0)), "server");
    expect(empty.line).toBe("connect ");
    expect(empty.compression).toBe("adaptive");
  });

  test("decompression is bounded to MAX_MSGLEN and owns its expanded binary tail", () => {
    const expansion = new Uint8Array(16372).fill(65); expansion[0] = 10;
    const packet = compressedPacket(compressAdaptive(expansion));
    const parsed = decodeConnectionless(packet, "server");
    expect(parsed.line).toBe("connect ");
    expect(parsed.payload.length).toBe(16371);
    packet.fill(0); expansion.fill(0);
    expect(parsed.payload.every(byte => byte === 65)).toBe(true);
    const oversized = compressedPacket(compressAdaptive(new Uint8Array(16373).fill(65)));
    expect(() => decodeConnectionless(oversized, "server")).toThrow("output exceeds limit");
  });

  test("actual localhost UDP carries request, compressed connect and multiline reply", async () => {
    const client = await UdpTransport.bind({ host: [127, 0, 0, 1], port: 0 });
    const server = await UdpTransport.bind({ host: [127, 0, 0, 1], port: 0 });
    try {
      expect(client.send(server.address, encodeConnectionlessText("getchallenge"))).toBe(true);
      expect(hex(await receive(server))).toBe(getchallenge);
      expect(client.send(server.address, encodeConnect(userinfo))).toBe(true);
      expect(decodeConnectionless(await receive(server), "server").arguments).toEqual([userinfo]);
      expect(server.send(client.address, Buffer.from(status, "hex"))).toBe(true);
      const received = decodeConnectionless(await receive(client), "client");
      expect(received.command).toBe("statusResponse");
      expect(text(received.payload)).toContain('2 30 "Player Two"\n');
    } finally { client.close(); server.close(); }
  });
});

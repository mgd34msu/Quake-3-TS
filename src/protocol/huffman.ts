// Port of id Software's code/qcommon/huffman.c and msg.c, GPL-2.0-or-later.
// Copyright (C) 1999-2005 Id Software, Inc.

const NYT = 256;
const INTERNAL = 257;

class Block {
  constructor(public leader: Node) {}
}

class Node {
  left: Node | null = null;
  right: Node | null = null;
  parent: Node | null = null;
  next: Node | null = null;
  prev: Node | null = null;
  block: Block;
  constructor(public symbol: number, public weight: number) {
    this.block = new Block(this);
  }
}

export interface HuffmanCodec {
  encodeSymbol(symbol: number, putBit: (bit: number) => void): void;
  decodeSymbol(getBit: () => number): number;
}

/** Adaptive sibling-property tree; packet messages train it once and then freeze updates. */
export class HuffmanTree implements HuffmanCodec {
  private readonly nyt = new Node(NYT, 0);
  private root = this.nyt;
  private readonly symbols = new Map<number, Node>([[NYT, this.nyt]]);

  addReference(symbol: number): void {
    checkByte(symbol);
    const existing = this.symbols.get(symbol);
    if (existing !== undefined) {
      this.increment(existing);
      return;
    }
    const leaf = new Node(symbol, 1);
    const branch = new Node(INTERNAL, 1);
    branch.next = this.nyt.next;
    if (branch.next !== null) {
      branch.next.prev = branch;
      if (branch.next.weight === 1) branch.block = branch.next.block;
    }
    this.nyt.next = branch;
    branch.prev = this.nyt;
    leaf.next = branch;
    branch.prev = leaf;
    leaf.block = branch.block;
    this.nyt.next = leaf;
    leaf.prev = this.nyt;

    const parent = this.nyt.parent;
    if (parent === null) this.root = branch;
    else if (parent.left === this.nyt) parent.left = branch;
    else parent.right = branch;
    branch.right = leaf;
    branch.left = this.nyt;
    branch.parent = parent;
    this.nyt.parent = branch;
    leaf.parent = branch;
    this.symbols.set(symbol, leaf);
    this.increment(parent);
  }

  encodeSymbol(symbol: number, putBit: (bit: number) => void): void {
    checkByte(symbol);
    const node = this.symbols.get(symbol);
    if (node === undefined) {
      this.send(this.nyt, putBit);
      for (let shift = 7; shift >= 0; shift--) putBit((symbol >>> shift) & 1);
    } else this.send(node, putBit);
  }

  decodePrefix(getBit: () => number): number {
    let node = this.root;
    while (node.symbol === INTERNAL) {
      const next = getBit() === 0 ? node.left : node.right;
      if (next === null) throw new Error("Invalid Huffman tree");
      node = next;
    }
    return node.symbol;
  }

  decodeSymbol(getBit: () => number): number {
    const prefix = this.decodePrefix(getBit);
    if (prefix !== NYT) return prefix;
    let symbol = 0;
    for (let i = 0; i < 8; i++) symbol = (symbol << 1) | getBit();
    return symbol;
  }

  private send(node: Node, putBit: (bit: number) => void): void {
    if (node.parent === null) return;
    this.send(node.parent, putBit);
    putBit(node.parent.right === node ? 1 : 0);
  }

  private swapTree(a: Node, b: Node): void {
    const ap = a.parent;
    const bp = b.parent;
    if (ap === null) this.root = b;
    else if (ap.left === a) ap.left = b;
    else ap.right = b;
    if (bp === null) this.root = a;
    else if (bp.left === b) bp.left = a;
    else bp.right = a;
    a.parent = bp;
    b.parent = ap;
  }

  private swapList(a: Node, b: Node): void {
    const next = a.next;
    a.next = b.next;
    b.next = next;
    const prev = a.prev;
    a.prev = b.prev;
    b.prev = prev;
    if (a.next === a) a.next = b;
    if (b.next === b) b.next = a;
    if (a.next !== null) a.next.prev = a;
    if (b.next !== null) b.next.prev = b;
    if (a.prev !== null) a.prev.next = a;
    if (b.prev !== null) b.prev.next = b;
  }

  private increment(node: Node | null): void {
    if (node === null) return;
    if (node.next !== null && node.next.weight === node.weight) {
      const leader = node.block.leader;
      if (leader !== node.parent) this.swapTree(leader, node);
      this.swapList(leader, node);
    }
    if (node.prev !== null && node.prev.weight === node.weight) node.block.leader = node.prev;
    node.weight++;
    if (node.next !== null && node.next.weight === node.weight) node.block = node.next.block;
    else node.block = new Block(node);
    if (node.parent !== null) {
      this.increment(node.parent);
      if (node.prev === node.parent) {
        this.swapList(node, node.parent);
        if (node.block.leader === node) node.block.leader = node.parent;
      }
    }
  }
}

function checkByte(symbol: number): void {
  if (!Number.isInteger(symbol) || symbol < 0 || symbol > 255) throw new RangeError("Huffman symbol must be a byte");
}

// msg_hData, in symbol order. Training order participates in equal-weight tie breaking.
const MESSAGE_COUNTS = [
  250315,41193,6292,7106,3730,3750,6110,23283,33317,6950,7838,9714,9257,17259,3949,1778,
  8288,1604,1590,1663,1100,1213,1238,1134,1749,1059,1246,1149,1273,4486,2805,3472,
  21819,1159,1670,1066,1043,1012,1053,1070,1726,888,1180,850,960,780,1752,3296,
  10630,4514,5881,2685,4650,3837,2093,1867,2584,1949,1972,940,1134,1788,1670,1206,
  5719,6128,7222,6654,3710,3795,1492,1524,2215,1140,1355,971,2180,1248,1328,1195,
  1770,1078,1264,1266,1168,965,1155,1186,1347,1228,1529,1600,2617,2048,2546,3275,
  2410,3585,2504,2800,2675,6146,3663,2840,14253,3164,2221,1687,3208,2739,3512,4796,
  4091,3515,5288,4016,7937,6031,5360,3924,4892,3743,4566,4807,5852,6400,6225,8291,
  23243,7838,7073,8935,5437,4483,3641,5256,5312,5328,5370,3492,2458,1694,1821,2121,
  1916,1149,1516,1367,1236,1029,1258,1104,1245,1006,1149,1025,1241,952,1287,997,
  1713,1009,1187,879,1099,929,1078,951,1656,930,1153,1030,1262,1062,1214,1060,
  1621,930,1106,912,1034,892,1158,990,1175,850,1121,903,1087,920,1144,1056,
  3462,2240,4397,12136,7758,1345,1307,3278,1950,886,1023,1112,1077,1042,1061,1071,
  1484,1001,1096,915,1052,995,1070,876,1111,851,1059,805,1112,923,1103,817,
  1899,1872,976,841,1127,956,1159,950,7791,954,1289,933,1127,3207,1020,927,
  1355,768,1040,745,952,805,1073,740,1013,805,1008,796,996,1057,11457,13504,
];

let messageCodec: HuffmanCodec | null = null;

/** Shared immutable codec: unlike connect-packet Huffman, MSG never updates after training. */
export function createMessageHuffman(): HuffmanCodec {
  if (messageCodec !== null) return messageCodec;
  const tree = new HuffmanTree();
  for (const [symbol, count] of MESSAGE_COUNTS.entries()) {
    for (let i = 0; i < count; i++) tree.addReference(symbol);
  }
  messageCodec = {
    encodeSymbol: (symbol, putBit) => tree.encodeSymbol(symbol, putBit),
    decodeSymbol: (getBit) => tree.decodePrefix(getBit),
  };
  return messageCodec;
}

/** Huff_Compress payload, including big-endian uncompressed length and final padding byte. */
export function compressAdaptive(data: Uint8Array): Uint8Array {
  if (data.length === 0) return new Uint8Array();
  if (data.length > 65535) throw new RangeError("Adaptive Huffman length exceeds 16 bits");
  const output = new Uint8Array(2 + data.length * 33 + 1);
  const view = new DataView(output.buffer);
  view.setUint16(0, data.length, false);
  let position = 16;
  const putBit = (bit: number): void => {
    const offset = position >>> 3;
    view.setUint8(offset, view.getUint8(offset) | (bit << (position & 7)));
    position++;
  };
  const tree = new HuffmanTree();
  for (const symbol of data) {
    tree.encodeSymbol(symbol, putBit);
    tree.addReference(symbol);
  }
  return output.slice(0, (position >>> 3) + 1);
}

export function decompressAdaptive(data: Uint8Array, maxLength = 16384): Uint8Array {
  if (!Number.isInteger(maxLength) || maxLength < 0) throw new RangeError("Invalid decompression limit");
  if (data.length === 0) return new Uint8Array();
  if (data.length < 2) throw new RangeError("Truncated Huffman length");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const length = Math.min(view.getUint16(0, false), maxLength);
  let position = 16;
  const getBit = (): number => {
    if (position >= data.length * 8) throw new RangeError("Truncated Huffman symbol");
    const value = (view.getUint8(position >>> 3) >>> (position & 7)) & 1;
    position++;
    return value;
  };
  const output = new Uint8Array(length);
  const tree = new HuffmanTree();
  for (let i = 0; i < length; i++) {
    const symbol = tree.decodeSymbol(getBit);
    output[i] = symbol;
    tree.addReference(symbol);
  }
  return output;
}

export class BinaryError extends Error {
  constructor(
    readonly source: string,
    readonly offset: number,
    message: string,
  ) {
    super(`${source}:${offset}: ${message}`);
    this.name = "BinaryError";
  }
}

export class BinaryReader {
  private readonly view: DataView;
  private cursor = 0;

  constructor(
    private readonly data: Uint8Array,
    readonly source = "<buffer>",
  ) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  get offset(): number { return this.cursor; }
  get length(): number { return this.data.byteLength; }
  get remaining(): number { return this.length - this.cursor; }

  private check(offset: number, length: number): void {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length)
      || offset < 0 || length < 0 || offset > this.length - length) {
      throw new BinaryError(this.source, offset, `range of ${length} bytes exceeds ${this.length}-byte input`);
    }
  }

  private take(length: number): number {
    const offset = this.cursor;
    this.check(offset, length);
    this.cursor += length;
    return offset;
  }

  seek(offset: number): void {
    this.check(offset, 0);
    this.cursor = offset;
  }

  skip(length: number): void { this.take(length); }
  u8(): number { return this.view.getUint8(this.take(1)); }
  i8(): number { return this.view.getInt8(this.take(1)); }
  u16(): number { return this.view.getUint16(this.take(2), true); }
  i16(): number { return this.view.getInt16(this.take(2), true); }
  u32(): number { return this.view.getUint32(this.take(4), true); }
  i32(): number { return this.view.getInt32(this.take(4), true); }
  f32(): number { return this.view.getFloat32(this.take(4), true); }
  f64(): number { return this.view.getFloat64(this.take(8), true); }

  finiteF32(): number {
    const offset = this.cursor;
    const value = this.f32();
    if (!Number.isFinite(value)) throw new BinaryError(this.source, offset, "non-finite float");
    return value;
  }

  bytes(length: number): Uint8Array {
    const offset = this.take(length);
    return new Uint8Array(this.data.subarray(offset, offset + length));
  }

  fixedString(length: number): string {
    const bytes = this.bytes(length);
    const end = bytes.indexOf(0);
    return new TextDecoder("utf-8", { fatal: true }).decode(end < 0 ? bytes : bytes.subarray(0, end));
  }

  section(offset: number, length: number): BinaryReader {
    this.check(offset, length);
    return new BinaryReader(this.data.subarray(offset, offset + length), `${this.source}@${offset}`);
  }

  expectMagic(magic: string): void {
    const offset = this.cursor;
    const actual = this.fixedString(magic.length);
    if (actual !== magic) throw new BinaryError(this.source, offset, `expected ${JSON.stringify(magic)}, got ${JSON.stringify(actual)}`);
  }

  records(offset: number, length: number, stride: number): BinaryReader {
    if (!Number.isSafeInteger(stride) || stride <= 0 || length % stride !== 0) {
      throw new BinaryError(this.source, offset, `length ${length} is not a multiple of record size ${stride}`);
    }
    return this.section(offset, length);
  }
}

export class BinaryWriter {
  private readonly data: Uint8Array;
  private readonly view: DataView;
  private cursor = 0;

  constructor(capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 0) throw new RangeError("Invalid binary capacity");
    this.data = new Uint8Array(capacity);
    this.view = new DataView(this.data.buffer);
  }

  get offset(): number { return this.cursor; }

  private take(length: number): number {
    if (!Number.isSafeInteger(length) || length < 0 || this.cursor > this.data.length - length) {
      throw new RangeError(`Binary output exceeds ${this.data.length}-byte capacity`);
    }
    const offset = this.cursor;
    this.cursor += length;
    return offset;
  }

  private integer(value: number, minimum: number, maximum: number): void {
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      throw new RangeError(`Integer ${value} outside ${minimum}..${maximum}`);
    }
  }

  u8(value: number): void { this.integer(value, 0, 255); this.view.setUint8(this.take(1), value); }
  i8(value: number): void { this.integer(value, -128, 127); this.view.setInt8(this.take(1), value); }
  u16(value: number): void { this.integer(value, 0, 65535); this.view.setUint16(this.take(2), value, true); }
  i16(value: number): void { this.integer(value, -32768, 32767); this.view.setInt16(this.take(2), value, true); }
  u32(value: number): void { this.integer(value, 0, 0xffffffff); this.view.setUint32(this.take(4), value, true); }
  i32(value: number): void { this.integer(value, -0x80000000, 0x7fffffff); this.view.setInt32(this.take(4), value, true); }
  f32(value: number): void { this.view.setFloat32(this.take(4), value, true); }
  f64(value: number): void { this.view.setFloat64(this.take(8), value, true); }
  bytes(value: Uint8Array): void { this.data.set(value, this.take(value.byteLength)); }
  finish(): Uint8Array { return this.data.slice(0, this.cursor); }
}

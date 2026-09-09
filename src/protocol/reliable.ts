// Port of id Software's CL_AddReliableCommand, SV_AddServerCommand and ack handling.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.

export const MAX_RELIABLE_COMMANDS = 64;

export interface ReliableCommand {
  readonly sequence: number;
  readonly text: string;
}

export class ReliableOverflowError extends Error {
  constructor(readonly sequence: number, readonly acknowledge: number) {
    super("Client command overflow");
    this.name = "ReliableOverflowError";
  }
}

export type ReliableAcknowledgement =
  | { readonly kind: "acknowledged"; readonly sequence: number }
  | { readonly kind: "clamped"; readonly sequence: number }
  | { readonly kind: "rejected-stale"; readonly sequence: number };

export type ServerCommandAppend =
  | { readonly kind: "queued"; readonly command: ReliableCommand }
  | { readonly kind: "overflow"; readonly sequence: number; readonly acknowledge: number };

function checkSequence(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0x7fffffff) throw new RangeError("Reliable sequence must be a nonnegative int32");
}

function checkSignedSequence(value: number): void {
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) throw new RangeError("Raw reliable sequence must be a signed int32");
}

function storedText(text: string): string {
  const nul = text.indexOf("\0");
  return text.slice(0, Math.min(1023, nul === -1 ? text.length : nul));
}

function configStringNumber(text: string): number {
  const match = /^cs[\t\n\v\f\r ]*([+-]?)(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)/.exec(text);
  if (match === null) throw new RangeError("SV_ReplacePendingServerCommands: indeterminate sscanf configstring index");
  const sign = match[1], digits = match[2];
  if (sign === undefined || digits === undefined) throw new Error("Missing configstring number capture");
  const radix = /^0[xX]/.test(digits) ? 16 : digits.startsWith("0") ? 8 : 10;
  const magnitude = Number.parseInt(digits, radix);
  const value = sign === "-" ? -magnitude : magnitude;
  if (!Number.isSafeInteger(value) || value < -0x80000000 || value > 0x7fffffff) {
    throw new RangeError("SV_ReplacePendingServerCommands: sscanf index exceeds signed int32");
  }
  return value;
}

class ReliableRing {
  protected currentSequence = 0;
  protected acknowledgedSequence = 0;
  private readonly slots: string[] = Array.from({ length: MAX_RELIABLE_COMMANDS }, () => "");

  get sequence(): number { return this.currentSequence; }
  get acknowledge(): number { return this.acknowledgedSequence; }
  get outstanding(): number { return this.currentSequence - this.acknowledgedSequence; }

  /** Direct source ring indexing; overwritten commands deliberately read their replacement slot. */
  lookup(sequence: number): string {
    checkSequence(sequence);
    if (sequence > this.currentSequence) throw new RangeError("Reliable lookup is ahead of generated commands");
    return this.lookupMasked(sequence);
  }

  /** Source netchannel XOR precedes admission and indexes every signed wire value with &63. */
  lookupMasked(sequence: number): string {
    checkSignedSequence(sequence);
    const text = this.slots[sequence & (MAX_RELIABLE_COMMANDS - 1)];
    if (text === undefined) throw new Error("Missing reliable command ring slot");
    return text;
  }

  /** Raw source assignment only; the production caller performs its ordered admission policy. */
  assignAcknowledgement(sequence: number): void {
    checkSignedSequence(sequence);
    this.acknowledgedSequence = sequence;
  }

  /** Source caller must reject stale raw acknowledgements before enumerating this range. */
  pending(): ReliableCommand[] {
    const commands: ReliableCommand[] = [];
    for (let sequence = this.acknowledgedSequence + 1; sequence <= this.currentSequence; sequence++) commands.push({ sequence, text: this.lookupMasked(sequence) });
    return commands;
  }

  protected nextSequence(): void {
    if (this.currentSequence === 0x7fffffff) throw new RangeError("Reliable sequence exhausted; reconnect required");
    this.currentSequence++;
  }

  protected store(text: string): ReliableCommand {
    const command = { sequence: this.currentSequence, text: storedText(text) };
    this.slots[this.currentSequence & (MAX_RELIABLE_COMMANDS - 1)] = command.text;
    return command;
  }

  protected replace(sequence: number, text: string): void {
    this.slots[sequence & (MAX_RELIABLE_COMMANDS - 1)] = storedText(text);
  }

  protected validateAcknowledge(sequence: number): void {
    checkSequence(sequence);
    if (sequence > this.currentSequence) throw new RangeError("Reliable acknowledgement is ahead of generated commands");
  }
}

/** The source tests >64 before incrementing, so command65 overwrites the oldest slot. */
export class ClientReliableCommands extends ReliableRing {
  /** CL_ChangeReliableCommand appends a newline within the current fixed-size slot. */
  changeLatest(): void {
    this.replace(this.sequence, `${this.lookupMasked(this.sequence).slice(0, 1022)}\n`);
  }

  add(text: string): ReliableCommand {
    if (this.outstanding > MAX_RELIABLE_COMMANDS) throw new ReliableOverflowError(this.sequence, this.acknowledge);
    this.nextSequence();
    return this.store(text);
  }

  acknowledgeThrough(sequence: number): ReliableAcknowledgement {
    this.validateAcknowledge(sequence);
    if (sequence < this.sequence - MAX_RELIABLE_COMMANDS) {
      this.acknowledgedSequence = this.sequence;
      return { kind: "clamped", sequence: this.sequence };
    }
    this.acknowledgedSequence = sequence;
    return { kind: "acknowledged", sequence };
  }
}

/** At command65 the server advances sequence but leaves that slot untouched.
 * Further appends are permitted so the caller's drop/disconnect broadcast cannot recurse. */
export class ServerReliableCommands extends ReliableRing {
  /** Active SV_ReplacePendingServerCommands helper; SV_AddServerCommand's call remains disabled. */
  replacePending(sent: number, text: string): boolean {
    checkSignedSequence(sent);
    const nul = text.indexOf("\0"), command = nul < 0 ? text : text.slice(0, nul);
    for (let sequence = sent + 1; sequence <= this.sequence; sequence++) {
      const pending = this.lookupMasked(sequence);
      if (command.slice(0, 2) !== pending.slice(0, 2)) continue;
      if (configStringNumber(command) !== configStringNumber(pending)) continue;
      this.replace(sequence, command);
      return true;
    }
    return false;
  }

  add(text: string): ServerCommandAppend {
    this.nextSequence();
    if (this.outstanding === MAX_RELIABLE_COMMANDS + 1) return { kind: "overflow", sequence: this.sequence, acknowledge: this.acknowledge };
    return { kind: "queued", command: this.store(text) };
  }

  acknowledgeThrough(sequence: number): ReliableAcknowledgement {
    this.validateAcknowledge(sequence);
    if (sequence < this.sequence - MAX_RELIABLE_COMMANDS) {
      this.acknowledgedSequence = this.sequence;
      return { kind: "rejected-stale", sequence: this.sequence };
    }
    this.acknowledgedSequence = sequence;
    return { kind: "acknowledged", sequence };
  }
}

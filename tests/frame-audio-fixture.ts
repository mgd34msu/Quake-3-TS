import type { PcmSound } from "../src/assets/wav.ts";
import { ClientFrameAudio } from "../src/cgame/frame-audio.ts";
import { ClientGameState } from "../src/cgame/state.ts";
import type { Product } from "../src/shared/definitions.ts";
import { createPlayerState } from "../src/shared/player-state.ts";

export function frameAudioTranscript(product: Product): string {
  const lines: string[] = [];
  const sounds = new Map<number, PcmSound>();
  const handles = new Map<PcmSound, number>();

  function sound(handle: number): PcmSound | null {
    if (handle === 0) return null;
    const existing = sounds.get(handle);
    if (existing !== undefined) return existing;
    const pcm: PcmSound = {
      sampleRate: 22050,
      channels: 1,
      frameCount: 1,
      loopStart: null,
      samples: new Int16Array([handle]),
    };
    sounds.set(handle, pcm);
    handles.set(pcm, handle);
    return pcm;
  }

  function handle(pcm: PcmSound | null): number {
    if (pcm === null) return 0;
    const found = handles.get(pcm);
    if (found === undefined) throw new Error("Unknown fixture sound");
    return found;
  }

  let cg = new ClientGameState(product, 7, 0);
  let ps = createPlayerState(product);
  let event = 0;
  let wearHandle = 700;

  function makeAudio(): ClientFrameAudio {
    return new ClientFrameAudio(cg, { wearOffSound: sound(wearHandle) }, {
      startLocalSound: (pcm, channel): void => {
        lines.push(`LOCAL event=${event++} sound=${handle(pcm)} channel=${channel} time=${cg.time}`);
      },
      startSound: (origin, entity, channel, pcm): void => {
        lines.push(`POSITIONAL event=${event++} originNull=${Number(origin === null)} entity=${entity} channel=${channel} sound=${handle(pcm)} time=${cg.time} oldTime=${cg.oldTime}`);
      },
    });
  }

  let audio = makeAudio();

  function reset(name: string): void {
    cg = new ClientGameState(product, 7, 0);
    ps = createPlayerState(product);
    ps.clientNum = 7;
    cg.snap = {
      messageNumber: 1,
      serverTime: 0,
      deltaNumber: -1,
      flags: 0,
      serverCommandNumber: 0,
      parseEntitiesNumber: 0,
      areaMask: new Uint8Array(32),
      playerState: ps,
      entities: [],
    };
    wearHandle = 700;
    audio = makeAudio();
    event = 0;
    lines.push(`CASE ${name}`);
  }

  function state(name: string): void {
    lines.push(`STATE ${name} in=${cg.soundBufferIn} out=${cg.soundBufferOut} soundTime=${cg.soundTime} time=${cg.time} events=${event} slots=${cg.soundBuffer.map(handle).join(",")}`);
  }

  function verifyOutOfRangeRead(): void {
    try {
      audio.playBufferedSounds();
    } catch (error) {
      if (error instanceof RangeError) return;
      throw error;
    }
    throw new Error("Expected the out-of-range sound-buffer read to throw RangeError");
  }

  function play(name: string, clock: number): void {
    cg.time = clock;
    if (cg.soundTime < cg.time && cg.soundBufferOut !== cg.soundBufferIn
      && (cg.soundBufferOut < 0 || cg.soundBufferOut >= 20)) {
      verifyOutOfRangeRead();
      lines.push(`UNSAFE_NEXT_READ ${name} out=${cg.soundBufferOut} limit=20; original function deliberately not called`);
      return;
    }
    audio.playBufferedSounds();
    state(name);
  }

  function powers(name: string, old: number, clock: number, slot: number, expiry: number): void {
    reset(name);
    cg.oldTime = old;
    cg.time = clock;
    ps.powerups.set(slot, expiry);
    lines.push(`INPUT oldTime=${old} time=${clock} slot=${slot} expiry=${expiry}`);
    audio.powerupTimerSounds();
    lines.push(`POWER_RESULT events=${event}`);
  }

  lines.push("CONSTANTS buffer=20 powers=16 item=4 announcer=7 blinkCount=5 blinkTime=1000");
  reset("strict_clock_and_gap");
  audio.addBufferedSound(null);
  state("zero_ignored");
  audio.addBufferedSound(sound(101));
  play("equal_zero", 0);
  play("first_due", 1);
  audio.addBufferedSound(sound(102));
  play("equal_deadline", 751);
  play("second_due", 752);
  play("empty_does_not_advance_deadline", 2000);

  reset("zero_slot_stalls");
  cg.soundBufferIn = 2;
  cg.soundBuffer[1] = sound(111);
  play("zero_head", 1);
  play("zero_head_again", 10000);

  reset("full_queue_oldest_safe");
  for (let index = 1; index <= 38; index++) audio.addBufferedSound(sound(index));
  state("38_additions");
  play("oldest_is_20", 1);
  play("wrap_out_equal_deadline", 751);
  play("next_is_21", 752);

  reset("full_queue_out_of_range_boundary");
  for (let index = 1; index <= 39; index++) {
    audio.addBufferedSound(sound(index));
    if (index >= 38) state(index === 38 ? "before_boundary" : "out_reaches_20");
  }
  play("would_read_slot_20", 1);

  reset("queue_clock_wrap");
  audio.addBufferedSound(sound(201));
  audio.addBufferedSound(sound(202));
  play("addition_wraps_deadline", 2147483547);
  play("signed_deadline_is_already_less", 2147483547);

  reset("queue_negative_clock_gate");
  audio.addBufferedSound(sound(211));
  play("negative_clock_before_zero_deadline", -2147483648);

  powers("expiry_equal_current", 9000, 10000, 0, 10000);
  powers("remaining_exactly_5000", 9999, 10000, 0, 15000);
  powers("remaining_4998_same_bucket", 10001, 10002, 0, 15000);
  powers("remaining_4999_crossing", 9999, 10001, 0, 15000);
  powers("remaining_999_crossing", 9999, 10001, 15, 11000);
  powers("remaining_1_same_bucket", 9999, 10001, 0, 10002);
  powers("remaining_1_crossing", 9001, 10001, 0, 10002);
  powers("unchanged_clock", 10001, 10001, 0, 11000);
  powers("backward_clock_crosses_bucket", 10001, 9999, 0, 11000);
  powers("negative_old_clock_wrap", -2147483648, 10000, 0, 12000);
  powers("large_remaining_skips_despite_old_subtraction_wrap", -1, 1, 0, 2147483647);
  powers("wrapped_current_with_positive_expiry", 0, -1, 0, 2147483647);
  powers("expiry_signed_before_current", 2147483646, 2147483647, 0, -2147482648);

  reset("multiple_powerup_slots");
  cg.oldTime = 9999;
  cg.time = 10001;
  ps.powerups.set(0, 11000);
  ps.powerups.set(3, 13000);
  ps.powerups.set(15, 15000);
  audio.powerupTimerSounds();
  lines.push(`POWER_RESULT events=${event}`);

  reset("combined_trap_order");
  cg.oldTime = 9999;
  cg.time = 10001;
  audio.addBufferedSound(sound(301));
  ps.powerups.set(2, 11000);
  ps.powerups.set(9, 13000);
  audio.playBufferedSounds();
  audio.powerupTimerSounds();
  state("complete");

  reset("all_powerup_slots");
  cg.oldTime = 1000;
  cg.time = 1001;
  for (let slot = 0; slot < 16; slot++) ps.powerups.set(slot, 2000);
  audio.powerupTimerSounds();
  lines.push(`POWER_RESULT events=${event}`);

  reset("zero_wear_handle_is_forwarded");
  cg.oldTime = 1000;
  cg.time = 1001;
  wearHandle = 0;
  audio = makeAudio();
  ps.powerups.set(6, 2000);
  audio.powerupTimerSounds();
  lines.push(`POWER_RESULT events=${event}`);

  return `${lines.join("\n")}\n`;
}

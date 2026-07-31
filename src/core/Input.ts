import type { InputState, SettingsState } from './types';
import { clamp, clamp01, deadzone, expoCurve } from './MathUtils';

/** Actions the player can rebind. */
export type Action =
  | 'throttle'
  | 'brake'
  | 'steerLeft'
  | 'steerRight'
  | 'handbrake'
  | 'boost'
  | 'horn'
  | 'lookBack'
  | 'pause'
  | 'camera'
  | 'reset'
  | 'airPitchUp'
  | 'airPitchDown'
  | 'airRollLeft'
  | 'airRollRight';

export const DEFAULT_BINDINGS: Record<Action, string[]> = {
  throttle: ['KeyW', 'ArrowUp'],
  brake: ['KeyS', 'ArrowDown'],
  steerLeft: ['KeyA', 'ArrowLeft'],
  steerRight: ['KeyD', 'ArrowRight'],
  handbrake: ['Space'],
  boost: ['ShiftLeft', 'ShiftRight'],
  horn: ['KeyH'],
  lookBack: ['KeyC'],
  pause: ['Escape', 'KeyP'],
  camera: ['KeyV'],
  reset: ['KeyR'],
  airPitchUp: ['KeyS', 'ArrowDown'],
  airPitchDown: ['KeyW', 'ArrowUp'],
  airRollLeft: ['KeyA', 'ArrowLeft'],
  airRollRight: ['KeyD', 'ArrowRight'],
};

/**
 * What a virtual (touch) controller writes into.
 *
 * The analogue fields are levels — held for as long as the finger is down. The
 * three `*Pressed` fields are edges: the overlay sets them true, and the next
 * `Input.poll` consumes them, so a tap fires exactly once no matter how many
 * frames it spans.
 */
export interface TouchInputChannel {
  /** true while a touch overlay is mounted and driving this channel */
  active: boolean;
  throttle: number;
  brake: number;
  steer: number;
  handbrake: number;
  boost: boolean;
  horn: boolean;
  lookBack: boolean;
  pausePressed: boolean;
  cameraPressed: boolean;
  resetPressed: boolean;
}

/**
 * The single touch channel every `Input` instance reads.
 *
 * The on-screen controls are built by the UI layer, which never sees the
 * `Input` the game constructed in `main`. Sharing one module-level object is
 * what connects the two without threading a reference through five constructors
 * — and it stays a plain mutable record, so writing to it costs nothing.
 */
export const touchChannel: TouchInputChannel = {
  active: false,
  throttle: 0,
  brake: 0,
  steer: 0,
  handbrake: 0,
  boost: false,
  horn: false,
  lookBack: false,
  pausePressed: false,
  cameraPressed: false,
  resetPressed: false,
};

/** Zero every level and edge on the shared channel (blur, unmount, portrait). */
export function resetTouchChannel(): void {
  touchChannel.throttle = 0;
  touchChannel.brake = 0;
  touchChannel.steer = 0;
  touchChannel.handbrake = 0;
  touchChannel.boost = false;
  touchChannel.horn = false;
  touchChannel.lookBack = false;
  touchChannel.pausePressed = false;
  touchChannel.cameraPressed = false;
  touchChannel.resetPressed = false;
}

const EMPTY: InputState = {
  throttle: 0,
  brake: 0,
  steer: 0,
  handbrake: 0,
  boost: false,
  horn: false,
  lookBack: false,
  airPitch: 0,
  airRoll: 0,
  pausePressed: false,
  cameraPressed: false,
  resetPressed: false,
  usingGamepad: false,
};

/**
 * Collects keyboard, gamepad and touch into one normalised InputState.
 *
 * Keyboard steering is smoothed (a digital key would otherwise snap the wheels
 * to full lock); analogue sticks pass through a deadzone + expo curve instead.
 */
export class Input {
  readonly state: InputState = { ...EMPTY };

  private keys = new Set<string>();
  private pressedThisFrame = new Set<string>();
  private bindings: Record<Action, string[]> = { ...DEFAULT_BINDINGS };

  /** smoothed keyboard steer, -1..1 */
  private keySteer = 0;
  private gamepadIndex: number | null = null;
  private lastGamepadActivity = 0;

  /** when set, the test hook / cutscenes override real input */
  private override: Partial<InputState> | null = null;

  /** virtual touch controls write here — see `touchChannel` */
  readonly touch: TouchInputChannel = touchChannel;

  private disposers: Array<() => void> = [];

  constructor(private target: EventTarget = window) {
    const onKeyDown = (e: Event) => {
      const ev = e as KeyboardEvent;
      if (ev.repeat) return;
      // let the browser keep refresh/devtools/fullscreen shortcuts
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      this.keys.add(ev.code);
      this.pressedThisFrame.add(ev.code);
      if (SWALLOWED.has(ev.code)) ev.preventDefault();
    };
    const onKeyUp = (e: Event) => {
      this.keys.delete((e as KeyboardEvent).code);
    };
    const onBlur = () => {
      this.keys.clear();
      this.keySteer = 0;
    };
    const onGamepadConnected = (e: Event) => {
      this.gamepadIndex = (e as GamepadEvent).gamepad.index;
    };
    const onGamepadDisconnected = (e: Event) => {
      if (this.gamepadIndex === (e as GamepadEvent).gamepad.index) this.gamepadIndex = null;
    };

    this.target.addEventListener('keydown', onKeyDown);
    this.target.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    window.addEventListener('gamepadconnected', onGamepadConnected);
    window.addEventListener('gamepaddisconnected', onGamepadDisconnected);

    this.disposers.push(
      () => this.target.removeEventListener('keydown', onKeyDown),
      () => this.target.removeEventListener('keyup', onKeyUp),
      () => window.removeEventListener('blur', onBlur),
      () => window.removeEventListener('gamepadconnected', onGamepadConnected),
      () => window.removeEventListener('gamepaddisconnected', onGamepadDisconnected),
    );
  }

  setBindings(b: Partial<Record<Action, string[]>>): void {
    this.bindings = { ...this.bindings, ...b };
  }

  getBindings(): Record<Action, string[]> {
    return { ...this.bindings };
  }

  /** Force a specific input state — used by the headless test hook. */
  setOverride(partial: Partial<InputState> | null): void {
    this.override = partial;
  }

  private down(action: Action): boolean {
    const codes = this.bindings[action];
    for (const c of codes) if (this.keys.has(c)) return true;
    return false;
  }

  private edge(action: Action): boolean {
    const codes = this.bindings[action];
    for (const c of codes) if (this.pressedThisFrame.has(c)) return true;
    return false;
  }

  /** Call once per frame, before any system reads `state`. */
  poll(dt: number, settings: SettingsState, airborne: boolean): InputState {
    const s = this.state;

    /* ---- keyboard ---- */
    let throttle = this.down('throttle') ? 1 : 0;
    let brake = this.down('brake') ? 1 : 0;
    const steerTarget = (this.down('steerRight') ? 1 : 0) - (this.down('steerLeft') ? 1 : 0);
    let handbrake = this.down('handbrake') ? 1 : 0;
    let boost = this.down('boost');
    let horn = this.down('horn');
    let lookBack = this.down('lookBack');

    // Ramp digital steering so keyboard players get an analogue-feeling sweep,
    // and centre faster than we turn so the car settles crisply.
    const toCentre = steerTarget === 0;
    const rate = toCentre ? KEY_STEER_RETURN : KEY_STEER_RATE;
    const delta = steerTarget - this.keySteer;
    this.keySteer += clamp(delta, -rate * dt, rate * dt);
    let steer = clamp(this.keySteer, -1, 1);

    /* ---- gamepad ---- */
    let usingGamepad = false;
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = this.gamepadIndex !== null ? pads[this.gamepadIndex] : (pads[0] ?? null);
    if (pad && pad.connected) {
      const rt = pad.buttons[7]?.value ?? 0;
      const lt = pad.buttons[6]?.value ?? 0;
      const lx = deadzone(pad.axes[0] ?? 0);
      const anyPadInput =
        rt > 0.02 || lt > 0.02 || Math.abs(lx) > 0.02 || pad.buttons.some((b) => b.pressed);
      if (anyPadInput) {
        this.lastGamepadActivity = performance.now();
        usingGamepad = true;
        throttle = Math.max(throttle, rt);
        brake = Math.max(brake, lt);
        if (Math.abs(lx) > Math.abs(steer)) steer = expoCurve(lx, 0.3);
        handbrake = Math.max(handbrake, pad.buttons[0]?.pressed ? 1 : 0); // A
        boost = boost || !!pad.buttons[1]?.pressed; // B
        horn = horn || !!pad.buttons[2]?.pressed; // X
        lookBack = lookBack || !!pad.buttons[11]?.pressed; // R3
      }
    }
    if (!usingGamepad && performance.now() - this.lastGamepadActivity < 1500) usingGamepad = true;

    /* ---- touch ---- */
    const t = this.touch;
    if (t.active) {
      throttle = Math.max(throttle, t.throttle);
      brake = Math.max(brake, t.brake);
      if (Math.abs(t.steer) > Math.abs(steer)) steer = t.steer;
      handbrake = Math.max(handbrake, t.handbrake);
      boost = boost || t.boost;
      horn = horn || t.horn;
      lookBack = lookBack || t.lookBack;
    }

    /* ---- accessibility ---- */
    if (settings.autoAccelerate && brake < 0.05) throttle = 1;

    /* ---- midair remap: the steering keys become pitch/roll in the air ---- */
    let airPitch = 0;
    let airRoll = 0;
    if (airborne) {
      airPitch = (this.down('airPitchUp') ? 1 : 0) - (this.down('airPitchDown') ? 1 : 0);
      airRoll = steer;
      if (pad && pad.connected) {
        const ly = deadzone(pad.axes[1] ?? 0);
        if (Math.abs(ly) > Math.abs(airPitch)) airPitch = expoCurve(ly, 0.3);
      }
      if (settings.invertLook) airPitch = -airPitch;
    }

    s.throttle = clamp01(throttle);
    s.brake = clamp01(brake);
    s.steer = clamp(steer, -1, 1);
    s.handbrake = clamp01(handbrake);
    s.boost = boost;
    s.horn = horn;
    s.lookBack = lookBack;
    s.airPitch = clamp(airPitch, -1, 1);
    s.airRoll = clamp(airRoll, -1, 1);
    s.pausePressed = this.edge('pause') || !!pad?.buttons[9]?.pressed || t.pausePressed;
    s.cameraPressed = this.edge('camera') || !!pad?.buttons[8]?.pressed || t.cameraPressed;
    s.resetPressed = this.edge('reset') || !!pad?.buttons[3]?.pressed || t.resetPressed;
    s.usingGamepad = usingGamepad;

    if (this.override) Object.assign(s, this.override);

    // Touch edges are consumed here: the overlay only has to set them true.
    t.pausePressed = false;
    t.cameraPressed = false;
    t.resetPressed = false;

    this.pressedThisFrame.clear();
    return s;
  }

  /** Rumble, when the pad supports it. Scaled by settings elsewhere. */
  vibrate(strong: number, weak: number, ms: number): void {
    const pads = navigator.getGamepads?.() ?? [];
    const pad = this.gamepadIndex !== null ? pads[this.gamepadIndex] : (pads[0] ?? null);
    const actuator = (pad as (Gamepad & { vibrationActuator?: GamepadHapticActuator }) | null)
      ?.vibrationActuator;
    if (!actuator || typeof actuator.playEffect !== 'function') return;
    void actuator
      .playEffect('dual-rumble', {
        duration: ms,
        strongMagnitude: clamp01(strong),
        weakMagnitude: clamp01(weak),
      })
      .catch(() => {
        /* some browsers reject unsupported effects */
      });
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
    this.keys.clear();
  }
}

/** Keys we stop the browser from acting on (scrolling, quick-find). */
const SWALLOWED = new Set([
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'Slash',
]);

/** How fast digital steering sweeps to full lock, and returns to centre. */
const KEY_STEER_RATE = 3.4;
const KEY_STEER_RETURN = 6.0;

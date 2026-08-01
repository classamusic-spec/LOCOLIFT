/**
 * Loco Lift — canvas minimap.
 *
 * The static road network is rasterised **once** into an offscreen canvas when
 * the graph arrives. Every frame after that is: clear → blit the sub-rectangle
 * around the Jeep → stamp a handful of markers. No path rebuilding, no
 * per-frame allocation, no DOM churn.
 *
 * The road graph arrives through a narrow structural interface defined here, so
 * this file never imports the world module (it duck-types `RoadGraph` from
 * `core/types` without depending on it).
 *
 * Marker language is redundant with colour — shape carries the meaning too, so
 * the map still reads with `colorBlindMode` on:
 *   ▲ yellow  the Jeep      ◆ magenta destination
 *   ● cyan    waiting fare  ▪ pale    traffic
 */
import { clamp, clamp01 } from '../core/MathUtils';
import type { SettingsState } from '../core/types';
import { el, UITheme, withAlpha } from './UITheme';

/* ------------------------------------------------- structural world inputs */

export interface MinimapPoint {
  readonly x: number;
  readonly z: number;
}

export interface MinimapNode {
  readonly pos: MinimapPoint;
}

export interface MinimapEdge {
  readonly a: number;
  readonly b: number;
  readonly width: number;
  readonly kind: string;
  readonly via: ReadonlyArray<MinimapPoint>;
}

/** The only shape the minimap needs from a road network. */
export interface MinimapGraph {
  readonly nodes: ReadonlyArray<MinimapNode>;
  readonly edges: ReadonlyArray<MinimapEdge>;
}

export interface MinimapBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

/* ------------------------------------------------------------- appearance */

const BASE_SIZE = 194;
const VIEW_RADIUS = 135; // metres visible from the centre to the ring
const MAX_OFFSCREEN = 2048;

const ROAD_TONE: Record<string, { fill: string; scale: number }> = {
  street: { fill: '#8493A3', scale: 1 },
  alley: { fill: '#5C6875', scale: 0.8 },
  coastal: { fill: '#9AA9B8', scale: 1.05 },
  plaza: { fill: '#98A3AE', scale: 1.15 },
  stairs: { fill: '#6E7C8A', scale: 0.85 },
  ramp: { fill: '#C7A24A', scale: 1 },
  rooftop: { fill: '#6A5F7A', scale: 0.85 },
};

const GROUND = '#111E29';
const CASING = '#060B10';

/* ------------------------------------------------------------------ class */

export class Minimap {
  readonly el: HTMLElement;

  private readonly theme: UITheme;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;

  private off: HTMLCanvasElement | null = null;
  private offScale = 1; // px per metre in the offscreen
  private bounds: MinimapBounds = { minX: -500, maxX: 500, minZ: -500, maxZ: 500 };

  private size = BASE_SIZE;
  private dpr = 1;
  private rotates = true;

  private px = 0;
  private pz = 0;
  private heading = 0;

  private destX = 0;
  private destZ = 0;
  private hasDest = false;

  private passengers = new Float32Array(0);
  private passengerCount = 0;
  private traffic = new Float32Array(0);
  private trafficCount = 0;

  private visible = true;
  private pulse = 0;

  constructor(theme: UITheme) {
    this.theme = theme;
    this.el = el('div', 'll-minimap');
    this.el.setAttribute('role', 'img');
    this.el.setAttribute('aria-label', 'Minimap of Old San Juan');

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'll-minimap__canvas';
    this.ctx = this.canvas.getContext('2d');

    const ring = el('div', 'll-minimap__ring');
    const cardinal = el('div', 'll-minimap__n', 'N');
    this.el.append(this.canvas, ring, cardinal);
    this.resize();
  }

  mount(parent: HTMLElement): void {
    parent.append(this.el);
  }

  unmount(): void {
    this.el.remove();
  }

  setVisible(v: boolean): void {
    if (v === this.visible) return;
    this.visible = v;
    this.el.classList.toggle('is-hidden', !v);
  }

  applySettings(s: SettingsState): void {
    this.rotates = s.minimapRotates;
    this.el.dataset.rotates = s.minimapRotates ? '1' : '0';
    // The floor used to be 0.75. A landscape phone needs to go below that —
    // `UISystem` hands us a viewport-derived scale there — but not so far that
    // the road lines stop resolving, which is what 0.42 (≈82 px) protects.
    const next = Math.round(BASE_SIZE * clamp(s.uiScale, 0.42, 1.5));
    if (next !== this.size) {
      this.size = next;
      this.resize();
    }
  }

  /* ----------------------------------------------------------- static bake */

  /** Rasterise the road network once. Safe to call again if the world reloads. */
  setGraph(graph: MinimapGraph, bounds: MinimapBounds): void {
    this.bounds = bounds;
    const w = Math.max(1, bounds.maxX - bounds.minX);
    const h = Math.max(1, bounds.maxZ - bounds.minZ);
    const pad = 24; // metres of margin so edge roads aren't clipped
    const spanW = w + pad * 2;
    const spanH = h + pad * 2;

    this.offScale = Math.min(2.0, MAX_OFFSCREEN / spanW, MAX_OFFSCREEN / spanH);
    const cw = Math.max(2, Math.ceil(spanW * this.offScale));
    const ch = Math.max(2, Math.ceil(spanH * this.offScale));

    const off = this.off ?? document.createElement('canvas');
    off.width = cw;
    off.height = ch;
    this.off = off;

    const c = off.getContext('2d');
    if (!c) return;

    c.clearRect(0, 0, cw, ch);
    c.fillStyle = GROUND;
    c.fillRect(0, 0, cw, ch);

    const ox = (x: number): number => (x - bounds.minX + pad) * this.offScale;
    const oz = (z: number): number => (z - bounds.minZ + pad) * this.offScale;

    const nodes = graph.nodes;
    // Two passes: dark casing under, tone on top. That contrast is what makes a
    // minimap readable at a glance.
    for (let pass = 0; pass < 2; pass++) {
      c.lineCap = 'round';
      c.lineJoin = 'round';
      for (let i = 0; i < graph.edges.length; i++) {
        const e = graph.edges[i];
        const a = nodes[e.a];
        const b = nodes[e.b];
        if (!a || !b) continue;
        const tone = ROAD_TONE[e.kind] ?? ROAD_TONE.street;
        const base = Math.max(1.6, e.width * this.offScale * tone.scale);
        c.strokeStyle = pass === 0 ? CASING : tone.fill;
        c.lineWidth = pass === 0 ? base + 2.4 : base;
        c.beginPath();
        c.moveTo(ox(a.pos.x), oz(a.pos.z));
        for (let v = 0; v < e.via.length; v++) c.lineTo(ox(e.via[v].x), oz(e.via[v].z));
        c.lineTo(ox(b.pos.x), oz(b.pos.z));
        c.stroke();
      }
    }

    // Junction dots keep the grid legible when roads thin out at small scales.
    c.fillStyle = 'rgba(255, 246, 232, 0.10)';
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      c.beginPath();
      c.arc(ox(n.pos.x), oz(n.pos.z), 1.6, 0, Math.PI * 2);
      c.fill();
    }
  }

  /* -------------------------------------------------------------- dynamic */

  setPlayer(x: number, z: number, heading: number): void {
    this.px = x;
    this.pz = z;
    this.heading = heading;
  }

  setDestination(x: number, z: number): void {
    this.destX = x;
    this.destZ = z;
    this.hasDest = true;
  }

  clearDestination(): void {
    this.hasDest = false;
  }

  /** Waiting fares. The array is copied; the caller keeps ownership of theirs. */
  setPassengerMarkers(points: ReadonlyArray<MinimapPoint>): void {
    this.passengerCount = this.copyInto(points, 'passengers');
  }

  setTrafficMarkers(points: ReadonlyArray<MinimapPoint>): void {
    this.trafficCount = this.copyInto(points, 'traffic');
  }

  private copyInto(points: ReadonlyArray<MinimapPoint>, which: 'passengers' | 'traffic'): number {
    const n = points.length;
    let buf = which === 'passengers' ? this.passengers : this.traffic;
    if (buf.length < n * 2) {
      buf = new Float32Array(Math.max(16, n * 2));
      if (which === 'passengers') this.passengers = buf;
      else this.traffic = buf;
    }
    for (let i = 0; i < n; i++) {
      buf[i * 2] = points[i].x;
      buf[i * 2 + 1] = points[i].z;
    }
    return n;
  }

  /* ----------------------------------------------------------------- draw */

  update(dt: number): void {
    const c = this.ctx;
    if (!c || !this.visible) return;

    this.pulse = (this.pulse + dt) % 1.6;
    const px = this.size * this.dpr;
    const R = px * 0.5;
    const scale = R / VIEW_RADIUS;

    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, px, px);
    c.save();
    c.beginPath();
    c.arc(R, R, R, 0, Math.PI * 2);
    c.clip();

    c.fillStyle = GROUND;
    c.fillRect(0, 0, px, px);

    const rot = this.rotates ? -this.heading : 0;
    const cosA = Math.cos(rot);
    const sinA = Math.sin(rot);

    /* static map ------------------------------------------------------- */
    const off = this.off;
    if (off) {
      const spanM = VIEW_RADIUS * 2 * 1.5;
      const sw = spanM * this.offScale;
      const sx = (this.px - this.bounds.minX + 24) * this.offScale - sw * 0.5;
      const sy = (this.pz - this.bounds.minZ + 24) * this.offScale - sw * 0.5;
      const dw = spanM * scale;
      c.save();
      c.translate(R, R);
      if (rot !== 0) c.rotate(rot);
      c.imageSmoothingEnabled = true;
      c.drawImage(off, sx, sy, sw, sw, -dw * 0.5, -dw * 0.5, dw, dw);
      c.restore();
    }

    /* traffic ---------------------------------------------------------- */
    c.fillStyle = 'rgba(232, 240, 246, 0.72)';
    for (let i = 0; i < this.trafficCount; i++) {
      const dx = this.traffic[i * 2] - this.px;
      const dz = this.traffic[i * 2 + 1] - this.pz;
      if (dx * dx + dz * dz > VIEW_RADIUS * VIEW_RADIUS) continue;
      const lx = R + (dx * cosA - dz * sinA) * scale;
      const ly = R + (dx * sinA + dz * cosA) * scale;
      c.fillRect(lx - 1.6 * this.dpr, ly - 1.6 * this.dpr, 3.2 * this.dpr, 3.2 * this.dpr);
    }

    /* waiting fares ---------------------------------------------------- */
    const pickup = this.theme.color('pickup');
    const beat = 0.5 + 0.5 * Math.sin(this.pulse * Math.PI * 2 * (this.theme.flashSafe ? 0 : 1));
    for (let i = 0; i < this.passengerCount; i++) {
      const dx = this.passengers[i * 2] - this.px;
      const dz = this.passengers[i * 2 + 1] - this.pz;
      const d2 = dx * dx + dz * dz;
      if (d2 > VIEW_RADIUS * VIEW_RADIUS) continue;
      const lx = R + (dx * cosA - dz * sinA) * scale;
      const ly = R + (dx * sinA + dz * cosA) * scale;
      const r = (3.4 + beat * 1.1) * this.dpr;
      c.beginPath();
      c.arc(lx, ly, r + 1.6 * this.dpr, 0, Math.PI * 2);
      c.fillStyle = CASING;
      c.fill();
      c.beginPath();
      c.arc(lx, ly, r, 0, Math.PI * 2);
      c.fillStyle = pickup;
      c.fill();
    }

    /* destination ------------------------------------------------------ */
    if (this.hasDest) {
      const dx = this.destX - this.px;
      const dz = this.destZ - this.pz;
      let lx = dx * cosA - dz * sinA;
      let ly = dx * sinA + dz * cosA;
      const dist = Math.hypot(lx, ly);
      const edge = VIEW_RADIUS * 0.88;
      const clamped = dist > edge;
      const k = clamped ? edge / Math.max(dist, 1e-3) : 1;
      lx = R + lx * k * scale;
      ly = R + ly * k * scale;
      this.drawDiamond(c, lx, ly, (clamped ? 5.6 : 6.6) * this.dpr, this.theme.color('dest'));
      if (clamped) {
        const ang = Math.atan2(ly - R, lx - R);
        c.save();
        c.translate(lx, ly);
        c.rotate(ang);
        c.fillStyle = this.theme.color('dest');
        c.strokeStyle = CASING;
        c.lineWidth = 1.4 * this.dpr;
        c.beginPath();
        c.moveTo(9 * this.dpr, 0);
        c.lineTo(2.4 * this.dpr, -4 * this.dpr);
        c.lineTo(2.4 * this.dpr, 4 * this.dpr);
        c.closePath();
        c.fill();
        c.stroke();
        c.restore();
      }
    }

    /* the Jeep --------------------------------------------------------- */
    const jeepAngle = this.rotates ? 0 : this.heading;
    c.save();
    c.translate(R, R);
    c.rotate(jeepAngle);
    c.beginPath();
    c.moveTo(0, -8.4 * this.dpr);
    c.lineTo(6.2 * this.dpr, 7.4 * this.dpr);
    c.lineTo(0, 4.2 * this.dpr);
    c.lineTo(-6.2 * this.dpr, 7.4 * this.dpr);
    c.closePath();
    c.fillStyle = this.theme.color('player');
    c.strokeStyle = CASING;
    c.lineWidth = 2 * this.dpr;
    c.stroke();
    c.fill();
    c.restore();

    /* compass ---------------------------------------------------------- */
    c.save();
    c.translate(R, R);
    c.rotate(rot);
    const ringR = R - 4 * this.dpr;
    for (let i = 0; i < 4; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 2;
      const inner = i === 0 ? ringR - 9 * this.dpr : ringR - 5 * this.dpr;
      c.beginPath();
      c.moveTo(Math.cos(a) * ringR, Math.sin(a) * ringR);
      c.lineTo(Math.cos(a) * inner, Math.sin(a) * inner);
      c.strokeStyle = i === 0 ? withAlpha(this.theme.color('paper'), 0.85) : 'rgba(255,246,232,0.3)';
      c.lineWidth = (i === 0 ? 2.6 : 1.6) * this.dpr;
      c.stroke();
    }
    c.restore();

    c.restore();
  }

  private drawDiamond(
    c: CanvasRenderingContext2D,
    x: number,
    y: number,
    r: number,
    fill: string,
  ): void {
    c.beginPath();
    c.moveTo(x, y - r);
    c.lineTo(x + r, y);
    c.lineTo(x, y + r);
    c.lineTo(x - r, y);
    c.closePath();
    c.fillStyle = fill;
    c.strokeStyle = CASING;
    c.lineWidth = 2 * this.dpr;
    c.stroke();
    c.fill();
  }

  /* --------------------------------------------------------------- sizing */

  private resize(): void {
    this.dpr = Math.min(2, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1);
    const px = Math.round(this.size * this.dpr);
    this.canvas.width = px;
    this.canvas.height = px;
    this.canvas.style.width = `${this.size}px`;
    this.canvas.style.height = `${this.size}px`;
    this.el.style.setProperty('--map-size', `${this.size}px`);
  }

  /** 0..1 fraction of the map radius the destination sits at (for the arrow). */
  destinationFraction(): number {
    if (!this.hasDest) return 0;
    const d = Math.hypot(this.destX - this.px, this.destZ - this.pz);
    return clamp01(d / VIEW_RADIUS);
  }

  dispose(): void {
    this.unmount();
    if (this.off) {
      this.off.width = 0;
      this.off.height = 0;
      this.off = null;
    }
    this.canvas.width = 0;
    this.canvas.height = 0;
  }
}

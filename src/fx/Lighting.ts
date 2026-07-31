/**
 * Loco Lift — the lighting rig.
 *
 * Owns the key light (sun by day, moon by night), the hemisphere and ambient
 * fill, the warm bounce fill, exponential fog, the shadow camera, and the
 * street-lamp field. Driven entirely by `LightingPresets`.
 *
 * Three things this module exists to fix:
 *
 * 1. **Shadowed ground going black at low sun.** A `HemisphereLight` at the
 *    reference's 0.5–0.6 intensity is not enough fill on its own once ACES has
 *    compressed the frame. The rig adds (a) a per-preset `AmbientLight` floor,
 *    (b) a shadowless warm **bounce** directional coming back from the sunlit
 *    surfaces opposite — the light §8.42 says must be there — and (c) the sky
 *    IBL that `Sky` captures. Together they hold daylight mean luminance inside
 *    the §6.4 band without washing the shadows out.
 *
 * 2. **Mushy shadows.** The old rig pointed a ±155 m ortho box at the whole
 *    district. This one fits a much tighter box just ahead of the player and
 *    snaps it to the shadow map's texel grid *in light space*, so edges neither
 *    smear nor crawl while driving.
 *
 * 3. **Golden hour not raking the streets.** The city is not rotated (see
 *    `ARCHITECTURE.md` "Reconciliation notes"). Instead the whole solar frame is
 *    offset by the road graph's dominant street bearing — a length-weighted
 *    circular mean of the edge tangents, mod 180° — so dawn and dusk fire
 *    straight down the calles largas whatever seed the layout was built with.
 *
 * Night lighting deliberately does **not** use 200 real point lights. Every
 * lamp is an instanced emissive mesh (2 draw calls for the whole city), and a
 * small fixed-size pool of real `PointLight`s is re-targeted at the lamps
 * nearest the player each frame. The pool size never changes, so the renderer
 * never recompiles a program mid-drive; the emissive globes carry the look at
 * distance and feed the bloom, and the real lights carry the pool of light on
 * the adoquín where the player actually needs to read the road.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { QUALITY_BUDGET } from '../core/Config';
import { clamp, clamp01, damp } from '../core/MathUtils';
import type { GameContext, QualityTier, RoadGraph, SettingsState } from '../core/types';
import type { MaterialLibrary } from '../world/Materials';
import {
  POST_STATE,
  createLightingState,
  evaluateLighting,
  pushPostState,
  type LightingState,
  type SkyWeather,
} from './LightingPresets';

/* -------------------------------------------------------------- constants */

/** Half-width of the fitted shadow box, metres. */
const SHADOW_EXTENT: Record<QualityTier, number> = {
  low: 62,
  medium: 82,
  high: 112,
  ultra: 145,
};

/** How far up-light the shadow camera sits. Must clear the fort (43 m). */
const SHADOW_DISTANCE = 260;

/** Real point lights kept alive for the lamp pool. Constant per tier. */
const LAMP_POOL: Record<QualityTier, number> = { low: 0, medium: 3, high: 6, ultra: 8 };

/** Instanced lamp posts placed along the road graph. */
const LAMP_BUDGET: Record<QualityTier, number> = { low: 0, medium: 220, high: 380, ultra: 560 };

/** §1.8 — lamps every 21 m, alternating sides. */
const LAMP_SPACING = 21;

/**
 * Candela for a street lantern. The reference's "4.0" predates three dropping
 * `useLegacyLights`; in physical units (irradiance = I / d²) a 4 cd lamp at 4 m
 * is invisible. 38 cd puts roughly the same irradiance on the road at 4 m as
 * the 3.6-intensity midday sun does, which is what a sodium pool should look
 * like against an otherwise black street.
 */
const LAMP_CANDELA = 38;
const LAMP_RANGE = 15;

const UP = new THREE.Vector3(0, 1, 0);
const ZERO = new THREE.Vector3(0, 0, 0);
const DEG = Math.PI / 180;

/* ------------------------------------------------- dominant street bearing */

/**
 * Length-weighted circular mean of the road tangents, mod 180°, in the
 * reference azimuth frame (`az = atan2(tx, -tz)`).
 *
 * A regular grid has two perpendicular families whose doubled-angle vectors
 * cancel, so when the resultant is weak the mean is recomputed over just the
 * heaviest 5° bin's neighbourhood — that is what picks the *calles largas* out
 * of a square grid rather than returning noise.
 */
export function dominantStreetBearing(roads: RoadGraph): number {
  const BINS = 36;
  const BIN_DEG = 180 / BINS;
  const hist = new Float64Array(BINS);
  let sx = 0;
  let sy = 0;
  let total = 0;

  for (const e of roads.edges) {
    if (e.kind === 'stairs' || e.kind === 'ramp' || e.kind === 'rooftop') continue;
    const na = roads.nodes[e.a];
    const nb = roads.nodes[e.b];
    if (!na || !nb) continue;
    const dx = nb.pos.x - na.pos.x;
    const dz = nb.pos.z - na.pos.z;
    const len = Math.hypot(dx, dz);
    if (len < 4) continue;
    const az = Math.atan2(dx, -dz);
    // coastal roads follow the shoreline, not the colonial grid — down-weight
    const w = len * (e.kind === 'coastal' ? 0.45 : e.kind === 'alley' ? 0.7 : 1);
    sx += w * Math.cos(2 * az);
    sy += w * Math.sin(2 * az);
    total += w;
    let deg = ((az / DEG) % 180 + 180) % 180;
    let bin = Math.floor(deg / BIN_DEG);
    if (bin >= BINS) bin = BINS - 1;
    hist[bin] += w;
  }

  if (total <= 0) return 90;

  const resultant = Math.hypot(sx, sy) / total;
  if (resultant > 0.2) {
    const deg = 0.5 * Math.atan2(sy, sx) / DEG;
    return ((deg % 180) + 180) % 180;
  }

  let best = 0;
  for (let i = 1; i < BINS; i++) if (hist[i] > hist[best]) best = i;
  const centre = (best + 0.5) * BIN_DEG;
  let ax = 0;
  let ay = 0;
  for (let i = 0; i < BINS; i++) {
    const c = (i + 0.5) * BIN_DEG;
    let d = c - centre;
    if (d > 90) d -= 180;
    if (d < -90) d += 180;
    if (Math.abs(d) > 30) continue;
    const rad = 2 * c * DEG;
    ax += hist[i] * Math.cos(rad);
    ay += hist[i] * Math.sin(rad);
  }
  if (ax === 0 && ay === 0) return centre;
  const deg = 0.5 * Math.atan2(ay, ax) / DEG;
  return ((deg % 180) + 180) % 180;
}

/* ----------------------------------------------------------- lamp records */

interface LampSite {
  x: number;
  y: number;
  z: number;
}

/* ------------------------------------------------------------------ opts */

export interface LightingOpts {
  scene: THREE.Scene;
  quality: QualityTier;
  roads: RoadGraph;
  materials: MaterialLibrary;
  groundHeight(x: number, z: number): number;
}

/* -------------------------------------------------------------- lighting */

export class Lighting {
  /** Added to the world root by `World`. Holds lights and the lamp field. */
  readonly group = new THREE.Group();
  readonly sun = new THREE.DirectionalLight(0xfff8ec, 3.6);
  readonly fog = new THREE.FogExp2(0xc6dcec, 0.0009);
  readonly state: LightingState = createLightingState();

  /** dominant street bearing, degrees in the reference azimuth frame */
  readonly streetBearingDeg: number;
  /** rotation applied to every preset azimuth so the sun rakes the long streets */
  readonly azimuthOffsetDeg: number;

  private hemi = new THREE.HemisphereLight(0xa9cff0, 0x8a7a62, 0.9);
  private ambient = new THREE.AmbientLight(0xa8c0d6, 0.24);
  private bounce = new THREE.DirectionalLight(0xc8b48e, 0.55);
  private lightningLight = new THREE.DirectionalLight(0xdde8ff, 0);
  private lightningAmbient = new THREE.AmbientLight(0xdde8ff, 0);

  private scene: THREE.Scene;
  private quality: QualityTier;
  private roads: RoadGraph;
  private materials: MaterialLibrary;
  private groundHeight: (x: number, z: number) => number;

  private _hours = 12;
  private _weather: SkyWeather = 'clear';
  private _weatherAmount = 0;
  private shadowsEnabled = true;

  /* lamp field */
  private lampSites: LampSite[] = [];
  private lampGrid = new Map<number, number[]>();
  private lampCell = 48;
  private lampPost: THREE.InstancedMesh | null = null;
  private lampGlobe: THREE.InstancedMesh | null = null;
  private lampGlobeMat: THREE.MeshStandardMaterial | null = null;
  private lampLights: THREE.PointLight[] = [];
  private lampCandidates: number[] = [];
  private lampScores: number[] = [];
  private _lampsEnabled = true;
  private lampLevelSmoothed = 0;

  /* shadow fit */
  private focus = new THREE.Vector3();
  private focusTarget = new THREE.Vector3();
  private lightBasis = new THREE.Matrix4();
  private tmpV = new THREE.Vector3();
  private tmpV2 = new THREE.Vector3();

  /* lightning */
  private flashTimer = 0;
  private flashDuration = 0;
  private flashPeak = 0;

  private disposed = false;

  constructor(opts: LightingOpts) {
    this.scene = opts.scene;
    this.quality = opts.quality;
    this.roads = opts.roads;
    this.materials = opts.materials;
    this.groundHeight = opts.groundHeight;

    this.streetBearingDeg = dominantStreetBearing(opts.roads);
    this.azimuthOffsetDeg = this.streetBearingDeg - 90;

    this.group.name = 'fx/lighting';

    /* --- key light --- */
    this.sun.name = 'world/sun';
    this.sun.castShadow = true;
    this.configureShadow(opts.quality);
    this.sun.target.position.set(0, 0, 0);
    this.group.add(this.sun);
    this.group.add(this.sun.target);

    /* --- fill --- */
    this.hemi.name = 'fx/hemi';
    this.ambient.name = 'fx/ambient';
    this.bounce.name = 'fx/bounce';
    this.bounce.castShadow = false;
    this.group.add(this.hemi, this.ambient, this.bounce, this.bounce.target);

    /* --- storm flash --- */
    this.lightningLight.castShadow = false;
    this.group.add(this.lightningLight, this.lightningLight.target, this.lightningAmbient);

    this.buildLamps();
    this.refresh();
  }

  /* ------------------------------------------------------------- controls */

  get timeOfDay(): number {
    return this._hours;
  }

  get weather(): SkyWeather {
    return this._weather;
  }

  get lampsEnabled(): boolean {
    return this._lampsEnabled;
  }

  /**
   * Turn the built-in lamp field off. Call this if a props module takes over
   * street furniture — the real-light pool keeps working from whatever sites
   * are registered, only the instanced geometry is hidden.
   */
  setLampsEnabled(on: boolean): void {
    this._lampsEnabled = on;
    if (this.lampPost) this.lampPost.visible = on;
    if (this.lampGlobe) this.lampGlobe.visible = on;
  }

  setTimeOfDay(hours: number): void {
    this._hours = ((hours % 24) + 24) % 24;
    this.refresh();
  }

  /** Snap the shadow focus, e.g. to the spawn point before the first frame. */
  focusOn(p: THREE.Vector3): void {
    this.focus.copy(p);
    this.focusTarget.copy(p);
    this.placeKeyLight();
  }

  /** `amount` lets a shower fade in and out instead of snapping. */
  setWeather(kind: SkyWeather, amount = kind === 'rain' || kind === 'storm' ? 1 : 0): void {
    this._weather = kind;
    this._weatherAmount = clamp01(amount);
    this.refresh();
  }

  /** Storm strike. `intensity` is a sun-equivalent; suppressed by the caller. */
  flash(intensity: number, duration = 0.08): void {
    this.flashPeak = Math.max(this.flashPeak, intensity);
    this.flashDuration = Math.max(duration, 0.02);
    this.flashTimer = this.flashDuration;
  }

  /* -------------------------------------------------------------- refresh */

  /** Re-evaluate the preset table and push it into every light. */
  private refresh(): void {
    const s = evaluateLighting(
      this._hours,
      this._weather,
      this._weatherAmount,
      this.azimuthOffsetDeg,
      this.state,
    );

    this.sun.color.copy(s.sunColor);
    this.sun.intensity = s.sunIntensity;

    this.hemi.color.copy(s.hemiSky);
    this.hemi.groundColor.copy(s.hemiGround);
    this.hemi.intensity = s.hemiIntensity;

    this.ambient.color.copy(s.ambientColor);
    this.ambient.intensity = s.ambientIntensity;

    this.bounce.color.copy(s.bounceColor);
    this.bounce.intensity = s.bounceIntensity;

    this.fog.color.copy(s.fogColor);
    this.fog.density = s.fogDensity;

    this.scene.environmentIntensity = s.envIntensity;

    pushPostState(s);
    this.placeKeyLight();
  }

  /** Re-derive the light positions from the current focus point. */
  private placeKeyLight(): void {
    const dir = this.state.sunDir;
    const ext = SHADOW_EXTENT[this.quality];
    const mapSize = QUALITY_BUDGET[this.quality].shadowMapSize;
    const texel = (ext * 2) / mapSize;

    /* Build the light-space basis exactly as three will (Matrix4.lookAt with
     * up = +Y), then snap the focus to whole texels in that space. Snapping in
     * world space is not enough: the box rotates with the sun. */
    this.tmpV.copy(dir);
    if (Math.abs(this.tmpV.y) > 0.9995) this.tmpV.y = Math.sign(this.tmpV.y) * 0.9995;
    this.tmpV.normalize();
    this.lightBasis.lookAt(this.tmpV, ZERO, UP);
    const e = this.lightBasis.elements;
    const f = this.focus;
    const lx = f.x * e[0] + f.y * e[1] + f.z * e[2];
    const ly = f.x * e[4] + f.y * e[5] + f.z * e[6];
    const lz = f.x * e[8] + f.y * e[9] + f.z * e[10];
    const sx = Math.round(lx / texel) * texel;
    const sy = Math.round(ly / texel) * texel;
    const t = this.tmpV2.set(
      e[0] * sx + e[4] * sy + e[8] * lz,
      e[1] * sx + e[5] * sy + e[9] * lz,
      e[2] * sx + e[6] * sy + e[10] * lz,
    );

    this.sun.target.position.copy(t);
    this.sun.target.updateMatrixWorld();
    this.sun.position.set(
      t.x + this.tmpV.x * SHADOW_DISTANCE,
      t.y + this.tmpV.y * SHADOW_DISTANCE,
      t.z + this.tmpV.z * SHADOW_DISTANCE,
    );
    this.sun.updateMatrixWorld();

    const b = this.state.bounceDir;
    this.bounce.target.position.copy(this.focus);
    this.bounce.target.updateMatrixWorld();
    this.bounce.position.set(
      this.focus.x + b.x * 90,
      this.focus.y + b.y * 90,
      this.focus.z + b.z * 90,
    );
    this.bounce.updateMatrixWorld();

    this.lightningLight.position.set(this.focus.x - 120, this.focus.y + 220, this.focus.z + 90);
    this.lightningLight.target.position.copy(this.focus);
    this.lightningLight.target.updateMatrixWorld();
    this.lightningLight.updateMatrixWorld();
  }

  private configureShadow(tier: QualityTier): void {
    const map = QUALITY_BUDGET[tier].shadowMapSize;
    const ext = SHADOW_EXTENT[tier];
    this.sun.shadow.mapSize.set(map, map);
    const cam = this.sun.shadow.camera;
    cam.left = -ext;
    cam.right = ext;
    cam.top = ext;
    cam.bottom = -ext;
    cam.near = 1;
    cam.far = SHADOW_DISTANCE + ext * 2.2;
    cam.updateProjectionMatrix();
    // §4.2: bias -0.0004, normalBias 0.02, soft PCF of ~2.5 texels. normalBias
    // is scaled by the world size of a texel so it survives a quality change.
    const texel = (ext * 2) / map;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = Math.max(0.02, texel * 1.35);
    this.sun.shadow.radius = 2.5;
    this.sun.shadow.blurSamples = 8;
  }

  /* --------------------------------------------------------------- update */

  update(ctx: GameContext, dt: number): void {
    if (this.disposed) return;
    const camera = ctx.camera;
    const ext = SHADOW_EXTENT[this.quality];

    /* --- follow the player, biased ahead so the shadow box covers what the
     * camera is about to see rather than what it just left --- */
    camera.getWorldDirection(this.tmpV);
    this.tmpV.y = 0;
    if (this.tmpV.lengthSq() < 1e-6) this.tmpV.set(0, 0, -1);
    this.tmpV.normalize();
    this.focusTarget.set(
      camera.position.x + this.tmpV.x * ext * 0.4,
      0,
      camera.position.z + this.tmpV.z * ext * 0.4,
    );
    this.focusTarget.y = this.groundHeight(this.focusTarget.x, this.focusTarget.z);

    const rate = dt > 0 ? 8 : 0;
    this.focus.set(
      damp(this.focus.x, this.focusTarget.x, rate, dt),
      damp(this.focus.y, this.focusTarget.y, rate, dt),
      damp(this.focus.z, this.focusTarget.z, rate, dt),
    );
    this.placeKeyLight();

    /* --- shadows honour the settings toggle without touching light counts --- */
    const wantShadows = ctx.settings.shadows;
    if (wantShadows !== this.shadowsEnabled) {
      this.shadowsEnabled = wantShadows;
      this.sun.castShadow = wantShadows;
    }

    /* --- lightning --- */
    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      const k = clamp01(this.flashTimer / Math.max(this.flashDuration, 1e-4));
      // a strike is a hard onset with a short decay, not a symmetric pulse
      const shape = k * k;
      this.lightningLight.intensity = this.flashPeak * shape;
      this.lightningAmbient.intensity = this.flashPeak * shape * 0.18;
      POST_STATE.flash = clamp01(shape * this.flashPeak * 0.09);
      if (this.flashTimer <= 0) {
        this.flashPeak = 0;
        this.lightningLight.intensity = 0;
        this.lightningAmbient.intensity = 0;
        POST_STATE.flash = 0;
      }
    }

    /* --- lamps --- */
    this.lampLevelSmoothed = damp(this.lampLevelSmoothed, this.state.lampLevel, 2.2, dt);
    this.updateLamps(camera.position);

    /* --- exposure for the no-post path; the composer reads POST_STATE --- */
    ctx.renderer.toneMappingExposure = POST_STATE.exposure;
  }

  /* ---------------------------------------------------------------- lamps */

  private buildLamps(): void {
    const budget = LAMP_BUDGET[this.quality];
    this.collectLampSites(budget);
    this.buildLampMeshes();
    this.buildLampPool();
  }

  /** Walk the road graph and drop a lamp every 21 m, alternating kerbs. */
  private collectLampSites(budget: number): void {
    this.lampSites.length = 0;
    this.lampGrid.clear();
    if (budget <= 0) return;

    const p = new THREE.Vector3();
    let side = 1;
    // Deterministic order (edge id) so lamps land in the same place every boot.
    const edges = this.roads.edges;
    const total = edges.reduce(
      (a, e) => a + (e.kind === 'stairs' || e.kind === 'ramp' || e.kind === 'rooftop' ? 0 : e.length),
      0,
    );
    // stretch the spacing if the district has more street than the budget covers
    const spacing = Math.max(LAMP_SPACING, total / Math.max(1, budget));

    for (const e of edges) {
      if (e.kind === 'stairs' || e.kind === 'ramp' || e.kind === 'rooftop') continue;
      if (e.length < spacing * 0.5) continue;
      const n = Math.max(1, Math.floor(e.length / spacing));
      const offset = e.width * 0.5 + 0.62;
      for (let i = 0; i < n; i++) {
        if (this.lampSites.length >= budget) break;
        const t = (i + 0.5) / n;
        this.roads.sample(e.id, t, side * offset, p);
        side = -side;
        const y = this.groundHeight(p.x, p.z);
        if (!Number.isFinite(y)) continue;
        const idx = this.lampSites.length;
        this.lampSites.push({ x: p.x, y, z: p.z });
        const key = this.cellKey(p.x, p.z);
        let list = this.lampGrid.get(key);
        if (!list) this.lampGrid.set(key, (list = []));
        list.push(idx);
      }
      if (this.lampSites.length >= budget) break;
    }
  }

  private cellKey(x: number, z: number): number {
    const i = Math.floor(x / this.lampCell);
    const j = Math.floor(z / this.lampCell);
    return i * 73856093 + j * 19349663;
  }

  /** One merged iron post + one emissive lantern, both instanced: 2 draws. */
  private buildLampMeshes(): void {
    const count = this.lampSites.length;
    if (count === 0) return;

    const parts: THREE.BufferGeometry[] = [];
    const push = (g: THREE.BufferGeometry, y: number): void => {
      g.translate(0, y, 0);
      parts.push(g);
    };
    // §1.8: plinth 0.45 h x 0.34 dia, shaft 0.14 -> 0.09 dia, lamp base 4.20.
    push(new THREE.CylinderGeometry(0.17, 0.19, 0.45, 8, 1), 0.225);
    push(new THREE.CylinderGeometry(0.045, 0.07, 3.78, 8, 1), 2.34);
    push(new THREE.CylinderGeometry(0.095, 0.075, 0.14, 8, 1), 4.26);
    push(new THREE.ConeGeometry(0.2, 0.3, 6, 1), 5.13);
    push(new THREE.SphereGeometry(0.055, 6, 4), 5.33);
    const postGeo = mergeGeometries(parts, false);
    for (const g of parts) g.dispose();
    if (!postGeo) return;

    const ironMat = this.materials.custom(
      'fx/lampIron',
      () =>
        new THREE.MeshStandardMaterial({
          name: 'loco/lampIron',
          color: 0x1a1d20,
          roughness: 0.45,
          metalness: 0.35,
        }),
      0.25,
    ) as THREE.MeshStandardMaterial;

    this.lampGlobeMat = this.materials.custom(
      'fx/lampGlobe',
      () =>
        new THREE.MeshStandardMaterial({
          name: 'loco/lampGlobe',
          color: 0x2a2214,
          roughness: 0.25,
          metalness: 0,
          emissive: new THREE.Color(0xffd9a0),
          emissiveIntensity: 0,
        }),
      0,
    ) as THREE.MeshStandardMaterial;

    // §1.8: lantern 0.75 h. Six-sided glass, seated on the 4.20 collar.
    const globeGeo = new THREE.CylinderGeometry(0.155, 0.115, 0.72, 6, 1);
    globeGeo.translate(0, 4.62, 0);

    this.lampPost = new THREE.InstancedMesh(postGeo, ironMat, count);
    this.lampPost.name = 'fx/lampPosts';
    this.lampPost.castShadow = false;
    this.lampPost.receiveShadow = false;
    this.lampPost.instanceMatrix.setUsage(THREE.StaticDrawUsage);

    this.lampGlobe = new THREE.InstancedMesh(globeGeo, this.lampGlobeMat, count);
    this.lampGlobe.name = 'fx/lampGlobes';
    this.lampGlobe.castShadow = false;
    this.lampGlobe.receiveShadow = false;
    this.lampGlobe.instanceMatrix.setUsage(THREE.StaticDrawUsage);

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const scl = new THREE.Vector3(1, 1, 1);
    const pos = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      const s = this.lampSites[i];
      pos.set(s.x, s.y, s.z);
      // a touch of yaw variance so the hexagonal lanterns do not line up
      q.setFromAxisAngle(UP, (i * 2.399963) % (Math.PI * 2));
      m.compose(pos, q, scl);
      this.lampPost.setMatrixAt(i, m);
      this.lampGlobe.setMatrixAt(i, m);
    }
    this.lampPost.instanceMatrix.needsUpdate = true;
    this.lampGlobe.instanceMatrix.needsUpdate = true;
    this.lampPost.computeBoundingSphere();
    this.lampGlobe.computeBoundingSphere();

    this.group.add(this.lampPost, this.lampGlobe);
  }

  private buildLampPool(): void {
    const n = LAMP_POOL[this.quality];
    for (let i = 0; i < n; i++) {
      const l = new THREE.PointLight(0xffb765, 0, LAMP_RANGE, 2);
      l.name = `fx/lampPool${i}`;
      l.castShadow = false;
      l.position.set(0, -1000, 0);
      this.lampLights.push(l);
      this.group.add(l);
    }
    this.lampCandidates = new Array<number>(64).fill(-1);
    this.lampScores = new Array<number>(64).fill(0);
  }

  /**
   * Re-target the real-light pool at the lamps nearest the camera and drive the
   * emissive globes. O(lamps in 3x3 cells) per frame, no allocation.
   */
  private updateLamps(camPos: THREE.Vector3): void {
    const level = this.lampLevelSmoothed;

    if (this.lampGlobeMat) {
      // 3.5x the bloom threshold (§4.3) — the globes are what makes the street
      // read as lit from 100 m, long after the point lights have fallen off.
      this.lampGlobeMat.emissiveIntensity = level * 3.4;
    }

    const pool = this.lampLights;
    if (pool.length === 0) return;
    if (level < 0.004) {
      for (const l of pool) if (l.intensity !== 0) l.intensity = 0;
      return;
    }

    /* gather candidates from the 3x3 cell neighbourhood */
    let n = 0;
    const cap = this.lampCandidates.length;
    const ci = Math.floor(camPos.x / this.lampCell);
    const cj = Math.floor(camPos.z / this.lampCell);
    for (let di = -1; di <= 1 && n < cap; di++) {
      for (let dj = -1; dj <= 1 && n < cap; dj++) {
        const list = this.lampGrid.get((ci + di) * 73856093 + (cj + dj) * 19349663);
        if (!list) continue;
        for (let k = 0; k < list.length && n < cap; k++) {
          const idx = list[k];
          const s = this.lampSites[idx];
          const dx = s.x - camPos.x;
          const dz = s.z - camPos.z;
          const d2 = dx * dx + dz * dz;
          if (d2 > 3600) continue;
          this.lampCandidates[n] = idx;
          this.lampScores[n] = d2;
          n++;
        }
      }
    }

    /* partial selection sort — pool.length is <= 8, so this is trivial */
    const take = Math.min(pool.length, n);
    for (let i = 0; i < take; i++) {
      let best = i;
      for (let j = i + 1; j < n; j++) if (this.lampScores[j] < this.lampScores[best]) best = j;
      if (best !== i) {
        const ti = this.lampCandidates[i];
        const ts = this.lampScores[i];
        this.lampCandidates[i] = this.lampCandidates[best];
        this.lampScores[i] = this.lampScores[best];
        this.lampCandidates[best] = ti;
        this.lampScores[best] = ts;
      }
      const s = this.lampSites[this.lampCandidates[i]];
      const l = pool[i];
      l.position.set(s.x, s.y + 4.6, s.z);
      // fade the outermost lamp out over the last 8 m so it never pops
      const d = Math.sqrt(this.lampScores[i]);
      const fade = clamp01((44 - d) / 8);
      l.intensity = LAMP_CANDELA * level * fade;
    }
    for (let i = take; i < pool.length; i++) {
      if (pool[i].intensity !== 0) pool[i].intensity = 0;
    }
  }

  /* -------------------------------------------------------------- quality */

  onQualityChange(tier: QualityTier, settings: SettingsState): void {
    if (tier !== this.quality) {
      this.quality = tier;
      this.configureShadow(tier);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
      this.rebuildLamps();
    }
    this.shadowsEnabled = settings.shadows;
    this.sun.castShadow = settings.shadows;
    this.refresh();
  }

  private rebuildLamps(): void {
    if (this.lampPost) {
      this.group.remove(this.lampPost);
      this.lampPost.geometry.dispose();
      this.lampPost.dispose();
      this.lampPost = null;
    }
    if (this.lampGlobe) {
      this.group.remove(this.lampGlobe);
      this.lampGlobe.geometry.dispose();
      this.lampGlobe.dispose();
      this.lampGlobe = null;
    }
    // The pool size is deliberately NOT rebuilt: changing the live point-light
    // count forces every program in the scene to recompile.
    this.collectLampSites(LAMP_BUDGET[this.quality]);
    this.buildLampMeshes();
    this.setLampsEnabled(this._lampsEnabled);
  }

  /* -------------------------------------------------------------- teardown */

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.lampPost) {
      this.lampPost.geometry.dispose();
      this.lampPost.dispose();
      this.lampPost = null;
    }
    if (this.lampGlobe) {
      this.lampGlobe.geometry.dispose();
      this.lampGlobe.dispose();
      this.lampGlobe = null;
    }
    this.lampLights.length = 0;
    this.lampSites.length = 0;
    this.lampGrid.clear();
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null;
    this.group.removeFromParent();
    this.group.clear();
  }

  /** Numbers the QA harness and the debug overlay want. */
  stats(): Record<string, number> {
    return {
      streetBearingDeg: Number(this.streetBearingDeg.toFixed(2)),
      sunAzimuthDeg: Number((((this.state.sunAz + this.azimuthOffsetDeg) % 360) + 360) % 360),
      sunElevationDeg: Number(this.state.sunEl.toFixed(2)),
      sunIntensity: Number(this.state.sunIntensity.toFixed(3)),
      hemiIntensity: Number(this.state.hemiIntensity.toFixed(3)),
      ambientIntensity: Number(this.state.ambientIntensity.toFixed(3)),
      envIntensity: Number(this.state.envIntensity.toFixed(3)),
      fogDensity: Number(this.state.fogDensity.toFixed(5)),
      exposure: Number(this.state.exposure.toFixed(3)),
      lamps: this.lampSites.length,
      lampPool: this.lampLights.length,
      lampLevel: Number(this.lampLevelSmoothed.toFixed(3)),
      shadowExtent: SHADOW_EXTENT[this.quality],
      shadowTexelMetres: Number(
        ((SHADOW_EXTENT[this.quality] * 2) / QUALITY_BUDGET[this.quality].shadowMapSize).toFixed(4),
      ),
    };
  }
}

export { SHADOW_EXTENT };

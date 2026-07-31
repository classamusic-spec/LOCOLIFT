import * as THREE from 'three';
import type { PhysicsWorld } from './PhysicsWorld';

/**
 * Renders Rapier's debug line buffer. Off by default and effectively free when
 * off — we skip the (expensive) buffer extraction entirely rather than just
 * hiding the mesh.
 */
export class PhysicsDebug {
  readonly object3d: THREE.LineSegments;
  private geometry = new THREE.BufferGeometry();
  private material: THREE.LineBasicMaterial;
  private _enabled = false;

  /** grown on demand; Rapier's buffer size varies with the number of colliders */
  private positions = new Float32Array(0);
  private colors = new Float32Array(0);

  constructor(private physics: PhysicsWorld) {
    this.material = new THREE.LineBasicMaterial({
      vertexColors: true,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 0.85,
    });
    this.object3d = new THREE.LineSegments(this.geometry, this.material);
    this.object3d.frustumCulled = false;
    this.object3d.renderOrder = 9999;
    this.object3d.visible = false;
    this.object3d.name = 'PhysicsDebug';
  }

  get enabled(): boolean {
    return this._enabled;
  }

  set enabled(v: boolean) {
    this._enabled = v;
    this.object3d.visible = v;
    if (!v) this.geometry.setDrawRange(0, 0);
  }

  toggle(): boolean {
    this.enabled = !this._enabled;
    return this._enabled;
  }

  update(): void {
    if (!this._enabled) return;

    const buffers = this.physics.raw.debugRender();
    const vtx = buffers.vertices;
    const col = buffers.colors;

    // Reallocate only when the collider set grows.
    if (this.positions.length < vtx.length) {
      this.positions = new Float32Array(vtx.length);
      this.colors = new Float32Array(col.length);
      this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
      this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 4));
    }

    this.positions.set(vtx);
    this.colors.set(col);

    const posAttr = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    const colAttr = this.geometry.getAttribute('color') as THREE.BufferAttribute;
    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
    this.geometry.setDrawRange(0, vtx.length / 3);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.object3d.removeFromParent();
  }
}

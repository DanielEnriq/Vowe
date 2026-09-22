import type * as THREE from 'three';

import {
  presenceColumns,
  presenceRows,
  type PresenceVisuals,
} from '@vowe/core/presence';

import { HALO_FRAG, HALO_VERT } from './shaders/halo.js';
import { POINTS_FRAG, POINTS_VERT } from './shaders/points.js';

/**
 * Vowe's presence, drawn.
 *
 * This is the only file in the application that knows what WebGL is. It takes
 * numbers and draws them; it has never heard of sessions, voice or attention,
 * and it must stay that way — the product decides what Vowe is doing, and this
 * decides what that looks like.
 *
 * It is a plain class rather than a component because the animation loop owns
 * mutable state that changes sixty times a second. React sets targets on it;
 * nothing here ever causes a render.
 */
export class PointCloudOrb {
  private readonly container: HTMLElement;

  private three: typeof THREE | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private points: THREE.Points | null = null;
  private halo: THREE.Mesh | null = null;
  private uniforms: Record<string, { value: unknown }> | null = null;

  private resize: ResizeObserver | null = null;
  private intersection: IntersectionObserver | null = null;
  private frame: number | null = null;

  private disposed = false;
  /** On screen, and the window is not in the background. */
  private onScreen = true;
  private documentVisible = true;
  /** The GPU took the context away; nothing may be drawn until it comes back. */
  private contextLost = false;

  /** Where the presence is going. */
  private target: PresenceVisuals;
  /** Where it currently is. Interpolated towards the target every frame. */
  private current: PresenceVisuals;
  private density: number;

  private activity = 0;
  private clock = 0;
  private last = 0;

  /** Called if the presence could not be drawn at all. */
  private readonly onUnavailable: () => void;

  constructor(
    container: HTMLElement,
    visuals: PresenceVisuals,
    onUnavailable: () => void = () => undefined,
  ) {
    this.container = container;
    this.target = visuals;
    this.current = { ...visuals };
    this.density = visuals.density;
    this.onUnavailable = onUnavailable;
    void this.boot().catch(() => {
      // No WebGL, no GPU, a context the driver refused: the presence says so
      // once and stops, rather than throwing into a render tree that has
      // nothing to do with graphics.
      if (!this.disposed) this.onUnavailable();
    });
  }

  setVisuals(visuals: PresenceVisuals): void {
    this.target = visuals;
    // Point count is the one parameter that is geometry rather than a uniform,
    // so it is the one change that costs anything. Sizes do not change while a
    // presence is mounted, so this is effectively once per instance.
    if (visuals.density !== this.density) {
      this.density = visuals.density;
      this.rebuildGeometry();
    }
  }

  /** Real, normalized speech energy. Zero means nobody is measuring. */
  setActivity(level: number): void {
    this.activity = level;
  }

  dispose(): void {
    this.disposed = true;
    this.stopLoop();
    this.resize?.disconnect();
    this.resize = null;
    this.intersection?.disconnect();
    this.intersection = null;
    document.removeEventListener('visibilitychange', this.onDocumentVisibility);

    this.points?.geometry.dispose();
    disposeMaterial(this.points?.material);
    this.halo?.geometry.dispose();
    disposeMaterial(this.halo?.material);

    if (this.renderer) {
      // A disposed renderer still holds its GL context. Without forcing the
      // loss the browser keeps every context an unmounted presence ever made,
      // and a long-lived window eventually starves.
      const canvas = this.renderer.domElement;
      this.renderer.dispose();
      this.renderer.forceContextLoss();
      canvas.remove();
    }

    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.points = null;
    this.halo = null;
    this.uniforms = null;
    this.three = null;
  }

  private async boot(): Promise<void> {
    const three = await import('three');
    // Unmounted while Three was loading: there is nothing to attach to.
    if (this.disposed) return;
    this.three = three;

    const { width, height } = this.measure();

    const renderer = new three.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    });
    // Two is enough on a Retina panel, and it is half the fragments of three.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height, false);
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.style.cssText = 'width:100%;height:100%;display:block';
    renderer.domElement.addEventListener('webglcontextlost', this.onContextLost);
    renderer.domElement.addEventListener('webglcontextrestored', this.onContextRestored);
    this.container.appendChild(renderer.domElement);
    this.renderer = renderer;

    const scene = new three.Scene();
    const camera = new three.PerspectiveCamera(32, width / height, 0.1, 100);
    camera.position.set(0, 0, 4.15);
    this.scene = scene;
    this.camera = camera;

    const uniforms = {
      uTime: { value: 0 },
      uAmp: { value: this.current.amp },
      uFreq: { value: this.current.freq },
      uTorsion: { value: this.current.torsion },
      uJitter: { value: this.current.jitter },
      uPulse: { value: this.current.pulse },
      uSize: { value: this.current.size },
      uRim: { value: this.current.rim },
      uBright: { value: this.current.bright },
      uLevel: { value: 0 },
      uPix: { value: renderer.getPixelRatio() },
      uHeight: { value: height },
      uLineBias: { value: this.current.lineBias },
      uIrid: { value: this.current.irid },
      uWarm: { value: this.current.warm },
      uOpacity: { value: this.current.opacity },
      uGain: { value: this.current.gain },
      uColorA: { value: new three.Vector3(...hexToRgb(this.current.colorA)) },
      uColorB: { value: new three.Vector3(...hexToRgb(this.current.colorB)) },
      uWarmColor: { value: new three.Vector3(...hexToRgb('#ffb15e')) },
    };
    this.uniforms = uniforms;

    const material = new three.ShaderMaterial({
      uniforms,
      vertexShader: POINTS_VERT,
      fragmentShader: POINTS_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: three.AdditiveBlending,
    });
    this.points = new three.Points(this.buildGeometry(three), material);
    scene.add(this.points);

    this.halo = new three.Mesh(
      new three.PlaneGeometry(3, 3),
      new three.ShaderMaterial({
        uniforms: {
          uHalo: { value: this.current.halo },
          uTime: uniforms.uTime,
          uLevel: uniforms.uLevel,
          uColorA: uniforms.uColorA,
        },
        vertexShader: HALO_VERT,
        fragmentShader: HALO_FRAG,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: three.AdditiveBlending,
      }),
    );
    scene.add(this.halo);

    this.resize = new ResizeObserver(() => this.applySize());
    this.resize.observe(this.container);
    this.intersection = new IntersectionObserver((entries) => {
      this.onScreen = entries.some((entry) => entry.isIntersecting);
      this.syncLoop();
    });
    this.intersection.observe(this.container);
    document.addEventListener('visibilitychange', this.onDocumentVisibility);
    this.documentVisible = document.visibilityState !== 'hidden';

    this.syncLoop();
  }

  /**
   * The point shell: rows of latitude, each rotated a little against the last.
   *
   * The offset is what stops it reading as a wireframe globe — without it the
   * columns line up into meridians. Directions only: the radius every point
   * ends up at is decided in the vertex shader, every frame.
   */
  private buildGeometry(three: typeof THREE): THREE.BufferGeometry {
    const rows = presenceRows(this.density);
    const columns = presenceColumns(this.density);
    const count = rows * columns;

    const direction = new Float32Array(count * 3);
    const random = new Float32Array(count);
    const row = new Float32Array(count);
    // Seeded, so a presence that unmounts and remounts comes back as the same
    // cloud rather than a subtly different one.
    const rand = mulberry32(0x0be5ed);

    let k = 0;
    for (let i = 0; i < rows; i++) {
      const v = (i + 0.5) / rows;
      const phi = Math.acos(1 - 2 * v);
      const offset = i * 0.137;
      for (let j = 0; j < columns; j++) {
        const theta = (j / columns) * Math.PI * 2 + offset;
        direction[k * 3] = Math.sin(phi) * Math.cos(theta);
        direction[k * 3 + 1] = Math.cos(phi);
        direction[k * 3 + 2] = Math.sin(phi) * Math.sin(theta);
        random[k] = rand();
        row[k] = v;
        k++;
      }
    }

    const geometry = new three.BufferGeometry();
    geometry.setAttribute('position', new three.BufferAttribute(new Float32Array(count * 3), 3));
    geometry.setAttribute('aDir', new three.BufferAttribute(direction, 3));
    geometry.setAttribute('aRand', new three.BufferAttribute(random, 1));
    geometry.setAttribute('aRow', new three.BufferAttribute(row, 1));
    // The shader displaces well beyond the unit sphere, and a bounding sphere
    // computed from the undisplaced buffer would cull the presence away.
    geometry.boundingSphere = new three.Sphere(new three.Vector3(), 2);
    return geometry;
  }

  private rebuildGeometry(): void {
    if (!this.three || !this.points) return;
    const previous = this.points.geometry;
    this.points.geometry = this.buildGeometry(this.three);
    previous.dispose();
  }

  private measure(): { width: number; height: number } {
    return {
      width: Math.max(1, this.container.clientWidth),
      height: Math.max(1, this.container.clientHeight),
    };
  }

  private applySize(): void {
    if (!this.renderer || !this.camera || !this.uniforms) return;
    const { width, height } = this.measure();
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.uniforms.uHeight!.value = height;
  }

  private readonly onContextLost = (event: Event): void => {
    event.preventDefault();
    this.contextLost = true;
    this.stopLoop();
  };

  private readonly onContextRestored = (): void => {
    this.contextLost = false;
    this.syncLoop();
  };

  private readonly onDocumentVisibility = (): void => {
    this.documentVisible = document.visibilityState !== 'hidden';
    this.syncLoop();
  };

  /**
   * Running only when there is something to see.
   *
   * The loop is stopped rather than made to return early: a presence in a
   * hidden window should cost nothing at all, and Vowe is on screen for as long
   * as the application is open.
   */
  private syncLoop(): void {
    const shouldRun =
      !this.disposed && !this.contextLost && this.onScreen && this.documentVisible && this.renderer !== null;
    if (shouldRun) this.startLoop();
    else this.stopLoop();
  }

  private startLoop(): void {
    if (this.frame !== null) return;
    this.last = performance.now();
    this.frame = requestAnimationFrame(this.tick);
  }

  private stopLoop(): void {
    if (this.frame === null) return;
    cancelAnimationFrame(this.frame);
    this.frame = null;
  }

  private readonly tick = (now: number): void => {
    this.frame = requestAnimationFrame(this.tick);
    const renderer = this.renderer;
    const uniforms = this.uniforms;
    if (!renderer || !uniforms || !this.scene || !this.camera || !this.points || !this.halo) return;

    // Small presences run at half rate. The callback still fires every frame —
    // only the work is skipped — so the next frame's `dt` covers the gap and
    // the motion is identical, just drawn half as often.
    const elapsed = now - this.last;
    if (elapsed + 1 < 1000 / this.target.maxFps) return;

    // Clamped, so a frame after a stall does not jump the whole animation.
    const dt = Math.min(0.05, elapsed / 1000);
    this.last = now;

    // Frame-rate independent approach: the same journey takes the same time at
    // 60 and at 120, and a state change is always a move rather than a cut.
    const k = 1 - Math.pow(0.0025, dt);
    const current = this.current;
    const target = this.target;
    for (const key of LERPED) current[key] += (target[key] - current[key]) * k;

    this.activityLevel(uniforms, dt);

    this.clock += dt * current.speed;
    uniforms.uTime!.value = this.clock;
    uniforms.uAmp!.value = current.amp;
    uniforms.uFreq!.value = current.freq;
    uniforms.uTorsion!.value = current.torsion;
    uniforms.uJitter!.value = current.jitter;
    uniforms.uSize!.value = current.size * current.scale;
    uniforms.uBright!.value = current.bright;
    uniforms.uRim!.value = current.rim;
    uniforms.uPulse!.value = current.pulse;
    uniforms.uWarm!.value = current.warm;
    uniforms.uLineBias!.value = current.lineBias;
    uniforms.uOpacity!.value = current.opacity;
    uniforms.uGain!.value = current.gain;
    uniforms.uIrid!.value = current.irid;

    lerpColor(uniforms.uColorA!.value as THREE.Vector3, target.colorA, k);
    lerpColor(uniforms.uColorB!.value as THREE.Vector3, target.colorB, k);

    const haloMaterial = this.halo.material as THREE.ShaderMaterial;
    haloMaterial.uniforms['uHalo']!.value = current.halo;

    // Drift follows the state's own tempo as well as the profile's, so an idle
    // presence turns slowly and an agitated one does not.
    this.points.rotation.y += dt * 0.055 * current.spin * current.speed;
    this.points.rotation.x = Math.sin(this.clock * 0.12) * 0.12;

    renderer.render(this.scene, this.camera);
  };

  /** Smoothed towards whatever was measured, so silence settles rather than cuts. */
  private activityLevel(uniforms: Record<string, { value: unknown }>, dt: number): void {
    const level = uniforms.uLevel!.value as number;
    uniforms.uLevel!.value = level + (this.activity - level) * Math.min(1, dt * 14);
  }
}

/** Everything that interpolates. Colours move too, but as vectors. */
const LERPED = [
  'amp',
  'freq',
  'speed',
  'torsion',
  'jitter',
  'size',
  'bright',
  'rim',
  'halo',
  'pulse',
  'warm',
  'lineBias',
  'opacity',
  'gain',
  'irid',
  'spin',
  'scale',
] as const satisfies readonly (keyof PresenceVisuals)[];

function lerpColor(vector: THREE.Vector3, hex: string, k: number): void {
  const [r, g, b] = hexToRgb(hex);
  vector.set(
    vector.x + (r - vector.x) * k,
    vector.y + (g - vector.y) * k,
    vector.z + (b - vector.z) * k,
  );
}

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  return [
    parseInt(value.slice(0, 2), 16) / 255,
    parseInt(value.slice(2, 4), 16) / 255,
    parseInt(value.slice(4, 6), 16) / 255,
  ];
}

/** Small, fast, seedable. The cloud must be the same cloud every time. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function disposeMaterial(material: THREE.Material | THREE.Material[] | undefined): void {
  if (!material) return;
  if (Array.isArray(material)) material.forEach((one) => one.dispose());
  else material.dispose();
}

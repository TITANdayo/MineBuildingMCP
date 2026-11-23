import * as THREE from "three";
import { coordKey } from "../core/block-name.js";
import type {
  InspectResult,
  InspectViewId,
  RawPickResult,
  TraceRecord,
  VoxelData,
} from "../types/shared.js";

const PICKER_VERTEX_SHADER = /* glsl */ `
  attribute vec4 aPickColor;
  varying vec4 vPickColor;

  void main() {
    vPickColor = aPickColor;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const PICKER_FRAGMENT_SHADER = /* glsl */ `
  precision highp float;
  varying vec4 vPickColor;

  void main() {
    gl_FragColor = vPickColor;
  }
`;

/**
 * Converts image-space coordinates `(u, v)` (either normalized `[0.0, 1.0]` with at least
 * one non-integer fractional coordinate, or pixel coordinates `[0, res - 1]`) into
 * clamped top-left pixel indices `[0, res - 1]`.
 */
export function resolvePickerPixelCoords(
  u: number,
  v: number,
  resolution: number
): { pxU: number; pxV: number } {
  const isNormalized =
    u >= 0 &&
    u <= 1 &&
    v >= 0 &&
    v <= 1 &&
    (!Number.isInteger(u) || !Number.isInteger(v));

  const rawU = isNormalized ? Math.floor(u * resolution) : Math.floor(u);
  const rawV = isNormalized ? Math.floor(v * resolution) : Math.floor(v);

  return {
    pxU: Math.max(0, Math.min(resolution - 1, rawU)),
    pxV: Math.max(0, Math.min(resolution - 1, rawV)),
  };
}

/**
 * Decodes the picker alpha byte written by `encodePickerAlphaByte`:
 * - `0`   -> sky / background miss
 * - `255` -> terrain (`opId = 0`)
 * - `1..254` -> build `opId` modulo bucket
 */
export function decodePickerAlphaByte(a: number): { isSky: boolean; opId: number } {
  if (a === 0) {
    return { isSky: true, opId: 0 };
  }
  return { isSky: false, opId: a === 255 ? 0 : a };
}

export class OffscreenPickerPass {
  private pickerScene: THREE.Scene;
  private pickerMaterial: THREE.ShaderMaterial;
  private pickerMesh: THREE.Mesh | null = null;
  private renderTarget: THREE.WebGLRenderTarget;
  private currentResolution = 512;

  // Cached RGBA8 pixel buffers per view direction (with each buffer's own resolution)
  private viewBuffers = new Map<
    InspectViewId,
    { buffer: Uint8Array; resolution: number }
  >();

  // World state lookup for <1ms coordinate -> VoxelData + TraceRecord + distanceToGround resolution
  private voxelMap = new Map<string, VoxelData>();
  private traces: Record<number, TraceRecord> = {};

  constructor(initialResolution = 512) {
    this.currentResolution = initialResolution;
    this.pickerScene = new THREE.Scene();

    this.pickerMaterial = new THREE.ShaderMaterial({
      vertexShader: PICKER_VERTEX_SHADER,
      fragmentShader: PICKER_FRAGMENT_SHADER,
      blending: THREE.NoBlending,
      toneMapped: false,
      fog: false,
      transparent: false,
      depthTest: true,
      depthWrite: true,
      side: THREE.DoubleSide,
    });

    this.renderTarget = this.createTarget(initialResolution);
  }

  private createTarget(resolution: number): THREE.WebGLRenderTarget {
    const rt = new THREE.WebGLRenderTarget(resolution, resolution, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: true,
      stencilBuffer: false,
      samples: 0,
    });
    rt.texture.colorSpace = THREE.NoColorSpace;
    rt.texture.generateMipmaps = false;
    return rt;
  }

  /**
   * Updates the picker mesh geometry and world lookup tables on SYNC_WORLD.
   * Note: geometry lifecycle/disposal is owned by the caller so shared/swapped cutaway geometries
   * are never double-disposed or leaked.
   */
  public setWorldData(
    pickerGeometry: THREE.BufferGeometry,
    voxels: VoxelData[],
    traces?: Record<number, TraceRecord>
  ): void {
    if (this.pickerMesh) {
      this.pickerMesh.geometry = pickerGeometry;
    } else {
      this.pickerMesh = new THREE.Mesh(pickerGeometry, this.pickerMaterial);
      this.pickerMesh.frustumCulled = false;
      this.pickerScene.add(this.pickerMesh);
    }

    this.voxelMap.clear();
    for (const v of voxels) {
      this.voxelMap.set(coordKey(v.x, v.y, v.z), v);
    }

    this.traces = traces ?? {};
    this.viewBuffers.clear();
  }

  /**
   * Updates the active interactive picker mesh geometry (e.g., when toggling Dollhouse Cutaway mode in browser UI)
   * without clearing the full-world voxelMap or trace lookup table.
   */
  public setInteractiveGeometry(pickerGeometry: THREE.BufferGeometry): void {
    if (this.pickerMesh) {
      this.pickerMesh.geometry = pickerGeometry;
    } else {
      this.pickerMesh = new THREE.Mesh(pickerGeometry, this.pickerMaterial);
      this.pickerMesh.frustumCulled = false;
      this.pickerScene.add(this.pickerMesh);
    }
  }

  public getPickerMesh(): THREE.Mesh | null {
    return this.pickerMesh;
  }

  public getResolution(): number {
    return this.currentResolution;
  }

  public hasCachedView(view: InspectViewId): boolean {
    return this.viewBuffers.has(view);
  }

  /**
   * Renders the unlit RGBA ID buffer for a specific camera view and caches its raw Uint8Array pixels.
   * When `overrideGeometry` is provided (such as per-view Dollhouse Cutaway geometry), it renders
   * that exact cutaway geometry into the picker buffer and caches it for `view`.
   */
  public renderViewBuffer(
    renderer: THREE.WebGLRenderer,
    view: InspectViewId,
    camera: THREE.Camera,
    resolution: number,
    overrideGeometry?: THREE.BufferGeometry
  ): Uint8Array {
    if (resolution !== this.currentResolution) {
      this.renderTarget.dispose();
      this.renderTarget = this.createTarget(resolution);
      this.currentResolution = resolution;
    }

    const prevGeometry = this.pickerMesh?.geometry;
    const prevTarget = renderer.getRenderTarget();
    const prevToneMapping = renderer.toneMapping;
    const prevAutoClear = renderer.autoClear;
    const prevClearColor = renderer.getClearColor(new THREE.Color());
    const prevClearAlpha = renderer.getClearAlpha();

    try {
      if (overrideGeometry && this.pickerMesh) {
        this.pickerMesh.geometry = overrideGeometry;
      }

      renderer.toneMapping = THREE.NoToneMapping;
      renderer.autoClear = true;
      renderer.setRenderTarget(this.renderTarget);
      // Clear sky to (0, 0, 0, 0): alpha=0 unambiguously identifies sky across all 0..255 coords
      renderer.setClearColor(new THREE.Color(0, 0, 0), 0);
      renderer.clear(true, true, false);
      renderer.render(this.pickerScene, camera);

      const byteBuffer = new Uint8Array(resolution * resolution * 4);
      renderer.readRenderTargetPixels(
        this.renderTarget,
        0,
        0,
        resolution,
        resolution,
        byteBuffer
      );

      this.viewBuffers.set(view, { buffer: byteBuffer, resolution });
      return byteBuffer;
    } finally {
      if (overrideGeometry && this.pickerMesh && prevGeometry) {
        this.pickerMesh.geometry = prevGeometry;
      }
      renderer.setRenderTarget(prevTarget);
      renderer.toneMapping = prevToneMapping;
      renderer.autoClear = prevAutoClear;
      renderer.setClearColor(prevClearColor, prevClearAlpha);
    }
  }

  /**
   * Performs <1ms raw pixel lookup in the cached ID buffer for `view` at image coordinates (u, v).
   * Note: Image (u, v) has origin (0, 0) at top-left; WebGL framebuffer has origin at bottom-left.
   */
  public readRawPixel(view: InspectViewId, u: number, v: number): RawPickResult {
    const entry = this.viewBuffers.get(view);
    if (!entry) {
      return { hit: false };
    }

    const { buffer, resolution: res } = entry;
    const { pxU, pxV } = resolvePickerPixelCoords(u, v, res);
    const fbX = pxU;
    const fbY = res - 1 - pxV;

    const idx = (fbY * res + fbX) * 4;
    const r = buffer[idx];
    const g = buffer[idx + 1];
    const b = buffer[idx + 2];
    const a = buffer[idx + 3];

    const decoded = decodePickerAlphaByte(a);
    if (decoded.isSky) {
      return { hit: false };
    }

    if (!this.voxelMap.has(coordKey(r, g, b))) {
      return { hit: false };
    }

    return {
      hit: true,
      x: r,
      y: g,
      z: b,
      opId: decoded.opId,
    };
  }

  /**
   * Resolves a 3D voxel coordinate (x, y, z) into a complete InspectResult
   * including block name, state, isTerrain, code TraceRecord, and distanceToGround.
   */
  public resolveCoordinate(x: number, y: number, z: number, fallbackOpId?: number): InspectResult {
    const voxel = this.voxelMap.get(coordKey(x, y, z));
    if (!voxel) {
      return { hit: false };
    }

    // Calculate vertical distance to the nearest non-air block directly below (x, y, z)
    let distanceToGround = y;
    for (let checkY = y - 1; checkY >= 0; checkY--) {
      if (this.voxelMap.has(coordKey(x, checkY, z))) {
        distanceToGround = y - 1 - checkY;
        break;
      }
    }

    const opId = voxel.opId !== 0 ? voxel.opId : (fallbackOpId ?? 0);
    const trace = opId > 0 ? this.traces[opId] : undefined;

    return {
      hit: true,
      coord: { x: voxel.x, y: voxel.y, z: voxel.z },
      block: voxel.name,
      state: voxel.state,
      isTerrain: voxel.isTerrain,
      trace,
      distanceToGround,
    };
  }

  /**
   * Resolves (view, u, v) from the cached ID buffer into a full InspectResult in <1ms.
   */
  public inspectPixel(view: InspectViewId, u: number, v: number): InspectResult {
    const raw = this.readRawPixel(view, u, v);
    if (!raw.hit || raw.x === undefined || raw.y === undefined || raw.z === undefined) {
      return { hit: false };
    }
    return this.resolveCoordinate(raw.x, raw.y, raw.z, raw.opId);
  }

  public dispose(): void {
    this.renderTarget.dispose();
    this.pickerMaterial.dispose();
    this.viewBuffers.clear();
  }
}

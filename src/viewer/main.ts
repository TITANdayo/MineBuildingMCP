import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type {
  CameraControlParams,
  CameraPreset,
  CameraProjection,
  CameraStateSnapshot,
  CompiledBlockDefinition,
  InspectResult,
  InspectViewId,
  TraceRecord,
  Vec3,
  ViewDirection,
  VoxelData,
  WsRequest,
  WsResponse
} from "../types/shared.js";
import { buildWorldMeshes, type BuiltWorldMeshes } from "./voxel-mesh.js";
import { OffscreenPickerPass } from "./picker-pass.js";

const VIEW_DIRECTIONS: ViewDirection[] = ["NE", "SE", "SW", "NW"];

const PRESET_ANGLES: Record<
  Exclude<CameraPreset, "RESET">,
  { yaw: number; pitch: number }
> = {
  NE: { yaw: 45, pitch: 45 },
  SE: { yaw: 135, pitch: 45 },
  SW: { yaw: 225, pitch: 45 },
  NW: { yaw: 315, pitch: 45 },
  N: { yaw: 0, pitch: 20 },
  BACK: { yaw: 0, pitch: 20 },
  S: { yaw: 180, pitch: 20 },
  FRONT: { yaw: 180, pitch: 20 },
  E: { yaw: 90, pitch: 20 },
  RIGHT: { yaw: 90, pitch: 20 },
  W: { yaw: 270, pitch: 20 },
  LEFT: { yaw: 270, pitch: 20 },
  TOP: { yaw: 180, pitch: 89 }
};

interface CustomCameraState {
  projection: CameraProjection;
  target: Vec3;
  position: Vec3;
  yaw: number;
  pitch: number;
  distance: number;
  zoom: number;
  fov: number;
  orthoSize: number;
  resolution: number;
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function wrapYaw(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

function computePositionFromSpherical(
  target: Vec3,
  yawDeg: number,
  pitchDeg: number,
  distance: number
): Vec3 {
  const yawRad = (yawDeg * Math.PI) / 180;
  const pitchRad = (pitchDeg * Math.PI) / 180;
  const horiz = distance * Math.cos(pitchRad);
  return {
    x: target.x + horiz * Math.sin(yawRad),
    y: target.y + distance * Math.sin(pitchRad),
    z: target.z - horiz * Math.cos(yawRad)
  };
}

class MineBuildingViewer {
  private container: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private orbitCamera: THREE.PerspectiveCamera;
  private customOrthoCamera: THREE.OrthographicCamera | null = null;
  private activeCamera: THREE.Camera;
  private activeViewMode: "free" | ViewDirection | "custom" = "free";
  private controls: OrbitControls;

  private visualGroup: THREE.Group | null = null;
  private syncGeneration = 0;
  private hasSyncedWorldOnce = false;
  private customCameraInitialized = false;
  private customCameraHasExplicitPosition = false;
  private customCameraState: CustomCameraState = {
    projection: "perspective",
    target: { x: 16, y: 8, z: 16 },
    position: { x: 42, y: 34, z: 42 },
    yaw: 135,
    pitch: 35,
    distance: 46,
    zoom: 1,
    fov: 45,
    orthoSize: 46,
    resolution: 512
  };
  private gridHelper: THREE.GridHelper | null = null;
  private debugMarkerGroup: THREE.Group;

  private pickerPass: OffscreenPickerPass;
  private worldSize: [number, number, number] = [32, 32, 32];
  private worldBounds: BuiltWorldMeshes["bounds"] = {
    min: new THREE.Vector3(0, 0, 0),
    max: new THREE.Vector3(32, 16, 32),
    center: new THREE.Vector3(16, 8, 16),
    size: new THREE.Vector3(32, 16, 32)
  };

  private ws: WebSocket | null = null;
  private wsQueue: Promise<void> = Promise.resolve();
  private raycaster = new THREE.Raycaster();
  private pointerDownPos = new THREE.Vector2();

  constructor() {
    this.container = document.getElementById("canvas-container")!;

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      preserveDrawingBuffer: true,
      powerPreference: "high-performance"
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(new THREE.Color(0x0b0f17), 1.0);
    this.container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();

    // Lighting setup for clear directional contrast
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.78);
    this.scene.add(ambientLight);

    const sunLight = new THREE.DirectionalLight(0xfffbeb, 0.85);
    sunLight.position.set(45, 80, 55);
    this.scene.add(sunLight);

    const fillLight = new THREE.DirectionalLight(0x93c5fd, 0.32);
    fillLight.position.set(-40, 30, -45);
    this.scene.add(fillLight);

    this.orbitCamera = new THREE.PerspectiveCamera(
      45,
      window.innerWidth / window.innerHeight,
      0.1,
      1000
    );
    this.orbitCamera.position.set(42, 34, 42);
    this.activeCamera = this.orbitCamera;

    this.controls = new OrbitControls(this.orbitCamera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.target.set(16, 6, 16);
    this.controls.update();

    this.pickerPass = new OffscreenPickerPass(512);

    // 3D Red Debug Marker for highlighting inspected voxels
    this.debugMarkerGroup = this.createDebugMarker();
    this.debugMarkerGroup.visible = false;
    this.scene.add(this.debugMarkerGroup);

    this.updateGridHelper([32, 32, 32]);
    this.bindEvents();
    this.initDefaultPreviewWorld();
    this.connectWebSocket();
    this.animate();
  }

  private createDebugMarker(): THREE.Group {
    const group = new THREE.Group();
    group.name = "InspectDebugMarker";

    const boxGeo = new THREE.BoxGeometry(1.04, 1.04, 1.04);
    const fillMat = new THREE.MeshBasicMaterial({
      color: 0xef4444,
      transparent: true,
      opacity: 0.28,
      depthWrite: false
    });
    const fillMesh = new THREE.Mesh(boxGeo, fillMat);
    group.add(fillMesh);

    const edgesGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1.06, 1.06, 1.06));
    const lineMat = new THREE.LineBasicMaterial({
      color: 0xff3b3b,
      linewidth: 2
    });
    const wireframe = new THREE.LineSegments(edgesGeo, lineMat);
    group.add(wireframe);

    return group;
  }

  private highlightCoordinate(coord?: { x: number; y: number; z: number }): void {
    if (!coord) {
      this.debugMarkerGroup.visible = false;
      return;
    }
    this.debugMarkerGroup.position.set(coord.x + 0.5, coord.y + 0.5, coord.z + 0.5);
    this.debugMarkerGroup.visible = true;
  }

  private updateGridHelper(size: [number, number, number]): void {
    if (this.gridHelper) {
      this.scene.remove(this.gridHelper);
      this.gridHelper.geometry.dispose();
    }
    const maxDim = Math.max(size[0], size[2], 16);
    const grid = new THREE.GridHelper(maxDim, maxDim, 0x38bdf8, 0x1e293b);
    grid.position.set(size[0] / 2, -0.01, size[2] / 2);
    this.gridHelper = grid;
    this.scene.add(grid);
  }

  /**
   * Creates an OrthographicCamera positioned at one of the 4 intercardinal directions
   * (NE, SE, SW, NW) at a 45-degree elevation angle looking at the center of the world bounds.
   */
  public createDirectionCamera(view: ViewDirection, aspect = 1.0): THREE.OrthographicCamera {
    const { center, size } = this.worldBounds;
    const maxSpan = Math.max(size.x, size.y, size.z, 8);
    // Tight framing around the structure/world bounding box with comfortable margin
    const frustumHalf = maxSpan * 0.72;

    const cam = new THREE.OrthographicCamera(
      -frustumHalf * aspect,
      frustumHalf * aspect,
      frustumHalf,
      -frustumHalf,
      0.1,
      maxSpan * 8
    );

    const dist = maxSpan * 2.0;
    // 45-degree elevation: height equals horizontal radial distance sqrt(dist^2 + dist^2)
    const elevationY = dist * Math.SQRT2;

    let offsetX = dist;
    let offsetZ = dist;
    switch (view) {
      case "NE":
        offsetX = dist;
        offsetZ = -dist;
        break;
      case "SE":
        offsetX = dist;
        offsetZ = dist;
        break;
      case "SW":
        offsetX = -dist;
        offsetZ = dist;
        break;
      case "NW":
        offsetX = -dist;
        offsetZ = -dist;
        break;
    }

    cam.position.set(center.x + offsetX, center.y + elevationY, center.z + offsetZ);
    cam.up.set(0, 1, 0);
    cam.lookAt(center);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    return cam;
  }

  private resetCustomCameraState(): void {
    const { center, size } = this.worldBounds;
    const maxSpan = Math.max(size.x, size.y, size.z, 8);
    const target: Vec3 = { x: center.x, y: center.y, z: center.z };
    const yaw = 135;
    const pitch = 35;
    const distance = Math.max(maxSpan * 1.45, 12);
    const position = computePositionFromSpherical(target, yaw, pitch, distance);

    this.customCameraState = {
      projection: "perspective",
      target,
      position,
      yaw,
      pitch,
      distance,
      zoom: 1.0,
      fov: 45,
      orthoSize: Math.max(maxSpan * 1.44, 12),
      resolution: 512
    };
    this.customCameraHasExplicitPosition = false;
    this.customCameraInitialized = true;
  }

  private buildCustomCamera(
    aspect: number,
    explicitPos: boolean
  ): THREE.PerspectiveCamera | THREE.OrthographicCamera {
    const s = this.customCameraState;
    const maxSpan = Math.max(
      this.worldBounds.size.x,
      this.worldBounds.size.y,
      this.worldBounds.size.z,
      8
    );

    if (s.projection === "orthographic") {
      const half = s.orthoSize / 2;
      const camDist = explicitPos
        ? s.distance
        : Math.max(s.distance, maxSpan * 2.0);
      const camPos = explicitPos
        ? s.position
        : computePositionFromSpherical(s.target, s.yaw, s.pitch, camDist);

      const cam = new THREE.OrthographicCamera(
        -half * aspect,
        half * aspect,
        half,
        -half,
        0.05,
        Math.max(1000, camDist + maxSpan * 8)
      );
      cam.position.set(camPos.x, camPos.y, camPos.z);
      cam.up.set(0, 1, 0);
      cam.lookAt(s.target.x, s.target.y, s.target.z);
      cam.zoom = s.zoom;
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld(true);
      return cam;
    }

    const near = Math.max(0.05, Math.min(0.5, s.distance * 0.01));
    const far = Math.max(1000, s.distance * 10 + maxSpan * 8);
    const cam = new THREE.PerspectiveCamera(s.fov, aspect, near, far);
    cam.position.set(s.position.x, s.position.y, s.position.z);
    cam.up.set(0, 1, 0);
    cam.lookAt(s.target.x, s.target.y, s.target.z);
    cam.zoom = s.zoom;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    return cam;
  }

  private getCameraSnapshot(): CameraStateSnapshot {
    const s = this.customCameraState;
    return {
      projection: s.projection,
      position: { ...s.position },
      target: { ...s.target },
      yaw: Number(s.yaw.toFixed(3)),
      pitch: Number(s.pitch.toFixed(3)),
      distance: Number(s.distance.toFixed(3)),
      zoom: Number(s.zoom.toFixed(4)),
      fov: s.fov,
      orthoSize: Number(s.orthoSize.toFixed(3)),
      resolution: s.resolution,
      bounds: {
        min: {
          x: this.worldBounds.min.x,
          y: this.worldBounds.min.y,
          z: this.worldBounds.min.z
        },
        max: {
          x: this.worldBounds.max.x,
          y: this.worldBounds.max.y,
          z: this.worldBounds.max.z
        },
        center: {
          x: this.worldBounds.center.x,
          y: this.worldBounds.center.y,
          z: this.worldBounds.center.z
        },
        size: {
          x: this.worldBounds.size.x,
          y: this.worldBounds.size.y,
          z: this.worldBounds.size.z
        }
      }
    };
  }

  private applyCameraParams(params: CameraControlParams): {
    camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
    snapshot: CameraStateSnapshot;
    explicitPosition: boolean;
  } {
    if (!this.customCameraInitialized) {
      this.resetCustomCameraState();
    }

    const s = this.customCameraState;

    if (params.preset === "RESET") {
      this.resetCustomCameraState();
    } else if (params.preset && params.preset in PRESET_ANGLES) {
      const angles = PRESET_ANGLES[params.preset];
      s.yaw = angles.yaw;
      s.pitch = angles.pitch;
      this.customCameraHasExplicitPosition = false;
    }

    const activeState = this.customCameraState;

    if (
      params.projection === "perspective" ||
      params.projection === "orthographic"
    ) {
      activeState.projection = params.projection;
    }
    if (typeof params.fov === "number" && Number.isFinite(params.fov)) {
      activeState.fov = clamp(params.fov, 10, 120);
    }
    if (
      typeof params.orthoSize === "number" &&
      Number.isFinite(params.orthoSize)
    ) {
      activeState.orthoSize = Math.max(0.5, params.orthoSize);
    }
    if (
      typeof params.resolution === "number" &&
      Number.isFinite(params.resolution)
    ) {
      activeState.resolution = Math.max(
        64,
        Math.min(2048, Math.floor(params.resolution))
      );
    }

    if (
      params.target &&
      Number.isFinite(params.target.x) &&
      Number.isFinite(params.target.y) &&
      Number.isFinite(params.target.z)
    ) {
      activeState.target = {
        x: params.target.x,
        y: params.target.y,
        z: params.target.z
      };
    }

    if (params.pan) {
      if (typeof params.pan.x === "number" && Number.isFinite(params.pan.x)) {
        activeState.target.x += params.pan.x;
      }
      if (typeof params.pan.y === "number" && Number.isFinite(params.pan.y)) {
        activeState.target.y += params.pan.y;
      }
      if (typeof params.pan.z === "number" && Number.isFinite(params.pan.z)) {
        activeState.target.z += params.pan.z;
      }
    }

    const hasExplicitPosInput =
      params.position !== undefined &&
      Number.isFinite(params.position.x) &&
      Number.isFinite(params.position.y) &&
      Number.isFinite(params.position.z);

    const hasRelativeAngleOrDist =
      (typeof params.deltaYaw === "number" && Number.isFinite(params.deltaYaw)) ||
      (typeof params.deltaPitch === "number" && Number.isFinite(params.deltaPitch)) ||
      (typeof params.deltaDistance === "number" &&
        Number.isFinite(params.deltaDistance));

    if (hasExplicitPosInput && params.position) {
      const pos = params.position;
      const dx = pos.x - activeState.target.x;
      const dy = pos.y - activeState.target.y;
      const dz = pos.z - activeState.target.z;
      const dist = Math.max(0.5, Math.hypot(dx, dy, dz));
      const horiz = Math.hypot(dx, dz);

      activeState.distance = dist;
      activeState.pitch = clamp(
        (Math.atan2(dy, horiz) * 180) / Math.PI,
        -89,
        89
      );
      if (horiz > 1e-5) {
        activeState.yaw = wrapYaw((Math.atan2(dx, -dz) * 180) / Math.PI);
      }

      if (hasRelativeAngleOrDist) {
        if (typeof params.deltaYaw === "number" && Number.isFinite(params.deltaYaw)) {
          activeState.yaw = wrapYaw(activeState.yaw + params.deltaYaw);
        }
        if (
          typeof params.deltaPitch === "number" &&
          Number.isFinite(params.deltaPitch)
        ) {
          activeState.pitch = clamp(activeState.pitch + params.deltaPitch, -89, 89);
        }
        if (
          typeof params.deltaDistance === "number" &&
          Number.isFinite(params.deltaDistance)
        ) {
          activeState.distance = Math.max(
            0.5,
            activeState.distance + params.deltaDistance
          );
        }
        activeState.position = computePositionFromSpherical(
          activeState.target,
          activeState.yaw,
          activeState.pitch,
          activeState.distance
        );
        this.customCameraHasExplicitPosition = false;
      } else {
        activeState.position = { x: pos.x, y: pos.y, z: pos.z };
        this.customCameraHasExplicitPosition = true;
      }
    } else {
      const hasSphericalOverride =
        params.preset !== undefined ||
        typeof params.yaw === "number" ||
        typeof params.pitch === "number" ||
        typeof params.distance === "number" ||
        hasRelativeAngleOrDist ||
        params.target !== undefined ||
        params.pan !== undefined;

      if (typeof params.yaw === "number" && Number.isFinite(params.yaw)) {
        activeState.yaw = wrapYaw(params.yaw);
      }
      if (typeof params.pitch === "number" && Number.isFinite(params.pitch)) {
        activeState.pitch = clamp(params.pitch, -89, 89);
      }
      if (
        typeof params.distance === "number" &&
        Number.isFinite(params.distance)
      ) {
        activeState.distance = Math.max(0.5, params.distance);
      }
      if (typeof params.deltaYaw === "number" && Number.isFinite(params.deltaYaw)) {
        activeState.yaw = wrapYaw(activeState.yaw + params.deltaYaw);
      }
      if (
        typeof params.deltaPitch === "number" &&
        Number.isFinite(params.deltaPitch)
      ) {
        activeState.pitch = clamp(activeState.pitch + params.deltaPitch, -89, 89);
      }
      if (
        typeof params.deltaDistance === "number" &&
        Number.isFinite(params.deltaDistance)
      ) {
        activeState.distance = Math.max(
          0.5,
          activeState.distance + params.deltaDistance
        );
      }

      if (hasSphericalOverride || !this.customCameraHasExplicitPosition) {
        activeState.position = computePositionFromSpherical(
          activeState.target,
          activeState.yaw,
          activeState.pitch,
          activeState.distance
        );
        this.customCameraHasExplicitPosition = false;
      }
    }

    if (typeof params.zoom === "number" && Number.isFinite(params.zoom)) {
      activeState.zoom = clamp(params.zoom, 0.1, 50);
    }
    if (
      typeof params.zoomFactor === "number" &&
      Number.isFinite(params.zoomFactor) &&
      params.zoomFactor > 0
    ) {
      activeState.zoom = clamp(activeState.zoom * params.zoomFactor, 0.1, 50);
    }

    const camera = this.buildCustomCamera(
      1.0,
      this.customCameraHasExplicitPosition
    );
    return {
      camera,
      snapshot: this.getCameraSnapshot(),
      explicitPosition: this.customCameraHasExplicitPosition
    };
  }

  /**
   * Synchronizes the 3D scene and picker pass with a new voxel world.
   */
  public async syncWorld(
    voxels: VoxelData[],
    size: [number, number, number],
    traces?: Record<number, TraceRecord>,
    textures?: Record<string, string>,
    blockModels?: Record<string, CompiledBlockDefinition>
  ): Promise<void> {
    const gen = ++this.syncGeneration;
    const built = await buildWorldMeshes(voxels, size, textures, blockModels);

    if (gen !== this.syncGeneration) {
      built.visualGroup.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.LineSegments) {
          obj.geometry.dispose();
        }
      });
      built.pickerGeometry.dispose();
      return;
    }

    const sizeChanged =
      !this.hasSyncedWorldOnce ||
      this.worldSize[0] !== size[0] ||
      this.worldSize[1] !== size[1] ||
      this.worldSize[2] !== size[2];
    this.hasSyncedWorldOnce = true;

    this.worldSize = size;
    this.updateGridHelper(size);

    if (this.visualGroup) {
      this.scene.remove(this.visualGroup);
      this.visualGroup.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.LineSegments) {
          obj.geometry.dispose();
        }
      });
    }

    this.visualGroup = built.visualGroup;
    this.worldBounds = built.bounds;
    this.scene.add(this.visualGroup);

    this.pickerPass.setWorldData(built.pickerGeometry, voxels, traces);

    if (sizeChanged) {
      this.customCameraInitialized = false;
      this.customCameraHasExplicitPosition = false;
    }

    if (sizeChanged || !this.customCameraInitialized) {
      // Frame orbit camera nicely around updated world center
      this.controls.target.copy(this.worldBounds.center);
      const span = Math.max(
        this.worldBounds.size.x,
        this.worldBounds.size.y,
        this.worldBounds.size.z,
        12
      );
      this.orbitCamera.zoom = 1;
      this.orbitCamera.updateProjectionMatrix();
      this.orbitCamera.position.set(
        this.worldBounds.center.x + span * 1.15,
        this.worldBounds.center.y + span * 0.95,
        this.worldBounds.center.z + span * 1.15
      );
      this.controls.update();
    }

    if (this.activeViewMode === "custom") {
      const aspect = window.innerWidth / Math.max(1, window.innerHeight);
      this.customOrthoCamera = this.buildCustomCamera(
        aspect,
        this.customCameraHasExplicitPosition
      ) as THREE.OrthographicCamera;
      this.activeCamera = this.customOrthoCamera;
    } else if (this.activeViewMode !== "free") {
      const aspect = window.innerWidth / Math.max(1, window.innerHeight);
      this.activeCamera = this.createDirectionCamera(this.activeViewMode, aspect);
    }

    // Update HUD stats
    let terrainCount = 0;
    let aiCount = 0;
    for (const v of voxels) {
      if (v.isTerrain) terrainCount++;
      else aiCount++;
    }

    const sizeEl = document.getElementById("stat-world-size");
    const terrainEl = document.getElementById("stat-terrain-count");
    const aiEl = document.getElementById("stat-ai-count");
    if (sizeEl) sizeEl.textContent = `${size[0]}×${size[1]}×${size[2]}`;
    if (terrainEl) terrainEl.textContent = String(terrainCount);
    if (aiEl) aiEl.textContent = String(aiCount);
  }

  private renderCameraToPng(
    cam: THREE.Camera,
    res: number,
    sharedResources?: {
      visualTarget: THREE.WebGLRenderTarget;
      rawPixels: Uint8Array;
      outCanvas: HTMLCanvasElement;
      ctx: CanvasRenderingContext2D;
      imgData: ImageData;
    }
  ): string {
    const ownsResources = !sharedResources;
    const visualTarget =
      sharedResources?.visualTarget ??
      (() => {
        const rt = new THREE.WebGLRenderTarget(res, res, {
          minFilter: THREE.LinearFilter,
          magFilter: THREE.LinearFilter,
          format: THREE.RGBAFormat,
          type: THREE.UnsignedByteType,
          depthBuffer: true,
          stencilBuffer: false
        });
        rt.texture.colorSpace = THREE.SRGBColorSpace;
        return rt;
      })();

    const rawPixels = sharedResources?.rawPixels ?? new Uint8Array(res * res * 4);
    const outCanvas =
      sharedResources?.outCanvas ??
      (() => {
        const c = document.createElement("canvas");
        c.width = res;
        c.height = res;
        return c;
      })();
    const ctx = sharedResources?.ctx ?? outCanvas.getContext("2d")!;
    const imgData = sharedResources?.imgData ?? ctx.createImageData(res, res);

    const prevTarget = ownsResources ? this.renderer.getRenderTarget() : null;
    const prevClearColor = ownsResources
      ? this.renderer.getClearColor(new THREE.Color())
      : null;
    const prevClearAlpha = ownsResources ? this.renderer.getClearAlpha() : 1;
    const prevMarkerVisible = ownsResources ? this.debugMarkerGroup.visible : false;

    if (ownsResources) {
      this.debugMarkerGroup.visible = false;
    }

    this.renderer.setRenderTarget(visualTarget);
    this.renderer.setClearColor(new THREE.Color(0x0f172a), 1.0);
    this.renderer.clear(true, true, false);
    this.renderer.render(this.scene, cam);

    this.renderer.readRenderTargetPixels(visualTarget, 0, 0, res, res, rawPixels);

    // Flip WebGL bottom-up rows to top-down PNG image coordinates
    const rowBytes = res * 4;
    for (let y = 0; y < res; y++) {
      const srcOffset = (res - 1 - y) * rowBytes;
      const dstOffset = y * rowBytes;
      imgData.data.set(rawPixels.subarray(srcOffset, srcOffset + rowBytes), dstOffset);
    }
    ctx.putImageData(imgData, 0, 0);
    const dataUrl = outCanvas.toDataURL("image/png");

    if (ownsResources) {
      visualTarget.dispose();
      this.debugMarkerGroup.visible = prevMarkerVisible;
      this.renderer.setRenderTarget(prevTarget);
      if (prevClearColor) {
        this.renderer.setClearColor(prevClearColor, prevClearAlpha);
      }
    }

    return dataUrl;
  }

  /**
   * Renders all 4 cardinal/intercardinal views (NE, SE, SW, NW) at `resolution`:
   * 1. Visual Pass -> Base64 PNG Data URLs
   * 2. Data Picking Pass -> Cached RGBA8 Uint8Array buffers for <1ms INSPECT_PIXEL lookups
   */
  public renderViews(resolution: number): Record<ViewDirection, string> {
    const res = Math.max(64, Math.min(2048, Math.floor(resolution || 512)));

    const visualTarget = new THREE.WebGLRenderTarget(res, res, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: true,
      stencilBuffer: false
    });
    visualTarget.texture.colorSpace = THREE.SRGBColorSpace;

    const prevTarget = this.renderer.getRenderTarget();
    const prevClearColor = this.renderer.getClearColor(new THREE.Color());
    const prevClearAlpha = this.renderer.getClearAlpha();
    const prevMarkerVisible = this.debugMarkerGroup.visible;

    this.debugMarkerGroup.visible = false;

    const rawPixels = new Uint8Array(res * res * 4);
    const outCanvas = document.createElement("canvas");
    outCanvas.width = res;
    outCanvas.height = res;
    const ctx = outCanvas.getContext("2d")!;
    const imgData = ctx.createImageData(res, res);

    const images = {} as Record<ViewDirection, string>;
    const sharedResources = { visualTarget, rawPixels, outCanvas, ctx, imgData };

    for (const view of VIEW_DIRECTIONS) {
      const cam = this.createDirectionCamera(view, 1.0);
      images[view] = this.renderCameraToPng(cam, res, sharedResources);
      this.pickerPass.renderViewBuffer(this.renderer, view, cam, res);
    }

    visualTarget.dispose();
    this.debugMarkerGroup.visible = prevMarkerVisible;
    this.renderer.setRenderTarget(prevTarget);
    this.renderer.setClearColor(prevClearColor, prevClearAlpha);

    return images;
  }

  /**
   * Applies custom camera parameters, renders the visual PNG and "custom" ID picker buffer,
   * and optionally syncs the live browser viewport camera.
   */
  public renderCustomCamera(params: CameraControlParams): {
    image: string;
    camera: CameraStateSnapshot;
  } {
    const { camera, snapshot, explicitPosition } = this.applyCameraParams(params);
    const res = snapshot.resolution;

    const image = this.renderCameraToPng(camera, res);
    this.pickerPass.renderViewBuffer(this.renderer, "custom", camera, res);

    if (params.syncViewer !== false) {
      const labelEl = document.getElementById("active-camera-label");
      const buttons = document.querySelectorAll<HTMLButtonElement>(".view-btn");

      if (snapshot.projection === "perspective") {
        const maxSpan = Math.max(
          this.worldBounds.size.x,
          this.worldBounds.size.y,
          this.worldBounds.size.z,
          8
        );
        this.orbitCamera.position.set(
          snapshot.position.x,
          snapshot.position.y,
          snapshot.position.z
        );
        this.orbitCamera.fov = snapshot.fov;
        this.orbitCamera.zoom = snapshot.zoom;
        this.orbitCamera.near = Math.max(
          0.05,
          Math.min(0.5, snapshot.distance * 0.01)
        );
        this.orbitCamera.far = Math.max(
          1000,
          snapshot.distance * 10 + maxSpan * 8
        );
        this.orbitCamera.updateProjectionMatrix();

        this.controls.target.set(
          snapshot.target.x,
          snapshot.target.y,
          snapshot.target.z
        );
        this.controls.update();

        this.activeViewMode = "free";
        this.activeCamera = this.orbitCamera;
        this.controls.enabled = true;

        buttons.forEach((b) => {
          b.classList.toggle("active", b.dataset.view === "free");
        });
        if (labelEl) {
          labelEl.textContent = `Custom (Persp ${snapshot.zoom.toFixed(1)}x)`;
        }
      } else {
        const aspect = window.innerWidth / Math.max(1, window.innerHeight);
        this.customOrthoCamera = this.buildCustomCamera(
          aspect,
          explicitPosition
        ) as THREE.OrthographicCamera;
        this.activeViewMode = "custom";
        this.activeCamera = this.customOrthoCamera;
        this.controls.enabled = false;

        buttons.forEach((b) => b.classList.remove("active"));
        if (labelEl) {
          labelEl.textContent = `Custom (Ortho ${snapshot.zoom.toFixed(1)}x)`;
        }
      }
    }

    return { image, camera: snapshot };
  }

  /**
   * Executes <1ms pixel inspection on the requested view and (u, v) pixel coordinate,
   * highlights the hit block in 3D with a red marker, and updates the HUD.
   */
  public inspectPixel(view: InspectViewId, u: number, v: number): InspectResult {
    if (!this.pickerPass.hasCachedView(view)) {
      if (view === "custom") {
        if (!this.customCameraInitialized) {
          this.resetCustomCameraState();
        }
        const cam = this.buildCustomCamera(
          1.0,
          this.customCameraHasExplicitPosition
        );
        this.pickerPass.renderViewBuffer(
          this.renderer,
          "custom",
          cam,
          this.customCameraState.resolution
        );
      } else {
        const cam = this.createDirectionCamera(view, 1.0);
        this.pickerPass.renderViewBuffer(
          this.renderer,
          view,
          cam,
          this.pickerPass.getResolution()
        );
      }
    }

    const result = this.pickerPass.inspectPixel(view, u, v);
    this.highlightCoordinate(result.coord);
    this.updateHudInspector(result, `AI (${view} @ ${u},${v})`);
    this.updateAiQuerySection(view, u, v, result);
    return result;
  }

  private updateHudInspector(result: InspectResult, sourceLabel: string): void {
    const originEl = document.getElementById("inspect-origin-badge");
    const coordEl = document.getElementById("inspect-coord");
    const blockEl = document.getElementById("inspect-block");
    const stateEl = document.getElementById("inspect-state");
    const opidEl = document.getElementById("inspect-opid");
    const groundEl = document.getElementById("inspect-ground");
    const traceEl = document.getElementById("inspect-trace");

    if (originEl) originEl.textContent = sourceLabel;

    if (!result.hit || !result.coord) {
      if (coordEl) coordEl.textContent = "Sky / Miss";
      if (blockEl) blockEl.textContent = "—";
      if (stateEl) stateEl.textContent = "—";
      if (opidEl) opidEl.textContent = "—";
      if (groundEl) groundEl.textContent = "—";
      if (traceEl) traceEl.textContent = "No block hit at this coordinate.";
      return;
    }

    const { x, y, z } = result.coord;
    if (coordEl) coordEl.textContent = `(${x}, ${y}, ${z})`;
    if (blockEl) blockEl.textContent = result.block ?? "unknown";
    if (stateEl) {
      const stateEntries = result.state ? Object.entries(result.state) : [];
      stateEl.textContent =
        stateEntries.length > 0
          ? stateEntries.map(([k, val]) => `${k}=${val}`).join(", ")
          : "default";
    }
    if (opidEl) {
      const opId = result.trace?.opId ?? (result.isTerrain ? 0 : 1);
      opidEl.textContent = result.isTerrain ? `Terrain (opId: 0)` : `AI Build (opId: ${opId})`;
    }
    if (groundEl) {
      const dist = result.distanceToGround ?? 0;
      groundEl.textContent = dist === 0 ? "0 (Supported)" : `${dist} blocks above ground`;
    }
    if (traceEl) {
      if (result.trace) {
        traceEl.innerHTML = `<span class="trace-line-badge">Line ${result.trace.line}</span>${this.escapeHtml(
          result.trace.codeSnippet
        )}`;
      } else if (result.isTerrain) {
        traceEl.textContent = "Initial terrain block (opId = 0)";
      } else {
        traceEl.textContent = "No code trace recorded for this block";
      }
    }
  }

  private updateAiQuerySection(
    view: InspectViewId,
    u: number,
    v: number,
    result: InspectResult
  ): void {
    const uvEl = document.getElementById("ai-query-uv");
    const targetEl = document.getElementById("ai-query-target");
    const traceEl = document.getElementById("ai-query-trace");

    if (uvEl) uvEl.textContent = `${view} (${u}, ${v})`;
    if (!result.hit || !result.coord) {
      if (targetEl) targetEl.textContent = "Miss (Sky / Background)";
      if (traceEl) traceEl.textContent = "Pixel did not hit any voxel.";
      return;
    }

    const { x, y, z } = result.coord;
    if (targetEl) targetEl.textContent = `(${x}, ${y}, ${z}) ${result.block ?? ""}`;
    if (traceEl) {
      if (result.trace) {
        traceEl.innerHTML = `<span class="trace-line-badge">Line ${result.trace.line}</span>${this.escapeHtml(
          result.trace.codeSnippet
        )}`;
      } else {
        traceEl.textContent = result.isTerrain
          ? "Terrain voxel (opId: 0)"
          : "AI voxel (no trace snippet)";
      }
    }
  }

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  private bindEvents(): void {
    window.addEventListener("resize", () => {
      const w = window.innerWidth;
      const h = Math.max(1, window.innerHeight);
      this.renderer.setSize(w, h);
      this.orbitCamera.aspect = w / h;
      this.orbitCamera.updateProjectionMatrix();

      if (this.activeViewMode === "custom") {
        this.customOrthoCamera = this.buildCustomCamera(
          w / h,
          this.customCameraHasExplicitPosition
        ) as THREE.OrthographicCamera;
        this.activeCamera = this.customOrthoCamera;
      } else if (this.activeViewMode !== "free") {
        this.activeCamera = this.createDirectionCamera(this.activeViewMode, w / h);
      }
    });

    // Camera view switcher buttons
    const buttons = document.querySelectorAll<HTMLButtonElement>(".view-btn");
    const labelEl = document.getElementById("active-camera-label");
    buttons.forEach((btn) => {
      btn.addEventListener("click", () => {
        buttons.forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");

        const mode = (btn.dataset.view || "free") as "free" | ViewDirection;
        this.activeViewMode = mode;

        if (mode === "free") {
          this.activeCamera = this.orbitCamera;
          this.controls.enabled = true;
          if (labelEl) labelEl.textContent = "Free Orbit";
        } else {
          const aspect = window.innerWidth / Math.max(1, window.innerHeight);
          this.activeCamera = this.createDirectionCamera(mode, aspect);
          this.controls.enabled = false;
          if (labelEl) labelEl.textContent = `${mode} (45° Ortho)`;
        }
      });
    });

    // Interactive click-to-inspect voxel in browser
    const domElem = this.renderer.domElement;
    domElem.addEventListener("pointerdown", (e) => {
      this.pointerDownPos.set(e.clientX, e.clientY);
    });

    domElem.addEventListener("pointerup", (e) => {
      const dist = Math.hypot(
        e.clientX - this.pointerDownPos.x,
        e.clientY - this.pointerDownPos.y
      );
      if (dist > 5) return; // Dragged to orbit, not a click

      const rect = domElem.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1
      );

      const pickerMesh = this.pickerPass.getPickerMesh();
      if (!pickerMesh) return;

      this.raycaster.setFromCamera(ndc, this.activeCamera);
      const hits = this.raycaster.intersectObject(pickerMesh, false);
      if (hits.length > 0 && hits[0].face) {
        const attr = pickerMesh.geometry.getAttribute("aPickColor") as THREE.BufferAttribute;
        const vertIndex = hits[0].face.a;
        const arr = attr.array as Uint8Array;
        const x = arr[vertIndex * 4];
        const y = arr[vertIndex * 4 + 1];
        const z = arr[vertIndex * 4 + 2];
        const opId = arr[vertIndex * 4 + 3];

        const res = this.pickerPass.resolveCoordinate(x, y, z, opId);
        this.highlightCoordinate(res.coord);
        this.updateHudInspector(res, "Browser Click");
      } else {
        this.highlightCoordinate(undefined);
        this.updateHudInspector({ hit: false }, "Browser Click");
      }
    });
  }

  private async initDefaultPreviewWorld(): Promise<void> {
    const demoVoxels: VoxelData[] = [];
    for (let x = 10; x < 22; x++) {
      for (let z = 10; z < 22; z++) {
        demoVoxels.push({
          x,
          y: 0,
          z,
          name: "minecraft:grass_block",
          isTerrain: true,
          opId: 0
        });
      }
    }
    await this.syncWorld(demoVoxels, [32, 32, 32]);
  }

  private connectWebSocket(): void {
    const params = new URLSearchParams(window.location.search);
    const wsUrlParam = params.get("wsUrl") || params.get("ws");
    const wsPort = params.get("wsPort") || "3001";
    const clientRole = params.get("client");
    const host = window.location.hostname || "127.0.0.1";
    const baseUrl = wsUrlParam || `ws://${host}:${wsPort}`;
    const url =
      clientRole === "headless"
        ? `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}client=headless`
        : baseUrl;

    const statusPill = document.getElementById("ws-status");
    const statusText = document.getElementById("ws-status-text");

    const setStatus = (connected: boolean) => {
      if (!statusPill || !statusText) return;
      if (connected) {
        statusPill.classList.add("connected");
        statusText.textContent = "Connected";
      } else {
        statusPill.classList.remove("connected");
        statusText.textContent = "Reconnecting...";
      }
    };

    try {
      const ws = new WebSocket(url);
      this.ws = ws;

      ws.addEventListener("open", () => {
        setStatus(true);
      });

      ws.addEventListener("message", (event) => {
        this.wsQueue = this.wsQueue.then(async () => {
          try {
            const req = JSON.parse(String(event.data)) as WsRequest;
            await this.handleWsRequest(req);
          } catch (err) {
            console.error("[MineBuildingViewer] Failed to handle WS message:", err);
          }
        });
      });

      ws.addEventListener("close", () => {
        setStatus(false);
        setTimeout(() => this.connectWebSocket(), 1000);
      });

      ws.addEventListener("error", () => {
        ws.close();
      });
    } catch {
      setStatus(false);
      setTimeout(() => this.connectWebSocket(), 1000);
    }
  }

  private sendWsResponse(res: WsResponse): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(res));
    }
  }

  private async handleWsRequest(req: WsRequest): Promise<void> {
    switch (req.type) {
      case "SYNC_WORLD": {
        await this.syncWorld(req.voxels, req.size, req.traces, req.textures, req.blockModels);
        this.sendWsResponse({
          type: "SYNC_ACK",
          id: req.id
        });
        break;
      }

      case "RENDER_VIEWS": {
        const images = this.renderViews(req.resolution);
        this.sendWsResponse({
          type: "RENDER_RESULT",
          id: req.id,
          images
        });
        break;
      }

      case "RENDER_CAMERA": {
        const { image, camera } = this.renderCustomCamera(req.params ?? {});
        this.sendWsResponse({
          type: "RENDER_CAMERA_RESULT",
          id: req.id,
          image,
          camera
        });
        break;
      }

      case "INSPECT_PIXEL": {
        const data = this.inspectPixel(req.view, req.u, req.v);
        this.sendWsResponse({
          type: "INSPECT_RESULT",
          id: req.id,
          data
        });
        break;
      }
    }
  }

  private animate = (): void => {
    requestAnimationFrame(this.animate);
    if (this.activeViewMode === "free") {
      this.controls.update();
    }
    this.renderer.render(this.scene, this.activeCamera);
  };
}

declare global {
  interface Window {
    __mineBuildingViewer?: MineBuildingViewer;
  }
}

window.__mineBuildingViewer = new MineBuildingViewer();

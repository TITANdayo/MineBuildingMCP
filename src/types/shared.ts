export type BlockState = Record<string, string>; // 例: { facing: "north", half: "bottom" }

export type McFaceDirection = "down" | "up" | "north" | "south" | "west" | "east";

export interface ResolvedModelFace {
  textureKey: string;
  uv?: [number, number, number, number];
  rotation?: number;
  cullface?: McFaceDirection;
  tintindex?: number;
}

export interface ResolvedModelElementRotation {
  origin: [number, number, number];
  axis?: "x" | "y" | "z";
  angle?: number;
  x?: number;
  y?: number;
  z?: number;
  rescale?: boolean;
}

export interface ResolvedModelElement {
  from: [number, number, number];
  to: [number, number, number];
  rotation?: ResolvedModelElementRotation;
  shade?: boolean;
  faces: Partial<Record<McFaceDirection, ResolvedModelFace>>;
}

export interface AppliedModelRef {
  model: string;
  x?: number;
  y?: number;
  uvlock?: boolean;
}

export interface MultipartCondition {
  OR?: MultipartCondition[];
  AND?: MultipartCondition[];
  [prop: string]: string | boolean | MultipartCondition[] | undefined;
}

export interface MultipartCase {
  when?: MultipartCondition;
  apply: AppliedModelRef[];
}

export interface CompiledBlockDefinition {
  blockName: string;
  variants?: Record<string, AppliedModelRef[]>;
  multipart?: MultipartCase[];
  models: Record<string, ResolvedModelElement[]>;
  isFullOpaqueCube: boolean;
  isFluid: boolean;
  isTranslucent: boolean;
}

export interface VoxelData {
  x: number;
  y: number;
  z: number;
  name: string;         // 例: "minecraft:oak_stairs"
  state?: BlockState;
  isTerrain: boolean;   // 元々の地形データかどうか
  opId: number;         // 生成元コードのトレースID (0は初期地形)
}

export interface TraceRecord {
  opId: number;
  line: number;         // AIが書いたスクリプトの行番号
  codeSnippet: string;  // 呼び出された関数名と引数 (例: 'placeFoundation(10, 10, 20, 20, 65, "stone_bricks")')
}

export type ViewDirection = "NE" | "SE" | "SW" | "NW";

export type InspectViewId = ViewDirection | "custom";

export type CameraProjection = "perspective" | "orthographic";

export type CameraPreset =
  | "NE"
  | "SE"
  | "SW"
  | "NW"
  | "N"
  | "S"
  | "E"
  | "W"
  | "TOP"
  | "FRONT"
  | "BACK"
  | "LEFT"
  | "RIGHT"
  | "RESET";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface CameraControlParams {
  preset?: CameraPreset;
  projection?: CameraProjection;
  target?: Vec3;
  position?: Vec3;
  yaw?: number;
  pitch?: number;
  distance?: number;
  zoom?: number;
  fov?: number;
  orthoSize?: number;
  zoomFactor?: number;
  deltaYaw?: number;
  deltaPitch?: number;
  deltaDistance?: number;
  pan?: Partial<Vec3>;
  resolution?: number;
  syncViewer?: boolean;
}

export interface CameraStateSnapshot {
  projection: CameraProjection;
  position: Vec3;
  target: Vec3;
  yaw: number;
  pitch: number;
  distance: number;
  zoom: number;
  fov: number;
  orthoSize: number;
  resolution: number;
  bounds: {
    min: Vec3;
    max: Vec3;
    center: Vec3;
    size: Vec3;
  };
}

export interface InspectResult {
  hit: boolean;
  coord?: { x: number; y: number; z: number };
  block?: string;
  state?: BlockState;
  isTerrain?: boolean;
  trace?: TraceRecord;
  distanceToGround?: number; // 直下の非空気ブロックまでの距離（浮き判定用）
}

// ピクセル逆引き（Viewer側）の生データ結果（サーバー側でTraceRecordやdistanceToGroundと結合することも可能、またはViewer側で完結も可能）
export interface RawPickResult {
  hit: boolean;
  x?: number;
  y?: number;
  z?: number;
  opId?: number;
}

// 地形サマリー構造
export interface TerrainSummary {
  size: [number, number, number];
  minY: number;
  maxY: number;
  averageY: number;
  heightmap: number[][]; // [x][z] -> max surface Y (-1 if column is all air)
  slopeSummary: string;
  blockCounts: Record<string, number>;
  textSummary: string;
}

// 構造評価結果（浮きブロック等の静的チェック）
export interface StructureEvaluation {
  valid: boolean;
  totalBuildBlocks: number;
  floatingBlocks: Array<{
    x: number;
    y: number;
    z: number;
    name: string;
    opId: number;
    trace?: TraceRecord;
    distanceToGround: number;
  }>;
  floatingClustersCount: number;
  outOfBoundsCount: number;
  warnings: string[];
}

// MCP Server <-> Three.js Viewer 間のWebSocket通信プロトコル
export type WsRequest =
  | {
      type: "SYNC_WORLD";
      id: string;
      voxels: VoxelData[];
      size: [number, number, number];
      traces?: Record<number, TraceRecord>;
      textures?: Record<string, string>; // textureKey -> data:image/png;base64,...
      blockModels?: Record<string, CompiledBlockDefinition>;
    }
  | { type: "RENDER_VIEWS"; id: string; resolution: number }
  | { type: "RENDER_CAMERA"; id: string; params: CameraControlParams }
  | { type: "INSPECT_PIXEL"; id: string; view: InspectViewId; u: number; v: number };

export type WsResponse =
  | { type: "SYNC_ACK"; id: string }
  | { type: "RENDER_RESULT"; id: string; images: Record<ViewDirection, string> } // Base64 PNG
  | {
      type: "RENDER_CAMERA_RESULT";
      id: string;
      image: string;
      camera: CameraStateSnapshot;
    }
  | { type: "INSPECT_RESULT"; id: string; data: InspectResult };

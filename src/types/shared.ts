export type BlockState = Record<string, string>; // 例: { facing: "north", half: "bottom" }

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

export interface InspectResult {
  hit: boolean;
  coord?: { x: number; y: number; z: number };
  block?: string;
  state?: BlockState;
  isTerrain?: boolean;
  trace?: TraceRecord;
  distanceToGround?: number; // 直下の非空気ブロックまでの距離（浮き判定用）
}

// ピクセル逆引き（Viewer側）の生データ結果
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

// --- 追加機能1：室内空間（Room）自動検出・動線チェック・内装レンダリング用の型定義 ---

export type CardinalDirection = "N" | "S" | "E" | "W";

export interface InteriorRoom {
  roomId: number;
  floorY: number;       // 部屋の床の上面（室内の空気ブロックの最下層Y座標）
  ceilingY: number;     // 部屋の天井直下の空気Y座標（天井ブロック自体は ceilingY + 1）
  center: { x: number; y: number; z: number }; // 室内中心座標（床+1または体積重心）
  eyePosition: { x: number; y: number; z: number }; // 室内一人称カメラ位置（床面 + 1.6ブロック相当）
  bounds: {
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
  };
  volume: number;       // 室内空気ボクセル数
  floorPositions: Array<{ x: number; y: number; z: number }>; // 床直上の室内空気座標リスト
  innerWallPositions: Array<{
    x: number;
    y: number;
    z: number;
    normal: CardinalDirection; // 壁が部屋の内側を向いている法線方向
  }>;
  doors: Array<{
    x: number;
    y: number;
    z: number;
    block: string;
    blocked: boolean;
    reason?: string;
  }>;
  lightingCount: number; // 室内および内壁・天井に配置された光源ブロック数
}

export interface InteriorFlowIssue {
  type: "door_blocked" | "unlit_room" | "low_headroom" | "isolated_room";
  roomId?: number;
  coord?: { x: number; y: number; z: number };
  message: string;
  trace?: TraceRecord;
}

export interface InteriorAnalysisReport {
  rooms: InteriorRoom[];
  suggestedCutY: number;
  flowIssues: InteriorFlowIssue[];
  validFlow: boolean;
  summaryText: string;
}

export interface RenderInteriorRoomCamera {
  roomId: number;
  eyePosition: { x: number; y: number; z: number };
}

// MCP Server <-> Three.js Viewer 間のWebSocket通信プロトコル
export type WsRequest =
  | {
      type: "SYNC_WORLD";
      id: string;
      voxels: VoxelData[];
      size: [number, number, number];
      traces?: Record<number, TraceRecord>;
      textures?: Record<string, string>; // blockName -> data:image/png;base64,...
    }
  | { type: "RENDER_VIEWS"; id: string; resolution: number }
  | {
      type: "RENDER_INTERIOR";
      id: string;
      resolution: number;
      cutY: number;
      rooms?: RenderInteriorRoomCamera[];
    }
  | { type: "INSPECT_PIXEL"; id: string; view: ViewDirection; u: number; v: number };

export type WsResponse =
  | { type: "SYNC_ACK"; id: string }
  | { type: "RENDER_RESULT"; id: string; images: Record<ViewDirection, string> } // Base64 PNG
  | {
      type: "RENDER_INTERIOR_RESULT";
      id: string;
      cutY: number;
      cutawayImages: Record<ViewDirection, string>; // 4方向のドールハウス断面ビュー Base64 PNG
      roomEyeImages: Record<number, Record<CardinalDirection, string>>; // roomId -> { N, S, E, W } 室内一人称ビュー Base64 PNG
    }
  | { type: "INSPECT_RESULT"; id: string; data: InspectResult };

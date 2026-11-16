# MineBuildingMCP

AI特化型の軽量マインクラフト建築エディタ＆MCPサーバー。
Blender等の外部ソフトを使わず、Java版ストラクチャーブロック（`.nbt`）の入出力、ローカルのMinecraft（`.jar`）からのアセット自動抽出（未インストール環境向けの決定論的16x16ピクセルアート生成フォールバック付き）、Three.jsによる4方向（`NE`, `SE`, `SW`, `NW`）レンダリング、および**画像上の `(u, v)` ピクセル指定から3D座標と生成元コードの行番号を1ミリ秒以下で逆引きするオフスクリーンIDバッファ**を備えています。

---

## ディレクトリ構成

```text
MineBuildingMCP/
├── package.json
├── tsconfig.json
├── vite.config.ts
├── index.html                  # Three.js ビューア用エントリー (デバッグHUD付き)
├── scripts/
│   └── generate-sample-terrain.ts # 32x32x32 斜面の崖と小さな川があるテスト用地形(.nbt)生成スクリプト
└── src/
    ├── types/
    │   └── shared.ts           # 全モジュール共通のインターフェース・WebSocketプロトコル定義
    ├── core/                   # [Agent 1] NBT入出力・ボクセル管理・建築DSL・行番号トレース
    │   ├── nbt-io.ts
    │   ├── voxel-world.ts
    │   └── builder-dsl.ts
    ├── assets/                 # [Agent 2] ローカルMinecraft(.jar)からのテクスチャ抽出＆フォールバック生成
    │   └── jar-loader.ts
    ├── viewer/                 # [Agent 3] Three.js描画・デュアルレンダーターゲット・ピクセル逆引き
    │   ├── main.ts
    │   ├── voxel-mesh.ts
    │   └── picker-pass.ts
    └── mcp/                    # [Agent 4] MCPサーバー・WebSocketブリッジ・Headlessブラウザ制御
        ├── server.ts
        └── ws-bridge.ts
```

---

## セットアップ & 使い方

### 1. 依存パッケージのインストールとビルド
```bash
npm install
npm run build
```

### 2. テスト用地形データ（`.nbt`）の生成
マイクラを起動しなくてもすぐに試せる「斜面の崖と小さな川がある32x32x32のテスト用地形データ（`samples/sloped_river_terrain.nbt`）」を生成します：
```bash
npm run generate-sample
```

### 3. MCPサーバーの起動 / Claude Desktop・Cursor等への登録
```json
{
  "mcpServers": {
    "MineBuildingMCP": {
      "command": "npx",
      "args": ["tsx", "/path/to/MineBuildingMCP/src/mcp/server.ts"],
      "env": {
        "MINECRAFT_JAR_PATH": "/optional/path/to/minecraft/version.jar"
      }
    }
  }
}
```
MCPサーバー起動時、自動的にViteサーバー（デフォルト `http://127.0.0.1:5173`）とWebSocketサーバー（デフォルト `ws://127.0.0.1:3001`）が立ち上がり、ブラウザ未接続時にはPlaywright Chromium（Headless）がバックグラウンドで自動起動します。人間がブラウザで `http://localhost:5173` を開いた場合は、両方の画面がリアルタイムに同期され、AIが `inspect_pixel` した座標が赤い3Dマーカーでハイライト表示されます。

---

## 公開 MCP Tools

1. **`load_terrain(nbtPath: string)`**
   - `.nbt` ファイルを読み込み、2D Heightmap・傾斜要約・ブロック内訳を返します。
2. **`run_build_script(jsCode: string, resolution?: number, resetBeforeRun?: boolean)`**
   - AIが記述した建築DSLスクリプトを実行し、浮きブロック等の静的構造チェック結果・行番号トレース表・4方向（`NE`, `SE`, `SW`, `NW`）のレンダリング画像（`ImageContent`）を返します。
   - 利用可能な主なDSL関数：`setBlock`, `fillBox`, `placeFoundation`, `buildWall`, `buildPitchedRoof`, `line`, `clearArea`, `getSurfaceY`, `getDistanceToGround`
3. **`inspect_pixel(view: "NE"|"SE"|"SW"|"NW", u: number, v: number)`**
   - 指定した視点画像のピクセル座標 `(u, v)` にあるブロックの3D座標 `(x, y, z)`、ブロック名・State、生成元スクリプトの行番号（`line`）と呼び出しコード（`codeSnippet`）、および直下の地面までの距離（`distanceToGround`）を即座に返します。
4. **`export_structure(outputPath: string)`**
   - 完成した建築物を含むワールドをJava版ストラクチャーブロック互換の `.nbt` 形式で保存します。

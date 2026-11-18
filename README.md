# MineBuildingMCP

AI特化型の軽量マインクラフト建築エディタ＆MCPサーバー。
Blender等の外部ソフトを使わず、Java版（`.nbt`）および統合版 Bedrock Edition（`.mcstructure`）ストラクチャーブロックの双方向入出力、ローカルのMinecraft（`.jar`）からのアセット自動抽出（未インストール環境向けの決定論的16x16ピクセルアート生成フォールバック付き）、Three.jsによる外装4方向・内装ドールハウス断面・室内一人称レンダリング、および**画像上の `(u, v)` ピクセル指定から3D座標と生成元コードの行番号を1ミリ秒以下で逆引きするオフスクリーンIDバッファ**を備えています。

---

## ディレクトリ構成

```text
MineBuildingMCP/
├── package.json
├── tsconfig.json
├── vite.config.ts
├── index.html                  # Three.js ビューア用エントリー (デバッグHUD・Cutawayスライダー付き)
├── scripts/
│   └── generate-sample-terrain.ts # 32x32x32 斜面の崖と小さな川があるテスト用地形(.nbt)生成スクリプト
└── src/
    ├── types/
    │   └── shared.ts           # 全モジュール共通のインターフェース・WebSocketプロトコル定義
    ├── core/                   # [Agent 1] NBT/.mcstructure入出力・ステート変換・室内空間検出・建築DSL・行番号トレース
    │   ├── nbt-io.ts
    │   ├── state-translator.ts
    │   ├── voxel-world.ts
    │   └── builder-dsl.ts
    ├── assets/                 # [Agent 2] ローカルMinecraft(.jar)からのテクスチャ抽出＆フォールバック生成
    │   └── jar-loader.ts
    ├── viewer/                 # [Agent 3] Three.js描画・断面/室内カメラ・デュアルレンダーターゲット・ピクセル逆引き
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
        "MINECRAFT_JAR_PATH": "/optional/path/to/minecraft/version.jar",
        "MINEBUILDING_OPEN_VIEWER": "true"
      }
    }
  }
}
```
MCPサーバー起動時、自動的にViteサーバー（デフォルト `http://127.0.0.1:5173`）とWebSocketサーバー（デフォルト `ws://127.0.0.1:3001`）が立ち上がり、ブラウザ未接続時にはPlaywright Chromium（Headless）がバックグラウンドで自動起動します。人間がブラウザで `http://localhost:5173` を開いた場合は、両方の画面がリアルタイムに同期され、AIが `inspect_pixel` した座標が赤い3Dマーカーでハイライト表示されます。

#### 主な環境変数 / CLIフラグ
- `MINEBUILDING_OPEN_VIEWER=true` または CLIフラグ `--open-viewer`: MCPサーバー起動時／ツール実行時に可視ブラウザ（OS標準ブラウザ）で3DビューアURLを自動で1回だけ開きます（すでに可視ブラウザが接続済みの場合は多重起動しません）。
- `MINEBUILDING_HEADLESS=false`: Playwright Chromiumをヘッドレスではなく可視ウィンドウとして起動します。
- `MINEBUILDING_VITE_PORT` / `MINEBUILDING_WS_PORT`: ViteサーバーおよびWebSocketサーバーのポート番号を指定します（デフォルト: `5173` / `3001`）。
- `MINECRAFT_JAR_PATH`: ローカルのMinecraftクライアント `.jar` のパスを明示指定します（未指定時は標準インストール先から自動検出）。

---

## 公開 MCP Tools

1. **`load_terrain(nbtPath: string)`**
   - Java版 `.nbt` または統合版（Bedrock Edition）`.mcstructure` ファイルを読み込み、2D Heightmap・傾斜要約・ブロック内訳を返します。
2. **`run_build_script(jsCode: string, resolution?: number, resetBeforeRun?: boolean)`**
   - AIが記述した建築DSLスクリプトを実行し、浮きブロック等の静的構造チェック結果・行番号トレース表・4方向（`NE`, `SE`, `SW`, `NW`）のレンダリング画像（`ImageContent`）を返します。
   - **外装・基本DSL関数**：`setBlock`, `fillBox`, `placeFoundation`, `buildWall`, `buildPitchedRoof`, `line`, `clearArea`, `getSurfaceY`, `getDistanceToGround`
   - **内装（インテリア）DSL関数**：`detectRooms`, `getRoomById`, `placeDoor`, `placeLighting`, `placeBed`, `placeTable`, `placeChair`, `furnishRoom`
3. **`render_camera(params)`**
   - AIがカメラの位置・注視点・角度・ズームを自由に操作して任意の視点からクローズアップや俯瞰画像をレンダリングし、ライブビューアのカメラも同期できます。
   - 主なパラメータ：`preset` (`NE|SE|SW|NW|N|S|E|W|TOP|FRONT|BACK|LEFT|RIGHT|RESET`), `projection` (`perspective|orthographic`), `target` (`{x,y,z}`), `position` (`{x,y,z}`), `yaw`, `pitch`, `distance`, `zoom`, `fov`, `orthoSize`, 相対調整（`zoomFactor`, `deltaYaw`, `deltaPitch`, `deltaDistance`, `pan`）, `resolution`, `syncViewer`
   - レンダリング結果は `"custom"` 視点のIDピッカーバッファにも保存されるため、続けて `inspect_pixel(view="custom", u, v)` で詳細部のブロックやソース行を逆引きできます。
4. **`inspect_pixel(view: "NE"|"SE"|"SW"|"NW"|"custom", u: number, v: number)`**
   - 指定した視点画像（4方向・ドールハウス断面ビュー・`render_camera` の `"custom"` 視点）のピクセル座標 `(u, v)` にあるブロックの3D座標 `(x, y, z)`、ブロック名・State、生成元スクリプトの行番号（`line`）と呼び出しコード（`codeSnippet`）、および直下の地面までの距離（`distanceToGround`）を即座に返します。
5. **`inspect_interior(cutY?: number, resolution?: number)`**
   - 建物内部の部屋（`InteriorRoom`）を自動検出し、ドア前クリアランスや照明有無などの動線チェック（`flowIssues`）を行うとともに、以下をレンダリングして返します：
     - **Dollhouse Cutaway（ドールハウス断面図）4方向**：指定した `cutY` より上の天井・屋根とカメラ手前側の外壁を非表示にし、オフスクリーンIDバッファ（`picker-pass`）も断面状態に同期します。直後に `inspect_pixel` を呼ぶことで室内の家具・床・内壁の3D座標とコード行番号を直接逆引きできます。
     - **Room Eye-Level（室内一人称ビュー）**：検出された各部屋の中心（床+1.6ブロック）から室内4方向（`N`, `S`, `E`, `W`）を撮影した一人称視点画像を出力します。
6. **`open_viewer(force?: boolean)`**
   - ライブ3Dビューア（`http://127.0.0.1:<vitePort>?wsPort=<wsPort>`）をOSのデフォルトブラウザで開きます（すでに可視ブラウザ接続済みの場合は重複起動をスキップ、`force=true` で強制起動）。
7. **`export_structure(outputPath: string)`**
   - 完成した建築物を含むワールドを、拡張子に応じてJava版 `.nbt`（Big-Endian Gzip）または統合版 `.mcstructure`（Little-Endian 無圧縮 + ブロックステート自動変換）形式で保存します。

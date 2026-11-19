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
    ├── core/                   # [Agent 1] NBT/.mcstructure入出力・ステート変換・隣接ステート解決・建築整合性リンター・室内空間検出・建築DSL・行番号トレース
    │   ├── nbt-io.ts
    │   ├── state-translator.ts
    │   ├── block-state-resolver.ts
    │   ├── structure-linter.ts
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

## AI 建築標準ワークフロー＆設計前リサーチ指針

AIエージェントが `MineBuildingMCP` で建築を行う際は、現実世界の物理感覚によるマイクラ仕様破綻を防ぐため、以下の3フェーズ（MCP Prompt `minecraft_building_workflow` としても公開）を標準手順とします。

1. **Phase 1: 設計前リサーチ（Minecraft建築の定番イディオム調査）**
   - 建築テーマやモチーフが決まったら、いきなりDSL（`run_build_script`）を書き始めず、まずWeb検索等で **そのテーマにおけるMinecraft特有の定番イディオム** を調査・整理します：
     - **屋根の勾配と軒先**：階段・ハーフ・フルブロックの比率、破風（Gable）やドーマーの縁取り技法
     - **壁面の奥行きとフレーム**：柱を1ブロック手前に出す2層構造、階段・トラップドア・塀（`*_wall`）による凹凸表現
     - **ブロックパレットの混色**：同系色3〜4ブロック（例：`stone_bricks` + `cracked_stone_bricks` + `andesite` + `mossy_stone_bricks`）のグラデーション／ノイズ混色
     - **鎖・照明・接続パーツのバニラ仕様**：Minecraftの鎖（`chain` / `iron_chain`）は単一軸（`axis=x/y/z`）しか持てないため、横向きの鎖の途中から縦向きの鎖を直接垂らす「T字・L字直結」は破綻します。必ず交点に **フェンス（`*_fence`）・塀（`*_wall`）・砥石（`grindstone`）・ホッパー（`hopper`）・フルブロック** 等の中継パーツを噛ませます。
2. **Phase 2: 地形読み込みと段階的DSL構築（`load_terrain` -> `run_build_script`）**
   - 地形のHeightmap・傾斜に合わせて `placeFoundation` で土台を接地させ、隣接ステート（フェンス・塀・階段の角・ツタの張り付き面など）はJAR内のタグ・blockstate定義から自動解決されます。
3. **Phase 3: バニラ建築整合性リンター（`lint_structure`）と視覚確認ループ**
   - ビルド時の自動レポートまたは `lint_structure` で検出される警告（`axis_mismatch_junction`：単軸細身ブロックの異軸隣接、`missing_support`：壁張り付き・吊り下げブロック等の支持体欠損、浮きブロック）を確認します。
   - 警告に含まれる **座標 `(x, y, z)`・DSL行番号（`line`）・改善ヒント（`hint`）** および `render_camera` + `inspect_pixel` の視覚逆引きを組み合わせて該当DSL行を修正し、警告が **0件** になってから `export_structure` で完了とします。

---

## 公開 MCP Tools & Prompts

1. **`load_terrain(nbtPath: string)`**
   - Java版 `.nbt` または統合版（Bedrock Edition）`.mcstructure` ファイルを読み込み、2D Heightmap・傾斜要約・ブロック内訳を返します。
2. **`run_build_script(jsCode: string, resolution?: number, resetBeforeRun?: boolean)`**
   - AIが記述した建築DSLスクリプトを実行し、隣接ブロックステートの自動解決、浮きブロック等の静的構造チェック、**バニラ建築整合性リンター（`Vanilla Building Linter`）の自動検査**、行番号トレース表、および4方向（`NE`, `SE`, `SW`, `NW`）のレンダリング画像（`ImageContent`）を返します。
   - **外装・基本DSL関数**：`setBlock`, `fillBox`, `placeFoundation`, `buildWall`, `buildPitchedRoof`, `line`, `clearArea`, `getSurfaceY`, `getDistanceToGround`
   - **内装（インテリア）DSL関数**：`detectRooms`, `getRoomById`, `placeDoor`, `placeLighting`, `placeBed`, `placeTable`, `placeChair`, `furnishRoom`
3. **`lint_structure()`**
   - 現在のワールドに対してバニラ建築整合性リンター（静的検査）を実行し、Minecraft仕様上不自然・破綻しやすい箇所を警告リスト（問題の種別 `type`、座標 `coord`、該当DSL行番号 `line` と `codeSnippet`、改善のヒント `hint`）として返します。
   - 主な検出項目（JAR内JSON/タグ・プロパティ構造駆動）：
     - `axis_mismatch_junction`：鎖（`#chains` 等）などの単軸細身ブロックが異なる `axis` 同士で直接隣接しているT字・L字破綻（交点にフェンス・塀・砥石・フルブロック等の接続パーツ挿入を提案）
     - `missing_support`：壁張り付き系（`vine`, `glow_lichen` 等）、吊り下げ・床置き系（`hanging=true/false` のランタン等）、壁・天井設置ブロック（`attachment`, `face`, 壁掛け松明等）の支持先が空気または非支持ブロックになっている箇所
4. **`render_camera(params)`**
   - AIがカメラの位置・注視点・角度・ズームを自由に操作して任意の視点からクローズアップや俯瞰画像をレンダリングし、ライブビューアのカメラも同期できます。
   - 主なパラメータ：`preset` (`NE|SE|SW|NW|N|S|E|W|TOP|FRONT|BACK|LEFT|RIGHT|RESET`), `projection` (`perspective|orthographic`), `target` (`{x,y,z}`), `position` (`{x,y,z}`), `yaw`, `pitch`, `distance`, `zoom`, `fov`, `orthoSize`, 相対調整（`zoomFactor`, `deltaYaw`, `deltaPitch`, `deltaDistance`, `pan`）, `resolution`, `syncViewer`
   - レンダリング結果は `"custom"` 視点のIDピッカーバッファにも保存されるため、続けて `inspect_pixel(view="custom", u, v)` で詳細部のブロックやソース行を逆引きできます。
5. **`inspect_pixel(view: "NE"|"SE"|"SW"|"NW"|"custom", u: number, v: number)`**
   - 指定した視点画像（4方向・ドールハウス断面ビュー・`render_camera` の `"custom"` 視点）のピクセル座標 `(u, v)` にあるブロックの3D座標 `(x, y, z)`、ブロック名・State、生成元スクリプトの行番号（`line`）と呼び出しコード（`codeSnippet`）、および直下の地面までの距離（`distanceToGround`）を即座に返します。
6. **`inspect_interior(cutY?: number, resolution?: number)`**
   - 建物内部の部屋（`InteriorRoom`）を自動検出し、ドア前クリアランスや照明有無などの動線チェック（`flowIssues`）を行うとともに、以下をレンダリングして返します：
     - **Dollhouse Cutaway（ドールハウス断面図）4方向**：指定した `cutY` より上の天井・屋根とカメラ手前側の外壁を非表示にし、オフスクリーンIDバッファ（`picker-pass`）も断面状態に同期します。直後に `inspect_pixel` を呼ぶことで室内の家具・床・内壁の3D座標とコード行番号を直接逆引きできます。
     - **Room Eye-Level（室内一人称ビュー）**：検出された各部屋の中心（床+1.6ブロック）から室内4方向（`N`, `S`, `E`, `W`）を撮影した一人称視点画像を出力します。
7. **`open_viewer(force?: boolean)`**
   - ライブ3Dビューア（`http://127.0.0.1:<vitePort>?wsPort=<wsPort>`）をOSのデフォルトブラウザで開きます（すでに可視ブラウザ接続済みの場合は重複起動をスキップ、`force=true` で強制起動）。
8. **`export_structure(outputPath: string)`**
   - 完成した建築物を含むワールドを、拡張子に応じてJava版 `.nbt`（Big-Endian Gzip）または統合版 `.mcstructure`（Little-Endian 無圧縮 + ブロックステート自動変換）形式で保存します。
9. **MCP Prompt: `minecraft_building_workflow(theme?: string)`**
   - 建築テーマに応じた「設計前イディオム調査 → DSL構築 → バニラ建築整合性リンター（`lint_structure`）＆視覚逆引きによる破綻修正」の標準ワークフロー指針を返します。

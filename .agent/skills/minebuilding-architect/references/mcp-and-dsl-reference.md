# MineBuildingMCP — エンジン仕様・MCPツール・DSLリファレンス

このリファレンスは `MineBuildingMCP` のソースコードや MCP スキーマ JSON を毎回再読せず、初手から正確に設計・構築するための確定仕様集である。

---

## 1. ハード制約＆既知のエンジン地雷（最優先）

| 項目 | 確定仕様・安全値 | 違反時の挙動・回避策 |
|---|---|---|
| **ワールド上限** | 各軸 `[1..256]`（座標 `0..255`） | `VoxelWorld` が `256` でサイレントクランプし、範囲外配置は破棄＋`outOfBoundsCount++`。未ロード時デフォルトは **`32×32×32`** のため、最初に必ずサイズ指定 `.nbt` を `load_terrain` する。 |
| **RGBA8 IDピッカー安全領域** | 座標 **`0..254`**（推奨 **`[2..253, 2..250, 2..253]`**） | `OffscreenPickerPass` が `(x, y, z, opId)` を RGBA 各 8-bit に格納し、背景空を `(255, 255, 255, 0)` とするため、座標 `255` は `inspect_pixel` の空判定と衝突リスクがある。 |
| **ブロック数予算＆同期タイムアウト** | 快適 `50k–160k` / 大規模目標 `160k–220k` / **安全上限 `240k–260k`**（絶対上限 `<300k`） | `WsBridge` のデフォルト `requestTimeoutMs = 30,000ms`。全ボクセルを単一 JSON `SYNC_WORLD`（上限 100MiB）で送信し、ブラウザメインスレッドで同期メッシュ＋エッジ生成を行うため、`300k+`（特に露出面が多い中空建築）は 30秒タイムアウトまたは OOM を起こす。ユーザー要求が `>256` 座標や `>300k` ブロックなら着工前に上限を共有し合意する。 |
| **8-bit `opId` 255 ラップアラウンド** | `activeOpId = ((opCounter - 1) % 255) + 1`（`0`＝地形） | 255回を超える `setBlock` ループは古い `traces[opId]` を上書きし、`inspect_pixel` や警告の `trace.line` / `codeSnippet` が後続行を指す（`coord`/`block`/`state` は常に正確）。大量配置は `fillBox` や `fSet`（軽量な直接配置）を使い、精密ディテールはスクリプト末尾に配置する。 |
| **`evaluateStructure()` 大規模浮遊処理** | コア修正済（反復 `for` ループ） | 旧版の `Math.min(...group.map(...))` スプレッドによる V8 スタック溢れは解消済み。`fSet` は大量配置の高速化と不要な `traces` 肥大化抑制のために引き続き推奨。 |
| **`lint_structure` JSON-RPC 上限保護** | コア修正済（`floatingBlocks` 上限 `100` 件、`issues` 上限 `200` 件） | `handleLintStructure()` は JSON 内の `floatingBlocks` を先頭 `100` 件（`MAX_LINT_FLOATING_BLOCKS`）へ制限し、`floatingBlocksCount`・`floatingClustersCount`・`floatingBlocksTruncatedCount`（および `issuesTruncatedCount`）を返すため JSON-RPC フレーム溢れは発生しない。意図した空中建築で警告ノイズを消し `floatingBlocks: 0` に揃えたい場合は `dry_run_validator.mjs --emit-anchors` でクラスタ別 `isTerrain=true` シード（元ブロックID・ステートを忠実継承）を生成して読み込む。 |
| **`.nbt` vs `.mcstructure` 容量差** | `.nbt`＝疎リスト＋Gzip / `.mcstructure`＝無圧縮密配列×2層 | `254×224×254` で `.nbt` が ~770 KB に対し `.mcstructure` は **115.6 MB（約150倍）**。キャンバス・中間チェックポイントは常に `.nbt` を使い、`.mcstructure` は最終納品時に要求された場合のみ1回出力する。 |
| **地形シードの保護** | `setBlock()` は `isTerrain` を `false` に上書きする | 空中建築のコアに置いた `isTerrain=true` シードを上書きすると全体が浮遊扱いになる。配置ヘルパー（`pSet`/`fSet`/`fClear`）で `existing?.isTerrain` を保護する。 |

### 実測レイテンシ目安（ヘッドレス Chromium 計測値）
- `~65k` ボクセル：`load_terrain` ~10s、`run_build_script(512)` 5–6s、`render_camera(768)` 2–4s
- `81k–186k` ボクセル（最適化済）：`Build + Sync + 4 Ortho(512)` 3.5s–8s
- `222k` ボクセル：`run_build_script(512)` 13–15s、`lint_structure` 6–7s、`render_camera(768–1024)` 2–4s

---

## 2. MCP ツール全8種クイックリファレンス

| ツール名 | 主な引数（`*`＝必須） | 挙動・運用上の注意点 |
|---|---|---|
| `load_terrain` | `nbtPath*` | `.nbt` / `.mcstructure` を初期地形（全ブロック `isTerrain=true`）として読込・同期。大規模ワールドでは Heightmap 出力が数万行になるため先頭25行のサマリーのみ確認する。チェックポイント `.nbt` の復元にも使える。 |
| `run_build_script` | `jsCode*`, `resetBeforeRun` (`true`), `resolution` (`512`) | BuilderDSL を実行し、自動ステート解決・Vanilla Linter・浮遊判定・3D同期・4方向正投影 PNG (`NE/SE/SW/NW`) を返す。増分ビルド時は `resetBeforeRun: false`。 |
| `lint_structure` | なし | 静的 Vanilla Building Linter（`axis_mismatch_junction`, `missing_support`）＋構造評価を実行。JSON 出力は `floatingBlocks` 先頭 `100` 件＋総数・クラスタ数・省略数（`floatingBlocksCount`, `floatingClustersCount`, `floatingBlocksTruncatedCount`）を返す。空中建築で `floatingBlocks: 0` を確定したい場合は `--emit-anchors` 済みキャンバスを併用する。 |
| `render_camera` | `projection` (`"perspective"`/`"orthographic"`), `target` `{x,y,z}`, `position` `{x,y,z}` or (`yaw`, `pitch`, `distance`), `fov` (`45`), `zoom`, `preset`, `pan`, `deltaYaw`/`deltaPitch`/`deltaDistance`, `resolution` (`512`, `[64..2048]`), `syncViewer` (`true`) | 自由視点 PNG を出力し `inspect_pixel(view="custom", u, v)` 用バッファを更新。角度規約：`yaw` `0=N(-Z), 90=E(+X), 180=S(+Z), 270=W(-X)`、`pitch` `[-89..89]`（`+`＝見下ろし、`-`＝見上げ）。`position` 指定時は `yaw/pitch/distance` を上書き。 |
| `inspect_pixel` | `view*` (`NE`/`SE`/`SW`/`NW`/`custom`), `u*`, `v*` | オフスクリーン RGBA ID ピッカーで `(x,y,z)`・ブロック名・State・`distanceToGround`・Trace を `<1ms` で逆引き。**注意**: `u` と `v` の**両方**が `0 < val < 1` のときのみ正規化座標扱い（片方が `0` や `1` だとピクセル座標扱い）。 |
| `inspect_interior` | `cutY`, `resolution` (`512`) | 室内空間自動検出＋ドールハウス断面4方向＋各室一人称4方向を出力。複雑地形・複数棟では自動 `cutY` が低すぎる小空洞を拾うため、**対象部屋の `floorY + 3..4` を明示 `cutY` で渡す**こと。 |
| `open_viewer` | `force` (`false`) | ライブ 3D Three.js ビューアを既定ブラウザで開く（既に接続済みならスキップ）。 |
| `export_structure` | `outputPath*` | 拡張子で `.nbt`（Java, `DataVersion: 3953`）か `.mcstructure`（Bedrock, `format_version: 1`）を自動切替。出力前に `resolveWorldBlockStates` を自動適用する。 |

---

## 3. BuilderDSL サンドボックス＆API

### 実行環境（`node:vm`）の制約
- ラッパー：`(function(scope) { with (scope) { ${jsCode}\n} })`（行番号は 1-to-1 で一致）。
- **`require` / `import` / `fs` は不可**。`export` 構文も構文エラーになる。
- **重要**：`resetBeforeRun: false` でフェーズ分割しても **JS 変数・関数は次回呼び出しへ引き継がれない**（`world` インスタンスのみ維持）。`geometry_helpers.js` 等の共有関数はフェーズごとに先頭へ結合する。

### `scopeBindings` で直接使えるグローバル＆DSL関数（全17種）
- グローバル：`dsl`, `world`, `Math`, `console`
- 直接 `world` メソッド：`world.size` (`[W, H, D]`), `world.getVoxel(x, y, z)`, `world.getInitialTerrainVoxel(x, y, z)`, `world.setVoxel(x, y, z, name, state, isTerrain=false, opId)`
- ブロック・地形系：
  - `setBlock(x, y, z, block, state?)`
  - `fillBox(x1, y1, z1, x2, y2, z2, block, hollow=false, state?)`
  - `clearArea(x1, y1, z1, x2, y2, z2)`
  - `placeFoundation(x1, z1, x2, z2, topY, block)` — `topY` から `isTerrain` または `y=0` まで垂直充填
  - `buildWall(x1, z1, x2, z2, height, block, followTerrain=false, baseY?)`
  - `buildPitchedRoof(x1, z1, x2, z2, startY, stairBlock, direction="NS"|"EW", gableBlock?)`
  - `line(x1, y1, z1, x2, y2, z2, block, state?)` — 3D 直線（斜めは6連結保証なし。6連結必須なら `drawStrut` を使用）
  - `getSurfaceY(x, z, terrainOnly=true)` / `getDistanceToGround(x, y, z)`
- 内装・部屋系：
  - `detectRooms()` / `getRoomById(roomId?)`
  - `placeDoor(x, y, z, doorBlock="minecraft:oak_door", facing="north")`
  - `placeLighting(x, y, z, lightBlock="minecraft:lantern", hanging?)`
  - `placeBed(x, y, z, facing="north", color="red")`
  - `placeTable(x, y, z, fenceBlock="minecraft:oak_fence", carpetOrSlabBlock="minecraft:brown_carpet")`
  - `placeChair(x, y, z, stairBlock="minecraft:oak_stairs", facing="north")`
  - `furnishRoom(roomId?, style="living"|"bedroom"|"study"|"workshop"|"dining")`

---

## 4. ローカル `.jar` アセット・ブロックID・自動ステート解決・Linter 厳密仕様

### ローカル Minecraft `.jar` とサンドボックス罠
- `JarAssetLoader` は `process.env.MINECRAFT_JAR_PATH` → OS 標準 `.minecraft/versions/` から最新 `.jar`（例：`26.3.jar`）を自動検出する。
- **Windows サンドボックス罠**：サンドボックス内の `run_command` は `%APPDATA%\.minecraft` にアクセスできず **`jarFound: false`** で静かにフォールバックする。この状態では：
  1. 全ブロックが不透明なハッシュ色キューブになり、色付きガラスの透過や階段・柵・鎖の 3D モデルが消失する。
  2. `getBlockModelsForBlocks()` が存在しないブロックIDやアイテム名（例：`spyglass`）にも擬似キューブを合成するため、**ブロックID存在チェックが偽陽性通過する**。
  3. `#chains` や `multiface_clinging` 等の JAR タグ／モデル形状が読めないため、ローカル `dry_run` の `axis_mismatch_junction`・ツタ支持チェックがスキップされる（最終確認は必ず実 JAR `jarFound=true` または MCP `lint_structure` で行うこと）。
  - **対策**：`dry_run_validator.mjs` / `batch_render.mjs` 出力の `jarFound=true` を必ず確認する（必要時のみ `--require-jar` 付きでサンドボックス外実行）。

### モダン JAR（MC 1.21.9+ / 26.x）特有のブロックID注意点
- **`minecraft:chain` → `minecraft:iron_chain`**：最新 JAR には `blockstates/chain.json` が存在せず `iron_chain`（および `copper_chain`, `oxidized_copper_chain`, `copper_lantern`, `copper_bars`, `copper_bulb`, `tuff_bricks` 等）が正式 ID。`JarAssetLoader` は `#chains` タグで旧 `chain` も補完するが、スクリプトは最初から **`minecraft:iron_chain`** を使用すること。
- 未知のブロックIDは見た目上ハッシュ単色キューブへ黙ってフォールバックするため、新規・珍しいブロックは実 JAR で存在確認してから使う。

### 自動ステート解決（`block-state-resolver.ts`）と省略すべきキー
`resolveWorldBlockStates()` は **Y降順（上から下）** に全ブロックの隣接ステートを自動計算し、ユーザーが明示指定したキー（`explicitStateKeys`）は上書きしない。したがって：
- **階段 (`*_stairs`)**：`{ facing, half }` のみ渡し、`shape`（`inner_left/right`, `outer_left/right`）は省略して自動接続させる。
- **フェンス (`*_fence`)・塀 (`*_wall`)・鉄格子／板ガラス (`*_bars`, `*_pane`)**：`north/south/east/west/up` は**無指定**にする（バニラ規則どおり `#leaves` 非接続、`fence` と `wall`/`pane` は非接続）。
- **ツタ (`vine`)・ヒカリゴケ (`glow_lichen`)**：方向キー無指定で隣接フル不透明キューブへ自動張り付き＋上部同種ブロックから垂れ下がり継承。支持面が0のままだと all-false フォールバックで中空箱描画になるため絶対禁止。

### Vanilla Building Linter（`structure-linter.ts`）の2大チェック
1. **`axis_mismatch_junction`**：単軸細身ブロック（`#chains` タグ、または `axis` バリアントを持ち断面2軸が `<=10px` のモデル。丸太・柱等のフルキューブは除外）が、異なる `axis` の単軸細身ブロックと6近傍で直接隣接すると警告。交点に `*_wall`・`*_fence`・`grindstone`・`hopper`・フルブロックのいずれかを必ず挟む。
2. **`missing_support`**：
   - `vine` / `glow_lichen`（`multiface_clinging`）：張り付き面に **フル不透明キューブ**（`isInstanceFullOpaqueCube && !isFluid`）が必須。塀・フェンス・階段・ハーフ・ガラス・葉は支持体にならない。垂れ下がりツタは最上段が水平方向のフル不透明キューブに接していれば下段へ連続継承可能。
   - `lantern` / `soul_lantern`（`hanging`）：`hanging="true"` は `y+1` に剛体支持（横向き鎖 `axis=x/z` は不可、縦鎖 `axis=y`・天井・フェンス・塀は可）。`hanging="false"` は `y-1` に剛体支持。
   - `bell` / `grindstone` / `lever` / `*_button`（`attachment`/`face`）および壁掛けブロック（`wall_torch`, `wall_sign`, `ladder`）：指定方向の背面・上下に剛体支持が必須。

---

## 5. CLI・Windows PowerShell・ヘッドレス描画の運用 Tips

- **PowerShell の引用符剥がれ回避**：`node -e "import(...)"` は Windows PowerShell が内部 `"` を剥がして `SyntaxError` になりやすい。インライン実行は避け、`scripts/` 配下の `.mjs` を引数付きで実行する。
- **モジュール解決**：外部プロジェクトから `MineBuildingMCP` を呼ぶときは `scripts/resolve_mcp.mjs` 経由で `MineBuildingMCP/dist/` を ESM import する（`tsx -e` は CJS 評価となり `.js`→`.ts` 解決が失敗する）。
- **テスト＆動画録画の注意**：
  - `MineBuildingMCP` のテストは並列 Chromium 起動でタイムアウトしやすいため `npx vitest run --fileParallelism=false`。
  - `tsx` 下で Playwright の `page.evaluate(fn)` に関数を渡すと `esbuild keepNames` の `__name` 注入で `ReferenceError: __name is not defined` になるため文字列で渡す。
  - プログラム起動の `MineBuildingMcpServer`（`scripts/batch_render.mjs`）は稼働中 MCP サーバー（`3001`/`5173`）と競合しない専用ポート（既定 `wsPort=3088`, `vitePort=5188`, `openViewer: false`）で完結するため、ユーザーのブラウザへ自動反映されない（前セッションの古いタブは切断状態のまま残る）。`batch_render.mjs` 併用時は節目・完了時にライブ MCP の `load_terrain(checkpointNbt)` → `open_viewer` → `render_camera(syncViewer: true)` で必ずライブ 3D ビューアへ同期する。
  - 3D ビューアの Auto-Rotate（HUD トグル＋速度スライダー、ショートカット `R`、HUD 非表示 `H`、URL クエリ `?autoRotate=1&autoRotateSpeed=1.2&hud=0`）および `window.__mineBuildingViewer` でターンテーブル鑑賞・シームレス 360° 録画が可能。Playwright 録画では SwiftShader を外し `['--use-gl=angle', '--enable-webgl', '--ignore-gpu-blocklist', '--no-sandbox']` を試すとネイティブ GPU で 10倍以上高速（失敗時のみ SwiftShader フォールバック）。

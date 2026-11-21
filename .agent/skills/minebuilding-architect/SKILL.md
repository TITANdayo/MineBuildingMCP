---
name: minebuilding-architect
description: >-
  MineBuildingMCPを用いた大規模・高密度Minecraft建築の設計、中空シェル生成、ローカル事前検証（dry_run）、
  Vanilla Building Linter警告0件化、マルチアングル視覚検証、および構造エクスポート（.nbt/.mcstructure）を
  ソースコード再読なしで最短・最高品質に遂行する建築スキル。MineBuildingMCPでの新規建築・改修・レンダリング・
  構造デバッグ、または過去建築ログからの知見更新を依頼された際に必ず発動する。
---

# MineBuildingMCP Architect Skill

`MineBuildingMCP` のソースコードや MCP スキーマを毎回 `Analyzed` せずに、初手からエンジン上限・バニラ整合性・造形美学を満たす大規模建築を構築するための実行ランブック。

---

## 1. ハード制約サマリー（厳守）

1. **ワールド上限＆安全座標**：各軸最大 `256`（`0..255`）。`OffscreenPickerPass` が `(255,255,255,0)` を空判定に使うため、**キャンバスは `<=254` 各軸または安全領域 `[2..253, 2..250, 2..253]`** に全ブロックを収める（`OOB: 0`）。未ロード時デフォルトは `32³` のため必ず最初に `load_terrain` する。
2. **ブロック数上限（30秒同期タイムアウト回避）**：中空シェル設計を徹底し、総ブロック数は **目標 `160k–220k`（安全上限 `240k–260k`、絶対上限 `<300k`）**。ユーザー要求が `>256` 座標や `>300k` ブロックなら着工前に仕様調整を合意する。
3. **配置パフォーマンス＆空中建築の接地**：
   - 大量配置は `geometry_helpers.js` の `fSet`（`opId` を `1..250` 巡回し軽量配置）を使い、不要なトレース上書きや肥大化を防ぐ。
   - `evaluateStructure()` と `lint_structure` の大量浮遊クラッシュはコア修正済み（`lint_structure` は `floatingBlocks` 先頭100件＋総数・クラスタ数のみ返却）。意図した空中建築で `floatingBlocks: 0` のクリーンな検証状態にする場合は `dry_run_validator.mjs --emit-anchors` でクラスタ別 `isTerrain=true` アンカー `.nbt` を生成する。
4. **ブロックID＆実 JAR 確認**：MC 1.21.9+/26.x のローカル JAR では鎖は **`minecraft:iron_chain`**（旧 `chain` は非推奨）。サンドボックス実行は `%APPDATA%\.minecraft` が読めず `jarFound=false`（不透明キューブ化）になるため、視覚・最終検証では必ず `jarFound=true` を確認する。
5. **形式選択＆VM非永続**：チェックポイントは常に疎＋Gzip の **`.nbt`**（`.mcstructure` は無圧縮密配列で約150倍重いため最終納品時のみ）。`run_build_script` は `resetBeforeRun: false` でも JS 変数を引き継がないため、共有ヘルパーは毎回先頭へ結合する。

> ツール引数・DSL 全17関数・自動ステート解決・Linter 厳密仕様 → [references/mcp-and-dsl-reference.md](./references/mcp-and-dsl-reference.md)

---

## 2. 鉄の造形・配色・バニラ整合ルール

1. **ランダムノイズ散布の禁止**：高彩度ブロックの1マス単位ランダム散布（紙吹雪化）を禁止。距離・高さ・温度・風化などの**連続関数＋低周波 `fbm3D`（周波数 `0.07..0.18`）による帯状グラデーション**を使う。
2. **パレット統一（モジュール／オブジェクト単位で ≤ 3トーン原則）**：個別の建築モジュールや自然／天体オブジェクトごとに最大3つの色調ファミリー（明色壁・暗色構造・金属/温色アクセント）に絞り、多色お祭り化を防ぐ。複合テーマの主建築と自然・天体背景、および暖色（居住区）／寒色（コア・深淵）の色温度コントラストには別予算を用い、シーン全体の単調化・色褪せを避ける。
3. **立体構図と抜け感**：平面的な並列配置を避け、Y軸の 70–90% を使う高低差・必要に応じた `28°–38°` 傾斜基底 `(U,V,N)`・2層以上の壁面凹凸・主役を引き立てるネガティブスペースを設計段階で確保する。
4. **外側面・内側面の文字／記号反転防止**：二重面に文字・記号を配置するときは単一軸を共有せず、必ず外向き法線から `right = cross(up, outwardNormal)` を導出する（`stampGlyphPlane` 使用）＋外周 `render_camera` で実読確認する。
5. **バニラ整合＆警告0件**：鎖の T字/L字直結禁止（交点に `*_wall`/`*_fence`/`grindstone`/フルブロックを挟む）、ランタン上下支持、ツタ／ヒカリゴケのフル不透明キューブ支持を配置ヘルパーで保証し、**`lint_structure` 警告 0 件**を必須完了条件とする。

> 配色・中空シェルアルゴリズム・失敗アンチパターン早見表 → [references/aesthetic-and-patterns.md](./references/aesthetic-and-patterns.md)

---

## 3. 標準ビルドワークフロー（6ステップ）

1. **事前リサーチ＆設計書（`DESIGN.md`）**：
   - **設計前に必ず [references/aesthetic-and-patterns.md](./references/aesthetic-and-patterns.md) を読み**、配色・立体構図・アンチパターンを確認する。新規テーマのみ `search_web` で Minecraft 固有イディオム（屋根勾配・壁奥行き・定番ブロック組合せ）を簡潔調査。
   - 安全座標・中心軸・傾斜基底・パレット（モジュール別 ≤3トーン）・フェーズ別ブロック数予算（合計 `<240k`）・固定カメラアングルを確定する。
2. **キャンバス／地形準備**：
   - 空中／建築主体なら [generate_void_canvas.mjs](./scripts/generate_void_canvas.mjs) でサイズ指定 `.nbt` を生成（自然地形なら26近傍中空シェル＋縁限定土壌で生成）。
3. **モジュール分割＆中空シェル実装**：
   - **DSL 実装時やエラー調査時のみ、必要に応じ [references/mcp-and-dsl-reference.md](./references/mcp-and-dsl-reference.md) を参照**し、ツール引数・DSL仕様・JAR/Linter 詳細を確認する。
   - [geometry_helpers.js](./scripts/geometry_helpers.js) を共通基盤とし、フェーズ別 `.js` に分割。体積物は `buildHollowVolumeShell`（6近傍BFS＋26近傍表面抽出）、斜材は `drawStrut`（マンハッタン6連結）、安全配置は `pSet`/`fSet`＋`placeChainSafe`/`placeLanternSafe`/`placeHangingVineSafe` を使う。
4. **ローカル事前検証（`dry_run`、2–6秒）**：
   - MCP を叩く前に必ず [dry_run_validator.mjs](./scripts/dry_run_validator.mjs) を実行し、**`OOB: 0`・SafeBox OK・総ブロック予算内・Topブロック偏りなし・浮遊クラスタ0（空中建築は `--emit-anchors` でアンカー化）・`Lint Issues: 0`** を通す。
5. **段階ビルド・チェックポイント・Linter 確定**：
   - `load_terrain` → フェーズごとに `run_build_script(resetBeforeRun: false)` → 各フェーズ末に `export_structure` で `checkpoints/phaseN.nbt` を保存＆ `render_camera` でプロポーション確認。全フェーズ後に `lint_structure` 警告 **0件**を確認。
   - 複数ステージや大量カメラ一括出力には [batch_render.mjs](./scripts/batch_render.mjs)（`--require-jar` 推奨）を活用する。
6. **マルチアングル視覚検証＆ `inspect_pixel` 修正ループ**：
   - 最低4視点の透視投影（`resolution: 768`）を撮影：**①主斜め俯瞰（エッジオン回避）、②反対側 `yaw+180°` リバース俯瞰、③前景越し／低仰角視点、④建築ディテール超近接**（内装ありなら `inspect_interior` に明示 `cutY` を指定）。
   - 違和感箇所は `inspect_pixel(view="custom", u, v)` で3D座標とステートを特定し修正。**パッチ修正は必ず元フェーズファイルへバックポート**して再 `dry_run` 後に最終 `.nbt`（必要時 `.mcstructure`）を出力する。

---

## 4. 同梱リソース＆スクリプト一覧

- **リファレンス**：
  - [references/mcp-and-dsl-reference.md](./references/mcp-and-dsl-reference.md) — MCP全8ツール、DSL全17関数、エンジン上限、JAR/Linter仕様
  - [references/aesthetic-and-patterns.md](./references/aesthetic-and-patterns.md) — 配色・構図・26近傍中空シェル・バニラ継手・アンチパターン表
- **汎用実行スクリプト（即実行可能・作品非依存）**：
  - [scripts/generate_void_canvas.mjs](./scripts/generate_void_canvas.mjs) — 任意サイズ＋シード付き虚空キャンバス `.nbt` 生成
  - [scripts/dry_run_validator.mjs](./scripts/dry_run_validator.mjs) — 高速ローカル検証・バンドル出力・浮遊クラスタ集計・自動アンカー `.nbt` 生成
  - [scripts/geometry_helpers.js](./scripts/geometry_helpers.js) — VM直結ヘルパー（安全境界・`pSet`/`fSet`・傾斜基底・`fbm3D`・バニラ安全配置・26近傍BFSシェル・6連結ストラット・非反転グリフ描画）
  - [scripts/batch_render.mjs](./scripts/batch_render.mjs) — `MineBuildingMcpServer` 直接起動による固定カメラ一括描画・Lint・エクスポート

---

## 5. 自己更新プロトコル（Hermes式 継続学習ルール）

新しい建築セッション完了後、または新規ログから重大な失敗・仕様変更・新イディオムが得られた場合、以下の手順でスキルを進化させる：

1. **抽出（Extract）**：対象ログから次の3種のみを抽出する — ①新規エンジン制約／JARブロック仕様変更、②視覚検証・ユーザー指摘で発覚した新アンチパターンと修正策、③複数作品で再利用可能な汎用ジオメトリ／検証アルゴリズム。
2. **抽象化ゲート（Anti-Overfitting Check）**：特定作品名・固定座標・テーマ専用部品を**すべて削ぎ落とし**、一般法則へ昇華できる知見のみを採用する（具体例は1行の抽象記述のみ許容）。
3. **重複排除マージ（Deduplicated Merge）**：
   - エンジン・ツール・JAR仕様の変更 → [references/mcp-and-dsl-reference.md](./references/mcp-and-dsl-reference.md) の該当節を更新（旧仕様と矛盾する記述は置換）。
   - 美学ルール・新アンチパターン → [references/aesthetic-and-patterns.md](./references/aesthetic-and-patterns.md) の該当節＋早見表に1行追記。
   - 再利用ロジック → [scripts/](./scripts/) へ汎用関数／CLIオプションとして統合し、必ず構文・実行テストを通す。
   - **ハード制約や標準手順が変わった場合のみ** `SKILL.md` を最小編集し、**`SKILL.md` は常に 200 行以内**を死守する（肥大化したら詳細を `references/` へ退避）。
4. **回帰確認（Verify）**：更新後、`SKILL.md` 行数（`<=200`）・相対リンク整合・`scripts/` のテスト実行を必ず確認して完了とする。

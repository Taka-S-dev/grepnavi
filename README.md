# grepnavi

[![CI](https://github.com/Taka-S-dev/grepnavi/actions/workflows/test.yml/badge.svg)](https://github.com/Taka-S-dev/grepnavi/actions/workflows/test.yml)
[![Release](https://img.shields.io/github/v/release/Taka-S-dev/grepnavi)](https://github.com/Taka-S-dev/grepnavi/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

*A lightweight code-reading tool for large C codebases — ripgrep search, a Monaco-based source viewer, call trees and reference maps on top of GNU Global. No language server required.*

C の大規模コードベース（Linux カーネル、OpenSSL、curl など）を読むためのコードリーディング（調査）ツール。ripgrep の高速検索 + VSCode と同じエディタ（Monaco）+ 調査グラフで、**「どこを調べたか」を記録しながら**構造を把握していきます。

clangd のような言語サーバを使える環境なら、精度はそちらのほうが上です。grepnavi が想定するのは**それが使えない・重すぎる環境**です — ビルドシステムが複雑で `compile_commands.json` を生成できない、PC のスペックが足りない、常駐のセキュリティソフトの下でインデックス作成がいつまでも終わらずエディタごと重くなる。そうした場面でも、検索・定義ジャンプ・呼び出し元の追跡が待たされずに動くことを優先しています。

> **ローカル専用ツールです**
> 自分の PC で起動して、同じ PC のブラウザからアクセスして使います。
> サーバーへのデプロイや、他の人が外部からアクセスできる環境での使用は想定していません。

---

## 特徴

### 検索

- **ripgrep 検索** — 正規表現・単語単位・glob。結果は逐次表示され、検索タブを 10 件まで並行保持
- **絞り込み** — 検索後に AND / OR / 除外 / `file:` `path:` でさらに絞る
- **関数セパレータ** — C の検索結果を所属関数ごとに区切る（「30 ヒットだが実は 2 関数」が一目で分かる）
- **シンボル検索** — 関数・構造体・マクロを名前のうろ覚えで（`recipe save` → `recipe_save`）
- **文字コード自動判定** — UTF-8 / Shift-JIS / EUC-JP / UTF-16 を自動検出、ワンクリックで切り替え再検索

### エディタ

- **ソースコードビューア（Monaco）** — VSCode と同じエディタで該当行へジャンプ。複数タブ
- **定義ジャンプ・参照・ホバー** — GNU Global の索引を優先し ripgrep へフォールバック。ホバーはマクロ展開と定数式の計算値つき
- **追跡ハイライト** — 単語を最大 8 色で、別ファイルを開いても追い続ける
- **#ifdef 可視化** — 条件コンパイルで死ぬブロックをグレーアウト。条件はリストで管理
- **行メモ・範囲メモ** — コードに書き込まずメモを残し、一覧からジャンプ
- **デバッグ行の管理** — printf 等を挿入して場所を記録、一覧から一括撤去。消し忘れは残数バッジで防ぐ
- **C セマンティックハイライト** — static 変数・関数呼び出し・マクロの追加色付け

### 調査グラフ

- **ノードに積む** — 検索結果やエディタの選択をツリーへ積み、ラベル・メモ・カラーバッジで整理
- **呼び出し ↔ 実態の同期** — 呼び出し箇所に付けたメモが関数の実装行にも表示される
- **整理と保存** — D&D / キーボードで階層編集、複数ツリー、D3 グラフ表示、JSON 保存

### アドオン

- **コールツリー** — callers / callees をツリー表示。関数ポインタのテーブル登録も「誰が呼ぶか」の答えとして拾う
- **参照マップ** — どのまとまりがどの実装を使っているか、開いたことのないツリーでも全域を俯瞰（Linux カーネル実測: 初回 87 秒・以後 0.2 秒）
- **状態遷移図** — 状態変数への代入を集めて遷移図に。実線の辺だけがコードに根拠のある遷移
- **ジャンプマップ** — 定義ジャンプの足跡をグラフで可視化、draw.io へエクスポート
- **インクルード依存グラフ** — `#include` の依存を上流・下流に展開

### プロジェクト

- **ルートと調査 JSON の管理** — ルートごとに複数の調査ファイルを登録してワンクリック切り替え
- **対象から外す宣言** — `.gitignore` と同じ書き方で生成物などを検索・参照・ジャンプの全機能から除外
- **外部エディタ連携** — `{file}` / `{line}` プレースホルダで任意のエディタに接続
- **AI エージェント連携** — MCP ブリッジで Claude Code / Copilot CLI 等から調査グラフを構築（[mcp/README.md](mcp/README.md)）

各機能の挙動の細部・操作方法・制限・実測値は [docs/features.md](docs/features.md) を参照。

---

## 必要なもの

| 依存 | 必須 | 説明 |
|------|------|------|
| [Go](https://golang.org/) 1.25 以上 | — | ソースからビルドする場合のみ。バイナリ配布版は不要 |
| [ripgrep](https://github.com/BurntSushi/ripgrep) | ✅ | `rg` コマンドが PATH にあること |
| [GNU Global](https://www.gnu.org/software/global/) | — | **なくても動作します。** `gtags` / `global` コマンドが PATH にあると定義ジャンプ・ホバー・Callers の精度が向上 |
| [Universal Ctags](https://github.com/universal-ctags/ctags) | — | **なくても動作します。** `tags` ファイルを生成しておくと定義ジャンプの精度が向上し、定数・マクロのハイライトが有効になる。索引の対象は C / C++ のみ |

---

## インストール・起動

### バイナリをダウンロード（推奨）

[GitHub Releases](https://github.com/Taka-S-dev/grepnavi/releases) からアーカイブをダウンロードして展開してください。Go のインストール不要です。

```
grepnavi/
├── grepnavi.exe    ← 実行ファイル（コンソール版。ターミナルから起動・ログ確認用）
├── grepnaviw.exe   ← ウィンドウ版。ダブルクリックでコンソールなしにトレイ常駐
└── static/         ← 静的ファイル（exe と同じディレクトリに必須）
```

> **注意：** `static/` フォルダを相対パスで参照するため、exe 単体では動作しません。アーカイブを展開したディレクトリごと配置してください。

### ソースからビルド

```bash
# ビルド
go build .
# → Windows: grepnavi.exe  Mac/Linux: grepnavi が生成されます

# ウィンドウ版（コンソールなし・ダブルクリックでトレイ常駐）
go build -ldflags "-H=windowsgui -X main.defaultTray=1" -o grepnaviw.exe .
```

アイコン（トレイ・exe・ウィンドウ・favicon で共用）は `rsrc_windows_amd64.syso` をリポジトリに含めているため、上記のビルドだけで exe に埋め込まれます。再生成の手順は [docs/setup.md](docs/setup.md) を参照。

### 起動

```bash
# 起動（カレントディレクトリを検索ルートとして使用）
.\grepnavi.exe          # Windows
./grepnavi              # Mac/Linux

# 起動時にルートを指定
.\grepnavi.exe -root C:\path\to\your\project
```

ブラウザが自動で開きます → http://localhost:8080

起動後もブラウザ上のルートチップ（左上）からディレクトリを変更できます。

#### デスクトップ（トレイ常駐）モード ※Windows のみ

```bash
.\grepnavi.exe -tray
```

システムトレイに常駐し、専用ウィンドウ（埋め込み WebView2）で開く。ブラウザ拡張機能の影響を受けない。ウィンドウは VSCode 風の一列バー（ファイル / 表示 メニュー + 窓ボタン）で、OS のタイトルバーを持たない。

起動フラグの一覧・デスクトップモードの操作詳細・別マシンからの SSH ポートフォワード利用は [docs/setup.md](docs/setup.md) を参照。
---

## 索引エンジン（オプション）

[GNU Global](https://www.gnu.org/software/global/) / [Universal Ctags](https://github.com/universal-ctags/ctags) を入れると、定義ジャンプ・ホバー・Callers・シンボル検索の精度が上がります（**どちらも無くても ripgrep で動作します**）。

エディタのファイルヘッダ右端の「索引」ラベルから生成・更新でき、状態（索引が古い / 索引なし）も同じ場所に表示されます。インストール手順（Scoop / `bin/` への直接配置）は [docs/setup.md](docs/setup.md) を参照。
---

## AI エージェント連携（オプション）

[MCP (Model Context Protocol)](https://modelcontextprotocol.io) ブリッジ `grepnavi-mcp` を経由して、AI エージェント（Claude Code / Copilot CLI 等）から grepnavi の調査グラフに直接ノードを追加できる。

AI に「`free_session()` の callers を 2 階層辿ってグラフに展開して」のように指示すると、AI が definition → graph_add_node → callers の連携で自動的にツリーを構築。grepnavi の GUI がリアルタイムで更新され、ブラウザのノードをクリック → エディタ該当行へジャンプして検証できる。

ブリッジはソースコード read-only（memo / グラフのみ編集可）。grepnavi 側は外部プロセスからの API アクセスを許可するため `-mcp` フラグ付きで起動する。

調査の進め方（どのツールをどの順で使うか、結果をどこまで信じてよいか）は [`mcp/skills/grepnavi/`](mcp/skills/grepnavi/) に Skill として分離してある。`cp -r mcp/skills/grepnavi ~/.claude/skills/` で有効化。入れなくても MCP 単体で動作する。

```bash
cd mcp
npm install
npm run build
./grepnavi -mcp
```

> ⚠️ **データ送信注意**: 仕組み上、AI エージェントは grepnavi から取得したファイル内容・検索結果・現在開いているファイルやカーソル位置を自身の AI サービス (Anthropic / GitHub 等) に送信する。機密コードを扱う場合は AI クライアントのデータ取り扱いポリシーを事前に確認すること。

セットアップ詳細・利用可能ツール一覧・トラブルシュートは [`mcp/README.md`](mcp/README.md) 参照。

---

## 使い方

### 基本的な流れ

1. 検索バーにパターンを入力して **検索** ボタン（または Enter）
2. 結果行をクリック → 右ペインのエディタでコードを確認
3. 気になった行の **+** ボタン（または Alt+Shift+G）でグラフにノード追加
4. F2 / 右クリックメニューでラベル・メモを編集してノードの意味を記録
5. ドラッグ&ドロップ or Shift+Alt+Arrow キーで親子関係・順序を整理
6. **Ctrl+S** でプロジェクトファイルに保存

キーボードショートカットの全表・`Ctrl+P` / `Alt+Shift+T` の検索記法・絞り込みの構文・ノードの移動操作は [docs/usage.md](docs/usage.md) を参照（アプリ内では `?` キーで同じ一覧が開きます）。


## アーキテクチャ

```
grepnavi/
├── main.go                    # エントリーポイント・フラグ解析
├── server.go                  # HTTP サーバー初期化
├── api/
│   ├── handlers.go            # 構造体・Register・共通ヘルパー
│   ├── handlers_search.go     # 検索
│   ├── handlers_graph.go      # グラフ操作
│   ├── handlers_tree.go       # ツリー管理
│   ├── handlers_analysis.go   # コード解析（定義・ホバー・コールツリー等）
│   ├── handlers_gtags.go      # GNU Global
│   ├── handlers_fileops.go    # ファイル操作・ルート管理・.grepnavi 読み書き
│   ├── handlers_projects.go   # プロジェクトマネージャー CRUD・.grepnavi open
│   └── handlers_include.go    # インクルード依存グラフ
├── graph/
│   ├── model.go               # データ構造（Node, Edge, Tree, ProjectFile）
│   ├── store.go               # プロジェクトファイルの読み書き・ノード/エッジ操作
│   └── expand.go              # 検索結果 → ノード変換
├── search/
│   ├── ripgrep.go             # ripgrep 呼び出し・JSON パース・SSE ストリーミング
│   ├── definition.go          # 定義ジャンプ（ctags 風シンボル解析）
│   ├── symbolsearch.go        # シンボル名のパターン検索（tags ファイルベース）
│   ├── symbols.go             # シンボル抽出
│   ├── hover.go               # ホバープレビュー用スニペット取得
│   ├── defineeval.go          # #define 定数式の評価（ホバーの計算値・電卓のマクロ解決）
│   ├── calltree.go            # callers / callees 解析
│   ├── gtags.go               # GNU Global 統合（インデックス管理・定義/参照検索）
│   ├── include.go             # C インクルード依存グラフ解析
│   ├── ifdef.go               # #ifdef 条件コンパイル解析
│   └── ifdef_eval.go          # #ifdef 条件評価
└── static/
    ├── index.html
    ├── js/
    │   ├── vendor/            # サードパーティライブラリ（Monaco Editor・D3.js・Cytoscape 等）
    │   ├── state.js           # グローバル状態変数
    │   ├── utils.js           # 定数・ユーティリティ関数
    │   ├── search.js          # 検索・フィルタ・結果表示
    │   ├── graph.js           # グラフ/ツリー操作・D3.js・D&D
    │   ├── editor.js          # Monaco エディタ・fzf・ナビ履歴・行メモ・#ifdef
    │   ├── memo-list.js       # メモリストパネル（行・範囲メモ一覧・グループ管理）
    │   ├── editor-c.js        # C/C++ 固有拡張（static変数・関数呼び出し・定数のハイライト、ローカル変数ホバー抑制）
    │   ├── numlit.js          # 数値リテラルの基数変換（ホバー・電卓の式評価器）
    │   ├── radix-calc.js      # 基数変換電卓パネル（右クリックメニューから）
    │   ├── gtags.js           # GNU Global UI（エンジン選択・インデックス管理）
    │   ├── include-graph.js   # C インクルード依存グラフ（D3.js）
    │   ├── filebrowser.js     # ファイルブラウザ（パンくず・履歴・キーボードナビ）
    │   ├── project.js         # プロジェクト保存/開く・ルート設定・glob履歴・リサイザー
    │   ├── projects.js        # プロジェクトマネージャーパネル・JSON 切り替えメニュー
    │   └── app.js             # ブートストラップ・グローバルイベント登録
    ├── addons/
    │   ├── addons.js          # アドオン設定（有効化リスト）
    │   ├── c-include/         # C インクルード依存グラフ アドオン
    │   ├── call-tree/         # コールツリー アドオン
    │   ├── jump-map/          # 定義ジャンプ履歴グラフ アドオン
    │   ├── ref-map/           # 参照マップ アドオン
    │   └── state-machine/     # 状態遷移図 アドオン
    └── css/
        └── main.css
```

API エンドポイントの一覧は [docs/api.md](docs/api.md) を参照。
---

## ライセンス

MIT

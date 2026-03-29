# grepnavi

[![CI](https://github.com/Taka-S-dev/grepnavi/actions/workflows/test.yml/badge.svg)](https://github.com/Taka-S-dev/grepnavi/actions/workflows/test.yml)

コードベース調査ツール。ripgrep の高速検索 + Monaco エディタ + 調査グラフで、**「どこを調べたか」を記録しながらコードを読み解く**ためのツールです。

大きなコードベース（Linux カーネル、OpenSSL、curl など）を読む際に、検索結果をグラフに積み上げながら構造を把握していくことを想定しています。

> **ローカル専用ツールです**
> 自分の PC で起動して、同じ PC のブラウザからアクセスして使います。
> サーバーへのデプロイや、他の人が外部からアクセスできる環境での使用は想定していません。

---

## 特徴

### 検索

- **ripgrep による高速検索** — 正規表現・大文字小文字区別・単語単位・glob フィルタに対応
- **リアルタイムストリーミング** — 検索結果を SSE で逐次表示
- **複数検索タブ** — 最大 10 件の検索を並行保持。タブを切り替えて結果を比較できる
- **検索結果の絞り込み** — AND（スペース区切り）/ OR（`|`）/ 除外（`-word`）。ファイル名のみ対象に切り替えも可能
- **種別バッジ** — 検索ヒット行が関数定義・構造体・`#define`・enum・typedef のどれかを自動判定してバッジ表示
- **検索ディレクトリ指定** — サブディレクトリのみを対象に絞れる。glob パターンの入力履歴付き
- **検索履歴** — Alt+H で過去の検索クエリ一覧を表示
- **文字コード自動判定** — UTF-8 / UTF-16 / Shift-JIS / EUC-JP を自動検出して表示

### エディタ

- **Monaco エディタ** — VSCode と同じエディタで該当行にジャンプ
- **複数タブ** — 開いたファイルはタブで切り替え可能
- **定義ジャンプ** — Ctrl+クリック / F12 でシンボル定義へジャンプ。GNU Global が利用可能な場合は構文解析済みインデックスを優先し、ripgrep にフォールバック。複数候補はピックリストで選択
- **ホバープレビュー** — シンボルにマウスを乗せると定義スニペットとその直前コメント（`//` / `/* */` 両形式）をポップアップ表示。GNU Global 対応
- **F3 / Shift+F3** — 検索ヒット行を順番にジャンプ
- **行メモ** — 任意の行にメモを付けてエディタ上にインライン表示（Alt+M で表示切り替え）
- **単語ハイライト固定** — Alt+H または右クリックでカーソル位置の単語を色付きハイライト固定。複数単語を最大 8 色で同時管理。タブ切り替え後も維持される
  - カーソルワード → 単語単位マッチ / テキスト選択 → 部分マッチ（チップに「単語一致」「部分一致」を表示）
  - タブバー直下のチップ一覧で「‹ 前へ / 次へ ›」ジャンプ、単語クリックでピン箇所に戻る、× で解除
- **#ifdef 可視化** — C/C++ の条件コンパイルブロックをハイライト。条件（例: `WIN32=1 DEBUG=0`）を指定して適用
- **ナビゲーション履歴** — Alt+← / Alt+→ で閲覧履歴を前後に移動
- **Ctrl+P ファイルクイックオープン** — fzf スタイルのファジー検索（スペース区切りで AND 絞り込み）

### 調査グラフ（ツリー）

- **ノード追加** — 検索結果の `+` ボタン、またはエディタのテキスト選択 → Alt+G でノードを追加
- **ラベル・メモ** — ノードごとにラベル（表示名）とメモを編集。フォーカスアウト / Enter で自動保存
- **ツリー表示とグラフ表示の切り替え** — ボタンで D3.js のフォースグラフに切り替え可能
- **複数ツリー** — 1 プロジェクトに複数の調査ツリーを作成・タブで切り替え
- **ツリーメモのインライン表示** — Alt+N（またはボタン）でノードのメモをツリー上にコメント風に常時表示
- **ノード展開** — 選択ノードのシンボルを検索してグラフを自動展開
- **ホバープレビュー** — ノードにマウスを乗せると関連コードのポップアップを表示
- **カラーバッジ** — ノードに色付きラベルを付けて分類・マーキング（詳細パネルから編集）

### ノード操作

- **ドラッグ&ドロップ** — ノードを別ノードにドロップして親子関係を変更。drop-before / drop-after のライン表示で挿入位置を確認
- **⠿ ハンドル** — ノード行の左端ハンドルを左右にドラッグしてインデントレベル（階層）を変更
- **キーボードでの移動** — Shift+Alt+Arrow キーで選択ノードを移動（↑↓ で兄弟間、← でレベルアップ、→ でレベルダウン）
- **↑ / ↓ で選択変更** — ツリービュー上でフォーカス外（テキスト入力・エディタ以外）のとき、Up/Down 矢印キーで選択ノードを切り替え

### アドオン

アドオンは `static/addons/<name>/addon.js` + `addon.css` で実装されており、`static/addons/addons.js` の `ADDONS` 配列に名前を列挙するだけで有効化できます。

#### コールツリー

関数の呼び出し元（callers）/ 呼び出し先（callees）をツリー形式で表示します。

- エディタ上の関数名を選択して右クリック or ツールバーの「Call Tree」ボタンで起動
- 入力欄に関数名を入力して実行（Enter または Go）
- `callers` / `callees` タブで方向を切り替え（タブを戻っても展開状態を保持）
- ノードをクリックして実装箇所へジャンプ（プロトタイプ宣言ではなく定義本体を優先）。`▶` で再帰的に展開
- Esc で検索欄をクリア（もう一度 Esc でパネルを閉じる）
- `?mode=panel` 時はサイドパネルのタブとして自己登録
- GNU Global が利用可能な場合、Callers は `global -xr` による構文解析ベースの参照検索を使用（ripgrep より誤検知が少ない）。使用中エンジンをパネル内に表示

#### ジャンプマップ

定義ジャンプの履歴をグラフとして可視化します。どのシンボルからどのシンボルへジャンプしたかを追跡し、コード読解の経路をノード・エッジで表示します。

- エディタのツールバー「Jump Map」ボタンまたは右クリックメニューから起動
- ファイル単位にシンボルをグループ化するフォルダビューに切り替え可能
- シンボルの種別（関数・構造体・enum・define 等）をノードの色で区別
- ミニマップでグラフ全体を俯瞰しながらナビゲーション
- draw.io 形式でエクスポート可能

#### C インクルード依存グラフ

`#include` の依存関係を D3.js フォースグラフで可視化します。

- エディタで C/C++ ファイルを開くと起点ファイルが自動セット
- ツールバーの「Include Graph」ボタンでパネルを開き「Analyze」で解析開始
- ノードをクリックして上流・下流を展開。Ctrl+クリック or ダブルクリックでエディタに表示
- 「Collapse All」でグラフを折りたたみ

### プロジェクト

- **プロジェクト保存** — グラフ・メモ・ルートディレクトリを JSON ファイルに保存（Ctrl+S）
- **名前を付けて保存 / 開く** — 複数のプロジェクトファイルを切り替えて使用可能

---

## 必要なもの

| 依存 | 必須 | 説明 |
|------|------|------|
| [Go](https://golang.org/) 1.25 以上 | — | ソースからビルドする場合のみ。バイナリ配布版は不要 |
| [ripgrep](https://github.com/BurntSushi/ripgrep) | ✅ | `rg` コマンドが PATH にあること |
| インターネット接続 | ✅ | 初回起動時に Monaco Editor を CDN から読み込み（オフライン配置も可） |
| D3.js | — | グラフビュー使用時のみ。後述のローカル配置推奨 |
| [GNU Global](https://www.gnu.org/software/global/) | — | **なくても動作します。** `gtags` / `global` コマンドが PATH にあると定義ジャンプ・ホバー・Callers の精度が向上 |

---

## インストール・起動

### バイナリをダウンロード（推奨）

[GitHub Releases](https://github.com/Taka-S-dev/grepnavi/releases) からアーカイブをダウンロードして展開してください。Go のインストール不要です。

```
grepnavi/
├── grepnavi.exe   ← 実行ファイル
└── static/        ← 静的ファイル（exe と同じディレクトリに必須）
```

> **注意：** `static/` フォルダを相対パスで参照するため、exe 単体では動作しません。アーカイブを展開したディレクトリごと配置してください。

### ソースからビルド

```bash
# ビルド
go build .
# → Windows: grepnavi.exe  Mac/Linux: grepnavi が生成されます
```

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

### オプション

| フラグ | デフォルト | 説明 |
|--------|-----------|------|
| `-root` | `.` (カレントディレクトリ) | 検索対象のルートディレクトリ |
| `-graph` | `graph.json` | プロジェクトファイルのパス |
| `-port` | `8080` | HTTP サーバーのポート番号 |
| `-host` | `127.0.0.1` | バインドアドレス。`0.0.0.0` を指定すると LAN 全体に公開される（認証なし・非推奨） |
| `-no-browser` | `false` | 起動時のブラウザ自動オープンを抑制する |

---

## GNU Global（オプション）

[GNU Global](https://www.gnu.org/software/global/) をインストールすると、定義ジャンプ・ホバー・Callers の精度が向上します。

### インストール（Windows）

**方法 1: Scoop（推奨）**

```bash
scoop install global
```

**方法 2: exe を直接配置（PATH 不要・環境依存なし）**

インストール不要で使いたい場合や、Scoop 環境で問題が発生する場合はこの方法が確実です。

1. [GNU Global 公式サイト](https://www.gnu.org/software/global/download.html) から Windows 用バイナリをダウンロード
2. アーカイブを展開し、`global.exe` と `gtags.exe` を grepnavi の `bin/` フォルダに配置

```
grepnavi/
├── grepnavi.exe
├── static/
└── bin/
    ├── global.exe   ← 定義ジャンプ・参照検索に使用
    └── gtags.exe    ← インデックス生成に使用
```

3. grepnavi を（再）起動すれば自動的に `bin/` のバイナリが使われます。PATH への追加は不要です。

> **注意：** gtags.exe・global.exe の両方が必要です。片方だけでは一部機能が動作しません。

### 使い方

1. grepnavi を起動し、プロジェクトルートを開く
2. エディタのファイルヘッダ右端に表示される **定義ジャンプエンジン** ラベルをクリック
3. ポップオーバーで「インデックス → 生成」を実行
4. 以降、定義ジャンプ（Ctrl+クリック / F12）・ホバー・コールツリーの Callers が GNU Global を使用する

インデックスは `GTAGS` / `GRTAGS` / `GPATH` の 3 ファイルとしてプロジェクトルートに保存されます。ファイルを変更した後は「更新」で差分更新、大規模なリファクタリング後は「再生成」を使ってください。

---

## オフライン・社内環境で使う

### Monaco Editor

プロジェクトルートで以下を実行：

```bash
npm install monaco-editor@0.52.2
cp -r node_modules/monaco-editor/min/vs static/vs/
```

`static/index.html` を変更：
```js
// CDN（デフォルト）
var require = {paths: {'vs': 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs'}};

// ローカルに変更
var require = {paths: {'vs': '/vs'}};
```

### D3.js

[d3.min.js](https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js) をダウンロードして `static/d3.min.js` に配置（グラフビューを使う場合は必須）。

---

## 使い方

### 基本的な流れ

1. 検索バーにパターンを入力して **検索** ボタン（または Enter）
2. 結果行をクリック → 右ペインのエディタでコードを確認
3. 気になった行の **+** ボタン（または Alt+G）でグラフにノード追加
4. 詳細パネルでラベル・メモを編集してノードの意味を記録（フォーカスアウトで自動保存）
5. ドラッグ&ドロップ or Shift+Alt+Arrow キーで親子関係・順序を整理
6. **Ctrl+S** でプロジェクトファイルに保存

### キーボードショートカット

#### 検索

| キー | 動作 |
|------|------|
| `Enter` | 検索実行 |
| `Alt+C` | 大文字小文字を区別 |
| `Alt+W` | 単語単位で検索 |
| `Alt+R` | 正規表現モード |
| `Alt+H` | 検索履歴を表示 |
| `Ctrl+Enter` | 現在の検索結果をスタックに保存（検索欄にフォーカス時） |
| `Alt+Shift+S` | 検索スタック一覧を表示 |

#### エディタ

| キー | 動作 |
|------|------|
| `Ctrl+P` | ファイルクイックオープン（fzf スタイル） |
| `F3` / `Shift+F3` | 検索結果を次 / 前へジャンプ |
| `F12` / `Ctrl+クリック` | 定義ジャンプ |
| `Alt+クリック` | カーソル位置の単語を grep 検索 |
| `Alt+←` / `Alt+→` | 閲覧履歴を前後に移動 |
| `Alt+H` | カーソル位置の単語ハイライトを固定 / 解除 |
| `Alt+N` | 行メモを追加 / 編集 |
| `Alt+M` | 行メモのインライン表示切り替え |
| `Alt+P` | ファイルパス表示切り替え |
| `Alt+G` | 選択テキストをグラフノードに追加 |

#### ツリー

| キー | 動作 |
|------|------|
| `Alt+G` | エディタの選択テキストをノードに追加 |
| `Alt+N` | ツリーメモのインライン表示切り替え |
| `↑` / `↓` | 選択ノードを変更 |
| `Shift+Alt+↑` / `↓` | 選択ノードを上 / 下に移動 |
| `Shift+Alt+←` / `→` | 選択ノードのレベルを上げる / 下げる |

#### 全体

| キー | 動作 |
|------|------|
| `Ctrl+S` | プロジェクトを保存 |
| `Ctrl+Z` | 元に戻す |
| `Ctrl+Shift+N` | 新しいウィンドウを開く |
| `?` | キーボードショートカット一覧を表示 |

### Ctrl+P ファイル検索

スペース区切りで AND 絞り込みができます。

```
ssl bio        → "ssl" かつ "bio" を含むパスを表示
test connect   → test ディレクトリの connect 関連ファイルを表示
```

### 検索結果の絞り込み

検索後に **絞り込みバー** でさらに絞れます。

```
foo bar        → AND 検索（foo かつ bar を含む行）
foo|bar        → OR 検索
-test          → test を含む行を除外
```

### ノード移動

**ドラッグ&ドロップ**
- ノード行をドラッグして他のノードにドロップ → 子ノードにする
- 別のノードの上端/下端にドロップ → 前後の兄弟として挿入（ターコイズのラインで位置を確認）
- 左上の「ここにドロップ」ゾーンにドロップ → ルートに移動

**⠿ ハンドル**
- ノード行の左端の `⠿` を左右にドラッグ → インデントレベル（階層）を変更
- ドラッグ中はレベル変化がバッジで表示される

**キーボード**
- Shift+Alt+Arrow キーで選択ノードを移動（↑↓ で兄弟間、← でレベルアップ、→ でレベルダウン）

---

## VSCode Simple Browser 連携（パネルモード）

VSCode の Simple Browser でサイドパネルとして使う場合、URL パラメータでレイアウトを切り替えられます。

| URL | 説明 |
|-----|------|
| `http://localhost:8080/?mode=panel` | 検索とコールツリーをタブで切り替えるパネル表示。ファイルクリックで VSCode が開く |
| `http://localhost:8080/?mode=search` | 検索パネルのみ表示 |
| `http://localhost:8080/?mode=calltree` | コールツリーのみ表示 |

**`?mode=panel` の特徴：**
- 右ペイン（エディタ・グラフ）を非表示にしてサイドパネルとして使える
- 検索結果・ノードのクリックで `code --goto` を使って VSCode でファイルを開く
- アドオンが `registerPanel()` を呼ぶことでタブに自己登録できる

**VSCode での開き方：**
1. コマンドパレット → `Simple Browser: Show`
2. URL に `http://localhost:8080/?mode=panel` を入力

---

## プロジェクトファイル

調査内容は JSON ファイルに保存されます。

```json
{
  "version": 2,
  "root_dir": "/path/to/project",
  "active_tree_id": "...",
  "trees": [
    {
      "id": "...",
      "name": "ツリー1",
      "nodes": { ... },
      "edges": [ ... ]
    }
  ],
  "line_memos": {
    "ファイルパス:行番号": "メモ内容"
  }
}
```

---

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
│   ├── handlers_fileops.go    # ファイル操作・ルート管理
│   └── handlers_include.go    # インクルード依存グラフ
├── graph/
│   ├── model.go               # データ構造（Node, Edge, Tree, ProjectFile）
│   ├── store.go               # プロジェクトファイルの読み書き・ノード/エッジ操作
│   └── expand.go              # 検索結果 → ノード変換
├── search/
│   ├── ripgrep.go             # ripgrep 呼び出し・JSON パース・SSE ストリーミング
│   ├── definition.go          # 定義ジャンプ（ctags 風シンボル解析）
│   ├── symbols.go             # シンボル抽出
│   ├── hover.go               # ホバープレビュー用スニペット取得
│   ├── calltree.go            # callers / callees 解析
│   ├── gtags.go               # GNU Global 統合（インデックス管理・定義/参照検索）
│   ├── include.go             # C インクルード依存グラフ解析
│   ├── ifdef.go               # #ifdef 条件コンパイル解析
│   └── ifdef_eval.go          # #ifdef 条件評価
└── static/
    ├── index.html
    ├── js/
    │   ├── state.js           # グローバル状態変数
    │   ├── utils.js           # 定数・ユーティリティ関数
    │   ├── panel.js           # パネルモード登録（registerPanel）・タブ切り替え
    │   ├── search.js          # 検索・フィルタ・結果表示
    │   ├── graph.js           # グラフ/ツリー操作・D3.js・詳細パネル・D&D
    │   ├── editor.js          # Monaco エディタ・fzf・ナビ履歴・行メモ・#ifdef
    │   ├── gtags.js           # GNU Global UI（エンジン選択・インデックス管理）
    │   ├── include-graph.js   # C インクルード依存グラフ（D3.js）
    │   ├── filebrowser.js     # ファイルブラウザ（パンくず・履歴・キーボードナビ）
    │   ├── project.js         # プロジェクト保存/開く・ルート設定・glob履歴・リサイザー
    │   └── app.js             # ブートストラップ・グローバルイベント登録
    ├── addons/
    │   ├── addons.js          # アドオン設定（有効化リスト）
    │   ├── c-include/         # C インクルード依存グラフ アドオン
    │   └── call-tree/         # コールツリー アドオン
    └── css/
        └── main.css
```

### API エンドポイント

| メソッド | パス | 説明 |
|---------|------|------|
| `GET` | `/api/graph` | アクティブツリーの取得 |
| `DELETE` | `/api/graph` | アクティブツリーをクリア |
| `POST` | `/api/graph/node` | ノード追加 |
| `PUT` | `/api/graph/node/:id` | ノードのラベル・メモ・子順序を更新 |
| `DELETE` | `/api/graph/node/:id` | ノード削除 |
| `POST` | `/api/graph/edge` | エッジ追加 |
| `POST` | `/api/graph/reparent` | ノードの親を変更 |
| `POST` | `/api/graph/rootorder` | ルートノードの並び順を保存 |
| `POST` | `/api/graph/saveas` | プロジェクトを名前を付けて保存 |
| `POST` | `/api/graph/openfile` | プロジェクトファイルを開く |
| `GET/POST` | `/api/root` | 検索ルートの取得/変更 |
| `GET` | `/api/dirs` | ルートディレクトリのサブディレクトリ一覧 |
| `GET` | `/api/files` | ファイル一覧（Ctrl+P 用） |
| `GET/POST` | `/api/trees` | ツリー一覧取得/新規作成 |
| `GET/PUT/DELETE` | `/api/trees/:id` | ツリーの切り替え/リネーム/削除 |
| `GET` | `/api/search/stream` | 検索（SSE ストリーミング） |
| `GET` | `/api/open` | ファイルの内容取得 |
| `GET` | `/api/snippet` | スニペット取得 |
| `GET` | `/api/definition` | 定義ジャンプ先の検索 |
| `GET` | `/api/hover` | ホバープレビュー用スニペット取得 |
| `GET` | `/api/callers` | 関数の呼び出し元を検索 |
| `GET` | `/api/callees` | 関数の呼び出し先を検索 |
| `GET` | `/api/include-graph` | ファイルのインクルード依存グラフ取得 |
| `GET` | `/api/include-file` | ファイルが `#include` しているファイル一覧 |
| `GET` | `/api/include-by` | ファイルを `#include` しているファイル一覧 |
| `GET` | `/api/gtags/status` | GNU Global のインストール状況・インデックス状態を取得 |
| `POST` | `/api/gtags/index` | GNU Global インデックスを新規生成 |
| `POST` | `/api/gtags/update` | GNU Global インデックスを差分更新 |
| `POST` | `/api/gtags/rebuild` | 既存インデックスを削除して完全再生成 |

---

## ライセンス

MIT

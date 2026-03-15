# grepnavi

コードベース調査ツール。ripgrep の高速検索 + Monaco エディタ + 調査グラフで、**「どこを調べたか」を記録しながらコードを読み解く**ためのツールです。

大きなコードベース（Linux カーネル、OpenSSL、PostgreSQL など）を読む際に、検索結果をグラフに積み上げながら構造を把握していくことを想定しています。

---

## 特徴

- **ripgrep による高速検索** — 正規表現・大文字小文字・単語単位・glob フィルタに対応
- **リアルタイムストリーミング** — 検索結果を SSE で逐次表示
- **Monaco エディタ** — VSCode と同じエディタで該当行にジャンプ、Ctrl+クリック / F12 で定義ジャンプ
- **調査グラフ** — 検索結果をノードとして追加し、ツリー構造で関係を整理
- **複数ツリー** — 1 プロジェクトに複数の調査ツリーを持てる
- **プロジェクト保存** — グラフ・メモ・ルートディレクトリを JSON ファイルに保存/復元
- **行メモ** — 任意の行にメモを付けてエディタ上にインライン表示
- **Ctrl+P ファイルクイックオープン** — fzf スタイルのファジー検索（スペース区切りで AND 絞り込み）
- **#ifdef 可視化** — C/C++ の条件コンパイルブロックをハイライト
- **ナビゲーション履歴** — Alt+← / Alt+→ で閲覧履歴を前後に移動
- **F3 / Shift+F3** — 検索結果を順番にジャンプ

---

## 必要なもの

- [Go](https://golang.org/) 1.21 以上
- [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg` コマンドが PATH にあること)
- インターネット接続（初回起動時に Monaco Editor・D3.js を CDN から読み込みます）

---

## インストール・起動

```bash
# ビルド
go build .
# → Windows: grepnavi.exe  Mac/Linux: grepnavi が生成されます

# 起動
# Windows (PowerShell)
.\grepnavi.exe

# Mac/Linux
./grepnavi

# 起動後にブラウザ上のルートチップからディレクトリを変更できます
# -root で起動時に指定することも可能
# .\grepnavi.exe -root C:\path\to\your\project
```

ブラウザが自動で開きます → http://localhost:8080

### オプション

| フラグ | デフォルト | 説明 |
|--------|-----------|------|
| `-root` | `.` (カレントディレクトリ) | 検索対象のルートディレクトリ |
| `-graph` | `graph.json` | プロジェクトファイルのパス |
| `-port` | `8080` | HTTP サーバーのポート番号 |

### オフライン・社内環境で使う

デフォルトは CDN（jsdelivr）から Monaco Editor と D3.js を読み込みます。
外部 CDN にアクセスできない場合はローカルに切り替えてください。

**Monaco Editor**

[Releases](https://github.com/microsoft/monaco-editor/releases) から `monaco-editor-x.x.x.tgz` をダウンロードし、`min/vs/` を `static/vs/` に配置。

`static/index.html` を変更：
```js
// CDN（デフォルト）
var require = {paths: {'vs': 'https://cdn.jsdelivr.net/npm/monaco-editor@0.44.0/min/vs'}};

// ローカルに変更
var require = {paths: {'vs': '/vs'}};
```

**D3.js**

[d3.min.js](https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js) をダウンロードして `static/d3.min.js` に配置。

`static/js/app.js` を変更：
```js
// CDN（デフォルト）
s.src = 'https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js';

// ローカルに変更
s.src = '/d3.min.js';
```

---

## 使い方

### 基本的な流れ

1. 検索バーにパターンを入力して **検索** ボタン（または Enter）
2. 結果行をクリック → 右ペインのエディタでコードを確認
3. 気になった行を **+** ボタンでグラフに追加
4. グラフ上でノードをドラッグして親子関係を整理
5. **Ctrl+S** でプロジェクトファイルに保存

### キーボードショートカット

| キー | 動作 |
|------|------|
| `Ctrl+P` | ファイルクイックオープン（fzf スタイル） |
| `F3` / `Shift+F3` | 検索結果を次/前へジャンプ |
| `Alt+←` / `Alt+→` | 閲覧履歴を前後に移動 |
| `Alt+C` | 大文字小文字を区別 |
| `Alt+W` | 単語単位で検索 |
| `Alt+R` | 正規表現モード |
| `Alt+M` | 行メモのインライン表示切り替え |
| `Alt+G` | エディタの選択テキストをノードに追加 |
| `Ctrl+S` | プロジェクトを保存 |
| `F12` / `Ctrl+クリック` | 定義ジャンプ |

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
│   └── handlers.go            # REST API ハンドラ
├── graph/
│   ├── model.go               # データ構造（Node, Edge, Tree, ProjectFile）
│   ├── store.go               # プロジェクトファイルの読み書き・ノード/エッジ操作
│   └── expand.go              # 検索結果 → ノード変換
├── search/
│   ├── ripgrep.go             # ripgrep 呼び出し・JSON パース・SSE ストリーミング
│   ├── definition.go          # 定義ジャンプ（ctags 風シンボル解析）
│   ├── symbols.go             # シンボル抽出
│   ├── ifdef.go               # #ifdef 条件コンパイル解析
│   └── ifdef_eval.go          # #ifdef 条件評価
└── static/
    ├── index.html
    ├── js/
    │   └── app.js             # フロントエンド（Monaco, D3.js, fzf）
    └── css/
        └── main.css
```

### API エンドポイント

| メソッド | パス | 説明 |
|---------|------|------|
| `GET` | `/api/graph` | アクティブツリーの取得 |
| `DELETE` | `/api/graph` | アクティブツリーをクリア |
| `POST` | `/api/graph/node` | ノード追加 |
| `DELETE` | `/api/graph/node/:id` | ノード削除 |
| `POST` | `/api/graph/edge` | エッジ追加 |
| `POST` | `/api/graph/reparent` | ノードの親を変更 |
| `POST` | `/api/graph/saveas` | プロジェクトを名前を付けて保存 |
| `POST` | `/api/graph/openfile` | プロジェクトファイルを開く |
| `GET/POST` | `/api/root` | 検索ルートの取得/変更 |
| `GET` | `/api/files` | ファイル一覧（Ctrl+P 用） |
| `GET/POST` | `/api/trees` | ツリー一覧取得/新規作成 |
| `GET/PUT/DELETE` | `/api/trees/:id` | ツリーの切り替え/リネーム/削除 |
| `POST` | `/api/search` | 検索（一括） |
| `GET` | `/api/search/stream` | 検索（SSE ストリーミング） |
| `GET` | `/api/open` | ファイルの内容取得 |
| `GET` | `/api/snippet` | スニペット取得 |

---

## ライセンス

MIT

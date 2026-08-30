# セットアップ詳細

[README](../README.md) のインストール・起動の補足。起動フラグ・デスクトップモードの詳細・SSH 経由の利用・索引エンジンの導入をまとめる。

## 起動オプション

| フラグ | デフォルト | 説明 |
|--------|-----------|------|
| `-root` | `.` (カレントディレクトリ) | 検索対象のルートディレクトリ |
| `-graph` | `graph.json` | プロジェクトファイルのパス。明示すると起動時にそのまま読み込む。省略時は作業ファイル扱いで、起動のたびに空のグラフから始まる（前回分は `graph.recover.json` へ退避され、メニューの「前回の作業を復元」で戻せる） |
| `-port` | `8080` | HTTP サーバーのポート番号 |
| `-host` | `127.0.0.1` | バインドアドレス。`0.0.0.0` を指定すると LAN 全体に公開される（認証なし・非推奨）。既定の loopback バインド時は `Host` ヘッダも loopback であることを検証するが、`0.0.0.0` を指定した場合は正当なホスト名を判定できないためこの検証は行わない |
| `-no-browser` | `false` | 起動時のブラウザ自動オープンを抑制する |
| `-tray` | `false` | UI をブラウザではなくシステムトレイ常駐 + 専用ウィンドウ（埋め込み WebView2）で開く。ブラウザ拡張機能の影響を受けない。Windows 専用 |
| `-mcp` | `false` | 外部プロセス（grepnavi-mcp ブリッジ等、`Origin` ヘッダー無しのクライアント）からの API 利用を許可する。デフォルトはブラウザのみ |
| `-mcp-insert` | `false` | 外部プロセス（AI エージェント）にデバッグ行の挿入・撤去・移動・ON/OFF を許可する（`-mcp` も自動で有効）。既定では読み取りのみ。操作できるのは**そのクライアント自身が挿入した行だけ**で、GUI で入れた行には触れない。挿入した行は記録に出所が残り、一覧で `AI` 印が付く。既存コードを `#if 0` で囲む操作と巻き戻し (Ctrl+Z) は、このフラグを付けても外部クライアントには開かない |
| `-lsp` | `false` | GUI ではなく Language Server（stdio）として起動する。下記「エディタ連携」参照 |
| `-log-level` | `info` | ログレベル（debug / info / warn / error） |
| `-debug` | `false` | `/debug/pprof` エンドポイントを有効化（プロファイル取得用） |

## デスクトップ（トレイ常駐）モード ※Windows のみ

```bash
.\grepnavi.exe -tray
```

システムトレイに常駐し、トレイメニューの「開く / 終了」でウィンドウを操作する。UI は埋め込み WebView2 で表示するため、ブラウザ拡張機能（アドオン）の影響を受けない。

ウィンドウは OS のタイトルバーを持たず、最小化 / 最大化 / 閉じるはページ右上の自前ボタンで行う（バーの空き部分をドラッグで移動、素早い2回押しで最大化）。グラフヘッダもこのバーに統合され、1行ぶん表示が広くなる。プロジェクト操作は「ファイル」メニュー、ツリーの描画切り替え（パス・メモ・グラフ）と各アドオンパネルは「表示」メニューにまとまり、ツリーの消去はタブの右クリックから行う。開いている JSON 名はステータスバー左に表示される。従来の OS タイトルバーに戻すには環境変数 `GREPNAVI_NATIVE_TITLEBAR=1` を設定して起動する。

## 別マシンから安全にアクセスする（SSH ポートフォワード）

grepnavi は認証機能を持たないため、LAN に直接公開することは推奨しません。
別マシン（ノート PC など）からアクセスしたい場合は SSH ポートフォワードを使うと、grepnavi 側の設定を変えずに安全に利用できます。

> **前提：** grepnavi を動かすマシンで SSH サーバーが起動している必要があります。
> - Linux/Mac: `sshd` が起動していれば OK
> - Windows: 設定 → オプション機能 → OpenSSH サーバーを追加・起動

**grepnavi を動かすマシン（デスクトップ側）**

通常通り起動します（localhost バインドのまま）。

```bash
./grepnavi
```

**アクセスしたいマシン（ノート PC 側）**

```bash
ssh -L 8080:localhost:8080 user@desktop-ip
```

その後ノート PC のブラウザで `http://localhost:8080` を開くだけです。

- `user` → デスクトップのユーザー名
- `desktop-ip` → デスクトップの IP アドレス

通信は SSH で暗号化されるため、grepnavi 自体に認証がなくても SSH の認証強度がそのままセキュリティ強度になります。

## エディタ連携（LSP・実験的）

`grepnavi -lsp` は Language Server Protocol の stdio サーバとして起動し、次をエディタに提供する（GUI も HTTP サーバも起動しない）。

| エディタの操作 | LSP | 中身 |
|---|---|---|
| 定義へ移動（F12） | definition | gtags → ctags → ripgrep の順で、GUI と同じ |
| 型定義へ移動 | typeDefinition | 変数の型を struct / union まで辿る（typedef は索引で解く） |
| 実装へ移動 | implementation | 関数ならその定義。関数ポインタのメンバ（`p->read(`）なら `.read = fn` / `p->read = fn` と書いている行の一覧。名前だけから実体は決められないので、集合で返す |
| 参照（Shift+F12） | references | 索引優先 |
| 同じ語のハイライト | documentHighlight | ローカル変数はその関数の中だけ、書き込みは Write として区別 |
| ホバー | hover | 定義スニペットとマクロ・enum の計算値 |
| 引数のヒント（`(` `,` で発火） | signatureHelp | 定義行の字面。関数ポインタのメンバは宣言 `int (*read)(...)` から |
| 呼び出し階層（Shift+Alt+H） | callHierarchy | 呼び出し元はテーブル登録行を含む。呼び出し先は関数ポインタ経由を `(ptr 受け手)` と示して展開しない |
| 補完 | completion | 構造体メンバー、`.`→`->` の自動修正、ローカル変数・関数・マクロ |
| アウトライン / Ctrl+T | documentSymbol / workspaceSymbol | ctags |
| 折りたたみ | foldingRange | 関数本体、`#if`〜`#endif`、複数行コメント |
| マクロと型名の色付け | semanticTokens | ctags |
| 関数の上の「呼び出し元 3（登録 1）」 | codeLens | 索引の呼び出し元。テーブル登録行も数える。クリックで呼び出し行の一覧を Peek。件数は画面に見えている関数だけ数え、ファイルごとにキャッシュする |

やらないもの: rename（検索ベースで名前を書き換えると別のシンボルまで変わる）、診断・コードアクション・整形（コンパイラの領分）。

要求は同時に 4 件まで並行して処理し、エディタの `$/cancelRequest`（カーソルが動いて不要になった要求の取り消し）に従う。1 リクエストは 15 秒で打ち切り、索引に無い語の全文検索が他の要求を塞がないようにしている。索引の扱いは GUI と同じで、GNU Global があれば索引で引き、無ければ ripgrep に落ちる。診断（エラー表示）は名乗らない。

Neovim は追加プラグインなしで接続できる:

```lua
vim.api.nvim_create_autocmd("FileType", {
  pattern = { "c", "cpp" },
  callback = function()
    vim.lsp.start({
      name = "grepnavi",
      cmd = { "path/to/grepnavi", "-lsp" },
      root_dir = vim.fs.root(0, { "GTAGS", ".git" }),
    })
  end,
})
```

VSCode は同梱の接続拡張を使う（`editors/vscode/`）。ビルドとインストール:

```bash
cd editors/vscode
npm install
npx @vscode/vsce package --allow-missing-repository --skip-license
code --install-extension grepnavi-lsp-0.1.3.vsix
```

インストール後、設定 `grepnavi.serverPath` に grepnavi 実行ファイルのパスを指定する（PATH に置いてあれば不要）。C/C++ ファイルを開くと自動で接続され、F12 / Shift+F12 / 呼び出し階層（Shift+Alt+H）が grepnavi の索引で動く。拡張名を出したくない環境では `package.json` の `displayName` を変えてからパッケージし直す。

## アイコンの再生成

アイコン（トレイ・exe・ウィンドウ・favicon で共用）は `rsrc_windows_amd64.syso` をリポジトリに含めているため、上記のビルドだけで exe に埋め込まれます。追加の手順は不要です。

意匠を変更する場合のみ、原本である `tools/icongen` から再生成してください。

```bash
go run ./tools/icongen   # desktop/app_icon.ico と static/favicon.ico を再生成
go run github.com/akavel/rsrc@latest -ico desktop/app_icon.ico -arch amd64 -o rsrc_windows_amd64.syso
```

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
2. エディタのファイルヘッダ右端に表示される **「索引」** ラベルをクリック（索引が無いときは「索引なし (grep で代用)」と出る）
3. ポップオーバーで、索引の「生成」を実行
4. 以降、定義ジャンプ（Ctrl+クリック / F12）・ホバー・コールツリーの Callers が GNU Global を使用する

インデックスは `GTAGS` / `GRTAGS` / `GPATH` の 3 ファイルとしてプロジェクトルートに保存されます。ファイルを変更した後は「更新」で差分更新、大規模なリファクタリング後は「再生成」を使ってください。

## Universal Ctags（オプション）

[Universal Ctags](https://github.com/universal-ctags/ctags) の `tags` ファイルを生成しておくと、定義ジャンプの精度が向上し、定数・マクロのハイライトが有効になります。

### インストール（Windows）

```bash
scoop install universal-ctags
```

### 使い方

1. grepnavi を起動し、プロジェクトルートを開く
2. エディタのファイルヘッダ右端に表示される **「索引」** ラベルをクリック（索引が無いときは「索引なし (grep で代用)」と出る）
3. ポップオーバーで、索引の「生成」を実行
4. 以降、定義ジャンプ（Ctrl+クリック / F12）・定数マクロのハイライトが有効になる

インデックスは `tags` ファイルとしてプロジェクトルートに保存されます。ファイルを追加・変更した後は「更新」で再生成してください。

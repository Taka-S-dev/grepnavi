# API エンドポイント

すべて loopback バインドの HTTP。外部プロセスから使う場合は `-mcp` フラグが必要（詳細は [mcp/README.md](../mcp/README.md)）。取得系は GET、変更系は POST が基本（`/api/graph` の DELETE などの例外は `api/handlers.go` の登録を参照）。

## 検索・解析

| パス | 説明 |
|------|------|
| `/api/search/stream` | 検索（SSE ストリーミング） |
| `/api/search` | 検索（ページネーション付き一括取得。MCP ブリッジ用） |
| `/api/symbol-search` | シンボル名のパターン検索（Alt+Shift+T / ƒ パネル、ctags 索引） |
| `/api/symbols` | 指定ファイル内のシンボル一覧 |
| `/api/definition` | 定義ジャンプ先の解決 |
| `/api/references` | 参照一覧（参照ピッカー / MCP） |
| `/api/complete` | 補完候補（デバッグ行ダイアログ用。メンバー / ローカル変数 / マクロ） |
| `/api/callers` / `/api/callees` | 関数の呼び出し元 / 呼び出し先 |
| `/api/func-body` | 関数本体の取得 |
| `/api/hover` | ホバープレビュー用スニペット |
| `/api/snippet` | 行周辺のスニペット取得 |
| `/api/macro-values` | マクロ・enum メンバ名の整数値解決（基数変換電卓用） |
| `/api/include-graph` / `/api/include-file` / `/api/include-by` | インクルード依存の取得 |
| `/api/ifdef` | 条件を与えて #if で無効になる行を判定（グレーアウト用） |
| `/api/ifdef-stack` | 行を囲んでいる #if 条件のスタック |
| `/api/state-machine` | 状態変数への代入を集めて遷移を返す |
| `/api/structure` | 参照マップ（全体図 / フォーカスの3面） |
| `/api/structure/build` / `/api/structure/status` | 参照マップの生成 / 有無・鮮度・見込み時間 |
| `/api/structure/children` | まとまり直下の一覧（パンくず移動用） |
| `/api/structure/edge-symbols` | 表示中の1エッジをまたぐ全シンボル |
| `/api/heal-line` | 記録行が内容とずれたときの照合補正 |
| `/api/file` / `/api/file/mtime` | ファイル内容 / 更新時刻の取得 |

## 調査グラフ

| パス | 説明 |
|------|------|
| `/api/graph` | アクティブツリーの取得（DELETE でクリア） |
| `/api/graph/clear` | ツリーのクリア |
| `/api/graph/node` / `/api/graph/node/:id` | ノードの追加 / 更新・削除 |
| `/api/graph/edge` / `/api/graph/edge/delete` | エッジの追加 / 削除 |
| `/api/graph/reparent` / `/api/graph/rootorder` / `/api/graph/tree/move-node` | 階層・並び順・所属ツリーの変更 |
| `/api/graph/expand` | ノードのシンボルを検索してヒットを子として追加 |
| `/api/graph/undo` | 直前のグラフ操作を戻す |
| `/api/graph/memos` | 行メモ・範囲メモの取得 / 更新 |
| `/api/graph/anchors` / `/api/graph/anchors/heal` | ピン位置のずれの列挙 / 一意なずれの自動追従 |
| `/api/graph/saveas` / `/api/graph/openfile` | 名前を付けて保存 / プロジェクトファイルを開く |
| `/api/graph/export` / `/api/graph/import` | グラフの書き出し / 取り込み |
| `/api/graph/description` / `/api/graph/descriptions` | 調査 JSON の説明の編集 / 一括取得 |
| `/api/graph/recover` | 前回の作業ファイルの復元 |
| `/api/trees` / `/api/trees/:id` | ツリーの一覧・作成 / 切り替え・リネーム・削除 |

## デバッグ行

| パス | 説明 |
|------|------|
| `/api/insertions` | 挿入（loopback バインド時のみ） |
| `/api/insertions/:id` | 書き換え / 撤去（記録行の照合付き。`record_only=1` で記録だけ削除） |
| `/api/insertions/removeall` | 一括撤去（`group` 指定でグループ単位） |
| `/api/insertions/restore` | 直前の撤去・移動を戻す（Ctrl+Z） |
| `/api/insertions/move` | 指定行の後ろへ移動（ID は保たれる） |
| `/api/insertions/toggle` | 一時無効化 / 再有効化（コメントアウトの往復） |
| `/api/insertions/wrap` | 選択範囲を #if 0 / #endif で囲む |
| `/api/insertions/group` | グループ名の変更 |

## 索引エンジン

| パス | 説明 |
|------|------|
| `/api/gtags/status` | GNU Global の導入・索引・鮮度の状態 |
| `/api/gtags/index` / `update` / `rebuild` | 索引の生成 / 差分更新 / 再生成 |
| `/api/gtags/stream` | 索引操作の進捗（SSE） |
| `/api/ctags/status` / `/api/ctags/index` | ctags の状態 / 索引生成 |
| `/api/ctags/macros` / `/api/ctags/file-symbols` | マクロ一覧 / ファイル内シンボル（ハイライト用） |

## プロジェクト・ルート・その他

| パス | 説明 |
|------|------|
| `/api/root` | 検索ルートの取得 / 変更 |
| `/api/grepnavi` | ルートの `.grepnavi` の取得 / 更新（graphs / exclude） |
| `/api/grepnavi/open` | 任意の `.grepnavi` を開いてルートを切り替え |
| `/api/grepnavi/graphs` | 登録 JSON リストの更新 |
| `/api/projects` / `/api/projects/:id` | プロジェクトマネージャーの一覧・登録 / 削除 |
| `/api/dirs` / `/api/files` | サブディレクトリ / ファイル一覧（Ctrl+P 用） |
| `/api/browse` | ディレクトリ内容の一覧（ファイルブラウザ用、拡張子フィルタ付き） |
| `/api/pick-dir` | OS のフォルダ選択ダイアログを開く |
| `/api/open` | 外部エディタでファイルを開く |
| `/api/reveal` | エクスプローラでファイルを表示 |
| `/api/new-window` | 新しいウィンドウ（別インスタンス）を起動 |
| `/api/has-ignore` | ルートに .gitignore 等があるか（除外マーカー表示用） |
| `/api/editor-state` | 開いているファイル・カーソル位置（MCP 用） |
| `/api/events` | グラフ変更通知（SSE） |
| `/api/memstats` | メモリ使用量の診断 |

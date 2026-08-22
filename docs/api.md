# API エンドポイント

すべて loopback バインドの HTTP。外部プロセスから使う場合は `-mcp` フラグが必要（詳細は [mcp/README.md](../mcp/README.md)）。

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
| `GET` | `/api/graph/anchors` | ピン位置がずれたノード・行メモの列挙 |
| `POST` | `/api/graph/anchors/heal` | 一意に見つかったずれの自動追従（曖昧なものは動かさない） |
| `POST` | `/api/insertions` | デバッグ行の挿入（loopback バインド時のみ） |
| `PUT/DELETE` | `/api/insertions/:id` | デバッグ行の書き換え/撤去（記録行の照合付き） |
| `POST` | `/api/insertions/removeall` | 全デバッグ行の一括撤去（`group` 指定でグループ単位） |
| `POST` | `/api/insertions/restore` | 直前の撤去・移動を戻す（Ctrl+Z） |
| `POST` | `/api/insertions/move` | デバッグ行を指定行の後ろへ移す（ID は保つ） |
| `POST` | `/api/graph/saveas` | プロジェクトを名前を付けて保存 |
| `POST` | `/api/graph/openfile` | プロジェクトファイルを開く |
| `GET/POST` | `/api/root` | 検索ルートの取得/変更 |
| `GET/POST` | `/api/grepnavi` | ルートの `.grepnavi` ファイルの取得/更新（graphs / exclude） |
| `POST` | `/api/grepnavi/open` | 任意の `.grepnavi` を開いてルートを切り替え |
| `GET/POST/DELETE` | `/api/projects` | プロジェクトマネージャーの一覧取得/登録 |
| `DELETE` | `/api/projects/:id` | プロジェクトの削除 |
| `GET` | `/api/dirs` | ルートディレクトリのサブディレクトリ一覧 |
| `GET` | `/api/files` | ファイル一覧（Ctrl+P 用） |
| `GET/POST` | `/api/trees` | ツリー一覧取得/新規作成 |
| `GET/PUT/DELETE` | `/api/trees/:id` | ツリーの切り替え/リネーム/削除 |
| `GET` | `/api/search/stream` | 検索（SSE ストリーミング） |
| `GET` | `/api/search` | 検索（ページネーション付き一括取得。MCP ブリッジ用） |
| `GET` | `/api/symbol-search` | シンボル名のパターン検索（Alt+Shift+T / MCP 用、ctags 索引ベース） |
| `POST` | `/api/open` | 外部エディタでファイルを開く |
| `GET` | `/api/snippet` | スニペット取得 |
| `GET` | `/api/definition` | 定義ジャンプ先の検索 |
| `GET` | `/api/hover` | ホバープレビュー用スニペット取得 |
| `GET` | `/api/macro-values` | マクロ・enum メンバ名の整数値解決（基数変換電卓用） |
| `GET` | `/api/callers` | 関数の呼び出し元を検索 |
| `GET` | `/api/callees` | 関数の呼び出し先を検索 |
| `GET` | `/api/include-graph` | ファイルのインクルード依存グラフ取得 |
| `GET` | `/api/include-file` | ファイルが `#include` しているファイル一覧 |
| `GET` | `/api/include-by` | ファイルを `#include` しているファイル一覧 |
| `GET` | `/api/gtags/status` | GNU Global のインストール状況・インデックス状態を取得 |
| `POST` | `/api/gtags/index` | GNU Global インデックスを新規生成 |
| `POST` | `/api/gtags/update` | GNU Global インデックスを差分更新 |
| `POST` | `/api/gtags/rebuild` | 既存インデックスを削除して完全再生成 |

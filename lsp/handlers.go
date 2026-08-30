package lsp

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"grepnavi/search"
)

// detailOf はアイテムの補足表示用に「L行 相対パス」を返す。行番号を先に置くのは、
// 呼び出し階層ペインが狭いと末尾から切れるため: パスは切れても行番号は残る。
func (s *server) detailOf(file string, line int) string {
	rel, err := filepath.Rel(s.root, file)
	if err != nil || len(rel) > len(file) {
		rel = filepath.Base(file)
	}
	return "L" + strconv.Itoa(line) + " " + filepath.ToSlash(rel)
}

// 解決の方針は GUI と同じ: 索引 (gtags) があれば索引で引き、無ければ ripgrep に
// 落ちる。0 件は「無い」という答えとして返し、劣化した全文検索の結果で水増し
// しない。エディタの一覧 UI は候補の真偽を選別する場ではないため、この規律は
// GUI 以上に効く。

func (s *server) handleInitialize(raw json.RawMessage) any {
	var p struct {
		RootURI  string `json:"rootUri"`
		RootPath string `json:"rootPath"`
	}
	_ = json.Unmarshal(raw, &p)
	if p.RootURI != "" {
		s.root = uriToPath(p.RootURI)
	} else if p.RootPath != "" {
		s.root = p.RootPath
	}
	// 「対象から外すもの」を GUI と同じに効かせる。除外規則は search のグローバル
	// だが読み込むのは普段 api 層なので、API を起動しない LSP では自分で読む。
	search.LoadExcludesFromRoot(s.root)
	// マクロ名のキャッシュを先に温める（セマンティックトークン用。サイドカーが
	// あれば一瞬、無ければ tags のパースが裏で走る）
	search.CtagsMacroWarmup(s.root)
	return map[string]any{
		"capabilities": map[string]any{
			"textDocumentSync":        1, // Full: 変更のたびに全文が届く。補完が未保存バッファを見るため
			"completionProvider":      map[string]any{"triggerCharacters": []string{".", ">"}},
			"definitionProvider":        true,
			"typeDefinitionProvider":    true,
			"implementationProvider":    true,
			"referencesProvider":        true,
			"documentHighlightProvider": true,
			"hoverProvider":             true,
			"signatureHelpProvider":     map[string]any{"triggerCharacters": []string{"(", ","}},
			"documentSymbolProvider":    true,
			"workspaceSymbolProvider":   true,
			"callHierarchyProvider":     true,
			"foldingRangeProvider":      true,
			"semanticTokensProvider": map[string]any{
				"legend": semanticLegend,
				"full":   true,
			},
		},
		"serverInfo": map[string]any{"name": "grepnavi-lsp"},
	}
}

// wordAt は URI と位置からカーソル下の識別子を切り出す。開いている文書なら
// バッファ（未保存の編集込み）を見る。
func (s *server) wordAt(uri string, pos position) (word, path string) {
	path = uriToPath(uri)
	content, ok := s.documentText(uri)
	if !ok {
		return "", path
	}
	word = wordAtPosition(content, pos)
	// キーワードに定義は無い。索引が 0 件を返したあと rg のフォールバックが
	// ツリー全体を走査し、受付が直列なので後続の要求まで全部その後ろに並ぶ
	// （実測: openssl で `unsigned` に F12 → 20 分）。語を空にして手前で止める
	if cKeywords[word] {
		return "", path
	}
	return word, path
}

// cKeywords は定義を探しても意味が無い語。型・修飾子・制御構文。
// NULL や errno はマクロとして定義があるので入れない
var cKeywords = map[string]bool{
	"auto": true, "break": true, "case": true, "char": true, "const": true,
	"continue": true, "default": true, "do": true, "double": true, "else": true,
	"enum": true, "extern": true, "float": true, "for": true, "goto": true,
	"if": true, "inline": true, "int": true, "long": true, "register": true,
	"restrict": true, "return": true, "short": true, "signed": true, "sizeof": true,
	"static": true, "struct": true, "switch": true, "typedef": true, "union": true,
	"unsigned": true, "void": true, "volatile": true, "while": true,
}

// requestTimeout は 1 リクエストに許す時間。受付が直列なので、索引に無い語の
// rg フォールバックが長引くと後続の要求が全部その後ろに並ぶ。期限が来たら
// rg は殺され（proc.CommandContext）、その要求は「答えなし」で返る。
// 索引があれば 1 秒かからず、無くても openssl 級のツリーの rg 走査は数秒で
// 終わるので、正しい答えを切る値ではない。
const requestTimeout = 15 * time.Second

func (s *server) requestContext() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), requestTimeout)
}

func (s *server) findDefinitions(word, currentFile string) []search.DefHit {
	ctx, cancel := s.requestContext()
	defer cancel()
	if search.GtagsInPath() && search.GtagsIndexed(s.root) {
		if hits, err := search.GtagsFindDefinitions(ctx, word, s.root); err == nil && len(hits) > 0 {
			return hits
		}
	}
	hits, err := search.FindDefinitionsSmart(ctx, word, currentFile, s.root, "")
	if err != nil {
		return nil
	}
	return hits
}

func (s *server) handleDefinition(raw json.RawMessage) (any, *responseError) {
	var p textDocumentPositionParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, &responseError{Code: codeInvalidRequest, Message: err.Error()}
	}
	word, path := s.wordAt(p.TextDocument.URI, p.Position)
	if word == "" {
		return []location{}, nil
	}
	locs := []location{}
	for _, h := range s.findDefinitions(word, path) {
		locs = append(locs, location{URI: pathToURI(h.File), Range: lineRange(h.Line)})
	}
	return locs, nil
}

func (s *server) handleReferences(raw json.RawMessage) (any, *responseError) {
	var p textDocumentPositionParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, &responseError{Code: codeInvalidRequest, Message: err.Error()}
	}
	word, _ := s.wordAt(p.TextDocument.URI, p.Position)
	if word == "" {
		return []location{}, nil
	}
	// 上限は GUI の参照一覧と同じ発想で高めに取る。切られたことを LSP で
	// 伝える口は無いので、途中で黙って切れるよりは広く返す。
	ctx, cancel := s.requestContext()
	defer cancel()
	refs, _, _, err := search.FindReferences(ctx, word, s.root, 2000, false, "")
	if err != nil {
		return nil, &responseError{Code: codeInvalidRequest, Message: err.Error()}
	}
	locs := []location{}
	for _, r := range refs {
		locs = append(locs, location{URI: pathToURI(r.File), Range: lineRange(r.Line)})
	}
	return locs, nil
}

// handleHover は GUI のホバーと同じ FindHover を Markdown に組む。定義スニペット
// （直前コメント込み）と、マクロ・enum なら計算値。複数定義は最大3枚まで。
func (s *server) handleHover(raw json.RawMessage) (any, *responseError) {
	var p textDocumentPositionParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, &responseError{Code: codeInvalidRequest, Message: err.Error()}
	}
	word, _ := s.wordAt(p.TextDocument.URI, p.Position)
	if word == "" {
		return nil, nil
	}
	ctx, cancel := s.requestContext()
	defer cancel()
	hits, _, err := search.FindHover(ctx, word, s.root, "", s.root)
	if err != nil || len(hits) == 0 {
		return nil, nil
	}
	var md strings.Builder
	const maxCards = 3
	for i, h := range hits {
		if i == maxCards {
			fmt.Fprintf(&md, "_…他 %d 件_\n", len(hits)-maxCards)
			break
		}
		if i > 0 {
			md.WriteString("\n---\n")
		}
		title := h.Kind
		if h.Chained && h.Name != "" {
			title += " " + h.Name
		}
		if h.Value != "" {
			title += " = " + h.Value
		}
		fmt.Fprintf(&md, "**%s** — %s\n\n```c\n%s\n```\n",
			title, s.detailOf(h.File, h.Line), strings.TrimRight(h.Body, "\r\n"))
	}
	return map[string]any{
		"contents": map[string]string{"kind": "markdown", "value": md.String()},
	}, nil
}

func (s *server) handlePrepareCallHierarchy(raw json.RawMessage) (any, *responseError) {
	var p textDocumentPositionParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, &responseError{Code: codeInvalidRequest, Message: err.Error()}
	}
	word, path := s.wordAt(p.TextDocument.URI, p.Position)
	if word == "" {
		return nil, nil // null = ここでは階層を出せない（仕様どおり）
	}
	// 定義位置をアイテムにする。見つからなければカーソル位置をそのまま使う
	// （rg フォールバックすら外した環境でも、呼び出し元一覧自体は引けるため）。
	item := callHierarchyItem{
		Name:  word,
		Kind:  symbolKindFunction,
		URI:   p.TextDocument.URI,
		Range: lineRange(p.Position.Line + 1), SelectionRange: lineRange(p.Position.Line + 1),
	}
	for _, h := range s.findDefinitions(word, path) {
		if h.Kind == "func" || item.URI == p.TextDocument.URI {
			item.URI = pathToURI(h.File)
			item.Range = lineRange(h.Line)
			item.SelectionRange = lineRange(h.Line)
			if h.Kind == "func" {
				break
			}
		}
	}
	return []callHierarchyItem{item}, nil
}

type callHierarchyCallsParams struct {
	Item callHierarchyItem `json:"item"`
}

func (s *server) handleIncomingCalls(raw json.RawMessage) (any, *responseError) {
	var p callHierarchyCallsParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, &responseError{Code: codeInvalidRequest, Message: err.Error()}
	}
	ctx, cancel := s.requestContext()
	defer cancel()
	sites, _, _, err := search.FindRefSites(ctx, search.RefQuery{
		Word:        p.Item.Name,
		Root:        s.root,
		CallersOnly: true,
		Limit:       1000,
	})
	if err != nil {
		return nil, &responseError{Code: codeInvalidRequest, Message: err.Error()}
	}
	type incomingCall struct {
		From       callHierarchyItem `json:"from"`
		FromRanges []lspRange        `json:"fromRanges"`
	}
	calls := []incomingCall{}
	for _, c := range sites {
		name := c.Func
		if name == "" {
			// 関数ポインタテーブルの登録行など、囲む関数を持たない参照。
			// 登録箇所も「誰が呼ぶか」の答えなので落とさない（GUI と同じ扱い）。
			name = c.Text
		}
		calls = append(calls, incomingCall{
			From: callHierarchyItem{
				Name:   name,
				Kind:   symbolKindFunction,
				Detail: s.detailOf(c.File, c.CallLine),
				URI:    pathToURI(c.File),
				Range:  lineRange(c.Line), SelectionRange: lineRange(c.Line),
			},
			FromRanges: []lspRange{lineRange(c.CallLine)},
		})
	}
	return calls, nil
}

func (s *server) handleOutgoingCalls(raw json.RawMessage) (any, *responseError) {
	var p callHierarchyCallsParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, &responseError{Code: codeInvalidRequest, Message: err.Error()}
	}
	file := uriToPath(p.Item.URI)
	line := p.Item.SelectionRange.Start.Line + 1
	type outgoingCall struct {
		To         callHierarchyItem `json:"to"`
		FromRanges []lspRange        `json:"fromRanges"`
	}
	calls := []outgoingCall{}
	// 子アイテムは位置が呼び出し行（呼び出し元の関数の中）なので、その位置で
	// 囲む関数を取ると呼び出し元自身に戻り、同じ子が何段でも繰り返される。
	// 展開のときは Data に運んだ名前で定義を引き直し、その本体を見る。
	// 定義が引けない名前（マクロ・libc）は「呼び先なし」で止める。
	if p.Item.Data != nil {
		// 関数ポインタ経由: 実体は字面で決まらない。名前で定義を引くと同名の
		// 別関数の本体を展開してしまうので、ここで止める（GUI の (ptr) と同じ）
		if p.Item.Data.Indirect {
			return calls, nil
		}
		if p.Item.Data.Callee != "" {
			def, ok := s.findFunctionDefinition(p.Item.Data.Callee, file)
			if !ok {
				return calls, nil
			}
			file, line = def.File, def.Line
		}
	}
	ctx, cancel := s.requestContext()
	defer cancel()
	hits, self, _, err := search.FindCallees(ctx, file, line, s.root)
	if err != nil {
		return nil, &responseError{Code: codeInvalidRequest, Message: err.Error()}
	}
	for _, c := range hits {
		// `int run(void) {` のように `{` がシグネチャと同じ行にあると、自分の
		// 名前が呼び先に混ざる（GUI と MCP も同じ理由で自分を除いている）
		if c.Name == self {
			continue
		}
		// アイテムの位置は呼び出し行のまま: クリックの着地点はそこでよく、
		// 呼び先ごとに索引を引かずに済む。定義は展開されたときだけ引く。
		kind := symbolKindFunction
		if c.Kind == "define" {
			kind = symbolKindConstant
		}
		detail := s.detailOf(file, c.CallLine)
		if c.Indirect {
			// 受け手の式を添える: `(ptr s->method)` で「method に何が入るか」
			// を追う起点が名前の横に出る
			detail += "  (ptr"
			if c.Receiver != "" {
				detail += " " + c.Receiver
			}
			detail += ")"
		}
		calls = append(calls, outgoingCall{
			To: callHierarchyItem{
				Name:   c.Name,
				Kind:   kind,
				Detail: detail,
				URI:    pathToURI(file),
				Range:  lineRange(c.CallLine), SelectionRange: lineRange(c.CallLine),
				Data:   &callHierarchyData{Callee: c.Name, Indirect: c.Indirect},
			},
			FromRanges: []lspRange{lineRange(c.CallLine)},
		})
	}
	return calls, nil
}

// findFunctionDefinition は名前から関数定義を 1 件選ぶ。関数の定義が無く
// マクロや宣言しか引けないときは false（本体が無いので呼び先も無い）。
func (s *server) findFunctionDefinition(word, currentFile string) (search.DefHit, bool) {
	for _, h := range s.findDefinitions(word, currentFile) {
		if h.Kind == "func" {
			return h, true
		}
	}
	return search.DefHit{}, false
}

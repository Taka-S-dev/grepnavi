package lsp

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"regexp"
	"runtime"
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

// lineLink は detailOf と同じ表示を、ホバーの中で押せるリンクにしたもの。
// 吹き出しの中のテキストは Ctrl+クリックできないので、場所へはリンクで行く。
// `file:///path#L10` は VSCode が行番号つきで開く。
func (s *server) lineLink(file string, line int) string {
	return "[" + s.detailOf(file, line) + "](" + pathToURI(file) + "#L" + strconv.Itoa(line) + ")"
}

// typeLine は宣言された変数の型を struct / union まで辿り、その定義へのリンク行を
// 返す（辿れなければ空）。`SSL3_RECORD *thisrr;` のホバーから、typedef の先の
// struct ssl3_record_st へ 1 クリックで行けるように。
func (s *server) typeLine(ctx context.Context, content string, line int, word, currentFile string) string {
	owner, ok := search.VariableStructInText(s.root, content, line, word)
	if !ok {
		return ""
	}
	for _, h := range s.findDefinitions(ctx, owner, currentFile) {
		if h.Kind == "struct" || h.Kind == "union" {
			label := owner
			if strings.HasPrefix(owner, "__anon") {
				label = "{...}" // ctags が無名 struct に付ける内部名は読めない
			}
			return "\n型: " + h.Kind + " " + label + " — " + s.lineLink(h.File, h.Line) + "\n"
		}
	}
	return ""
}

func (s *server) handleInitialize(raw json.RawMessage) any {
	var p struct {
		RootURI               string `json:"rootUri"`
		RootPath              string `json:"rootPath"`
		InitializationOptions struct {
			// Defines は "CONFIG_X=1 DEBUG=0" の形。GUI の #ifdef 条件リストと同じ
			// 書式で、無効になる領域の計算に使う（拡張の設定 grepnavi.defines）
			Defines string `json:"defines"`
		} `json:"initializationOptions"`
	}
	_ = json.Unmarshal(raw, &p)
	if p.RootURI != "" {
		s.root = uriToPath(p.RootURI)
	} else if p.RootPath != "" {
		s.root = p.RootPath
	}
	s.defines = search.ParseDefines(p.InitializationOptions.Defines)
	// 「対象から外すもの」を GUI と同じに効かせる。除外規則は search のグローバル
	// だが読み込むのは普段 api 層なので、API を起動しない LSP では自分で読む。
	search.LoadExcludesFromRoot(s.root)
	// マクロ名のキャッシュを先に温める（セマンティックトークン用。サイドカーが
	// あれば一瞬、無ければ tags のパースが裏で走る）
	search.CtagsMacroWarmup(s.root)
	// gtags も GUI と同じく先に温める: global の起動方式の判定と定義テーブルの
	// 一括プリロード。無いと F12 のたびに global.exe を起動し、Ctrl を押して
	// 語に乗ってから下線が出るまで待たされて、最初のクリックが空振りする
	search.GtagsWarmupAsync(s.root)
	// 定義の表はメモリに持つ: F12 のたびの global.exe 起動（40〜60ms、検査の
	// 入る環境では不定期に 400〜900ms）を無くし、Ctrl+クリックの下線が即出る
	search.GtagsPreloadDefsAsync(s.root)
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
			// resolve を分けるのは、レンズの位置は 1ms で出せるが件数は索引を
			// 引くため。VSCode は見えているレンズだけ resolve してくる
			"codeLensProvider": map[string]any{"resolveProvider": true},
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
	// コメントと文字列の中の語は引かない。Ctrl を押したままスクロールすると
	// エディタはコメントの語にも定義を尋ね、索引に無い語は rg の全走査
	// （openssl で約 0.9 秒）になる。答えも無いので、手前で止める
	if inCommentOrString(content, pos) {
		return "", path
	}
	// キーワードに定義は無い。索引が 0 件を返したあと rg のフォールバックが
	// ツリー全体を走査し、同時 4 枠の 1 つを長時間塞ぐ（openssl 実測: `unsigned`
	// に F12 → 20 分）。語を空にして手前で止める
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

// requestTimeout は 1 リクエストに許す時間。同時に処理する枠は 4 つなので、
// 索引に無い語の rg フォールバックが長引くと枠を塞いで後続を待たせる。期限が
// 来たら rg は殺され（proc.CommandContext）、その要求は「答えなし」で返る。
// 索引があれば 1 秒かからず、無くても openssl 級のツリーの rg 走査は数秒で
// 終わるので、正しい答えを切る値ではない。
const requestTimeout = 15 * time.Second

func (s *server) requestContext(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(ctx, requestTimeout)
}

// findDefinitions は GUI と同じ方針で定義を引く: 索引 (gtags) があれば索引、
// 無ければ ripgrep。0 件は「無い」という答えとして返し、劣化した全文検索の
// 結果で水増ししない。エディタの一覧 UI は候補の真偽を選別する場ではないので、
// この規律は GUI 以上に効く。
func (s *server) findDefinitions(ctx context.Context, word, currentFile string) []search.DefHit {
	ctx, cancel := s.requestContext(ctx)
	defer cancel()
	if search.GtagsInPath() && search.GtagsIndexed(s.root) {
		if hits, err := search.GtagsFindDefinitions(ctx, word, s.root); err == nil && len(hits) > 0 {
			return cSourceOnly(hits)
		}
	}
	// gtags に無いもの（構造体メンバ・typedef の一部）は ctags が持つ。GUI と同じ
	// gtags → ctags → rg の順。ここを飛ばすと `s->rlayer` の F12 が 0 件になる
	if search.CtagsIndexed(s.root) {
		if hits, err := search.CtagsFindDefinitions(word, s.root); err == nil && len(cSourceOnly(hits)) > 0 {
			return cSourceOnly(hits)
		}
	}
	hits, err := search.FindDefinitionsSmart(ctx, word, currentFile, s.root, "")
	if err != nil {
		return nil
	}
	return cSourceOnly(hits)
}

// memberDefinitions は `s->method->ssl_read` のようにメンバとして書かれた語の
// 宣言を返す。受け手の struct が分かればその本体の宣言行、分からなければ
// ctags のメンバ項目。名前だけで索引を引くと同名の関数（bio_ssl.c の static
// ssl_read）が先に立つので、メンバ呼び出しではこちらを先に見る。
func (s *server) memberDefinitions(ctx context.Context, content string, pos position, word, currentFile string) []search.DefHit {
	owner := ""
	if chain := receiverChainAt(content, pos); len(chain) > 0 {
		owner, _ = search.ChainStructInText(s.root, content, pos.Line+1, chain)
	}
	if owner != "" {
		if defs := s.memberDeclarations(ctx, owner, word, currentFile); len(defs) > 0 {
			return defs
		}
	}
	hits, _ := search.CtagsFindDefinitions(word, s.root)
	var out []search.DefHit
	for _, h := range cSourceOnly(hits) {
		if h.Kind == "member" && (owner == "" || h.Owner == "" || h.Owner == owner) {
			out = append(out, h)
		}
	}
	return out
}

// cSourceOnly は C/C++ 以外のファイルにあるヒットを落とす。doxygen の出力ごと
// 索引にしたツリーでは `<title>rlayer</title>` の見出しがメンバ rlayer の定義として
// 並ぶ（実測: openssl の ssl/record/html/）。GUI は選ぶ場なので最後に並べて残すが、
// エディタの F12 やホバーに HTML の見出しを出す理由は無い
func cSourceOnly(hits []search.DefHit) []search.DefHit {
	out := hits[:0:0]
	for _, h := range hits {
		if search.IsCSourceFile(h.File) {
			out = append(out, h)
		}
	}
	return out
}

func (s *server) handleDefinition(ctx context.Context, raw json.RawMessage) (any, *responseError) {
	var p textDocumentPositionParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, &responseError{Code: codeInvalidParams, Message: err.Error()}
	}
	word, path := s.wordAt(p.TextDocument.URI, p.Position)
	if word == "" {
		return []location{}, nil
	}
	locs := []location{}
	// ローカル変数・引数はこの関数の宣言行へ。索引にはローカルが無いので、
	// 引くと同名のグローバルやメンバに飛んでしまう
	if content, ok := s.documentText(p.TextDocument.URI); ok {
		if line, _, ok := localDeclaration(content, p.Position, word); ok {
			return []location{{URI: p.TextDocument.URI, Range: wordRange(path, line+1, word)}}, nil
		}
		// メンバとして書かれた語は、同名の関数ではなくメンバの宣言へ。宣言が
		// 引けないときも関数には落とさない: C にメソッドは無いので、`x->f(` の f と
		// 同名の関数は別物（実測: befs の nls->uni2char が static uni2char に飛んだ）
		if memberAccessAt(content, p.Position) {
			for _, h := range s.memberDefinitions(ctx, content, p.Position, word, path) {
				locs = append(locs, location{URI: pathToURI(h.File), Range: wordRange(h.File, h.Line, word)})
			}
			return locs, nil
		}
	}
	for _, h := range s.findDefinitions(ctx, word, path) {
		locs = append(locs, location{URI: pathToURI(h.File), Range: wordRange(h.File, h.Line, word)})
	}
	return locs, nil
}

// handleReferences は定義ジャンプと同じ絞り込みを参照一覧にも掛ける。索引は語で
// 引くので、そのまま返すと ssl_lib.c の `s` に 1,026 件、`version` に別構造体の
// メンバまで並ぶ。ローカル変数はその関数の中の出現だけ、メンバは `->name` `.name`
// の形で現れる行だけにする。
func (s *server) handleReferences(ctx context.Context, raw json.RawMessage) (any, *responseError) {
	var p referenceParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, &responseError{Code: codeInvalidParams, Message: err.Error()}
	}
	word, path := s.wordAt(p.TextDocument.URI, p.Position)
	if word == "" {
		return []location{}, nil
	}
	content, hasDoc := s.documentText(p.TextDocument.URI)
	if hasDoc {
		if declLine, _, ok := localDeclaration(content, p.Position, word); ok {
			return localReferences(p.TextDocument.URI, content, p.Position, word, declLine, p.Context.IncludeDeclaration), nil
		}
	}
	// 上限は GUI の参照一覧と同じ発想で高めに取る。切られたことを LSP で
	// 伝える口は無いので、途中で黙って切れるよりは広く返す。
	ctx, cancel := s.requestContext(ctx)
	defer cancel()
	refs, _, engine, err := search.FindReferences(ctx, word, s.root, 2000, false, "")
	if err != nil {
		return nil, searchError(ctx, err)
	}
	isMember := hasDoc && memberAccessAt(content, p.Position)
	if isMember {
		re := regexp.MustCompile(`(?:->|\.)\s*` + regexp.QuoteMeta(word) + `\b`)
		kept := refs[:0]
		for _, r := range refs {
			if re.MatchString(r.Text) {
				kept = append(kept, r)
			}
		}
		refs = kept
	}
	// 宣言・定義の行は includeDeclaration に従って足す／外す。索引の参照一覧は
	// 定義行を含まない（gtags -r）ので、定義は別に引いて揃える。索引が無くて rg で
	// 引いたときは定義行も参照として混ざっており、もう一度走査してまで選り分けない
	var defs []search.DefHit
	if engine != "rg" {
		if isMember {
			defs = s.memberDefinitions(ctx, content, p.Position, word, path)
		} else {
			defs = s.findDefinitions(ctx, word, path)
		}
	}
	isDef := map[string]bool{}
	for _, d := range defs {
		isDef[lineKey(d.File, d.Line)] = true
	}
	locs := []location{}
	seen := map[string]bool{}
	for _, r := range refs {
		k := lineKey(r.File, r.Line)
		if seen[k] || (isDef[k] && !p.Context.IncludeDeclaration) {
			continue
		}
		seen[k] = true
		locs = append(locs, location{URI: pathToURI(r.File), Range: wordRange(r.File, r.Line, word)})
	}
	if p.Context.IncludeDeclaration {
		for _, d := range defs {
			if k := lineKey(d.File, d.Line); !seen[k] {
				seen[k] = true
				locs = append(locs, location{URI: pathToURI(d.File), Range: wordRange(d.File, d.Line, word)})
			}
		}
	}
	return locs, nil
}

// localReferences はローカル変数・引数の参照: 宣言を含む関数の中の出現を字面から
// 集める（ハイライトと同じ経路）。includeDeclaration が偽なら宣言の行は外す。
func localReferences(uri, content string, pos position, word string, declLine int, includeDeclaration bool) []location {
	locs := []location{}
	lines := strings.Split(content, "\n")
	fr, ok := enclosingFuncRange(lines, pos.Line+1)
	if !ok {
		return locs
	}
	masked := maskNonCode(lines[fr.Start-1 : fr.End])
	re := regexp.MustCompile(`\b` + regexp.QuoteMeta(word) + `\b`)
	for i, l := range masked {
		abs := fr.Start - 1 + i
		if abs == declLine && !includeDeclaration {
			continue
		}
		for _, m := range re.FindAllStringIndex(l, -1) {
			locs = append(locs, location{URI: uri, Range: lspRange{
				Start: position{Line: abs, Character: utf16Len(l[:m[0]])},
				End:   position{Line: abs, Character: utf16Len(l[:m[1]])},
			}})
		}
	}
	return locs
}

// lineKey は「同じファイルの同じ行」の鍵。索引と定義表でパスの区切りや大文字小文字が
// 揃わないことがあるので、正規化してから比べる
func lineKey(file string, line int) string {
	p := filepath.ToSlash(filepath.Clean(file))
	if runtime.GOOS == "windows" {
		p = strings.ToLower(p)
	}
	return p + ":" + strconv.Itoa(line)
}

// handleHover は GUI のホバーと同じ FindHover を Markdown に組む。定義スニペット
// （直前コメント込み）と、マクロ・enum なら計算値。複数定義は最大3枚まで。
func (s *server) handleHover(ctx context.Context, raw json.RawMessage) (any, *responseError) {
	var p textDocumentPositionParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, &responseError{Code: codeInvalidParams, Message: err.Error()}
	}
	word, path := s.wordAt(p.TextDocument.URI, p.Position)
	if word == "" {
		return nil, nil
	}
	// ローカル変数・引数はこの関数の宣言行を見せる。索引を引くと同名の
	// 構造体メンバがツリー全体から並ぶ（ssl3_get_record の version で 13 件）
	if content, ok := s.documentText(p.TextDocument.URI); ok {
		if line, text, ok := localDeclaration(content, p.Position, word); ok {
			md := "**local** — " + s.lineLink(path, line+1) + "\n\n```c\n" + declarationBlock(path, line+1, text) + "\n```\n" +
				s.typeLine(ctx, content, p.Position.Line+1, word, path)
			return map[string]any{
				"contents": map[string]string{"kind": "markdown", "value": md},
			}, nil
		}
		// メンバとして書かれた語は、その宣言行だけをカードにする。宣言が引けない
		// ときは何も出さない（同名の関数のカードを出すよりは無いほうが正しい）
		if memberAccessAt(content, p.Position) {
			defs := s.memberDefinitions(ctx, content, p.Position, word, path)
			if len(defs) == 0 {
				return nil, nil
			}
			{
				var md strings.Builder
				for i, d := range defs {
					if i == 3 {
						break
					}
					if i > 0 {
						md.WriteString("\n---\n")
					}
					fmt.Fprintf(&md, "**member** — %s\n\n```c\n%s\n```\n", s.lineLink(d.File, d.Line), declarationBlock(d.File, d.Line, d.Text))
					if d.Owner != "" {
						for _, o := range s.findDefinitions(ctx, d.Owner, path) {
							if o.Kind == "struct" || o.Kind == "union" {
								fmt.Fprintf(&md, "\n%s %s — %s\n", o.Kind, d.Owner, s.lineLink(o.File, o.Line))
								break
							}
						}
					}
				}
				return map[string]any{
					"contents": map[string]string{"kind": "markdown", "value": md.String()},
				}, nil
			}
		}
	}
	ctx, cancel := s.requestContext(ctx)
	defer cancel()
	hits, engine, err := search.FindHover(ctx, word, s.root, "", s.root)
	if err != nil {
		return nil, nil
	}
	// 生成 HTML の見出しなど C/C++ 以外のヒットはカードにしない（cSourceOnly と同じ理由）
	kept := hits[:0:0]
	for _, h := range hits {
		if search.IsCSourceFile(h.File) {
			kept = append(kept, h)
		}
	}
	hits = kept
	if len(hits) == 0 {
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
		// どの索引で引いたかを 1 語添える。検索ベースの答えは「なぜここか」が
		// 見えないと信用しにくく、rg（全文検索の推定）と gtags（索引）では重みが違う
		fmt.Fprintf(&md, "**%s** (%s) — %s\n\n```c\n%s\n```\n",
			title, engine, s.lineLink(h.File, h.Line), strings.TrimRight(h.Body, "\r\n"))
	}
	return map[string]any{
		"contents": map[string]string{"kind": "markdown", "value": md.String()},
	}, nil
}

func (s *server) handlePrepareCallHierarchy(ctx context.Context, raw json.RawMessage) (any, *responseError) {
	var p textDocumentPositionParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, &responseError{Code: codeInvalidParams, Message: err.Error()}
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
		Range: wordRange(path, p.Position.Line+1, word), SelectionRange: wordRange(path, p.Position.Line+1, word),
	}
	for _, h := range s.findDefinitions(ctx, word, path) {
		if h.Kind == "func" || item.URI == p.TextDocument.URI {
			item.URI = pathToURI(h.File)
			item.Range = wordRange(h.File, h.Line, word)
			item.SelectionRange = item.Range
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

func (s *server) handleIncomingCalls(ctx context.Context, raw json.RawMessage) (any, *responseError) {
	var p callHierarchyCallsParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, &responseError{Code: codeInvalidParams, Message: err.Error()}
	}
	ctx, cancel := s.requestContext(ctx)
	defer cancel()
	sites, _, _, err := search.FindRefSites(ctx, search.RefQuery{
		Word:        p.Item.Name,
		Root:        s.root,
		CallersOnly: true,
		Limit:       1000,
	})
	if err != nil {
		return nil, searchError(ctx, err)
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
				Range:  wordRange(c.File, c.Line, name), SelectionRange: wordRange(c.File, c.Line, name),
			},
			FromRanges: []lspRange{wordRange(c.File, c.CallLine, p.Item.Name)},
		})
	}
	return calls, nil
}

func (s *server) handleOutgoingCalls(ctx context.Context, raw json.RawMessage) (any, *responseError) {
	var p callHierarchyCallsParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, &responseError{Code: codeInvalidParams, Message: err.Error()}
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
			def, ok := s.findFunctionDefinition(ctx, p.Item.Data.Callee, file)
			if !ok {
				return calls, nil
			}
			file, line = def.File, def.Line
		}
	}
	ctx, cancel := s.requestContext(ctx)
	defer cancel()
	hits, self, _, err := search.FindCallees(ctx, file, line, s.root)
	if err != nil {
		return nil, searchError(ctx, err)
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
				Range:  wordRange(file, c.CallLine, c.Name), SelectionRange: wordRange(file, c.CallLine, c.Name),
				Data:   &callHierarchyData{Callee: c.Name, Indirect: c.Indirect},
			},
			FromRanges: []lspRange{wordRange(file, c.CallLine, c.Name)},
		})
	}
	return calls, nil
}

// findFunctionDefinition は名前から関数定義を 1 件選ぶ。関数の定義が無く
// マクロや宣言しか引けないときは false（本体が無いので呼び先も無い）。
func (s *server) findFunctionDefinition(ctx context.Context, word, currentFile string) (search.DefHit, bool) {
	for _, h := range s.findDefinitions(ctx, word, currentFile) {
		if h.Kind == "func" {
			return h, true
		}
	}
	return search.DefHit{}, false
}

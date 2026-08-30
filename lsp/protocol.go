package lsp

import (
	"net/url"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"unicode/utf16"

	"grepnavi/search"
)

// LSP の型のうち、名乗る capability に必要な最小集合。
// 仕様全部を写さない: 使わないフィールドは持たない。

type position struct {
	Line      int `json:"line"`      // 0-indexed
	Character int `json:"character"` // 0-indexed, UTF-16 code unit
}

type lspRange struct {
	Start position `json:"start"`
	End   position `json:"end"`
}

type location struct {
	URI   string   `json:"uri"`
	Range lspRange `json:"range"`
}

type textDocumentPositionParams struct {
	TextDocument struct {
		URI string `json:"uri"`
	} `json:"textDocument"`
	Position position `json:"position"`
}

// referenceParams は textDocument/references の引数。context.includeDeclaration は
// 宣言・定義の行を結果に含めるかで、エディタが必ず送ってくる。
type referenceParams struct {
	textDocumentPositionParams
	Context struct {
		IncludeDeclaration bool `json:"includeDeclaration"`
	} `json:"context"`
}

type callHierarchyItem struct {
	Name           string   `json:"name"`
	Kind           int      `json:"kind"`
	Detail         string   `json:"detail,omitempty"` // エディタが名前の横に薄く出す。ファイル:行 を入れる
	URI            string   `json:"uri"`
	Range          lspRange `json:"range"`
	SelectionRange lspRange `json:"selectionRange"`
	// Data はサーバが自由に持ち回れる値で、エディタは展開要求のときそのまま返す。
	// 呼び出し先アイテムは位置を呼び出し行に置くので、展開時に「どの関数の
	// 中身を見るか」をここで運ぶ（位置から囲む関数を取ると呼び出し元に戻ってしまう）
	Data *callHierarchyData `json:"data,omitempty"`
}

type callHierarchyData struct {
	// Callee は展開時に定義を引き直す関数名。空なら Range の位置をそのまま使う
	Callee string `json:"callee,omitempty"`
	// Indirect は関数ポインタ経由の呼び出し。展開しない（実体は字面で決まらない）
	Indirect bool `json:"indirect,omitempty"`
}

// LSP SymbolKind のうち使う値。マクロは Constant で出すと、関数と見分けが付く
// アイコンになる（呼び出し先一覧に SSLfatal のようなマクロが混ざるため）。
const (
	symbolKindFunction = 12
	symbolKindConstant = 14
)

// uriToPath は file:// URI を OS のパスに直す。
// VSCode は Windows のドライブ文字を %3A でエスケープして送る（file:///c%3A/...）。
func uriToPath(uri string) string {
	p := strings.TrimPrefix(uri, "file://")
	if unescaped, err := url.PathUnescape(p); err == nil {
		p = unescaped
	}
	// file:///C:/... は先頭に余分な / が付く
	if runtime.GOOS == "windows" && len(p) >= 3 && p[0] == '/' && p[2] == ':' {
		p = p[1:]
	}
	return filepath.FromSlash(p)
}

func pathToURI(path string) string {
	p := filepath.ToSlash(path)
	if !strings.HasPrefix(p, "/") {
		p = "/" + p // Windows のドライブパス（C:/...）
	}
	return "file://" + p
}

// wordRange は file の line1 行にある word の範囲。索引は行までしか知らないが、
// 着地点が行全体だとエディタは行をまるごと選択し、移動履歴（Alt+←）にも
// 行全体の選択が残る。語の列まで返せば、着地も履歴もその語になる。
// 行に語が無い（索引が古い等）ときは行全体に落とす。
func wordRange(file string, line1 int, word string) lspRange {
	lines, err := search.CachedLines(file)
	if err != nil || word == "" || line1 < 1 || line1 > len(lines) {
		return lineRange(line1)
	}
	l := strings.TrimSuffix(lines[line1-1], "\r")
	masked := maskNonCode([]string{l})[0]
	re := regexp.MustCompile(`\b` + regexp.QuoteMeta(word) + `\b`)
	m := re.FindStringIndex(masked)
	if m == nil {
		return lineRange(line1)
	}
	return lspRange{
		Start: position{Line: line1 - 1, Character: utf16Len(l[:m[0]])},
		End:   position{Line: line1 - 1, Character: utf16Len(l[:m[1]])},
	}
}

// lineRange は1行全体を指す範囲（1-indexed の行番号から作る）。
// 索引は行までしか知らないので、列は行全体で表す。
func lineRange(line1 int) lspRange {
	l := line1 - 1
	if l < 0 {
		l = 0
	}
	return lspRange{Start: position{Line: l}, End: position{Line: l, Character: 9999}}
}

// wordAtPosition は file の pos にある C 識別子を返す。position の文字位置は
// UTF-16 単位（LSP の既定）なので、バイト位置に直してから識別子を切り出す。
func wordAtPosition(content string, pos position) string {
	lines := strings.Split(content, "\n")
	if pos.Line < 0 || pos.Line >= len(lines) {
		return ""
	}
	line := strings.TrimSuffix(lines[pos.Line], "\r")
	byteOff := 0
	u16 := 0
	for i, r := range line {
		if u16 >= pos.Character {
			byteOff = i
			break
		}
		u16 += len(utf16.Encode([]rune{r}))
		byteOff = i + len(string(r))
	}
	if byteOff > len(line) {
		byteOff = len(line)
	}
	isWord := func(b byte) bool {
		return b == '_' || b >= '0' && b <= '9' || b >= 'a' && b <= 'z' || b >= 'A' && b <= 'Z'
	}
	// カーソルが識別子の直後にある場合も拾う（行末の語で F12 する操作は普通にある）
	if byteOff > 0 && (byteOff >= len(line) || !isWord(line[byteOff])) && isWord(line[byteOff-1]) {
		byteOff--
	}
	if byteOff >= len(line) || !isWord(line[byteOff]) {
		return ""
	}
	start := byteOff
	for start > 0 && isWord(line[start-1]) {
		start--
	}
	end := byteOff
	for end < len(line) && isWord(line[end]) {
		end++
	}
	word := line[start:end]
	// 数値リテラルは識別子ではない
	if word[0] >= '0' && word[0] <= '9' {
		return ""
	}
	return word
}

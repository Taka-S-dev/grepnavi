package lsp

import (
	"encoding/json"
	"strings"

	"grepnavi/search"
)

type foldingRange struct {
	StartLine int    `json:"startLine"`
	EndLine   int    `json:"endLine"`
	Kind      string `json:"kind,omitempty"` // "comment" / "region"
}

// handleFoldingRange は折りたためる範囲を返す: 関数本体、`#if`〜`#endif`、
// 複数行のブロックコメント。関数の範囲は GUI と同じ走査器（search.FunctionRanges）
// で、ブレース深度から取るので `{` の位置に依らない。
func (s *server) handleFoldingRange(raw json.RawMessage) (any, *responseError) {
	var p struct {
		TextDocument struct {
			URI string `json:"uri"`
		} `json:"textDocument"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, &responseError{Code: codeInvalidRequest, Message: err.Error()}
	}
	out := []foldingRange{}
	content, ok := s.documentText(p.TextDocument.URI)
	if !ok {
		return out, nil
	}
	lines := strings.Split(content, "\n")
	for _, fr := range search.FunctionRanges(lines) {
		if fr.End > fr.Start {
			out = append(out, foldingRange{StartLine: fr.Start - 1, EndLine: fr.End - 1, Kind: "region"})
		}
	}
	var stack []int
	inComment := false
	commentStart := 0
	for i, l := range lines {
		t := strings.TrimSpace(l)
		if strings.HasPrefix(t, "#") {
			d := strings.TrimSpace(t[1:])
			switch {
			case strings.HasPrefix(d, "if"):
				stack = append(stack, i)
			case strings.HasPrefix(d, "endif"):
				if n := len(stack); n > 0 {
					start := stack[n-1]
					stack = stack[:n-1]
					if i > start {
						out = append(out, foldingRange{StartLine: start, EndLine: i, Kind: "region"})
					}
				}
			}
		}
		if !inComment {
			if idx := strings.Index(l, "/*"); idx >= 0 && !strings.Contains(l[idx+2:], "*/") {
				inComment = true
				commentStart = i
			}
		} else if strings.Contains(l, "*/") {
			inComment = false
			if i > commentStart {
				out = append(out, foldingRange{StartLine: commentStart, EndLine: i, Kind: "comment"})
			}
		}
	}
	return out, nil
}

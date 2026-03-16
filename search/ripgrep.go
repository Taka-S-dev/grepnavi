package search

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha1"
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
	"strconv"
	"strings"

	"grepnavi/graph"
)

// Options は ripgrep の検索オプション。
type Options struct {
	Pattern      string
	Dir          string
	CaseSensitive bool
	Regex        bool   // false = literal search
	WordRegexp   bool   // --word-regexp
	FileGlob     string // e.g. "*.c" / "*.h"
	ContextLines int    // default 3
	MaxResults   int    // 0 = unlimited
}

// Search は ripgrep を呼び出してマッチ一覧を返す。
// ctx がキャンセルされると rg プロセスも即座に kill される。
func Search(ctx context.Context, opts Options) ([]graph.Match, error) {
	if opts.ContextLines == 0 {
		opts.ContextLines = 3
	}

	args := buildArgs(opts)
	cmd := exec.CommandContext(ctx, "rg", args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return nil, nil // クライアント切断による中断は正常扱い
		}
		// exit code 1 = no matches (not an error)
		if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 1 {
			return nil, nil
		}
		return nil, fmt.Errorf("rg failed: %v\n%s", err, stderr.String())
	}

	return parseOutput(stdout.Bytes(), opts.Pattern, opts.ContextLines)
}

func buildArgs(opts Options) []string {
	args := []string{"--json"}

	if !opts.CaseSensitive {
		args = append(args, "--ignore-case")
	}
	if !opts.Regex {
		args = append(args, "--fixed-strings")
	}
	if opts.WordRegexp {
		args = append(args, "--word-regexp")
	}
	for _, g := range strings.FieldsFunc(opts.FileGlob, func(r rune) bool {
		return r == ' ' || r == ','
	}) {
		args = append(args, "--glob", g)
	}
	args = append(args, "--context", strconv.Itoa(opts.ContextLines))
	if opts.MaxResults > 0 {
		args = append(args, "--max-count", strconv.Itoa(opts.MaxResults))
	}
	args = append(args, "--", opts.Pattern, opts.Dir)
	return args
}

// ripgrep --json の各行は以下のいずれか:
//   {"type":"begin",   "data":{"path":...}}
//   {"type":"context", "data":{"path":...,"line_number":N,"lines":{"text":"..."}}}
//   {"type":"match",   "data":{"path":...,"line_number":N,"lines":{"text":"..."},"submatches":[...]}}
//   {"type":"end",     "data":{...}}
//   {"type":"summary", "data":{...}}

type rgEvent struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

type rgMatchData struct {
	Path       rgText      `json:"path"`
	LineNumber int         `json:"line_number"`
	Lines      rgText      `json:"lines"`
	Submatches []rgSubmatch `json:"submatches"`
}

type rgContextData struct {
	Path       rgText `json:"path"`
	LineNumber int    `json:"line_number"`
	Lines      rgText `json:"lines"`
}

type rgText struct {
	Text string `json:"text"`
}

type rgSubmatch struct {
	Match rgText `json:"match"`
	Start int    `json:"start"`
	End   int    `json:"end"`
}

// pendingMatch はコンテキスト行を蓄積しながら Match を組み立てる。
type pendingMatch struct {
	m       graph.Match
	pending bool // match イベントを受け取り完成待ち
}

func parseOutput(data []byte, query string, ctxLines int) ([]graph.Match, error) {
	var results []graph.Match

	// ファイルごとに context + match イベントをバッファして Match を組み立てる
	var snippetBuf []graph.SnippetLine
	var currentMatch *graph.Match

	flush := func() {
		if currentMatch != nil {
			currentMatch.Snippet = snippetBuf
			results = append(results, *currentMatch)
			currentMatch = nil
			snippetBuf = nil
		}
	}

	scanner := bufio.NewScanner(bytes.NewReader(data))
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		var ev rgEvent
		if err := json.Unmarshal(line, &ev); err != nil {
			continue
		}

		switch ev.Type {
		case "begin":
			flush()

		case "context":
			var d rgContextData
			if err := json.Unmarshal(ev.Data, &d); err != nil {
				continue
			}
			snippetBuf = append(snippetBuf, graph.SnippetLine{
				Line:    d.LineNumber,
				Text:    strings.TrimRight(d.Lines.Text, "\n"),
				IsMatch: false,
			})

		case "match":
			var d rgMatchData
			if err := json.Unmarshal(ev.Data, &d); err != nil {
				continue
			}
			// 直前の pending match を先に flush
			flush()
			col := 1
			if len(d.Submatches) > 0 {
				col = d.Submatches[0].Start + 1
			}
			id := matchID(d.Path.Text, d.LineNumber, col)
			m := graph.Match{
				ID:    id,
				File:  d.Path.Text,
				Line:  d.LineNumber,
				Col:   col,
				Text:  strings.TrimRight(d.Lines.Text, "\n"),
				Query: query,
			}
			// 直前の context 行をスニペットに含める
			snip := make([]graph.SnippetLine, len(snippetBuf))
			copy(snip, snippetBuf)
			snip = append(snip, graph.SnippetLine{
				Line:    d.LineNumber,
				Text:    strings.TrimRight(d.Lines.Text, "\n"),
				IsMatch: true,
			})
			currentMatch = &m
			snippetBuf = snip

		case "end":
			flush()
		}
	}
	flush()

	if err := scanner.Err(); err != nil {
		return results, err
	}
	return results, nil
}

func matchID(file string, line, col int) string {
	h := sha1.New()
	fmt.Fprintf(h, "%s:%d:%d", file, line, col)
	return fmt.Sprintf("%x", h.Sum(nil))[:16]
}

// SearchStream は ripgrep の出力をストリーミングしながら1件ずつ callback に渡す。
// callback が error を返すと中断する（上限到達・クライアント切断など）。
//
// スキャナーgoroutine が rg の stdout を読んで matchCh に push し、
// 呼び出し元goroutine が matchCh から pop して callback を呼ぶ。
// 二つを分離することで、HTTP書き込みが詰まっても rg のパイプが満杯にならない。
func SearchStream(ctx context.Context, opts Options, callback func(graph.Match) error) error {
	if opts.ContextLines == 0 {
		opts.ContextLines = 3
	}

	innerCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	cmd := exec.CommandContext(innerCtx, "rg", buildArgs(opts)...)
	cmd.Stderr = io.Discard
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("rg start failed: %v", err)
	}

	const chanBuf = 512
	matchCh := make(chan graph.Match, chanBuf)
	errCh := make(chan error, 1) // スキャナーgoroutineのエラーをここで受け取る

	go func() {
		defer close(matchCh)
		errCh <- scanRgOutput(innerCtx, stdout, matchCh, opts.Pattern)
	}()

	var cbErr error
	for m := range matchCh {
		if cbErr != nil {
			continue // goroutine が matchCh を close するまで読み捨て
		}
		if err := callback(m); err != nil {
			cbErr = err
			cancel() // scanRgOutput に中断を通知
		}
	}

	_ = cmd.Wait()

	if cbErr != nil {
		return nil // 上限到達・クライアント切断は正常終了扱い
	}
	return <-errCh
}

// scanRgOutput は rg の stdout を JSON パースして matchCh に送る。
// ctx がキャンセルされたら残りの stdout を読み捨てて終了する（rg のパイプ詰まり防止）。
func scanRgOutput(ctx context.Context, stdout io.Reader, matchCh chan<- graph.Match, pattern string) error {
	var snippetBuf []graph.SnippetLine
	var currentMatch *graph.Match
	var cancelled bool

	send := func(m graph.Match) {
		if cancelled {
			return
		}
		select {
		case matchCh <- m:
		case <-ctx.Done():
			cancelled = true
		}
	}

	flush := func() {
		if currentMatch == nil || cancelled {
			return
		}
		currentMatch.Snippet = snippetBuf
		send(*currentMatch)
		currentMatch = nil
		snippetBuf = nil
	}

	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)

	for scanner.Scan() && !cancelled {
		line := scanner.Bytes()
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		var ev rgEvent
		if err := json.Unmarshal(line, &ev); err != nil {
			continue
		}

		switch ev.Type {
		case "begin":
			flush()

		case "context":
			var d rgContextData
			if err := json.Unmarshal(ev.Data, &d); err != nil {
				continue
			}
			snippetBuf = append(snippetBuf, graph.SnippetLine{
				Line:    d.LineNumber,
				Text:    strings.TrimRight(d.Lines.Text, "\n"),
				IsMatch: false,
			})

		case "match":
			var d rgMatchData
			if err := json.Unmarshal(ev.Data, &d); err != nil {
				continue
			}
			flush()
			if cancelled {
				break
			}
			col := 1
			if len(d.Submatches) > 0 {
				col = d.Submatches[0].Start + 1
			}
			id := matchID(d.Path.Text, d.LineNumber, col)
			m := graph.Match{
				ID:    id,
				File:  d.Path.Text,
				Line:  d.LineNumber,
				Col:   col,
				Text:  strings.TrimRight(d.Lines.Text, "\n"),
				Query: pattern,
			}
			snip := make([]graph.SnippetLine, len(snippetBuf))
			copy(snip, snippetBuf)
			snip = append(snip, graph.SnippetLine{
				Line:    d.LineNumber,
				Text:    strings.TrimRight(d.Lines.Text, "\n"),
				IsMatch: true,
			})
			currentMatch = &m
			snippetBuf = snip

		case "end":
			flush()
		}
	}
	flush()

	// 残りの stdout を読み捨てる。
	// cancel() 後も rg がパイプへの書き込みでブロックしている可能性があるため、
	// ここで読み捨てることで rg を終了させ、cmd.Wait() が即座に返るようにする。
	io.Copy(io.Discard, stdout)
	return scanner.Err()
}

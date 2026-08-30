// Package lsp は grepnavi の解析エンジン (search パッケージ) を Language Server
// Protocol で公開する。definition / references / callHierarchy の3系統だけを名乗る
// 最小サーバで、補完や診断は提供しない（LSP は capability 宣言制なので、できる
// ことだけ名乗れば足りる）。
//
// このパッケージは api（HTTP サーバ）・graph・desktop を参照せず、search だけに
// 依存する。配線は main.go の -lsp 分岐1か所のみ。取り外すときはこのディレクトリと
// その分岐を消すだけでよい（desktop パッケージと同じ分離方針）。
//
// プロトコル実装は手書きの最小 JSON-RPC（Content-Length フレーミング）。外部
// 依存を増やさないための選択で、扱うメソッドが少ないうちはこれで十分。
// stdout はプロトコル専用なので、ログは一切 stdout に書かないこと（main.go が
// slog / log を stderr に向けている前提）。
package lsp

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
)

// Serve は stdin/stdout で LSP クライアントと会話する。クライアントが exit を
// 送るか stdin が閉じるまでブロックする。root は -root フラグ由来の既定値で、
// initialize の rootUri があればそちらを優先する（エディタが開いている
// ワークスペースこそが調査対象なので）。
func Serve(root string) error {
	s := newServer(root, bufio.NewReader(os.Stdin), os.Stdout)
	return s.run()
}

func newServer(root string, in *bufio.Reader, out io.Writer) *server {
	return &server{
		root:    root,
		in:      in,
		out:     out,
		docs:    map[string]string{},
		cancels: map[string]context.CancelFunc{},
		sem:     make(chan struct{}, maxInFlight),
	}
}

// maxInFlight は同時に処理する要求の数。エディタはカーソルが動くたびにホバー・
// ハイライト・シグネチャを続けて送るので、直列だと 1 件の遅い索引引きが後続を
// 全部止める。上限を置くのは、大きいファイルのセマンティックトークンのような
// 重い要求が何十も並んで CPU を奪い合わないため。
const maxInFlight = 4

type server struct {
	root string
	in   *bufio.Reader

	outMu sync.Mutex // 応答は 1 件ずつ書く。並行処理でフレームが混ざらないように
	out   io.Writer

	shutdown atomic.Bool

	docsMu sync.RWMutex
	docs   map[string]string // 開いている文書の内容（URI → 全文）。補完が未保存バッファを見るため

	// 処理中の要求の取り消し口（要求 ID → cancel）。$/cancelRequest で引く
	cancelMu sync.Mutex
	cancels  map[string]context.CancelFunc

	sem chan struct{}
	wg  sync.WaitGroup

	// defines は #ifdef の評価に使う構成（initialize の initializationOptions）
	defines map[string]int

	// lensCache は codeLens/resolve の結果（ファイルの mtime と関数名が鍵）。
	// 同じ関数を見えるたびに数え直さない
	lensMu    sync.Mutex
	lensCache map[string]resolvedLens
}

type request struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"` // 数値と文字列の両方が来るので生のまま持つ
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type responseError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

const (
	codeMethodNotFound = -32601
	codeInvalidRequest = -32600
)

// codeRequestCancelled は LSP が取り消された要求に返すエラーコード。
const codeRequestCancelled = -32800

func (s *server) run() error {
	defer s.wg.Wait()
	for {
		req, err := s.readMessage()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		if req.Method == "exit" {
			return nil
		}
		// 通知（ID なし）には応答しない。文書の開閉・変更は読み取りループで
		// 順に反映する: 後から来た要求は必ず反映後の文書を見る。取り消しも
		// ここで受ける（要求の goroutine が待っている間に届く必要がある）。
		if req.ID == nil {
			switch req.Method {
			case "textDocument/didOpen":
				s.publishInactive(s.handleDidOpen(req.Params))
			case "textDocument/didChange":
				s.publishInactive(s.handleDidChange(req.Params))
			case "textDocument/didClose":
				s.handleDidClose(req.Params)
			case "$/cancelRequest":
				s.cancelRequest(req.Params)
			}
			continue
		}
		// initialize と shutdown は順序が意味を持つので、その場で答える。
		// shutdown は処理中の要求を終えてから: 先に旗を立てると、直前に
		// 受け付けた要求が「shutting down」で落ちる
		if req.Method == "initialize" || req.Method == "shutdown" {
			if req.Method == "shutdown" {
				s.wg.Wait()
			}
			result, rerr := s.dispatch(context.Background(), req)
			if err := s.reply(req.ID, result, rerr); err != nil {
				return err
			}
			continue
		}
		s.wg.Add(1)
		go s.serveRequest(req)
	}
}

// serveRequest は 1 件の要求を自分の goroutine で処理する。取り消されたら
// 結果を捨てて RequestCancelled を返す（エディタは応答が無いと待ち続ける）。
func (s *server) serveRequest(req *request) {
	defer s.wg.Done()
	ctx, cancel := context.WithCancel(context.Background())
	key := string(req.ID)
	s.cancelMu.Lock()
	s.cancels[key] = cancel
	s.cancelMu.Unlock()
	defer func() {
		s.cancelMu.Lock()
		delete(s.cancels, key)
		s.cancelMu.Unlock()
		cancel()
	}()

	// 待っている間に取り消されたら、処理を始めない
	select {
	case s.sem <- struct{}{}:
	case <-ctx.Done():
		_ = s.reply(req.ID, nil, &responseError{Code: codeRequestCancelled, Message: "request cancelled"})
		return
	}
	defer func() { <-s.sem }()

	result, rerr := s.dispatch(ctx, req)
	if ctx.Err() != nil {
		result, rerr = nil, &responseError{Code: codeRequestCancelled, Message: "request cancelled"}
	}
	_ = s.reply(req.ID, result, rerr)
}

// cancelRequest は $/cancelRequest 通知を受けて、その ID の要求を取り消す。
// 既に終わった要求や知らない ID は無視する（通知なので応答も無い）。
func (s *server) cancelRequest(raw json.RawMessage) {
	var p struct {
		ID json.RawMessage `json:"id"`
	}
	if json.Unmarshal(raw, &p) != nil || p.ID == nil {
		return
	}
	s.cancelMu.Lock()
	cancel := s.cancels[string(p.ID)]
	s.cancelMu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (s *server) dispatch(ctx context.Context, req *request) (any, *responseError) {
	if s.shutdown.Load() && req.Method != "exit" {
		return nil, &responseError{Code: codeInvalidRequest, Message: "server is shutting down"}
	}
	switch req.Method {
	case "initialize":
		return s.handleInitialize(req.Params), nil
	case "shutdown":
		s.shutdown.Store(true)
		return nil, nil
	case "textDocument/definition":
		return s.handleDefinition(ctx, req.Params)
	case "textDocument/references":
		return s.handleReferences(ctx, req.Params)
	case "textDocument/hover":
		return s.handleHover(ctx, req.Params)
	case "textDocument/documentHighlight":
		return s.handleDocumentHighlight(ctx, req.Params)
	case "textDocument/signatureHelp":
		return s.handleSignatureHelp(ctx, req.Params)
	case "textDocument/typeDefinition":
		return s.handleTypeDefinition(ctx, req.Params)
	case "textDocument/implementation":
		return s.handleImplementation(ctx, req.Params)
	case "textDocument/foldingRange":
		return s.handleFoldingRange(ctx, req.Params)
	case "textDocument/codeLens":
		return s.handleCodeLens(ctx, req.Params)
	case "codeLens/resolve":
		return s.handleCodeLensResolve(ctx, req.Params)
	case "textDocument/completion":
		return s.handleCompletion(ctx, req.Params)
	case "textDocument/documentSymbol":
		return s.handleDocumentSymbol(ctx, req.Params)
	case "workspace/symbol":
		return s.handleWorkspaceSymbol(ctx, req.Params)
	case "textDocument/semanticTokens/full":
		return s.handleSemanticTokensFull(ctx, req.Params)
	case "textDocument/prepareCallHierarchy":
		return s.handlePrepareCallHierarchy(ctx, req.Params)
	case "callHierarchy/incomingCalls":
		return s.handleIncomingCalls(ctx, req.Params)
	case "callHierarchy/outgoingCalls":
		return s.handleOutgoingCalls(ctx, req.Params)
	default:
		return nil, &responseError{Code: codeMethodNotFound, Message: "unsupported method: " + req.Method}
	}
}

// readMessage は Content-Length ヘッダ + 空行 + JSON 本文を1件読む。
func (s *server) readMessage() (*request, error) {
	length := -1
	for {
		line, err := s.in.ReadString('\n')
		if err != nil {
			return nil, err
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			break // ヘッダ終わり
		}
		if v, ok := strings.CutPrefix(line, "Content-Length:"); ok {
			n, err := strconv.Atoi(strings.TrimSpace(v))
			if err != nil {
				return nil, fmt.Errorf("bad Content-Length: %w", err)
			}
			length = n
		}
	}
	if length < 0 {
		return nil, fmt.Errorf("missing Content-Length header")
	}
	body := make([]byte, length)
	if _, err := io.ReadFull(s.in, body); err != nil {
		return nil, err
	}
	var req request
	if err := json.Unmarshal(body, &req); err != nil {
		return nil, fmt.Errorf("bad request body: %w", err)
	}
	return &req, nil
}

func (s *server) reply(id json.RawMessage, result any, rerr *responseError) error {
	msg := map[string]any{"jsonrpc": "2.0", "id": id}
	if rerr != nil {
		msg["error"] = rerr
	} else {
		// LSP は「結果なし」を null で表す（フィールド省略は不可）
		msg["result"] = result
	}
	body, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	s.outMu.Lock()
	defer s.outMu.Unlock()
	_, err = fmt.Fprintf(s.out, "Content-Length: %d\r\n\r\n%s", len(body), body)
	return err
}

// notify はサーバ発の通知（ID なし）を送る。
func (s *server) notify(method string, params any) error {
	body, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "method": method, "params": params})
	if err != nil {
		return err
	}
	s.outMu.Lock()
	defer s.outMu.Unlock()
	_, err = fmt.Fprintf(s.out, "Content-Length: %d\r\n\r\n%s", len(body), body)
	return err
}

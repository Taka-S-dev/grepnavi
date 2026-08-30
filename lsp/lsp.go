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
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
)

// Serve は stdin/stdout で LSP クライアントと会話する。クライアントが exit を
// 送るか stdin が閉じるまでブロックする。root は -root フラグ由来の既定値で、
// initialize の rootUri があればそちらを優先する（エディタが開いている
// ワークスペースこそが調査対象なので）。
func Serve(root string) error {
	s := &server{root: root, in: bufio.NewReader(os.Stdin), out: os.Stdout, docs: map[string]string{}}
	return s.run()
}

type server struct {
	root     string
	in       *bufio.Reader
	out      io.Writer
	shutdown bool
	docs     map[string]string // 開いている文書の内容（URI → 全文）。補完が未保存バッファを見るため
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

func (s *server) run() error {
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
		// 通知（ID なし）には応答しない。文書の開閉・変更だけは追う（補完が
		// 未保存バッファを見るため）。他の通知は無視してよい。
		if req.ID == nil {
			switch req.Method {
			case "textDocument/didOpen":
				s.handleDidOpen(req.Params)
			case "textDocument/didChange":
				s.handleDidChange(req.Params)
			case "textDocument/didClose":
				s.handleDidClose(req.Params)
			}
			continue
		}
		result, rerr := s.dispatch(req)
		if err := s.reply(req.ID, result, rerr); err != nil {
			return err
		}
	}
}

func (s *server) dispatch(req *request) (any, *responseError) {
	if s.shutdown && req.Method != "exit" {
		return nil, &responseError{Code: codeInvalidRequest, Message: "server is shutting down"}
	}
	switch req.Method {
	case "initialize":
		return s.handleInitialize(req.Params), nil
	case "shutdown":
		s.shutdown = true
		return nil, nil
	case "textDocument/definition":
		return s.handleDefinition(req.Params)
	case "textDocument/references":
		return s.handleReferences(req.Params)
	case "textDocument/hover":
		return s.handleHover(req.Params)
	case "textDocument/documentHighlight":
		return s.handleDocumentHighlight(req.Params)
	case "textDocument/signatureHelp":
		return s.handleSignatureHelp(req.Params)
	case "textDocument/typeDefinition":
		return s.handleTypeDefinition(req.Params)
	case "textDocument/implementation":
		return s.handleImplementation(req.Params)
	case "textDocument/foldingRange":
		return s.handleFoldingRange(req.Params)
	case "textDocument/completion":
		return s.handleCompletion(req.Params)
	case "textDocument/documentSymbol":
		return s.handleDocumentSymbol(req.Params)
	case "workspace/symbol":
		return s.handleWorkspaceSymbol(req.Params)
	case "textDocument/semanticTokens/full":
		return s.handleSemanticTokensFull(req.Params)
	case "textDocument/prepareCallHierarchy":
		return s.handlePrepareCallHierarchy(req.Params)
	case "callHierarchy/incomingCalls":
		return s.handleIncomingCalls(req.Params)
	case "callHierarchy/outgoingCalls":
		return s.handleOutgoingCalls(req.Params)
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
	_, err = fmt.Fprintf(s.out, "Content-Length: %d\r\n\r\n%s", len(body), body)
	return err
}

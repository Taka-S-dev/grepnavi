package api

// デバッグ仕込み API。操作対象は grepnavi が記録している挿入行のみで、
// 任意ファイル書き込みの口は作らない。-host で LAN に公開している場合は
// EnableFileWrites が呼ばれず、全エンドポイントが 403 を返す。

import (
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"grepnavi/graph"
	"grepnavi/patch"
	"grepnavi/search"
)

// EnableFileWrites はファイル書き換えを伴う挿入系APIを有効にする。
// loopback バインド時にのみ server.go から呼ばれる想定。
func (h *Handler) EnableFileWrites() { h.fileWrites = true }

// errRecordedLineModified は「記録行の照合に失敗し、完全一致するの行も
// ちょうど1行に絞れなかった」ことを表す。0件・複数件のどちらも同じ扱い
// （もっともらしく間違えるより止まる方を選ぶ）。
var errRecordedLineModified = errors.New("insertion: recorded line no longer matches")

// resolveWithinRoot は file を root 基準の絶対パスへ解決し、root の外を
// filepath.Rel で弾く。操作対象を「記録済み挿入行を持つファイル」に限定する
// 一次関門で、ここを抜けても実際に触るのは記録済みの行だけ。
func (h *Handler) resolveWithinRoot(file string) (string, bool) {
	abs := h.absFromRoot(file)
	h.mu.RLock()
	root := h.root
	h.mu.RUnlock()
	rel, err := filepath.Rel(root, abs)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", false
	}
	return abs, true
}

func writeModifiedConflict(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusConflict)
	json.NewEncoder(w).Encode(map[string]string{"status": "modified"})
}

// patchErrStatus は patch パッケージのセンチネルエラーを対応する HTTP ステータスへ写す。
func patchErrStatus(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, patch.ErrUnsupportedEncoding):
		jsonErr(w, err.Error(), http.StatusUnsupportedMediaType)
	case errors.Is(err, patch.ErrUnencodable):
		jsonErr(w, err.Error(), http.StatusUnprocessableEntity)
	case errors.Is(err, patch.ErrMismatch), errors.Is(err, errRecordedLineModified):
		writeModifiedConflict(w)
	default:
		jsonErr(w, err.Error(), http.StatusInternalServerError)
	}
}

// findInsertion は現在の Insertions からID一致のものを1件返す。
func (h *Handler) findInsertion(id string) (graph.Insertion, bool) {
	for _, ins := range h.store.GetGraphResponse().Insertions {
		if ins.ID == id {
			return ins, true
		}
	}
	return graph.Insertion{}, false
}

// --- POST /api/insertions ---

func (h *Handler) handleInsertions(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	if !h.fileWrites {
		jsonErr(w, "file writes disabled (bind to loopback to enable)", http.StatusForbidden)
		return
	}
	var req struct {
		File  string   `json:"file"`
		Line  int      `json:"line"`
		Lines []string `json:"lines"`
		Group string   `json:"group"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonErr(w, err.Error(), http.StatusBadRequest)
		return
	}
	if len(req.Lines) == 0 {
		jsonErr(w, "lines required", http.StatusBadRequest)
		return
	}
	req.Group = strings.TrimSpace(req.Group)
	if strings.ContainsAny(req.Group, "\n\r") || len(req.Group) > 120 {
		jsonErr(w, "invalid group name", http.StatusBadRequest)
		return
	}
	for _, l := range req.Lines {
		if strings.ContainsAny(l, "\n\r") {
			// 改行を含む要素は1サイトが複数物理行になり、記録行数と
			// ShiftLines の delta がずれる。ずれた記録行は二度と CachedLines
			// の1行と完全一致しなくなり、以後 DELETE が永久に409で失敗する。
			jsonErr(w, "lines must not contain newline characters", http.StatusBadRequest)
			return
		}
	}
	abs, ok := h.resolveWithinRoot(req.File)
	if !ok {
		jsonErr(w, "file outside root", http.StatusForbidden)
		return
	}

	// NextInsertionTag の採番から AddInsertion までを1つの臨界区間として
	// 直列化する。ここを跨いで別リクエストが割り込むと、タグの重複や
	// ShiftLines の対象取り違えが起きる。
	h.insMu.Lock()
	defer h.insMu.Unlock()

	// {tag} は挿入した仕込みを後から目視・grep で見分けるための連番。
	// 採番は保存前 (NextInsertionTag は既存 Insertions の最大値+1) なので、
	// この挿入自体がまだ登録されていない時点でも重複しない。
	tag := h.store.NextInsertionTag()
	lines := make([]string, len(req.Lines))
	for i, l := range req.Lines {
		lines[i] = strings.ReplaceAll(l, "{tag}", tag)
		// {group} を実行出力にも埋め込めば、どのグループの仕込みが発火したか
		// プログラムの出力からも判別できる。
		lines[i] = strings.ReplaceAll(lines[i], "{group}", req.Group)
	}

	pf, err := patch.Load(abs)
	if err != nil {
		patchErrStatus(w, err)
		return
	}
	if err := pf.InsertAfter(req.Line, lines); err != nil {
		patchErrStatus(w, err)
		return
	}
	if err := pf.Save(); err != nil {
		jsonErr(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// ShiftLines は必ず AddInsertion より先に呼ぶ: 後で呼ぶと、たった今
	// 追加したこの仕込み自身の sites まで二重にシフトされてしまう
	// （ShiftLines は対象ファイルの全 Insertions を対象にするため）。
	shift := h.store.ShiftLines(abs, req.Line+1, len(lines))

	sites := make([]graph.InsertionSite, len(lines))
	for i, l := range lines {
		sites[i] = graph.InsertionSite{Line: req.Line + 1 + i, Text: l}
	}
	ins := graph.Insertion{ID: tag, File: abs, Sites: sites, Group: req.Group, Enabled: true, CreatedAt: time.Now()}
	if err := h.store.AddInsertion(ins); err != nil {
		jsonErr(w, err.Error(), http.StatusInternalServerError)
		return
	}

	jsonOK(w, map[string]any{"insertion": ins, "shift": shift})
}

// --- DELETE, PUT /api/insertions/{id} ---

func (h *Handler) handleInsertionByID(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/insertions/")
	if id == "" || strings.Contains(id, "/") {
		http.NotFound(w, r)
		return
	}
	if !h.fileWrites {
		jsonErr(w, "file writes disabled (bind to loopback to enable)", http.StatusForbidden)
		return
	}
	switch r.Method {
	case http.MethodDelete:
		h.deleteInsertionByID(w, id)
	case http.MethodPut:
		h.putInsertionByID(w, r, id)
	default:
		http.Error(w, "PUT/DELETE only", http.StatusMethodNotAllowed)
	}
}

func (h *Handler) deleteInsertionByID(w http.ResponseWriter, id string) {
	// findInsertion の読み出しから RemoveInsertion までを1つの臨界区間として
	// 直列化する（ファイルの read-modify-write と store 更新をまたぐため）。
	h.insMu.Lock()
	defer h.insMu.Unlock()

	ins, ok := h.findInsertion(id)
	if !ok {
		jsonErr(w, "insertion not found", http.StatusNotFound)
		return
	}
	shifts, err := h.deleteInsertionSites(ins)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			// ファイルごと消えている: ディスク側に splice する対象が無いので、
			// 記録の削除だけを成功として扱う（仕様「ファイルなし → 記録の削除のみ可能」）。
			if err := h.store.RemoveInsertion(id); err != nil {
				jsonErr(w, err.Error(), http.StatusInternalServerError)
				return
			}
			jsonOK(w, map[string]any{"shifts": []graph.ShiftResult{}})
			return
		}
		// ErrUnsupportedEncoding→415 / ErrMismatch・errRecordedLineModified→409
		// など、POST/PUT と同じマッピングを通す（以前は一律500にしていた）。
		patchErrStatus(w, err)
		return
	}
	if err := h.store.RemoveInsertion(id); err != nil {
		jsonErr(w, err.Error(), http.StatusInternalServerError)
		return
	}
	jsonOK(w, map[string]any{"shifts": shifts})
}

func (h *Handler) putInsertionByID(w http.ResponseWriter, r *http.Request, id string) {
	var req struct {
		Site    int    `json:"site"`
		NewText string `json:"new_text"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonErr(w, err.Error(), http.StatusBadRequest)
		return
	}
	if strings.ContainsAny(req.NewText, "\n\r") {
		// POST と同じ理由: 改行混入は記録行数とファイルの実行数をずらし、
		// 以後の照合を永久に破綻させる。
		jsonErr(w, "lines must not contain newline characters", http.StatusBadRequest)
		return
	}

	// 位置解決 (resolveSitePosition) から UpdateInsertion までを直列化する。
	h.insMu.Lock()
	defer h.insMu.Unlock()

	ins, ok := h.findInsertion(id)
	if !ok {
		jsonErr(w, "insertion not found", http.StatusNotFound)
		return
	}
	if req.Site < 0 || req.Site >= len(ins.Sites) {
		jsonErr(w, "site index out of range", http.StatusBadRequest)
		return
	}
	site := ins.Sites[req.Site]

	pf, err := patch.Load(ins.File)
	if err != nil {
		patchErrStatus(w, err)
		return
	}
	line, err := resolveSitePosition(pf, ins.File, site)
	if err != nil {
		patchErrStatus(w, err)
		return
	}
	if err := pf.ReplaceLine(line, site.Text, req.NewText); err != nil {
		patchErrStatus(w, err)
		return
	}
	if err := pf.Save(); err != nil {
		jsonErr(w, err.Error(), http.StatusInternalServerError)
		return
	}

	var updated graph.Insertion
	err = h.store.UpdateInsertion(id, func(u *graph.Insertion) {
		u.Sites[req.Site].Line = line
		u.Sites[req.Site].Text = req.NewText
		updated = *u
	})
	if err != nil {
		jsonErr(w, err.Error(), http.StatusInternalServerError)
		return
	}
	jsonOK(w, map[string]any{"insertion": updated})
}

// --- POST /api/insertions/removeall ---

type skippedInsertion struct {
	ID     string `json:"id"`
	Reason string `json:"reason"`
}

func (h *Handler) handleInsertionsRemoveAll(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	if !h.fileWrites {
		jsonErr(w, "file writes disabled (bind to loopback to enable)", http.StatusForbidden)
		return
	}

	// group フィルタ: nil = 全部（従来挙動）、"" = 無グループのみ、"x" = そのグループのみ。
	// ポインタなのは「フィールド省略」と「空文字指定」を区別するため。
	var req struct {
		Group *string `json:"group"`
	}
	json.NewDecoder(r.Body).Decode(&req) // 空 body = 全部対象

	// GetGraphResponse の読み出しから各 RemoveInsertion までを直列化する
	// （他の挿入系APIと衝突すると読み出した一覧がその場で古くなる）。
	h.insMu.Lock()
	defer h.insMu.Unlock()

	all := h.store.GetGraphResponse().Insertions
	byFile := map[string][]string{} // file -> ids, ファイル毎にまとめて処理順を作る
	for _, ins := range all {
		if req.Group != nil && ins.Group != *req.Group {
			continue
		}
		byFile[ins.File] = append(byFile[ins.File], ins.ID)
	}

	removed := []string{}
	skipped := []skippedInsertion{}
	shifts := []graph.ShiftResult{}
	for _, ids := range byFile {
		// ファイル内では記録行の降順に処理する（下から消せば上の記録行が崩れない）。
		sort.Slice(ids, func(a, b int) bool {
			ia, _ := h.findInsertion(ids[a])
			ib, _ := h.findInsertion(ids[b])
			return maxSiteLine(ia) > maxSiteLine(ib)
		})
		for _, id := range ids {
			// 直前の削除がこのファイルの他の仕込みの行番号もシフトしている
			// ため、ループの都度ストアから引き直す（キャッシュした行番号は使わない）。
			ins, ok := h.findInsertion(id)
			if !ok {
				continue
			}
			siteShifts, err := h.deleteInsertionSites(ins)
			if err != nil {
				if errors.Is(err, fs.ErrNotExist) {
					// ファイルごと消えている: 記録の削除だけを成功として扱う (DELETE と同じ規約)。
					if err := h.store.RemoveInsertion(id); err != nil {
						skipped = append(skipped, skippedInsertion{ID: id, Reason: err.Error()})
						continue
					}
					removed = append(removed, id)
					continue
				}
				skipped = append(skipped, skippedInsertion{ID: id, Reason: err.Error()})
				continue
			}
			if err := h.store.RemoveInsertion(id); err != nil {
				skipped = append(skipped, skippedInsertion{ID: id, Reason: err.Error()})
				continue
			}
			removed = append(removed, id)
			shifts = append(shifts, siteShifts...)
		}
	}
	jsonOK(w, map[string]any{"removed": removed, "skipped": skipped, "shifts": shifts})
}

func maxSiteLine(ins graph.Insertion) int {
	max := 0
	for _, s := range ins.Sites {
		if s.Line > max {
			max = s.Line
		}
	}
	return max
}

// --- 共通ロジック ---

// resolveSitePosition は site が今どの行にあるかを決める。記録行がそのまま
// 一致すればそこ。ずれていれば記録テキストとの完全一致行をファイル全体
// から探し、ちょうど1行に絞れたときだけそこを使う（0件・複数件は
// もっともらしく当てるより止まる方を選ぶ）。
func resolveSitePosition(pf *patch.File, abs string, site graph.InsertionSite) (int, error) {
	if text, ok := pf.LineUTF8(site.Line); ok && text == site.Text {
		return site.Line, nil
	}
	lines, err := search.CachedLines(abs)
	if err != nil {
		return 0, err
	}
	line, found := 0, 0
	for i, l := range lines {
		if l == site.Text { // 完全一致。トリムしない (記録どおりのインデントのはず)
			found++
			line = i + 1
		}
	}
	if found != 1 {
		return 0, errRecordedLineModified
	}
	return line, nil
}

// deleteInsertionSites は ins の全 sites を撤去し、site ごとの ShiftResult を
// 適用順 (行番号降順) のまま返す。まず全 sites の現在位置を確定させてから
// 一括で Save することで、途中の site で不一致が起きても部分削除にならない
// （verify-then-apply）。1つに畳んだ ShiftResult は複数キーが同じ移動先へ
// 収束した場合にクライアントが順序を知らないと再現できないため、
// removeall と同じ「順序付きリスト」の形で返す（畳み込みはしない）。
func (h *Handler) deleteInsertionSites(ins graph.Insertion) ([]graph.ShiftResult, error) {
	pf, err := patch.Load(ins.File)
	if err != nil {
		return nil, err
	}

	type sitePos struct {
		line int
		text string
	}
	positions := make([]sitePos, len(ins.Sites))
	for i, site := range ins.Sites {
		line, err := resolveSitePosition(pf, ins.File, site)
		if err != nil {
			return nil, err
		}
		positions[i] = sitePos{line: line, text: site.Text}
	}
	// 降順で消す: 複数 sites (Plan 2 の囲みペア) でも、上の行番号を崩さない。
	sort.Slice(positions, func(a, b int) bool { return positions[a].line > positions[b].line })

	for _, p := range positions {
		if err := pf.DeleteLine(p.line, p.text); err != nil {
			return nil, err
		}
	}
	if err := pf.Save(); err != nil {
		return nil, err
	}

	shifts := make([]graph.ShiftResult, 0, len(positions))
	for _, p := range positions {
		shifts = append(shifts, h.store.ShiftLines(ins.File, p.line+1, -1))
	}
	return shifts, nil
}

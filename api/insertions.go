package api

// デバッグ仕込み API。操作対象は grepnavi が記録している挿入行のみで、
// 任意ファイル書き込みの口は作らない。-host で LAN に公開している場合は
// EnableFileWrites が呼ばれず、全エンドポイントが 403 を返す。

import (
	"encoding/json"
	"errors"
	"fmt"
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

// saveFile は書き換えたソースを保存し、書き換えに伴う後始末をする。
// 挿入系の保存は必ずここを通す（保存経路が増えても後始末を忘れないため）。
//
// 定義・ホバー・参照のキャッシュは file:line をそのまま持っているので、行が
// ずれた後も古い位置を返し続ける。索引を作り直したときは捨てているのに、自分で
// 書き換えたときに捨てないのは筋が通らない。捨てれば次の問い合わせで現在の
// ファイルに合わせて位置を取り直せる。
func (h *Handler) saveFile(pf *patch.File) error {
	if err := pf.Save(); err != nil {
		return err
	}
	defCacheClear()
	hoverCacheClear()
	search.ClearResultCaches()
	return nil
}

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

// normalizeGroup はグループ名を正規化して妥当性を検証する (挿入・囲み・付け替えで共通)。
// 改行はグラフ JSON 上は表現できても UI の1行チップ表示を壊すので弾く。
func normalizeGroup(g string) (string, bool) {
	g = strings.TrimSpace(g)
	if strings.ContainsAny(g, "\n\r") || len(g) > 120 {
		return "", false
	}
	return g, true
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
	group, ok := normalizeGroup(req.Group)
	if !ok {
		jsonErr(w, "invalid group name", http.StatusBadRequest)
		return
	}
	req.Group = group
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
	if err := h.saveFile(pf); err != nil {
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
	shifts, undo, err := h.deleteInsertionSites(ins)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			// ファイルごと消えている: ディスク側に splice する対象が無いので、
			// 記録の削除だけを成功として扱う（仕様「ファイルなし → 記録の削除のみ可能」）。
			if err := h.store.RemoveInsertion(id); err != nil {
				jsonErr(w, err.Error(), http.StatusInternalServerError)
				return
			}
			h.lastRemoved = nil // 戻す先のファイルが無い
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
	h.lastRemoved = undo
	jsonOK(w, map[string]any{"shifts": shifts})
}

// removedInsertion は撤去1件を戻すための控え。lines は撤去直後のファイル行数で、
// 戻す前に一致を確かめる — 行数が変わっていれば sites の行番号はもう元の位置を
// 指しておらず、戻すと関係ない場所へ紛れ込む。
type removedInsertion struct {
	ins   graph.Insertion
	lines int
}

// --- POST /api/insertions/restore ---

// handleInsertionsRestore は直前の1件撤去を戻す (ブラウザの Ctrl+Z)。撤去の逆操作に
// 徹していて、同じ ID・同じ本文を消した行へ戻す。挿入 API で入れ直すのでは代わりに
// ならない: 採番が変わり、本文に焼き込まれた {tag} 置換後の ID と食い違う。
// 戻せるのは常に直前の1件だけで、履歴スタックは持たない。
func (h *Handler) handleInsertionsRestore(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	if !h.fileWrites {
		jsonErr(w, "file writes disabled (bind to loopback to enable)", http.StatusForbidden)
		return
	}

	h.insMu.Lock()
	defer h.insMu.Unlock()

	last := h.lastRemoved
	if last == nil {
		jsonErr(w, "no removal to restore", http.StatusNotFound)
		return
	}
	// 戻せなかった控えも捨てる。残しても次の Ctrl+Z が同じ理由で失敗するだけで、
	// その間ずっとグラフ側の undo を奪い続ける。
	h.lastRemoved = nil

	if _, ok := h.resolveWithinRoot(last.ins.File); !ok {
		// プロジェクトを切り替えた後。戻す先がもう今の root の外にある。
		jsonErr(w, "file outside root", http.StatusForbidden)
		return
	}
	if _, exists := h.findInsertion(last.ins.ID); exists {
		// 撤去した後に同じ ID が再採番された (NextInsertionTag は最大+1 なので、
		// 末尾の1件を撤去した直後の挿入がこれに当たる)。
		jsonErr(w, "id already in use", http.StatusConflict)
		return
	}

	pf, err := patch.Load(last.ins.File)
	if err != nil {
		patchErrStatus(w, err)
		return
	}
	if pf.LineCount() != last.lines {
		jsonErr(w, "file changed since the removal", http.StatusConflict)
		return
	}

	sites := append([]graph.InsertionSite(nil), last.ins.Sites...)
	// 昇順に戻す: 上の行から順に入れれば、下の site の行番号は「自分より上が
	// 戻り終わった後の位置」としてそのまま使える (撤去が降順なのの裏返し)。
	sort.Slice(sites, func(a, b int) bool { return sites[a].Line < sites[b].Line })
	hadFinalNewline := pf.EndsWithNewline()
	for _, site := range sites {
		if err := pf.InsertAfter(site.Line-1, []string{site.Text}); err != nil {
			patchErrStatus(w, err)
			return
		}
	}
	pf.SetFinalNewline(hadFinalNewline)
	if err := h.saveFile(pf); err != nil {
		jsonErr(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// ShiftLines は AddInsertion より先に (挿入 API と同じ理由: 後だと戻したばかりの
	// この記録自身の sites まで押し下げてしまう)。
	shifts := make([]graph.ShiftResult, 0, len(sites))
	for _, site := range sites {
		shifts = append(shifts, h.store.ShiftLines(last.ins.File, site.Line, 1))
	}
	restored := last.ins
	restored.Sites = sites
	if err := h.store.AddInsertion(restored); err != nil {
		jsonErr(w, err.Error(), http.StatusInternalServerError)
		return
	}
	jsonOK(w, map[string]any{"insertion": restored, "shifts": shifts})
}

func (h *Handler) putInsertionByID(w http.ResponseWriter, r *http.Request, id string) {
	// lines を送ると「このデバッグ行の全行を差し替える」(行数が変わってよい)。
	// site + new_text は従来どおり1行だけの置き換えで、行数は変わらない。
	// 囲みのように site が離れているレコードは前者を使えないので、後者が残る。
	var req struct {
		Site    int      `json:"site"`
		NewText string   `json:"new_text"`
		Lines   []string `json:"lines"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonErr(w, err.Error(), http.StatusBadRequest)
		return
	}
	texts := req.Lines
	if texts == nil {
		texts = []string{req.NewText}
	}
	if len(texts) == 0 {
		jsonErr(w, "lines required", http.StatusBadRequest)
		return
	}
	for _, l := range texts {
		if strings.ContainsAny(l, "\n\r") {
			// POST と同じ理由: 改行混入は記録行数とファイルの実行数をずらし、
			// 以後の照合を永久に破綻させる。
			jsonErr(w, "lines must not contain newline characters", http.StatusBadRequest)
			return
		}
	}

	// 位置解決 (resolveSitePosition) から UpdateInsertion までを直列化する。
	h.insMu.Lock()
	defer h.insMu.Unlock()

	ins, ok := h.findInsertion(id)
	if !ok {
		jsonErr(w, "insertion not found", http.StatusNotFound)
		return
	}
	if req.Lines != nil {
		h.replaceInsertionBlock(w, ins, req.Lines)
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
	if err := h.saveFile(pf); err != nil {
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

// errSitesNotContiguous は「レコードの行が連続していないので塊として置き換え
// られない」ことを表す。囲み (#if 0 / #endif) は間に対象コードを挟むため必ず
// これに当たる。丸ごと置き換えると #endif を消してしまうので、構造として弾く。
var errSitesNotContiguous = errors.New("insertion: sites are not contiguous")

// isWrapRecord は「対象コードを挟む囲み」かを判定する。
//
// Kind はこの判定を入れた後に作られた記録にしか無いので、それより前の囲みは
// ガード行の形から見分ける（生成時の形は決まっており、OFF 中は行頭にコメント
// 記号が付く）。誤って囲みでないと見なすとガードを消してしまうのに対し、
// 逆の誤りは「まとめて書き換えられない」だけなので、片方でも当たれば囲み扱いにする。
func isWrapRecord(ins graph.Insertion) bool {
	if ins.Kind == graph.InsertionKindWrap {
		return true
	}
	if len(ins.Sites) != 2 {
		return false
	}
	guard := func(text, prefix string) bool {
		t := strings.TrimSpace(text)
		t = strings.TrimSpace(strings.TrimPrefix(t, disableMarker))
		return strings.HasPrefix(t, prefix)
	}
	return guard(ins.Sites[0].Text, "#if 0") || guard(ins.Sites[1].Text, "#endif")
}

// replaceInsertionBlock はデバッグ行の全行を lines で置き換える。行数が変わって
// よい点が site 単位の書き換えとの違いで、1行を数行に育てたり、複数行で撒いた
// 塊をまとめて直したりできる。
//
// 手順は挿入・撤去と同じ verify-then-apply: 先に全 site の現在位置を確定させ、
// 途中で不一致が出たらファイルには触らない。適用は「降順に消してから元の位置へ
// 挿入」で、既存バイトを書き換えない byte-splice の性質を保つ。
func (h *Handler) replaceInsertionBlock(w http.ResponseWriter, ins graph.Insertion, lines []string) {
	if len(ins.Sites) == 0 {
		// 記録が壊れている (手で編集した project JSON など)。置き換える対象が
		// 無いので、位置を求める前に断る。
		jsonErr(w, "insertion has no sites", http.StatusBadRequest)
		return
	}
	if isWrapRecord(ins) {
		// 囲みは #if 0 と #endif で対象コードを挟む。丸ごと置き換えると
		// #endif が消えて囲みが壊れる。行が連続していても (中身を手で消した
		// 場合など) 種類で断る。
		jsonErr(w, errSitesNotContiguous.Error(), http.StatusBadRequest)
		return
	}
	pf, err := patch.Load(ins.File)
	if err != nil {
		patchErrStatus(w, err)
		return
	}
	type sitePos struct {
		line int
		text string
	}
	positions := make([]sitePos, len(ins.Sites))
	for i, s := range ins.Sites {
		line, err := resolveSitePosition(pf, ins.File, s)
		if err != nil {
			patchErrStatus(w, err)
			return
		}
		positions[i] = sitePos{line: line, text: s.Text}
	}
	sort.Slice(positions, func(a, b int) bool { return positions[a].line < positions[b].line })
	for i, p := range positions {
		if p.line != positions[0].line+i {
			jsonErr(w, errSitesNotContiguous.Error(), http.StatusBadRequest)
			return
		}
	}

	// 末尾の行を消して足し直すと終端の有無が前後の行へ移るので、控えて戻す。
	hadFinalNewline := pf.EndsWithNewline()
	start, n, m := positions[0].line, len(positions), len(lines)
	for i := n - 1; i >= 0; i-- { // 降順に消せば、まだ消していない行の番号が崩れない
		if err := pf.DeleteLine(positions[i].line, positions[i].text); err != nil {
			patchErrStatus(w, err)
			return
		}
	}
	if err := pf.InsertAfter(start-1, lines); err != nil {
		patchErrStatus(w, err)
		return
	}
	pf.SetFinalNewline(hadFinalNewline)
	if err := h.saveFile(pf); err != nil {
		jsonErr(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// 旧ブロックの直後から m-n 行ずれる。ShiftLines は自分の sites も対象に
	// するが、それらは全て start+n より上にあるので触られない (この後で明示的に
	// 置き直す)。挿入と同じく、記録の更新より先に呼ぶ。
	// 行数が変わらないときは動かす対象が無いので、走らせない
	// (メモ4マップの作り直しと保存が丸ごと無駄になる)。
	var shift *graph.ShiftResult
	if m != n {
		s := h.store.ShiftLines(ins.File, start+n, m-n)
		shift = &s
	}

	sites := make([]graph.InsertionSite, m)
	for i, l := range lines {
		sites[i] = graph.InsertionSite{Line: start + i, Text: l}
	}
	var updated graph.Insertion
	if err := h.store.UpdateInsertion(ins.ID, func(u *graph.Insertion) {
		u.Sites = sites
		// OFF のまま中身を書き換えてコメント記号を外すと、記録は OFF なのに
		// コードは生きた状態で固定され、ON にも OFF にもできなくなる。
		// 実際の中身に合わせて直す (OFF→ON の向きだけ。生きている行を
		// 勝手に OFF 扱いにはしない)。
		if !u.Enabled && !allSitesDisabled(sites) {
			u.Enabled = true
		}
		updated = *u
	}); err != nil {
		jsonErr(w, err.Error(), http.StatusInternalServerError)
		return
	}
	jsonOK(w, map[string]any{"insertion": updated, "shift": shift})
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

	// まとめ撤去の後に1件だけ戻せても中途半端で、しかも「今の Ctrl+Z が何を戻すのか」が
	// 押す側から見えなくなる。確認ダイアログを通っている操作なので控えは捨てる。
	h.lastRemoved = nil

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
			siteShifts, _, err := h.deleteInsertionSites(ins)
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

// --- POST /api/insertions/toggle ---

// disableMarker は一時無効化 (コメントアウト) のマーカ。無効化は「先頭空白の
// 直後に // を入れる」、有効化は「取り除く」の対で、字下げ (行頭への空白追加)
// と干渉しない。Sites[].Text は常にディスク上の行そのものを写すので、
// 無効化中も既存の照合・撤去・書き換えロジックがそのまま働く。
const disableMarker = "//"

func splitIndent(s string) (indent, rest string) {
	i := 0
	for i < len(s) && (s[i] == ' ' || s[i] == '\t') {
		i++
	}
	return s[:i], s[i:]
}

func disabledSiteText(s string) string {
	indent, rest := splitIndent(s)
	return indent + disableMarker + rest
}

// allSitesDisabled は全行がコメントアウト済みか。OFF の記録と実際の中身が
// 食い違ったときの復旧判定に使う。
func allSitesDisabled(sites []graph.InsertionSite) bool {
	for _, s := range sites {
		if _, ok := enabledSiteText(s.Text); !ok {
			return false
		}
	}
	return len(sites) > 0
}

// enabledSiteText はマーカを外した行を返す。マーカが見つからない場合は
// 記録と実ファイルの対応が崩れているので ok=false (呼び出し側で409扱い)。
func enabledSiteText(s string) (string, bool) {
	indent, rest := splitIndent(s)
	if !strings.HasPrefix(rest, disableMarker) {
		return "", false
	}
	return indent + strings.TrimPrefix(rest, disableMarker), true
}

// toggleInsertionSites は ins の全 sites を desired (true=有効) の形へ書き換え、
// 書き換え後の sites (解決済み行番号 + 新テキスト) を返す。deleteInsertionSites と
// 同じ verify-then-apply: 全 sites の位置と新テキストを確定させてから一括で
// Save し、部分適用にしない。行数は変わらないのでシフトは発生しない。
func (h *Handler) toggleInsertionSites(ins graph.Insertion, desired bool) ([]graph.InsertionSite, error) {
	pf, err := patch.Load(ins.File)
	if err != nil {
		return nil, err
	}
	sites := make([]graph.InsertionSite, len(ins.Sites))
	for i, site := range ins.Sites {
		line, err := resolveSitePosition(pf, ins.File, site)
		if err != nil {
			return nil, err
		}
		newText := ""
		if desired {
			t, ok := enabledSiteText(site.Text)
			if !ok {
				return nil, errRecordedLineModified
			}
			newText = t
		} else {
			newText = disabledSiteText(site.Text)
		}
		sites[i] = graph.InsertionSite{Line: line, Text: newText}
	}
	for i, site := range ins.Sites {
		if err := pf.ReplaceLine(sites[i].Line, site.Text, sites[i].Text); err != nil {
			return nil, err
		}
	}
	if err := h.saveFile(pf); err != nil {
		return nil, err
	}
	return sites, nil
}

// handleInsertionsToggle はデバッグ行の一時無効化と再有効化。撤去と違って
// 行数が変わらないので、行位置の再指定なしに ON/OFF を何度でも往復できる。
// 対象は id 指定で1件、group 指定でそのグループ、どちらも無しで全部
// (removeall と同じポインタ規約: group 省略=全部、""=無グループのみ)。
func (h *Handler) handleInsertionsToggle(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	if !h.fileWrites {
		jsonErr(w, "file writes disabled (bind to loopback to enable)", http.StatusForbidden)
		return
	}
	var req struct {
		ID      string  `json:"id"`
		Group   *string `json:"group"`
		Enabled *bool   `json:"enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonErr(w, err.Error(), http.StatusBadRequest)
		return
	}
	if req.Enabled == nil {
		jsonErr(w, "enabled required", http.StatusBadRequest)
		return
	}
	desired := *req.Enabled

	// 対象の読み出しから UpdateInsertion までを直列化する (他の挿入系APIと同じ)。
	h.insMu.Lock()
	defer h.insMu.Unlock()

	var targets []graph.Insertion
	if req.ID != "" {
		ins, ok := h.findInsertion(req.ID)
		if !ok {
			jsonErr(w, "insertion not found", http.StatusNotFound)
			return
		}
		targets = append(targets, ins)
	} else {
		for _, ins := range h.store.GetGraphResponse().Insertions {
			if req.Group != nil && ins.Group != *req.Group {
				continue
			}
			targets = append(targets, ins)
		}
	}

	toggled := []string{}
	skipped := []skippedInsertion{}
	updated := []graph.Insertion{}
	for _, ins := range targets {
		if ins.Enabled == desired {
			continue // 既に目的の状態。エラーではなく単なる no-op。
		}
		sites, err := h.toggleInsertionSites(ins, desired)
		if err != nil {
			skipped = append(skipped, skippedInsertion{ID: ins.ID, Reason: err.Error()})
			continue
		}
		var u graph.Insertion
		if err := h.store.UpdateInsertion(ins.ID, func(p *graph.Insertion) {
			p.Enabled = desired
			p.Sites = sites
			u = *p
		}); err != nil {
			skipped = append(skipped, skippedInsertion{ID: ins.ID, Reason: err.Error()})
			continue
		}
		toggled = append(toggled, ins.ID)
		updated = append(updated, u)
	}
	jsonOK(w, map[string]any{"toggled": toggled, "skipped": skipped, "insertions": updated})
}

// --- POST /api/insertions/group ---

// handleInsertionsGroup はデバッグ行の所属グループだけを付け替える。
// グループは撤去・ON/OFF のまとめ単位で、どれを1単位にしたいかは撒き終わって
// から分かることが多い。ファイルには一切触らないので、行の照合も 409 も無い。
//
// 挿入時に {group} を展開したテキストは、その時点の名前のまま残る（行を
// 書き換えると 409 の余地が生まれるため、記録は動かさない）。呼び出し側で
// 古い名前が残っていることを知らせる。
func (h *Handler) handleInsertionsGroup(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	if !h.fileWrites {
		jsonErr(w, "file writes disabled (bind to loopback to enable)", http.StatusForbidden)
		return
	}
	// removeall/toggle の Group は「省略 = 全部」を表すためポインタだが、こちらは
	// 絞り込みではなく代入なので素の string でよい（省略 = 無グループにする）。
	var req struct {
		ID    string `json:"id"`
		Group string `json:"group"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonErr(w, err.Error(), http.StatusBadRequest)
		return
	}
	if req.ID == "" {
		jsonErr(w, "id required", http.StatusBadRequest)
		return
	}
	group, ok := normalizeGroup(req.Group)
	if !ok {
		jsonErr(w, "invalid group name", http.StatusBadRequest)
		return
	}
	// 他の挿入系APIと同じく直列化する。ファイル I/O は無いので待ちは一瞬だが、
	// 存在確認と更新の間に DELETE が入ると「無い」を 500 として報告してしまう。
	h.insMu.Lock()
	defer h.insMu.Unlock()

	// 存在確認を先に済ませる。UpdateInsertion は「見つからない」と「保存に失敗した」
	// を同じ error で返すので、まとめて 404 にすると保存できなかったときに
	// 「無い」と嘘をつき、記録はメモリ上だけ変わって残る。
	if _, ok := h.findInsertion(req.ID); !ok {
		jsonErr(w, "insertion not found", http.StatusNotFound)
		return
	}
	var updated graph.Insertion
	if err := h.store.UpdateInsertion(req.ID, func(u *graph.Insertion) {
		u.Group = group
		updated = *u
	}); err != nil {
		jsonErr(w, err.Error(), http.StatusInternalServerError)
		return
	}
	jsonOK(w, map[string]any{"insertion": updated})
}

// --- POST /api/insertions/wrap ---

// handleInsertionsWrap は選択範囲を #if 0 / #endif で囲む。囲みは「既存行の
// 書き換えなし・前後への行挿入だけ」で実現できるので、byte-splice の不変条件
// (既存バイトは再エンコードしない) をそのまま満たす。ガード行にタグを埋める
// のは、ずれた時の完全一致探索 (resolveSitePosition) がちょうど1行に絞れる
// 一意性を持たせるため。
func (h *Handler) handleInsertionsWrap(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	if !h.fileWrites {
		jsonErr(w, "file writes disabled (bind to loopback to enable)", http.StatusForbidden)
		return
	}
	var req struct {
		File      string `json:"file"`
		StartLine int    `json:"start_line"`
		EndLine   int    `json:"end_line"`
		Group     string `json:"group"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonErr(w, err.Error(), http.StatusBadRequest)
		return
	}
	if req.StartLine < 1 || req.EndLine < req.StartLine {
		jsonErr(w, "invalid range", http.StatusBadRequest)
		return
	}
	group, ok := normalizeGroup(req.Group)
	if !ok {
		jsonErr(w, "invalid group name", http.StatusBadRequest)
		return
	}
	abs, ok := h.resolveWithinRoot(req.File)
	if !ok {
		jsonErr(w, "file outside root", http.StatusForbidden)
		return
	}

	// 採番から AddInsertion までを直列化する (POST と同じ臨界区間)。
	h.insMu.Lock()
	defer h.insMu.Unlock()

	tag := h.store.NextInsertionTag()
	top := fmt.Sprintf("#if 0 /* %s */", tag)
	bottom := fmt.Sprintf("#endif /* %s */", tag)

	pf, err := patch.Load(abs)
	if err != nil {
		patchErrStatus(w, err)
		return
	}
	if req.EndLine > pf.LineCount() {
		jsonErr(w, "range out of file", http.StatusBadRequest)
		return
	}
	if err := pf.InsertAfter(req.StartLine-1, []string{top}); err != nil {
		patchErrStatus(w, err)
		return
	}
	// 1行目の挿入で選択範囲は1行下がっている: 元の EndLine 行は今 EndLine+1 行目。
	if err := pf.InsertAfter(req.EndLine+1, []string{bottom}); err != nil {
		patchErrStatus(w, err)
		return
	}
	if err := h.saveFile(pf); err != nil {
		jsonErr(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// ShiftLines は AddInsertion より先 (POST と同じ契約)。2回目のシフト位置は
	// 1回目の挿入を反映した座標系で指定する (下側ガードは EndLine+2 行目に入る)。
	shifts := []graph.ShiftResult{
		h.store.ShiftLines(abs, req.StartLine, 1),
		h.store.ShiftLines(abs, req.EndLine+2, 1),
	}
	ins := graph.Insertion{
		ID:   tag,
		File: abs,
		Sites: []graph.InsertionSite{
			{Line: req.StartLine, Text: top},
			{Line: req.EndLine + 2, Text: bottom},
		},
		Group: group, Kind: graph.InsertionKindWrap, Enabled: true, CreatedAt: time.Now(),
	}
	if err := h.store.AddInsertion(ins); err != nil {
		jsonErr(w, err.Error(), http.StatusInternalServerError)
		return
	}
	jsonOK(w, map[string]any{"insertion": ins, "shifts": shifts})
}

// deleteInsertionSites は ins の全 sites を撤去し、site ごとの ShiftResult を
// 適用順 (行番号降順) のまま返す。まず全 sites の現在位置を確定させてから
// 一括で Save することで、途中の site で不一致が起きても部分削除にならない
// （verify-then-apply）。1つに畳んだ ShiftResult は複数キーが同じ移動先へ
// 収束した場合にクライアントが順序を知らないと再現できないため、
// removeall と同じ「順序付きリスト」の形で返す（畳み込みはしない）。
// 第2の戻り値は撤去を取り消すための控え。記録の行番号ではなく resolveSitePosition が
// 見つけた実位置を写す — 記録がずれていた場合、戻すべき場所は実際に消した行であって
// 記録の行ではない。
func (h *Handler) deleteInsertionSites(ins graph.Insertion) ([]graph.ShiftResult, *removedInsertion, error) {
	pf, err := patch.Load(ins.File)
	if err != nil {
		return nil, nil, err
	}

	type sitePos struct {
		line int
		text string
	}
	positions := make([]sitePos, len(ins.Sites))
	for i, site := range ins.Sites {
		line, err := resolveSitePosition(pf, ins.File, site)
		if err != nil {
			return nil, nil, err
		}
		positions[i] = sitePos{line: line, text: site.Text}
	}
	// 降順で消す: 複数 sites (囲みペアや複数行の塊) でも、上の行番号を崩さない。
	sort.Slice(positions, func(a, b int) bool { return positions[a].line > positions[b].line })

	// 末尾の行を消すと終端の有無が手前の行へ移る。末尾に撒いたデバッグ行を
	// 撤去したときに、元ファイルに無かった改行が増えないよう控えて戻す。
	hadFinalNewline := pf.EndsWithNewline()
	for _, p := range positions {
		if err := pf.DeleteLine(p.line, p.text); err != nil {
			return nil, nil, err
		}
	}
	pf.SetFinalNewline(hadFinalNewline)
	if err := h.saveFile(pf); err != nil {
		return nil, nil, err
	}

	undo := ins
	undo.Sites = make([]graph.InsertionSite, len(positions))
	for i, p := range positions {
		undo.Sites[i] = graph.InsertionSite{Line: p.line, Text: p.text}
	}

	shifts := make([]graph.ShiftResult, 0, len(positions))
	for _, p := range positions {
		shifts = append(shifts, h.store.ShiftLines(ins.File, p.line+1, -1))
	}
	return shifts, &removedInsertion{ins: undo, lines: pf.LineCount()}, nil
}

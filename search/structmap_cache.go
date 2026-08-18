package search

import (
	"bufio"
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// 参照マップの基礎表をディスクに残す。
//
// 索引のダンプを読み直すと linux で 67 秒かかる（実測）。プロセスを起動する
// たびに払う額ではないので、畳んだ後の表を保存して次回は読むだけにする。
//
// 置き場所はツリーのルート。gtags の GTAGS / GRTAGS / GPATH と
// .grepnavi-macros が既にそこにあり、この表は GTAGS から導出したものなので、
// 導出元と同じ場所・同じ寿命にあるのが自然（ツリーを消せば一緒に消える）。
//
// 形式は行指向。パスは1度だけ書いて以後は番号で参照する（linux の 66 万
// エッジをパス2本ずつで書くと数倍に膨らむ）。

const (
	refMapCacheMagic = "grepnavi-refmap\t4"
	refMapCacheFile  = ".grepnavi-refmap"
)

func refMapCachePath(root string) string {
	if root == "" {
		return ""
	}
	return filepath.Join(root, refMapCacheFile)
}

// refMapHeader は「この保存が今も有効か」を判定する材料。
// 索引が更新されても除外設定が変わっても作り直す。
func refMapHeader(gtagsMtime time.Time, gtagsSize int64, excl string) string {
	sum := sha1.Sum([]byte(excl))
	return fmt.Sprintf("%s\t%d\t%d\t%s", refMapCacheMagic,
		gtagsMtime.UnixNano(), gtagsSize, hex.EncodeToString(sum[:8]))
}

func loadRefMapCache(root string, mtime time.Time, size int64, excl string) (*structTables, bool) {
	p := refMapCachePath(root)
	if p == "" {
		return nil, false
	}
	f, err := os.Open(p)
	if err != nil {
		return nil, false
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 256*1024), 4*1024*1024)
	if !sc.Scan() || sc.Text() != refMapHeader(mtime, size, excl) {
		return nil, false
	}
	t := &structTables{edges: map[structPair]*structFileEdge{}}
	var paths []string
	at := func(s string) (string, bool) {
		i, err := strconv.Atoi(s)
		if err != nil || i < 0 || i >= len(paths) {
			return "", false
		}
		return paths[i], true
	}
	for sc.Scan() {
		line := sc.Text()
		if len(line) < 2 || line[1] != '\t' {
			return nil, false
		}
		body := line[2:]
		switch line[0] {
		case 'n':
			// sameName<TAB>sameNameRefs<TAB>staticRefs<TAB>headerRefs
			fs := strings.Split(body, "\t")
			if len(fs) != 4 {
				return nil, false
			}
			ns := make([]int, 4)
			for i, f := range fs {
				v, err := strconv.Atoi(f)
				if err != nil {
					return nil, false
				}
				ns[i] = v
			}
			t.sameName, t.sameNameRefs, t.staticRefs, t.headerRefs = ns[0], ns[1], ns[2], ns[3]
		case 'p':
			paths = append(paths, body)
		case 'i':
			rel, ok := at(body)
			if !ok {
				return nil, false
			}
			t.implFiles = append(t.implFiles, rel)
		case 'e':
			// src<TAB>def<TAB>count<TAB>sym,sym,...
			fs := strings.SplitN(body, "\t", 4)
			if len(fs) < 3 {
				return nil, false
			}
			src, ok1 := at(fs[0])
			def, ok2 := at(fs[1])
			n, err := strconv.Atoi(fs[2])
			if !ok1 || !ok2 || err != nil {
				return nil, false
			}
			e := &structFileEdge{count: n}
			if len(fs) == 4 && fs[3] != "" {
				e.syms = strings.Split(fs[3], ",")
			}
			t.edges[structPair{src: src, def: def}] = e
		default:
			return nil, false
		}
	}
	if sc.Err() != nil {
		return nil, false
	}
	return t, true
}

func saveRefMapCache(root string, mtime time.Time, size int64, excl string, t *structTables) {
	p := refMapCachePath(root)
	if p == "" {
		return
	}
	// tmp に書いて rename。途中で落ちても壊れた本体を残さない
	tmp := p + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		return // 書けないツリー（読み取り専用等）では毎回作り直す運用に落ちる
	}
	w := bufio.NewWriterSize(f, 1<<20)
	fmt.Fprintln(w, refMapHeader(mtime, size, excl))
	fmt.Fprintf(w, "n\t%d\t%d\t%d\t%d\n", t.sameName, t.sameNameRefs, t.staticRefs, t.headerRefs)

	id := make(map[string]int, len(t.edges))
	put := func(path string) int {
		if i, ok := id[path]; ok {
			return i
		}
		i := len(id)
		id[path] = i
		w.WriteString("p\t")
		w.WriteString(path)
		w.WriteByte('\n')
		return i
	}
	for _, rel := range t.implFiles {
		fmt.Fprintf(w, "i\t%d\n", put(rel))
	}
	for pair, e := range t.edges {
		src, def := put(pair.src), put(pair.def)
		fmt.Fprintf(w, "e\t%d\t%d\t%d\t%s\n", src, def, e.count, strings.Join(e.syms, ","))
	}

	err = w.Flush()
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(tmp)
		return
	}
	if err := os.Rename(tmp, p); err != nil {
		os.Remove(tmp)
	}
}

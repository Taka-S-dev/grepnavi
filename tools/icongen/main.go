// icongen は grepnavi のアプリアイコン（マルチサイズ .ico）を生成する。
//
// 意匠は虫眼鏡（grep）のレンズに方位磁針（navi）を収めた形。外形を虫眼鏡に
// することで 16px でもシルエットが立ち、針が検索ツール一般との差別化になる。
//
// アイコンは3箇所（トレイ / exe リソース / favicon）で使い回すため、
// 派生ファイルではなくこのプログラムを唯一の原本とする。
//
//	go run ./tools/icongen
//
// 生成物: desktop/app_icon.ico, static/favicon.ico
// exe への埋め込みは README のリリース手順を参照（rsrc で .syso を生成）。
package main

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math"
	"os"
	"path/filepath"
)

// Windows がトレイ・エクスプローラ・タスクバー・高DPI で参照するサイズ一式。
var sizes = []int{16, 20, 24, 32, 48, 64, 256}

var (
	bgColor     = color.RGBA{R: 30, G: 64, B: 175, A: 255}   // 深いブルー
	glyphColor  = color.RGBA{R: 255, G: 255, B: 255, A: 255} // 虫眼鏡と針の南側
	needleColor = color.RGBA{R: 245, G: 158, B: 11, A: 255}  // 針の北側（青との補色で小サイズでも残る）
)

// glyphParams は描画パラメータ（キャンバス幅に対する比率）。
// 小サイズは線が潰れるため、太らせて視認性を優先する（光学調整）。
type glyphParams struct {
	corner     float64 // 背景角丸の半径
	ringCenter float64 // レンズ中心（左上からの位置、x=y）
	ringRadius float64 // レンズ半径（ストローク中心線）
	ringStroke float64 // レンズの線幅
	handleEnd  float64 // 取っ手の終点（x=y）
	handleWide float64 // 取っ手の太さ
	needleLen  float64 // 針の長さ（中心から先端）
	needleWide float64 // 針の根元の半幅
}

func paramsFor(size int) glyphParams {
	// レンズを大きめに取り、内側の針を読ませる。ただし取っ手が消えると
	// 虫眼鏡に見えなくなるため、半径は 0.32 を上限とする。
	p := glyphParams{
		corner:     0.22,
		ringCenter: 0.44,
		ringRadius: 0.32,
		ringStroke: 0.085,
		handleEnd:  0.88,
		handleWide: 0.10,
		needleLen:  0.225,
		needleWide: 0.072,
	}
	if size <= 24 {
		// 16px では 1px 未満の線が消えるため、比率を保ったまま線と針を太らせる
		p.ringRadius = 0.315
		p.ringStroke = 0.119
		p.handleWide = 0.124
		p.needleLen = 0.214
		p.needleWide = 0.083
	}
	return p
}

func main() {
	imgs := make([]*image.RGBA, 0, len(sizes))
	for _, s := range sizes {
		imgs = append(imgs, render(s))
	}

	ico, err := encodeICO(imgs)
	if err != nil {
		fmt.Fprintln(os.Stderr, "encode:", err)
		os.Exit(1)
	}
	for _, out := range []string{
		filepath.Join("desktop", "app_icon.ico"),
		filepath.Join("static", "favicon.ico"),
	} {
		if err := os.WriteFile(out, ico, 0644); err != nil {
			fmt.Fprintln(os.Stderr, "write:", err)
			os.Exit(1)
		}
		fmt.Printf("wrote %s (%d bytes, %d sizes)\n", out, len(ico), len(sizes))
	}

	// 任意: 目視確認用のプレビューを書き出す
	if len(os.Args) > 1 {
		writePreview(os.Args[1], imgs)
	}
}

// render は 1 サイズ分のアイコンを描く。
// スーパーサンプリング後に縮小することでアンチエイリアスを得る。
func render(size int) *image.RGBA {
	ss := 8
	if size >= 128 {
		ss = 4
	}
	hi := drawHiRes(size, ss)
	return downsample(hi, size, ss)
}

func drawHiRes(size, ss int) *image.RGBA {
	p := paramsFor(size)
	n := size * ss
	f := float64(n)
	img := image.NewRGBA(image.Rect(0, 0, n, n))

	cx, cy := p.ringCenter*f, p.ringCenter*f
	rr := p.ringRadius * f
	rs := p.ringStroke * f / 2
	// 取っ手の始点はレンズ外周。丸い端が内側へ回り込んでレンズを欠けさせないよう、
	// 線幅の半分だけ外に出した位置を中心にする。
	dir := math.Sqrt2 / 2
	hx0, hy0 := cx+dir*(rr+rs), cy+dir*(rr+rs)
	hx1, hy1 := p.handleEnd*f, p.handleEnd*f
	hw := p.handleWide * f / 2
	corner := p.corner * f

	// 針は取っ手と同じ 45 度線上に置き、北（右上）をアクセント色にする
	nx, ny := dir, -dir
	tipN := [2]float64{cx + nx*p.needleLen*f, cy + ny*p.needleLen*f}
	tipS := [2]float64{cx - nx*p.needleLen*f, cy - ny*p.needleLen*f}
	baseL := [2]float64{cx - ny*p.needleWide*f, cy + nx*p.needleWide*f}
	baseR := [2]float64{cx + ny*p.needleWide*f, cy - nx*p.needleWide*f}

	for y := 0; y < n; y++ {
		for x := 0; x < n; x++ {
			px, py := float64(x)+0.5, float64(y)+0.5
			if !insideRoundedRect(px, py, f, corner) {
				continue // 角の外は透明のまま
			}
			c := bgColor
			switch {
			case math.Abs(math.Hypot(px-cx, py-cy)-rr) <= rs,
				distToSegment(px, py, hx0, hy0, hx1, hy1) <= hw:
				c = glyphColor
			case insideTriangle(px, py, tipN, baseL, baseR):
				c = needleColor
			case insideTriangle(px, py, tipS, baseL, baseR):
				c = glyphColor
			}
			img.SetRGBA(x, y, c)
		}
	}
	return img
}

// insideTriangle は 3 頂点の三角形に点が含まれるかを外積の符号で判定する。
func insideTriangle(px, py float64, a, b, c [2]float64) bool {
	cross := func(p, q, r [2]float64) float64 {
		return (p[0]-r[0])*(q[1]-r[1]) - (q[0]-r[0])*(p[1]-r[1])
	}
	p := [2]float64{px, py}
	d1, d2, d3 := cross(p, a, b), cross(p, b, c), cross(p, c, a)
	hasNeg := d1 < 0 || d2 < 0 || d3 < 0
	hasPos := d1 > 0 || d2 > 0 || d3 > 0
	return !(hasNeg && hasPos)
}

func insideRoundedRect(x, y, size, radius float64) bool {
	// 角の内側の中心へ寄せてから距離を測る
	dx := math.Max(math.Max(radius-x, x-(size-radius)), 0)
	dy := math.Max(math.Max(radius-y, y-(size-radius)), 0)
	return math.Hypot(dx, dy) <= radius
}

func distToSegment(px, py, x0, y0, x1, y1 float64) float64 {
	vx, vy := x1-x0, y1-y0
	wx, wy := px-x0, py-y0
	den := vx*vx + vy*vy
	t := 0.0
	if den > 0 {
		t = math.Max(0, math.Min(1, (wx*vx+wy*vy)/den))
	}
	return math.Hypot(px-(x0+t*vx), py-(y0+t*vy))
}

// downsample は ss×ss ブロックを平均して縮小する。
// 透明ピクセルの RGB は 0 なので、平均は乗算済みアルファでの合成と等価。
// 最後に非乗算へ戻すことで、縁が黒ずむのを防ぐ。
func downsample(src *image.RGBA, size, ss int) *image.RGBA {
	dst := image.NewRGBA(image.Rect(0, 0, size, size))
	area := float64(ss * ss)
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			var r, g, b, a float64
			for sy := 0; sy < ss; sy++ {
				for sx := 0; sx < ss; sx++ {
					c := src.RGBAAt(x*ss+sx, y*ss+sy)
					r += float64(c.R)
					g += float64(c.G)
					b += float64(c.B)
					a += float64(c.A)
				}
			}
			r, g, b, a = r/area, g/area, b/area, a/area
			if a == 0 {
				continue
			}
			dst.SetRGBA(x, y, color.RGBA{
				R: uint8(math.Round(r * 255 / a)),
				G: uint8(math.Round(g * 255 / a)),
				B: uint8(math.Round(b * 255 / a)),
				A: uint8(math.Round(a)),
			})
		}
	}
	return dst
}

// encodeICO は複数サイズを 1 つの .ico にまとめる。
// 256px は PNG、それ以外は 32bit BMP（互換性が最も高い組み合わせ）。
func encodeICO(imgs []*image.RGBA) ([]byte, error) {
	type entry struct {
		size int
		data []byte
		png  bool
	}
	entries := make([]entry, 0, len(imgs))
	for _, img := range imgs {
		s := img.Bounds().Dx()
		if s >= 256 {
			var buf bytes.Buffer
			if err := png.Encode(&buf, img); err != nil {
				return nil, err
			}
			entries = append(entries, entry{size: s, data: buf.Bytes(), png: true})
			continue
		}
		entries = append(entries, entry{size: s, data: encodeBMP(img)})
	}

	var out bytes.Buffer
	binary.Write(&out, binary.LittleEndian, uint16(0)) // reserved
	binary.Write(&out, binary.LittleEndian, uint16(1)) // type: icon
	binary.Write(&out, binary.LittleEndian, uint16(len(entries)))

	offset := 6 + 16*len(entries)
	for _, e := range entries {
		dim := byte(e.size) // 256 は 0 として記録する仕様
		out.WriteByte(dim)
		out.WriteByte(dim)
		out.WriteByte(0)                                    // パレット数（32bit なので 0）
		out.WriteByte(0)                                    // reserved
		binary.Write(&out, binary.LittleEndian, uint16(1))  // planes
		binary.Write(&out, binary.LittleEndian, uint16(32)) // bit count
		binary.Write(&out, binary.LittleEndian, uint32(len(e.data)))
		binary.Write(&out, binary.LittleEndian, uint32(offset))
		offset += len(e.data)
	}
	for _, e := range entries {
		out.Write(e.data)
	}
	return out.Bytes(), nil
}

// encodeBMP は ICO 内に置く DIB を作る。
// 高さは XOR 画像 + AND マスクの分を 2 倍で記録し、行は下から上へ並べる。
func encodeBMP(img *image.RGBA) []byte {
	s := img.Bounds().Dx()
	var buf bytes.Buffer

	binary.Write(&buf, binary.LittleEndian, uint32(40)) // biSize
	binary.Write(&buf, binary.LittleEndian, int32(s))   // biWidth
	binary.Write(&buf, binary.LittleEndian, int32(s*2)) // biHeight (XOR+AND)
	binary.Write(&buf, binary.LittleEndian, uint16(1))  // biPlanes
	binary.Write(&buf, binary.LittleEndian, uint16(32)) // biBitCount
	binary.Write(&buf, binary.LittleEndian, uint32(0))  // biCompression: BI_RGB
	binary.Write(&buf, binary.LittleEndian, uint32(0))  // biSizeImage
	binary.Write(&buf, binary.LittleEndian, int32(0))   // biXPelsPerMeter
	binary.Write(&buf, binary.LittleEndian, int32(0))   // biYPelsPerMeter
	binary.Write(&buf, binary.LittleEndian, uint32(0))  // biClrUsed
	binary.Write(&buf, binary.LittleEndian, uint32(0))  // biClrImportant

	for y := s - 1; y >= 0; y-- {
		for x := 0; x < s; x++ {
			c := img.RGBAAt(x, y)
			buf.Write([]byte{c.B, c.G, c.R, c.A})
		}
	}
	// AND マスクはアルファで表現済みのため全 0（不透明扱い）。行は 4 バイト境界。
	maskRow := ((s + 31) / 32) * 4
	buf.Write(make([]byte, maskRow*s))
	return buf.Bytes()
}

// writePreview は各サイズを実寸で並べた確認用 PNG を書き出す。
func writePreview(path string, imgs []*image.RGBA) {
	gap, pad := 8, 8
	w, h := pad, 0
	for _, img := range imgs {
		s := img.Bounds().Dx()
		w += s + gap
		if s > h {
			h = s
		}
	}
	canvas := image.NewRGBA(image.Rect(0, 0, w, h+pad*2))
	for x := 0; x < canvas.Bounds().Dx(); x++ {
		for y := 0; y < canvas.Bounds().Dy(); y++ {
			canvas.SetRGBA(x, y, color.RGBA{R: 32, G: 32, B: 32, A: 255})
		}
	}
	x0 := pad
	for _, img := range imgs {
		s := img.Bounds().Dx()
		for y := 0; y < s; y++ {
			for x := 0; x < s; x++ {
				c := img.RGBAAt(x, y)
				if c.A == 0 {
					continue
				}
				canvas.SetRGBA(x0+x, pad+y, c)
			}
		}
		x0 += s + gap
	}
	f, err := os.Create(path)
	if err != nil {
		return
	}
	defer f.Close()
	png.Encode(f, canvas)
	fmt.Println("wrote preview:", path)
}

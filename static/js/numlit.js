// ===== 数値リテラルの基数変換ホバー =====
// C ソース中の整数・文字リテラルにホバーしたとき、10進/16進/2進と立っている
// ビット位置をその場で出す。フラグ値やマスクを読むとき人が電卓でやっている
// 変換を、視線を動かさずに済ませる。サーバ照会なしのクライアント完結。
// 値は BigInt で扱う（64bit マスクは Number の安全整数 2^53 を超える）。

// 行内の整数・文字リテラルを列挙して column(1-based) を含むものを返す。
// 識別子の一部(var2)・浮動小数(1.5 / 1e5 / 0x1p3)は隣接文字で除外する。
// 文字列リテラル内の数値はあえて除外しない（"port 8080" 等でも変換は有用で、
// 誤変換の危険がない）。
function findNumLiteralAt(lineText, column) {
  const re = /'(?:\\(?:x[0-9a-fA-F]+|[0-7]{1,3}|.)|[^'\\])'|(?:0[xX][0-9a-fA-F]+|0[bB][01]+|[0-9]+)[uUlL]*/g;
  let m;
  while ((m = re.exec(lineText)) !== null) {
    const start = m.index, end = m.index + m[0].length;
    if (column < start + 1 || column > end + 1) continue;
    if (m[0][0] !== "'") {
      const prev = start > 0 ? lineText[start - 1] : '';
      const next = end < lineText.length ? lineText[end] : '';
      if (/[A-Za-z0-9_.]/.test(prev) || /[A-Za-z0-9_.]/.test(next)) continue;
    }
    return { text: m[0], startColumn: start + 1, endColumn: end + 1 };
  }
  return null;
}

// 3桁ごと・4桁ごと等の区切りを入れる（"4294967295" → "4,294,967,295"）
function _groupDigits(s, n, sep) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % n === 0) out += sep;
    out += s[i];
  }
  return out;
}

// 2進は値の大きさに応じて 8/16/32/64 桁へゼロ詰め。C の整数幅に合わせると
// "どの位置のビットか" が桁数から読める
function _padBinary(v) {
  const raw = v.toString(2);
  const width = raw.length <= 8 ? 8 : raw.length <= 16 ? 16 : raw.length <= 32 ? 32 : 64;
  return raw.padStart(width, '0');
}

const _CHAR_ESCAPES = { '0': 0, 'a': 7, 'b': 8, 'f': 12, 'n': 10, 'r': 13, 't': 9, 'v': 11, '\\': 92, "'": 39, '"': 34, '?': 63 };

// 縦積みの等幅ブロックに揃える（電卓のプログラマモードと同じ配置）。
// 常に同じ行に同じ基数が来るので、2回目からは視線が覚えた場所に飛ぶだけで済む
function _rowsToMarkdown(rows, note) {
  const block = rows.map(([k, v]) => `${k}  ${v}`).join('\n');
  return (note ? note + '\n\n' : '') + '```text\n' + block + '\n```';
}

function _formatCharLiteral(text) {
  const inner = text.slice(1, -1);
  let code;
  if (inner[0] === '\\') {
    const esc = inner.slice(1);
    if (/^x[0-9a-fA-F]+$/.test(esc)) code = parseInt(esc.slice(1), 16);
    else if (/^[0-7]{1,3}$/.test(esc)) code = parseInt(esc, 8);
    else if (esc in _CHAR_ESCAPES) code = _CHAR_ESCAPES[esc];
    else return null;
  } else {
    code = inner.codePointAt(0);
  }
  // 非 ASCII は文字コード（UTF-8/SJIS 等）でバイト値が変わるので出さない
  if (code > 127) return null;
  return _rowsToMarkdown([['dec', code], ['hex', '0x' + code.toString(16)]]);
}

// リテラル1個を基数変換の markdown へ。対象外（不正な8進・C の整数幅超え・
// 非 ASCII 文字リテラル）は null。
function formatNumLiteral(text) {
  if (text[0] === "'") return _formatCharLiteral(text);
  const suffix = text.match(/[uUlL]*$/)[0];
  const numStr = suffix ? text.slice(0, -suffix.length) : text;
  let value, base;
  try {
    if (/^0[xX][0-9a-fA-F]+$/.test(numStr)) { value = BigInt(numStr); base = 16; }
    else if (/^0[bB][01]+$/.test(numStr)) { value = BigInt(numStr); base = 2; }
    else if (/^0[0-7]+$/.test(numStr)) { value = BigInt('0o' + numStr.slice(1)); base = 8; }
    else if (/^0[0-9]+$/.test(numStr)) return null; // 089: C では不正な8進
    else if (/^[0-9]+$/.test(numStr)) { value = BigInt(numStr); base = 10; }
    else return null;
  } catch { return null; }
  if (value >= 1n << 64n) return null;

  const rows = [
    ['dec', _groupDigits(value.toString(10), 3, ',')],
    ['hex', '0x' + value.toString(16)],
    ['bin', '0b' + _groupDigits(_padBinary(value), 4, '_')],
  ];
  if (value > 0n) {
    const bits = [];
    for (let i = 0n, v = value; v > 0n; v >>= 1n, i++) {
      if (v & 1n) bits.push(i.toString());
    }
    // 2進は左(MSB)から読むので、ビット位置も降順で揃える（bit0 = 最下位）
    bits.reverse();
    rows.push(['bit', bits.length <= 12 ? bits.join(', ') : bits.length + '個']);
  }
  // 素の 010 が 8 に見えない事故は C の定番なので、8進だけ注記を付ける
  return _rowsToMarkdown(rows, base === 8 ? `**\`${text}\`** は8進表記` : '');
}

// ホバーカードの計算値（10進文字列）用の 2進+ビット位置の一行。ヘッダの
// = 66 (0x42) で dec/hex は出ているので、足りない情報だけを補完する。
// ホバー内のテキストには再ホバーできない（Monaco の構造上、ポップアップは
// ただの描画結果）ため、変換はカード生成時に焼き込むしかない。
function formatValueBits(decStr) {
  let v;
  try { v = BigInt(decStr); } catch { return ''; }
  if (v <= 0n || v >= 1n << 64n) return '';
  const bits = [];
  for (let i = 0n, w = v; w > 0n; w >>= 1n, i++) {
    if (w & 1n) bits.push(i.toString());
  }
  bits.reverse();
  const bin = '0b' + _groupDigits(_padBinary(v), 4, '_');
  return `${bin} · bit ${bits.length <= 12 ? bits.join(', ') : bits.length + '個'}`;
}

if (typeof module !== 'undefined') module.exports = { findNumLiteralAt, formatNumLiteral, formatValueBits };

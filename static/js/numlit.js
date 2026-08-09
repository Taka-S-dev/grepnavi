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

// リテラル文字列を {value(BigInt), base} へ。不正（089 等）・C に無い字面は null
function _parseIntLiteral(text) {
  const suffix = text.match(/[uUlL]*$/)[0];
  const numStr = suffix ? text.slice(0, -suffix.length) : text;
  try {
    if (/^0[xX][0-9a-fA-F]+$/.test(numStr)) return { value: BigInt(numStr), base: 16 };
    if (/^0[bB][01]+$/.test(numStr)) return { value: BigInt(numStr), base: 2 };
    if (/^0[0-7]+$/.test(numStr)) return { value: BigInt('0o' + numStr.slice(1)), base: 8 };
    if (/^0[0-9]+$/.test(numStr)) return null; // 089: C では不正な8進
    if (/^[0-9]+$/.test(numStr)) return { value: BigInt(numStr), base: 10 };
  } catch { /* BigInt が投げる形は全て対象外 */ }
  return null;
}

// 値1個を dec/hex/bin/bit の行に展開する（0 <= v < 2^64 前提）
function _rowsForValue(value) {
  const rows = [
    ['dec', _groupDigits(value.toString(10), 3, ',')],
    ['hex', '0x' + value.toString(16)],
    ['bin', '0b' + _groupDigits(_padBinary(value), 4, '_')],
  ];
  if (value > 0n) {
    // 位置の羅列だけでは「立っているビット」だと伝わらないので文で言い切る
    rows.push(['bit', _setBitsPhrase(value)]);
  }
  return rows;
}

// 「6, 1 が立っている (0=最下位)」の形。2進は左(MSB)から読むので降順で揃える
function _setBitsPhrase(value) {
  const bits = [];
  for (let i = 0n, v = value; v > 0n; v >>= 1n, i++) {
    if (v & 1n) bits.push(i.toString());
  }
  bits.reverse();
  if (bits.length > 12) return bits.length + '個が立っている';
  return bits.join(', ') + ' が立っている (0=最下位)';
}

// リテラル1個を基数変換の markdown へ。対象外（不正な8進・C の整数幅超え・
// 非 ASCII 文字リテラル）は null。
function formatNumLiteral(text) {
  if (text[0] === "'") return _formatCharLiteral(text);
  const lit = _parseIntLiteral(text);
  if (!lit || lit.value >= 1n << 64n) return null;
  // 素の 010 が 8 に見えない事故は C の定番なので、8進だけ注記を付ける
  return _rowsToMarkdown(_rowsForValue(lit.value), lit.base === 8 ? `**\`${text}\`** は8進表記` : '');
}

// ホバーカードの計算値（10進文字列）用の 2進+ビット位置の一行。ヘッダの
// = 66 (0x42) で dec/hex は出ているので、足りない情報だけを補完する。
// ホバー内のテキストには再ホバーできない（Monaco の構造上、ポップアップは
// ただの描画結果）ため、変換はカード生成時に焼き込むしかない。
function formatValueBits(decStr) {
  let v;
  try { v = BigInt(decStr); } catch { return ''; }
  if (v <= 0n || v >= 1n << 64n) return '';
  const bin = '0b' + _groupDigits(_padBinary(v), 4, '_');
  // 2進だけ code span（等幅でないと桁が読めない）、説明文は地の文のまま
  return `\`${bin}\` — bit ${_setBitsPhrase(v)}`;
}

// ===== 式の評価（基数変換電卓用）=====
// リテラルと演算子だけの整数式を BigInt で評価する。識別子（マクロ名）は
// 扱わない — 値の解決はサーバ側の索引が要る話で、ホバーが担当している。
// / と % は BigInt がゼロ方向切り捨てで C と一致する。

// C の優先順位（低い方から | ^ & 等値 比較 シフト 加減 乗除）。
// 比較が & ^ | より強いのは C の定番の罠 (1 & 2 == 2 は 1 & (2==2)) だが、
// C を読むための電卓なので C の解釈に忠実であることを優先する
const _CALC_PREC = {
  '|': 1, '^': 2, '&': 3,
  '==': 4, '!=': 4,
  '<': 5, '<=': 5, '>': 5, '>=': 5,
  '<<': 6, '>>': 6,
  '+': 7, '-': 7,
  '*': 8, '/': 8, '%': 8,
};

function _lexNumExpr(src) {
  const toks = [];
  const re = /\s+|(?:0[xX][0-9a-fA-F]+|0[bB][01]+|[0-9]+)[uUlL]*|<<|>>|[<>=!]=|[<>]|[|&^+\-*/%~()]/y;
  let i = 0;
  while (i < src.length) {
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) return null; // 語彙の外（識別子・比較・小数点など）
    i = re.lastIndex;
    const s = m[0];
    if (/^\s/.test(s)) continue;
    if (/^[0-9]/.test(s)) {
      const lit = _parseIntLiteral(s);
      if (!lit) return null;
      toks.push({ num: lit.value });
    } else {
      toks.push({ op: s });
    }
  }
  return toks;
}

function _calcBinary(st, minPrec) {
  let left = _calcUnary(st);
  if (left === null) return null;
  while (st.pos < st.toks.length) {
    const t = st.toks[st.pos];
    const prec = t.op !== undefined ? _CALC_PREC[t.op] : undefined;
    if (prec === undefined || prec < minPrec) break;
    st.pos++;
    const right = _calcBinary(st, prec + 1); // 左結合
    if (right === null) return null;
    switch (t.op) {
      case '|': left |= right; break;
      case '^': left ^= right; break;
      case '&': left &= right; break;
      case '==': left = left === right ? 1n : 0n; break;
      case '!=': left = left !== right ? 1n : 0n; break;
      case '<': left = left < right ? 1n : 0n; break;
      case '<=': left = left <= right ? 1n : 0n; break;
      case '>': left = left > right ? 1n : 0n; break;
      case '>=': left = left >= right ? 1n : 0n; break;
      case '<<': case '>>':
        if (right < 0n || right > 63n) return null;
        left = t.op === '<<' ? left << right : left >> right;
        break;
      case '+': left += right; break;
      case '-': left -= right; break;
      case '*': left *= right; break;
      case '/': case '%':
        if (right === 0n) return null;
        left = t.op === '/' ? left / right : left % right;
        break;
    }
  }
  return left;
}

function _calcUnary(st) {
  const t = st.toks[st.pos];
  if (t && (t.op === '~' || t.op === '-' || t.op === '+')) {
    st.pos++;
    const v = _calcUnary(st);
    if (v === null) return null;
    return t.op === '~' ? ~v : t.op === '-' ? -v : v;
  }
  return _calcPrimary(st);
}

function _calcPrimary(st) {
  const t = st.toks[st.pos];
  if (!t) return null;
  if (t.num !== undefined) { st.pos++; return t.num; }
  if (t.op === '(') {
    st.pos++;
    const v = _calcBinary(st, 1);
    if (v === null || st.toks[st.pos]?.op !== ')') return null;
    st.pos++;
    return v;
  }
  return null;
}

// 式を評価して BigInt を返す。解釈できなければ null（|| や比較は
// 2トークンに割れて構文で落ちる）。
function evalNumExpr(src) {
  if (!src || !src.trim()) return null;
  const toks = _lexNumExpr(src);
  if (!toks || !toks.length) return null;
  const st = { toks, pos: 0 };
  const v = _calcBinary(st, 1);
  return (v !== null && st.pos === toks.length) ? v : null;
}

// 電卓の出力（<pre> 用プレーンテキスト）。負値は 10進のみ（16進表現は幅の
// 解釈が要る）、64bit 超は 10進と16進のみ（2進は長すぎて読めない）。
function formatCalcResult(src) {
  const v = evalNumExpr(src);
  if (v === null) return null;
  // 比較を含む式の 0/1 は真偽の答えとして表示する（(1<<4) == 16 の検算用途。
  // dec 1 のブロックを出しても「で、合ってるの？」に答えていない）
  const toks = _lexNumExpr(src);
  const hasCmp = toks && toks.some(t =>
    t.op === '==' || t.op === '!=' || t.op === '<' || t.op === '<=' || t.op === '>' || t.op === '>=');
  if (hasCmp && (v === 0n || v === 1n)) return v === 1n ? 'true' : 'false';
  let rows;
  if (v < 0n) {
    rows = [['dec', '-' + _groupDigits((-v).toString(10), 3, ',')]];
  } else if (v >= 1n << 64n) {
    rows = [
      ['dec', _groupDigits(v.toString(10), 3, ',')],
      ['hex', '0x' + v.toString(16)],
    ];
  } else {
    rows = _rowsForValue(v);
  }
  return rows.map(([k, val]) => `${k}  ${val}`).join('\n');
}

if (typeof module !== 'undefined') module.exports = { findNumLiteralAt, formatNumLiteral, formatValueBits, evalNumExpr, formatCalcResult };

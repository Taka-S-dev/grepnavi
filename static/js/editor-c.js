// editor-c.js — C/C++ 言語固有のエディタ拡張
//
// initEditorC(editor, monaco) を呼び出して初期化する。
// 戻り値: { resolveLocalVar } — ホバープロバイダから使用する判定関数

// C/C++ キーワード（型名判定で除外する識別子）
const _C_KEYWORDS = new Set([
  'auto','break','case','char','const','continue','default','do',
  'double','else','enum','extern','float','for','goto','if',
  'inline','int','long','register','restrict','return','short',
  'signed','sizeof','static','struct','switch','typedef','typeof',
  'union','unsigned','void','volatile','while',
  'bool','catch','class','constexpr','delete','explicit','false',
  'friend','mutable','namespace','new','noexcept','nullptr',
  'operator','override','private','protected','public','template',
  'this','throw','true','try','using','virtual',
  '__attribute__','__typeof__','__volatile__','__asm__',
]);

function initEditorC(editor, monaco) {

  // ===== コメント/文字列内判定 =====
  // ブロックコメント /* ... */ は複数行にまたがるため、monaco.editor.tokenize では
  // 途中の行を単独でトークン化しても comment と判定されない。
  // そのためファイル全体をスキャンして各行のコメント/文字列範囲を事前に収集する。
  //
  // 戻り値: Map<lineNumber(1-based), [[startCol, endCol], ...]>  (col は 0-based)
  function _buildCommentRanges(model) {
    const result = new Map();
    const lineCount = model.getLineCount();
    let inBlock = false;

    function addRange(ln, s, e) {
      if (!result.has(ln)) result.set(ln, []);
      result.get(ln).push([s, e]);
    }

    for (let ln = 1; ln <= lineCount; ln++) {
      const line = model.getLineContent(ln);
      const len = line.length;
      let i = 0;

      if (inBlock) {
        const end = line.indexOf('*/');
        if (end >= 0) {
          addRange(ln, 0, end + 2);
          inBlock = false;
          i = end + 2;
        } else {
          addRange(ln, 0, len);
          continue;
        }
      }

      while (i < len) {
        if (line[i] === '/' && i + 1 < len && line[i + 1] === '/') {
          addRange(ln, i, len);
          break;
        } else if (line[i] === '/' && i + 1 < len && line[i + 1] === '*') {
          const end = line.indexOf('*/', i + 2);
          if (end >= 0) {
            addRange(ln, i, end + 2);
            i = end + 2;
          } else {
            addRange(ln, i, len);
            inBlock = true;
            break;
          }
        } else if (line[i] === '"' || line[i] === "'") {
          const q = line[i];
          const strStart = i;
          i++;
          while (i < len && line[i] !== q) {
            if (line[i] === '\\') i++;
            i++;
          }
          i++;
          addRange(ln, strStart, i);
        } else if (line[i] === '<' && /^\s*#\s*include\b/.test(line.substring(0, i))) {
          // #include <...> のangle bracket内を除外
          const end = line.indexOf('>', i + 1);
          if (end >= 0) {
            addRange(ln, i, end + 1);
            i = end + 1;
          } else {
            i++;
          }
        } else {
          i++;
        }
      }
    }
    return result;
  }

  // _buildCommentRanges のキャッシュ（モデルバージョンが変わるまで再利用）
  let _commentRangesCache = null; // { versionId, ranges }

  function _getCommentRanges(model) {
    const v = model.getVersionId();
    if (_commentRangesCache && _commentRangesCache.versionId === v) {
      return _commentRangesCache.ranges;
    }
    const ranges = _buildCommentRanges(model);
    _commentRangesCache = { versionId: v, ranges };
    return ranges;
  }

  function _isInCommentOrString(commentRanges, range) {
    const ranges = commentRanges.get(range.startLineNumber);
    if (!ranges) return false;
    const col = range.startColumn - 1; // 0-based
    for (const [s, e] of ranges) {
      if (col >= s && col < e) return true;
    }
    return false;
  }

  // ===== static 変数ハイライト =====
  let _staticVarDec = null; // IEditorDecorationsCollection
  let _staticVarTimer = null;

  function _applyStaticDecorations() {
    const model = editor.getModel();
    if (!model) { if (_staticVarDec) _staticVarDec.clear(); return; }
    const lang = model.getLanguageId();
    if (lang !== 'c' && lang !== 'cpp') { if (_staticVarDec) _staticVarDec.clear(); return; }

    const staticNames = new Set();
    const lineCount = model.getLineCount();
    for (let ln = 1; ln <= lineCount; ln++) {
      const line = model.getLineContent(ln);
      if (!line.includes('static')) continue;
      const m = line.match(
        /\bstatic\b(?:\s+(?:const|volatile|unsigned|signed|long|short|inline))*\s+(?:(?:struct|enum|union)\s+)?\w+\s*\**\s*([a-zA-Z_]\w*)\s*(?=[=;\[])/
      );
      if (!m) continue;
      const staticOff = line.indexOf('static');
      const nameOff = line.indexOf(m[1], staticOff);
      if (nameOff < 0 || line.substring(staticOff, nameOff).includes('(')) continue;
      staticNames.add(m[1]);
    }

    const commentRanges = _getCommentRanges(model);
    const decs = [];
    for (const name of staticNames) {
      const matches = model.findMatches(`(?<![>.\\w])${name}(?!\\w)`, false, true, true, null, false, model.getLineCount() * 5);
      for (const match of matches) {
        if (_isInCommentOrString(commentRanges, match.range)) continue;
        // struct/enum/union の直後は型名として使われているのでスキップ
        const lineContent = model.getLineContent(match.range.startLineNumber);
        const before = lineContent.substring(0, match.range.startColumn - 1);
        if (/\b(?:struct|enum|union)\s+$/.test(before)) continue;
        decs.push({ range: match.range, options: { description: 'static-var', inlineClassName: 'monaco-static-var' } });
      }
    }
    if (_staticVarDec) { _staticVarDec.set(decs); } else { _staticVarDec = editor.createDecorationsCollection(decs); }
  }

  function _scheduleStaticDecorations() {
    clearTimeout(_staticVarTimer);
    _staticVarTimer = setTimeout(_applyStaticDecorations, 300);
  }

  editor.onDidChangeModel(_scheduleStaticDecorations);
  editor.onDidChangeModelContent(_scheduleStaticDecorations);

  // ===== 関数呼び出しハイライト =====
  const FUNC_CALL_SKIP = new Set([
    'if','else','while','for','switch','return','sizeof','typeof','do',
    'case','break','continue','goto','default','defined','offsetof',
  ]);
  let _funcDec = null; // IEditorDecorationsCollection
  let _funcDecTimer = null;

  function _applyFuncDecorations() {
    const model = editor.getModel();
    if (!model) { if (_funcDec) _funcDec.clear(); return; }
    const lang = model.getLanguageId();
    if (lang !== 'c' && lang !== 'cpp') { if (_funcDec) _funcDec.clear(); return; }

    const commentRanges = _getCommentRanges(model);
    const matches = model.findMatches(`[a-zA-Z_]\\w*\\s*\\(`, false, true, false, null, true, model.getLineCount() * 10);
    const decs = [];
    for (const m of matches) {
      const fullText = m.matches[0];
      const name = fullText.match(/^([a-zA-Z_]\w*)/)[1];
      if (FUNC_CALL_SKIP.has(name)) continue;
      const r = m.range;
      const funcRange = new monaco.Range(r.startLineNumber, r.startColumn, r.startLineNumber, r.startColumn + name.length);
      if (_isInCommentOrString(commentRanges, funcRange)) continue;
      decs.push({
        range: funcRange,
        options: { description: 'func-call', inlineClassName: 'monaco-local-func' }
      });
    }
    if (_funcDec) { _funcDec.set(decs); } else { _funcDec = editor.createDecorationsCollection(decs); }
  }

  function _scheduleFuncDecorations() {
    clearTimeout(_funcDecTimer);
    _funcDecTimer = setTimeout(_applyFuncDecorations, 400);
  }

  editor.onDidChangeModel(_scheduleFuncDecorations);
  editor.onDidChangeModelContent(_scheduleFuncDecorations);

  // ===== define マクロハイライト =====
  // ctagsインデックスのdefine/enum_memberをハイライト。
  let _macroDec = null; // IEditorDecorationsCollection
  let _macroDecTimer = null;
  let _macroNamesCache = null; // { macros: Set } | null

  // ctagsインデックス再生成後にキャッシュをクリアするためのフック
  const _origSetStatus = window._ctagsSetStatus;
  window._ctagsSetStatus = function(d) {
    if (_origSetStatus) _origSetStatus(d);
    _macroNamesCache = null;
    _scheduleMacroDecorations();
  };

  async function _fetchMacroNames(filePath) {
    if (_macroNamesCache !== null) return _macroNamesCache;
    if (!window._ctagsIndexed || !window._ctagsIndexed()) return null;
    if (!filePath) return null;
    try {
      const r = await fetch('/api/ctags/macros?file=' + encodeURIComponent(filePath));
      if (!r.ok) return null;
      const d = await r.json();
      if (d.loading) {
        setTimeout(_scheduleMacroDecorations, 3000);
        return null;
      }
      if (!d.ready) return null;
      _macroNamesCache = { macros: new Set(d.macros || []) };
      return _macroNamesCache;
    } catch {
      return null;
    }
  }

  async function _applyMacroDecorations() {
    const model = editor.getModel();
    if (!model) {
      if (_macroDec) _macroDec.clear();
      return;
    }
    const lang = model.getLanguageId();
    if (lang !== 'c' && lang !== 'cpp') {
      if (_macroDec) _macroDec.clear();
      return;
    }

    const commentRanges = _getCommentRanges(model);
    const filePath = model.uri.scheme === 'grepnavi'
      ? model.uri.path.replace(/^\/([A-Za-z]:)/, '$1').replace(/\//g, '\\')
      : (model.uri.fsPath || model.uri.path);
    const expectedUri = model.uri.toString();
    const cache = await _fetchMacroNames(filePath);
    if (editor.getModel()?.uri.toString() !== expectedUri) return;
    const macroDecs = [];

    if (cache) {
      const matches = model.findMatches(`(?<!\\w)[A-Za-z_][A-Za-z0-9_]+(?!\\w)`, false, true, true, null, true, model.getLineCount() * 20);
      for (const m of matches) {
        const name = m.matches[0];
        if (_isInCommentOrString(commentRanges, m.range)) continue;
        if (cache.macros.has(name)) {
          macroDecs.push({ range: m.range, options: { description: 'macro', inlineClassName: 'monaco-define-macro' } });
        }
      }
    }

    if (_macroDec) {
      _macroDec.set(macroDecs);
    } else {
      _macroDec = editor.createDecorationsCollection(macroDecs);
    }
  }

  function _scheduleMacroDecorations() {
    clearTimeout(_macroDecTimer);
    _macroDecTimer = setTimeout(_applyMacroDecorations, 500);
  }

  editor.onDidChangeModel(() => { _macroNamesCache = null; _commentRangesCache = null; _scheduleMacroDecorations(); });
  editor.onDidChangeModelContent(_scheduleMacroDecorations);

  // ===== ローカル変数・関数引数のホバー処理 =====
  //
  // resolveLocalVar(model, word, position) の戻り値:
  //   false          → ローカル変数ではない → 通常の gtags ルックアップ
  //   null           → 引数など（宣言テキスト取れない）→ ホバー抑制
  //   { decl }       → ローカル/static 変数 → 宣言テキストをホバー表示
  function resolveLocalVar(model, w, position) {
    const lang = model.getLanguageId();
    if (lang !== 'c' && lang !== 'cpp') return false;

    const scanStart = Math.max(1, position.lineNumber - 200);

    // インデントあり宣言（関数内ローカル変数）
    const reLocal = new RegExp(
      String.raw`^\s+(?:\w+\s+)+\**\s*\b` + w + String.raw`\b\s*[=;,\[]`
    );
    // 現在行用（インデントなしも含む）
    const reLocalNoIndent = new RegExp(
      String.raw`^\s*(?:\w+\s+)+\**\s*\b` + w + String.raw`\b\s*[=;,\[]`
    );
    // ファイルスコープの static/extern 宣言（インデントなし）
    const reFileScope = new RegExp(
      String.raw`^(?:static|extern)\b(?:\s+\w+)+\s*\**\s*\b` + w + String.raw`\b\s*[=;,\[]`
    );
    // 関数引数
    const reParam = new RegExp(
      String.raw`[\(,]\s*(?:\w+\s+)+\**\s*\b` + w + String.raw`\b\s*[,\)]`
    );

    const reWord = new RegExp(String.raw`\b` + w + String.raw`\b`);

    // 宣言行から型名を抽出（C キーワード以外の最後の識別子）
    // null → プリミティブのみ or 型不明 → ホバー抑制
    function extractType(line) {
      const varIdx = line.search(reWord);
      if (varIdx < 0) return null;
      const typeWords = (line.substring(0, varIdx).match(/[a-zA-Z_]\w*/g) || [])
        .filter(w2 => !_C_KEYWORDS.has(w2));
      return typeWords.length ? typeWords[typeWords.length - 1] : null;
    }

    // Pass 1: 直近 200 行をスキャン（引数・インデントありローカル変数）
    // ファイルスコープ宣言はここでは拾わず Pass 2 に委ねる（#ifdef 複数行対応）
    for (let ln = position.lineNumber; ln >= scanStart; ln--) {
      const line = model.getLineContent(ln);
      if (ln === position.lineNumber) {
        if (reParam.test(line)) return null;
        if (reLocalNoIndent.test(line)) {
          const t = extractType(line);
          if (t) return { decl: line.trim() };
          // キーワードのみ（`return w;` 等）→ スキャン継続
        }
      } else {
        if (reParam.test(line)) return null;
        if (reLocal.test(line)) {
          return extractType(line) ? { decl: line.trim() } : null;
        }
      }
    }

    // Pass 2: ファイル先頭から現在行までを順スキャンしてファイルスコープ宣言を全収集
    // （#ifdef 分岐で複数の宣言がある場合もすべて表示）
    const fileScopeDecls = [];
    for (let ln = 1; ln < position.lineNumber; ln++) {
      const line = model.getLineContent(ln);
      if (reFileScope.test(line) && extractType(line)) {
        fileScopeDecls.push(line.trim());
      }
    }
    if (fileScopeDecls.length > 0) {
      const unique = [...new Set(fileScopeDecls)];
      return { decl: unique.join('\n') };
    }

    return false;
  }

  return { resolveLocalVar };
}

if (typeof module !== 'undefined') module.exports = { initEditorC };

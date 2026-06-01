// ===== /api/editor-state pusher =====
// Monaco editor の状態 (active file, cursor, selection, viewport) を
// 200ms throttle + 値変化検知付きで server に PUT する。
// MCP bridge 経由で AI が grepnavi_editor_state ツールを呼ぶと、
// この cache を経由して user が今どこを見ているかを取得できる。
//
// 信頼性の設計:
//   - throttle 200ms: cursor 連打で server を叩かない
//   - 値変化検知 (JSON diff): 同じ state の再送を防ぐ
//   - heartbeat 10s: 何も操作してなくても定期的に PUT → server 側で
//     "fresh" 判定 (20s 窓) が維持される。AI 側に「browser 接続されてる」
//     という情報を提供
//   - visibilitychange hook: background タブに移ったら heartbeat 停止 →
//     20s で fresh=false に落ちる → AI が "user 不在" を検知できる
//   - 初期 push は ensureEditor 完了直後の 1 回

(function () {
  const PUSH_THROTTLE_MS = 200;
  const HEARTBEAT_MS = 10000;

  let _pushTimer = null;
  let _heartbeatTimer = null;
  let _lastPushedKey = '';
  let _started = false;

  function _captureEditorState() {
    if (typeof monacoEditor === 'undefined' || !monacoEditor) return null;
    if (typeof tabs === 'undefined' || typeof activeTabIdx === 'undefined') return null;
    const tab = tabs[activeTabIdx];
    if (!tab || !tab.file) return null;
    const pos = monacoEditor.getPosition();
    const sel = monacoEditor.getSelection();
    let viewport = null;
    try {
      const ranges = monacoEditor.getVisibleRanges() || [];
      if (ranges.length > 0) {
        viewport = {
          top_line:    ranges[0].startLineNumber,
          bottom_line: ranges[ranges.length - 1].endLineNumber,
        };
      }
    } catch (_) {}
    const state = {
      root:        (typeof projectRoot !== 'undefined' && projectRoot) || '',
      active_file: tab.file,
    };
    if (pos) state.cursor = { line: pos.lineNumber, column: pos.column };
    if (sel && !sel.isEmpty()) {
      state.selection = {
        start_line:   sel.startLineNumber,
        start_column: sel.startColumn,
        end_line:     sel.endLineNumber,
        end_column:   sel.endColumn,
      };
    }
    if (viewport) state.viewport = viewport;
    return state;
  }

  function _push(force) {
    const state = _captureEditorState();
    if (!state) return;
    const key = JSON.stringify(state);
    // 値変化が無いときは force=true (heartbeat) のときだけ送る。
    // heartbeat は値が同じでも server の lastUpdated を進めて fresh を維持する必要がある。
    if (!force && key === _lastPushedKey) return;
    _lastPushedKey = key;
    fetch('/api/editor-state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: key,
    }).catch(() => { /* network エラーは無視。次回 push で復帰 */ });
  }

  function _schedulePush() {
    clearTimeout(_pushTimer);
    _pushTimer = setTimeout(() => _push(false), PUSH_THROTTLE_MS);
  }

  function _startHeartbeat() {
    clearInterval(_heartbeatTimer);
    _heartbeatTimer = setInterval(() => _push(true), HEARTBEAT_MS);
  }

  function _stopHeartbeat() {
    clearInterval(_heartbeatTimer);
    _heartbeatTimer = null;
  }

  function _onVisibilityChange() {
    if (document.hidden) {
      // background タブに移った → heartbeat 止める →
      // 20s 後に server 側で fresh=false 確定。AI 側に「user 離席」が伝わる。
      _stopHeartbeat();
    } else {
      // foreground 復帰 → 即座に push して fresh 復元
      _push(true);
      _startHeartbeat();
    }
  }

  // editor.js の ensureEditor() / switchTab() 等から呼ばれる起動点。
  // 多重呼び出し可 (idempotent)。
  window.startEditorStateSync = function () {
    if (typeof monacoEditor === 'undefined' || !monacoEditor) return;
    if (_started) {
      _push(false);
      return;
    }
    _started = true;
    monacoEditor.onDidChangeCursorPosition(_schedulePush);
    monacoEditor.onDidChangeCursorSelection(_schedulePush);
    monacoEditor.onDidScrollChange(_schedulePush);
    document.addEventListener('visibilitychange', _onVisibilityChange);
    _startHeartbeat();
    _push(true);
  };

  // タブ切り替え等で active_file が変わった瞬間に push したいときの公開 API。
  window.bumpEditorStateSync = function () { _schedulePush(); };
})();

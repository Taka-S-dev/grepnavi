function toggleHelp() { id('help-overlay').classList.toggle('open'); }
function closeHelp()  { id('help-overlay').classList.remove('open'); }

// Monaco エディタ内部の非同期キャンセル（Canceled）を抑制
window.addEventListener('unhandledrejection', e => {
  if(e.reason && e.reason.message === 'Canceled') e.preventDefault();
});

// ===== アドオンパネルのぶん本体を狭める =====
// 右から出るパネル (.side-panel) は position:fixed のかぶせなので、そのままだと
// エディタの縦スクロールバーとミニマップがパネルの下に入って掴めなくなる。
// 開いている中で一番広いものの幅を CSS 変数に出し、#workspace をその分狭める。
// パネル側は幅をリサイザーで変えるので、class だけでなく寸法の変化も見る。
// Monaco は automaticLayout なので、コンテナが狭まれば自分で追従する。
function sidePanelWidth(doc = document) {
  let w = 0;
  for (const p of doc.querySelectorAll('.side-panel.open')) {
    w = Math.max(w, p.getBoundingClientRect().width);
  }
  return w;
}

function syncSidePanelWidth() {
  const w = sidePanelWidth();
  document.documentElement.style.setProperty('--side-panel-w', w ? w + 'px' : '0px');
}

function initSidePanelLayout() {
  let pending = false;
  const schedule = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; syncSidePanelWidth(); });
  };
  const sizeObserver = new ResizeObserver(schedule);
  const observed = new WeakSet();
  const attach = () => {
    for (const p of document.querySelectorAll('.side-panel')) {
      if (observed.has(p)) continue;
      observed.add(p);
      sizeObserver.observe(p);
    }
  };
  // アドオンはそれぞれ自分のタイミングで DOM を作るので、後から現れる分も拾う。
  new MutationObserver(() => { attach(); schedule(); })
    .observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
  attach();
  schedule();
}

// ===== 起動オーバーレイ =====
// 起動時の準備ステップを一覧表示し、全部完了したら閉じる。何を待っているか・何が
// 遅いか（スピナー中の行＝ボトルネック、完了行＝所要秒数）をユーザが目視できる。
// 万一どこかでハングしても残り続けないよう、安全タイマーで必ず除去する。
let _bootOverlayHidden = false;
function hideBootOverlay() {
  if (_bootOverlayHidden) return;
  _bootOverlayHidden = true;
  const el = document.getElementById('boot-overlay');
  if (!el) return;
  el.classList.add('hidden');
  setTimeout(() => el.remove(), 300); // フェードアウト後に DOM から除去
}

// 準備ステップ管理。全ステップは起動前にここで登録しておく（途中登録だと、先に
// 登録済みの分が全部 done になった瞬間に早閉じしてしまうため）。
const _bootSteps = new Map(); // name -> {label, done, t0, ms}
function bootRegister(name, label) {
  if (!_bootSteps.has(name)) _bootSteps.set(name, { label, done: false, t0: performance.now() });
}
function bootDone(name) {
  const s = _bootSteps.get(name);
  if (!s || s.done) return;
  s.done = true;
  s.ms = performance.now() - s.t0;
  renderBootSteps();
  for (const st of _bootSteps.values()) if (!st.done) return; // 全完了で閉じる
  hideBootOverlay();
}
function renderBootSteps() {
  const list = document.getElementById('boot-steps');
  if (!list) return;
  list.innerHTML = '';
  for (const s of _bootSteps.values()) {
    const row = document.createElement('div');
    row.className = 'boot-step' + (s.done ? ' done' : '');
    const ico  = s.done ? '<span class="boot-step-ico ok">✓</span>'
                        : '<span class="boot-step-ico spin"></span>';
    const time = s.done ? `<span class="boot-step-time">${(s.ms / 1000).toFixed(1)}s</span>` : '';
    row.innerHTML = `${ico}<span class="boot-step-label">${s.label}</span>${time}`;
    list.appendChild(row);
  }
}
window.bootDone = bootDone;

// 待機する準備ステップを登録（'defengine' は gtags.js の fetchStatus が完了させる）。
bootRegister('graph',     'グラフ復元');
bootRegister('editor',    'エディタ初期化');
bootRegister('defengine', '定義エンジン (gtags/ctags)');
renderBootSteps();
setTimeout(hideBootOverlay, 12000);

// ===== BOOT =====
addEventListener('DOMContentLoaded', async () => {
  initSidePanelLayout();

  id('tree').addEventListener('wheel', e => {
    e.preventDefault();
    id('tree').scrollTop += e.deltaY * 0.4;
  }, { passive: false });

  id('btn-s').onclick = doSearch;

  // ===== 左パネルタブ切り替え =====
  function switchLeftTab(tab) {
    const isExplorer = tab === 'explorer';
    const isProjects = tab === 'projects';
    const isNodes    = tab === 'nodes';
    const isSymbols  = tab === 'symbols';
    const isSearch   = !isExplorer && !isProjects && !isNodes && !isSymbols;
    id('tab-search').classList.toggle('active', isSearch);
    id('tab-explorer').classList.toggle('active', isExplorer);
    id('tab-projects').classList.toggle('active', isProjects);
    id('tab-nodes')?.classList.toggle('active', isNodes);
    id('tab-symbols')?.classList.toggle('active', isSymbols);
    id('explorer-panel').classList.toggle('visible', isExplorer);
    id('projects-panel').classList.toggle('visible', isProjects);
    id('nodes-panel')?.classList.toggle('visible', isNodes);
    id('symbols-panel')?.classList.toggle('visible', isSymbols);
    id('search-panel').style.display  = isSearch ? '' : 'none';
    id('pane-search').style.display   = isSearch ? '' : 'none';
    if(isExplorer) explorerShow();
    if(isSymbols && typeof symbolsPanelShow === 'function') symbolsPanelShow();
    if(isProjects) _renderProjectsPanel();
    // #pane-tree 自体を DOM 移動させて使う（リスナー・状態が DOM に紐付いてるので付いてくる）。
    const paneTree = id('pane-tree');
    if(paneTree) {
      if(isNodes) {
        const dest = id('nodes-panel');
        if(dest && paneTree.parentElement !== dest) dest.appendChild(paneTree);
      } else {
        const paneRight = id('pane-right');
        const peek = id('peek');
        if(paneRight && peek && paneTree.parentElement !== paneRight) {
          paneRight.insertBefore(paneTree, peek);
        }
      }
      if(typeof renderCurrent === 'function') renderCurrent();
    }
  }
  window.switchLeftTab = switchLeftTab;
  document.querySelectorAll('.activity-btn[data-tab]').forEach(btn => {
    btn.onclick = () => switchLeftTab(btn.dataset.tab);
  });
  id('act-settings').onclick = () => showSettingsModal();
  initExplorer();
  initProjectsPanel();

  initNodeCtxMenu();

  id('btn-stop').onclick = stopSearch;
  id('btn-clr').onclick = clearGraph;
  id('btn-tree-add').onclick = createTree;
  id('btn-view').onclick = toggleView;
  // chip 本体は表示専用。変更は ⚙ ボタンを意図的に押した時のみ
  // （narrow-scope のつもりで誤って chip 全体を押す事故を防ぐ）
  id('root-chip-change').onclick = e => { e.stopPropagation(); showRootDialog(); };
  id('btn-nav-back').onclick = navBack;
  id('btn-nav-fwd').onclick  = navForward;

  document.addEventListener('keydown', e => {
    // ナビゲーション履歴の戻る/進むは常時有効（call tree 等のサイドバーを
    // 開いたままジャンプして回る使い方を想定。どのアドオンともキーは衝突しない）
    if(e.altKey && e.key === 'ArrowLeft')  { e.preventDefault(); navBack(); return; }
    if(e.altKey && e.key === 'ArrowRight') { e.preventDefault(); navForward(); return; }
    // Ctrl+Z の位置がそのまま「戻る」になるので、ランチャー(Alt+A)の
    // Z / X と同じ文字で覚えられる
    if(e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      const k = e.key.toLowerCase();
      if(k === 'z') { e.preventDefault(); navBack(); return; }
      if(k === 'x') { e.preventDefault(); navForward(); return; }
    }
    // 挿入ダイアログは背面を触れるので、Escape を押す時点でフォーカスが
    // エディタやピークにあることが多い。閉じる順は「ピーク → ダイアログ」で、
    // 直前に開いた参照窓から畳む。
    // 他のオーバーレイが開いているときは手を出さない。あちらの Escape 処理は
    // 伝播を止めないものがあり、ここで一緒に閉じると書きかけを巻き添えにする。
    if(e.key === 'Escape' && !document.querySelector(
        '#fzf-overlay.open, #gn-dialog.open, #input-modal.open, #help-overlay.open, #fb-overlay.open, #project-modal.open, ' +
        '#node-label-modal.open, #node-memo-modal.open, #node-line-modal.open, ' +
        '#node-badge-modal.open, #node-sync-modal.open, #node-expand-modal.open, #settings-modal.open')) {
      if(window.closeTopFloatingDef?.()) return;
      const insDlg = document.getElementById('insert-dialog-modal');
      if(insDlg?.classList.contains('open') && typeof closeInsertDialog === 'function') {
        closeInsertDialog();
        return;
      }
    }
    // オーバーレイ/サイドバー表示中は F3 等の誤発火を防ぐため以降を無効化
    if(document.querySelector('#include-overlay.open, #ct-sidebar.open')) return;
    if(e.key === 'F3' && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      // 直前にピッカーから選んでいれば、その一覧を送る（grep 結果より優先）
      if(!refStepJump(e.shiftKey ? -1 : 1)) jumpResult(e.shiftKey ? -1 : 1);
    }
    if((e.ctrlKey || e.metaKey) && e.key === 'p') { e.preventDefault(); openFzf('file'); }
    // Ctrl+T はブラウザ予約 (新規タブ) で奪えず、Alt+T は移動系（コールツリー）に
    // 譲ったので Alt+Shift+T。Ctrl+P 内の `#` プレフィックスでも入れる
    if(e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 't') { e.preventDefault(); openFzf('symbol'); }
    if((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'O') { e.preventDefault(); showFileBrowser('open-file'); }
    if((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
      // 検索タブ以外（エクスプローラ・シンボル・プロジェクト・ノード）を開いて
      // いるときは grep 検索へ戻す。個別パネル名で判定すると、パネルが増える
      // たびにここが漏れる（シンボルパネル追加で実際に漏れた）。
      if(id('search-panel').style.display === 'none') {
        e.preventDefault();
        id('tab-search').click();
        id('q')?.focus();
        id('q')?.select();
      }
    }
    if(e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const tag = document.activeElement?.tagName;
      if(tag !== 'INPUT' && tag !== 'TEXTAREA') { e.preventDefault(); toggleHelp(); }
    }
    if(e.key === 'Escape') {
      closeHelp(); if(typeof _incCancelExpand === 'function') _incCancelExpand();
    }
  });

  id('fzf-input').addEventListener('input', e => {
    fzfRender(e.target.value);
    // 参照・代入の一覧は絞り込みをサーバへ送り直す（索引が返した全件に届く）。
    // 呼び先は1関数ぶんしかないので手元の絞り込みで足りる
    if(fzfMode === 'ref' && fzfRefWord) fzfReloadRefs(e.target.value);
  });
  id('fzf-input').addEventListener('keydown', e => {
    if(e.key === 'ArrowDown')  { e.preventDefault(); fzfMoveSel(1); }
    if(e.key === 'ArrowUp')    { e.preventDefault(); fzfMoveSel(-1); }
    if(e.key === 'Enter')      { fzfActivate(fzfSelIdx); }
    if(e.key === 'Escape')     { closeFzf(); }
    // 代入一覧から一段深い見方へ。同じ問い（どこで書き換えているか）に
    // 一覧とパネルの2つの答えがあると、どちらを開くか決められない。
    // 速い方を既定にして、値まで見たいときだけ深い方へ渡す
    if(e.altKey && (e.key === 's' || e.key === 'S') && fzfMode === 'ref'
       && typeof window.openStateMachine === 'function' && fzfRefWord) {
      e.preventDefault();
      const w = fzfRefWord;
      closeFzf();
      window.openStateMachine(w);
    }
  });
  id('fzf-overlay').addEventListener('click', e => { if(e.target === id('fzf-overlay')) closeFzf(); });
  id('help-overlay').addEventListener('click', e => { if(e.target === id('help-overlay')) closeHelp(); });

  id('btn-project-menu').onclick = e => {
    e.stopPropagation();
    const menu = id('project-menu');
    menu.classList.toggle('open');
    if(menu.classList.contains('open')) {
      // position:fixed なのでボタン位置から座標を計算（ペインの overflow:hidden に
      // クリップされず、エディタペインに被せて全体を表示できる）。
      const r = id('btn-project-menu').getBoundingClientRect();
      menu.style.top = (r.bottom + 2) + 'px';
      menu.style.right = (window.innerWidth - r.right) + 'px';
      menu.style.left = 'auto';
      updateProjectUI(); // 開くたびにノード数・保存状態を取り直す
      refreshRecoverItem();
      _updateTopMenuGraphs();
    }
  };
  document.addEventListener('click', () => id('project-menu').classList.remove('open'));
  // ステータス行はメニュー項目ではないので、クリックで閉じない（パスを選択してコピーできる）
  id('pmenu-status')?.addEventListener('click', e => e.stopPropagation());

  id('btn-filter-help')?.addEventListener('click', e => {
    e.stopPropagation();
    id('filter-help')?.classList.toggle('open');
  });
  document.addEventListener('click', () => id('filter-help')?.classList.remove('open'));
  id('pmenu-new-window').onclick = () => { id('project-menu').classList.remove('open'); openNewWindow(); };
  id('pmenu-new').onclick        = async () => {
    id('project-menu').classList.remove('open');
    // 新規JSON は現在のファイルから detach する (ResetInMemory: filePath="" にして保存しない)。
    // DELETE /api/graph は ClearActiveTree が現在のファイルに空を上書き保存してしまうため使わない。
    const r = await fetch('/api/graph/clear', { method: 'POST' });
    const d = await r.json();
    if(!d.error) { selNode = null; applyGraphResponse(d); }
    if(typeof setProjectPath === 'function') setProjectPath('');
    localStorage.removeItem('grepnavi_project_root');
    updateProjectUI();
  };
  id('pmenu-recover').onclick    = () => { id('project-menu').classList.remove('open'); restorePreviousWork(); };
  id('pmenu-open').onclick       = () => { id('project-menu').classList.remove('open'); openProjectFilePicker(); };
  id('pmenu-saveas').onclick     = () => { id('project-menu').classList.remove('open'); saveAsProjectFilePicker(); };
  id('pmenu-save').onclick       = () => { id('project-menu').classList.remove('open'); saveProjectFileCurrent(); };
  id('pmenu-desc').onclick       = () => { id('project-menu').classList.remove('open'); if (typeof editGraphDesc === 'function') editGraphDesc(); };
  id('pmenu-settings').onclick   = () => { id('project-menu').classList.remove('open'); showSettingsModal(); };

  document.addEventListener('keydown', async e => {
    if((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
      // Monaco がフォーカスを持っているときはエディタ側のアンドゥに任せる
      if(monacoEditor && monacoEditor.hasTextFocus()) return;
      // 入力欄でも同じ。ここで奪うと、書いている文字が戻らないうえに
      // グラフ側の操作が黙って1つ取り消される (memo-list.js の Ctrl+Z と同じ規約)。
      const tag = document.activeElement?.tagName;
      if(tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;
      e.preventDefault();
      const r = await fetch('/api/graph/undo', {method: 'POST'});
      const d = await r.json();
      if(d.error) { st('元に戻せません: ' + d.error); return; }
      applyGraphResponse(d);
      st('元に戻した');
    }
  });

  document.addEventListener('keydown', e => {
    if(e.ctrlKey && e.key === 's') {
      e.preventDefault();
      saveProjectFileCurrent();
    }
    if((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'N') {
      e.preventDefault();
      openNewWindow();
    }
  });

  id('project-modal-cancel').onclick = closeProjectModal;
  id('project-modal-ok').onclick = onProjectModalOk;
  id('project-modal-input').onkeydown = e => {
    if(e.key === 'Enter') onProjectModalOk();
    if(e.key === 'Escape') closeProjectModal();
  };
  updateProjectUI();

  id('q').onkeydown = e => { if(e.key==='Enter') doSearch(); };
  id('ifdef-apply').onclick = applyIfdefHighlight;
  id('ifdef-clear').onclick = clearIfdefHighlight;
  id('ifdef-cond').onkeydown = e => { if(e.key==='Enter') applyIfdefHighlight(); };

  const btnLmt = id('btn-line-memo-toggle');
  if(btnLmt) {
    btnLmt.onclick = toggleLineMemoInline;
    btnLmt.classList.toggle('on', showLineMemoInline);
    btnLmt.style.background = showLineMemoInline ? '#094771' : '';
  }
  document.addEventListener('keydown', e => {
    if(e.altKey && e.key === 'm') { e.preventDefault(); toggleLineMemoInline(); }
  });

  const btnNs = id('btn-node-sub');
  if(btnNs) {
    // デフォルト非表示（コンパクト）
    id('tree').classList.add('hide-sub');
    btnNs.classList.remove('on');
    btnNs.style.background = '';
    btnNs.onclick = () => {
      const hidden = id('tree').classList.toggle('hide-sub');
      btnNs.classList.toggle('on', !hidden);
      btnNs.style.background = !hidden ? '#094771' : '';
    };
  }
  // Alt+P はエディタの「デバッグ行を挿入」が持つ。document で拾うとエディタに
  // フォーカスがあっても一緒に発火し、挿入ダイアログとパス表示が同時に動く
  document.addEventListener('keydown', e => {
    if(e.altKey && e.shiftKey && e.key.toLowerCase() === 'p') { e.preventDefault(); id('btn-node-sub')?.click(); }
  });

  const btnTm = id('btn-tree-memo');
  if(btnTm) {
    btnTm.onclick = () => {
      showTreeMemos = !showTreeMemos;
      btnTm.classList.toggle('on', showTreeMemos);
      btnTm.style.background = showTreeMemos ? '#094771' : '';
      if(viewMode === 'tree') renderCurrent();
    };
  }
  document.addEventListener('keydown', e => {
    // Alt+N はエディタの「メモを追加/編集」が持つ（Alt+P も同様に Shift 付きへ）
    if(e.altKey && e.shiftKey && e.key.toLowerCase() === 'n') { e.preventDefault(); id('btn-tree-memo')?.click(); }
  });

  document.addEventListener('keydown', e => {
    if(!e.shiftKey || !e.altKey) return;
    if(e.key !== 'ArrowUp' && e.key !== 'ArrowDown' && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const tag = document.activeElement?.tagName;
    if(tag === 'INPUT' || tag === 'TEXTAREA') return;
    e.preventDefault();
    e.stopPropagation();
    if(e.key === 'ArrowUp')    moveNodeUp();
    if(e.key === 'ArrowDown')  moveNodeDown();
    if(e.key === 'ArrowLeft')  moveNodeLevelUp();
    if(e.key === 'ArrowRight') moveNodeLevelDown();
  }, true);

  document.addEventListener('keydown', e => {
    if(e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    if(e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
    if(document.activeElement?.id !== 'tree') return;
    if(viewMode !== 'tree') return;
    e.preventDefault();
    const rows = [...document.querySelectorAll('#tree .node-row')];
    if(!rows.length) return;
    const curIdx = rows.findIndex(r => r.dataset.id === selNode);
    const next = e.key === 'ArrowUp'
      ? rows[Math.max(0, curIdx <= 0 ? 0 : curIdx - 1)]
      : rows[Math.min(rows.length - 1, curIdx < 0 ? 0 : curIdx + 1)];
    if(next) { selectNode(next.dataset.id); next.scrollIntoView({block: 'nearest'}); }
  });

  document.addEventListener('keydown', e => {
    if(e.key !== 'F2') return;
    const tag = document.activeElement?.tagName;
    if(tag === 'INPUT' || tag === 'TEXTAREA') return;
    if(viewMode !== 'tree') return;
    e.preventDefault();
    triggerRenameSelectedNode();
  });

  // ツリー内の隙間でも "禁止" カーソルを出さない
  id('tree').addEventListener('dragover', e => {
    if(dragNodeId) e.preventDefault();
  });

  // ツリーペインを出たら insert-before/after インジケーターをクリア
  id('pane-tree').addEventListener('dragleave', e => {
    if(!id('pane-tree').contains(e.relatedTarget)) {
      document.querySelectorAll('.node.insert-before,.node.insert-after,.node-row.drag-over').forEach(el => {
        el.classList.remove('insert-before','insert-after','drag-over');
      });
    }
  });

  // ルートドロップゾーン
  const dropRoot = id('drop-root');
  dropRoot.ondragover = e => { e.preventDefault(); dropRoot.classList.add('drag-over'); };
  dropRoot.ondragleave = () => dropRoot.classList.remove('drag-over');
  dropRoot.ondrop = e => {
    e.preventDefault();
    dropHandled = true; // ondragend の二重処理を防ぐ
    dropRoot.classList.remove('drag-over');
    const movedId = dragNodeId;
    if(movedId) reparent(movedId, '');
  };

  // 前回の検索設定を復元
  const saved = JSON.parse(localStorage.getItem('grepnavi-settings') || '{}');
  if(saved.dir)  { id('dir').value  = saved.dir;  const dc = id('dir-clear');  if(dc) dc.style.display = ''; }
  if(saved.glob) { id('glob').value = saved.glob; const gc = id('glob-clear'); if(gc) gc.style.display = ''; }
  // 復元した dir / glob が非空なら、フィルタ欄を開いた状態で起動する。
  // 畳んだまま効かせると、glob はどこにも表示されず「理由の見えない絞り込み」になる
  // （dir はルートチップに出るが、glob の手掛かりはこの欄しか無い）。
  if(saved.dir || saved.glob) {
    id('bar-sub').classList.add('open');
    id('btn-toggle-sub').classList.add('open');
  }
  updateRootChip();
  if(saved.regex) id('btn-re').classList.toggle('on', !!saved.regex);
  if(saved.cs)    id('btn-cs').classList.toggle('on', !!saved.cs);
  if(saved.word)  id('btn-wb').classList.toggle('on', !!saved.word);
  if(saved.enc)   updateEncBtn(saved.enc);

  // 起動時のグラフ復元:
  // savedPath がある場合はまず開く。失敗時はサーバーが持っているグラフを使い、
  // それも無いときだけ .grepnavi の記録に頼る。
  //
  // サーバーのグラフを優先するのは、-graph で明示指定された場合と、新しい
  // ウィンドウ (port ごとの別グラフ + -reset-graph で空から始める) を壊さない
  // ため。localStorage は port ごとに別物なので、新しいウィンドウでは savedPath
  // が空になり、ここで .grepnavi を開くと「常に空で始まる」約束が崩れる。
  try {
    const savedPath = getProjectPath();
    let restored = false;
    if (savedPath) {
      restored = await openProject(savedPath);
    }
    if (!restored) {
      if (savedPath) setProjectPath('');
      await loadGraph();
      if (!window._serverGraphFile) {
        const gn = await (await fetch('/api/grepnavi')).json();
        const last = lastGraphOf(gn);
        if (last) await openProject(last);
      }
    }
  } catch(_) {
    await loadGraph();
  }
  bootDone('graph');

  initSearchBar();
  initFilter();
  initDirPicker();
  initGlobPicker();
  initColResizer();

  id('root-label').style.cursor = 'pointer';
  id('root-label').title = (projectRoot || '未設定') + ' (クリックで変更)';
  id('root-label').onclick = showRootDialog;

  // 起動時に root が設定されているかだけ確認する。/api/dirs は full dir walk なので
  // 巨大プロジェクトや AV ありの環境で startup を秒オーダーで止める。/api/root は
  // in-memory 文字列を返すだけなので瞬時。
  const rootRes = await fetch('/api/root').then(r=>r.json()).catch(()=>null);
  if(!rootRes || !rootRes.root) showRootDialog();

  // モードに応じたレイアウト適用
  if(pageMode === PAGE_MODES.SEARCH) {
    document.body.classList.add('search-mode');
    id('peek').classList.remove('visible');
    setTimeout(() => { id('q')?.focus(); id('q')?.select(); }, 0);
  } else {
    id('peek').classList.add('visible');
  }

  // Monaco のロード完了を 'editor' ステップとして記録（最も重い処理）。
  try { await (window.loadMonaco ? window.loadMonaco() : Promise.resolve()); } catch(_) {}
  bootDone('editor');

  st('準備完了');

  // エンコーディングボタン初期化（クリックで UTF-8 → SJIS → EUC-JP → UTF-16 を循環）
  const encBtn = id('enc-btn');
  if(encBtn) {
    encBtn.addEventListener('click', () => {
      const cur = encBtn.dataset.enc || '';
      const next = ENC_CYCLE[(ENC_CYCLE.indexOf(cur) + 1) % ENC_CYCLE.length];
      setSearchEnc(next);
    });
  }
});

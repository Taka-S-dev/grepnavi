function toggleHelp() { id('help-overlay').classList.toggle('open'); }
function closeHelp()  { id('help-overlay').classList.remove('open'); }

// Monaco エディタ内部の非同期キャンセル（Canceled）を抑制
window.addEventListener('unhandledrejection', e => {
  if(e.reason && e.reason.message === 'Canceled') e.preventDefault();
});

// ===== BOOT =====
addEventListener('DOMContentLoaded', async () => {
  id('btn-s').onclick = doSearch;
  id('btn-stop').onclick = stopSearch;
  id('btn-clr').onclick = clearGraph;
  id('btn-tree-add').onclick = createTree;
  id('btn-view').onclick = toggleView;
  id('root-chip').onclick = () => showRootDialog();
  id('btn-nav-back').onclick = navBack;
  id('btn-nav-fwd').onclick  = navForward;

  document.addEventListener('keydown', e => {
    if(e.altKey && e.key === 'ArrowLeft')  { e.preventDefault(); navBack(); }
    if(e.altKey && e.key === 'ArrowRight') { e.preventDefault(); navForward(); }
    if(e.key === 'F3' && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      jumpResult(e.shiftKey ? -1 : 1);
    }
    if((e.ctrlKey || e.metaKey) && e.key === 'p') { e.preventDefault(); openFzf(); }
    if((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'O') { e.preventDefault(); showFileBrowser('open-file'); }
    if(e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const tag = document.activeElement?.tagName;
      if(tag !== 'INPUT' && tag !== 'TEXTAREA') { e.preventDefault(); toggleHelp(); }
    }
    if(e.key === 'Escape') closeHelp();
  });

  id('fzf-input').addEventListener('input', e => fzfRender(e.target.value));
  id('fzf-input').addEventListener('keydown', e => {
    if(e.key === 'ArrowDown')  { e.preventDefault(); fzfMoveSel(1); }
    if(e.key === 'ArrowUp')    { e.preventDefault(); fzfMoveSel(-1); }
    if(e.key === 'Enter')      { if(fzfFiltered[fzfSelIdx]) fzfOpen(fzfFiltered[fzfSelIdx]); }
    if(e.key === 'Escape')     { closeFzf(); }
  });
  id('fzf-overlay').addEventListener('click', e => { if(e.target === id('fzf-overlay')) closeFzf(); });
  id('help-overlay').addEventListener('click', e => { if(e.target === id('help-overlay')) closeHelp(); });

  id('btn-project-menu').onclick = e => {
    e.stopPropagation();
    id('project-menu').classList.toggle('open');
  };
  document.addEventListener('click', () => id('project-menu').classList.remove('open'));
  id('pmenu-new-window').onclick = () => { id('project-menu').classList.remove('open'); openNewWindow(); };
  id('pmenu-open').onclick       = () => { id('project-menu').classList.remove('open'); openProjectFilePicker(); };
  id('fzf-browse-btn').onclick   = () => { closeFzf(); showFileBrowser('open-file'); };
  id('pmenu-saveas').onclick     = () => { id('project-menu').classList.remove('open'); saveAsProjectFilePicker(); };
  id('pmenu-save').onclick       = () => { id('project-menu').classList.remove('open'); saveProjectFileCurrent(); };

  document.addEventListener('keydown', async e => {
    if((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
      // Monaco がフォーカスを持っているときはエディタ側のアンドゥに任せる
      if(monacoEditor && monacoEditor.hasTextFocus()) return;
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
  document.addEventListener('keydown', e => {
    if(e.altKey && e.key === 'p') { e.preventDefault(); id('btn-node-sub')?.click(); }
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
    if(e.altKey && e.key === 'n') { e.preventDefault(); id('btn-tree-memo')?.click(); }
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
  if(saved.dir)  id('dir').value  = saved.dir;
  if(saved.glob) id('glob').value = saved.glob;
  updateRootChip();
  if(saved.regex) id('btn-re').classList.toggle('on', !!saved.regex);
  if(saved.cs)    id('btn-cs').classList.toggle('on', !!saved.cs);
  if(saved.word)  id('btn-wb').classList.toggle('on', !!saved.word);

  await loadGraph();

  // 前回開いていたプロジェクトファイルを自動で復元
  const _lastProject = getProjectPath();
  if(_lastProject) {
    try { await openProject(_lastProject); } catch(e) {}
  }

  initSearchBar();
  initFilter();
  initDirPicker();
  initGlobPicker();
  initColResizer();

  id('root-label').style.cursor = 'pointer';
  id('root-label').title = (projectRoot || '未設定') + ' (クリックで変更)';
  id('root-label').onclick = showRootDialog;

  const rootOk = await fetch('/api/dirs').then(r=>r.json()).catch(()=>null);
  if(!rootOk || rootOk.length === 0) showRootDialog();

  // URL モードに応じたレイアウト適用
  if(pageMode === 'panel') {
    document.body.classList.add('panel-mode');
    id('pane-right').style.display = 'none';
    id('col-resizer').style.display = 'none';
    id('peek').classList.remove('visible');

    // 検索タブ（組み込み）をタブバーに追加
    const tabBar = document.createElement('div');
    tabBar.id = 'panel-tabs';
    const searchBtn = document.createElement('button');
    searchBtn.className = 'panel-tab active';
    searchBtn.dataset.panelTab = 'search';
    searchBtn.textContent = '検索';
    searchBtn.onclick = () => switchPanelTab('search');
    tabBar.appendChild(searchBtn);
    id('pane-left').insertBefore(tabBar, id('pane-left').firstChild);
    // 登録済みパネルをタブに反映（app.js より先に registerPanel した分）
    flushPanelRegistry();
    // まだ登録されていない分は registerPanel 内で自動追加される
  } else if(pageMode === 'search') {
    id('pane-right')?.style.setProperty('display', 'none', 'important');
    id('col-resizer')?.style.setProperty('display', 'none', 'important');
    id('pane-left').style.width = '100%';
    id('peek').classList.remove('visible');
  } else if(pageMode === 'calltree') {
    id('pane-left')?.style.setProperty('display', 'none', 'important');
    id('col-resizer')?.style.setProperty('display', 'none', 'important');
    id('peek').classList.remove('visible');
    setTimeout(() => window.openCallTree?.(), 300);
  } else {
    id('peek').classList.add('visible');
  }

  st('準備完了');
});

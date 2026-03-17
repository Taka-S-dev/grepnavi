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
  });

  id('fzf-input').addEventListener('input', e => fzfRender(e.target.value));
  id('fzf-input').addEventListener('keydown', e => {
    if(e.key === 'ArrowDown')  { e.preventDefault(); fzfMoveSel(1); }
    if(e.key === 'ArrowUp')    { e.preventDefault(); fzfMoveSel(-1); }
    if(e.key === 'Enter')      { if(fzfFiltered[fzfSelIdx]) fzfOpen(fzfFiltered[fzfSelIdx]); }
    if(e.key === 'Escape')     { closeFzf(); }
  });
  id('fzf-overlay').addEventListener('click', e => { if(e.target === id('fzf-overlay')) closeFzf(); });

  id('btn-project-menu').onclick = e => {
    e.stopPropagation();
    id('project-menu').classList.toggle('open');
  };
  document.addEventListener('click', () => id('project-menu').classList.remove('open'));
  id('pmenu-open').onclick   = () => { id('project-menu').classList.remove('open'); showProjectModal('open'); };
  id('pmenu-saveas').onclick = () => { id('project-menu').classList.remove('open'); showProjectModal('save'); };
  id('pmenu-save').onclick   = async () => {
    id('project-menu').classList.remove('open');
    const p = getProjectPath();
    if(p) await saveProject(p);
    else showProjectModal('save');
  };

  document.addEventListener('keydown', async e => {
    if(e.ctrlKey && e.key === 's') {
      e.preventDefault();
      const p = getProjectPath();
      if(p) await saveProject(p);
      else showProjectModal('save');
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
    if(e.shiftKey && e.altKey) {
      if(e.key === 'ArrowUp')    { e.preventDefault(); moveNodeUp(); }
      if(e.key === 'ArrowDown')  { e.preventDefault(); moveNodeDown(); }
      if(e.key === 'ArrowLeft')  { e.preventDefault(); moveNodeLevelUp(); }
      if(e.key === 'ArrowRight') { e.preventDefault(); moveNodeLevelDown(); }
    }
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
  initSearchBar();
  initFilter();
  initDirPicker();
  initColResizer();

  id('root-label').style.cursor = 'pointer';
  id('root-label').title = (projectRoot || '未設定') + ' (クリックで変更)';
  id('root-label').onclick = showRootDialog;

  const rootOk = await fetch('/api/dirs').then(r=>r.json()).catch(()=>null);
  if(!rootOk || rootOk.length === 0) showRootDialog();

  id('peek').classList.add('visible');
  st('準備完了');
});

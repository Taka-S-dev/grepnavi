// ===== Project Manager Panel =====

let _projectsData = [];
let _expandedProjects = new Set(); // 展開中のプロジェクトID

async function initProjectsPanel() {
  await _loadProjects();
}

async function _loadProjects() {
  try {
    const res = await fetch('/api/projects');
    _projectsData = await res.json();
  } catch { _projectsData = []; }
  _renderProjectsPanel();
}

function _renderProjectsPanel() {
  const panel = id('projects-panel');
  if (!panel) return;

  const currentGraph = (typeof getProjectPath === 'function' ? getProjectPath() : '').replace(/\\/g, '/');
  const currentRoot  = (localStorage.getItem('grepnavi_project_root') || '').replace(/\\/g, '/');

  // 各 .json アイテム（ホバーで説明ツールチップを後付けする対象）を集める。
  const _descItems = [];

  panel.innerHTML = '';

  const hdr = document.createElement('div');
  hdr.className = 'projects-hdr';
  hdr.innerHTML =
    '<span class="projects-title">PROJECTS</span>' +
    '<button class="projects-add-btn" title="現在のJSONをプロジェクトに追加">' +
    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="8" y1="2" x2="8" y2="14"/><line x1="2" y1="8" x2="14" y2="8"/></svg>' +
    '</button>';
  hdr.querySelector('.projects-add-btn').onclick = _addCurrentProject;
  panel.appendChild(hdr);

  const list = document.createElement('div');
  list.className = 'projects-list';

  if (_projectsData.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'projects-empty';
    empty.textContent = '+ で現在の状態を保存';
    list.appendChild(empty);
  } else {
    _projectsData.forEach(proj => {
      const gnNorm = (proj.grepnaviFile || '').replace(/\\/g, '/');
      const projRoot = gnNorm.replace(/\/\.grepnavi$/, '').replace(/\\/g, '/');
      const isCurrentRoot = currentRoot && projRoot && currentRoot === projRoot;
      const isExpanded = _expandedProjects.has(proj.id);
      const graphs = proj.graphs || [];

      // ── プロジェクト行 ──
      const item = document.createElement('div');
      item.className = 'projects-item';
      item.title = proj.grepnaviFile;

      const arrow = document.createElement('span');
      arrow.className = 'projects-arrow' + (isExpanded ? ' open' : '');
      arrow.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10"><path d="M3 2l4 3-4 3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

      const folderIcon = document.createElement('span');
      folderIcon.className = 'projects-folder-icon';
      folderIcon.innerHTML = isExpanded
        ? '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="#c8a84b"><path d="M1 4a1 1 0 011-1h4l1.5 2H14a1 1 0 011 1v7a1 1 0 01-1 1H2a1 1 0 01-1-1V4z"/></svg>'
        : '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="#c8a84b" stroke-width="1.2"><path d="M1 4a1 1 0 011-1h4l1.5 2H14a1 1 0 011 1v7a1 1 0 01-1 1H2a1 1 0 01-1-1V4z"/></svg>';

      const info = document.createElement('div');
      info.className = 'projects-item-info';

      const nameEl = document.createElement('div');
      nameEl.className = 'projects-item-name';
      nameEl.textContent = proj.name;
      if (isCurrentRoot) {
        const dot = document.createElement('span');
        dot.style.cssText = 'display:inline-block;width:6px;height:6px;border-radius:50%;background:#4fc3f7;margin-left:5px;vertical-align:middle;flex-shrink:0';
        nameEl.appendChild(dot);
      }

      const pathEl = document.createElement('div');
      pathEl.className = 'projects-item-root';
      pathEl.textContent = projRoot;

      info.appendChild(nameEl);
      info.appendChild(pathEl);

      const delBtn = document.createElement('button');
      delBtn.className = 'projects-item-del';
      delBtn.title = '削除';
      delBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><polyline points="2,4 14,4"/><path d="M5 4V2h6v2"/><path d="M3 4l1 10h8l1-10"/></svg>';
      delBtn.onclick = async e => {
        e.stopPropagation();
        await fetch('/api/projects/' + proj.id, { method: 'DELETE' });
        _expandedProjects.delete(proj.id);
        await _loadProjects();
      };

      item.appendChild(arrow);
      item.appendChild(folderIcon);
      item.appendChild(info);
      item.appendChild(delBtn);
      item.onclick = e => {
        if (e.target.closest('.projects-item-del')) return;
        if (_expandedProjects.has(proj.id)) {
          _expandedProjects.delete(proj.id);
        } else {
          _expandedProjects.add(proj.id);
        }
        _renderProjectsPanel();
      };
      list.appendChild(item);

      // ── グラフ子リスト ──
      if (isExpanded) {
        const graphList = document.createElement('div');
        graphList.className = 'projects-graph-list';

        if (graphs.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'projects-graph-empty';
          empty.textContent = 'JSONなし';
          graphList.appendChild(empty);
        } else {
          graphs.forEach(gPath => {
            const gNorm = gPath.replace(/\\/g, '/');
            const gName = gNorm.split('/').pop();
            const isActive = currentGraph && gNorm === currentGraph;

            const gItem = document.createElement('div');
            gItem.className = 'projects-graph-item' + (isActive ? ' projects-graph-item--active' : '');
            gItem.title = gPath;

            const gIcon = document.createElement('span');
            gIcon.style.cssText = 'flex-shrink:0;display:inline-flex;align-items:center;opacity:0.6';
            gIcon.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M4 1h6l4 4v10H2V1z"/><path d="M10 1v4h4"/></svg>';

            const gNameEl = document.createElement('span');
            gNameEl.className = 'projects-graph-name';
            gNameEl.textContent = gName;

            const gDelBtn = document.createElement('button');
            gDelBtn.className = 'projects-item-del';
            gDelBtn.title = 'リストから削除';
            gDelBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><line x1="2" y1="2" x2="14" y2="14"/><line x1="14" y1="2" x2="2" y2="14"/></svg>';
            gDelBtn.onclick = async e => {
              e.stopPropagation();
              await _removeGraphFromProject(proj, gPath);
            };

            gItem.appendChild(gIcon);
            gItem.appendChild(gNameEl);
            gItem.appendChild(gDelBtn);
            gItem.onclick = e => {
              if (e.target.closest('.projects-item-del')) return;
              _switchToGraph(proj, gPath);
            };
            graphList.appendChild(gItem);
            _descItems.push({ path: gPath, el: gItem });
          });
        }
        list.appendChild(graphList);
      }
    });
  }

  panel.appendChild(list);
  _applyGraphDescs(_descItems);
}

// 各 .json の説明をまとめて取得し、パネルの項目にホバーツールチップとして付与する。
async function _applyGraphDescs(items) {
  if (!items.length) return;
  const paths = [...new Set(items.map(i => i.path))];
  let map = {};
  try {
    const res = await fetch('/api/graph/descriptions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths }),
    });
    map = await res.json();
  } catch { return; }
  items.forEach(({ path, el }) => {
    const desc = map[path];
    if (desc) el.title = path + '\n――――\n' + desc;
  });
}

async function _switchToGraph(proj, graphPath) {
  const currentGraph = (typeof getProjectPath === 'function' ? getProjectPath() : '').replace(/\\/g, '/');
  const normGraph = graphPath.replace(/\\/g, '/');
  if (normGraph === currentGraph) return;

  // JSON を開く（root_dir が設定されていればサーバー側でroot切り替えが起きる）
  if (typeof openProject === 'function') await openProject(graphPath);

  if (typeof setProjectPath === 'function') setProjectPath(graphPath);
  if (typeof markClean === 'function') markClean();

  _renderProjectsPanel();
  _updateTopMenuGraphs();
}

async function _removeGraphFromProject(proj, graphPath) {
  const newGraphs = (proj.graphs || []).filter(g =>
    g.replace(/\\/g, '/') !== graphPath.replace(/\\/g, '/')
  );
  await fetch('/api/grepnavi/graphs', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grepnaviFile: proj.grepnaviFile, graphs: newGraphs }),
  });
  await _loadProjects();
  _updateTopMenuGraphs();
}

async function _addCurrentProject() {
  const rootRes = await fetch('/api/root');
  const { root } = await rootRes.json();
  if (!root) { await showAlert('ルートが設定されていません'); return; }

  const graphPath = (typeof getProjectPath === 'function') ? getProjectPath() : '';
  if (!graphPath) { await showAlert('開いているJSONがありません'); return; }

  const gnPath = root.replace(/\\/g, '/') + '/.grepnavi';
  const existing = _projectsData.find(p =>
    (p.grepnaviFile || '').replace(/\\/g, '/') === gnPath
  );

  if (existing) {
    // 既存プロジェクトにグラフを追加
    await fetch('/api/grepnavi', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root, graph: graphPath }),
    });
    await _loadProjects();
    _expandedProjects.add(existing.id);
    _renderProjectsPanel();
    _updateTopMenuGraphs();
    return;
  }

  // 新規プロジェクト
  const parts = root.replace(/\\/g, '/').split('/');
  const suggested = parts[parts.length - 1] || root;
  const name = await showInputModal('プロジェクトを保存', 'プロジェクト名', suggested);
  if (!name) return;

  const gnRes = await fetch('/api/grepnavi', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root, graph: graphPath }),
  });
  if (!gnRes.ok) {
    const gnErr = await gnRes.json().catch(() => ({}));
    await showAlert('.grepnaviの書き込みに失敗しました: ' + (gnErr.error || gnRes.status));
    return;
  }

  const res = await fetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, grepnaviFile: gnPath }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    await showAlert('保存に失敗しました: ' + (err.error || res.status));
    return;
  }
  _projectsData = await res.json();
  const added = _projectsData.find(p => (p.grepnaviFile || '').replace(/\\/g, '/') === gnPath);
  if (added) _expandedProjects.add(added.id);
  _renderProjectsPanel();
  _updateTopMenuGraphs();
}

// 上部メニューのグラフリストを更新（現在rootの .grepnavi から直接取得）
async function _updateTopMenuGraphs() {
  const currentGraph = (typeof getProjectPath === 'function' ? getProjectPath() : '').replace(/\\/g, '/');

  document.querySelectorAll('.pmenu-graph-item, .pmenu-graph-sep').forEach(el => el.remove());

  let graphs = [];
  try {
    const res = await fetch('/api/grepnavi');
    const cfg = await res.json();
    graphs = cfg.graphs || [];
  } catch { return; }

  if (graphs.length === 0) return;

  // 各 .json の説明を取得し、名前にホバーしたとき「何の調査か」をツールチップ表示する。
  let descs = {};
  try {
    const dres = await fetch('/api/graph/descriptions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: graphs }),
    });
    descs = await dres.json();
  } catch {}

  const menu = id('project-menu');
  if (!menu) return;
  // json 一覧は「新規JSON」の直前（メニュー先頭）に差し込む。「新しいウィンドウ」を
  // 最下部に移したので、先頭はファイル操作（json 一覧 / 新規JSON / 開く…）でまとまる。
  const anchor = id('pmenu-new');
  if (!anchor) return;

  const section = document.createElement('div');
  section.className = 'pmenu-graph-section pmenu-graph-sep';
  menu.insertBefore(section, anchor);

  const sep = document.createElement('div');
  sep.className = 'pmenu-separator pmenu-graph-sep';
  menu.insertBefore(sep, anchor);

  graphs.forEach(gPath => {
    const gNorm = gPath.replace(/\\/g, '/');
    const gName = gNorm.split('/').pop();
    const isActive = currentGraph && gNorm === currentGraph;

    const item = document.createElement('div');
    item.className = 'pmenu-item pmenu-graph-item' + (isActive ? ' pmenu-graph-item--active' : '');
    item.style.cssText = 'display:flex;align-items:center;justify-content:space-between;';

    const nameSpan = document.createElement('span');
    nameSpan.textContent = gName;
    nameSpan.style.flex = '1';
    const desc = descs[gPath] || '';
    if (desc) { nameSpan.title = desc; nameSpan.style.cursor = 'help'; }

    const delBtn = document.createElement('button');
    delBtn.style.cssText = 'background:none;border:none;color:transparent;cursor:pointer;padding:1px 4px;border-radius:2px;flex-shrink:0;line-height:1;font-size:11px;';
    delBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="2" y1="2" x2="14" y2="14"/><line x1="14" y1="2" x2="2" y2="14"/></svg>';
    delBtn.title = 'リストから削除';
    delBtn.onmouseenter = () => { delBtn.style.color = '#f44'; };
    delBtn.onmouseleave = () => { delBtn.style.color = 'transparent'; };
    item.onmouseenter = () => { delBtn.style.color = '#666'; };
    item.onmouseleave = () => { delBtn.style.color = 'transparent'; };
    delBtn.onclick = async e => {
      e.stopPropagation();
      const newGraphs = graphs.filter(g => g.replace(/\\/g, '/') !== gNorm);
      await fetch('/api/grepnavi', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ graph: null, graphs: newGraphs }),
      });
      id('project-menu').classList.remove('open');
      await _loadProjects();
    };

    item.appendChild(nameSpan);
    item.appendChild(delBtn);
    item.onclick = e => {
      if (e.target.closest('button')) return;
      id('project-menu').classList.remove('open');
      if (typeof openProject === 'function') openProject(gPath);
    };
    section.appendChild(item);
  });
}

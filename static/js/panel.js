// ===== Panel Registry =====
// アドオンが registerPanel() を呼ぶことでパネルモードのタブに登録される。

const _panelRegistry = [];

function registerPanel({ id: panelId, label, containerId, onOpen }) {
  _panelRegistry.push({ id: panelId, label, containerId, onOpen });
  if(pageMode === 'panel') _applyPanelEntry({ id: panelId, label, containerId, onOpen });
}

// panel-tabs が存在する場合のみタブを追加する
function _applyPanelEntry({ id: panelId, label, containerId, onOpen }) {
  const tabBar = document.getElementById('panel-tabs');
  if(!tabBar) return;

  // 重複防止
  if(tabBar.querySelector(`[data-panel-tab="${panelId}"]`)) return;

  const container = document.getElementById(containerId);
  if(container) document.getElementById('pane-left').appendChild(container);

  const btn = document.createElement('button');
  btn.className = 'panel-tab';
  btn.dataset.panelTab = panelId;
  btn.textContent = label;
  btn.onclick = () => switchPanelTab(panelId);
  tabBar.appendChild(btn);
}

// app.js が panel-tabs を作成した後に呼ぶ
function flushPanelRegistry() {
  _panelRegistry.forEach(c => _applyPanelEntry(c));
}

function switchPanelTab(tabId) {
  const isSearch = tabId === 'search';

  const searchPanel = document.getElementById('search-panel');
  const paneSearch  = document.getElementById('pane-search');
  if(searchPanel) searchPanel.style.display = isSearch ? '' : 'none';
  if(paneSearch)  paneSearch.style.display  = isSearch ? '' : 'none';

  _panelRegistry.forEach(p => {
    const el = document.getElementById(p.containerId);
    if(!el) return;
    if(p.id === tabId) {
      el.classList.add('open');
      p.onOpen?.();
    } else {
      el.classList.remove('open');
    }
  });

  document.querySelectorAll('[data-panel-tab]').forEach(b => {
    b.classList.toggle('active', b.dataset.panelTab === tabId);
  });
}

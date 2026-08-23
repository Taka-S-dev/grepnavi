// 1行入力に付ける候補リスト。
// <datalist> はネイティブ描画で CSS が効かず、暗い画面に明るいポップアップが
// 浮くので、アプリ側で同じ見た目とキー操作を用意する。
// （コード欄の補完は Monaco 本体の補完ウィジェットが受け持つ。ここは
// 「テキスト入力に候補を出す」だけの軽い部品。）

// placePopupAt は (x, y) の直下にポップアップを置く。画面の端では上・左へ返す。
// 重なり順は取り付け先の器に合わせる: ダイアログは前面へ出るたびに z-index が
// 上がっていく（raiseAbovePeeks）ので、固定値だと下に潜る。
function placePopupAt(pop, hostEl, x, y, skipHeight, minWidth) {
  let z = 0;
  for (let el = hostEl.parentElement; el; el = el.parentElement) {
    const v = parseInt(getComputedStyle(el).zIndex, 10);
    if (!isNaN(v)) z = Math.max(z, v);
  }
  pop.style.zIndex = z + 1;
  pop.style.minWidth = minWidth ? minWidth + 'px' : '';
  pop.style.top = '0px';
  pop.style.left = '0px';
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  let left = x;
  if (left + w > window.innerWidth - 4) left = Math.max(4, window.innerWidth - 4 - w);
  const below = y + skipHeight + 2;
  const top = below + h <= window.innerHeight - 4 ? below : Math.max(4, y - h - 2);
  pop.style.left = Math.round(left) + 'px';
  pop.style.top = Math.round(top) + 'px';
}

// attachSuggestList は1行入力に候補リストを付ける。<datalist> はネイティブ描画で
// CSS が効かず、暗い画面に明るいポップアップが浮くので、アプリ側で同じ見た目
// （補完ポップアップと共通）と同じキー操作を用意する。
// getItems は [{label, detail}] を返す関数。フォーカスで全件、入力で絞り込む。
function attachSuggestList(input, getItems) {
  let pop = null;
  let items = [];
  let sel = 0;

  function close() {
    if (pop) { pop.remove(); pop = null; }
    items = [];
  }

  function open() {
    const q = input.value.trim().toLowerCase();
    items = (getItems() || []).filter(it => !q || it.label.toLowerCase().includes(q));
    if (items.length === 0) { close(); return; }
    sel = 0;
    render();
  }

  function render() {
    if (!pop) {
      pop = document.createElement('div');
      pop.className = 'cmpl-pop';
      document.body.appendChild(pop);
    }
    pop.replaceChildren();
    items.forEach((it, i) => {
      const row = document.createElement('div');
      row.className = 'cmpl-item' + (i === sel ? ' sel' : '');
      const name = document.createElement('span');
      name.className = 'cmpl-label';
      name.textContent = it.label;
      row.appendChild(name);
      if (it.detail) {
        const d = document.createElement('span');
        d.className = 'cmpl-detail';
        d.textContent = it.detail;
        row.appendChild(d);
      }
      row.onmousedown = (e) => { e.preventDefault(); sel = i; accept(); };
      pop.appendChild(row);
    });
    const r = input.getBoundingClientRect();
    placePopupAt(pop, input, r.left, r.top, r.height, r.width);
    pop.children[sel]?.scrollIntoView({ block: 'nearest' });
  }

  function accept() {
    if (items[sel]) {
      input.value = items[sel].label;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    close();
  }

  // キーは補完ポップアップと同じ理由で document のキャプチャ段階で取る
  // （入力欄側の Esc がダイアログを閉じてしまうため）。
  const onKey = (e) => {
    if (e.target !== input || !pop) return;
    const handled = () => { e.preventDefault(); e.stopPropagation(); };
    switch (e.key) {
      case 'ArrowDown': handled(); sel = (sel + 1) % items.length; render(); break;
      case 'ArrowUp':   handled(); sel = (sel - 1 + items.length) % items.length; render(); break;
      case 'Enter':
      case 'Tab':       handled(); accept(); break;
      case 'Escape':    handled(); close(); break;
    }
  };
  input.addEventListener('focus', open);
  input.addEventListener('input', open);
  input.addEventListener('blur', () => setTimeout(close, 120));
  document.addEventListener('keydown', onKey, true);
  return {
    dispose() {
      close();
      input.removeEventListener('focus', open);
      input.removeEventListener('input', open);
      document.removeEventListener('keydown', onKey, true);
    },
  };
}

if (typeof module !== "undefined") module.exports = { attachSuggestList };

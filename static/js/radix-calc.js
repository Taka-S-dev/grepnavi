// ===== 基数変換電卓 =====
// 右クリック→「基数変換電卓」。選択テキスト（無ければカーソル位置の数値）を
// 初期値に、リテラルと演算子の式をその場で評価する。コードと見比べながら
// 使う道具なのでモーダルにせず、閉じるまで右上に残す。

function showRadixCalc(initial) {
  let panel = document.getElementById('radix-calc');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'radix-calc';
    panel.innerHTML =
      '<div id="radix-calc-head"><span>基数変換</span>' +
      '<button id="radix-calc-close" title="閉じる (Esc)">✕</button></div>' +
      '<input id="radix-calc-in" spellcheck="false" placeholder="0x42 | 1<<6 など">' +
      '<pre id="radix-calc-out"></pre>';
    document.body.appendChild(panel);
    const input = panel.querySelector('#radix-calc-in');
    const out = panel.querySelector('#radix-calc-out');
    const update = () => {
      const src = input.value.trim();
      const res = src ? formatCalcResult(src) : '';
      const err = src !== '' && res === null;
      out.textContent = err
        ? '解釈できません（リテラルと | & ^ ~ << >> + - * / % のみ）'
        : res;
      out.classList.toggle('radix-err', err);
    };
    input.addEventListener('input', update);
    input.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        panel.style.display = 'none';
        if (typeof monacoEditor !== 'undefined') monacoEditor?.focus();
      }
    });
    panel.querySelector('#radix-calc-close').addEventListener('click', () => {
      panel.style.display = 'none';
    });
    panel._update = update;
  }
  panel.style.display = 'block';
  const input = panel.querySelector('#radix-calc-in');
  if (initial) input.value = initial;
  panel._update();
  input.focus();
  input.select();
}

if (typeof module !== 'undefined') module.exports = { showRadixCalc };

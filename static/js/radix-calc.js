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
      '<textarea id="radix-calc-in" rows="1" spellcheck="false" placeholder="0x42 | 1<<6 や (1<<4)==16 など"></textarea>' +
      '<pre id="radix-calc-out"></pre>';
    document.body.appendChild(panel);
    const input = panel.querySelector('#radix-calc-in');
    const out = panel.querySelector('#radix-calc-out');
    const show = (text, isErr) => {
      out.textContent = text;
      out.classList.toggle('radix-err', !!isErr);
    };
    let seq = 0;      // 打鍵より遅れて返った解決結果を捨てる
    let timer = null;
    const update = () => {
      // 長いマクロ名の式でも全体が見えるよう、入力欄は内容に合わせて伸ばす
      input.style.height = 'auto';
      input.style.height = input.scrollHeight + 'px';
      clearTimeout(timer);
      const mySeq = ++seq;
      const src = input.value.trim();
      if (!src) { show(''); return; }
      const direct = formatCalcResult(src);
      if (direct !== null) { show(direct); return; }
      // 数値だけで解釈できない → マクロ名を含むなら索引で解決してから再評価。
      // 電卓が ERR_R_FATAL|0x100 のような式を計算できるのは grepnavi の中だから
      const idents = calcIdentifiers(src);
      if (!idents.length) {
        show('解釈できません（リテラル・マクロ名と | & ^ ~ << >> + - * / % と比較 == != < > のみ）', true);
        return;
      }
      show(idents.join(', ') + ' を解決中...');
      timer = setTimeout(async () => {
        try {
          const r = await fetch('/api/macro-values?names=' + encodeURIComponent(idents.join(',')));
          if (mySeq !== seq) return;
          if (!r.ok) { show('マクロを解決できません', true); return; }
          const values = await r.json();
          if (mySeq !== seq) return;
          const missing = idents.filter(n => values[n] === undefined);
          if (missing.length) {
            show(missing.join(', ') + ' の値を決められません（未定義か、ifdef で複数定義か、定数でない）', true);
            return;
          }
          const res = formatCalcResult(substituteCalcIdents(src, values));
          if (res === null) { show('解釈できません', true); return; }
          // 何をいくつとして計算したかを添える（黙って代入すると検証できない）
          show(res + '\n\n' + idents.map(n => n + ' = ' + values[n]).join('\n'));
        } catch (_) {
          if (mySeq === seq) show('マクロを解決できません', true);
        }
      }, 250);
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

    // ヘッダをつかんで移動できるようにする。固定位置だと読みたいコードに
    // 被ったとき詰む。位置は覚えて次回も同じ場所に出す
    const head = panel.querySelector('#radix-calc-head');
    head.addEventListener('pointerdown', e => {
      if (e.target.id === 'radix-calc-close') return;
      const r = panel.getBoundingClientRect();
      const dx = e.clientX - r.left, dy = e.clientY - r.top;
      const move = ev => {
        const x = Math.min(Math.max(ev.clientX - dx, 0), window.innerWidth - r.width);
        const y = Math.min(Math.max(ev.clientY - dy, 0), window.innerHeight - 30);
        panel.style.left = x + 'px';
        panel.style.top = y + 'px';
        panel.style.right = 'auto';
      };
      const up = () => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        try {
          localStorage.setItem('grepnavi-radix-pos', JSON.stringify({ left: panel.style.left, top: panel.style.top }));
        } catch (_) {}
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
      e.preventDefault();
    });
    try {
      const pos = JSON.parse(localStorage.getItem('grepnavi-radix-pos') || 'null');
      // 前回の位置が今の画面の外なら既定位置のまま（マルチモニタ / リサイズ後）
      if (pos && parseInt(pos.left) < window.innerWidth - 40 && parseInt(pos.top) < window.innerHeight - 40) {
        panel.style.left = pos.left;
        panel.style.top = pos.top;
        panel.style.right = 'auto';
      }
    } catch (_) {}
  }
  panel.style.display = 'block';
  const input = panel.querySelector('#radix-calc-in');
  if (initial) input.value = initial;
  panel._update();
  input.focus();
  input.select();
}

if (typeof module !== 'undefined') module.exports = { showRadixCalc };

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// 右から出るパネルは position:fixed のかぶせなので、本体を狭めないと
// エディタの縦スクロールバーとミニマップがパネルの下に入って掴めなくなる。
// 狭める処理 (app.js の initSidePanelLayout) は .side-panel を目印にするので、
// 新しいアドオンがそれを付け忘れると、症状だけが静かに戻る。
test('アドオンパネル - 右端に固定するパネルは side-panel を名乗る', () => {
  const root = path.join(__dirname, '..', 'static', 'addons');
  const dirs = fs.readdirSync(root).filter(d => fs.statSync(path.join(root, d)).isDirectory());
  let checked = 0;
  for (const d of dirs) {
    const cssPath = path.join(root, d, 'addon.css');
    const jsPath = path.join(root, d, 'addon.js');
    if (!fs.existsSync(cssPath) || !fs.existsSync(jsPath)) continue;
    const css = fs.readFileSync(cssPath, 'utf8');
    const js = fs.readFileSync(jsPath, 'utf8');
    for (const m of css.matchAll(/#([\w-]+)\s*\{([^}]*)\}/g)) {
      const body = m[2].replace(/\s+/g, '');
      if (!body.includes('position:fixed') || !/right:0/.test(body)) continue;
      const id = m[1];
      const tag = js.match(new RegExp(`id="${id}"[^>]*`));
      assert.ok(tag, `${d}: #${id} を作っている要素が addon.js に見つからない`);
      assert.ok(/class="[^"]*\bside-panel\b/.test(tag[0]),
        `${d}: #${id} に class="side-panel" が無い。開いてもエディタが狭まらず、` +
        '縦スクロールバーがパネルの下に隠れる');
      checked++;
    }
  }
  assert.ok(checked >= 4, `右端パネルが ${checked} 件しか見つからない（検出側が壊れている疑い）`);
});

// 同じ症状は本体組み込みのパネルでも起きる。マーク一覧がまさにこれで、
// アドオンだけ走査していた上のテストをすり抜けて1枚だけ残った。
// main.css で右端固定のパネルを拾い、index.html 側の要素に目印を要求する。
test('本体パネル - 右端に固定するパネルも side-panel を名乗る', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'static', 'css', 'main.css'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'static', 'index.html'), 'utf8');
  let checked = 0;
  for (const m of css.matchAll(/#([\w-]+)\s*\{([^}]*)\}/g)) {
    const body = m[2].replace(/\s+/g, '');
    if (!body.includes('position:fixed') || !/right:0[;}]/.test(body)) continue;
    const id = m[1];
    const tag = html.match(new RegExp(`id="${id}"[^>]*`));
    if (!tag) continue; // アドオン側の要素は上のテストが見る
    assert.ok(/class="[^"]*\bside-panel\b/.test(tag[0]),
      `#${id} に class="side-panel" が無い。開いてもエディタが狭まらず、` +
      '縦スクロールバーがパネルの下に隠れる');
    checked++;
  }
  assert.ok(checked >= 1, `右端固定の本体パネルが ${checked} 件しか見つからない（検出側が壊れている疑い）`);
});

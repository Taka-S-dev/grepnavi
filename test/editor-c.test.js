const { test } = require('node:test');
const assert = require('node:assert/strict');

// browser globals stub
global.window = {};

const { initEditorC } = require('../static/js/editor-c.js');

// Monaco / editor の最小スタブ
const mockEditor = {
  onDidChangeModel: () => {},
  onDidChangeModelContent: () => {},
  getModel: () => null,
  createDecorationsCollection: () => ({ set: () => {}, clear: () => {} }),
};
const mockMonaco = {};

const { resolveLocalVar } = initEditorC(mockEditor, mockMonaco);

// model ヘルパー
function makeModel(lines, lang = 'c') {
  return {
    getLanguageId: () => lang,
    getLineContent: (n) => lines[n - 1] ?? '',
  };
}
function pos(lineNumber) { return { lineNumber }; }

// ===== resolveLocalVar =====

test('resolveLocalVar - C以外は false', () => {
  const model = makeModel(['  Foo bar;'], 'go');
  assert.equal(resolveLocalVar(model, 'bar', pos(1)), false);
});

test('resolveLocalVar - 関数引数は null（ホバー抑制）', () => {
  const lines = [
    'static void foo(Elf_Ehdr *ehdr, int n)',
    '{',
    '  use(ehdr);',  // hover here
    '}',
  ];
  const result = resolveLocalVar(makeModel(lines), 'ehdr', pos(3));
  assert.equal(result, null);
});

test('resolveLocalVar - インデントありローカル変数（複合型）→ 宣言テキスト', () => {
  const lines = [
    'void foo() {',
    '  Elf_Ehdr ehdr;',
    '  use(ehdr);',  // hover here
    '}',
  ];
  const result = resolveLocalVar(makeModel(lines), 'ehdr', pos(3));
  assert.ok(result && result.decl === 'Elf_Ehdr ehdr;');
});

test('resolveLocalVar - インデントありローカル変数（プリミティブ型）→ null', () => {
  const lines = [
    'void foo() {',
    '  int count = 0;',
    '  count++;',  // hover here
    '}',
  ];
  const result = resolveLocalVar(makeModel(lines), 'count', pos(3));
  assert.equal(result, null);
});

test('resolveLocalVar - ファイルスコープ static（複合型）→ 宣言テキスト', () => {
  const lines = [
    'static Elf_Ehdr ehdr;',
    '',
    'void foo() {',
    '  use(ehdr);',  // hover here
    '}',
  ];
  const result = resolveLocalVar(makeModel(lines), 'ehdr', pos(4));
  assert.ok(result && result.decl === 'static Elf_Ehdr ehdr;');
});

test('resolveLocalVar - ファイルスコープ static が 200 行より前（Pass 2）', () => {
  // 宣言を line 1 に、ホバーを line 210 に置く
  const lines = ['static Elf_Ehdr ehdr;'];
  for (let i = 0; i < 210; i++) lines.push('  // filler');
  lines.push('  use(ehdr);');  // line 212
  const result = resolveLocalVar(makeModel(lines), 'ehdr', pos(lines.length));
  assert.ok(result && result.decl === 'static Elf_Ehdr ehdr;');
});

test('resolveLocalVar - #ifdef で複数の static 宣言 → 両方表示', () => {
  const lines = [
    '#ifdef CONFIG_64BIT',
    'static Elf64_Ehdr ehdr;',
    '#else',
    'static Elf32_Ehdr ehdr;',
    '#endif',
    '',
    'void foo() {',
    '  use(ehdr);',  // hover here
    '}',
  ];
  const result = resolveLocalVar(makeModel(lines), 'ehdr', pos(8));
  assert.ok(result);
  assert.ok(result.decl.includes('static Elf64_Ehdr ehdr;'));
  assert.ok(result.decl.includes('static Elf32_Ehdr ehdr;'));
});

test('resolveLocalVar - return 文（キーワードのみ行）→ スキャン継続して宣言発見', () => {
  const lines = [
    'static Elf_Ehdr ehdr;',
    '',
    'Elf_Ehdr get_ehdr() {',
    '  return ehdr;',  // hover here: `return` はキーワードなので継続
    '}',
  ];
  const result = resolveLocalVar(makeModel(lines), 'ehdr', pos(4));
  assert.ok(result && result.decl === 'static Elf_Ehdr ehdr;');
});

test('resolveLocalVar - ローカル変数でなければ false', () => {
  const lines = [
    'void foo() {',
    '  do_something(ehdr);',  // hover here, no declaration
    '}',
  ];
  const result = resolveLocalVar(makeModel(lines), 'ehdr', pos(2));
  assert.equal(result, false);
});

test('resolveLocalVar - 宣言行上でホバー → 宣言テキストを返す', () => {
  const lines = [
    'static Elf_Ehdr ehdr;',  // hover on this line
  ];
  const result = resolveLocalVar(makeModel(lines), 'ehdr', pos(1));
  assert.ok(result && result.decl === 'static Elf_Ehdr ehdr;');
});

test('resolveLocalVar - ポインタ変数（*）も認識', () => {
  const lines = [
    'void foo() {',
    '  Elf_Shdr *shdr = NULL;',
    '  use(shdr);',  // hover here
    '}',
  ];
  const result = resolveLocalVar(makeModel(lines), 'shdr', pos(3));
  assert.ok(result && result.decl === 'Elf_Shdr *shdr = NULL;');
});

test('resolveLocalVar - 関数定義は static 変数と誤検知しない', () => {
  const lines = [
    'static void add_reloc(int x) {',
    '  use(add_reloc);',  // hover on add_reloc
    '}',
  ];
  // add_reloc は関数なので ( が続く → reFileScope にマッチしない → false
  const result = resolveLocalVar(makeModel(lines), 'add_reloc', pos(2));
  assert.equal(result, false);
});

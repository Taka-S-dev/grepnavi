/**
 * テスト共通セットアップ
 * - 外部への fetch / XHR をインターセプトし、localhost 以外へのアクセスをテスト失敗にする
 * - Node.js にはブラウザ API がないため最低限のスタブも提供する
 */

// ---- ブラウザ API スタブ ----
global.addEventListener = () => {};
global.document = {
  addEventListener: () => {},
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
};
global.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};
global.location = { search: '', href: '' };
global.window = global;

// ---- fetch インターセプト ----
global.fetch = (url, _opts) => {
  const str = String(url);
  // 相対パス (/api/...) は localhost へのリクエストとみなす
  if (!str.startsWith('/') && !str.startsWith('http://localhost') && !str.startsWith('http://127.0.0.1')) {
    throw new Error(`[security] 外部への fetch を検知: ${str}`);
  }
  // テスト中は実際の通信は行わず空レスポンスを返す
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(''),
  });
};

// ---- XMLHttpRequest インターセプト ----
global.XMLHttpRequest = class {
  open(method, url) {
    const str = String(url);
    if (!str.startsWith('/') && !str.startsWith('http://localhost') && !str.startsWith('http://127.0.0.1')) {
      throw new Error(`[security] 外部への XHR を検知: ${str}`);
    }
  }
  send() {}
  setRequestHeader() {}
};

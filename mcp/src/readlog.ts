// [verified] を自己申告にしないための、このプロセス内での「読んだ範囲」の記録。
//
// `[未確認]` の自動付与だけでは、AI が本体を読まずに `[verified]` と書けば素通りする。
// 本体を取得したかどうかはブリッジが確実に知っている事実なので、それと照合する。
// 記録はプロセスの寿命と同じ (= エージェントの 1 セッション)。前のセッションで
// 読んだものは数えない。それが「このメモを書いた AI が読んだ」の意味だから。

export interface ReadRange {
  start: number;
  end: number;
}

export interface MemoAnchor {
  file: string;
  line: number;
  /** 範囲メモの終端。省略時は line と同じ。 */
  end_line?: number;
}

export interface VerifyResult {
  memo: string;
  downgraded: boolean;
  reason?: string;
}

const VERIFIED_TAG_RE = /^\s*\[\s*(verified|確認済|読了)\s*\]\s*/i;

const readRanges = new Map<string, ReadRange[]>();

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

// 相対で来た側があっても照合できるよう、片方がもう片方の末尾に一致すれば同じ扱い。
function samePath(a: string, b: string): boolean {
  if (a === b) return true;
  return a.endsWith("/" + b) || b.endsWith("/" + a);
}

export function recordRead(file: string, start: number, end: number): void {
  if (!file || !(start > 0) || end < start) return;
  const key = normalizePath(file);
  const list = readRanges.get(key) ?? [];
  list.push({ start, end });
  readRanges.set(key, list);
}

export function wasRead(file: string, line: number, endLine: number = line): boolean {
  const key = normalizePath(file);
  for (const [k, ranges] of readRanges) {
    if (!samePath(k, key)) continue;
    for (const r of ranges) {
      if (r.start <= endLine && line <= r.end) return true;
    }
  }
  return false;
}

export function hasVerifiedTag(memo: string | undefined): boolean {
  return !!memo && VERIFIED_TAG_RE.test(memo);
}

// メモが [verified] 系を名乗っていて、どのアンカーも読まれていなければ [未確認] に落とす。
// アンカーは複数渡せる: 呼び出し木の子はアンカーが呼び出し元の行なので、
// 呼び先の定義位置も候補に含めないと、正しく読んだ場合まで落としてしまう。
export function verifyMemo(memo: string | undefined, anchors: MemoAnchor[]): VerifyResult {
  if (memo === undefined || !hasVerifiedTag(memo)) {
    return { memo: memo ?? "", downgraded: false };
  }
  const covered = anchors.some((a) => a.file && wasRead(a.file, a.line, a.end_line ?? a.line));
  if (covered) return { memo, downgraded: false };
  // 同じ場所がスラッシュ違いで定義側からも来るので、正規化して 1 つにまとめる
  const seen = new Set<string>();
  const where = anchors
    .filter((a) => a.file)
    .map((a) => `${a.file.replace(/\\/g, "/")}:${a.line}${a.end_line && a.end_line !== a.line ? "-" + a.end_line : ""}`)
    .filter((w) => !seen.has(w.toLowerCase()) && seen.add(w.toLowerCase()))
    .join(" / ");
  return {
    memo: memo.replace(VERIFIED_TAG_RE, "[未確認] "),
    downgraded: true,
    reason:
      `memo claimed verified, but no grepnavi_func_body / grepnavi_read_file call in this session ` +
      `covered ${where || "the anchor"}. Tag replaced with [未確認]. Read the code, then resubmit with [verified].`,
  };
}

// テスト用。
export function resetReadLog(): void {
  readRanges.clear();
}

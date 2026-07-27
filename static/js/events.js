// ===== /api/events SSE subscriber =====
// graph / memo の外部変更を browser に push reflect する。
// 自分自身の POST でも server は publish するため、loadGraph が
// 2 回走るケースがある (即時更新 + SSE 経由の再 fetch)。loadGraph は冪等。

(function () {
  let es = null;
  let backoff = 1000;
  const MAX_BACKOFF = 30000;

  function reloadGraphIfPossible() {
    if (typeof loadGraph === "function") loadGraph();
  }

  function connect() {
    try {
      es = new EventSource("/api/events");
    } catch (e) {
      scheduleReconnect();
      return;
    }

    es.addEventListener("hello", () => {
      backoff = 1000;
    });

    // graph.updated: グラフを変更する API 要求が成功したときに必ず流れる。
    // ノードのメモ・ラベル更新や削除・移動もこれで届く（以前はノード追加と
    // 行メモしか通知されず、AI がメモを付けてもタブを切り替えるまで反映されなかった）。
    // memos は GraphResponse 内に含まれるので loadGraph で再取得される。
    // browser 自身の save で発火しても局所 state と一致するので無害。
    es.addEventListener("graph.updated", () => {
      reloadGraphIfPossible();
    });

    // 旧イベント名。古い grepnavi 本体に新しい static/ を載せた場合の保険。
    es.addEventListener("graph.node_added", () => {
      reloadGraphIfPossible();
    });
    es.addEventListener("memos.updated", () => {
      reloadGraphIfPossible();
    });

    es.addEventListener("defs.invalidated", () => {
      reloadGraphIfPossible();
    });

    es.onerror = () => {
      if (es) {
        es.close();
        es = null;
      }
      scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF);
  }

  if (typeof window !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", connect, { once: true });
    } else {
      connect();
    }
  }
})();

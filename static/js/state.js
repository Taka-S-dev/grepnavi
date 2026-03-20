// ===== GLOBAL STATE =====

// URL mode: 'search' | 'calltree' | '' (通常)
const pageMode = new URLSearchParams(location.search).get('mode') || '';

// Graph
let graph = { nodes:{}, edges:[] };
let selNode = null;
let viewMode = 'tree'; // 'tree' | 'graph'
let d3sim = null;
let showMemos = false;
let showTreeMemos = false;
let graphSel = new Set();
let edgeMode = 'ref'; // 'ref' | 'seq'
let projectRoot = '';

// Search
let sse = null, batchTimer = null, spinnerTimer = null;
let spinnerFrame = 0;
let pending = [], allMatches = [];
let fileGroupMap = {};
let filterTokens = [];

// Drag & Drop
let dragNodeId = null;
let dragDepth  = 0;
let dragStartX = 0;
let lastDragX  = 0;
let dropHandled = false; // ondrop 済みフラグ（ondragend との二重処理防止）
let dragSeq = 0; // ドラッグ操作ごとに増加。再レンダリング後の古い ondragend を無視するため。

// Monaco Editor
let monacoEditor = null, monacoDecoIds = [], monacoReady = false;
let tabs = []; // {file, line, label, model, decoIds}
let activeTabIdx = -1;
const navHistory = []; // [{file, line}]
let navIndex = -1;
let navSkipPush = false;
let graphDecoIds = [];
let lineMemoDecoIds = [];
let showLineMemoInline = true;
let _lineMemoScrollDispose = null;
let ifdefDecoIds = [];

// Resize
let peekResizing = false, peekStartY = 0, peekStartH = 0;
let leftResizing = false, leftStartY = 0, leftStartH = 0;

// File Quick-Open (fzf)
let fzfFiles = null;
let fzfSelIdx = 0;
let fzfFiltered = [];

// Project
let dirList = null;
let _projectModalMode = 'save';

// Search history tabs
let searchTabs = []; // [{query, count, title, overText, filterValue, allMatches, pinned}]
let activeSearchTab = -1;
const MAX_SEARCH_TABS = 10;
const LS_PINNED_TABS = 'grepnavi-pinned-tabs';

// Search stack
let searchStack = []; // [{query, count, title, overText, filterValue, allMatches}]
const LS_SEARCH_STACK = 'grepnavi-search-stack';

// Search stack drag
let _stackDragIdx = null;

// Detail panel accordion open/close state
const accState = {loc:true, ifdef:false, snippet:false, memo:true, expand:false};

// File browser
let _fbMode = 'save'; // 'save' | 'open'
let _fbCurrentPath = '';

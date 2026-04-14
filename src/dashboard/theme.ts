export const DASHBOARD_HEAD_TAGS = `
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Syne:wght@400;500;700&display=swap" rel="stylesheet">
`;

export const DASHBOARD_CSS = String.raw`
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    color-scheme: dark;
    --bg: #0c0c10;
    --surface: #13131a;
    --surface2: #1a1a24;
    --surface3: #22222d;
    --border: rgba(255,255,255,0.07);
    --border2: rgba(255,255,255,0.12);
    --text: #e8e8f0;
    --muted: #6b6b80;
    --accent: #00d4aa;
    --accent-dim: rgba(0,212,170,0.12);
    --accent-glow: rgba(0,212,170,0.25);
    --blue: #4d9fff;
    --blue-dim: rgba(77,159,255,0.12);
    --amber: #f5a623;
    --amber-dim: rgba(245,166,35,0.12);
    --red: #ff5555;
    --red-dim: rgba(255,85,85,0.12);
    --font-sans: "Syne", sans-serif;
    --font-mono: "IBM Plex Mono", monospace;
  }

  html, body {
    min-height: 100%;
    background: var(--bg);
    color: var(--text);
    font-family: var(--font-sans);
    font-size: 15px;
    line-height: 1.6;
  }

  body { overflow: hidden; }
  a { color: inherit; text-decoration: none; }
  button, input, select, textarea { font: inherit; }
  .muted { color: var(--muted); }
  code {
    font-family: var(--font-mono);
    font-size: 0.92em;
    padding: 0.12rem 0.36rem;
    border-radius: 999px;
    background: rgba(255,255,255,0.06);
  }

  .app {
    display: flex;
    height: 100vh;
    background:
      radial-gradient(circle at top left, rgba(0,212,170,0.07), transparent 22%),
      radial-gradient(circle at bottom right, rgba(77,159,255,0.08), transparent 24%),
      var(--bg);
  }

  .sidebar {
    width: 260px;
    min-width: 0;
    flex-shrink: 0;
    background: var(--surface);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    padding: 20px 0;
    overflow-y: auto;
    transition:
      width 180ms ease,
      padding 180ms ease,
      border-color 180ms ease,
      opacity 140ms ease;
  }

  .app.sidebar-collapsed .sidebar {
    width: 0;
    padding: 0;
    border-right-color: transparent;
    opacity: 0;
    overflow: hidden;
    pointer-events: none;
  }

  .logo {
    padding: 0 16px 20px;
    display: flex;
    align-items: center;
    gap: 10px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 16px;
  }
  .logo-mark {
    width: 30px;
    height: 30px;
    border-radius: 8px;
    background: var(--accent);
    position: relative;
    flex-shrink: 0;
  }
  .logo-mark::after {
    content: "";
    position: absolute;
    inset: 10px;
    border-radius: 50%;
    background: var(--bg);
    animation: dash-ping 2s infinite;
  }
  @keyframes dash-ping {
    0%,100% { transform: scale(1); opacity: 1; }
    50% { transform: scale(0.6); opacity: 0.45; }
  }
  .logo-name { font-size: 15px; font-weight: 700; letter-spacing: -0.02em; color: var(--text); }
  .logo-beta {
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: 9px;
    background: var(--accent-dim);
    color: var(--accent);
    padding: 2px 5px;
    border-radius: 4px;
  }

  .nav-section { padding: 0 10px; margin-bottom: 20px; }
  .nav-label {
    font-family: var(--font-mono);
    font-size: 9px;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    padding: 0 6px;
    margin-bottom: 6px;
  }
  .nav-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border-radius: 8px;
    color: var(--muted);
    font-size: 13px;
    font-weight: 500;
    transition: all 0.15s ease;
    margin-bottom: 2px;
  }
  .nav-item:hover { background: var(--surface2); color: var(--text); }
  .nav-item.active { background: var(--accent-dim); color: var(--accent); }
  .nav-icon { font-size: 14px; width: 16px; text-align: center; }
  .nav-badge {
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: 10px;
    background: var(--accent-dim);
    color: var(--accent);
    padding: 1px 6px;
    border-radius: 10px;
  }

  .run-list-shell { padding: 0 10px; display: grid; gap: 8px; }
  .run-list { display: grid; gap: 8px; }
  .run-button, .run-link {
    width: 100%;
    display: block;
    text-align: left;
    cursor: pointer;
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 12px;
    background: var(--surface2);
    transition: all 0.18s ease;
  }
  .run-button:hover, .run-button:focus-visible, .run-link:hover, .run-link:focus-visible {
    border-color: var(--border2);
    transform: translateY(-1px);
    outline: none;
  }
  .run-button--active, .run-link--active {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-dim);
  }
  .run-topline, .section-heading, .task-card__header, .history-head, .panel-topline {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }
  .run-host { font-size: 14px; font-weight: 600; color: var(--text); }
  .run-summary {
    margin-top: 8px;
    color: rgba(232, 232, 240, 0.82);
    font-size: 13px;
    line-height: 1.65;
    display: -webkit-box;
    overflow: hidden;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
  }

  .mini-meta, .helper-row, .task-meta, .history-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 10px;
  }
  .mini-meta span, .helper-row span, .task-meta span, .history-meta span {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border-radius: 20px;
    border: 1px solid var(--border);
    color: var(--muted);
    font-size: 11px;
    font-family: var(--font-mono);
  }

  .sidebar-footer {
    margin-top: auto;
    padding: 16px;
    border-top: 1px solid var(--border);
  }
  .workspace {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    padding: 6px 8px;
    border-radius: 8px;
    transition: background 0.15s ease;
  }
  .workspace:hover { background: var(--surface2); }
  .ws-avatar {
    width: 28px;
    height: 28px;
    border-radius: 8px;
    background: linear-gradient(135deg, #4d9fff, #00d4aa);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    font-weight: 700;
    color: #fff;
    flex-shrink: 0;
  }
  .ws-name { font-size: 12px; font-weight: 500; }
  .ws-plan { font-size: 10px; color: var(--muted); font-family: var(--font-mono); }

  .main {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    display: flex;
    flex-direction: column;
  }

  .topbar {
    position: sticky;
    top: 0;
    z-index: 10;
    background: rgba(12,12,16,0.85);
    backdrop-filter: blur(12px);
    border-bottom: 1px solid var(--border);
    padding: 12px 24px;
    display: flex;
    align-items: center;
    gap: 16px;
  }
  .topbar-left {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
  }
  .page-title { font-size: 16px; font-weight: 700; }
  .page-sub { font-size: 12px; color: var(--muted); margin-left: 4px; }
  .topbar-right { margin-left: auto; display: flex; align-items: center; gap: 10px; }

  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 8px 16px;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 500;
    border: none;
    transition: all 0.15s ease;
  }
  .btn-primary { background: var(--accent); color: #0c0c10; }
  .btn-primary:hover { filter: brightness(1.08); }
  .btn-ghost {
    background: var(--surface2);
    color: var(--text);
    border: 1px solid var(--border2);
  }
  .btn-ghost:hover { background: var(--surface3); }
  .sidebar-toggle {
    padding-inline: 12px;
    white-space: nowrap;
  }
  .sidebar-toggle-label {
    display: inline-block;
  }
  .summary-toggle {
    min-width: 0;
    white-space: nowrap;
  }
  .summary-toggle-label {
    display: inline-block;
  }

  .content {
    padding: 24px;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .metrics-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 12px;
  }
  .metric-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 16px 20px;
    transition: border-color 0.2s ease;
  }
  .metric-card:hover { border-color: var(--border2); }
  .metric-label {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin-bottom: 8px;
  }
  .metric-val { font-size: 28px; font-weight: 700; line-height: 1; margin-bottom: 6px; }
  .metric-delta { font-size: 11px; font-family: var(--font-mono); color: var(--muted); }
  .delta-up { color: var(--accent); }
  .delta-down { color: var(--red); }

  .new-test-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 20px;
  }
  .card-title, .ss-label {
    font-size: 12px;
    font-family: var(--font-mono);
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin-bottom: 14px;
  }
  .url-row { display: flex; gap: 10px; margin-bottom: 14px; }
  .url-input {
    flex: 1;
    background: var(--surface2);
    border: 1px solid var(--border2);
    border-radius: 8px;
    padding: 10px 14px;
    font-family: var(--font-mono);
    font-size: 13px;
    color: var(--text);
    outline: none;
  }
  .url-input:focus { border-color: var(--accent); }
  .task-intro {
    margin-bottom: 12px;
    color: var(--muted);
    font-size: 13px;
  }
  .instruction-panel {
    display: grid;
    gap: 10px;
    margin-bottom: 14px;
  }
  .instruction-label {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .instruction-input {
    min-height: 190px;
    resize: vertical;
    background: var(--surface2);
    border: 1px solid var(--border2);
    border-radius: 8px;
    padding: 12px 12px;
    font-size: 13px;
    line-height: 1.6;
    color: var(--text);
    outline: none;
  }
  .instruction-input:focus { border-color: var(--accent); }
  .file-input-row {
    display: grid;
    gap: 6px;
    margin-bottom: 14px;
  }
  .file-input {
    background: var(--surface2);
    border: 1px solid var(--border2);
    border-radius: 8px;
    padding: 10px 12px;
    color: var(--text);
  }
  .file-input::file-selector-button {
    margin-right: 10px;
    border: 1px solid var(--border2);
    border-radius: 999px;
    background: var(--surface3);
    color: var(--text);
    padding: 6px 10px;
    cursor: pointer;
  }
  .task-entry-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
    margin-bottom: 14px;
  }
  .task-entry {
    display: grid;
    gap: 6px;
  }
  .task-entry__label {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .task-entry__input {
    min-height: 88px;
    resize: vertical;
    background: var(--surface2);
    border: 1px solid var(--border2);
    border-radius: 8px;
    padding: 10px 12px;
    font-size: 13px;
    line-height: 1.55;
    color: var(--text);
    outline: none;
  }
  .task-entry__input:focus { border-color: var(--accent); }
  .config-row { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
  .config-select {
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 6px 12px;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text);
    outline: none;
  }
  .tag {
    font-family: var(--font-mono);
    font-size: 11px;
    padding: 4px 10px;
    border-radius: 20px;
    border: 1px solid var(--border);
    color: var(--muted);
  }
  .tag.on { border-color: var(--accent); color: var(--accent); background: var(--accent-dim); }

  .two-col { display: grid; grid-template-columns: minmax(0, 1fr) 380px; gap: 18px; align-items: start; }
  .two-col.summary-rail-collapsed { grid-template-columns: minmax(0, 1fr) 120px; }
  .stack { display: flex; flex-direction: column; gap: 14px; min-width: 0; }

  .panel, .task-card, .history-card, .violation-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
  }
  .panel-head {
    padding: 14px 18px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .panel-body, .summary-section, .task-card, .history-card, .violation-card { padding: 16px; }
  .panel-title { font-size: 16px; font-weight: 600; }
  .panel-sub { font-size: 13px; color: var(--muted); font-family: var(--font-mono); }
  .panel-actions { margin-left: auto; display: flex; gap: 8px; }
  .icon-btn {
    background: none;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 5px 10px;
    font-size: 12px;
    color: var(--muted);
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .icon-btn:hover { border-color: var(--border2); color: var(--text); }

  .live-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--accent);
    background: var(--accent-dim);
    padding: 3px 8px;
    border-radius: 20px;
  }
  .live-badge.warning { color: var(--amber); background: var(--amber-dim); }
  .live-badge.danger { color: var(--red); background: var(--red-dim); }
  .live-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
    animation: dash-ping 1.6s infinite;
  }
  .live-dot.warning { background: var(--amber); }

  .agents-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 10px;
    padding: 16px;
  }
  .agent-card {
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 12px;
    transition: all 0.18s ease;
    position: relative;
    overflow: hidden;
  }
  .agent-card[data-run-id] { cursor: pointer; }
  .agent-card::before {
    content: "";
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 2px;
    opacity: 1;
  }
  .agent-card.st-done::before { background: var(--accent); }
  .agent-card.st-active::before { background: var(--blue); }
  .agent-card.st-error::before { background: var(--amber); }
  .agent-card.st-idle::before { background: var(--border2); }
  .agent-card:hover { border-color: var(--border2); transform: translateY(-1px); }
  .agent-card.selected { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent-dim); }
  .agent-num {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--muted);
    margin-bottom: 4px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .status-pip {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .pip-green { background: var(--accent); }
  .pip-blue { background: var(--blue); animation: dash-ping 1.4s infinite; }
  .pip-amber { background: var(--amber); }
  .pip-gray { background: var(--muted); }
  .agent-persona { font-size: 13px; font-weight: 600; margin-bottom: 4px; }
  .agent-doing {
    font-size: 12px;
    font-family: var(--font-sans);
    color: var(--muted);
    margin-bottom: 8px;
    line-height: 1.55;
    min-height: 58px;
  }
  .agent-score { font-size: 20px; font-weight: 700; margin-bottom: 6px; }
  .score-green { color: var(--accent); }
  .score-amber { color: var(--amber); }
  .score-red { color: var(--red); }
  .score-muted { color: var(--muted); }
  .prog-track { height: 2px; background: var(--border); border-radius: 2px; overflow: hidden; }
  .prog-fill { height: 100%; border-radius: 2px; }
  .prog-green { background: var(--accent); }
  .prog-blue { background: var(--blue); }
  .prog-amber { background: var(--amber); }

  .feedback-list {
    padding: 0 16px 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-height: 320px;
    overflow-y: auto;
  }
  .fb-item {
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px 12px;
    transition: border-color 0.15s ease;
  }
  .fb-item:hover { border-color: var(--border2); }
  .fb-top {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    margin-bottom: 5px;
  }
  .fb-agent { font-family: var(--font-mono); font-size: 11px; color: var(--muted); }
  .fb-tag {
    font-family: var(--font-mono);
    font-size: 10px;
    padding: 2px 8px;
    border-radius: 20px;
  }
  .tag-bug { background: var(--red-dim); color: var(--red); }
  .tag-ux { background: var(--amber-dim); color: var(--amber); }
  .tag-pos { background: var(--accent-dim); color: var(--accent); }
  .tag-perf { background: var(--blue-dim); color: var(--blue); }
  .fb-text { font-size: 14px; color: var(--text); line-height: 1.65; }

  .summary-section { border-bottom: 1px solid var(--border); }
  .summary-section:last-child { border-bottom: none; }
  .summary-rail--collapsed .panel-head {
    flex-direction: column;
    align-items: stretch;
    padding: 12px;
  }
  .summary-rail--collapsed .panel-title {
    font-size: 11px;
    text-align: center;
    color: var(--muted);
    font-family: var(--font-mono);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .summary-rail--collapsed .panel-actions {
    margin-left: 0;
    width: 100%;
    justify-content: center;
  }
  .summary-rail--collapsed [data-summary-share],
  .summary-rail--collapsed .summary-rail-body { display: none; }
  .summary-rail--collapsed .summary-toggle { width: 100%; }
  .big-score { font-size: 48px; font-weight: 700; color: var(--accent); line-height: 1; }
  .score-dim { font-size: 20px; color: var(--muted); }
  .score-bars { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
  .sb-row { display: flex; align-items: center; gap: 8px; font-size: 12px; }
  .sb-name { color: var(--muted); width: 86px; font-family: var(--font-mono); }
  .sb-track { flex: 1; height: 4px; background: var(--border); border-radius: 2px; overflow: hidden; }
  .sb-fill { height: 100%; border-radius: 2px; }
  .sb-val { font-family: var(--font-mono); font-size: 12px; width: 32px; text-align: right; }

  .issue-list { display: flex; flex-direction: column; gap: 6px; }
  .issue-row {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    font-size: 13px;
    padding: 8px 10px;
    border-radius: 6px;
    transition: background 0.15s ease;
  }
  .issue-row:hover { background: var(--surface2); }
  .issue-icon {
    width: 18px;
    height: 18px;
    border-radius: 5px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 9px;
    font-weight: 700;
    flex-shrink: 0;
    margin-top: 1px;
  }
  .i-bug { background: var(--red-dim); color: var(--red); }
  .i-ux { background: var(--amber-dim); color: var(--amber); }
  .i-info { background: var(--blue-dim); color: var(--blue); }
  .issue-text { color: var(--text); line-height: 1.55; flex: 1; }
  .issue-cnt { font-family: var(--font-mono); font-size: 11px; color: var(--muted); flex-shrink: 0; }

  .persona-chips { display: flex; flex-wrap: wrap; gap: 5px; }
  .p-chip {
    font-family: var(--font-mono);
    font-size: 11px;
    padding: 3px 8px;
    border-radius: 20px;
    border: 1px solid var(--border);
    color: var(--muted);
  }

  .activity-log { display: flex; flex-direction: column; gap: 0; }
  .al-row {
    display: flex;
    gap: 10px;
    padding: 8px 0;
    border-bottom: 1px solid var(--border);
    font-size: 12px;
  }
  .al-row:last-child { border-bottom: none; }
  .al-time { font-family: var(--font-mono); color: var(--muted); width: 52px; flex-shrink: 0; }
  .al-text { color: var(--text); line-height: 1.55; }
  .al-id { font-family: var(--font-mono); color: var(--blue); }

  .list-grid, .task-stack, .accessibility-grid, .history-grid {
    display: grid;
    gap: 12px;
  }
  .list-grid { grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
  .accessibility-grid, .history-grid { grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
  .prose-list, .evidence-list {
    margin-top: 12px;
    padding-left: 18px;
    display: grid;
    gap: 10px;
  }
  .prose-list li, .evidence-list li {
    font-size: 14px;
    line-height: 1.7;
    color: rgba(232, 232, 240, 0.88);
  }

  .task-card, .history-card, .violation-card { padding: 16px; }
  .task-card__reason, .history-card p, .violation-card p {
    margin-top: 8px;
    color: var(--muted);
    font-size: 14px;
    line-height: 1.72;
  }
  .step-proof {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 10px;
    margin-top: 12px;
  }
  .proof-shot {
    margin: 0;
    display: grid;
    gap: 6px;
  }
  .proof-shot a {
    display: block;
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
    background: var(--surface2);
  }
  .proof-shot img {
    width: 100%;
    height: 160px;
    object-fit: cover;
    display: block;
  }
  .proof-shot figcaption {
    color: var(--muted);
    font-size: 11px;
    font-family: var(--font-mono);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .visit-recap__line {
    margin-top: 8px;
    color: rgba(232, 232, 240, 0.92);
    font-size: 16px;
    line-height: 1.82;
  }
  .task-details {
    margin-top: 14px;
    border-top: 1px solid var(--border);
    padding-top: 14px;
  }
  .task-details > summary {
    cursor: pointer;
    color: var(--text);
    font-size: 13px;
    font-family: var(--font-mono);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .visit-recap { display: grid; gap: 10px; }

  .pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 9px;
    border-radius: 20px;
    font-family: var(--font-mono);
    font-size: 10px;
  }
  .pill--score-high, .pill--status-success, .pill--status-completed, .pill--friction-none {
    color: var(--accent);
    background: var(--accent-dim);
  }
  .pill--score-mid, .pill--status-partial_success, .pill--status-queued, .pill--status-running, .pill--friction-low, .pill--friction-medium {
    color: var(--amber);
    background: var(--amber-dim);
  }
  .pill--score-low, .pill--status-failed, .pill--friction-high {
    color: var(--red);
    background: var(--red-dim);
  }

  .link-row {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-top: 10px;
  }
  .inline-link {
    color: var(--accent);
    font-size: 12px;
    font-weight: 500;
  }
  .inline-link:hover { text-decoration: underline; }

  .warning-note, .empty-stack {
    border: 1px dashed var(--border2);
    border-radius: 12px;
    padding: 14px;
    background: var(--surface2);
    color: var(--muted);
  }
  .empty-stack {
    text-align: center;
    min-height: 220px;
    display: grid;
    place-items: center;
  }

  @media (max-width: 1200px) {
    .metrics-grid { grid-template-columns: repeat(2, 1fr); }
    .two-col { grid-template-columns: 1fr; }
    .two-col.summary-rail-collapsed { grid-template-columns: 1fr; }
  }

  @media (max-width: 900px) {
    body { overflow: auto; }
    .app { display: block; height: auto; min-height: 100vh; }
    .sidebar {
      width: auto;
      border-right: 0;
      border-bottom: 1px solid var(--border);
      max-height: none;
    }
    .app.sidebar-collapsed .sidebar {
      width: auto;
      max-height: 0;
      padding: 0;
      border-bottom-color: transparent;
    }
    .main { min-height: auto; }
  }

  @media (max-width: 720px) {
    .content, .topbar { padding: 16px; }
    .topbar { flex-wrap: wrap; }
    .topbar-left { width: 100%; }
    .topbar-right { width: 100%; margin-left: 0; }
    .topbar-right .btn { flex: 1; }
    .sidebar-toggle { width: 100%; }
    .sidebar-toggle-label { flex: 1; text-align: center; }
    .metrics-grid { grid-template-columns: 1fr; }
    .url-row { flex-direction: column; }
    .task-entry-grid { grid-template-columns: 1fr; }
    .agents-grid { grid-template-columns: 1fr; }
    .list-grid, .accessibility-grid, .history-grid { grid-template-columns: 1fr; }
  }
`;

import * as vscode from 'vscode';
import {
  getStatsSummary,
  getAggregatedStats,
  getModelStats,
  getAccountStats,
  getModelTrend,
  getAccountTrend,
  syncTokenData,
  TokenStatsSummary,
  TokenStatsAggregated,
  ModelTokenStats,
  AccountTokenStats,
  TrendPoint,
} from '../core/tokenStatsStore';
import { loadConfig } from '../core/profileStore';
import { getLocalUserStatus } from '../core/lsRpcClient';

export class StatsPanel {
  public static currentPanel: StatsPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _sandboxRoot: string;
  private _disposables: vscode.Disposable[] = [];
  private _currentTimeRange: 'hourly' | 'daily' | 'weekly' = 'daily';
  private _currentViewMode: 'model' | 'account' = 'model';

  public static render(extensionUri: vscode.Uri, sandboxRoot: string) {
    if (StatsPanel.currentPanel) {
      StatsPanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
      StatsPanel.currentPanel.refresh();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'agTokenStats',
      'Token & Request Statistics',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    StatsPanel.currentPanel = new StatsPanel(panel, extensionUri, sandboxRoot);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    _extensionUri: vscode.Uri,
    sandboxRoot: string
  ) {
    this._panel = panel;
    this._sandboxRoot = sandboxRoot;

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case 'ready':
            await this.refresh();
            break;
          case 'refresh':
            await this.handleManualSync();
            break;
          case 'setTimeRange':
            this._currentTimeRange = message.value;
            await this.refresh();
            break;
          case 'setViewMode':
            this._currentViewMode = message.value;
            await this.refresh();
            break;
        }
      },
      null,
      this._disposables
    );

    this._panel.webview.html = this._getHtmlForWebview();
  }

  public dispose() {
    StatsPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) {
        x.dispose();
      }
    }
  }

  public async refresh() {
    try {
      const summary: TokenStatsSummary = await getStatsSummary(this._sandboxRoot);
      const aggregated: TokenStatsAggregated[] = await getAggregatedStats(
        this._sandboxRoot,
        this._currentTimeRange
      );
      const modelStats: ModelTokenStats[] = await getModelStats(this._sandboxRoot);
      const accountStats: AccountTokenStats[] = await getAccountStats(this._sandboxRoot);
      const modelTrend: TrendPoint[] = await getModelTrend(
        this._sandboxRoot,
        this._currentTimeRange
      );
      const accountTrend: TrendPoint[] = await getAccountTrend(
        this._sandboxRoot,
        this._currentTimeRange
      );

      this._panel.webview.postMessage({
        type: 'update',
        payload: {
          summary,
          aggregated,
          modelStats,
          accountStats,
          modelTrend,
          accountTrend,
          timeRange: this._currentTimeRange,
          viewMode: this._currentViewMode,
        },
      });
    } catch (err: any) {
      this._panel.webview.postMessage({
        type: 'error',
        message: err.message,
      });
    }
  }

  private async handleManualSync() {
    try {
      const config = loadConfig(this._sandboxRoot);
      let email = config.activeProfile || 'active@sandbox';
      try {
        const status = await getLocalUserStatus(this._sandboxRoot);
        if (status?.email) {
          email = status.email;
        }
      } catch {
        // Fallback to config email
      }

      const syncResult = await syncTokenData(this._sandboxRoot, email);
      await this.refresh();

      this._panel.webview.postMessage({
        type: 'syncDone',
        message: `Synced ${syncResult.addedSteps} new steps via ${syncResult.source}.`,
      });
    } catch (err: any) {
      vscode.window.showErrorMessage(`Sync failed: ${err.message}`);
    }
  }

  private _getHtmlForWebview(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Token & Request Statistics</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background, #1e1e1e);
      --fg: var(--vscode-editor-foreground, #cccccc);
      --card-bg: var(--vscode-sideBar-background, #252526);
      --card-border: var(--vscode-widget-border, #333333);
      --accent: var(--vscode-button-background, #0e639c);
      --accent-hover: var(--vscode-button-hoverBackground, #1177bb);
      --muted: var(--vscode-descriptionForeground, #888888);
      --font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif);
      --primary-blue: #3b82f6;
      --primary-purple: #8b5cf6;
      --primary-green: #10b981;
      --primary-amber: #f59e0b;
      --primary-pink: #ec4899;
      --primary-cyan: #06b6d4;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      background-color: var(--bg);
      color: var(--fg);
      font-family: var(--font-family);
      padding: 20px;
      line-height: 1.5;
    }

    .header-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 12px;
      margin-bottom: 24px;
      border-bottom: 1px solid var(--card-border);
      padding-bottom: 16px;
    }

    .title-group {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .title-group h1 {
      font-size: 1.35rem;
      font-weight: 600;
    }

    .badge-sandbox {
      background: rgba(14, 99, 156, 0.25);
      border: 1px solid var(--accent);
      color: #58a6ff;
      font-size: 0.75rem;
      padding: 2px 8px;
      border-radius: 12px;
      font-weight: 500;
    }

    .controls-group {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }

    .pill-group {
      display: flex;
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 6px;
      overflow: hidden;
    }

    .pill-btn {
      background: transparent;
      border: none;
      color: var(--muted);
      padding: 6px 14px;
      font-size: 0.85rem;
      cursor: pointer;
      transition: all 0.15s ease;
      font-family: inherit;
    }

    .pill-btn.active {
      background: var(--accent);
      color: #ffffff;
      font-weight: 500;
    }

    .pill-btn:hover:not(.active) {
      color: var(--fg);
      background: rgba(255, 255, 255, 0.05);
    }

    .btn-refresh {
      display: flex;
      align-items: center;
      gap: 6px;
      background: var(--accent);
      color: #ffffff;
      border: none;
      padding: 6px 14px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 0.85rem;
      font-weight: 500;
      transition: background 0.15s ease;
      font-family: inherit;
    }

    .btn-refresh:hover {
      background: var(--accent-hover);
    }

    .btn-refresh:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    /* KPI Grid */
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
      gap: 14px;
      margin-bottom: 24px;
    }

    .kpi-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 8px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      position: relative;
      overflow: hidden;
    }

    .kpi-card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 3px;
    }

    .kpi-total::before { background: var(--primary-blue); }
    .kpi-input::before { background: var(--primary-purple); }
    .kpi-output::before { background: var(--primary-green); }
    .kpi-cached::before { background: var(--primary-amber); }
    .kpi-requests::before { background: var(--primary-pink); }
    .kpi-accounts::before { background: var(--primary-cyan); }

    .kpi-title {
      font-size: 0.78rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--muted);
      margin-bottom: 6px;
    }

    .kpi-val {
      font-size: 1.6rem;
      font-weight: 700;
      letter-spacing: -0.02em;
      color: var(--fg);
    }

    .kpi-sub {
      font-size: 0.75rem;
      color: var(--muted);
      margin-top: 4px;
    }

    /* Chart section */
    .section-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 8px;
      padding: 18px;
      margin-bottom: 24px;
    }

    .section-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 14px;
    }

    .section-title {
      font-size: 1.05rem;
      font-weight: 600;
    }

    .chart-container {
      width: 100%;
      height: 240px;
      position: relative;
    }

    canvas {
      width: 100% !important;
      height: 100% !important;
      display: block;
    }

    .legend-container {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin-top: 10px;
      font-size: 0.8rem;
      color: var(--muted);
    }

    .legend-item {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .legend-color {
      width: 10px;
      height: 10px;
      border-radius: 2px;
    }

    /* Tables */
    .table-container {
      overflow-x: auto;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
      font-size: 0.88rem;
    }

    th {
      border-bottom: 1px solid var(--card-border);
      padding: 10px 12px;
      font-weight: 600;
      color: var(--muted);
      font-size: 0.8rem;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }

    td {
      padding: 12px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
    }

    tr:hover td {
      background: rgba(255, 255, 255, 0.02);
    }

    .bar-cell {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .bar-bg {
      flex: 1;
      height: 6px;
      background: rgba(255, 255, 255, 0.08);
      border-radius: 3px;
      overflow: hidden;
    }

    .bar-fill {
      height: 100%;
      background: var(--primary-blue);
      border-radius: 3px;
    }

    .empty-state {
      text-align: center;
      padding: 40px;
      color: var(--muted);
      font-size: 0.9rem;
    }
  </style>
</head>
<body>

  <div class="header-bar">
    <div class="title-group">
      <h1>Token & Request Statistics</h1>
      <span class="badge-sandbox">Stealth Sandbox</span>
    </div>

    <div class="controls-group">
      <div class="pill-group" id="timeRangePills">
        <button class="pill-btn" data-range="hourly">Hourly (24h)</button>
        <button class="pill-btn active" data-range="daily">Daily (7d)</button>
        <button class="pill-btn" data-range="weekly">Weekly (30d)</button>
      </div>

      <div class="pill-group" id="viewModePills">
        <button class="pill-btn active" data-mode="model">By Model</button>
        <button class="pill-btn" data-mode="account">By Account</button>
      </div>

      <button class="btn-refresh" id="btnRefresh">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M23 4v6h-6"></path>
          <path d="M1 20v-6h6"></path>
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
        </svg>
        Refresh Stats
      </button>
    </div>
  </div>

  <!-- KPI Grid -->
  <div class="kpi-grid">
    <div class="kpi-card kpi-total">
      <div class="kpi-title">Total Tokens</div>
      <div class="kpi-val" id="kpiTotal">0</div>
      <div class="kpi-sub">Total consumption</div>
    </div>
    <div class="kpi-card kpi-input">
      <div class="kpi-title">Input Tokens</div>
      <div class="kpi-val" id="kpiInput">0</div>
      <div class="kpi-sub" id="kpiCachedRate">0% cached</div>
    </div>
    <div class="kpi-card kpi-output">
      <div class="kpi-title">Output Tokens</div>
      <div class="kpi-val" id="kpiOutput">0</div>
      <div class="kpi-sub">Generated output</div>
    </div>
    <div class="kpi-card kpi-cached">
      <div class="kpi-title">Cached Tokens</div>
      <div class="kpi-val" id="kpiCached">0</div>
      <div class="kpi-sub">Context cache hits</div>
    </div>
    <div class="kpi-card kpi-requests">
      <div class="kpi-title">Total Requests</div>
      <div class="kpi-val" id="kpiRequests">0</div>
      <div class="kpi-sub">Model invocations</div>
    </div>
    <div class="kpi-card kpi-accounts">
      <div class="kpi-title">Active Accounts</div>
      <div class="kpi-val" id="kpiAccounts">0</div>
      <div class="kpi-sub">In profile pool</div>
    </div>
  </div>

  <!-- Trend Chart -->
  <div class="section-card">
    <div class="section-header">
      <div class="section-title" id="chartSectionTitle">Token Consumption Trend</div>
    </div>
    <div class="chart-container">
      <canvas id="trendChart"></canvas>
    </div>
    <div class="legend-container" id="chartLegend"></div>
  </div>

  <!-- Detailed Table -->
  <div class="section-card">
    <div class="section-header">
      <div class="section-title" id="tableSectionTitle">Breakdown by Model</div>
    </div>
    <div class="table-container">
      <table id="statsTable">
        <thead>
          <tr id="tableHeaders"></tr>
        </thead>
        <tbody id="tableBody"></tbody>
      </table>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const COLORS = [
      '#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981',
      '#06b6d4', '#6366f1', '#f43f5e', '#84cc16', '#a855f7'
    ];

    let currentPayload = null;
    let selectedTimeRange = 'daily';
    let selectedViewMode = 'model';

    function formatNumber(num) {
      if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
      if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
      return num.toLocaleString();
    }

    // Canvas trend drawer
    function drawChart(canvas, dataPoints, seriesKeys) {
      const ctx = canvas.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();

      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.scale(dpr, dpr);

      const w = rect.width;
      const h = rect.height;
      ctx.clearRect(0, 0, w, h);

      if (!dataPoints || dataPoints.length === 0) {
        ctx.fillStyle = '#888888';
        ctx.font = '13px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('No usage data recorded for this period yet.', w / 2, h / 2);
        return;
      }

      const padL = 50;
      const padR = 20;
      const padT = 20;
      const padB = 35;
      const plotW = w - padL - padR;
      const plotH = h - padT - padB;

      // Find max value
      let maxVal = 0;
      dataPoints.forEach(p => {
        let sum = 0;
        seriesKeys.forEach(k => {
          sum += (p.series[k] || 0);
        });
        if (sum > maxVal) maxVal = sum;
      });
      if (maxVal === 0) maxVal = 100;

      // Grid lines
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
      ctx.lineWidth = 1;
      ctx.fillStyle = '#888888';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'right';

      const steps = 4;
      for (let i = 0; i <= steps; i++) {
        const y = padT + (plotH / steps) * i;
        const val = Math.round(maxVal - (maxVal / steps) * i);
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(w - padR, y);
        ctx.stroke();
        ctx.fillText(formatNumber(val), padL - 8, y + 3);
      }

      // X-axis labels
      ctx.textAlign = 'center';
      const n = dataPoints.length;
      const stepX = n > 1 ? plotW / (n - 1) : plotW / 2;

      dataPoints.forEach((p, idx) => {
        const x = padL + idx * stepX;
        let label = p.period;
        if (label.includes(' ')) {
          label = label.split(' ')[1]; // show hour
        } else if (label.length > 5) {
          label = label.slice(5); // MM-DD
        }
        if (n <= 12 || idx % Math.ceil(n / 8) === 0) {
          ctx.fillText(label, x, h - 12);
        }
      });

      // Draw series lines
      seriesKeys.forEach((key, sIdx) => {
        const col = COLORS[sIdx % COLORS.length];
        ctx.strokeStyle = col;
        ctx.lineWidth = 2.2;
        ctx.beginPath();

        dataPoints.forEach((p, idx) => {
          const val = p.series[key] || 0;
          const x = padL + idx * stepX;
          const y = padT + plotH - (val / maxVal) * plotH;
          if (idx === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();

        // Draw points
        ctx.fillStyle = col;
        dataPoints.forEach((p, idx) => {
          const val = p.series[key] || 0;
          const x = padL + idx * stepX;
          const y = padT + plotH - (val / maxVal) * plotH;
          ctx.beginPath();
          ctx.arc(x, y, 3, 0, Math.PI * 2);
          ctx.fill();
        });
      });
    }

    function renderUI(payload) {
      currentPayload = payload;

      // KPIs
      const s = payload.summary;
      document.getElementById('kpiTotal').textContent = formatNumber(s.totalTokens);
      document.getElementById('kpiInput').textContent = formatNumber(s.totalInputTokens);
      document.getElementById('kpiOutput').textContent = formatNumber(s.totalOutputTokens);
      document.getElementById('kpiCached').textContent = formatNumber(s.totalCachedTokens);
      document.getElementById('kpiRequests').textContent = s.totalRequests.toLocaleString();
      document.getElementById('kpiAccounts').textContent = s.uniqueAccounts.toLocaleString();

      const cachedPct = s.totalInputTokens > 0
        ? Math.round((s.totalCachedTokens / (s.totalInputTokens + s.totalCachedTokens)) * 100)
        : 0;
      document.getElementById('kpiCachedRate').textContent = cachedPct + '% cached rate';

      // Chart
      const isModelView = payload.viewMode === 'model';
      document.getElementById('chartSectionTitle').textContent =
        isModelView ? 'Token Consumption Trend (By Model)' : 'Token Consumption Trend (By Account)';
      document.getElementById('tableSectionTitle').textContent =
        isModelView ? 'Detailed Breakdown by Model' : 'Detailed Breakdown by Account';

      const trendData = isModelView ? payload.modelTrend : payload.accountTrend;
      const allKeys = isModelView
        ? payload.modelStats.map(m => m.model)
        : payload.accountStats.map(a => a.accountEmail);

      const canvas = document.getElementById('trendChart');
      drawChart(canvas, trendData, allKeys.slice(0, 8));

      // Legend
      const legendBox = document.getElementById('chartLegend');
      legendBox.innerHTML = '';
      allKeys.slice(0, 8).forEach((key, idx) => {
        const item = document.createElement('div');
        item.className = 'legend-item';
        item.innerHTML = \`<span class="legend-color" style="background:\${COLORS[idx % COLORS.length]}"></span><span>\${key}</span>\`;
        legendBox.appendChild(item);
      });

      // Table
      const headers = document.getElementById('tableHeaders');
      const tbody = document.getElementById('tableBody');
      tbody.innerHTML = '';

      if (isModelView) {
        headers.innerHTML = \`
          <th>Model</th>
          <th>Requests</th>
          <th>Input</th>
          <th>Output</th>
          <th>Cached</th>
          <th>Total Tokens</th>
          <th style="width: 140px;">Share</th>
        \`;

        if (payload.modelStats.length === 0) {
          tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No model usage recorded yet. Click "Refresh Stats" to sync.</td></tr>';
        } else {
          payload.modelStats.forEach(m => {
            const tr = document.createElement('tr');
            tr.innerHTML = \`
              <td><strong>\${m.model}</strong></td>
              <td>\${m.requestCount.toLocaleString()}</td>
              <td>\${formatNumber(m.totalInputTokens)}</td>
              <td>\${formatNumber(m.totalOutputTokens)}</td>
              <td>\${formatNumber(m.totalCachedTokens)}</td>
              <td><strong>\${formatNumber(m.totalTokens)}</strong></td>
              <td>
                <div class="bar-cell">
                  <div class="bar-bg"><div class="bar-fill" style="width: \${m.percentage || 0}%;"></div></div>
                  <span>\${m.percentage || 0}%</span>
                </div>
              </td>
            \`;
            tbody.appendChild(tr);
          });
        }
      } else {
        headers.innerHTML = \`
          <th>Account Email</th>
          <th>Requests</th>
          <th>Input</th>
          <th>Output</th>
          <th>Cached</th>
          <th>Total Tokens</th>
          <th style="width: 140px;">Share</th>
        \`;

        if (payload.accountStats.length === 0) {
          tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No account usage recorded yet. Click "Refresh Stats" to sync.</td></tr>';
        } else {
          payload.accountStats.forEach(a => {
            const tr = document.createElement('tr');
            tr.innerHTML = \`
              <td><strong>\${a.accountEmail}</strong></td>
              <td>\${a.requestCount.toLocaleString()}</td>
              <td>\${formatNumber(a.totalInputTokens)}</td>
              <td>\${formatNumber(a.totalOutputTokens)}</td>
              <td>\${formatNumber(a.totalCachedTokens)}</td>
              <td><strong>\${formatNumber(a.totalTokens)}</strong></td>
              <td>
                <div class="bar-cell">
                  <div class="bar-bg"><div class="bar-fill" style="width: \${a.percentage || 0}%;"></div></div>
                  <span>\${a.percentage || 0}%</span>
                </div>
              </td>
            \`;
            tbody.appendChild(tr);
          });
        }
      }
    }

    // Event listeners
    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.type === 'update') {
        renderUI(msg.payload);
      } else if (msg.type === 'syncDone') {
        const btn = document.getElementById('btnRefresh');
        btn.disabled = false;
        btn.innerHTML = \`
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
          Updated!
        \`;
        setTimeout(() => {
          btn.innerHTML = \`
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M23 4v6h-6"></path><path d="M1 20v-6h6"></path>
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
            </svg>
            Refresh Stats
          \`;
        }, 1800);
      }
    });

    // Time range pills
    document.querySelectorAll('#timeRangePills .pill-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#timeRangePills .pill-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        selectedTimeRange = btn.getAttribute('data-range');
        vscode.postMessage({ command: 'setTimeRange', value: selectedTimeRange });
      });
    });

    // View mode pills
    document.querySelectorAll('#viewModePills .pill-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#viewModePills .pill-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        selectedViewMode = btn.getAttribute('data-mode');
        vscode.postMessage({ command: 'setViewMode', value: selectedViewMode });
      });
    });

    // Refresh button
    document.getElementById('btnRefresh').addEventListener('click', () => {
      const btn = document.getElementById('btnRefresh');
      btn.disabled = true;
      btn.textContent = 'Syncing...';
      vscode.postMessage({ command: 'refresh' });
    });

    // Resize handler for responsive charts
    window.addEventListener('resize', () => {
      if (currentPayload) {
        renderUI(currentPayload);
      }
    });

    // Initial signal
    vscode.postMessage({ command: 'ready' });
  </script>
</body>
</html>`;
  }
}

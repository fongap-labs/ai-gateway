// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

export const THEME_CSS = `
:root{
  --paper:#f8f7f3;
  --paper-2:#f2f0ea;
  --surface:#ffffff;
  --surface-soft:#f4f3ee;
  --card-border:rgba(27,30,28,.06);
  --ink:#1b1e1c;
  --ink-2:#565b54;
  --ink-3:#8b8f84;

  --brand:#0f5d53;
  --brand-deep:#0a413a;
  --brand-soft:#e4efec;
  --data-1:#0f5d53;
  --data-2:#3f8b7c;
  --data-3:#7cb4a5;
  --data-4:#a9d0c4;

  --heat-1:#bfdcd2;
  --heat-2:#8cc3b2;
  --heat-3:#4f9f8a;
  --heat-4:#0f5d53;

  --ok:#3f8b7c;
  --ok-soft:#e4efec;
  --amber:#b4793b;
  --amber-soft:#f3e8d9;
  --red:#a75b58;
  --red-soft:#f1e1df;

  --radius:16px;
  --content:76rem;
  --shadow:0 1px 2px rgba(20,20,15,.025),0 12px 28px -22px rgba(20,20,15,.18);
}
*{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
body{
  margin:0;
  background:radial-gradient(circle at 50% -16%,rgba(15,93,83,.055),transparent 30%),var(--paper);
  color:var(--ink);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  line-height:1.65
}
::selection{background:var(--brand-soft);color:var(--brand-deep)}
a{color:inherit;text-decoration:none}
button{font:inherit}
.wrap{width:min(var(--content),calc(100% - 64px));margin:0 auto;min-width:0}
.sr-only{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}

header{padding:16px 0 12px;background:rgba(248,247,243,.82);backdrop-filter:blur(10px)}
.header-row{display:flex;align-items:center;justify-content:space-between;gap:24px}
.brand{display:flex;align-items:center;gap:13px}
.brand-logo{width:38px;height:38px;display:block;color:var(--brand);flex:none}
.brand-copy{display:flex;flex-direction:column;gap:1px;min-width:0}
.brand-name{font-size:18px;font-weight:650;letter-spacing:-.015em;line-height:1.25}
.brand-slogan{color:var(--ink-3);font-size:11.5px;line-height:1.35;white-space:nowrap}
.github{display:flex;align-items:center;gap:8px;padding:8px 11px;border-radius:10px;color:var(--ink-3);font-size:12px;transition:color .16s ease,background .16s ease}
.github:hover{color:var(--ink);background:var(--surface-soft)}
.github:focus-visible{outline:2px solid var(--brand);outline-offset:3px}

.main-content{padding:4px 0 4px}
section{padding:24px 0}
section+section{padding-top:18px}
.section-head{display:flex;align-items:baseline;justify-content:space-between;gap:20px;margin-bottom:12px}
.section-title{font-size:16px;font-weight:650;letter-spacing:.005em}
.section-sub{margin-left:auto;color:var(--ink-3);font-size:12px;white-space:nowrap}

.status-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px;min-width:0}
.status-panel,.stat,.composition-card,.usage-panel,.code-card,.fallback-card{
  border:1px solid var(--card-border);
  background:var(--surface);
  box-shadow:var(--shadow);
}
.status-panel{border-radius:var(--radius);padding:18px 22px 16px;min-width:0;overflow:hidden}
.status-panel-head{display:flex;align-items:baseline;justify-content:space-between;gap:16px;margin-bottom:12px}
.status-panel-title{font-size:16px;font-weight:650}
.status-panel-note{color:var(--ink-3);font-size:11.5px}
.model-table-head,.model-row{
  display:grid;
  grid-template-columns:minmax(0,1.35fr) minmax(0,.95fr) minmax(48px,.55fr) minmax(48px,.55fr) minmax(64px,.8fr);
  column-gap:14px;
  align-items:center;
}
.model-table-head{padding:0 8px 5px;color:var(--ink-3);font-size:10.5px}
.model-table-head span:nth-child(n+3){text-align:right}
.status-grid-inner{display:grid;gap:2px}
.model-row{padding:7px 8px;border-radius:10px;font-size:12px}
.model-row:hover{background:var(--surface-soft)}
.mr-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;font-size:12.5px}
.mr-status-cell{display:flex;align-items:center;gap:8px;min-width:0}
.mr-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--ok);box-shadow:0 0 0 3px var(--ok-soft)}
.mr-dot.warn{background:var(--amber);box-shadow:0 0 0 3px var(--amber-soft)}
.mr-dot.muted{background:var(--ink-3);box-shadow:0 0 0 3px #eef1f5}
.mr-dot.down{background:var(--red);box-shadow:0 0 0 3px var(--red-soft)}
.mr-status{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink-2);font-size:11.5px}
.mr-p50-val,.mr-p95-val,.mr-samples{text-align:right;font-variant-numeric:tabular-nums}
.mr-p50-val,.mr-p95-val{color:var(--ink-2);font-weight:550}
.mr-samples{color:var(--ink-3)}

.stat-row{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;margin-bottom:18px;min-width:0}
.stat{min-height:102px;padding:17px 20px;border-radius:var(--radius);display:flex;flex-direction:column;justify-content:center;min-width:0;overflow:hidden}
.stat-label{margin-bottom:6px;color:var(--ink-3);font-size:12px;line-height:1.5}
.stat-value{font-family:"Songti SC","STSong","SimSun","Noto Serif CJK SC",serif;font-weight:500;font-size:clamp(30px,3.2vw,38px);line-height:1.15;letter-spacing:-.025em;font-variant-numeric:tabular-nums}

.composition-card{border-radius:var(--radius);padding:18px 22px;margin-bottom:20px}
.panel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin-bottom:18px}
.panel-title{color:var(--ink);font-size:14px;font-weight:650}
.panel-note,.panel-meta{margin-top:2px;color:var(--ink-3);font-size:11.5px}
.panel-meta{white-space:nowrap}
.composition-data{display:grid;gap:18px;min-width:0}
.composition-track{display:flex;width:100%;height:8px;overflow:hidden;border-radius:99px;background:var(--surface-soft)}
.composition-track i{display:block;height:100%}
.composition-input{background:var(--data-1)}
.composition-cache{background:var(--data-2)}
.composition-output{background:var(--data-3)}
.composition-metrics{display:grid;gap:24px}
.composition-metrics.four-up{grid-template-columns:repeat(4,minmax(0,1fr))}
.composition-metric{min-width:0;display:grid;grid-template-rows:20px 30px 16px;align-content:start}
.composition-metric.metric-left{justify-items:start;text-align:left}
.composition-metric.metric-center{justify-items:center;text-align:center}
.composition-metric.metric-right{justify-items:end;text-align:right}
.composition-label{display:inline-flex;align-items:center;gap:8px;width:max-content;max-width:100%;color:var(--ink-3);font-size:11.5px;line-height:20px;white-space:nowrap}
.metric-dot{width:7px;height:7px;border-radius:50%;flex:none}
.metric-dot.input{background:var(--data-1)}
.metric-dot.output{background:var(--data-3)}
.metric-dot.cache{background:var(--data-2)}
.composition-metric strong{display:block;margin:0;font-size:19px;font-weight:650;line-height:30px;font-variant-numeric:tabular-nums}
.composition-metric small{display:block;margin:0;color:var(--ink-3);font-size:10.5px;line-height:16px}

.usage-detail-grid{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(0,.85fr);gap:24px;min-width:0}
.usage-panel{border-radius:var(--radius);padding:24px 26px;min-width:0;overflow:hidden}
.heatmap-wrap{overflow-x:auto;padding-bottom:2px;margin:0}
.heatmap{display:grid;grid-template-columns:repeat(var(--week-count,52),1fr);grid-template-rows:repeat(7,11px);gap:4px;min-width:610px}
.cell{height:11px;border-radius:3px;background:#edf1f6;outline:none}
.cell[data-level="1"]{background:var(--heat-1)}
.cell[data-level="2"]{background:var(--heat-2)}
.cell[data-level="3"]{background:var(--heat-3)}
.cell[data-level="4"]{background:var(--heat-4)}
.cell:focus-visible{outline:2px solid var(--brand);outline-offset:1px}
.months{display:grid;grid-template-columns:repeat(var(--week-count,52),1fr);column-gap:4px;min-width:610px;margin-top:10px;color:var(--ink-3);font-size:10px}
.months span{grid-row:1;justify-self:start;white-space:nowrap}
.cell[data-future="1"]{background:transparent;box-shadow:inset 0 0 0 1px #e7ebf1}
.cell[data-inrange="0"]{opacity:.28}

.model-ranking{display:flex;flex-direction:column;gap:2px}
.model-rank-row{display:grid;grid-template-columns:20px minmax(0,1.15fr) minmax(60px,1fr) minmax(58px,.55fr) 44px;gap:11px;align-items:center;padding:6px 8px;border-radius:10px;font-size:11.5px;min-width:0}
.model-rank-row:hover{background:var(--surface-soft)}
.model-rank-index{color:var(--ink-3);text-align:center;font-variant-numeric:tabular-nums}
.model-rank-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;color:var(--ink-2)}
.model-rank-bar{height:6px;border-radius:99px;background:var(--surface-soft);overflow:hidden}
.model-rank-bar i{display:block;width:var(--w);height:100%;border-radius:99px;background:var(--c)}
.model-rank-value,.model-rank-share{text-align:right;font-variant-numeric:tabular-nums}
.model-rank-value{color:var(--ink-2)}
.model-rank-share{color:var(--ink-3)}
.model-panel .panel-head{margin-bottom:14px}
.model-usage-empty{padding:34px 0;text-align:center;font-size:12.5px;color:var(--ink-3)}

.tabs{display:flex;gap:24px;margin-bottom:22px}
.tab{position:relative;padding:0 0 11px;border:0;background:none;color:var(--ink-3);cursor:pointer;font-size:13px}
.tab.active{color:var(--brand-deep);font-weight:600}
.tab.active::after{content:"";position:absolute;left:0;right:0;bottom:0;height:2px;border-radius:99px;background:var(--brand)}
.tab:focus-visible{outline:2px solid var(--brand);outline-offset:3px}
.code-card{position:relative;padding:28px 30px;border-radius:var(--radius)}
.code-line{overflow-x:auto;white-space:pre;color:var(--ink-2);font-size:13px;line-height:1.8;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace}
.code-line+.code-line{margin-top:6px}
.code-key{color:var(--ink-3)}
.code-value{color:var(--brand-deep)}
.copy{position:absolute;top:22px;right:24px;border:0;border-radius:9px;padding:7px 13px;background:var(--brand-soft);color:var(--brand-deep);cursor:pointer;font-size:12px}
.copy:hover{background:#d7e8e2}
.copy:focus-visible{outline:2px solid var(--brand);outline-offset:2px}

.tooltip{position:fixed;pointer-events:none;z-index:1000;background:var(--surface);border:1px solid var(--card-border);border-radius:10px;padding:7px 11px;font-size:12px;color:var(--ink);box-shadow:0 8px 24px rgba(35,54,86,.12);white-space:pre-wrap;width:max-content;max-width:90vw;opacity:0;transition:opacity 120ms ease}
.tooltip.show{opacity:1}

.fallback-section{padding:64px 0}
.fallback-card{max-width:560px;margin:0 auto;padding:42px;border-radius:var(--radius);text-align:center}
.fallback-card h1{font-size:24px;margin-bottom:8px}
.fallback-card p{color:var(--ink-3)}

footer{padding:34px 0 42px;color:var(--ink-3);font-size:12px}
.footer-row{display:flex;align-items:center;justify-content:center;gap:10px;flex-wrap:wrap}
.footer-row a:hover{color:var(--brand-deep)}
.footer-sep{color:#b8bbb4}

@media(min-width:761px) and (max-height:900px){
  header{padding:12px 0 9px}
  .brand-logo{width:34px;height:34px}
  .brand-name{font-size:16px}
  .brand-slogan{font-size:10.5px}
  .main-content{padding-top:0}
  section{padding:18px 0}
  section+section{padding-top:12px}
  .section-head{margin-bottom:9px}
  .status-panel{padding:14px 18px 12px}
  .status-panel-head{margin-bottom:7px}
  .model-table-head{padding-bottom:3px}
  .model-row{padding:5px 7px}
  .stat-row{margin-bottom:14px}
  .stat{min-height:88px;padding:13px 17px}
  .stat-label{margin-bottom:5px}
  .stat-value{font-size:clamp(27px,2.8vw,34px)}
}
@media(max-width:1120px){
  .status-grid{grid-template-columns:1fr}
  .usage-detail-grid{grid-template-columns:1fr}
}
@media(max-width:980px){
  .composition-data{gap:12px}
  .composition-metrics.four-up{grid-template-columns:repeat(2,minmax(0,1fr))}
}
@media(max-width:760px){
  .wrap{width:calc(100% - 36px)}
  .heatmap{grid-template-rows:repeat(7,10px)}
  .cell{height:10px}
  header{padding:18px 0 15px}
  .brand-logo{width:34px;height:34px}
  .brand-name{font-size:16px}
  .brand-slogan{font-size:10.5px}
  .github span{display:none}
  .main-content{padding-top:6px}
  section{padding:26px 0}
  .stat-row{grid-template-columns:1fr 1fr;gap:12px}
  .stat{min-height:108px;padding:17px}
  .composition-card,.usage-panel,.status-panel{padding:20px}
  .composition-data{gap:12px}
  .composition-metrics{gap:16px}
  .model-table-head,.model-row{grid-template-columns:minmax(88px,1fr) 88px 52px 52px 58px;column-gap:8px}
  .model-table-head{font-size:9.5px}
  .model-row{font-size:11px}
  .mr-name{font-size:11.5px}
  .mr-status{font-size:10.5px}
  .model-rank-row{grid-template-columns:18px minmax(90px,1fr) minmax(60px,.8fr) 60px 42px;gap:8px}
  .code-card{padding:22px 20px}
  .copy{position:static;margin-top:16px}
}
@media(max-width:500px){
  .brand-slogan{white-space:normal;max-width:220px}
  .model-table-head span:nth-child(2),.mr-status-cell{display:none}
  .model-table-head,.model-row{grid-template-columns:minmax(92px,1fr) 54px 54px 60px}
  .model-table-head span:nth-child(3){grid-column:2}
  .model-table-head span:nth-child(4){grid-column:3}
  .model-table-head span:nth-child(5){grid-column:4}
  .model-rank-row{grid-template-columns:18px minmax(86px,1fr) 54px 42px}
  .model-rank-bar{display:none}
  .composition-metrics.four-up{grid-template-columns:1fr 1fr}
  .stat-value{font-size:29px}
}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}*{transition:none!important}}
@media(forced-colors:active){.cell{border:1px solid CanvasText}}
`;

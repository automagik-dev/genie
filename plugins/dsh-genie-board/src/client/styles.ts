/**
 * Plugin stylesheet, injected once as <style data-plugin="@automagik/genie-dsh-board">.
 * Every color, radius and font comes from DSH alias tokens so the panels follow
 * the active theme (light, dark, high contrast) without a palette of their own.
 */
export const css = `
.gb-panel{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font-size:13px;line-height:20px}
.gb-panel *,.gb-panel *::before,.gb-panel *::after{box-sizing:border-box}
.gb-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:12px 20px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.gb-title{display:flex;align-items:center;gap:8px;margin:0 auto 0 0;font-size:15px;font-weight:600;line-height:24px}
.gb-title svg{color:var(--dsw-alias-label-secondary)}
.gb-sub{color:var(--dsw-alias-label-tertiary);font-weight:400;font-size:12px}
.gb-select{appearance:none;-webkit-appearance:none;height:28px;padding:0 26px 0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 14 14' fill='none' stroke='%23888' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M3.5 5.5L7 9l3.5-3.5'/%3E%3C/svg%3E") no-repeat right 8px center;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;max-width:260px;text-overflow:ellipsis;cursor:pointer}
.gb-select:hover{background-color:var(--dsw-alias-interactive-bg-hover)}
.gb-status{display:flex;align-items:center;gap:8px;min-height:32px;padding:6px 20px;color:var(--dsw-alias-label-tertiary);font-size:12px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.gb-status[data-tone=error]{color:var(--dsw-alias-state-error-primary)}
.gb-status[data-tone=ok]{color:var(--dsw-alias-state-success-primary)}
.gb-body{display:flex;flex:1;min-height:0}
.gb-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;flex:1;padding:40px 20px;color:var(--dsw-alias-label-tertiary);text-align:center}
.gb-empty strong{color:var(--dsw-alias-label-secondary);font-weight:500}
.gb-lanes{display:flex;flex:1;gap:12px;min-width:0;padding:16px 20px 20px;overflow:auto}
.gb-lane{display:flex;flex-direction:column;flex:1 0 240px;min-width:240px;max-width:340px;min-height:0;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}
.gb-lane-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);font-weight:500}
.gb-lane-head .gb-count{margin-left:auto;padding:0 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:18px}
.gb-lane-body{display:flex;flex-direction:column;gap:8px;padding:10px;overflow:auto;min-height:60px}
.gb-lane-body:empty::after{content:'No tasks';color:var(--dsw-alias-label-dimmed);font-size:12px;padding:6px 2px}
.gb-card{display:flex;flex-direction:column;gap:6px;width:100%;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-left:3px solid var(--gb-accent,var(--dsw-alias-border-l3));border-radius:10px;background:var(--dsw-alias-bg-base);color:inherit;font:inherit;text-align:left;cursor:pointer;transition:background 80ms ease,border-color 80ms ease}
.gb-card:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l3);box-shadow:var(--dsw-shadow-lv2,0 2px 8px rgba(0,0,0,.08));transform:translateY(-1px)}
.gb-card:active{transform:translateY(1px)}
.gb-card[aria-pressed=true]{border-color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-active)}
.gb-card:focus-visible,.gb-item:focus-visible,.gb-select:focus-visible,.gb-textarea:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.gb-card-title{font-weight:500;overflow-wrap:anywhere}
.gb-card-meta{display:flex;flex-wrap:wrap;align-items:center;gap:6px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.gb-card[data-status=ready]{--gb-accent:var(--dsw-alias-state-business-primary)}
.gb-card[data-status=in_progress]{--gb-accent:var(--dsw-alias-state-warn-primary)}
.gb-card[data-status=done]{--gb-accent:var(--dsw-alias-state-success-primary)}
.gb-card[data-status=blocked]{--gb-accent:var(--dsw-alias-state-error-primary)}
.gb-detail{display:flex;flex-direction:column;width:min(720px,58%);flex:none;min-height:0;border-left:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.gb-detail-head{display:flex;flex-direction:column;gap:10px;padding:14px 18px 12px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.gb-detail-title h2{margin:0;font-size:15px;line-height:22px;font-weight:600;overflow-wrap:anywhere}
.gb-toolbar{padding-top:2px}
.gb-detail-body{display:grid;grid-template-columns:minmax(0,1fr) 260px;flex:1;min-height:0}
.gb-chat{display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--dsw-alias-border-l2)}
.gb-chat-head{margin:0;padding:14px 18px 0}
.gb-chat-log{flex:1;min-height:0;overflow:auto;padding:14px 18px;display:flex;flex-direction:column;gap:10px}
.gb-chat-empty{margin:auto;max-width:320px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.gb-msg{padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-base)}
.gb-msg[data-kind=report]{border-color:var(--dsw-alias-state-business-primary)}
.gb-msg header{display:flex;align-items:center;gap:8px;margin-bottom:4px;font-size:12px}
.gb-msg header strong{font-weight:600}
.gb-msg-kind{color:var(--dsw-alias-label-tertiary)}
.gb-msg header time{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:11px;white-space:nowrap}
.gb-msg p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
.gb-composer{display:flex;flex-direction:column;gap:8px;padding:10px 18px 14px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.gb-composer .gb-textarea{min-height:56px}
.gb-audit{display:flex;flex-direction:column;gap:12px;min-height:0;padding:14px 16px;overflow:auto}
.gb-audit h3,.gb-detail h3{margin:0;font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-secondary);text-transform:uppercase;letter-spacing:.04em}
.gb-audit-list{margin:0;padding:0 0 0 10px;list-style:none;display:flex;flex-direction:column;gap:10px;border-left:2px solid var(--dsw-alias-border-l2)}
.gb-audit-list li{position:relative;display:grid;grid-template-columns:44px 1fr;gap:8px;padding-left:10px;font-size:12px;line-height:16px}
.gb-audit-list li::before{content:'';position:absolute;left:-7px;top:4px;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-border-l3);border:2px solid var(--dsw-alias-bg-layer-1)}
.gb-audit-now::before{background:var(--dsw-alias-state-business-primary)!important}
.gb-audit-list time{color:var(--dsw-alias-label-tertiary);white-space:nowrap;font-variant-numeric:tabular-nums}
.gb-audit-list div{display:flex;flex-direction:column;gap:1px;min-width:0}
.gb-audit-label{overflow-wrap:anywhere;white-space:pre-wrap}
.gb-audit-by{color:var(--dsw-alias-label-tertiary);font-size:11px}
.gb-audit-held{color:var(--dsw-alias-label-tertiary);font-size:11px;font-style:italic}
.gb-kv{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:12px}
.gb-kv dt{color:var(--dsw-alias-label-tertiary)}
.gb-kv dd{margin:0;overflow-wrap:anywhere}
.gb-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.gb-textarea{width:100%;min-height:72px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:inherit;font:inherit;resize:vertical}
.gb-mono{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;color:var(--dsw-alias-label-tertiary)}
.gb-list{display:flex;flex-direction:column;width:340px;flex:none;min-height:0;border-right:1px solid var(--dsw-alias-border-l2);overflow:auto}
.gb-list-search{position:sticky;top:0;z-index:1;padding:12px 12px 8px;background:var(--dsw-alias-bg-base)}
.gb-group{display:flex;flex-direction:column}
.gb-group-head{position:sticky;top:44px;padding:8px 16px 4px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase}
.gb-item{display:flex;flex-direction:column;gap:3px;width:100%;padding:10px 16px;border:0;border-bottom:1px solid var(--dsw-alias-border-l1);background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.gb-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.gb-item[aria-current=true]{background:var(--dsw-alias-interactive-bg-active)}
.gb-item-name{display:flex;align-items:center;gap:8px;font-weight:500}
.gb-item-desc{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:17px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.gb-doc{flex:1;min-width:0;display:flex;flex-direction:column;min-height:0}
.gb-doc-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;padding:14px 20px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.gb-doc-head h2{margin:0 auto 0 0;font-size:15px;font-weight:600}
.gb-doc-body{flex:1;min-height:0;overflow:auto;padding:16px 20px 24px}
.gb-doc-desc{margin:0 0 14px;color:var(--dsw-alias-label-secondary)}
.gb-phases{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 16px;padding:0;list-style:none;counter-reset:phase}
.gb-phases li{display:flex;align-items:baseline;gap:8px;padding:6px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);font-size:12px}
.gb-phases li::before{counter-increment:phase;content:counter(phase);display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);font-size:11px}
.gb-phases small{color:var(--dsw-alias-label-tertiary)}
.gb-pre{margin:0;padding:14px 16px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-markdown-code-block,var(--dsw-alias-bg-layer-1));font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;line-height:18px;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary)}
.gb-chips{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 14px}
.gb-invoke{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0 0 14px;padding:10px 12px;border:1px dashed var(--dsw-alias-border-l3);border-radius:10px;color:var(--dsw-alias-label-secondary);font-size:12px}
.gb-invoke code{padding:1px 6px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);color:var(--dsw-alias-label-primary)}
@media (prefers-reduced-motion:reduce){.gb-card,.gb-select{transition:none}.gb-card:hover,.gb-card:active{transform:none}}
@media (max-width:768px){.gb-head{padding:10px 12px}.gb-lanes{padding:12px;gap:10px;scroll-snap-type:inline mandatory}.gb-lane{flex-basis:86vw;min-width:86vw;scroll-snap-align:start}.gb-select,.gb-card,.gb-item{min-height:44px}.gb-textarea,.gb-select{font-size:16px}}
@media (max-width:900px){.gb-body{flex-direction:column}.gb-detail,.gb-list{width:100%;flex:none;border-left:0;border-right:0;border-top:1px solid var(--dsw-alias-border-l2);max-height:60%}.gb-detail-body{grid-template-columns:1fr}.gb-audit{border-top:1px solid var(--dsw-alias-border-l2)}.gb-lane{flex-basis:220px;min-width:220px}}
`;

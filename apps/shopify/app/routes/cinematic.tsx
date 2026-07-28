import type { LoaderFunctionArgs } from "react-router";

// Standalone, full-fidelity cinematic onboarding demo asset.
// Served as a public resource route (no App Bridge/auth) so it can be opened
// and screen-recorded directly. This is the demo-video incarnation of the
// design_handoff_jefe_onboarding_cinematic handoff; the real merchant-paced
// App Bridge integration (9s dwell, event-driven ingestion, throughput ETA,
// tiered insight streaming, real OAuth) is a separate build. Does NOT touch
// the working Polaris onboarding funnel in app._index.tsx.

const HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Jefe — Onboarding</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='17' fill='%231b2338'/%3E%3Cpath d='M28 16h11v26c0 8-5 12-13 12-4 0-7-1.5-9-4l5-6c1 1.3 2.5 2 4 2 2.5 0 2-3.5 2-6.5V16z' fill='%23f8ece7'/%3E%3Ccircle cx='32' cy='49' r='4.5' fill='%23c98a8a'/%3E%3C/svg%3E" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Schibsted+Grotesk:wght@400;500;600;700;800&family=Bricolage+Grotesque:wght@600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet" />
<style>
  html,body{margin:0;height:100%;background:#0c0f1a;}
  *{box-sizing:border-box;}
  @keyframes fadeUp{from{opacity:0;transform:translateY(16px);}to{opacity:1;transform:none;}}
  @keyframes fadeDown{from{opacity:0;transform:translateY(-12px);}to{opacity:1;transform:none;}}
  @keyframes fadeIn{from{opacity:0;}to{opacity:1;}}
  @keyframes fadeOut{to{opacity:0;}}
  @keyframes popIn{0%{opacity:0;transform:scale(0.86);}62%{transform:scale(1.04);}100%{opacity:1;transform:scale(1);}}
  @keyframes spin{to{transform:rotate(360deg);}}
  @keyframes breathe{0%,100%{transform:scale(1);opacity:1;}50%{transform:scale(1.045);opacity:0.92;}}
  @keyframes ringOut{0%{transform:scale(0.72);opacity:0.75;}100%{transform:scale(1.9);opacity:0;}}
  @keyframes typeIn{from{max-width:0;}to{max-width:100%;}}
  @keyframes caret{0%,100%{border-color:oklch(0.78 0.13 15);}50%{border-color:transparent;}}
  @keyframes drawLine{from{stroke-dashoffset:120;}to{stroke-dashoffset:0;}}
  @keyframes nodeIn{0%{opacity:0;transform:translate(-50%,-50%) scale(0.4);}100%{opacity:1;transform:translate(-50%,-50%) scale(1);}}
  @keyframes pulseDot{0%,100%{opacity:1;}50%{opacity:0.3;}}
  @keyframes drift1{0%,100%{transform:translate(0,0);}50%{transform:translate(60px,-40px);}}
  @keyframes drift2{0%,100%{transform:translate(0,0);}50%{transform:translate(-70px,50px);}}
  @keyframes glowPulse{0%,100%{box-shadow:0 0 0 0 oklch(0.72 0.13 15 / 0.5);}70%{box-shadow:0 0 0 16px oklch(0.72 0.13 15 / 0);}}
  @keyframes meterFill{from{width:0;}to{width:var(--w,70%);}}
  @keyframes sweep{0%{transform:translateX(-120%);}100%{transform:translateX(120%);}}
  @keyframes flowDash{to{stroke-dashoffset:-40;}}
  /* Responsive — hold up on smaller widths and the shorter App Bridge iframe */
  @media (max-width: 860px){
    #root div[style*="grid-template-columns"]{grid-template-columns:1fr !important;}
    #root [style*="padding:20px 40px 68px"]{padding:16px 16px 60px !important;}
    #root [style*="gap:28px"]{gap:16px !important;row-gap:10px !important;}
  }
  @media (max-width: 560px){
    #root [style*="font-size:44px"]{font-size:29px !important;}
    #root [style*="font-size:42px"]{font-size:29px !important;}
    #root [style*="font-size:40px"]{font-size:27px !important;}
    #root [style*="font-size:26px"]{font-size:21px !important;}
    #root [style*="font-size:12.5px"]{font-size:11px !important;}
    #root [style*="height:322px"]{transform:scale(0.8);transform-origin:center top;margin-bottom:-40px;}
    #root [style*="max-width:520px"]{max-width:100% !important;}
    #root [style*="white-space:nowrap"]{white-space:normal !important;}
  }
</style>
</head>
<body>
<div id="root" style="height:100vh;position:relative;overflow:hidden;display:flex;flex-direction:column;font-family:'Schibsted Grotesk',sans-serif;color:oklch(0.95 0.012 80);background:radial-gradient(1100px 620px at 50% 12%, oklch(0.26 0.05 268), oklch(0.145 0.03 265) 62%), #0c0f1a;">

  <div style="position:absolute;top:-14%;left:8%;width:640px;height:640px;border-radius:50%;background:radial-gradient(circle, oklch(0.5 0.11 285 / 0.30), transparent 66%);filter:blur(30px);animation:drift1 22s ease-in-out infinite;pointer-events:none;"></div>
  <div style="position:absolute;bottom:-18%;right:4%;width:620px;height:620px;border-radius:50%;background:radial-gradient(circle, oklch(0.62 0.12 18 / 0.22), transparent 66%);filter:blur(34px);animation:drift2 26s ease-in-out infinite;pointer-events:none;"></div>
  <div style="position:absolute;inset:0;background-image:linear-gradient(oklch(0.75 0.03 265 / 0.05) 1px, transparent 1px), linear-gradient(90deg, oklch(0.75 0.03 265 / 0.05) 1px, transparent 1px);background-size:62px 62px;mask-image:radial-gradient(80% 70% at 50% 40%, black, transparent);-webkit-mask-image:radial-gradient(80% 70% at 50% 40%, black, transparent);pointer-events:none;"></div>

  <div style="position:absolute;top:0;left:0;right:0;height:2px;background:oklch(0.3 0.04 265);z-index:5;">
    <div id="hairline" style="height:100%;width:0%;background:linear-gradient(90deg, oklch(0.62 0.1 285), oklch(0.78 0.13 15));box-shadow:0 0 12px oklch(0.72 0.13 15 / 0.8);transition:width 0.6s ease;"></div>
  </div>

  <div id="chip-loading" style="display:none;position:absolute;bottom:70px;left:26px;z-index:7;align-items:center;gap:10px;background:oklch(0.22 0.04 265 / 0.9);border:1px solid oklch(0.42 0.06 268);border-radius:100px;padding:8px 15px;backdrop-filter:blur(10px);font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:oklch(0.86 0.02 265);box-shadow:0 0 24px -6px oklch(0.5 0.1 285 / 0.5);">
    <span style="width:10px;height:10px;border-radius:50%;border:1.5px solid oklch(0.8 0.13 15);border-top-color:transparent;animation:spin 0.9s linear infinite;display:inline-block;"></span>
    <span id="chip-text">Reading your store · 0%</span>
  </div>
  <div id="chip-ready" style="display:none;position:absolute;bottom:70px;left:26px;z-index:7;align-items:center;gap:10px;background:oklch(0.26 0.06 155 / 0.92);border:1px solid oklch(0.6 0.13 155);border-radius:100px;padding:8px 15px;backdrop-filter:blur(10px);font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:oklch(0.93 0.03 155);box-shadow:0 0 26px -4px oklch(0.65 0.15 155 / 0.6);animation:popIn 0.5s cubic-bezier(0.2,0.9,0.2,1);">
    <span style="width:16px;height:16px;border-radius:50%;background:oklch(0.68 0.15 155);color:oklch(0.16 0.03 265);display:flex;align-items:center;justify-content:center;font-size:10px;">✓</span>
    <span>Store read · 4 findings ready</span>
  </div>

  <div style="position:relative;z-index:3;flex:none;display:flex;align-items:center;justify-content:center;gap:28px;padding:22px 32px 8px;flex-wrap:wrap;">
    <div id="rail-0" onclick="go(0)" style="display:flex;align-items:center;gap:9px;cursor:pointer;transition:opacity 0.4s ease;"><span id="raildot-0" style="width:7px;height:7px;border-radius:50%;"></span><span id="raillab-0" style="font-family:'IBM Plex Mono',monospace;font-size:11px;letter-spacing:1.6px;text-transform:uppercase;white-space:nowrap;">Connect</span></div>
    <div id="rail-1" onclick="go(1)" style="display:flex;align-items:center;gap:9px;cursor:pointer;transition:opacity 0.4s ease;"><span id="raildot-1" style="width:7px;height:7px;border-radius:50%;"></span><span id="raillab-1" style="font-family:'IBM Plex Mono',monospace;font-size:11px;letter-spacing:1.6px;text-transform:uppercase;white-space:nowrap;">Integrations</span></div>
    <div id="rail-2" onclick="go(2)" style="display:flex;align-items:center;gap:9px;cursor:pointer;transition:opacity 0.4s ease;"><span id="raildot-2" style="width:7px;height:7px;border-radius:50%;"></span><span id="raillab-2" style="font-family:'IBM Plex Mono',monospace;font-size:11px;letter-spacing:1.6px;text-transform:uppercase;white-space:nowrap;">Insights</span></div>
    <div id="rail-3" onclick="go(3)" style="display:flex;align-items:center;gap:9px;cursor:pointer;transition:opacity 0.4s ease;"><span id="raildot-3" style="width:7px;height:7px;border-radius:50%;"></span><span id="raillab-3" style="font-family:'IBM Plex Mono',monospace;font-size:11px;letter-spacing:1.6px;text-transform:uppercase;white-space:nowrap;">First move</span></div>
    <div id="rail-4" onclick="go(4)" style="display:flex;align-items:center;gap:9px;cursor:pointer;transition:opacity 0.4s ease;"><span id="raildot-4" style="width:7px;height:7px;border-radius:50%;"></span><span id="raillab-4" style="font-family:'IBM Plex Mono',monospace;font-size:11px;letter-spacing:1.6px;text-transform:uppercase;white-space:nowrap;">Goals</span></div>
    <div id="rail-5" onclick="go(5)" style="display:flex;align-items:center;gap:9px;cursor:pointer;transition:opacity 0.4s ease;"><span id="raildot-5" style="width:7px;height:7px;border-radius:50%;"></span><span id="raillab-5" style="font-family:'IBM Plex Mono',monospace;font-size:11px;letter-spacing:1.6px;text-transform:uppercase;white-space:nowrap;">Channels</span></div>
  </div>

  <div style="position:relative;z-index:2;flex:1;min-height:0;overflow:auto;display:flex;align-items:center;justify-content:center;padding:20px 40px 68px;">

    <!-- SCENE 0 -->
    <div id="scene-0" style="display:flex;margin:auto;width:100%;max-width:1080px;flex-direction:column;align-items:center;gap:18px;">
      <div style="position:relative;width:84px;height:84px;display:flex;align-items:center;justify-content:center;opacity:0;animation:popIn 0.9s cubic-bezier(0.2,0.8,0.2,1) forwards;">
        <span style="position:absolute;inset:0;border-radius:26px;border:1px solid oklch(0.72 0.13 15 / 0.55);animation:ringOut 3.2s ease-out infinite;"></span>
        <span style="position:absolute;inset:0;border-radius:26px;border:1px solid oklch(0.62 0.1 285 / 0.5);animation:ringOut 3.2s ease-out infinite;animation-delay:1.6s;"></span>
        <span style="position:relative;width:68px;height:68px;display:block;animation:breathe 3.6s ease-in-out infinite;filter:drop-shadow(0 0 26px oklch(0.6 0.12 285 / 0.65));">
          <svg viewBox="0 0 64 64" style="width:100%;height:100%;display:block;"><rect width="64" height="64" rx="17" fill="#f8ece7"></rect><path d="M28 16h11v26c0 8-5 12-13 12-4 0-7-1.5-9-4l5-6c1 1.3 2.5 2 4 2 2.5 0 2-3.5 2-6.5V16z" fill="#1b2338"></path><circle cx="32" cy="49" r="4.5" fill="#c98a8a"></circle></svg>
        </span>
      </div>
      <h2 style="margin:0;text-align:center;font-family:'Instrument Serif',serif;font-weight:400;font-size:44px;line-height:1.1;opacity:0;animation:fadeIn 0.4s ease forwards;animation-delay:0.55s;">
        <span style="display:inline-block;overflow:hidden;white-space:nowrap;vertical-align:bottom;border-right:2px solid oklch(0.78 0.13 15);max-width:0;animation:typeIn 2.1s steps(44,end) forwards, caret 0.75s step-end 6;animation-delay:0.6s;">Hi — I'm <span style="font-family:'Bricolage Grotesque',sans-serif;font-style:italic;font-weight:600;color:oklch(0.82 0.11 18);">Jefe.</span> Reading Everdew now…</span>
      </h2>
      <div style="position:relative;width:100%;max-width:880px;height:322px;opacity:0;animation:fadeIn 0.8s ease forwards;animation-delay:2.4s;">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" style="position:absolute;inset:0;width:100%;height:100%;overflow:visible;">
          <g stroke="oklch(0.62 0.09 285 / 0.55)" stroke-width="1" vector-effect="non-scaling-stroke" stroke-dasharray="120" fill="none">
            <line x1="50" y1="52" x2="12" y2="17" style="animation:drawLine 0.7s ease forwards;animation-delay:2.6s;stroke-dashoffset:120;"></line>
            <line x1="50" y1="52" x2="50" y2="7" style="animation:drawLine 0.7s ease forwards;animation-delay:2.78s;stroke-dashoffset:120;"></line>
            <line x1="50" y1="52" x2="88" y2="17" style="animation:drawLine 0.7s ease forwards;animation-delay:2.96s;stroke-dashoffset:120;"></line>
            <line x1="50" y1="52" x2="96" y2="53" style="animation:drawLine 0.7s ease forwards;animation-delay:3.14s;stroke-dashoffset:120;"></line>
            <line x1="50" y1="52" x2="86" y2="90" style="animation:drawLine 0.7s ease forwards;animation-delay:3.32s;stroke-dashoffset:120;"></line>
            <line x1="50" y1="52" x2="50" y2="97" style="animation:drawLine 0.7s ease forwards;animation-delay:3.5s;stroke-dashoffset:120;"></line>
            <line x1="50" y1="52" x2="14" y2="90" style="animation:drawLine 0.7s ease forwards;animation-delay:3.68s;stroke-dashoffset:120;"></line>
            <line x1="50" y1="52" x2="4" y2="53" style="animation:drawLine 0.7s ease forwards;animation-delay:3.86s;stroke-dashoffset:120;"></line>
          </g>
          <g stroke="oklch(0.82 0.12 18 / 0.9)" stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-dasharray="6 34" fill="none" style="opacity:0;animation:fadeIn 0.6s ease forwards;animation-delay:4.6s;">
            <line x1="50" y1="52" x2="12" y2="17" style="animation:flowDash 1.4s linear infinite;"></line>
            <line x1="50" y1="52" x2="88" y2="17" style="animation:flowDash 1.4s linear infinite;animation-delay:0.3s;"></line>
            <line x1="50" y1="52" x2="86" y2="90" style="animation:flowDash 1.4s linear infinite;animation-delay:0.6s;"></line>
            <line x1="50" y1="52" x2="14" y2="90" style="animation:flowDash 1.4s linear infinite;animation-delay:0.9s;"></line>
          </g>
        </svg>
        <div style="position:absolute;left:50%;top:52%;transform:translate(-50%,-50%);width:54px;height:54px;border-radius:16px;background:oklch(0.96 0.012 80);display:flex;align-items:center;justify-content:center;box-shadow:0 0 40px oklch(0.62 0.12 285 / 0.8);animation:breathe 3.2s ease-in-out infinite;"><span style="font-family:'Bricolage Grotesque',sans-serif;font-weight:700;font-size:26px;color:oklch(0.24 0.05 265);">J</span></div>
        <div style="position:absolute;left:12%;top:17%;transform:translate(-50%,-50%);opacity:0;animation:nodeIn 0.5s cubic-bezier(0.2,0.9,0.2,1) forwards;animation-delay:3.1s;display:flex;align-items:center;gap:8px;background:oklch(0.24 0.04 265 / 0.85);border:1px solid oklch(0.42 0.06 268);border-radius:100px;padding:7px 13px;backdrop-filter:blur(6px);white-space:nowrap;"><span style="width:6px;height:6px;border-radius:50%;background:oklch(0.78 0.13 15);"></span><span style="font-size:12.5px;font-weight:600;">214 products</span></div>
        <div style="position:absolute;left:50%;top:7%;transform:translate(-50%,-50%);opacity:0;animation:nodeIn 0.5s cubic-bezier(0.2,0.9,0.2,1) forwards;animation-delay:3.28s;display:flex;align-items:center;gap:8px;background:oklch(0.24 0.04 265 / 0.85);border:1px solid oklch(0.42 0.06 268);border-radius:100px;padding:7px 13px;backdrop-filter:blur(6px);white-space:nowrap;"><span style="width:6px;height:6px;border-radius:50%;background:oklch(0.78 0.13 15);"></span><span style="font-size:12.5px;font-weight:600;">3,412 orders</span></div>
        <div style="position:absolute;left:88%;top:17%;transform:translate(-50%,-50%);opacity:0;animation:nodeIn 0.5s cubic-bezier(0.2,0.9,0.2,1) forwards;animation-delay:3.46s;display:flex;align-items:center;gap:8px;background:oklch(0.24 0.04 265 / 0.85);border:1px solid oklch(0.42 0.06 268);border-radius:100px;padding:7px 13px;backdrop-filter:blur(6px);white-space:nowrap;"><span style="width:6px;height:6px;border-radius:50%;background:oklch(0.78 0.13 15);"></span><span style="font-size:12.5px;font-weight:600;">9.8k customers</span></div>
        <div style="position:absolute;left:96%;top:53%;transform:translate(-50%,-50%);opacity:0;animation:nodeIn 0.5s cubic-bezier(0.2,0.9,0.2,1) forwards;animation-delay:3.64s;display:flex;align-items:center;gap:8px;background:oklch(0.24 0.04 265 / 0.85);border:1px solid oklch(0.42 0.06 268);border-radius:100px;padding:7px 13px;backdrop-filter:blur(6px);white-space:nowrap;"><span style="width:6px;height:6px;border-radius:50%;background:oklch(0.78 0.13 15);"></span><span style="font-size:12.5px;font-weight:600;">Inventory</span></div>
        <div style="position:absolute;left:86%;top:90%;transform:translate(-50%,-50%);opacity:0;animation:nodeIn 0.5s cubic-bezier(0.2,0.9,0.2,1) forwards;animation-delay:3.82s;display:flex;align-items:center;gap:8px;background:oklch(0.24 0.04 265 / 0.85);border:1px solid oklch(0.42 0.06 268);border-radius:100px;padding:7px 13px;backdrop-filter:blur(6px);white-space:nowrap;"><span style="width:6px;height:6px;border-radius:50%;background:oklch(0.78 0.13 15);"></span><span style="font-size:12.5px;font-weight:600;">Returns</span></div>
        <div style="position:absolute;left:50%;top:97%;transform:translate(-50%,-50%);opacity:0;animation:nodeIn 0.5s cubic-bezier(0.2,0.9,0.2,1) forwards;animation-delay:4s;display:flex;align-items:center;gap:8px;background:oklch(0.24 0.04 265 / 0.85);border:1px solid oklch(0.42 0.06 268);border-radius:100px;padding:7px 13px;backdrop-filter:blur(6px);white-space:nowrap;"><span style="width:6px;height:6px;border-radius:50%;background:oklch(0.78 0.13 15);"></span><span style="font-size:12.5px;font-weight:600;">38 regions</span></div>
        <div style="position:absolute;left:14%;top:90%;transform:translate(-50%,-50%);opacity:0;animation:nodeIn 0.5s cubic-bezier(0.2,0.9,0.2,1) forwards;animation-delay:4.18s;display:flex;align-items:center;gap:8px;background:oklch(0.24 0.04 265 / 0.85);border:1px solid oklch(0.42 0.06 268);border-radius:100px;padding:7px 13px;backdrop-filter:blur(6px);white-space:nowrap;"><span style="width:6px;height:6px;border-radius:50%;background:oklch(0.78 0.13 15);"></span><span style="font-size:12.5px;font-weight:600;">Ad spend</span></div>
        <div style="position:absolute;left:4%;top:53%;transform:translate(-50%,-50%);opacity:0;animation:nodeIn 0.5s cubic-bezier(0.2,0.9,0.2,1) forwards;animation-delay:4.36s;display:flex;align-items:center;gap:8px;background:oklch(0.24 0.04 265 / 0.85);border:1px solid oklch(0.42 0.06 268);border-radius:100px;padding:7px 13px;backdrop-filter:blur(6px);white-space:nowrap;"><span style="width:6px;height:6px;border-radius:50%;background:oklch(0.78 0.13 15);"></span><span style="font-size:12.5px;font-weight:600;">Fulfilment</span></div>
      </div>
      <div style="width:100%;max-width:520px;display:flex;flex-direction:column;gap:10px;opacity:0;animation:fadeIn 0.5s ease forwards;animation-delay:4.9s;">
        <div style="display:flex;align-items:baseline;gap:10px;font-family:'IBM Plex Mono',monospace;font-size:12px;color:oklch(0.76 0.03 265);">
          <span style="width:11px;height:11px;border-radius:50%;border:1.5px solid oklch(0.78 0.13 15);border-top-color:transparent;animation:spin 0.8s linear infinite;display:inline-block;"></span>
          <span id="ingest-stage" style="flex:1;">Reading orders, refunds and payouts…</span>
          <span id="ingest-pct" style="color:oklch(0.86 0.1 18);font-weight:500;">0%</span>
        </div>
        <div style="height:3px;border-radius:2px;background:oklch(0.3 0.04 265);overflow:hidden;">
          <div id="ingest-bar" style="height:100%;width:0%;background:linear-gradient(90deg, oklch(0.62 0.1 285), oklch(0.8 0.13 15));box-shadow:0 0 10px oklch(0.78 0.13 15 / 0.7);transition:width 0.4s linear;"></div>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
          <span id="ingest-eta" style="font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:oklch(0.66 0.02 265);">about 45 seconds left · 14 months of history</span>
          <span id="dwell-link" onclick="go(1)" style="font-family:'Bricolage Grotesque',sans-serif;font-size:12.5px;font-weight:700;color:oklch(0.86 0.1 18);cursor:pointer;opacity:0;transition:opacity 0.5s ease;">Set up while I read →</span>
        </div>
      </div>
    </div>

    <!-- SCENE 1 -->
    <div id="scene-1" style="display:none;margin:auto;width:100%;max-width:900px;flex-direction:column;align-items:center;gap:26px;">
      <div style="text-align:center;opacity:0;animation:fadeDown 0.6s ease forwards;">
        <div style="font-family:'IBM Plex Mono',monospace;font-size:11px;letter-spacing:2.4px;text-transform:uppercase;color:oklch(0.78 0.13 15);margin-bottom:12px;">Reaching into your stack</div>
        <h2 style="font-family:'Instrument Serif',serif;font-weight:400;font-size:40px;margin:0 0 10px;">You already run these. Let me in.</h2>
        <p style="font-size:15.5px;color:oklch(0.75 0.02 265);margin:0;">Every tool I can see makes the next call sharper.</p>
      </div>
      <div style="width:100%;display:grid;grid-template-columns:1fr 1fr;gap:14px;">
        <div style="opacity:0;animation:fadeUp 0.6s cubic-bezier(0.2,0.8,0.2,1) forwards;animation-delay:0.3s;position:relative;overflow:hidden;background:oklch(0.22 0.035 265 / 0.7);border:1px solid oklch(0.36 0.05 268);border-radius:16px;padding:17px;display:flex;align-items:center;gap:14px;backdrop-filter:blur(10px);"><div style="position:absolute;top:0;bottom:0;width:45%;background:linear-gradient(90deg, transparent, oklch(0.8 0.06 20 / 0.09), transparent);animation:sweep 2.6s ease-in-out infinite;animation-delay:0.3s;"></div><span style="position:relative;width:42px;height:42px;flex:none;border-radius:11px;background:oklch(0.3 0.01 262);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:16px;color:white;">K<img src="https://cdn.simpleicons.org/klaviyo/white" alt="" onerror="imgFail(event)" style="position:absolute;inset:0;margin:auto;width:23px;height:23px;display:block;" /></span><div style="position:relative;flex:1;min-width:0;"><div style="font-weight:700;font-size:15px;">Klaviyo</div><div style="font-size:12.5px;color:oklch(0.72 0.02 265);line-height:1.4;">what email really earns you, not what it claims</div></div><div style="position:relative;flex:none;width:104px;height:30px;"><div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:flex-end;gap:7px;font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:oklch(0.7 0.02 265);animation:fadeOut 0.4s ease forwards;animation-delay:1.7s;"><span style="width:11px;height:11px;border-radius:50%;border:1.5px solid oklch(0.62 0.06 285);border-top-color:transparent;animation:spin 0.8s linear infinite;"></span>linking</div><div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:flex-end;gap:6px;font-size:12px;font-weight:700;color:oklch(0.82 0.14 155);opacity:0;animation:popIn 0.5s cubic-bezier(0.2,0.9,0.2,1) forwards;animation-delay:1.9s;"><span style="width:18px;height:18px;border-radius:50%;background:oklch(0.68 0.15 155);color:oklch(0.16 0.03 265);display:flex;align-items:center;justify-content:center;font-size:11px;box-shadow:0 0 14px oklch(0.68 0.15 155 / 0.7);">✓</span>Live</div></div></div>
        <div style="opacity:0;animation:fadeUp 0.6s cubic-bezier(0.2,0.8,0.2,1) forwards;animation-delay:0.5s;position:relative;overflow:hidden;background:oklch(0.22 0.035 265 / 0.7);border:1px solid oklch(0.36 0.05 268);border-radius:16px;padding:17px;display:flex;align-items:center;gap:14px;backdrop-filter:blur(10px);"><div style="position:absolute;top:0;bottom:0;width:45%;background:linear-gradient(90deg, transparent, oklch(0.8 0.06 20 / 0.09), transparent);animation:sweep 2.6s ease-in-out infinite;animation-delay:0.5s;"></div><span style="position:relative;width:42px;height:42px;flex:none;border-radius:11px;background:oklch(0.55 0.18 262);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:16px;color:white;">M<img src="https://cdn.simpleicons.org/meta/white" alt="" onerror="imgFail(event)" style="position:absolute;inset:0;margin:auto;width:23px;height:23px;display:block;" /></span><div style="position:relative;flex:1;min-width:0;"><div style="font-weight:700;font-size:15px;">Meta Ads</div><div style="font-size:12.5px;color:oklch(0.72 0.02 265);line-height:1.4;">budget that quietly stopped paying off</div></div><div style="position:relative;flex:none;width:104px;height:30px;"><div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:flex-end;gap:7px;font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:oklch(0.7 0.02 265);animation:fadeOut 0.4s ease forwards;animation-delay:2.4s;"><span style="width:11px;height:11px;border-radius:50%;border:1.5px solid oklch(0.62 0.06 285);border-top-color:transparent;animation:spin 0.8s linear infinite;"></span>linking</div><div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:flex-end;gap:6px;font-size:12px;font-weight:700;color:oklch(0.82 0.14 155);opacity:0;animation:popIn 0.5s cubic-bezier(0.2,0.9,0.2,1) forwards;animation-delay:2.6s;"><span style="width:18px;height:18px;border-radius:50%;background:oklch(0.68 0.15 155);color:oklch(0.16 0.03 265);display:flex;align-items:center;justify-content:center;font-size:11px;box-shadow:0 0 14px oklch(0.68 0.15 155 / 0.7);">✓</span>Live</div></div></div>
        <div style="opacity:0;animation:fadeUp 0.6s cubic-bezier(0.2,0.8,0.2,1) forwards;animation-delay:0.7s;position:relative;overflow:hidden;background:oklch(0.22 0.035 265 / 0.7);border:1px solid oklch(0.36 0.05 268);border-radius:16px;padding:17px;display:flex;align-items:center;gap:14px;backdrop-filter:blur(10px);"><div style="position:absolute;top:0;bottom:0;width:45%;background:linear-gradient(90deg, transparent, oklch(0.8 0.06 20 / 0.09), transparent);animation:sweep 2.6s ease-in-out infinite;animation-delay:0.7s;"></div><span style="position:relative;width:42px;height:42px;flex:none;border-radius:11px;background:oklch(0.55 0.14 20);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:16px;color:white;">R<img src="https://cdn.simpleicons.org/recharge/white" alt="" onerror="imgFail(event)" style="position:absolute;inset:0;margin:auto;width:23px;height:23px;display:block;" /></span><div style="position:relative;flex:1;min-width:0;"><div style="font-weight:700;font-size:15px;">Recharge</div><div style="font-size:12.5px;color:oklch(0.72 0.02 265);line-height:1.4;">when subscribers are about to slip away</div></div><div style="position:relative;flex:none;width:104px;height:30px;"><div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:flex-end;gap:7px;font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:oklch(0.7 0.02 265);animation:fadeOut 0.4s ease forwards;animation-delay:3.1s;"><span style="width:11px;height:11px;border-radius:50%;border:1.5px solid oklch(0.62 0.06 285);border-top-color:transparent;animation:spin 0.8s linear infinite;"></span>linking</div><div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:flex-end;gap:6px;font-size:12px;font-weight:700;color:oklch(0.82 0.14 155);opacity:0;animation:popIn 0.5s cubic-bezier(0.2,0.9,0.2,1) forwards;animation-delay:3.3s;"><span style="width:18px;height:18px;border-radius:50%;background:oklch(0.68 0.15 155);color:oklch(0.16 0.03 265);display:flex;align-items:center;justify-content:center;font-size:11px;box-shadow:0 0 14px oklch(0.68 0.15 155 / 0.7);">✓</span>Live</div></div></div>
        <div style="opacity:0;animation:fadeUp 0.6s cubic-bezier(0.2,0.8,0.2,1) forwards;animation-delay:0.9s;position:relative;overflow:hidden;background:oklch(0.22 0.035 265 / 0.7);border:1px solid oklch(0.36 0.05 268);border-radius:16px;padding:17px;display:flex;align-items:center;gap:14px;backdrop-filter:blur(10px);"><div style="position:absolute;top:0;bottom:0;width:45%;background:linear-gradient(90deg, transparent, oklch(0.8 0.06 20 / 0.09), transparent);animation:sweep 2.6s ease-in-out infinite;animation-delay:0.9s;"></div><span style="position:relative;width:42px;height:42px;flex:none;border-radius:11px;background:oklch(0.5 0.13 250);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:16px;color:white;">S<img src="https://cdn.simpleicons.org/shipstation/white" alt="" onerror="imgFail(event)" style="position:absolute;inset:0;margin:auto;width:23px;height:23px;display:block;" /></span><div style="position:relative;flex:1;min-width:0;"><div style="font-weight:700;font-size:15px;">ShipStation</div><div style="font-size:12.5px;color:oklch(0.72 0.02 265);line-height:1.4;">delays before they turn into bad reviews</div></div><div style="position:relative;flex:none;width:104px;height:30px;"><div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:flex-end;gap:7px;font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:oklch(0.7 0.02 265);animation:fadeOut 0.4s ease forwards;animation-delay:3.8s;"><span style="width:11px;height:11px;border-radius:50%;border:1.5px solid oklch(0.62 0.06 285);border-top-color:transparent;animation:spin 0.8s linear infinite;"></span>linking</div><div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:flex-end;gap:6px;font-size:12px;font-weight:700;color:oklch(0.82 0.14 155);opacity:0;animation:popIn 0.5s cubic-bezier(0.2,0.9,0.2,1) forwards;animation-delay:4s;"><span style="width:18px;height:18px;border-radius:50%;background:oklch(0.68 0.15 155);color:oklch(0.16 0.03 265);display:flex;align-items:center;justify-content:center;font-size:11px;box-shadow:0 0 14px oklch(0.68 0.15 155 / 0.7);">✓</span>Live</div></div></div>
      </div>
      <div style="font-family:'IBM Plex Mono',monospace;font-size:12px;color:oklch(0.7 0.02 265);opacity:0;animation:fadeIn 0.6s ease forwards;animation-delay:4.2s;">4 sources streaming · 61 signals per hour</div>
    </div>

    <!-- SCENE 2 -->
    <div id="scene-2" style="display:none;margin:auto;width:100%;max-width:900px;flex-direction:column;align-items:center;gap:22px;">
      <div style="text-align:center;opacity:0;animation:fadeDown 0.6s ease forwards;">
        <div style="font-family:'IBM Plex Mono',monospace;font-size:11px;letter-spacing:2.4px;text-transform:uppercase;color:oklch(0.78 0.13 15);margin-bottom:12px;">What I found in your data</div>
        <h2 style="font-family:'Instrument Serif',serif;font-weight:400;font-size:40px;margin:0;">Here's what I already know.</h2>
      </div>
      <div style="width:100%;display:flex;flex-direction:column;gap:12px;">
        <div style="opacity:0;animation:fadeUp 0.6s cubic-bezier(0.2,0.8,0.2,1) forwards;animation-delay:0.3s;position:relative;overflow:hidden;background:oklch(0.22 0.035 265 / 0.72);border:1px solid oklch(0.36 0.05 268);border-radius:16px;padding:16px 18px;display:flex;align-items:center;gap:15px;backdrop-filter:blur(10px);"><span style="position:absolute;left:0;top:0;bottom:0;width:3px;background:oklch(0.66 0.11 285);box-shadow:0 0 14px oklch(0.66 0.11 285);"></span><span style="flex:none;width:34px;height:34px;border-radius:10px;background:oklch(0.28 0.05 268);color:oklch(0.66 0.11 285);font-size:15px;font-weight:700;display:flex;align-items:center;justify-content:center;">£</span><div style="flex:1;min-width:0;"><div style="font-size:14.5px;line-height:1.5;color:oklch(0.93 0.014 80);">Everdew is botanical skincare doing about £142k a month — up 18% since spring.</div><div style="display:flex;align-items:center;gap:9px;margin-top:8px;"><div style="flex:1;max-width:170px;height:3px;border-radius:2px;background:oklch(0.32 0.04 265);overflow:hidden;"><div style="height:100%;width:0;background:oklch(0.66 0.11 285);animation:meterFill 1.1s cubic-bezier(0.2,0.8,0.2,1) forwards;animation-delay:0.7s;--w:96%;"></div></div><span style="font-family:'IBM Plex Mono',monospace;font-size:10.5px;color:oklch(0.7 0.02 265);">High confidence</span></div></div><div style="flex:none;position:relative;width:108px;height:30px;"><div style="position:absolute;inset:0;display:flex;gap:7px;justify-content:flex-end;align-items:center;animation:fadeOut 0.4s ease forwards;animation-delay:2.6s;"><span style="font-size:11.5px;font-weight:700;color:oklch(0.24 0.05 265);background:oklch(0.88 0.06 20);border-radius:8px;padding:7px 11px;">Confirm</span><span style="font-size:11.5px;font-weight:600;color:oklch(0.74 0.02 265);border:1px solid oklch(0.4 0.05 268);border-radius:8px;padding:7px 11px;">Nope</span></div><div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:flex-end;gap:6px;font-size:12px;font-weight:700;color:oklch(0.82 0.14 155);opacity:0;animation:popIn 0.5s cubic-bezier(0.2,0.9,0.2,1) forwards;animation-delay:2.8s;"><span style="width:18px;height:18px;border-radius:50%;background:oklch(0.68 0.15 155);color:oklch(0.16 0.03 265);display:flex;align-items:center;justify-content:center;font-size:11px;box-shadow:0 0 14px oklch(0.68 0.15 155 / 0.7);">✓</span>Locked</div></div></div>
        <div style="opacity:0;animation:fadeUp 0.6s cubic-bezier(0.2,0.8,0.2,1) forwards;animation-delay:1.1s;position:relative;overflow:hidden;background:oklch(0.22 0.035 265 / 0.72);border:1px solid oklch(0.36 0.05 268);border-radius:16px;padding:16px 18px;display:flex;align-items:center;gap:15px;backdrop-filter:blur(10px);"><span style="position:absolute;left:0;top:0;bottom:0;width:3px;background:oklch(0.82 0.12 18);box-shadow:0 0 14px oklch(0.82 0.12 18);"></span><span style="flex:none;width:34px;height:34px;border-radius:10px;background:oklch(0.28 0.05 268);color:oklch(0.82 0.12 18);font-size:15px;font-weight:700;display:flex;align-items:center;justify-content:center;">↩</span><div style="flex:1;min-width:0;"><div style="font-size:14.5px;line-height:1.5;color:oklch(0.93 0.014 80);">Your Overnight Repair Serum is 34% of revenue — but it returns at 9.2%, nearly double your catalogue. The note that keeps coming up: 'pump arrived broken.'</div><div style="display:flex;align-items:center;gap:9px;margin-top:8px;"><div style="flex:1;max-width:170px;height:3px;border-radius:2px;background:oklch(0.32 0.04 265);overflow:hidden;"><div style="height:100%;width:0;background:oklch(0.82 0.12 18);animation:meterFill 1.1s cubic-bezier(0.2,0.8,0.2,1) forwards;animation-delay:1.5s;--w:92%;"></div></div><span style="font-family:'IBM Plex Mono',monospace;font-size:10.5px;color:oklch(0.7 0.02 265);">High confidence</span></div></div><div style="flex:none;position:relative;width:108px;height:30px;"><div style="position:absolute;inset:0;display:flex;gap:7px;justify-content:flex-end;align-items:center;animation:fadeOut 0.4s ease forwards;animation-delay:4.2s;"><span style="font-size:11.5px;font-weight:700;color:oklch(0.24 0.05 265);background:oklch(0.88 0.06 20);border-radius:8px;padding:7px 11px;">Confirm</span><span style="font-size:11.5px;font-weight:600;color:oklch(0.74 0.02 265);border:1px solid oklch(0.4 0.05 268);border-radius:8px;padding:7px 11px;">Nope</span></div><div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:flex-end;gap:6px;font-size:12px;font-weight:700;color:oklch(0.82 0.14 155);opacity:0;animation:popIn 0.5s cubic-bezier(0.2,0.9,0.2,1) forwards;animation-delay:4.4s;"><span style="width:18px;height:18px;border-radius:50%;background:oklch(0.68 0.15 155);color:oklch(0.16 0.03 265);display:flex;align-items:center;justify-content:center;font-size:11px;box-shadow:0 0 14px oklch(0.68 0.15 155 / 0.7);">✓</span>Locked</div></div></div>
        <div style="opacity:0;animation:fadeUp 0.6s cubic-bezier(0.2,0.8,0.2,1) forwards;animation-delay:1.9s;position:relative;overflow:hidden;background:oklch(0.22 0.035 265 / 0.72);border:1px solid oklch(0.36 0.05 268);border-radius:16px;padding:16px 18px;display:flex;align-items:center;gap:15px;backdrop-filter:blur(10px);"><span style="position:absolute;left:0;top:0;bottom:0;width:3px;background:oklch(0.66 0.11 285);box-shadow:0 0 14px oklch(0.66 0.11 285);"></span><span style="flex:none;width:34px;height:34px;border-radius:10px;background:oklch(0.28 0.05 268);color:oklch(0.66 0.11 285);font-size:15px;font-weight:700;display:flex;align-items:center;justify-content:center;">◎</span><div style="flex:1;min-width:0;"><div style="font-size:14.5px;line-height:1.5;color:oklch(0.93 0.014 80);">Bristol quietly outperforms everywhere — 2.3× London on revenue per customer.</div><div style="display:flex;align-items:center;gap:9px;margin-top:8px;"><div style="flex:1;max-width:170px;height:3px;border-radius:2px;background:oklch(0.32 0.04 265);overflow:hidden;"><div style="height:100%;width:0;background:oklch(0.66 0.11 285);animation:meterFill 1.1s cubic-bezier(0.2,0.8,0.2,1) forwards;animation-delay:2.3s;--w:88%;"></div></div><span style="font-family:'IBM Plex Mono',monospace;font-size:10.5px;color:oklch(0.7 0.02 265);">High confidence</span></div></div><div style="flex:none;position:relative;width:108px;height:30px;"><div style="position:absolute;inset:0;display:flex;gap:7px;justify-content:flex-end;align-items:center;animation:fadeOut 0.4s ease forwards;animation-delay:5.6s;"><span style="font-size:11.5px;font-weight:700;color:oklch(0.24 0.05 265);background:oklch(0.88 0.06 20);border-radius:8px;padding:7px 11px;">Confirm</span><span style="font-size:11.5px;font-weight:600;color:oklch(0.74 0.02 265);border:1px solid oklch(0.4 0.05 268);border-radius:8px;padding:7px 11px;">Nope</span></div><div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:flex-end;gap:6px;font-size:12px;font-weight:700;color:oklch(0.82 0.14 155);opacity:0;animation:popIn 0.5s cubic-bezier(0.2,0.9,0.2,1) forwards;animation-delay:5.8s;"><span style="width:18px;height:18px;border-radius:50%;background:oklch(0.68 0.15 155);color:oklch(0.16 0.03 265);display:flex;align-items:center;justify-content:center;font-size:11px;box-shadow:0 0 14px oklch(0.68 0.15 155 / 0.7);">✓</span>Locked</div></div></div>
        <div style="opacity:0;animation:fadeUp 0.6s cubic-bezier(0.2,0.8,0.2,1) forwards;animation-delay:2.7s;position:relative;overflow:hidden;background:oklch(0.22 0.035 265 / 0.72);border:1px solid oklch(0.36 0.05 268);border-radius:16px;padding:16px 18px;display:flex;align-items:center;gap:15px;backdrop-filter:blur(10px);"><span style="position:absolute;left:0;top:0;bottom:0;width:3px;background:oklch(0.82 0.12 18);box-shadow:0 0 14px oklch(0.82 0.12 18);"></span><span style="flex:none;width:34px;height:34px;border-radius:10px;background:oklch(0.28 0.05 268);color:oklch(0.82 0.12 18);font-size:15px;font-weight:700;display:flex;align-items:center;justify-content:center;">↺</span><div style="flex:1;min-width:0;"><div style="font-size:14.5px;line-height:1.5;color:oklch(0.93 0.014 80);">Repeat purchases have climbed three months straight — your 60-day reorder spike lands exactly when a 30ml serum runs dry.</div><div style="display:flex;align-items:center;gap:9px;margin-top:8px;"><div style="flex:1;max-width:170px;height:3px;border-radius:2px;background:oklch(0.32 0.04 265);overflow:hidden;"><div style="height:100%;width:0;background:oklch(0.82 0.12 18);animation:meterFill 1.1s cubic-bezier(0.2,0.8,0.2,1) forwards;animation-delay:3.1s;--w:74%;"></div></div><span style="font-family:'IBM Plex Mono',monospace;font-size:10.5px;color:oklch(0.7 0.02 265);">Medium confidence</span></div></div><div style="flex:none;position:relative;width:108px;height:30px;"><div style="position:absolute;inset:0;display:flex;gap:7px;justify-content:flex-end;align-items:center;animation:fadeOut 0.4s ease forwards;animation-delay:7s;"><span style="font-size:11.5px;font-weight:700;color:oklch(0.24 0.05 265);background:oklch(0.88 0.06 20);border-radius:8px;padding:7px 11px;">Confirm</span><span style="font-size:11.5px;font-weight:600;color:oklch(0.74 0.02 265);border:1px solid oklch(0.4 0.05 268);border-radius:8px;padding:7px 11px;">Nope</span></div><div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:flex-end;gap:6px;font-size:12px;font-weight:700;color:oklch(0.82 0.14 155);opacity:0;animation:popIn 0.5s cubic-bezier(0.2,0.9,0.2,1) forwards;animation-delay:7.2s;"><span style="width:18px;height:18px;border-radius:50%;background:oklch(0.68 0.15 155);color:oklch(0.16 0.03 265);display:flex;align-items:center;justify-content:center;font-size:11px;box-shadow:0 0 14px oklch(0.68 0.15 155 / 0.7);">✓</span>Locked</div></div></div>
      </div>
    </div>

    <!-- SCENE 3 -->
    <div id="scene-3" style="display:none;margin:auto;width:100%;max-width:700px;flex-direction:column;align-items:center;gap:20px;">
      <div style="text-align:center;opacity:0;animation:fadeDown 0.6s ease forwards;">
        <div style="font-family:'IBM Plex Mono',monospace;font-size:11px;letter-spacing:2.4px;text-transform:uppercase;color:oklch(0.78 0.13 15);margin-bottom:12px;">First move</div>
        <h2 style="font-family:'Instrument Serif',serif;font-weight:400;font-size:42px;margin:0;">I found you <span style="font-family:'Bricolage Grotesque',sans-serif;font-style:italic;font-weight:600;color:oklch(0.82 0.11 18);">£3,100</span> a month.</h2>
      </div>
      <div style="width:100%;position:relative;overflow:hidden;background:oklch(0.23 0.04 265 / 0.8);border:1px solid oklch(0.42 0.07 20);border-radius:22px;padding:26px;backdrop-filter:blur(14px);box-shadow:0 30px 80px -30px oklch(0.5 0.1 285 / 0.55);opacity:0;animation:popIn 0.7s cubic-bezier(0.2,0.9,0.2,1) forwards;animation-delay:0.4s;">
        <div style="position:absolute;top:0;bottom:0;width:40%;background:linear-gradient(90deg, transparent, oklch(0.85 0.08 20 / 0.07), transparent);animation:sweep 3.4s ease-in-out infinite;"></div>
        <div style="position:relative;display:flex;align-items:center;gap:11px;margin-bottom:14px;">
          <span style="width:34px;height:34px;flex:none;display:inline-block;filter:drop-shadow(0 0 14px oklch(0.6 0.12 285 / 0.7));"><svg viewBox="0 0 64 64" style="width:100%;height:100%;display:block;"><rect width="64" height="64" rx="17" fill="#f8ece7"></rect><path d="M28 16h11v26c0 8-5 12-13 12-4 0-7-1.5-9-4l5-6c1 1.3 2.5 2 4 2 2.5 0 2-3.5 2-6.5V16z" fill="#1b2338"></path><circle cx="32" cy="49" r="4.5" fill="#c98a8a"></circle></svg></span>
          <span style="font-weight:700;font-size:15px;">Jefe</span>
          <span style="margin-left:auto;font-family:'IBM Plex Mono',monospace;font-size:10.5px;font-weight:500;text-transform:uppercase;letter-spacing:1.4px;color:oklch(0.88 0.06 20);background:oklch(0.32 0.06 20);padding:5px 11px;border-radius:100px;">Needs your OK</span>
        </div>
        <div style="position:relative;font-size:16.5px;line-height:1.6;color:oklch(0.94 0.014 80);">Your Overnight Repair Serum returns at <strong style="color:oklch(0.86 0.1 20);">9.2%</strong> — almost double your catalogue. Nearly every note says the pump arrived broken. Switch to the lock-cap pump and that drops to about 4%.</div>
        <div style="position:relative;display:flex;gap:10px;margin-top:20px;">
          <div style="font-family:'Bricolage Grotesque',sans-serif;background:oklch(0.88 0.09 20);color:oklch(0.2 0.04 265);font-weight:700;font-size:14.5px;padding:13px 24px;border-radius:11px;cursor:pointer;animation:glowPulse 2.6s ease-out infinite;">Approve</div>
          <div style="font-family:'Bricolage Grotesque',sans-serif;background:transparent;color:oklch(0.8 0.02 265);font-weight:700;font-size:14.5px;padding:13px 24px;border-radius:11px;border:1px solid oklch(0.42 0.05 268);cursor:pointer;">Show me the numbers</div>
        </div>
      </div>
      <div style="width:100%;display:flex;align-items:center;gap:13px;padding:15px 18px;border-radius:16px;background:oklch(0.2 0.03 265 / 0.6);border:1px solid oklch(0.32 0.04 268);backdrop-filter:blur(10px);opacity:0;animation:fadeUp 0.6s ease forwards;animation-delay:1.1s;">
        <span style="width:8px;height:8px;flex:none;border-radius:50%;background:oklch(0.68 0.15 155);box-shadow:0 0 12px oklch(0.68 0.15 155);animation:pulseDot 1.6s ease-in-out infinite;"></span>
        <div style="flex:1;font-size:14px;color:oklch(0.86 0.016 80);">That's one. I've got three more like it queued — and I've barely started.</div>
        <div style="font-family:'Bricolage Grotesque',sans-serif;flex:none;background:oklch(0.96 0.012 80);color:oklch(0.24 0.05 265);font-weight:700;font-size:13.5px;padding:11px 18px;border-radius:10px;cursor:pointer;">Show me</div>
      </div>
    </div>

    <!-- SCENE 4 -->
    <div id="scene-4" style="display:none;margin:auto;width:100%;max-width:880px;flex-direction:column;align-items:center;gap:24px;">
      <div style="text-align:center;opacity:0;animation:fadeDown 0.6s ease forwards;">
        <div style="font-family:'IBM Plex Mono',monospace;font-size:11px;letter-spacing:2.4px;text-transform:uppercase;color:oklch(0.78 0.13 15);margin-bottom:12px;">Setting your north star</div>
        <h2 style="font-family:'Instrument Serif',serif;font-weight:400;font-size:40px;margin:0;">Tell me what winning looks like.</h2>
      </div>
      <div style="width:100%;display:flex;flex-direction:column;gap:16px;">
        <div style="font-size:14px;color:oklch(0.76 0.02 265);opacity:0;animation:fadeIn 0.5s ease forwards;animation-delay:0.4s;"><span style="font-family:'Bricolage Grotesque',sans-serif;font-weight:700;color:oklch(0.82 0.11 18);">Jefe</span> — Where do you want Everdew in 3, 6 and 12 months?</div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px;">
          <div style="opacity:0;animation:popIn 0.6s cubic-bezier(0.2,0.9,0.2,1) forwards;animation-delay:0.8s;background:oklch(0.22 0.035 265 / 0.7);border:1px solid oklch(0.36 0.05 268);border-radius:16px;padding:18px;backdrop-filter:blur(10px);"><div style="font-family:'IBM Plex Mono',monospace;font-size:10.5px;letter-spacing:1.6px;text-transform:uppercase;color:oklch(0.78 0.13 15);">3 months</div><div style="font-family:'Instrument Serif',serif;font-size:26px;margin-top:8px;">£180k / month</div></div>
          <div style="opacity:0;animation:popIn 0.6s cubic-bezier(0.2,0.9,0.2,1) forwards;animation-delay:1.1s;background:oklch(0.22 0.035 265 / 0.7);border:1px solid oklch(0.36 0.05 268);border-radius:16px;padding:18px;backdrop-filter:blur(10px);"><div style="font-family:'IBM Plex Mono',monospace;font-size:10.5px;letter-spacing:1.6px;text-transform:uppercase;color:oklch(0.78 0.13 15);">6 months</div><div style="font-family:'Instrument Serif',serif;font-size:26px;margin-top:8px;">Launch refills</div></div>
          <div style="opacity:0;animation:popIn 0.6s cubic-bezier(0.2,0.9,0.2,1) forwards;animation-delay:1.4s;background:oklch(0.22 0.035 265 / 0.7);border:1px solid oklch(0.36 0.05 268);border-radius:16px;padding:18px;backdrop-filter:blur(10px);"><div style="font-family:'IBM Plex Mono',monospace;font-size:10.5px;letter-spacing:1.6px;text-transform:uppercase;color:oklch(0.78 0.13 15);">12 months</div><div style="font-family:'Instrument Serif',serif;font-size:26px;margin-top:8px;">Break into the US</div></div>
        </div>
        <div style="display:flex;flex-direction:column;gap:10px;margin-top:4px;">
          <div style="opacity:0;animation:fadeUp 0.5s ease forwards;animation-delay:2s;align-self:flex-start;max-width:74%;background:oklch(0.22 0.035 265 / 0.75);border:1px solid oklch(0.34 0.05 268);border-radius:14px 14px 14px 4px;padding:12px 15px;font-size:14px;color:oklch(0.88 0.015 80);"><span style="font-family:'Bricolage Grotesque',sans-serif;font-weight:700;color:oklch(0.82 0.11 18);">Jefe</span> — If you had unlimited time, what would you dig into?</div>
          <div style="opacity:0;animation:fadeUp 0.5s ease forwards;animation-delay:2.9s;align-self:flex-end;max-width:74%;background:linear-gradient(150deg, oklch(0.62 0.1 285), oklch(0.5 0.09 288));border-radius:14px 14px 4px 14px;padding:12px 15px;font-size:14px;color:oklch(0.98 0.01 80);">Why customers churn after their third order.</div>
          <div style="opacity:0;animation:fadeIn 0.5s ease forwards;animation-delay:3.7s;align-self:flex-start;display:flex;align-items:center;gap:9px;font-family:'IBM Plex Mono',monospace;font-size:12px;color:oklch(0.82 0.14 155);"><span style="width:6px;height:6px;border-radius:50%;background:oklch(0.68 0.15 155);animation:pulseDot 1.4s ease-in-out infinite;"></span>Locked in — I'll measure every move against these</div>
        </div>
      </div>
    </div>

    <!-- SCENE 5 -->
    <div id="scene-5" style="display:none;margin:auto;width:100%;max-width:820px;flex-direction:column;align-items:center;gap:26px;">
      <div style="text-align:center;max-width:620px;opacity:0;animation:fadeDown 0.6s ease forwards;">
        <div style="font-family:'IBM Plex Mono',monospace;font-size:11px;letter-spacing:2.4px;text-transform:uppercase;color:oklch(0.78 0.13 15);margin-bottom:12px;">Opening a line to you</div>
        <h2 style="font-family:'Instrument Serif',serif;font-weight:400;font-size:40px;margin:0 0 10px;">Where should I find you?</h2>
        <p style="font-size:15.5px;color:oklch(0.75 0.02 265);margin:0;">Pick any — I'll bring the next move to you there.</p>
      </div>
      <div style="width:100%;display:grid;grid-template-columns:repeat(3,1fr);gap:16px;">
        <div id="ch-slack" style="opacity:0;animation:fadeUp 0.6s cubic-bezier(0.2,0.8,0.2,1) forwards;animation-delay:0.3s;background:oklch(0.22 0.035 265 / 0.7);border:1.5px solid oklch(0.4 0.05 268);border-radius:18px;padding:22px 18px;display:flex;flex-direction:column;align-items:center;text-align:center;gap:12px;backdrop-filter:blur(10px);transition:border-color 0.3s ease, box-shadow 0.3s ease;"><span style="position:relative;width:46px;height:46px;border-radius:13px;background:oklch(0.42 0.14 320);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:17px;color:white;">S<img src="https://cdn.simpleicons.org/slack/white" alt="" onerror="imgFail(event)" style="position:absolute;inset:0;margin:auto;width:25px;height:25px;display:block;" /></span><div style="font-weight:700;font-size:15.5px;">Slack</div><div style="font-size:12.5px;color:oklch(0.72 0.02 265);line-height:1.45;min-height:36px;">Drops the next move in your channel</div><div id="chbtn-slack" onclick="toggleCh('slack')" style="font-family:'Bricolage Grotesque',sans-serif;font-weight:700;font-size:13px;padding:10px 20px;border-radius:10px;cursor:pointer;border:1px solid oklch(0.4 0.05 268);transition:all 0.25s ease;">Connect</div></div>
        <div id="ch-teams" style="opacity:0;animation:fadeUp 0.6s cubic-bezier(0.2,0.8,0.2,1) forwards;animation-delay:0.5s;background:oklch(0.22 0.035 265 / 0.7);border:1.5px solid oklch(0.4 0.05 268);border-radius:18px;padding:22px 18px;display:flex;flex-direction:column;align-items:center;text-align:center;gap:12px;backdrop-filter:blur(10px);transition:border-color 0.3s ease, box-shadow 0.3s ease;"><span style="position:relative;width:46px;height:46px;border-radius:13px;background:oklch(0.5 0.13 285);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:17px;color:white;">T<img src="https://cdn.simpleicons.org/microsoftteams/white" alt="" onerror="imgFail(event)" style="position:absolute;inset:0;margin:auto;width:25px;height:25px;display:block;" /></span><div style="font-weight:700;font-size:15.5px;">Teams</div><div style="font-size:12.5px;color:oklch(0.72 0.02 265);line-height:1.45;min-height:36px;">Talk to me from Microsoft Teams</div><div id="chbtn-teams" onclick="toggleCh('teams')" style="font-family:'Bricolage Grotesque',sans-serif;font-weight:700;font-size:13px;padding:10px 20px;border-radius:10px;cursor:pointer;border:1px solid oklch(0.4 0.05 268);transition:all 0.25s ease;">Connect</div></div>
        <div id="ch-whatsapp" style="opacity:0;animation:fadeUp 0.6s cubic-bezier(0.2,0.8,0.2,1) forwards;animation-delay:0.7s;background:oklch(0.22 0.035 265 / 0.7);border:1.5px solid oklch(0.4 0.05 268);border-radius:18px;padding:22px 18px;display:flex;flex-direction:column;align-items:center;text-align:center;gap:12px;backdrop-filter:blur(10px);transition:border-color 0.3s ease, box-shadow 0.3s ease;"><span style="position:relative;width:46px;height:46px;border-radius:13px;background:oklch(0.6 0.14 150);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:17px;color:white;">W<img src="https://cdn.simpleicons.org/whatsapp/white" alt="" onerror="imgFail(event)" style="position:absolute;inset:0;margin:auto;width:25px;height:25px;display:block;" /></span><div style="font-weight:700;font-size:15.5px;">WhatsApp</div><div style="font-size:12.5px;color:oklch(0.72 0.02 265);line-height:1.45;min-height:36px;">Straight to your phone, day or night</div><div id="chbtn-whatsapp" onclick="toggleCh('whatsapp')" style="font-family:'Bricolage Grotesque',sans-serif;font-weight:700;font-size:13px;padding:10px 20px;border-radius:10px;cursor:pointer;border:1px solid oklch(0.4 0.05 268);transition:all 0.25s ease;">Connect</div></div>
      </div>
      <div style="width:100%;display:flex;align-items:center;gap:13px;padding:16px 18px;border-radius:16px;background:oklch(0.2 0.03 265 / 0.6);border:1px solid oklch(0.32 0.04 268);backdrop-filter:blur(10px);opacity:0;animation:fadeUp 0.6s ease forwards;animation-delay:1.5s;">
        <span style="width:8px;height:8px;flex:none;border-radius:50%;background:oklch(0.68 0.15 155);box-shadow:0 0 12px oklch(0.68 0.15 155);animation:pulseDot 1.6s ease-in-out infinite;"></span>
        <div style="flex:1;font-size:14px;color:oklch(0.86 0.016 80);">I'm on shift. Next one's already brewing — a Bristol VIP restock offer.</div>
        <div style="font-family:'Bricolage Grotesque',sans-serif;flex:none;background:oklch(0.96 0.012 80);color:oklch(0.24 0.05 265);font-weight:700;font-size:13.5px;padding:11px 18px;border-radius:10px;cursor:pointer;">Open Jefe</div>
      </div>
    </div>

  </div>

  <div id="controls" style="position:absolute;bottom:0;left:0;right:0;z-index:6;display:flex;align-items:center;gap:16px;padding:14px 28px;background:linear-gradient(transparent, oklch(0.12 0.025 265 / 0.9));transition:opacity 0.5s ease;">
    <div id="step-label" style="font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:oklch(0.68 0.02 265);min-width:140px;">01 / 06 · Connect</div>
    <div style="flex:1;display:flex;align-items:center;justify-content:center;gap:14px;">
      <div onclick="go(S.scene-1)" style="width:34px;height:34px;border-radius:10px;border:1px solid oklch(0.36 0.05 268);display:flex;align-items:center;justify-content:center;cursor:pointer;color:oklch(0.8 0.02 265);font-size:15px;">‹</div>
      <div onclick="togglePlay()" style="width:40px;height:40px;border-radius:11px;background:oklch(0.88 0.09 20);color:oklch(0.2 0.04 265);display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:13px;font-weight:700;"><span id="play-icon">❚❚</span></div>
      <div onclick="go(S.scene+1)" style="width:34px;height:34px;border-radius:10px;border:1px solid oklch(0.36 0.05 268);display:flex;align-items:center;justify-content:center;cursor:pointer;color:oklch(0.8 0.02 265);font-size:15px;">›</div>
    </div>
    <div onclick="replay()" style="min-width:140px;text-align:right;font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:oklch(0.72 0.02 265);cursor:pointer;">↻ replay</div>
  </div>

</div>
<script>
(function(){
  var S={scene:0,playing:true,channels:{slack:true,teams:false,whatsapp:true},ingest:0,elapsed:0,ui:true};
  window.S=S;
  var INGEST_MS=52000,DWELL_MS=9000,LAST=5;
  var labels=['Connect','Integrations','Insights','First move','Goals','Channels'];
  var durations=[26000,19000,27000,21000,21000,999999];
  var t0=Date.now(),timer=null,uiTimer=null;
  var blush='oklch(0.82 0.12 18)',violet='oklch(0.66 0.11 285)',dim='oklch(0.62 0.02 265)',line='oklch(0.4 0.05 268)';
  function el(id){return document.getElementById(id);}
  function pad2(n){return ('0'+n).slice(-2);}
  function showScene(n){ for(var i=0;i<=5;i++){ var sc=el('scene-'+i); if(sc){ sc.style.display=(i===n)?'flex':'none'; } } var a=el('scene-'+n); if(a){ a.innerHTML=a.innerHTML; } }
  window.go=function(n,po){ n=Math.max(0,Math.min(LAST,n)); var playing=(po!==undefined)?po:S.playing; S.scene=n; showScene(n); render(); arm(n,playing); };
  function arm(n,playing){ clearTimeout(timer); if(playing&&n<LAST){ timer=setTimeout(function(){window.go(n+1);},durations[n]); } }
  function hideSoon(){ clearTimeout(uiTimer); uiTimer=setTimeout(function(){S.ui=false;render();},2600); }
  window.togglePlay=function(){ S.playing=!S.playing; render(); arm(S.scene,S.playing); };
  window.replay=function(){ t0=Date.now(); S.playing=true; S.ingest=0; S.elapsed=0; window.go(0,true); };
  function render(){
    var scene=S.scene, ing=S.ingest;
    for(var j=0;j<6;j++){
      var active=(j===scene), done=(j<scene);
      var item=el('rail-'+j); if(item){ item.style.opacity= active?'1':(done?'0.62':'0.34'); }
      var dot=el('raildot-'+j); if(dot){ dot.style.background= active?blush:(done?violet:line); dot.style.boxShadow= active?('0 0 12px '+blush):'none'; }
      var lab=el('raillab-'+j); if(lab){ lab.style.color= active?'oklch(0.95 0.012 80)':dim; }
    }
    var etaS=Math.max(1,Math.ceil(((1-ing)*INGEST_MS)/1000));
    var stage = ing<0.28?'Reading orders, refunds and payouts…':ing<0.55?'Mapping every SKU, collection and variant…':ing<0.82?'Profiling customers by region and cohort…':ing<1?'Looking for what matters…':'Store read — findings ready';
    var pct=Math.round(ing*100)+'%';
    if(el('ingest-stage')){ el('ingest-stage').textContent=stage; }
    if(el('ingest-pct')){ el('ingest-pct').textContent=pct; }
    if(el('ingest-bar')){ el('ingest-bar').style.width=pct; }
    if(el('ingest-eta')){ el('ingest-eta').textContent= ing>=1?'Done — 14 months indexed':('about '+(etaS<20?etaS:Math.round(etaS/5)*5)+' seconds left · 14 months of history'); }
    if(el('dwell-link')){ el('dwell-link').style.opacity= (S.elapsed>=DWELL_MS)?'1':'0'; }
    if(el('hairline')){ el('hairline').style.width= Math.round((scene/LAST)*100)+'%'; }
    var showChip=(scene>0&&ing<1), showReady=(scene>0&&ing>=1&&S.elapsed<INGEST_MS+6000);
    if(el('chip-loading')){ el('chip-loading').style.display=showChip?'flex':'none'; if(el('chip-text')){ el('chip-text').textContent='Reading your store · '+Math.round(ing*100)+'%'; } }
    if(el('chip-ready')){ el('chip-ready').style.display=showReady?'flex':'none'; }
    if(el('step-label')){ el('step-label').textContent= pad2(scene+1)+' / 06 · '+labels[scene]; }
    if(el('play-icon')){ el('play-icon').textContent= S.playing?'❚❚':'▶'; }
    if(el('controls')){ el('controls').style.opacity=S.ui?'1':'0'; el('controls').style.pointerEvents=S.ui?'auto':'none'; }
    ['slack','teams','whatsapp'].forEach(function(k){
      var on=!!S.channels[k]; var card=el('ch-'+k); if(!card){ return; }
      card.style.borderColor= on?'oklch(0.6 0.11 20)':line;
      card.style.boxShadow= on?'0 0 34px -8px oklch(0.7 0.12 20 / 0.5)':'none';
      var btn=el('chbtn-'+k); if(btn){ btn.textContent= on?'Connected ✓':'Connect'; btn.style.background= on?'oklch(0.88 0.09 20)':'transparent'; btn.style.color= on?'oklch(0.2 0.04 265)':'oklch(0.82 0.02 265)'; btn.style.borderColor= on?'oklch(0.88 0.09 20)':line; }
    });
  }
  window.toggleCh=function(k){ S.channels[k]=!S.channels[k]; render(); };
  window.imgFail=function(e){ if(e&&e.target){ e.target.style.display='none'; } };
  document.addEventListener('mousemove',function(){ if(!S.ui){S.ui=true;} hideSoon(); render(); });
  document.addEventListener('visibilitychange',function(){ if(!document.hidden){ showScene(S.scene); render(); } });
  window.go(0,true); hideSoon();
  setInterval(function(){ var ms=Date.now()-t0; S.elapsed=ms; S.ingest=Math.min(1,ms/INGEST_MS); render(); },250);
})();
</script>
</body>
</html>`;

export async function loader(_args: LoaderFunctionArgs) {
  return new Response(HTML, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy":
        "default-src 'self' https: data: 'unsafe-inline' 'unsafe-eval'; img-src 'self' https: data:; font-src https: data:; style-src 'self' https: 'unsafe-inline';",
      "Cache-Control": "no-store",
    },
  });
}

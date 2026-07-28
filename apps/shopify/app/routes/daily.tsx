
// Standalone, full-fidelity build of the Jefe "Daily" home surface (screen 5a from
// the design_handoff_jefe_daily handoff): three columns — nav · brief · partner rail.
// Light theme. Served as a public resource route (no App Bridge/auth) so it can be
// opened and screen-recorded / reviewed directly. This is the demo/preview incarnation;
// the real merchant-paced App Bridge version (live data, real approve flow, chat/queue)
// is a separate build. Does NOT touch the onboarding funnel or /cinematic.

const HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Jefe — Home</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='16' fill='%2333456b'/%3E%3Cpath d='M28 16h11v26c0 8-5 12-13 12-4 0-7-1.5-9-4l5-6c1 1.3 2.5 2 4 2 2.5 0 2-3.5 2-6.5V16z' fill='%23f8ece7'/%3E%3Ccircle cx='32' cy='49' r='4.5' fill='%23c98a8a'/%3E%3C/svg%3E" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Schibsted+Grotesk:wght@400;500;600;700;800&family=Bricolage+Grotesque:wght@600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet" />
<style>
  html,body{margin:0;height:100%;}
  *{box-sizing:border-box;}
  body{font-family:'Schibsted Grotesk',sans-serif;background:linear-gradient(180deg, oklch(0.985 0.005 70), oklch(0.965 0.007 65));color:oklch(0.24 0.02 45);}
  @keyframes pulseDot{0%,100%{opacity:1;}50%{opacity:0.3;}}
  .JefeDaily{height:100vh;display:flex;overflow:hidden;}
  .JefeNav{width:198px;flex:none;border-right:1px solid oklch(0.88 0.008 62);background:oklch(0.975 0.004 68);padding:16px 12px;display:flex;flex-direction:column;gap:18px;}
  .JefeContent{flex:1;min-width:0;display:flex;}
  .JefeBrief{flex:1;min-width:0;display:flex;flex-direction:column;border-right:1px solid oklch(0.9 0.008 62);}
  .JefeRail{width:300px;flex:none;background:oklch(0.972 0.005 68);display:flex;flex-direction:column;}
  @media (max-width:1100px){
    .JefeContent{flex-direction:column;overflow:auto;}
    .JefeBrief{border-right:none;border-bottom:1px solid oklch(0.9 0.008 62);}
    .JefeRail{width:auto;}
  }
  @media (max-width:1000px){
    .JefeNav{width:64px;}
    .JefeNav .navlabel,.JefeNav .navsection{display:none;}
    .JefeNav .navrow{justify-content:center;}
  }
</style>
</head>
<body>
<div class="JefeDaily">

  <!-- NAV -->
  <div class="JefeNav">
    <div style="display:flex;align-items:center;gap:9px;padding:0 4px;">
      <span style="width:24px;height:24px;flex:none;display:inline-block;"><svg viewBox="0 0 64 64" style="width:100%;height:100%;display:block;"><rect width="64" height="64" rx="16" fill="#33456b"></rect><path d="M28 16h11v26c0 8-5 12-13 12-4 0-7-1.5-9-4l5-6c1 1.3 2.5 2 4 2 2.5 0 2-3.5 2-6.5V16z" fill="#f8ece7"></path><circle cx="32" cy="49" r="4.5" fill="#c98a8a"></circle></svg></span>
      <span class="navlabel" style="font-weight:700;font-size:14.5px;">Jefe</span>
      <span style="margin-left:auto;width:7px;height:7px;border-radius:50%;background:oklch(0.6 0.15 155);animation:pulseDot 2.2s ease-in-out infinite;"></span>
    </div>
    <div style="display:flex;flex-direction:column;gap:2px;">
      <div class="navrow" style="display:flex;align-items:center;padding:8px 10px;border-radius:8px;font-size:13.5px;background:oklch(0.93 0.025 262);color:oklch(0.3 0.06 262);font-weight:700;"><span class="navlabel">Brief</span></div>
      <div class="navrow" style="display:flex;align-items:center;padding:8px 10px;border-radius:8px;font-size:13.5px;background:transparent;color:oklch(0.4 0.015 60);font-weight:400;"><span class="navlabel">Queue</span><span style="margin-left:auto;font-family:'IBM Plex Mono',monospace;font-size:10.5px;background:oklch(0.42 0.09 22);color:oklch(0.97 0.01 80);padding:2px 6px;border-radius:5px;">4</span></div>
      <div class="navrow" style="display:flex;align-items:center;padding:8px 10px;border-radius:8px;font-size:13.5px;background:transparent;color:oklch(0.4 0.015 60);font-weight:400;"><span class="navlabel">Horizon</span></div>
      <div class="navrow" style="display:flex;align-items:center;padding:8px 10px;border-radius:8px;font-size:13.5px;background:transparent;color:oklch(0.4 0.015 60);font-weight:400;"><span class="navlabel">Tidy-up</span><span style="margin-left:auto;font-family:'IBM Plex Mono',monospace;font-size:10.5px;background:oklch(0.93 0.006 64);color:oklch(0.45 0.015 60);padding:2px 6px;border-radius:5px;">73</span></div>
      <div class="navrow" style="display:flex;align-items:center;padding:8px 10px;border-radius:8px;font-size:13.5px;background:transparent;color:oklch(0.4 0.015 60);font-weight:400;"><span class="navlabel">Activity</span></div>
      <div class="navrow" style="display:flex;align-items:center;padding:8px 10px;border-radius:8px;font-size:13.5px;background:transparent;color:oklch(0.4 0.015 60);font-weight:400;"><span class="navlabel">Goals</span></div>
      <div class="navrow" style="display:flex;align-items:center;padding:8px 10px;border-radius:8px;font-size:13.5px;background:transparent;color:oklch(0.4 0.015 60);font-weight:400;"><span class="navlabel">Memory</span></div>
      <div class="navrow" style="display:flex;align-items:center;padding:8px 10px;border-radius:8px;font-size:13.5px;background:transparent;color:oklch(0.4 0.015 60);font-weight:400;"><span class="navlabel">Settings</span></div>
    </div>
    <div class="navsection" style="display:flex;flex-direction:column;gap:8px;">
      <div style="font-family:'IBM Plex Mono',monospace;font-size:9.5px;letter-spacing:1.3px;text-transform:uppercase;color:oklch(0.58 0.015 60);padding:0 4px;">Autonomy</div>
      <div style="padding:0 4px;display:flex;flex-direction:column;gap:7px;">
        <div style="height:4px;border-radius:3px;background:oklch(0.9 0.008 62);position:relative;">
          <div style="position:absolute;left:0;top:0;bottom:0;width:62%;border-radius:3px;background:linear-gradient(90deg, oklch(0.55 0.07 262), oklch(0.62 0.13 22));"></div>
          <div style="position:absolute;left:62%;top:50%;width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;background:white;border:1.5px solid oklch(0.62 0.13 22);"></div>
        </div>
        <div style="display:flex;justify-content:space-between;font-family:'IBM Plex Mono',monospace;font-size:9.5px;color:oklch(0.6 0.015 60);"><span>Ask first</span><span style="color:oklch(0.42 0.09 22);font-weight:500;">Trusted</span></div>
      </div>
    </div>
    <div class="navsection" style="margin-top:auto;display:flex;flex-direction:column;gap:4px;">
      <div style="font-family:'IBM Plex Mono',monospace;font-size:9.5px;letter-spacing:1.3px;text-transform:uppercase;color:oklch(0.58 0.015 60);padding:0 4px;margin-bottom:3px;">Reaching you on</div>
      <div style="display:flex;align-items:center;gap:8px;padding:4px;font-size:12.5px;color:oklch(0.35 0.02 45);"><span style="width:15px;height:15px;flex:none;border-radius:4px;background:oklch(0.45 0.16 320);color:white;display:flex;align-items:center;justify-content:center;font-size:8px;font-weight:700;">S</span>Slack · #everdew-ops</div>
      <div style="display:flex;align-items:center;gap:8px;padding:4px;font-size:12.5px;color:oklch(0.35 0.02 45);"><span style="width:15px;height:15px;flex:none;border-radius:4px;background:oklch(0.6 0.14 150);color:white;display:flex;align-items:center;justify-content:center;font-size:8px;font-weight:700;">W</span>WhatsApp · Sam</div>
      <div style="display:flex;align-items:center;gap:8px;padding:4px;font-size:12.5px;color:oklch(0.62 0.015 60);"><span style="width:15px;height:15px;flex:none;border-radius:4px;background:oklch(0.82 0.01 285);color:white;display:flex;align-items:center;justify-content:center;font-size:8px;font-weight:700;">T</span>Teams · off</div>
    </div>
  </div>

  <div class="JefeContent">
    <!-- BRIEF -->
    <div class="JefeBrief">
      <div style="flex:1;min-height:0;overflow:auto;padding:24px 26px 16px;display:flex;flex-direction:column;gap:20px;">

        <div style="display:flex;flex-direction:column;gap:9px;">
          <div style="font-family:'IBM Plex Mono',monospace;font-size:10.5px;letter-spacing:1.8px;text-transform:uppercase;color:oklch(0.42 0.09 22);">Tuesday 28 July · your brief</div>
          <div style="font-family:'Instrument Serif',serif;font-size:32px;line-height:1.15;color:oklch(0.22 0.02 40);">Quiet night. But there's <span style="font-family:'Bricolage Grotesque',sans-serif;font-style:italic;font-weight:600;color:oklch(0.42 0.09 20);">£13,540</span> sitting in four decisions.</div>
          <div style="display:flex;gap:20px;margin-top:2px;flex-wrap:wrap;">
            <div><div style="font-family:'IBM Plex Mono',monospace;font-size:9.5px;letter-spacing:1.2px;text-transform:uppercase;color:oklch(0.55 0.015 60);">Orders</div><div style="font-family:'Instrument Serif',serif;font-size:21px;">41</div></div>
            <div><div style="font-family:'IBM Plex Mono',monospace;font-size:9.5px;letter-spacing:1.2px;text-transform:uppercase;color:oklch(0.55 0.015 60);">Revenue</div><div style="font-family:'Instrument Serif',serif;font-size:21px;">£1,880</div></div>
            <div><div style="font-family:'IBM Plex Mono',monospace;font-size:9.5px;letter-spacing:1.2px;text-transform:uppercase;color:oklch(0.55 0.015 60);">vs last Tue</div><div style="font-family:'Instrument Serif',serif;font-size:21px;color:oklch(0.5 0.13 155);">+12%</div></div>
            <div><div style="font-family:'IBM Plex Mono',monospace;font-size:9.5px;letter-spacing:1.2px;text-transform:uppercase;color:oklch(0.55 0.015 60);">I handled</div><div style="font-family:'Instrument Serif',serif;font-size:21px;">6</div></div>
          </div>
        </div>

        <div style="background:oklch(0.99 0.008 262);border:1px solid oklch(0.84 0.04 262);border-radius:15px;padding:15px 17px;display:flex;flex-direction:column;gap:10px;">
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="width:22px;height:22px;flex:none;display:inline-block;"><svg viewBox="0 0 64 64" style="width:100%;height:100%;display:block;"><rect width="64" height="64" rx="16" fill="#33456b"></rect><path d="M28 16h11v26c0 8-5 12-13 12-4 0-7-1.5-9-4l5-6c1 1.3 2.5 2 4 2 2.5 0 2-3.5 2-6.5V16z" fill="#f8ece7"></path><circle cx="32" cy="49" r="4.5" fill="#c98a8a"></circle></svg></span>
            <span style="font-family:'IBM Plex Mono',monospace;font-size:9px;letter-spacing:1.1px;text-transform:uppercase;font-weight:500;color:oklch(0.34 0.07 262);background:oklch(0.92 0.03 262);padding:3px 8px;border-radius:5px;">I got one wrong</span>
            <span style="margin-left:auto;font-family:'IBM Plex Mono',monospace;font-size:10px;color:oklch(0.55 0.015 60);">caught it myself · already corrected</span>
          </div>
          <div style="font-size:14.5px;line-height:1.55;color:oklch(0.24 0.02 45);">Last Tuesday I moved <strong>£600</strong> into Retargeting-UK expecting about £1,400 back. It's returned <strong>£180</strong> — I made the audience too narrow, so it kept hitting the same people.</div>
          <div style="font-size:13.5px;line-height:1.55;color:oklch(0.32 0.02 45);background:oklch(0.975 0.005 68);border-radius:10px;padding:11px 13px;">I've moved <strong>£400</strong> back to prospecting already and left £200 running so the test still tells me something. Widening to 30-day site visitors should fix the rest.</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <span style="font-family:'Bricolage Grotesque',sans-serif;background:oklch(0.35 0.06 262);color:oklch(0.97 0.01 80);font-weight:700;font-size:13px;padding:9px 17px;border-radius:9px;cursor:pointer;">Widen it</span>
            <span style="font-family:'Bricolage Grotesque',sans-serif;color:oklch(0.4 0.015 60);font-weight:700;font-size:13px;padding:9px 15px;border-radius:9px;border:1px solid oklch(0.86 0.008 62);cursor:pointer;">Leave it</span>
            <span style="font-family:'Bricolage Grotesque',sans-serif;color:oklch(0.4 0.015 60);font-weight:700;font-size:13px;padding:9px 15px;border-radius:9px;border:1px solid oklch(0.86 0.008 62);cursor:pointer;">Show the numbers</span>
          </div>
        </div>

        <div style="display:flex;flex-direction:column;gap:10px;">
          <div style="font-family:'IBM Plex Mono',monospace;font-size:10px;letter-spacing:1.6px;text-transform:uppercase;color:oklch(0.55 0.015 60);">Your call</div>

          <div style="background:oklch(0.995 0.004 70);border:1px solid oklch(0.62 0.13 22);border-radius:15px;padding:15px 17px;display:flex;flex-direction:column;gap:9px;">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
              <span style="font-family:'IBM Plex Mono',monospace;font-size:9px;letter-spacing:1.1px;text-transform:uppercase;font-weight:500;color:oklch(0.4 0.08 20);background:oklch(0.93 0.04 20);padding:3px 7px;border-radius:5px;">Needs your OK</span>
              <span style="font-family:'IBM Plex Mono',monospace;font-size:10px;color:oklch(0.58 0.015 60);">from Returns + Reviews</span>
              <span style="margin-left:auto;font-family:'Instrument Serif',serif;font-size:22px;color:oklch(0.42 0.09 20);">£3,100</span>
            </div>
            <div style="font-size:14.5px;line-height:1.45;color:oklch(0.24 0.02 45);">Switch the Overnight Repair Serum to the lock-cap pump</div>
            <div style="font-size:12.5px;line-height:1.45;color:oklch(0.5 0.015 60);">61% of 214 return notes mention a broken pump. Supplier quoted 18p more per unit.</div>
            <div style="display:flex;align-items:center;gap:8px;margin-top:2px;flex-wrap:wrap;">
              <span style="font-family:'Bricolage Grotesque',sans-serif;background:oklch(0.42 0.09 22);color:oklch(0.97 0.01 80);font-weight:700;font-size:13px;padding:9px 18px;border-radius:9px;cursor:pointer;">Approve</span>
              <span style="font-family:'Bricolage Grotesque',sans-serif;color:oklch(0.4 0.015 60);font-weight:700;font-size:13px;padding:9px 15px;border-radius:9px;border:1px solid oklch(0.86 0.008 62);cursor:pointer;">5 steps</span>
              <span style="margin-left:auto;font-size:12px;font-weight:700;color:oklch(0.42 0.09 22);cursor:pointer;">How I got this number ›</span>
            </div>
          </div>

          <div style="background:oklch(0.995 0.004 70);border:1px solid oklch(0.88 0.008 62);border-radius:15px;padding:15px 17px;display:flex;flex-direction:column;gap:9px;">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
              <span style="font-family:'IBM Plex Mono',monospace;font-size:9px;letter-spacing:1.1px;text-transform:uppercase;font-weight:500;color:oklch(0.42 0.08 70);background:oklch(0.94 0.05 80);padding:3px 7px;border-radius:5px;">Time-sensitive</span>
              <span style="font-family:'IBM Plex Mono',monospace;font-size:10px;color:oklch(0.58 0.015 60);">from Inventory + Recharge</span>
              <span style="margin-left:auto;font-family:'Instrument Serif',serif;font-size:22px;color:oklch(0.42 0.09 20);">£8,200</span>
            </div>
            <div style="font-size:14.5px;line-height:1.45;color:oklch(0.24 0.02 45);">Reorder 240 units of the 30ml serum before the 12th</div>
            <div style="font-size:12.5px;line-height:1.45;color:oklch(0.5 0.015 60);">At current velocity you're out on the 19th, and the lead time is 9 days.</div>
            <div style="display:flex;align-items:center;gap:8px;margin-top:2px;flex-wrap:wrap;">
              <span style="font-family:'Bricolage Grotesque',sans-serif;background:oklch(0.42 0.09 22);color:oklch(0.97 0.01 80);font-weight:700;font-size:13px;padding:9px 18px;border-radius:9px;cursor:pointer;">Approve</span>
              <span style="font-family:'Bricolage Grotesque',sans-serif;color:oklch(0.4 0.015 60);font-weight:700;font-size:13px;padding:9px 15px;border-radius:9px;border:1px solid oklch(0.86 0.008 62);cursor:pointer;">3 steps</span>
              <span style="margin-left:auto;font-size:12px;font-weight:700;color:oklch(0.42 0.09 22);cursor:pointer;">How I got this number ›</span>
            </div>
          </div>

          <div style="font-size:13px;color:oklch(0.42 0.09 22);font-weight:700;cursor:pointer;">2 more in the queue →</div>
        </div>

        <div style="display:flex;flex-direction:column;gap:9px;">
          <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;">
            <span style="font-family:'IBM Plex Mono',monospace;font-size:10px;letter-spacing:1.6px;text-transform:uppercase;color:oklch(0.55 0.015 60);">While you slept</span>
            <span style="font-family:'IBM Plex Mono',monospace;font-size:10px;color:oklch(0.45 0.12 155);">+£2,240 this week · estimated</span>
          </div>
          <div style="background:oklch(0.99 0.003 70);border:1px solid oklch(0.88 0.008 62);border-radius:14px;overflow:hidden;">
            <div style="padding:11px 15px;border-bottom:1px solid oklch(0.93 0.006 64);display:flex;align-items:center;gap:11px;">
              <span style="flex:none;width:15px;height:15px;border-radius:50%;background:oklch(0.9 0.06 155);color:oklch(0.42 0.12 155);display:flex;align-items:center;justify-content:center;font-size:9px;">✓</span>
              <span style="flex:1;font-size:12.5px;color:oklch(0.3 0.02 45);">Moved £600 from Meta prospecting into Retargeting-UK</span>
              <span style="flex:none;font-family:'IBM Plex Mono',monospace;font-size:10px;color:oklch(0.45 0.12 155);">+£1,400/mo</span>
              <span style="flex:none;font-size:11px;font-weight:600;color:oklch(0.42 0.09 22);cursor:pointer;">working ›</span>
            </div>
            <div style="padding:11px 15px;border-bottom:1px solid oklch(0.93 0.006 64);display:flex;align-items:center;gap:11px;">
              <span style="flex:none;width:15px;height:15px;border-radius:50%;background:oklch(0.9 0.06 155);color:oklch(0.42 0.12 155);display:flex;align-items:center;justify-content:center;font-size:9px;">✓</span>
              <span style="flex:1;font-size:12.5px;color:oklch(0.3 0.02 45);">Rewrote 18 product titles and meta descriptions</span>
              <span style="flex:none;font-family:'IBM Plex Mono',monospace;font-size:10px;color:oklch(0.45 0.12 155);">+6% CTR</span>
              <span style="flex:none;font-size:11px;font-weight:600;color:oklch(0.42 0.09 22);cursor:pointer;">working ›</span>
            </div>
            <div style="padding:11px 15px;display:flex;align-items:center;gap:11px;">
              <span style="flex:none;width:15px;height:15px;border-radius:50%;background:oklch(0.9 0.06 155);color:oklch(0.42 0.12 155);display:flex;align-items:center;justify-content:center;font-size:9px;">✓</span>
              <span style="flex:1;font-size:12.5px;color:oklch(0.3 0.02 45);">Flagged the Rosehip Oil batch to fulfilment — 3 late shipments</span>
              <span style="flex:none;font-family:'IBM Plex Mono',monospace;font-size:10px;color:oklch(0.45 0.12 155);">saved 3 refunds</span>
              <span style="flex:none;font-size:11px;font-weight:600;color:oklch(0.42 0.09 22);cursor:pointer;">working ›</span>
            </div>
          </div>
        </div>
      </div>

      <!-- composer, pinned -->
      <div style="flex:none;border-top:1px solid oklch(0.88 0.008 62);background:oklch(0.98 0.004 68);padding:12px 26px 14px;display:flex;align-items:center;gap:12px;">
        <span style="width:34px;height:34px;flex:none;border-radius:10px;background:oklch(0.42 0.09 22);display:flex;align-items:center;justify-content:center;"><svg viewBox="0 0 24 24" fill="none" stroke="oklch(0.97 0.01 80)" stroke-width="2" stroke-linecap="round" style="width:16px;height:16px;display:block;"><rect x="9" y="2.5" width="6" height="11" rx="3"></rect><path d="M5.5 11a6.5 6.5 0 0 0 13 0"></path><path d="M12 17.5V21"></path></svg></span>
        <span style="flex:1;font-size:13px;color:oklch(0.5 0.015 60);">Hold <span style="font-family:'IBM Plex Mono',monospace;font-size:10.5px;background:oklch(0.94 0.006 64);border:1px solid oklch(0.88 0.008 62);border-radius:4px;padding:1px 5px;color:oklch(0.32 0.015 60);">space</span> or <span style="font-family:'IBM Plex Mono',monospace;font-size:10.5px;background:oklch(0.94 0.006 64);border:1px solid oklch(0.88 0.008 62);border-radius:4px;padding:1px 5px;color:oklch(0.32 0.015 60);">fn</span> to talk — or just type</span>
      </div>
    </div>

    <!-- PARTNER RAIL -->
    <div class="JefeRail">
      <div style="flex:1;min-height:0;overflow:auto;padding:18px 16px 20px;display:flex;flex-direction:column;gap:20px;">
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="font-family:'IBM Plex Mono',monospace;font-size:9.5px;letter-spacing:1.4px;text-transform:uppercase;color:oklch(0.4 0.08 262);background:oklch(0.93 0.025 262);padding:4px 9px;border-radius:100px;">Design partner</span>
          <span style="font-family:'IBM Plex Mono',monospace;font-size:9.5px;color:oklch(0.56 0.015 60);">#3 of 10</span>
        </div>

        <div style="display:flex;flex-direction:column;gap:9px;">
          <div style="display:flex;align-items:center;gap:7px;">
            <span style="font-family:'IBM Plex Mono',monospace;font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:oklch(0.42 0.09 22);">New in Jefe</span>
            <span style="width:6px;height:6px;border-radius:50%;background:oklch(0.62 0.13 22);animation:pulseDot 2s ease-in-out infinite;"></span>
            <span style="margin-left:auto;font-size:11px;font-weight:700;color:oklch(0.42 0.09 22);cursor:pointer;">All</span>
          </div>
          <div style="background:oklch(0.995 0.004 70);border:1px solid oklch(0.8 0.06 22);border-radius:12px;padding:11px 12px;display:flex;flex-direction:column;gap:6px;">
            <div style="display:flex;align-items:center;gap:7px;"><span style="font-family:'IBM Plex Mono',monospace;font-size:8.5px;letter-spacing:0.9px;text-transform:uppercase;font-weight:500;color:oklch(0.4 0.08 20);background:oklch(0.93 0.04 20);padding:3px 7px;border-radius:4px;">New</span><span style="margin-left:auto;font-family:'IBM Plex Mono',monospace;font-size:9px;color:oklch(0.58 0.015 60);">today</span></div>
            <div style="font-size:12.5px;line-height:1.5;color:oklch(0.26 0.02 45);">Jefe now reads your Xero margins, so pricing advice uses profit after fees rather than gross.</div>
          </div>
          <div style="background:oklch(0.995 0.004 70);border:1px solid oklch(0.88 0.008 62);border-radius:12px;padding:11px 12px;display:flex;flex-direction:column;gap:6px;">
            <div style="display:flex;align-items:center;gap:7px;"><span style="font-family:'IBM Plex Mono',monospace;font-size:8.5px;letter-spacing:0.9px;text-transform:uppercase;font-weight:500;color:oklch(0.36 0.11 155);background:oklch(0.94 0.04 155);padding:3px 7px;border-radius:4px;">Shipped</span><span style="margin-left:auto;font-family:'IBM Plex Mono',monospace;font-size:9px;color:oklch(0.58 0.015 60);">2d ago</span></div>
            <div style="font-size:12.5px;line-height:1.5;color:oklch(0.26 0.02 45);">Voice notes from WhatsApp now land in the same thread as everything else.</div>
            <div style="font-size:11px;font-weight:600;color:oklch(0.42 0.09 22);">You asked for this</div>
          </div>
          <div style="background:oklch(0.995 0.004 70);border:1px solid oklch(0.88 0.008 62);border-radius:12px;padding:11px 12px;display:flex;flex-direction:column;gap:6px;">
            <div style="display:flex;align-items:center;gap:7px;"><span style="font-family:'IBM Plex Mono',monospace;font-size:8.5px;letter-spacing:0.9px;text-transform:uppercase;font-weight:500;color:oklch(0.36 0.11 155);background:oklch(0.94 0.04 155);padding:3px 7px;border-radius:4px;">Shipped</span><span style="margin-left:auto;font-family:'IBM Plex Mono',monospace;font-size:9px;color:oklch(0.58 0.015 60);">4d ago</span></div>
            <div style="font-size:12.5px;line-height:1.5;color:oklch(0.26 0.02 45);">Every recommendation opens up to show the working behind its number.</div>
            <div style="font-size:11px;font-weight:600;color:oklch(0.42 0.09 22);">You asked for this</div>
          </div>
          <div style="background:oklch(0.995 0.004 70);border:1px solid oklch(0.88 0.008 62);border-radius:12px;padding:11px 12px;display:flex;flex-direction:column;gap:6px;">
            <div style="display:flex;align-items:center;gap:7px;"><span style="font-family:'IBM Plex Mono',monospace;font-size:8.5px;letter-spacing:0.9px;text-transform:uppercase;font-weight:500;color:oklch(0.45 0.015 60);background:oklch(0.93 0.006 64);padding:3px 7px;border-radius:4px;">Fixed</span><span style="margin-left:auto;font-family:'IBM Plex Mono',monospace;font-size:9px;color:oklch(0.58 0.015 60);">6d ago</span></div>
            <div style="font-size:12.5px;line-height:1.5;color:oklch(0.26 0.02 45);">Stopped counting gift orders against your retention rate.</div>
          </div>
        </div>

        <div style="display:flex;flex-direction:column;gap:9px;">
          <div style="font-family:'IBM Plex Mono',monospace;font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:oklch(0.42 0.09 22);">Tell us what to build</div>
          <div style="background:oklch(0.995 0.004 70);border:1px solid oklch(0.88 0.008 62);border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:10px;">
            <div style="font-size:12.5px;line-height:1.5;color:oklch(0.5 0.015 60);">What's missing? What's annoying? Ramble at us — we'd rather have the mess than a tidy summary.</div>
            <div style="display:flex;gap:7px;">
              <span style="flex:1;display:flex;align-items:center;justify-content:center;gap:6px;font-family:'Bricolage Grotesque',sans-serif;background:oklch(0.42 0.09 22);color:oklch(0.97 0.01 80);font-weight:700;font-size:12.5px;padding:9px;border-radius:9px;cursor:pointer;"><svg viewBox="0 0 24 24" fill="none" stroke="oklch(0.97 0.01 80)" stroke-width="2" stroke-linecap="round" style="width:13px;height:13px;display:block;"><rect x="9" y="2.5" width="6" height="11" rx="3"></rect><path d="M5.5 11a6.5 6.5 0 0 0 13 0"></path><path d="M12 17.5V21"></path></svg>Record</span>
              <span style="flex:1;text-align:center;font-family:'Bricolage Grotesque',sans-serif;color:oklch(0.4 0.015 60);font-weight:700;font-size:12.5px;padding:9px;border-radius:9px;border:1px solid oklch(0.86 0.008 62);cursor:pointer;">Write</span>
            </div>
            <div style="display:flex;align-items:center;gap:7px;padding-top:8px;border-top:1px solid oklch(0.93 0.006 64);">
              <span style="font-family:'IBM Plex Mono',monospace;font-size:9.5px;color:oklch(0.56 0.015 60);">Your last 3 requests</span>
              <span style="margin-left:auto;font-family:'IBM Plex Mono',monospace;font-size:9.5px;color:oklch(0.45 0.12 155);">2 shipped</span>
            </div>
          </div>
        </div>

        <div style="display:flex;flex-direction:column;gap:9px;">
          <div style="font-family:'IBM Plex Mono',monospace;font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:oklch(0.42 0.09 22);">Talk to the founders</div>
          <div style="background:oklch(0.995 0.004 70);border:1px solid oklch(0.88 0.008 62);border-radius:12px;padding:13px;display:flex;flex-direction:column;gap:11px;">
            <div style="display:flex;align-items:center;">
              <span style="width:28px;height:28px;border-radius:50%;background:oklch(0.45 0.09 262);color:white;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;border:2px solid oklch(0.995 0.004 70);">JC</span>
              <span style="width:28px;height:28px;border-radius:50%;background:oklch(0.5 0.13 320);color:white;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;border:2px solid oklch(0.995 0.004 70);margin-left:-8px;">AR</span>
              <span style="margin-left:10px;font-size:12.5px;line-height:1.4;color:oklch(0.4 0.015 60);">30 mins with us, whenever you need it</span>
            </div>
            <span style="font-family:'Bricolage Grotesque',sans-serif;text-align:center;background:oklch(0.35 0.06 262);color:oklch(0.97 0.01 80);font-weight:700;font-size:12.5px;padding:10px;border-radius:9px;cursor:pointer;">Book a slot</span>
            <div style="font-family:'IBM Plex Mono',monospace;font-size:9.5px;color:oklch(0.56 0.015 60);text-align:center;">Next free: Thu 31 Jul, 2:00pm</div>
          </div>
        </div>
      </div>
    </div>
  </div>

</div>
</body>
</html>`;

export async function loader() {
  return new Response(HTML, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy":
        "default-src 'self' https: data: 'unsafe-inline'; img-src 'self' https: data:; font-src https: data:; style-src 'self' https: 'unsafe-inline';",
      "Cache-Control": "no-store",
    },
  });
}

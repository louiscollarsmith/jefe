# Settings surface — panel contract

The in-app settings area (`app/routes/app.settings.tsx`) is a shell + a left sub-nav with
one destination per section. Four lanes build panels into it (Autonomy, Channels,
Integrations, email-preferences), plus proposals from Horizon / store-hygiene.

**This is the shared contract those lanes build against. Once panels exist in this pattern,
the pattern _is_ the contract — changing it later means editing every lane's work. So treat
a change to the established pattern as something to raise (a one-way-ish door), not to
refactor silently.** "I can revert my commit" is not the same as "this is reversible" here.

## Shape & nav direction

- One route, `/app/settings`, with an internal vertical **sub-nav**, switched by `?panel=<id>`.
  **Order is founder-specified and fixed: Autonomy · Integrations · Channels · Notifications** —
  Autonomy first (the most important control; don't let it drift as panels fill in). The `PANELS`
  array is the single ordering source; when wiring a panel, flip its `ready` and add its
  `PanelBody` case, never reorder. Slugs are stable (`autonomy`/`integrations`/`channels`/
  `settings`); the `settings` slug carries the label **"Notifications"** (label ≠ slug).
- This sub-nav is **scoped to settings only** — it is NOT the global Polaris `Frame`
  navigation, which was deliberately dropped (`0acdf68`, founder's "one nav, not two").
  Do not reintroduce a global Frame nav to bring settings back.
- The home stays a full-width conversation; settings is a **separate area**
  (interpretation A). The entry point is a **gear top-right on the home** (in the `app.tsx`
  shell, beside "Open the app"), founder-decided 2026-08-12 — the home itself stays clean, no
  left buttons on it. The gear carries the embedded `?host=…` params so auth survives the hop.

## A panel is a self-contained, data-in component

- Lives at `app/components/settings/<Name>Panel.tsx`, exports `<Name>Panel`.
- **Props = exactly the data it needs**, computed in the settings **loader** and passed
  down. A panel never fetches its own data.
- Styled to the **home tokens** (`COLORS`/`FONT` from `daily-home.tsx`), never the shelved
  13a register.
- Renders only the panel **body** — the slot already renders the panel title + blurb above
  it.
- **No fabricated data**: an absent/empty input renders an honest empty state, never a
  placeholder control or an invented number.

## Forms post to the app._index action

`/app/settings` is **loader-only (no action)**. Any `<Form>` / `useFetcher().Form` inside a
panel MUST set **`action="/app?index"`** so it reaches the `app._index` action, which owns
every intent (`notification.set`, `action.set_mode`, `channel.*`, `memory.*`, …). React
Router revalidates the settings loader after the post, so the panel reflects the new state.

Reference implementation — `AutonomyPanel`'s ModePicker:

```tsx
<fetcher.Form method="post" action="/app?index">
```

**Exception — a dedicated resource route.** When app._index does not cleanly own an intent
(e.g. the `channel.*` handlers redirect to a now-dead onboarding step), a panel may instead
post to its own resource route (e.g. `/api/channels/slack`) **provided it redirects/returns
to `/app/settings?panel=<id>`** so the settings loader still revalidates. The invariant is:
hit a working handler **and** trigger a settings revalidation. `ChannelsPanel` uses this.

## Wiring (shell owner / chat 11 — the single wiring point)

Per delivered panel: import it → compute its prop in the settings loader → add a `case` to
`PanelBody` → flip its `PANELS` entry `ready: true`. Then run `scripts/preflight.sh` — that
is the integration gate (the panel becomes imported for the first time).

## Slot status

| panel        | component          | loader prop (source)                          | status                                                            |
| ------------ | ------------------ | --------------------------------------------- | ----------------------------------------------------------------- |
| autonomy     | `AutonomyPanel`    | `actionModes` (`getLiveActionModes`)          | **wired**                                                         |
| integrations | `IntegrationsPanel`| `toolStack` (`getDetectedToolStack`)          | **wired** (empty "still learning" state — 0 detections today)     |
| channels     | `ChannelsPanel`    | `connection` + `destinations` (Slack)         | **wired** (+ `/api/channels/slack`; `?channelNotice=` surfaced)   |
| settings     | `SettingsPanel`    | `emailBrief` (contact-email + notif. pref)    | delivered as **"Notifications"**; needs `action="/app?index"` on its Form before wiring |

## Reachability

The surface is reachable from the home via the top-right gear. **Autonomy, Integrations and
Channels are live**; **Notifications** shows a merchant-facing "coming soon" until the email-prefs
panel wires in (all four sub-nav items stay visible — wire-or-keep). ⚠️ The Slack "Save channel"
flow does a **live send** to the merchant's Slack once connected — that path is founder-greenlit
(Matt, "go live for sure"), and the channels lane runs a real connect e2e before merchants use it.

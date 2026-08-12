# Settings surface — panel contract

The in-app settings area (`app/routes/app.settings.tsx`) is a shell + a left sub-nav with
one destination per section. Four lanes build panels into it (Autonomy, Channels,
Integrations, email-preferences), plus proposals from Horizon / store-hygiene.

**This is the shared contract those lanes build against. Once panels exist in this pattern,
the pattern _is_ the contract — changing it later means editing every lane's work. So treat
a change to the established pattern as something to raise (a one-way-ish door), not to
refactor silently.** "I can revert my commit" is not the same as "this is reversible" here.

## Shape & nav direction

- One route, `/app/settings`, with an internal vertical **sub-nav**
  [Integrations · Channels · Settings · Autonomy], switched by `?panel=<id>`.
- This sub-nav is **scoped to settings only** — it is NOT the global Polaris `Frame`
  navigation, which was deliberately dropped (`0acdf68`, founder's "one nav, not two").
  Do not reintroduce a global Frame nav to bring settings back.
- The home stays a full-width conversation; settings is a **separate area**
  (interpretation A). The entry point from the home (a small affordance, e.g. a gear by the
  "Open the app" button) is pending the founder's call, so the surface is not linked yet.

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

## Wiring (shell owner / chat 11 — the single wiring point)

Per delivered panel: import it → compute its prop in the settings loader → add a `case` to
`PanelBody` → flip its `PANELS` entry `ready: true`. Then run `scripts/preflight.sh` — that
is the integration gate (the panel becomes imported for the first time).

## Slot status

| panel        | component          | loader prop (source)                          | status                                                            |
| ------------ | ------------------ | --------------------------------------------- | ----------------------------------------------------------------- |
| autonomy     | `AutonomyPanel`    | `actionModes` (`getLiveActionModes`)          | **wired**                                                         |
| settings     | `SettingsPanel`    | `emailBrief` (contact-email + notif. pref)    | delivered; needs `action="/app?index"` on its Form before wiring  |
| integrations | `IntegrationsPanel`| `toolStack` (`getDetectedToolStack`)          | built; not yet pushed to main                                     |
| channels     | `ChannelsPanel` (tbd) | tbd                                        | pending founder scope greenlight (multi-hour restore)             |

## Reachability

No entry point from the home yet (pending founder), so nothing here is merchant-reachable.
Wiring panels is therefore safe/inert until the entry point lands — which is why panels can
be wired as they arrive without waiting on the entry-point decision.

// @ts-check

const APP_HOME_UI_SEARCH_KEYS = new Set([
  "conversation",
  "talkAction",
  "actionChat",
]);

/** A focused-chat resource mutation refreshes its own narrow data. */
/** @param {FormData | null | undefined} formData */
export function isAppHomeNarrowMutation(formData) {
  return formData?.get("intent") === "chat.focus.start";
}

/** @param {URL} currentUrl @param {URL} nextUrl */
export function isAppHomeUiOnlyNavigation(currentUrl, nextUrl) {
  if (
    normalizeAppDataPath(currentUrl.pathname) !== "/app" ||
    normalizeAppDataPath(nextUrl.pathname) !== "/app"
  ) {
    return false;
  }
  const changed = changedSearchKeys(
    currentUrl.searchParams,
    nextUrl.searchParams,
  );
  return (
    changed.length > 0 &&
    changed.every((key) => APP_HOME_UI_SEARCH_KEYS.has(key))
  );
}

/** @param {string} pathname */
export function normalizeAppDataPath(pathname) {
  return pathname === "/app.data" ? "/app" : pathname;
}

/** @param {URLSearchParams} current @param {URLSearchParams} next */
function changedSearchKeys(current, next) {
  const keys = new Set([...current.keys(), ...next.keys()]);
  return [...keys].filter(
    (key) =>
      current.getAll(key).join("\u0000") !== next.getAll(key).join("\u0000"),
  );
}

// @ts-check

const APP_HOME_UI_SEARCH_KEYS = new Set([
  "conversation",
  "talkAction",
  "actionChat",
]);

const OPEN_CONVERSATION_STORAGE_KEY = "jefe:daily-home:open-conversation";
const CONVERSATION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A focused-chat resource mutation refreshes its own narrow data. */
/** @param {FormData | null | undefined} formData */
export function isAppHomeNarrowMutation(formData) {
  return formData?.get("intent") === "chat.focus.start";
}

/**
 * Overlay params that must not survive a fresh app entry (App Bridge restores
 * the last URL on re-open). `conversation` is a destination, not an overlay —
 * Shopify iframe refreshes arrive as type=navigate, so Navigation Timing cannot
 * tell a reload apart from a re-open. Keep or restore the thread instead.
 *
 * @param {URLSearchParams} searchParams
 * @param {string | null | undefined} storedConversationId
 * @returns {Record<string, string | null> | null}
 */
export function dailyHomeFreshEntryUpdates(searchParams, storedConversationId) {
  /** @type {Record<string, string | null>} */
  const updates = {};
  if (searchParams.has("actionChat")) updates.actionChat = null;
  if (searchParams.has("talkAction")) updates.talkAction = null;
  const conversationId = searchParams.get("conversation");
  if (!conversationId) {
    const stored = normalizeConversationId(storedConversationId);
    if (stored) updates.conversation = stored;
  }
  return Object.keys(updates).length > 0 ? updates : null;
}

/** @returns {string | null} */
export function readStoredOpenConversation() {
  try {
    return normalizeConversationId(sessionStorage.getItem(OPEN_CONVERSATION_STORAGE_KEY));
  } catch {
    return null;
  }
}

/** @param {string | null | undefined} conversationId */
export function writeStoredOpenConversation(conversationId) {
  try {
    const stored = normalizeConversationId(conversationId);
    if (stored) sessionStorage.setItem(OPEN_CONVERSATION_STORAGE_KEY, stored);
    else sessionStorage.removeItem(OPEN_CONVERSATION_STORAGE_KEY);
  } catch {
    // Private mode / quota — losing a refresh restore is better than throwing.
  }
}

/** @param {unknown} value @returns {string | null} */
function normalizeConversationId(value) {
  const id = typeof value === "string" ? value.trim() : "";
  return CONVERSATION_ID_RE.test(id) ? id : null;
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

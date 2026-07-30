-- Win-back CAMPAIGN step tracking (emails 2 & 3 of the self-terminating uninstall
-- sequence). Day 0's farewell already claims `winback_email_sent_at`; these two
-- timestamps mark when the later nudges went out, each claimed atomically
-- (UPDATE ... WHERE winback_emailN_sent_at IS NULL) so a step sends at most once.
-- NULL = that step not yet sent.
--
-- `winback_recipient_email` persists WHO to send the follow-ups to: the uninstall
-- webhook deletes the shop's Session rows, so the recipient resolvable at Day 0 is
-- gone by the time emails 2 & 3 are due. It is written ONLY when the campaign is
-- enabled (ENABLE_WINBACK_CAMPAIGN) and cleared on reinstall alongside the guards.
-- All nullable, no default — additive and reversible.

ALTER TABLE "shops"
  ADD COLUMN "winback_email2_sent_at" TIMESTAMPTZ(6),
  ADD COLUMN "winback_email3_sent_at" TIMESTAMPTZ(6),
  ADD COLUMN "winback_recipient_email" TEXT;

// @ts-check

import { ChannelServiceError } from "./errors.server.js";

const COUNTRY_CALLING_CODES = Object.freeze({
  AU: "61",
  CA: "1",
  DE: "49",
  ES: "34",
  FR: "33",
  GB: "44",
  IE: "353",
  IT: "39",
  NL: "31",
  US: "1",
});

/**
 * @param {{ countryCode?: string | null; phoneNumber: string }} input
 */
export function normalisePhoneToE164(input) {
  const rawPhone = input.phoneNumber.trim();
  const country = input.countryCode?.trim() ?? "";
  if (!rawPhone) throw new ChannelServiceError("invalid_number");

  if (rawPhone.startsWith("+")) {
    return validateE164(`+${rawPhone.replace(/[^\d]/g, "")}`);
  }

  const callingCode = normaliseCallingCode(country);
  if (!callingCode) throw new ChannelServiceError("invalid_number");

  let nationalNumber = rawPhone.replace(/[^\d]/g, "");
  if (nationalNumber.startsWith("00")) {
    return validateE164(`+${nationalNumber.slice(2)}`);
  }
  while (nationalNumber.startsWith("0")) {
    nationalNumber = nationalNumber.slice(1);
  }

  return validateE164(`+${callingCode}${nationalNumber}`);
}

/** @param {string | null | undefined} value */
export function maskPhoneNumber(value) {
  if (!value) return null;
  const digits = value.replace(/[^\d]/g, "");
  if (digits.length <= 4) return value;
  const prefixLength = Math.min(2, Math.max(1, digits.length - 4));
  const prefix = digits.slice(0, prefixLength);
  const suffix = digits.slice(-4);
  return `+${prefix} •••• ••• ${suffix}`;
}

/** @param {string} value */
function validateE164(value) {
  if (!/^\+[1-9]\d{7,14}$/.test(value)) {
    throw new ChannelServiceError("invalid_number");
  }
  return value;
}

/** @param {string} countryCode */
function normaliseCallingCode(countryCode) {
  if (!countryCode) return null;
  const trimmed = countryCode.trim();
  const upper = trimmed.toUpperCase();
  if (COUNTRY_CALLING_CODES[/** @type {keyof typeof COUNTRY_CALLING_CODES} */ (upper)]) {
    return COUNTRY_CALLING_CODES[/** @type {keyof typeof COUNTRY_CALLING_CODES} */ (upper)];
  }
  const digits = trimmed.replace(/[^\d]/g, "");
  return digits && /^[1-9]\d{0,3}$/.test(digits) ? digits : null;
}

/**
 * @param {Record<string, string | undefined>} env
 */
export function buildHealthPayload(env = process.env) {
  return {
    ok: true,
    environment: env.APP_ENV || env.NODE_ENV || "development",
  };
}

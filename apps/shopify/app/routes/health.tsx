import { buildHealthPayload } from "../services/deployment-health.server";

export const loader = () =>
  new Response(JSON.stringify(buildHealthPayload(process.env)), {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    },
  });

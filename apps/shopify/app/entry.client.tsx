import { HydratedRouter } from "react-router/dom";
import { startTransition, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { initClientSentry } from "./lib/observability/sentry.client";

// Client entry (previously React Router's default virtual entry). Added so we
// can initialise client-side Sentry before hydration — early hydration errors
// are then captured too. Inert unless VITE_SENTRY_DSN is set at build.
initClientSentry();

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <HydratedRouter />
    </StrictMode>,
  );
});

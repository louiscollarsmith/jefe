import type { LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { redirect } = await authenticate.admin(request);

  throw redirect("/app/onboarding");
};

export default function ImportProgressRedirect() {
  return null;
}

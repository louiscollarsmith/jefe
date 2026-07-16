import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  url.searchParams.delete("preview");

  throw redirect(`/app/onboarding${url.search}`);
};

export default function ImportProgressRedirect() {
  return null;
}

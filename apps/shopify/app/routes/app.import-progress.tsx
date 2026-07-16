import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  url.searchParams.delete("preview");
  url.searchParams.set("task", "backfill");

  throw redirect(`/app/onboarding?${url.searchParams.toString()}`);
};

export default function ImportProgressRedirect() {
  return null;
}

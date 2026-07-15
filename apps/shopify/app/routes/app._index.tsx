import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  throw redirect(`/app/daily-brief${url.search}`);
};

export default function AppIndex() {
  return null;
}

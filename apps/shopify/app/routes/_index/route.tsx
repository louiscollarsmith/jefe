import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return null;
};

const proofPoints = [
  "Daily verdicts with evidence, confidence and money at stake.",
  "Inventory and margin risks surfaced before they become expensive.",
  "Approved actions only, with previews, caps and outcome tracking.",
];

const modules = [
  "Daily Verdict",
  "Inventory Guardian",
  "Watchdog",
  "Klaviyo Winback",
  "Feedback",
  "House Rules",
];

export default function Index() {
  return (
    <main className={styles.page}>
      <section className={styles.hero}>
        <div className={styles.eyebrow}>Jefe for Shopify</div>
        <h1 className={styles.heading}>An accountable AI ecom manager.</h1>
        <p className={styles.lede}>
          Jefe reads the merchant&apos;s commerce stack, opens every day with a
          verdict, recommends bounded actions, and proves what worked.
        </p>
      </section>

      <section className={styles.grid} aria-label="What Jefe does">
        {proofPoints.map((point) => (
          <article className={styles.panel} key={point}>
            <p>{point}</p>
          </article>
        ))}
      </section>

      <section className={styles.section}>
        <div>
          <h2>Built for founder-run stores.</h2>
          <p>
            Jefe is not another analytics dashboard, chatbot, or generic
            assistant. It is a manager surface for founder-led Shopify brands
            that need clearer decisions, safer execution, and verified margin.
          </p>
        </div>

        <div>
          <h2>What the app will cover.</h2>
          <ul className={styles.moduleList}>
            {modules.map((module) => (
              <li key={module}>{module}</li>
            ))}
          </ul>
        </div>
      </section>

      <section className={styles.footerNote}>
        <p>
          The MVP is intentionally read-heavy and write-light. External writes
          require merchant approval, typed adapters, idempotency keys and
          blast-radius caps.
        </p>
      </section>
    </main>
  );
}

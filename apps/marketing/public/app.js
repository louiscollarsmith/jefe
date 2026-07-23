document.getElementById("year").textContent = new Date().getFullYear();

const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const RECS = [
  {
    text: "Heads up — you'll run out of the Blue Tee in about 6 days. Want me to reorder 200 units?",
    tag: "Needs your OK",
    ask: true,
    primary: "Approve reorder",
    secondary: "Not yet",
  },
  {
    text: "I trimmed spend on your weakest Meta campaign and moved it to the one converting best — same budget, better return.",
    tag: "Done for you",
    ask: false,
    primary: "Got it",
    secondary: null,
  },
  {
    text: "A competitor just undercut your bestseller by 12%. Want me to match their price?",
    tag: "Needs your OK",
    ask: true,
    primary: "Match price",
    secondary: "Ignore",
  },
  {
    text: "Quiver's delivery options cut returns by 20% — I've made it the default at checkout.",
    tag: "Done for you",
    ask: false,
    primary: "Got it",
    secondary: null,
  },
];

const recBody = document.getElementById("rec-body");
const recText = document.getElementById("rec-text");
const recTag = document.getElementById("rec-tag");
const recPrimary = document.getElementById("rec-primary");
const recSecondary = document.getElementById("rec-secondary");
const recDots = document.getElementById("rec-dots");

let recIndex = 0;

RECS.forEach((_, i) => {
  const dot = document.createElement("button");
  dot.type = "button";
  dot.setAttribute("aria-label", `Show recommendation ${i + 1}`);
  dot.addEventListener("click", () => setRec(i));
  recDots.appendChild(dot);
});

function setRec(i) {
  recIndex = i;
  const rec = RECS[recIndex];

  recText.textContent = rec.text;
  recTag.textContent = rec.tag;
  recTag.className = `rec-tag ${rec.ask ? "ask" : "done"}`;
  recPrimary.textContent = rec.primary;

  if (rec.secondary) {
    recSecondary.textContent = rec.secondary;
    recSecondary.hidden = false;
  } else {
    recSecondary.hidden = true;
  }

  [...recDots.children].forEach((dot, i) => dot.classList.toggle("active", i === recIndex));

  if (!prefersReducedMotion) {
    recBody.style.animation = "none";
    // eslint-disable-next-line no-unused-expressions
    recBody.offsetHeight;
    recBody.style.animation = "";
  }
}

function nextRec() {
  setRec((recIndex + 1) % RECS.length);
}

recPrimary.addEventListener("click", nextRec);
recSecondary.addEventListener("click", nextRec);

setRec(0);

if (!prefersReducedMotion) {
  setInterval(nextRec, 4200);
}

const form = document.getElementById("waitlist-form");
const message = document.getElementById("form-message");
const success = document.getElementById("signup-success");
const successBody = document.getElementById("success-body");
const submitButton = form.querySelector("button[type=submit]");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = form.email.value.trim();
  const company = form.company.value;

  const storePrefix = form.storeUrl.value
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\.myshopify\.com.*$/i, "")
    .replace(/\/.*$/, "");
  const storeUrl = storePrefix ? `${storePrefix}.myshopify.com` : "";

  message.textContent = "";
  submitButton.disabled = true;

  try {
    const res = await fetch("/api/waitlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, storeUrl, company }),
    });
    const data = await res.json();

    if (res.ok && data.ok) {
      successBody.textContent = `Jefe's got your name down, ${email}. He'll be in touch.`;
      form.style.display = "none";
      success.hidden = false;
    } else {
      message.textContent = data.error || "Something went wrong. Try again shortly.";
    }
  } catch (err) {
    message.textContent = "Something went wrong. Try again shortly.";
  } finally {
    submitButton.disabled = false;
  }
});

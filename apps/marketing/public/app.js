document.getElementById("year").textContent = new Date().getFullYear();

const form = document.getElementById("waitlist-form");
const message = document.getElementById("form-message");
const button = form.querySelector("button[type=submit]");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = form.email.value.trim();
  const company = form.company.value;

  message.textContent = "";
  message.className = "form-message";
  button.disabled = true;

  try {
    const res = await fetch("/api/waitlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, company }),
    });
    const data = await res.json();

    if (res.ok && data.ok) {
      message.textContent = "You're on the list. We'll be in touch.";
      message.classList.add("success");
      form.reset();
    } else {
      message.textContent = data.error || "Something went wrong. Try again shortly.";
      message.classList.add("error");
    }
  } catch (err) {
    message.textContent = "Something went wrong. Try again shortly.";
    message.classList.add("error");
  } finally {
    button.disabled = false;
  }
});

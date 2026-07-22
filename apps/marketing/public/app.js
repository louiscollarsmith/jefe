document.getElementById("year").textContent = new Date().getFullYear();

const videoBlock = document.getElementById("video-block");
const playButton = document.getElementById("play-button");

function playVideo() {
  const videoId = videoBlock.dataset.yt;
  videoBlock.innerHTML = `<iframe
    src="https://www.youtube.com/embed/${videoId}?autoplay=1"
    title="22 Jump Street — My Name is Jeff"
    allow="autoplay; encrypted-media"
    allowfullscreen
  ></iframe>`;
}

videoBlock.addEventListener("click", playVideo);
playButton.addEventListener("click", (event) => {
  event.stopPropagation();
  playVideo();
});

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

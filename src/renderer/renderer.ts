const button = document.querySelector<HTMLButtonElement>("#hello");
const message = document.querySelector<HTMLParagraphElement>("#message");

if (!button || !message) {
  throw new Error("Required hello world elements are missing");
}

button.addEventListener("click", () => {
  void (async () => {
    button.disabled = true;
    try {
      message.textContent = await window.desktop.sayHello();
    } catch (error) {
      message.textContent = "Could not reach the main process. Please try again.";
      console.error(error);
    } finally {
      button.disabled = false;
    }
  })();
});

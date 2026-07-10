console.log("✅ PromptMeter Active on ChatGPT");

function attachListener() {

    const promptBox = document.querySelector("#prompt-textarea");

    if (!promptBox) {
        console.log("Prompt box not found");
        return;
    }

    console.log("Prompt box found");

    document.addEventListener("keydown", (event) => {

        if (event.key === "Enter" && !event.shiftKey) {

            const prompt = promptBox.innerText;

            console.log("🚀 Prompt Sent:");

            console.log(prompt);

        }

    });

}

setTimeout(attachListener,2000);
console.log("✅ PromptMeter Active on ChatGPT");

// State management for capturing turns
let lastProcessedElement = null;
let lastProcessedResponse = "";
let isStreaming = false;

// State management for typing suggestions
let debounceTimer = null;
let ignoredPromptText = "";
let wasOptimized = false;
let lastSavedTokens = 0;
let lastSavedCarbon = 0;

// Helper to query the prompt input box with robust selectors
function getPromptBox() {
    return document.querySelector("#prompt-textarea") || 
           document.querySelector('div[contenteditable="true"]') || 
           document.querySelector('textarea[placeholder*="Message"]') ||
           document.querySelector('textarea');
}

// State management for attachments (Module 13)
let activeAttachments = { images: [], documents: [] };
let lastNonEmptyAttachments = { images: [], documents: [] };

// Detects uploaded files, image previews, and file bubbles in the chat input area
function detectAttachments() {
    const images = [];
    const documents = [];
    
    // Detect preview images in the input area
    const imgElements = document.querySelectorAll('#prompt-textarea img, [class*="attachment"] img, [class*="file-pill"] img');
    imgElements.forEach(img => {
        images.push({ name: img.alt || "Image Attachment", type: "image" });
    });

    // Detect file bubbles or upload pills
    const fileElements = document.querySelectorAll('[data-testid="file-pill"], [class*="file-pill"], [class*="attachment-pill"]');
    fileElements.forEach(file => {
        const text = file.innerText || file.textContent || "";
        const isImage = /\.(jpg|jpeg|png|webp|gif|svg)$/i.test(text) || file.querySelector('img') !== null;
        
        if (!isImage) {
            let estimatedTokens = 2000; // Default document context cost
            // Match file size (e.g. "50 KB", "1.2 MB")
            const sizeMatch = text.match(/(\d+(?:\.\d+)?)\s*(KB|MB|bytes)/i);
            if (sizeMatch) {
                const val = parseFloat(sizeMatch[1]);
                const unit = sizeMatch[2].toUpperCase();
                let bytes = val;
                if (unit === 'KB') bytes *= 1024;
                if (unit === 'MB') bytes *= 1024 * 1024;
                estimatedTokens = Math.round(bytes * 0.25); // Heuristic text density conversion
            }
            documents.push({ name: text.split('\n')[0] || "Document", type: "document", tokens: estimatedTokens });
        } else {
            const name = text.split('\n')[0] || "Image";
            if (!images.some(img => img.name === name)) {
                images.push({ name: name, type: "image" });
            }
        }
    });

    return { images, documents };
}

// 1. Monitor active typing inside the prompt box (from Module 3 & 9)
function handleInput(e) {
    const originalText = e.target.value || e.target.textContent || e.target.innerText || "";
    
    // Reset debounce timer
    clearTimeout(debounceTimer);

    // If text is cleared or too short, hide optimization card immediately
    if (originalText.trim().length < 5) {
        hideOptimizationCard();
        return;
    }

    // Debounce analysis for 750ms after typing stops
    debounceTimer = setTimeout(() => {
        analyzeAndOfferOptimization(originalText);
    }, 750);
}

// 2. Hide the optimization card
function hideOptimizationCard() {
    const card = document.getElementById("promptmeter-opt-card");
    if (card) {
        card.classList.remove("visible");
    }
}

// 3. Create and show the premium optimization overlay
function showOptimizationCard(originalText, optimizedText, tokensSaved, carbonSaved) {
    let card = document.getElementById("promptmeter-opt-card");
    if (!card) {
        // Create the card container if it doesn't exist
        card = document.createElement("div");
        card.id = "promptmeter-opt-card";
        card.className = "promptmeter-opt-card";
        document.body.appendChild(card);
    }

    // Inject our glassmorphic visual layout
    card.innerHTML = `
        <div class="promptmeter-opt-header">
            <div class="promptmeter-opt-title">
                🌿 PromptMeter Sustainability Coach
            </div>
            <div class="promptmeter-opt-metrics">
                <span class="promptmeter-metric-pill">-${tokensSaved} Tokens</span>
                <span class="promptmeter-metric-pill">-${carbonSaved.toFixed(3)}g CO₂</span>
            </div>
        </div>
        <div class="promptmeter-opt-diff">
            <div class="promptmeter-diff-box promptmeter-diff-original">${originalText}</div>
            <div class="promptmeter-diff-box promptmeter-diff-optimized">${optimizedText}</div>
        </div>
        <div class="promptmeter-opt-actions">
            <button id="promptmeter-btn-ignore" class="promptmeter-opt-btn promptmeter-btn-ignore">Ignore</button>
            <button id="promptmeter-btn-accept" class="promptmeter-opt-btn promptmeter-btn-accept">Accept Optimization</button>
        </div>
    `;

    // Add event handlers
    document.getElementById("promptmeter-btn-accept").onclick = () => {
        applyOptimization(optimizedText);
    };

    document.getElementById("promptmeter-btn-ignore").onclick = () => {
        ignoredPromptText = originalText;
        hideOptimizationCard();
    };

    // Make the card slide and fade in
    card.classList.add("visible");
}

// 4. Perform lightweight analysis on active typing text
function analyzeAndOfferOptimization(text) {
    // If the user previously ignored this exact text, don't show the card
    if (text === ignoredPromptText) {
        return;
    }

    // Calculate optimized prompt
    const optimized = PromptMeterOptimizer.optimizePrompt(text);

    // Calculate current prompt score
    const analysis = PromptMeterOptimizer.analyzePrompt(text);

    // If optimized text is different and score is below 95
    if (optimized !== text && analysis.score < 95) {
        const origTokens = PromptMeterTokenizer.countTokens(text);
        const optTokens = PromptMeterTokenizer.countTokens(optimized);
        const tokensSaved = Math.max(0, origTokens - optTokens);

        if (tokensSaved > 0) {
            const elecSaved = tokensSaved * PromptMeterCalculator.config.electricityPerToken;
            const carbonSaved = elecSaved * PromptMeterCalculator.config.carbonIntensity;

            showOptimizationCard(text, optimized, tokensSaved, carbonSaved);
            return;
        }
    }

    // Hide card if prompt is already efficient
    hideOptimizationCard();
}

// 5. Apply the optimized prompt text directly into ChatGPT's input area
function applyOptimization(optimizedText) {
    const promptBox = getPromptBox();
    if (promptBox) {
        const originalText = promptBox.value || promptBox.textContent || promptBox.innerText || "";

        // Calculate and capture optimization savings (Module 12)
        const origTokens = PromptMeterTokenizer.countTokens(originalText);
        const optTokens = PromptMeterTokenizer.countTokens(optimizedText);
        const tokensSaved = Math.max(0, origTokens - optTokens);

        if (tokensSaved > 0) {
            const elecSaved = tokensSaved * PromptMeterCalculator.config.electricityPerToken;
            const carbonSaved = elecSaved * PromptMeterCalculator.config.carbonIntensity;

            wasOptimized = true;
            lastSavedTokens = tokensSaved;
            lastSavedCarbon = carbonSaved;
            console.log(`🌿 PromptMeter [Gamification]: Pre-saved ${tokensSaved} tokens and ${carbonSaved.toFixed(4)}g CO2.`);
        }

        promptBox.focus();
        
        if (promptBox.tagName === 'TEXTAREA' || promptBox.tagName === 'INPUT') {
            promptBox.value = optimizedText;
        } else {
            // Select all existing content and delete it
            document.execCommand('selectAll', false, null);
            document.execCommand('delete', false, null);
            
            // Insert optimized text (triggers React internal contenteditable listeners)
            document.execCommand('insertText', false, optimizedText);
        }

        // Dispatch input event to force React virtual DOM state synchronization
        const inputEvent = new Event('input', { bubbles: true });
        promptBox.dispatchEvent(inputEvent);

        console.log("🌿 PromptMeter [Optimizer]: Applied optimized prompt and synced React state.");
    }
    hideOptimizationCard();
}

// 6. Helper to find the user prompt preceding a given assistant response node
function findPrecedingUserPrompt(assistantElement) {
    const allMessages = Array.from(
        document.querySelectorAll('[data-message-author-role="user"], [data-message-author-role="assistant"]')
    );
    const index = allMessages.indexOf(assistantElement);
    if (index > 0) {
        // Search backwards to find the nearest user prompt
        for (let i = index - 1; i >= 0; i--) {
            if (allMessages[i].getAttribute('data-message-author-role') === 'user') {
                return allMessages[i].innerText || allMessages[i].textContent || "";
            }
        }
    }
    return "";
}

// 7. Save the captured prompt and response pair to local storage
function handleResponseCaptured(prompt, response) {
    if (!prompt.trim() && !response.trim()) return;

    const timestamp = new Date().toISOString();
    
    // Parse links and snapshot attachments (Module 13)
    const linkRegex = /https?:\/\/[^\s]+/g;
    const links = prompt.match(linkRegex) || [];
    const linkTokens = links.length * 2000; // 2000 tokens scraping compute overhead per link

    // Use current snapshot, or fallback to last-saved if the submission wiped the DOM bubbles early
    let imagesList = activeAttachments.images;
    let docsList = activeAttachments.documents;
    
    if (imagesList.length === 0 && docsList.length === 0) {
        imagesList = lastNonEmptyAttachments.images;
        docsList = lastNonEmptyAttachments.documents;
    }

    const attachedImagesCount = imagesList.length;
    const imageTokens = attachedImagesCount * 170; // 170 tokens vision model compute per image

    const documentTokens = docsList.reduce((sum, doc) => sum + (doc.tokens || 2000), 0);

    // Calculate token metrics (Module 5 & 13)
    const basePromptTokens = PromptMeterTokenizer.countTokens(prompt);
    const promptTokens = basePromptTokens + linkTokens + imageTokens + documentTokens;
    const responseTokens = PromptMeterTokenizer.countTokens(response);
    const totalTokens = promptTokens + responseTokens;

    // Calculate environmental metrics (Module 6)
    const footprint = PromptMeterCalculator.calculate(totalTokens);

    // Snapshot counts before resetting
    const attachedImages = attachedImagesCount;
    const attachedDocs = docsList.length;
    const attachedLinks = links.length;

    // Reset attachments state tracker for next turn
    activeAttachments = { images: [], documents: [] };
    lastNonEmptyAttachments = { images: [], documents: [] };

    // Retrieve history to run comparative duplicate and regen analyses (Module 8)
    PromptMeterStorage.getHistory((history) => {
        const analysis = PromptMeterOptimizer.analyzePrompt(prompt, history);

        console.log("=== PromptMeter: Captured Turn ===");
        console.log("Prompt:", prompt.substring(0, 60) + (prompt.length > 60 ? "..." : ""));
        console.log("Response:", response.substring(0, 60) + (response.length > 60 ? "..." : ""));
        console.log("Prompt Tokens (incl. overhead):", promptTokens);
        console.log("Response Tokens:", responseTokens);
        console.log("Total Tokens:", totalTokens);
        console.log("Electricity (Wh):", footprint.electricity);
        console.log("Carbon Emissions (g CO2):", footprint.carbon);
        console.log("Water Usage (mL):", footprint.water);
        console.log("Prompt Efficiency Score:", analysis.score);
        if (analysis.flags.length > 0) {
            console.log("Flags:", analysis.flags.join(", "));
        }
        console.log("Timestamp:", timestamp);
        console.log("==================================");

        const turnData = {
            prompt: prompt,
            response: response,
            promptTokens: promptTokens,
            responseTokens: responseTokens,
            totalTokens: totalTokens,
            electricity: footprint.electricity,
            carbon: footprint.carbon,
            water: footprint.water,
            efficiencyScore: analysis.score,
            wasOptimized: wasOptimized,
            tokensSaved: wasOptimized ? lastSavedTokens : 0,
            carbonSaved: wasOptimized ? lastSavedCarbon : 0,
            attachedImages: attachedImages,
            attachedDocs: attachedDocs,
            attachedLinks: attachedLinks,
            timestamp: timestamp
        };

        // Reset optimization state trackers
        wasOptimized = false;
        lastSavedTokens = 0;
        lastSavedCarbon = 0;

        // Save to storage using Module 7 storage wrapper
        PromptMeterStorage.saveTurn(turnData, () => {
            console.log(`✅ Turn data saved successfully (Score: ${analysis.score}%).`);
        });
    });
}

// 8. Main observer for handling page mutations
const observer = new MutationObserver((mutations) => {
    // A. Bind/re-bind the input event listener to the prompt textarea
    const promptBox = getPromptBox();
    if (promptBox) {
        promptBox.removeEventListener("input", handleInput);
        promptBox.addEventListener("input", handleInput);
        
        const detected = detectAttachments();
        if (detected.images.length > 0 || detected.documents.length > 0) {
            activeAttachments = detected;
            lastNonEmptyAttachments = detected;
        } else {
            // If DOM shows no attachments, we only clear activeAttachments if the input area is still being edited.
            // If the prompt text was just cleared (e.g. on submit), we retain lastNonEmptyAttachments.
            const text = promptBox.value || promptBox.textContent || promptBox.innerText || "";
            if (text.trim().length > 0) {
                // User manually removed all attachments, reset
                activeAttachments = { images: [], documents: [] };
                lastNonEmptyAttachments = { images: [], documents: [] };
            }
        }
    }

    // B. Detect assistant responses and their streaming completion
    const assistantMessages = document.querySelectorAll('[data-message-author-role="assistant"]');
    if (assistantMessages.length > 0) {
        const latestAssistantMessage = assistantMessages[assistantMessages.length - 1];
        
        // Determine if ChatGPT is currently streaming
        const isCurrentlyStreaming = 
            latestAssistantMessage.classList.contains('result-streaming') || 
            document.querySelector('button[aria-label="Stop generating"]') !== null;

        const responseText = latestAssistantMessage.innerText || latestAssistantMessage.textContent || "";

        if (latestAssistantMessage !== lastProcessedElement || responseText !== lastProcessedResponse) {
            if (isCurrentlyStreaming) {
                if (!isStreaming) {
                    isStreaming = true;
                    hideOptimizationCard(); // Hide overlay if the user hits enter/submits
                    console.log("PromptMeter: Assistant began generating response...");
                }
            } else {
                // Generation is complete, capture the response
                isStreaming = false;
                lastProcessedElement = latestAssistantMessage;
                lastProcessedResponse = responseText;

                const promptText = findPrecedingUserPrompt(latestAssistantMessage);
                handleResponseCaptured(promptText, responseText);
            }
        }
    }
});

// Watch the entire document body for elements being added/removed and attribute changes
observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class"]
});
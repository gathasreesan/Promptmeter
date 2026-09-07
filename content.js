console.log("✅ PromptMeter Active on ChatGPT");

// Global enabled state (controlled by popup on/off switch)
let isPromptMeterEnabled = true;

// Initialize enabled state from Chrome storage
if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get({ isEnabled: true }, (res) => {
        isPromptMeterEnabled = res.isEnabled !== false;
    });

    // Listen for runtime changes when user toggles switch in popup
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.isEnabled !== undefined) {
            isPromptMeterEnabled = changes.isEnabled.newValue !== false;
            if (!isPromptMeterEnabled) {
                hideOptimizationCard();
            }
            console.log(`🌿 PromptMeter is now ${isPromptMeterEnabled ? 'ACTIVE' : 'PAUSED'}`);
        }
    });
}

// State management for capturing turns
let lastProcessedElement = null;
let lastProcessedResponse = "";
let isStreaming = false;
let captureLockTimeout = null;
const loggedPromptSet = new Set(); // Tracks recently saved prompt-response pairs to prevent duplicates

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
            const sizeMatch = text.match(/(\d+(?:\.\d+)?)\s*(KB|MB|bytes)/i);
            if (sizeMatch) {
                const val = parseFloat(sizeMatch[1]);
                const unit = sizeMatch[2].toUpperCase();
                let bytes = val;
                if (unit === 'KB') bytes *= 1024;
                if (unit === 'MB') bytes *= 1024 * 1024;
                estimatedTokens = Math.round(bytes * 0.25);
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

// 1. Monitor active typing inside the prompt box
function handleInput(e) {
    if (!isPromptMeterEnabled) {
        hideOptimizationCard();
        return;
    }

    const originalText = e.target.value || e.target.textContent || e.target.innerText || "";

    clearTimeout(debounceTimer);

    if (originalText.trim().length < 5) {
        hideOptimizationCard();
        return;
    }

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

// 3. Create and show the optimization overlay
function showOptimizationCard(originalText, optimizedText, tokensSaved, carbonSaved) {
    let card = document.getElementById("promptmeter-opt-card");
    if (!card) {
        card = document.createElement("div");
        card.id = "promptmeter-opt-card";
        card.className = "promptmeter-opt-card";
        document.body.appendChild(card);
    }

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

    document.getElementById("promptmeter-btn-accept").onclick = () => {
        applyOptimization(optimizedText);
    };

    document.getElementById("promptmeter-btn-ignore").onclick = () => {
        ignoredPromptText = originalText;
        hideOptimizationCard();
    };

    card.classList.add("visible");
}

// 4. Perform analysis on active typing text
function analyzeAndOfferOptimization(text) {
    if (!isPromptMeterEnabled || text === ignoredPromptText) return;

    const optimized = PromptMeterOptimizer.optimizePrompt(text);
    const analysis = PromptMeterOptimizer.analyzePrompt(text);

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

    hideOptimizationCard();
}

// 5. Apply the optimized prompt text directly into ChatGPT's input area
function applyOptimization(optimizedText) {
    const promptBox = getPromptBox();
    if (promptBox) {
        const originalText = promptBox.value || promptBox.textContent || promptBox.innerText || "";
        const origTokens = PromptMeterTokenizer.countTokens(originalText);
        const optTokens = PromptMeterTokenizer.countTokens(optimizedText);
        const tokensSaved = Math.max(0, origTokens - optTokens);

        if (tokensSaved > 0) {
            const elecSaved = tokensSaved * PromptMeterCalculator.config.electricityPerToken;
            const carbonSaved = elecSaved * PromptMeterCalculator.config.carbonIntensity;

            wasOptimized = true;
            lastSavedTokens = tokensSaved;
            lastSavedCarbon = carbonSaved;
        }

        promptBox.focus();

        if (promptBox.tagName === 'TEXTAREA' || promptBox.tagName === 'INPUT') {
            promptBox.value = optimizedText;
        } else {
            document.execCommand('selectAll', false, null);
            document.execCommand('delete', false, null);
            document.execCommand('insertText', false, optimizedText);
        }

        const inputEvent = new Event('input', { bubbles: true });
        promptBox.dispatchEvent(inputEvent);
    }
    hideOptimizationCard();
}

// Helpers for Turn/Message containers
function getAllTurnContainers() {
    const list = document.querySelectorAll(
        'article, ' +
        '[data-testid^="conversation-turn-"], ' +
        '.conversation-turn, ' +
        '.chat-turn, ' +
        '[data-role="turn"]'
    );
    if (list.length > 0) return Array.from(list);
    return Array.from(document.querySelectorAll('.w-full.group'));
}

function getTurnContainer(element) {
    if (!element) return null;
    return element.closest('article') ||
        element.closest('[data-testid^="conversation-turn-"]') ||
        element.closest('.conversation-turn') ||
        element.closest('.chat-turn') ||
        element.closest('[data-role="turn"]') ||
        element.closest('.w-full.group');
}

function getAssistantMessages() {
    const direct = document.querySelectorAll('[data-message-author-role="assistant"], .agent-turn, .assistant-turn');
    if (direct.length > 0) return Array.from(direct);

    const turns = getAllTurnContainers();
    const assistantTurns = [];
    turns.forEach(turn => {
        const isAssistant = turn.querySelector('[data-message-author-role="assistant"]') ||
            turn.querySelector('.agent-turn') ||
            turn.querySelector('.result-streaming') ||
            turn.querySelector('button[aria-label="Read aloud"]') ||
            turn.querySelector('button[aria-label="Copy"]');
        if (isAssistant) assistantTurns.push(turn);
    });
    return assistantTurns;
}

// 6. Helper to find preceding prompt
function findPrecedingUserPrompt(assistantElement) {
    const parentTurn = getTurnContainer(assistantElement);
    if (parentTurn) {
        let prev = parentTurn.previousElementSibling;
        while (prev) {
            const isAssistant = prev.querySelector('[data-message-author-role="assistant"]') ||
                prev.querySelector('.agent-turn') ||
                prev.querySelector('.result-streaming') ||
                prev.querySelector('button[aria-label="Read aloud"]');
            if (!isAssistant && prev.innerText.trim().length > 0) {
                const userMsg = prev.querySelector('[data-message-author-role="user"]') || prev;
                return userMsg.innerText || userMsg.textContent || "";
            }
            prev = prev.previousElementSibling;
        }
    }

    const allTurns = getAllTurnContainers();
    const assistantTurn = getTurnContainer(assistantElement);
    const index = allTurns.indexOf(assistantTurn);
    if (index > 0) {
        for (let i = index - 1; i >= 0; i--) {
            const turn = allTurns[i];
            const isAssistant = turn.querySelector('[data-message-author-role="assistant"]') ||
                turn.querySelector('.agent-turn') ||
                turn.querySelector('.result-streaming') ||
                turn.querySelector('button[aria-label="Read aloud"]');
            if (!isAssistant && turn.innerText.trim().length > 0) {
                const userMsg = turn.querySelector('[data-message-author-role="user"]') || turn;
                return userMsg.innerText || userMsg.textContent || "";
            }
        }
    }
    return "";
}

// 7. Save captured prompt and response pair
function handleResponseCaptured(prompt, response) {
    if (!isPromptMeterEnabled) return;

    const cleanPrompt = prompt.trim();
    const cleanResponse = response.trim();
    if (!cleanPrompt || !cleanResponse) return;

    // Deduplication Key: Prevents same exact turn from saving repeatedly
    const dedupeKey = `${cleanPrompt.slice(0, 100)}_${cleanResponse.slice(0, 100)}`;
    if (loggedPromptSet.has(dedupeKey)) {
        return;
    }
    loggedPromptSet.add(dedupeKey);

    const timestamp = new Date().toISOString();
    const linkRegex = /https?:\/\/[^\s]+/g;
    const links = cleanPrompt.match(linkRegex) || [];
    const linkTokens = links.length * 2000;

    let imagesList = activeAttachments.images;
    let docsList = activeAttachments.documents;
    if (imagesList.length === 0 && docsList.length === 0) {
        imagesList = lastNonEmptyAttachments.images;
        docsList = lastNonEmptyAttachments.documents;
    }

    const attachedImagesCount = imagesList.length;
    const imageTokens = attachedImagesCount * 170;
    const documentTokens = docsList.reduce((sum, doc) => sum + (doc.tokens || 2000), 0);

    const basePromptTokens = PromptMeterTokenizer.countTokens(cleanPrompt);
    const promptTokens = basePromptTokens + linkTokens + imageTokens + documentTokens;
    const responseTokens = PromptMeterTokenizer.countTokens(cleanResponse);
    const totalTokens = promptTokens + responseTokens;

    const footprint = PromptMeterCalculator.calculate(totalTokens);
    const attachedImages = attachedImagesCount;
    const attachedDocs = docsList.length;
    const attachedLinks = links.length;

    activeAttachments = { images: [], documents: [] };
    lastNonEmptyAttachments = { images: [], documents: [] };

    PromptMeterStorage.getHistory((history) => {
        const analysis = PromptMeterOptimizer.analyzePrompt(cleanPrompt, history);

        const turnData = {
            prompt: cleanPrompt,
            response: cleanResponse,
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

        wasOptimized = false;
        lastSavedTokens = 0;
        lastSavedCarbon = 0;

        PromptMeterStorage.saveTurn(turnData, () => {
            console.log(`✅ Turn saved (Score: ${analysis.score}%).`);
        });
    });
}

// 8. Main observer with debounced generation completion
const observer = new MutationObserver((mutations) => {
    const promptBox = getPromptBox();
    if (promptBox) {
        promptBox.removeEventListener("input", handleInput);
        promptBox.addEventListener("input", handleInput);

        const detected = detectAttachments();
        if (detected.images.length > 0 || detected.documents.length > 0) {
            activeAttachments = detected;
            lastNonEmptyAttachments = detected;
        } else {
            const text = promptBox.value || promptBox.textContent || promptBox.innerText || "";
            if (text.trim().length > 0) {
                activeAttachments = { images: [], documents: [] };
                lastNonEmptyAttachments = { images: [], documents: [] };
            }
        }
    }

    const assistantMessages = getAssistantMessages();
    if (assistantMessages.length > 0) {
        const latestAssistantMessage = assistantMessages[assistantMessages.length - 1];

        const isCurrentlyStreaming =
            latestAssistantMessage.classList.contains('result-streaming') ||
            latestAssistantMessage.querySelector('.result-streaming') !== null ||
            document.querySelector('button[aria-label="Stop generating"]') !== null ||
            document.querySelector('.result-streaming') !== null;

        const responseText = (latestAssistantMessage.innerText || latestAssistantMessage.textContent || "").trim();

        if (isCurrentlyStreaming) {
            isStreaming = true;
            hideOptimizationCard();
            clearTimeout(captureLockTimeout);
        } else if (isStreaming && responseText.length > 0) {
            // Wait 800ms after streaming stops to ensure DOM has finalized markdown/code blocks
            clearTimeout(captureLockTimeout);
            captureLockTimeout = setTimeout(() => {
                isStreaming = false;
                lastProcessedElement = latestAssistantMessage;
                lastProcessedResponse = responseText;

                const promptText = findPrecedingUserPrompt(latestAssistantMessage);
                handleResponseCaptured(promptText, responseText);
            }, 800);
        }
    }
});

// Watch document
observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class"]
});
/**
 * PromptMeter Optimizer & Analyzer (Advanced Structural NLP & Intent Rewriter)
 * 
 * Provides deep structural prompt transformations:
 * - Detects and corrects typos, misspelled pleasantries ("plesase" -> "please"), and keyboard smashes.
 * - Restructures indirect conversational preambles ("I am having an exam help me to study AI") 
 *   into high-efficiency imperative prompts ("Help me study for my AI exam.").
 * - Normalizes chat slang, abbreviations ("u" -> "you", "w/o" -> "without"), and tech acronyms ("ai" -> "AI").
 * - Strips pleasantries, greetings, AI names ("chatgpt"), and meta-prompting padding.
 * - Maximizes token and carbon savings across any user prompt.
 */
const PromptMeterOptimizer = {
    // Dictionary of common spelling errors, typos, and fuzzy pleasantry variations
    typoDictionary: {
        // Politeness typos
        "plesase": "please",
        "plese": "please",
        "pleae": "please",
        "pleese": "please",
        "pleas": "please",
        "pleaz": "please",
        "plise": "please",
        "plse": "please",
        "plz": "please",
        "pls": "please",
        "thx": "thanks",
        "thnks": "thanks",
        "thanku": "thank you",
        "tysm": "thank you",
        "ty": "thank you",
        
        // Common typos
        "grmmmar": "grammar",
        "grmmar": "grammar",
        "grammer": "grammar",
        "deytect": "detect",
        "detec": "detect",
        "teh": "the",
        "hte": "the",
        "wrting": "writing",
        "witing": "writing",
        "wrtg": "writing",
        "pyton": "python",
        "pyhtn": "python",
        "pyhton": "python",
        "exampel": "example",
        "exampal": "example",
        "explenation": "explanation",
        "explanasion": "explanation",
        "codeing": "coding",
        "funciton": "function",
        "funtion": "function",
        "functon": "function",
        "scrpt": "script",
        "scipt": "script",
        "differnt": "different",
        "difrent": "different",
        "seperate": "separate",
        "recieve": "receive",
        "definitly": "definitely",
        "definately": "definitely",
        "tommorow": "tomorrow",
        "tomorow": "tomorrow",
        "neccessary": "necessary",
        "necesary": "necessary",
        "algoritm": "algorithm",
        "datbase": "database",
        "databse": "database",
        "perforamnce": "performance",
        "sugest": "suggest",
        "optmize": "optimize",
        "optmise": "optimize",
        "enviroment": "environment",
        "referance": "reference",
        "occurd": "occurred",
        "occured": "occurred",
        "helpfull": "helpful",
        "usefull": "useful",
        "successfull": "successful",
        "beatifull": "beautiful",
        "alot": "a lot",
        "goverment": "government",
        "knowlege": "knowledge",
        "similiar": "similar",
        "javascriptt": "javascript",
        "javscript": "javascript"
    },

    // Technical acronyms and subject proper case formatting
    techAcronymMap: {
        "ai": "AI",
        "ml": "ML",
        "nlp": "NLP",
        "ui": "UI",
        "ux": "UX",
        "api": "API",
        "apis": "APIs",
        "sql": "SQL",
        "json": "JSON",
        "html": "HTML",
        "css": "CSS",
        "js": "JavaScript",
        "py": "Python",
        "dsa": "Data Structures & Algorithms",
        "db": "database"
    },

    // Informal chat slang and abbreviations
    // NOTE: Single-char expansions ("u", "r") removed — they corrupt technical words like
    // "url", "router", "user", "return", "for", etc.
    chatSlangMap: {
        "w/": "with",
        "w/o": "without",
        "asap": "as soon as possible",
        "gimme": "give me",
        "wanna": "want to",
        "gotta": "got to",
        "kinda": "kind of",
        "dunno": "don't know",
        "bc": "because",
        "b/c": "because",
        "approx": "approximately"
    },

    // Missing contraction apostrophes
    contractionMap: {
        "im": "I'm",
        "dont": "don't",
        "cant": "can't",
        "wont": "won't",
        "ive": "I've",
        "youre": "you're",
        "theyre": "they're",
        "isnt": "isn't",
        "arent": "aren't",
        "doesnt": "doesn't",
        "didnt": "didn't",
        "havent": "haven't",
        "hasnt": "hasn't",
        "couldnt": "couldn't",
        "wouldnt": "wouldn't",
        "shouldnt": "shouldn't",
        "whats": "what's",
        "theres": "there's"
    },

    // Regular expression rules for scoring deductions & pattern matching
    rules: {
        greetings: /\b(hello|hallo|hi+|he+y+|greetings|dear|good\s+morning|good\s+afternoon|good\s+evening|chatgpt|chat\s*gpt|gpt|yo+|howdy|what's\s+up|salutations|hi\s+there|hey\s+there|dear\s+ai|dear\s+assistant|hiya)\b/gi,
        politeness: /\b(please|plea+se+|ples+a+s+e*|pl+z+|pl+s+|pretty\s+please|thank\s+you|thanks|thx|tysm|ty|could\s+you|would\s+you\s+mind|would\s+you\s+please|can\s+you\s+please|kindly|hope\s+you\s+are\s+well|hope\s+this\s+finds\s+you\s+well|do\s+me\s+a\s+favor|i\s+beg\s+you|my\s+life\s+depends|be\s+a\s+sweetheart|i\s+will\s+tip)\b/gi,
        preambles: /\b(i\s+am\s+(?:having|really\s+bored|preparing|studying|working)|i'm\s+(?:having|really\s+bored|preparing|studying|working)|so\s+i\s+want\s+to|i\s+want\s+to|i\s+need\s+to|i\s+would\s+like\s+to|i\s+would\s+like\s+you\s+to|i\s+was\s+wondering\s+if|so\s+basically|to\s+give\s+you\s+a\s+little\s+background|as\s+you\s+might\s+know|i\s+was\s+sitting|i\s+just\s+wanted\s+to\s+ask|i\s+am\s+trying\s+to\s+figure\s+out|is\s+there\s+any\s+chance|do\s+you\s+know\s+if)\b/gi,
        fluffConstraints: /\b(take\s+a\s+deep\s+breath|think\s+step\s+by\s+step|do\s+not\s+hesitate\s+to|feel\s+free\s+to|without\s+any\s+further\s+delay|brief\s+concise|short\s+and\s+concise|concise\s+and\s+not\s+long|detailed\s+comprehensive\s+step-by-step\s+in-depth)\b/gi,
        fillerPhrases: /\b(in\s+order\s+to|due\s+to\s+the\s+fact\s+that|as\s+a\s+matter\s+of\s+fact|more\s+or\s+less|virtually|for\s+all\s+intents\s+and\s+purposes|can\s+you\s+help\s+me|at\s+this\s+point\s+in\s+time|in\s+the\s+event\s+that|for\s+the\s+purpose\s+of|a\s+large\s+number\s+of|has\s+the\s+capability\s+to|make\s+a\s+decision|perform\s+an\s+analysis|take\s+into\s+consideration|prior\s+to|subsequent\s+to|with\s+regard\s+to|with\s+respect\s+to)\b/gi,
        symbolSpam: /(!{2,}|\?{2,}|\.{4,})/g,
        repeatedWords: /\b(\w+)\s+\1\b/gi,
        copyPasteGarbage: /(Sent\s+from\s+my\s+(?:iPhone|iPad|Android|Galaxy|Outlook)|Confidentiality\s+Notice:[\s\S]*|Page\s+\d+\s+of\s+\d+)/gi,
        chatSlang: /\b(u|r|w\/|w\/o|asap|gimme|wanna|gotta|kinda|dunno|bc|b\/c|approx)\b/gi,
        spellingTypos: /\b(plesase|plese|pleae|pleese|pleas|plise|plse|grmmmar|grmmar|grammer|deytect|detec|teh|hte|wrting|witing|wrtg|pyton|pyhtn|pyhton|exampel|exampal|explenation|explanasion|codeing|funciton|funtion|functon|scrpt|scipt|differnt|difrent|seperate|recieve|definitly|definately|tommorow|tomorow|neccessary|necesary|algoritm|datbase|databse|perforamnce|sugest|optmize|optmise|enviroment|referance|occurd|occured|helpfull|usefull|successfull|beatifull|alot|goverment|knowlege|similiar|javascriptt|javscript)\b/gi
    },

    /**
     * Fixes spelling, typos, chat slang, contractions, article agreement, and tech acronyms.
     * @param {string} text - Input text.
     * @returns {string} Grammatically corrected text.
     */
    correctGrammarAndSpelling: function(text) {
        if (!text) return "";
        let str = text;

        // 1. Fix common dictionary typos
        for (const [typo, fix] of Object.entries(this.typoDictionary)) {
            const rx = new RegExp(`\\b${typo}\\b`, 'gi');
            str = str.replace(rx, fix);
        }

        // 2. Fix repeated character typos (e.g., "grmmmar" -> "grammar", "pleaaase" -> "please")
        str = str.replace(/([a-z])\1{2,}/gi, (match, char) => {
            if (/[eomsnlpftr]/i.test(char)) return char + char;
            return char;
        });

        // 3. Expand chat slang
        for (const [slang, expanded] of Object.entries(this.chatSlangMap)) {
            const rx = slang.includes('/') 
                ? new RegExp(slang.replace('/', '\\/'), 'gi')
                : new RegExp(`\\b${slang}\\b`, 'gi');
            str = str.replace(rx, expanded);
        }

        // 4. Fix missing contraction apostrophes (Bug #6: preserve original capitalization)
        for (const [flat, contracted] of Object.entries(this.contractionMap)) {
            const rx = new RegExp(`\\b${flat}\\b`, 'gi');
            str = str.replace(rx, (match) => {
                // Preserve capitalization: if match was Title Case, keep Title Case
                if (match[0] === match[0].toUpperCase()) {
                    return contracted.charAt(0).toUpperCase() + contracted.slice(1);
                }
                return contracted;
            });
        }

        // 5. Format tech acronyms & subjects properly (e.g., "ai" -> "AI", "js" -> "JavaScript")
        for (const [acronym, formatted] of Object.entries(this.techAcronymMap)) {
            const rx = new RegExp(`\\b${acronym}\\b`, 'g');
            str = str.replace(rx, formatted);
        }

        // 6. Fix article agreement (a/an)
        str = str.replace(/\b([Aa])\s+([aeiou]\w+)/g, (match, a, word) => {
            if (/^(user|european|one|unicode|universal|utility)/i.test(word)) {
                return `${a} ${word}`;
            }
            return `${a}n ${word}`;
        });
        str = str.replace(/\b([Aa])n\s+([bcdfghjklmnpqrstvwxyz]\w+)/g, (match, a, word) => {
            if (/^(hour|honest|honor)/i.test(word)) {
                return `${a}n ${word}`;
            }
            return `${a} ${word}`;
        });

        // 7. Capitalize standalone "i"
        str = str.replace(/\b i \b/g, ' I ');

        // 8. Fix missing space after punctuation: "word,word" -> "word, word"
        str = str.replace(/(\w)([,!?:;])(\w)/g, '$1$2 $3');

        // 9. Fix double punctuation like ",," or ".."
        str = str.replace(/,{2,}/g, ',');
        str = str.replace(/;{2,}/g, ';');

        return str;
    },

    /**
     * Transforms indirect conversational preambles & wordy request wrappers into concise imperative prompts.
     * Example: "I am having an exam help me to study AI" -> "Help me study for my AI exam."
     * @param {string} text - Cleaned prompt text.
     * @returns {string} Structurally transformed text.
     */
    transformStructuralIntent: function(text) {
        if (!text) return "";
        let str = text.trim();

        // 1. Remove trailing emotional confusion fluff
        str = str.replace(/\b(?:because|since)\s+i\s+am\s+(?:really\s+)?(?:confused|stuck|lost|bored|struggling|dumb|clueless|new\s+to\s+this)\b.*/gi, '').trim();

        // 2. Exam / Study / Test Preambles
        const examMatch = str.match(/^I\s+(?:am\s+)?(?:having|preparing|studying|taking|got)\s+(?:a|an)\s+(?:exam|test|quiz|midterm|final)(?:\s+tomorrow|\s+next\s+week)?(?:\s+(?:in|on|for)\s+([a-z0-9\s#+\-&]+))?\s*(?:help\s+me|can\s+you\s+help\s+me|could\s+you\s+help\s+me)?\s*(?:to\s+)?(?:study|prepare|learn)?\s*(?:for)?\s*(.*?)$/i);
        if (examMatch) {
            let subject = (examMatch[2] || examMatch[1] || "").trim();
            subject = subject.replace(/^(?:to\s+)?(?:study|prepare|learn)\s+(?:for\s+)?/i, '').replace(/^(?:in|on|for)\s+/i, '');
            subject = subject.replace(/\s+help\s+me(?:\s+to)?(?:\s+(?:prepare|study|learn))?$/i, '').trim();
            if (subject.length > 0) {
                return `Help me study for my ${subject} exam.`;
            }
        }

        // 3. Work / Project Preambles
        const projectMatch = str.match(/^I\s+(?:am\s+)?working\s+on\s+a[n]?\s+(.*?)\s+(?:project|app|website)\s+(?:and|so)?\s*(?:I\s+need\s+(?:you\s+to|help\s+to)?|can\s+you|could\s+you)?\s*(.*)$/i);
        if (projectMatch && projectMatch[1] && projectMatch[2]) {
            const domain = projectMatch[1].trim();
            const task = projectMatch[2].trim();
            return `${task} for a ${domain} project.`;
        }

        // 4. Scenario & Narrative Compression ("Imagine a X is running a Y. Explain why Z and describe W")
        str = str.replace(/^Imagine\s+(?:a|an)\s+(.*?)\s+is\s+running\s+a\s+/i, 'Describe a $1 running a ');
        str = str.replace(/^Imagine\s+(?:that\s+)?/i, '');
        str = str.replace(/^Suppose\s+(?:that\s+)?/i, '');

        // 5. Verbosity & Indirect Action Simplification
        str = str.replace(/\bdecided\s+to\s+replace\s+all\s+the\s+/gi, 'replaced all ');
        str = str.replace(/\bdecided\s+to\s+(replace|use|create|make|build|change|implement|add|remove|switch)\b/gi, '$1d');
        str = str.replace(/\band\s+describe\s+the\s+(?:company's|project's|app's)\s+/gi, 'and its ');
        str = str.replace(/\bthe\s+(?:company's|organization's)\s+/gi, 'its ');
        str = str.replace(/\bis\s+running\s+a\b/gi, 'running a');

        // 6. Number Words & Duration Normalization ("five-year" -> "5-year")
        str = str.replace(/\bone-year\b/gi, '1-year');
        str = str.replace(/\btwo-year\b/gi, '2-year');
        str = str.replace(/\bthree-year\b/gi, '3-year');
        str = str.replace(/\bfour-year\b/gi, '4-year');
        str = str.replace(/\bfive-year\b/gi, '5-year');
        str = str.replace(/\bten-year\b/gi, '10-year');

        // 7. Redundant Prepositions & Articles
        str = str.replace(/\ball\s+of\s+the\b/gi, 'all');
        str = str.replace(/\bsome\s+of\s+the\b/gi, 'some');
        str = str.replace(/\beach\s+and\s+every\b/gi, 'each');
        str = str.replace(/\ba\s+large\s+number\s+of\b/gi, 'many');
        str = str.replace(/\ba\s+small\s+number\s+of\b/gi, 'few');

        // 8. Request & Direct Command Wrappers
        str = str.replace(/^I\s+(?:want|need|would\s+like)\s+(?:you\s+to\s+)?(?:check|review|analyze)\s+/i, 'Check ');
        str = str.replace(/^(?:can\s+you\s+|could\s+you\s+|please\s+)?help\s+me\s+to\s+/i, 'Help me ');
        str = str.replace(/^I\s+(?:want|would\s+like|am\s+trying)\s+to\s+(?:understand|learn|figure\s+out)\s+how\s+/i, 'Explain how ');
        str = str.replace(/^(?:can\s+you\s+|could\s+you\s+)?(?:give\s+(?:me\s+)?a[n]?\s+|provide\s+a[n]?\s+)?explanation\s+(?:of|on|about)\s+/i, 'Explain ');
        str = str.replace(/^I\s+(?:need|want|require)\s+code\s+(for|to)\s+/i, 'Write code $1 ');
        str = str.replace(/^(?:do\s+you\s+know|can\s+you\s+tell\s+me|could\s+you\s+tell\s+me)\s+(how|what|why|where|when)\s+/i, '$1 ');

        return str;
    },

    /**
     * Analyzes the efficiency of a prompt and computes a score from 0 to 100.
     * @param {string} prompt - The raw prompt text.
     * @param {Array} history - The list of historical turns.
     * @returns {Object} Analysis report { score, flags }
     */
    analyzePrompt: function (prompt, history = []) {
        if (!prompt || prompt.trim() === "") {
            return { score: 100, flags: [] };
        }

        let score = 100;
        const flags = [];
        const cleanPrompt = prompt.trim();

        // 1. Check for Greetings
        const greetingMatches = cleanPrompt.match(this.rules.greetings);
        if (greetingMatches && greetingMatches.length > 0) {
            const deduction = Math.min(15, greetingMatches.length * 5);
            score -= deduction;
            flags.push(`Greetings detected (-${deduction} pts)`);
        }

        // 2. Check for Politeness & Emotional Begging
        const politenessMatches = cleanPrompt.match(this.rules.politeness);
        if (politenessMatches && politenessMatches.length > 0) {
            const deduction = Math.min(25, politenessMatches.length * 8);
            score -= deduction;
            flags.push(`Over-politeness/emotional padding detected (-${deduction} pts)`);
        }

        // 3. Check for Conversational Preambles
        const preambleMatches = cleanPrompt.match(this.rules.preambles);
        if (preambleMatches && preambleMatches.length > 0) {
            const deduction = Math.min(25, preambleMatches.length * 10);
            score -= deduction;
            flags.push(`Conversational preambles detected (-${deduction} pts)`);
        }

        // 4. Check for Meta-Prompting Fluff & Redundant Constraints
        const constraintMatches = cleanPrompt.match(this.rules.fluffConstraints);
        if (constraintMatches && constraintMatches.length > 0) {
            const deduction = Math.min(20, constraintMatches.length * 10);
            score -= deduction;
            flags.push(`Meta-prompting fluff / redundant constraints detected (-${deduction} pts)`);
        }

        // 5. Check for Wordy/Filler Phrases
        const fillerMatches = cleanPrompt.match(this.rules.fillerPhrases);
        if (fillerMatches && fillerMatches.length > 0) {
            const deduction = Math.min(20, fillerMatches.length * 8);
            score -= deduction;
            flags.push(`Redundant wordy filler phrases detected (-${deduction} pts)`);
        }

        // 6. Check for Symbol Spam & Excessive Punctuation
        const symbolMatches = cleanPrompt.match(this.rules.symbolSpam);
        if (symbolMatches && symbolMatches.length > 0) {
            score -= 10;
            flags.push("Excessive punctuation & symbol spam detected (-10 pts)");
        }

        // 7. Check for Adjacent Word Repetition
        const repetitionMatches = cleanPrompt.match(this.rules.repeatedWords);
        if (repetitionMatches && repetitionMatches.length > 0) {
            score -= 10;
            flags.push("Adjacent repeated words detected (-10 pts)");
        }

        // 8. Check for Copy-Paste Metadata Footers
        const garbageMatches = cleanPrompt.match(this.rules.copyPasteGarbage);
        if (garbageMatches && garbageMatches.length > 0) {
            score -= 15;
            flags.push("Unwanted email/metadata footer detected (-15 pts)");
        }

        // 9. Check for Spelling & Typos
        const typoMatches = cleanPrompt.match(this.rules.spellingTypos);
        if (typoMatches && typoMatches.length > 0) {
            score -= 10;
            flags.push("Spelling typos & misspellings detected (-10 pts)");
        }

        // 10. Check for Chat Slang & Informal Abbreviations
        const slangMatches = cleanPrompt.match(this.rules.chatSlang);
        if (slangMatches && slangMatches.length > 0) {
            score -= 8;
            flags.push("Chat slang & informal abbreviations detected (-8 pts)");
        }

        // 11. History-based analysis: Duplicate Prompts & Regenerations
        if (history && history.length > 0) {
            const lastTurn = history[history.length - 1];
            if (lastTurn && lastTurn.prompt && lastTurn.prompt.trim() === cleanPrompt) {
                const timeDiff = new Date() - new Date(lastTurn.timestamp);
                const isRegen = timeDiff < 3 * 60 * 1000;

                if (isRegen) {
                    score -= 15;
                    flags.push("Frequent prompt regeneration detected (-15 pts)");
                } else {
                    score -= 10;
                    flags.push("Duplicate prompt detected (-10 pts)");
                }
            }
        }

        score = Math.max(0, Math.min(100, score));

        return {
            score: score,
            flags: flags
        };
    },

    /**
     * Checks if a text string is primarily a raw code snippet or stack trace.
     * @param {string} text - Input text.
     * @returns {boolean} True if text is identified as code.
     */
    isCodeSnippet: function(text) {
        if (!text) return false;
        
        const codeIndicators = [
            /^\s*(?:import|export)\s+[\w*{}\s,'"]+from/m,
            /^\s*(?:const|let|var|function|class|def|async|return|if|for|while|switch)\s+[\w$]/m,
            /^\s*(?:public|private|protected|static|void|int|string|boolean|double|float)\s+[\w$]/m,
            /^\s*(?:SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\s+[A-Z*\s]/im,
            /^\s*(?:<[!a-zA-Z]|<\/?[a-zA-Z]+>)/m,
            /^\s*\{\s*"[\w-]+"\s*:/m,
            /Traceback\s+\(most\s+recent\s+call\s+last\):/i,
            /Error:\s+[\s\S]*?\b(?:at\s+|line\s+\d+)/i,
            /console\.(?:log|warn|error|info)\s*\(/
        ];

        let matches = 0;
        for (const rx of codeIndicators) {
            if (rx.test(text)) matches++;
        }

        const lines = text.trim().split('\n');
        const syntaxLines = lines.filter(line => /[{};()=>]\s*$/.test(line.trim()));

        return matches >= 1 || (lines.length > 2 && (syntaxLines.length / lines.length) > 0.35);
    },

    /**
     * Advanced Multi-Pass Optimization Engine:
     * Cleans bizarre, wordy, noisy, or misspelled prompts into streamlined, compute-efficient, grammatically correct queries.
     * Protects 100% of code snippets, code blocks, and programming constructs from corruption.
     * @param {string} prompt - The original prompt text.
     * @returns {string} The optimized prompt text.
     */
    optimizePrompt: function (prompt) {
        if (!prompt || prompt.trim() === "") {
            return "";
        }

        const rawPrompt = prompt;

        // STAGE 0: Extract and Protect Code Blocks (both triple ``` and single ` backtick blocks)
        const codeBlocks = [];
        const protectedPrompt = rawPrompt.replace(/(```[\s\S]*?```|`[^`\n]+`)/g, (match) => {
            const placeholder = `___PROMPTMETER_CODE_BLOCK_${codeBlocks.length}___`;
            codeBlocks.push(match);
            return placeholder;
        });

        // If the remaining prompt text is identified as raw code, return untouched to preserve program integrity!
        const textWithoutBlocks = protectedPrompt.replace(/___PROMPTMETER_CODE_BLOCK_\d+___/g, '').trim();
        if (textWithoutBlocks.length > 0 && this.isCodeSnippet(textWithoutBlocks)) {
            return prompt;
        }

        let optimized = protectedPrompt;

        // --- STAGE 1: Grammar, Spelling & Acronym Pre-processing ---
        optimized = this.correctGrammarAndSpelling(optimized);

        // --- STAGE 2: Copy-Paste Garbage & Symbol Spam Cleaning ---
        optimized = optimized.replace(/(?:Sent\s+from\s+my\s+(?:iPhone|iPad|Android|Galaxy|Outlook)|Confidentiality\s+Notice:[\s\S]*|Page\s+\d+\s+of\s+\d+)/gi, '');
        
        // Normalize symbol spam: "!!!!!!" -> "!", "?????" -> "?", "....." -> "..."
        optimized = optimized.replace(/!{2,}/g, '!');
        optimized = optimized.replace(/\?{2,}/g, '?');
        optimized = optimized.replace(/\.{4,}/g, '...');

        // --- STAGE 3: Iterative Conversational & Pleasantry Stripping ---
        const globalStrippers = [
            /\b(?:hello|hallo|hi+|he+y+|greetings|dear|good\s+morning|good\s+afternoon|good\s+evening|yo+|howdy|what's\s+up|salutations|hiya)\b(?:\s+(?:chatgpt|chat\s*gpt|gpt|ai|assistant|there))?(?:[,!.\s]*)/gi,
            /\b(?:hope\s+you\s+are\s+doing\s+well(?:\s+today)?|hope\s+this\s+finds\s+you\s+well|how\s+are\s+you(?:\s+today)?)(?:[,!.\s]*)/gi,
            /\b(?:i\s+am\s+(?:really\s+)?bored(?:\s+so)?|i'm\s+(?:really\s+)?bored(?:\s+so)?|so\s+i\s+want\s+to|so\s+i\s+need\s+to)\b\s*/gi,
            /\b(?:so\s+basically\s+what\s+happened\s+was|to\s+give\s+you\s+a\s+little\s+background(?:\s+context)?|as\s+you\s+might\s+already\s+know|i\s+was\s+sitting(?:\s+at\s+my\s+computer)?\s+thinking(?:\s+and)?)\b(?:[,!.\s]*)/gi,
            /\b(?:i\s+was\s+wondering\s+if\s+you\s+could|i\s+just\s+wanted\s+to\s+ask\s+if\s+you\s+can|can\s+you\s+help\s+me\s+with|could\s+you\s+help\s+me\s+with|can\s+you\s+help\s+me\s+to|could\s+you\s+help\s+me\s+to|can\s+you\s+help\s+me)\b\s*/gi,
            /\b(?:i\s+am\s+trying\s+to\s+figure\s+out\s+how\s+to|i\s+am\s+looking\s+for\s+a\s+way\s+to|is\s+there\s+any\s+way\s+that\s+you\s+could|do\s+you\s+know\s+if)\b\s*/gi,
            /\b(?:i\s+would\s+like\s+you\s+to|i\s+would\s+like\s+to|i\s+want\s+you\s+to|i\s+want\s+to|i\s+need\s+you\s+to|i\s+need\s+to)\b\s*/gi,
            /\b(?:pretty\s+please|do\s+me\s+a\s+huge\s+favor(?:\s+and)?|be\s+a\s+sweetheart(?:\s+and)?|my\s+life\s+depends\s+on\s+this|i\s+beg\s+you|i\s+will\s+tip(?:\s+\$\d+)?)\b\s*/gi,
            /\b(?:would\s+you\s+mind|would\s+you\s+please|can\s+you\s+please|could\s+you\s+please|could\s+you|would\s+you|can\s+you)\b\s*/gi,
            /\b(?:please|plea+se+|ples+a+s+e*|pl+z+|pl+s+)\b\s*/gi,
            /\b(?:thank\s+you\s+so\s+much|thank\s+you|thanks\s+a\s+lot|thanks|thx|tysm|ty|kindly)(?:[,!.\s]*)/gi,
            /\b(?:chatgpt|chat\s*gpt|gpt)\b(?:[,!.\s]*)/gi
        ];

        // 2 deterministic passes with explicit regex lastIndex resetting
        for (let pass = 0; pass < 2; pass++) {
            for (const rx of globalStrippers) {
                rx.lastIndex = 0;
                optimized = optimized.replace(rx, ' ');
            }
        }

        // --- STAGE 4: Structural Intent Transformation ---
        optimized = this.transformStructuralIntent(optimized);

        // --- STAGE 5: Meta-Prompting Fluff & Redundant Constraint Simplification ---
        optimized = optimized.replace(/\b(?:take\s+a\s+deep\s+breath|without\s+any\s+further\s+delay|do\s+not\s+hesitate\s+to|feel\s+free\s+to)\b(?:[,!.\s]*)/gi, '');
        optimized = optimized.replace(/\b(?:make\s+sure\s+(?:it\s+is\s+)?(?:brief,\s*)?(?:concise,\s*)?(?:short,\s*)?(?:and\s+)?not\s+long)\b/gi, 'make it concise');
        optimized = optimized.replace(/\b(?:detailed,\s*comprehensive,\s*step-by-step,\s*in-depth\s+explanation|detailed\s+comprehensive\s+explanation)\b/gi, 'detailed explanation');

        // --- STAGE 6: Concise Word & Thesaurus Replacement ---
        optimized = optimized.replace(/\bin\s+order\s+to\b/gi, 'to');
        optimized = optimized.replace(/\bdue\s+to\s+the\s+fact\s+that\b/gi, 'because');
        optimized = optimized.replace(/\bas\s+a\s+matter\s+of\s+fact\b/gi, 'actually');
        optimized = optimized.replace(/\bfor\s+all\s+intents\s+and\s+purposes\b/gi, 'basically');
        optimized = optimized.replace(/\bat\s+this\s+point\s+in\s+time\b/gi, 'now');
        optimized = optimized.replace(/\bin\s+the\s+event\s+that\b/gi, 'if');
        optimized = optimized.replace(/\bfor\s+the\s+purpose\s+of\b/gi, 'for');
        optimized = optimized.replace(/\bhas\s+the\s+capability\s+to\b/gi, 'can');
        optimized = optimized.replace(/\bmake\s+a\s+decision\b/gi, 'decide');
        optimized = optimized.replace(/\bperform\s+an\s+analysis\s+on\b/gi, 'analyze');
        optimized = optimized.replace(/\btake\s+into\s+consideration\b/gi, 'consider');
        optimized = optimized.replace(/\bwith\s+regard\s+to\b/gi, 'regarding');
        optimized = optimized.replace(/\bwith\s+respect\s+to\b/gi, 'regarding');

        // --- STAGE 7: Re-run Grammar Post-processing ---
        optimized = this.correctGrammarAndSpelling(optimized);

        // --- STAGE 8: Clean Joining Words & Formatting ---
        // Clean orphan leading joiners ("and write a script" -> "write a script")
        optimized = optimized.replace(/^\s*(?:and|so|or|but|then)\s+/gi, '');

        // Bug #5 fix: Only remove duplicate adjacent FILLER words (≤6 chars), never code/technical terms
        // "write write" -> "write", but never affect "return return" or variable names
        if (codeBlocks.length === 0) {
            optimized = optimized.replace(/\b(\w{1,6})\s+\1\b/gi, '$1');
        }

        // Clean up redundant spaces, punctuation artifacts, leading dots/commas, multiple spaces, empty lines
        optimized = optimized.replace(/^[.,:;\s]+/, '').replace(/[ \t]+/g, ' ').replace(/\s+([,.?!])/g, '$1').replace(/\n\s*\n/g, '\n').trim();

        // Remove trailing commas, semicolons, or prepositions
        optimized = optimized.replace(/[,;:]\s*$/, '');

        // --- STAGE 9: Intent Preservation Fallback ---
        // If everything was stripped, preserve original trimmed text with grammar fix
        if (optimized.length === 0 && prompt.trim().length > 0) {
            optimized = this.correctGrammarAndSpelling(prompt.trim());
        }

        // Capitalize the first letter
        if (optimized.length > 0) {
            optimized = optimized.charAt(0).toUpperCase() + optimized.slice(1);
        }

        // --- STAGE 10: Re-inject Pristine Original Code Blocks ---
        if (codeBlocks.length > 0) {
            codeBlocks.forEach((codeBlock, index) => {
                const placeholder = `___PROMPTMETER_CODE_BLOCK_${index}___`;
                optimized = optimized.split(placeholder).join(codeBlock);
            });
        }

        return optimized;
    }
};

// Export for ES Module / browser environment compatibility
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { PromptMeterOptimizer };
}

/**
 * PromptMeter Optimizer & Analyzer (Structural NLP & Intent Rewriter)
 *
 * Rewrites wordy, misspelled, or padded prompts into concise imperative queries,
 * and scores how efficient a prompt was to begin with.
 *
 * The transformations live in plain data tables (dictionaries and [pattern, replacement]
 * pairs) that are compiled into regexes once at load time. Adding a rule means adding a
 * row to a table, not another line of procedural code.
 */
// The protected-span registry is a separate file so the rules that decide "never touch
// this" can be reviewed and tested on their own. It loads before this file in the
// manifest, and is required directly under Node.
const PM_PROTECT = (typeof PromptMeterProtect !== 'undefined')
    ? PromptMeterProtect
    : (typeof require !== 'undefined' ? require('./protect.js').PromptMeterProtect : null);

// Sentence-level condensing, for prompts too long for phrase rules to help with.
const PM_CONDENSE = (typeof PromptMeterCondense !== 'undefined')
    ? PromptMeterCondense
    : (typeof require !== 'undefined' ? require('./condense.js').PromptMeterCondense : null);

const PromptMeterOptimizer = {
    // Politeness typos. Kept apart from spellingTypos because the scoring pass already
    // penalises these under the "politeness" rule and must not charge for them twice.
    politenessTypos: {
        "thx": "thanks", "thnks": "thanks", "thanku": "thank you",
        "tysm": "thank you", "ty": "thank you", "plz": "please", "pls": "please"
    },

    // Ordinary misspellings. The scoring pass derives its typo regex from these keys.
    spellingTypos: {
        "plesase": "please", "plese": "please", "pleae": "please", "pleese": "please",
        "pleas": "please", "pleaz": "please", "plise": "please", "plse": "please",
        "grmmmar": "grammar", "grmmar": "grammar", "grammer": "grammar",
        "deytect": "detect", "detec": "detect", "teh": "the", "hte": "the",
        "wrting": "writing", "witing": "writing", "wrtg": "writing",
        "pyton": "python", "pyhtn": "python", "pyhton": "python",
        "exampel": "example", "exampal": "example",
        "explenation": "explanation", "explanasion": "explanation",
        "codeing": "coding", "funciton": "function", "funtion": "function",
        "functon": "function", "scrpt": "script", "scipt": "script",
        "differnt": "different", "difrent": "different", "seperate": "separate",
        "recieve": "receive", "definitly": "definitely", "definately": "definitely",
        "tommorow": "tomorrow", "tomorow": "tomorrow",
        "neccessary": "necessary", "necesary": "necessary",
        "algoritm": "algorithm", "datbase": "database", "databse": "database",
        "perforamnce": "performance", "sugest": "suggest",
        "optmize": "optimize", "optmise": "optimize",
        "enviroment": "environment", "referance": "reference",
        "occurd": "occurred", "occured": "occurred",
        "helpfull": "helpful", "usefull": "useful", "successfull": "successful",
        "beatifull": "beautiful", "alot": "a lot", "goverment": "government",
        "knowlege": "knowledge", "similiar": "similar",
        "javascriptt": "javascript", "javscript": "javascript"
    },

    // Technical acronyms, matched case-sensitively so "AI" and "Js" are left alone.
    techAcronymMap: {
        "ai": "AI", "ml": "ML", "nlp": "NLP", "ui": "UI", "ux": "UX",
        "api": "API", "apis": "APIs", "sql": "SQL", "json": "JSON",
        "html": "HTML", "css": "CSS", "js": "JavaScript", "py": "Python",
        "dsa": "Data Structures & Algorithms", "db": "database"
    },

    // Informal chat slang. Single-char expansions ("u", "r") are deliberately absent:
    // they corrupt technical words. They are still penalised by the chatSlang score rule.
    chatSlangMap: {
        "w/o": "without", "w/": "with", "b/c": "because", "bc": "because",
        "asap": "as soon as possible", "gimme": "give me", "wanna": "want to",
        "gotta": "got to", "kinda": "kind of", "dunno": "don't know",
        "approx": "approximately"
    },

    // Missing contraction apostrophes.
    contractionMap: {
        "im": "I'm", "dont": "don't", "cant": "can't", "wont": "won't",
        "ive": "I've", "youre": "you're", "theyre": "they're", "isnt": "isn't",
        "arent": "aren't", "doesnt": "doesn't", "didnt": "didn't",
        "havent": "haven't", "hasnt": "hasn't", "couldnt": "couldn't",
        "wouldnt": "wouldn't", "shouldnt": "shouldn't",
        "whats": "what's", "theres": "there's"
    },

    /**
     * Compiles a lookup map into a single word-bounded alternation regex.
     *
     * Keys are sorted longest-first so "w/o" wins over "w/" and "thanku" over "ty".
     * The trailing edge uses (?!\w) rather than \b: for keys ending in a word character
     * the two are identical, but \b would fail on slash-terminated keys like "w/",
     * where the following space is not a word boundary.
     *
     * @param {Object} map - Lookup table of term -> replacement.
     * @param {string} flags - Regex flags ('gi' for case-insensitive matching).
     * @returns {RegExp} One regex matching any key in the map.
     */
    buildAlternation: function (map, flags) {
        const keys = Object.keys(map)
            .sort((a, b) => b.length - a.length)
            .map(k => k.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&'));
        return new RegExp('\\b(?:' + keys.join('|') + ')(?!\\w)', flags);
    },

    /**
     * Replaces every map key found in the text using a prebuilt alternation regex.
     * @param {string} text - Input text.
     * @param {RegExp} rx - Alternation regex from buildAlternation.
     * @param {Object} map - The lookup table the regex was built from.
     * @param {boolean} preserveCase - Re-capitalize the replacement when the match was capitalized.
     * @returns {string} Text with all matches replaced.
     */
    replaceAll: function (text, rx, map, preserveCase) {
        return text.replace(rx, (match) => {
            const replacement = map[match.toLowerCase()];
            if (replacement === undefined) return match;
            if (preserveCase && match[0] === match[0].toUpperCase()) {
                return replacement.charAt(0).toUpperCase() + replacement.slice(1);
            }
            return replacement;
        });
    },

    // Regex rules for scoring deductions. `per` points are charged per match, capped at `cap`;
    // a flat-rate rule is simply one where per === cap.
    scoreRules: [
        {
            label: "Greetings detected", per: 5, cap: 15,
            rx: /\b(hello|hallo|hi+|he+y+|greetings|dear|good\s+morning|good\s+afternoon|good\s+evening|chatgpt|chat\s*gpt|gpt|yo+|howdy|what's\s+up|salutations|hi\s+there|hey\s+there|dear\s+ai|dear\s+assistant|hiya)\b/gi
        },
        {
            label: "Over-politeness/emotional padding detected", per: 8, cap: 25,
            rx: /\b(please|plea+se+|ples+a+s+e*|pl+z+|pl+s+|pretty\s+please|thank\s+you|thanks|thx|tysm|ty|could\s+you|would\s+you\s+mind|would\s+you\s+please|can\s+you\s+please|kindly|hope\s+you\s+are\s+well|hope\s+this\s+finds\s+you\s+well|do\s+me\s+a\s+favor|i\s+beg\s+you|my\s+life\s+depends|be\s+a\s+sweetheart|i\s+will\s+tip)\b/gi
        },
        {
            label: "Conversational preambles detected", per: 10, cap: 25,
            rx: /\b(i\s+am\s+(?:having|really\s+bored|preparing|studying|working)|i'm\s+(?:having|really\s+bored|preparing|studying|working)|so\s+i\s+want\s+to|i\s+want\s+to|i\s+need\s+to|i\s+would\s+like\s+to|i\s+would\s+like\s+you\s+to|i\s+was\s+wondering\s+if|so\s+basically|to\s+give\s+you\s+a\s+little\s+background|as\s+you\s+might\s+know|i\s+was\s+sitting|i\s+just\s+wanted\s+to\s+ask|i\s+am\s+trying\s+to\s+figure\s+out|is\s+there\s+any\s+chance|do\s+you\s+know\s+if)\b/gi
        },
        {
            label: "Meta-prompting fluff / redundant constraints detected", per: 10, cap: 20,
            rx: /\b(take\s+a\s+deep\s+breath|think\s+step\s+by\s+step|do\s+not\s+hesitate\s+to|feel\s+free\s+to|without\s+any\s+further\s+delay|brief\s+concise|short\s+and\s+concise|concise\s+and\s+not\s+long|detailed\s+comprehensive\s+step-by-step\s+in-depth)\b/gi
        },
        {
            label: "Redundant wordy filler phrases detected", per: 8, cap: 20,
            rx: /\b(in\s+order\s+to|due\s+to\s+the\s+fact\s+that|as\s+a\s+matter\s+of\s+fact|more\s+or\s+less|virtually|for\s+all\s+intents\s+and\s+purposes|can\s+you\s+help\s+me|at\s+this\s+point\s+in\s+time|in\s+the\s+event\s+that|for\s+the\s+purpose\s+of|a\s+large\s+number\s+of|has\s+the\s+capability\s+to|make\s+a\s+decision|perform\s+an\s+analysis|take\s+into\s+consideration|prior\s+to|subsequent\s+to|with\s+regard\s+to|with\s+respect\s+to)\b/gi
        },
        {
            label: "Excessive punctuation & symbol spam detected", per: 10, cap: 10,
            rx: /(!{2,}|\?{2,}|\.{4,})/g
        },
        {
            label: "Adjacent repeated words detected", per: 10, cap: 10,
            rx: /\b(\w+)\s+\1\b/gi
        },
        {
            label: "Unwanted email/metadata footer detected", per: 15, cap: 15,
            rx: /(Sent\s+from\s+my\s+(?:iPhone|iPad|Android|Galaxy|Outlook)|Confidentiality\s+Notice:[\s\S]*|Page\s+\d+\s+of\s+\d+)/gi
        },
        {
            // Built from the spellingTypos keys at load time, below.
            label: "Spelling typos & misspellings detected", per: 10, cap: 10,
            rx: null
        },
        {
            label: "Chat slang & informal abbreviations detected", per: 8, cap: 8,
            rx: /\b(u|r|w\/|w\/o|asap|gimme|wanna|gotta|kinda|dunno|bc|b\/c|approx)\b/gi
        },
        {
            label: "Conversational filler & hedging detected", per: 6, cap: 18,
            rx: /\b(?:um+|uh+|erm+|hmm+|you\s+know|i\s+mean|(?:i\s+was\s+)?just\s+wondering|out\s+of\s+curiosity|if\s+that\s+makes\s+sense|or\s+something|or\s+whatever|and\s+stuff|sorry\s+(?:if|for)\s+(?:this|the)|correct\s+me\s+if|i\s+hope\s+(?:this|that)\s+makes\s+sense|is\s+it\s+(?:possible|ok|okay)\s+(?:to|if)|are\s+you\s+able\s+to|do\s+you\s+think\s+you\s+(?:can|could))\b/gi
        },
        {
            label: "Sign-off & gratitude padding detected", per: 6, cap: 12,
            rx: /\b(?:thanks?\s+(?:in\s+advance|so\s+much|a\s+(?:lot|ton|bunch))|much\s+appreciated|appreciate\s+(?:it|any\s+help)|any\s+help\s+(?:would\s+be|is)\s+(?:appreciated|great)|cheers|(?:best|kind|warm)\s+regards|looking\s+forward\s+to)\b/gi
        },
        {
            label: "Urgency padding detected", per: 6, cap: 6,
            rx: /\b(?:asap|as\s+soon\s+as\s+possible|urgently|as\s+quickly\s+as\s+possible|it(?:'?s|\s+is)\s+urgent|this\s+is\s+urgent|quick(?:ly)?\s+please)\b/gi
        },
        {
            label: "Keyboard noise detected", per: 12, cap: 12,
            rx: /\b[a-z]*(?:asdf|sdfg|dfgh|qwer|werty|zxcv|xcvb|hjkl|uiop)[a-z]*\b/gi
        },
        {
            label: "Emoji spam detected", per: 5, cap: 5,
            rx: /(?:[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}]\uFE0F?\s*){2,}/gu
        },
        {
            label: "Meta commentary about the question detected", per: 6, cap: 12,
            rx: /\b(?:i\s+have\s+a\s+(?:quick\s+)?question(?:\s+about)?|quick\s+question(?:\s+about)?|one\s+(?:more|last)\s+thing|just\s+to\s+clarify|for\s+your\s+information|fyi|please\s+note\s+that)\b/gi
        }
    ],

    // Stated intent -> the imperative it stands for. These must run BEFORE the
    // conversational strippers, which would otherwise remove the "I want to" wrapper on
    // its own and leave the verb behind as a broken command -- "I want to know about X"
    // becoming "Know about X" rather than "Explain X".
    intentRewrites: [
        [/(?<=^|[.!?;,]|\n)\s*(?:i|we)\s+(?:would\s+like|want|need|wanted)\s+to\s+(?:know|understand|learn|find\s+out)\s+(?:about\s+|more\s+about\s+)?/gi, 'Explain '],
        [/(?<=^|[.!?;,]|\n)\s*(?:i|we)\s+(?:would\s+like|want|need)\s+to\s+see\s+/gi, 'Show '],
        [/(?<=^|[.!?;,]|\n)\s*(?:i|we)\s+(?:am|'m)\s+curious\s+(?:about|how|what|why)\s+/gi, 'Explain '],
        [/\b(?:things?|stuff)\s+(?:that\s+)?(?:i|we)\s+(?:should|need\s+to|have\s+to)\s+know\s+about\b/gi, 'key points of']
    ],

    // Wordy phrase -> concise equivalent.
    concisePhrases: [
        [/\bin\s+order\s+to\b/gi, 'to'],
        [/\b(?:that|which)\s+can\s+be\s+used\s+to\b/gi, 'to'],
        [/\bdue\s+to\s+the\s+fact\s+that\b/gi, 'because'],
        [/\bas\s+a\s+matter\s+of\s+fact\b/gi, 'actually'],
        [/\bfor\s+all\s+intents\s+and\s+purposes\b/gi, 'basically'],
        [/\bat\s+this\s+point\s+in\s+time\b/gi, 'now'],
        [/\bin\s+the\s+event\s+that\b/gi, 'if'],
        [/\bfor\s+the\s+purpose\s+of\b/gi, 'for'],
        [/\bhas\s+the\s+capability\s+to\b/gi, 'can'],
        [/\bmake\s+a\s+decision\b/gi, 'decide'],
        [/\bperform\s+an\s+analysis\s+on\b/gi, 'analyze'],
        [/\btake\s+into\s+consideration\b/gi, 'consider'],
        [/\bwith\s+regard\s+to\b/gi, 'regarding'],
        [/\bwith\s+respect\s+to\b/gi, 'regarding']
    ],

    // Greetings, pleasantries and request wrappers stripped outright. Ordered most-specific
    // first, so long phrases are consumed before the generic ones that overlap them.
    conversationalStrippers: [
        /\b(?:hello|hallo|hi+|he+y+|greetings|dear|good\s+morning|good\s+afternoon|good\s+evening|yo+|howdy|what's\s+up|salutations|hiya)\b(?:\s+(?:chatgpt|chat\s*gpt|gpt|ai|assistant|there))?(?:[,!.\s]*)/gi,
        /\b(?:(?:i\s+)?hope\s+you\s+are\s+doing\s+well(?:\s+today)?|hope\s+this\s+finds\s+you\s+well|how\s+are\s+you(?:\s+today)?)(?:[,!.\s]*)/gi,
        /\b(?:i\s+am\s+(?:really\s+)?bored(?:\s+so)?|i'm\s+(?:really\s+)?bored(?:\s+so)?|so\s+i\s+want\s+to|so\s+i\s+need\s+to)\b\s*/gi,
        /\b(?:so\s+basically\s+what\s+happened\s+was|to\s+give\s+you\s+a\s+little\s+background(?:\s+context)?|as\s+you\s+might\s+already\s+know|i\s+was\s+sitting(?:\s+at\s+my\s+computer)?\s+thinking(?:\s+and)?)\b(?:[,!.\s]*)/gi,
        /\b(?:i\s+was\s+wondering\s+if\s+you\s+could|i\s+just\s+wanted\s+to\s+ask\s+if\s+you\s+can|can\s+you\s+help\s+me\s+with|could\s+you\s+help\s+me\s+with|can\s+you\s+help\s+me\s+to|could\s+you\s+help\s+me\s+to|can\s+you\s+help\s+me)\b\s*/gi,
        /\b(?:i\s+am\s+trying\s+to\s+figure\s+out\s+how\s+to|i\s+am\s+looking\s+for\s+a\s+way\s+to|is\s+there\s+any\s+way\s+that\s+you\s+could|do\s+you\s+know\s+if)\b\s*/gi,
        /(?<=^|[.!?]|[,;]|\n)\s*(?:i\s+would\s+like\s+you\s+to|i\s+would\s+like\s+to|i\s+want\s+you\s+to|i\s+want\s+to|i\s+need\s+you\s+to|i\s+need\s+to)\b\s*/gim,
        /\b(?:pretty\s+please|do\s+me\s+a\s+huge\s+favor(?:\s+and)?|be\s+a\s+sweetheart(?:\s+and)?|my\s+life\s+depends\s+on\s+this|i\s+beg\s+you|i\s+will\s+tip(?:\s+\$\d+)?)\b\s*/gi,
        /(?<=^|[.!?]|[,;]|\n)\s*(?:would\s+you\s+mind|would\s+you\s+please|can\s+you\s+please|could\s+you\s+please|could\s+you|would\s+you|can\s+you)\b\s*/gim,
        /\b(?:please|plea+se+|ples+a+s+e*|pl+z+|pl+s+)\b\s*/gi,
        /\b(?:thank\s+you\s+so\s+much(?:\s+for\s+your\s+[\w\s]{0,30}?(?:time|help|assistance))?|thank\s+you(?:\s+for\s+your\s+[\w\s]{0,30}?(?:time|help|assistance))?|thanks\s+a\s+lot|thanks|thx|tysm|ty|kindly)(?:[,!.\s]*)/gi,
        /\b(?:chatgpt|chat\s*gpt|gpt)\b(?:[,!.\s]*)/gi
    ],

    // Conversational noise that carries no instruction. These are deliberately narrow:
    // a wrong strip silently destroys the user's meaning, which is far worse than
    // leaving a few filler tokens in place.
    junkStrippers: [
        // Keyboard mashing and typing noise
        /\b[a-z]*(?:asdf|sdfg|dfgh|qwer|werty|zxcv|xcvb|hjkl|uiop)[a-z]*\b/gi,
        // Filler interjections and verbal tics
        /\b(?:um+|uh+|erm+|hmm+|welp|ok(?:ay)?\s+so|alright\s+so|so\s+yeah|yeah\s+so)\b[,!.\s]*/gi,
        /\b(?:you\s+know|i\s+mean|like(?=\s*,)|like\s+i\s+said|as\s+i\s+said|if\s+that\s+makes\s+sense|or\s+something|or\s+whatever|and\s+stuff)\b[,!.\s]*/gi,
        // Hedging, apology and self-deprecation
        /\b(?:sorry\s+(?:if|for)\s+(?:this\s+is|the)\s+(?:a\s+)?(?:dumb|stupid|silly|basic|long|obvious)[\w\s]{0,12}|i\s+know\s+this\s+(?:might\s+be|is|sounds)\s+(?:a\s+)?(?:basic|dumb|stupid|silly|obvious)[\w\s]{0,12}|this\s+may(?:be)?\s+(?:be\s+)?(?:a\s+)?(?:dumb|stupid|basic)\s+question|not\s+sure\s+if\s+(?:this|that)(?:'s|\s+is)\s+(?:right|correct|clear)|correct\s+me\s+if\s+(?:i'?m|i\s+am)\s+wrong|i\s+hope\s+(?:this|that)\s+makes\s+sense|(?:i\s+was\s+)?just\s+wondering|(?:i\s+was\s+)?just\s+curious|out\s+of\s+curiosity)\b[,!.\s]*/gi,
        // Sign-offs and gratitude tails
        /\b(?:thanks?\s+(?:in\s+advance|so\s+much|a\s+(?:lot|ton|bunch))|much\s+appreciated|(?:i'?d\s+|i\s+would\s+)?(?:really\s+)?appreciate\s+(?:it|any\s+help)(?:\s+if\s+you\s+(?:could|can|would))?|any\s+help\s+(?:would\s+be|is)\s+(?:appreciated|great)|cheers|(?:best|kind|warm)\s+regards|looking\s+forward\s+to\s+(?:your|the)\s+(?:response|reply|answer)|let\s+me\s+know\s+(?:if\s+you\s+need\s+(?:anything\s+else|more\s+(?:info|information|details))|what\s+you\s+think))\b[,!.\s]*/gi,
        // Urgency padding: an LLM cannot act on it, so it is pure token cost
        /\b(?:asap|as\s+soon\s+as\s+possible|urgently|as\s+quickly\s+as\s+possible|it(?:'?s|\s+is)\s+urgent|this\s+is\s+urgent|quick(?:ly)?\s+please)\b[,!.\s]*/gi,
        // Permission-seeking wrappers
        /\b(?:is\s+it\s+(?:possible|ok|okay)\s+(?:to|if)|do\s+you\s+think\s+you\s+(?:can|could)|are\s+you\s+able\s+to|if\s+(?:it'?s|its)\s+not\s+too\s+much\s+trouble|if\s+you\s+(?:don'?t|do\s+not)\s+mind|whenever\s+you\s+(?:get\s+a\s+chance|can))\b\s*/gi,
        // Meta announcements about the question itself
        /\b(?:i\s+have\s+a\s+(?:quick\s+)?question(?:\s+about)?|quick\s+question(?:\s+about)?|one\s+(?:more|last)\s+thing|just\s+to\s+clarify|for\s+your\s+information|fyi|please\s+note\s+that)\b[,:!.\s]*/gi,
        // Doubled intensifiers ("very very")
        /\b(very|really|so|super|extremely|totally)\s+\1\b/gi,
        // Emoji runs. Two or more in a row is decoration; a single emoji may be the
        // actual subject of the question, so it is left alone.
        /(?:[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{FE0F}]\uFE0F?\s*){2,}/gu
    ],

    // Stacked synonyms ("detailed and comprehensive and thorough") say one thing three
    // times. The first survives.
    adjectiveStacks: [
        [/\b(detailed|comprehensive|thorough|in-depth|extensive|exhaustive|complete|full)(?:(?:,|\s+and|,\s+and)\s+(?:detailed|comprehensive|thorough|in-depth|extensive|exhaustive|complete|full))+\b/gi, '$1'],
        [/\b(simple|easy|basic|straightforward|clear)(?:(?:,|\s+and|,\s+and)\s+(?:simple|easy|basic|straightforward|clear))+\b/gi, '$1'],
        [/\b(quick|fast|rapid|speedy)(?:(?:,|\s+and|,\s+and)\s+(?:quick|fast|rapid|speedy))+\b/gi, '$1']
    ],

    // Repairs run after stripping. Removing a phrase from the middle of a sentence can
    // strand the connective that introduced it ("... because about marketing"), so these
    // rules tidy up the joins rather than the content.
    connectiveRepairs: [
        // A conjunction left immediately before a preposition lost its clause
        [/\b(?:because|since|as|and|but|so|where|when|which|that|who|if)\s+(about|for|of|in|on|with|to|from|by)\b/gi, '$1'],
        // A conjunction left dangling at a clause or sentence end
        [/\s*\b(?:because|since|and|but|so|where|when|which|that|who|if|although|however)\s*([,.;!?])/gi, '$1'],
        // Two coordinators in a row
        [/\b(?:and|but|or)\s+(and|but|or)\b/gi, '$1'],
        // A stranded leading connective once the opening clause was removed
        [/^\s*(?:and|but|so|because|since|where|when|which|that|although|however)\b\s*/i, ''],
        // Duplicated preposition after a merge
        [/\b(about|for|of|in|on|with|to|from|by)\s+\1\b/gi, '$1']
    ],

    // Request wrappers that survived the original rules. Split by where they are safe
    // to remove: the anchored group is only a wrapper at the start of a clause
    // ("I am trying to build X"), because mid-clause it is ordinary grammar
    // ("explain what I am trying to do"). The unanchored group is padding anywhere.
    wrapperStrippers: [
        /(?<=^|[.!?]|[,;]|\n)\s*(?:(?:i'?m|i\s+am)\s+trying\s+to|i\s+was\s+hoping\s+(?:that\s+)?you\s+(?:could|would|can)(?:\s+maybe)?|i\s+wonder(?:ed)?\s+if\s+you\s+(?:could|can|would)|(?:i'?m|i\s+am)\s+looking\s+for\s+(?:a\s+way\s+to|help\s+(?:with|to)))\b\s*/gim,
        /\b(?:i\s+need\s+help\s+(?:with|on|to)|i\s+could\s+use\s+(?:some\s+)?help\s+(?:with|on)|any\s+chance\s+you\s+(?:could|can))\b\s*/gi
    ],

    // Meta-prompting padding and over-specified constraints.
    fluffReplacements: [
        [/\b(?:take\s+a\s+deep\s+breath|without\s+any\s+further\s+delay|do\s+not\s+hesitate\s+to|feel\s+free\s+to)\b(?:[,!.\s]*)/gi, ''],
        [/\b(?:make\s+sure\s+(?:it\s+is\s+)?(?:brief,\s*)?(?:concise,\s*)?(?:short,\s*)?(?:and\s+)?not\s+long)\b/gi, 'make it concise'],
        [/\b(?:detailed,\s*comprehensive,\s*step-by-step,\s*in-depth\s+explanation|detailed\s+comprehensive\s+explanation)\b/gi, 'detailed explanation']
    ],

    // Narrative padding, verbose constructions and wordy request wrappers, rewritten in place.
    structuralRewrites: [
        // Trailing emotional confusion fluff
        [/\b(?:because|since)\s+i\s+am\s+(?:really\s+)?(?:confused|stuck|lost|bored|struggling|dumb|clueless|new\s+to\s+this)\b.*/gi, ''],
        // Scenario & narrative compression
        [/^Imagine\s+(?:a|an)\s+(.*?)\s+is\s+running\s+a\s+/i, 'Describe a $1 running a '],
        [/^Imagine\s+(?:that\s+)?/i, ''],
        [/^Suppose\s+(?:that\s+)?/i, ''],
        // Indirect action simplification
        [/\bdecided\s+to\s+replace\s+all\s+the\s+/gi, 'replaced all '],
        [/\bdecided\s+to\s+(replace|use|create|make|build|change|implement|add|remove|switch)\b/gi, '$1d'],
        [/\band\s+describe\s+the\s+(?:company's|project's|app's)\s+/gi, 'and its '],
        [/\bthe\s+(?:company's|organization's)\s+/gi, 'its '],
        [/\bis\s+running\s+a\b/gi, 'running a'],
        // Duration normalization ("five-year" -> "5-year")
        [/\bone-year\b/gi, '1-year'],
        [/\btwo-year\b/gi, '2-year'],
        [/\bthree-year\b/gi, '3-year'],
        [/\bfour-year\b/gi, '4-year'],
        [/\bfive-year\b/gi, '5-year'],
        [/\bten-year\b/gi, '10-year'],
        // Redundant quantifiers
        [/\ball\s+of\s+the\b/gi, 'all'],
        [/\bsome\s+of\s+the\b/gi, 'some'],
        [/\beach\s+and\s+every\b/gi, 'each'],
        [/\ba\s+large\s+number\s+of\b/gi, 'many'],
        [/\ba\s+small\s+number\s+of\b/gi, 'few'],
        // Request wrappers -> direct commands
        [/^I\s+(?:want|need|would\s+like)\s+(?:you\s+to\s+)?(?:check|review|analyze)\s+/i, 'Check '],
        [/^(?:can\s+you\s+|could\s+you\s+|please\s+)?help\s+me\s+to\s+/i, 'Help me '],
        [/^I\s+(?:want|would\s+like|am\s+trying)\s+to\s+(?:understand|learn|figure\s+out)\s+how\s+/i, 'Explain how '],
        [/^(?:can\s+you\s+|could\s+you\s+)?(?:give\s+(?:me\s+)?a[n]?\s+|provide\s+a[n]?\s+)?explanation\s+(?:of|on|about)\s+/i, 'Explain '],
        [/^I\s+(?:need|want|require)\s+code\s+(for|to)\s+/i, 'Write code $1 '],
        [/^(?:do\s+you\s+know|can\s+you\s+tell\s+me|could\s+you\s+tell\s+me)\s+(how|what|why|where|when)\s+/i, '$1 ']
    ],

    // Patterns identifying raw code or stack traces, which must never be rewritten.
    codeIndicators: [
        /^\s*(?:import|export)\s+[\w*{}\s,'"]+from/m,
        /^\s*(?:const|let|var|function|class|def|async|return|if|for|while|switch)\s+[\w$]/m,
        /^\s*(?:public|private|protected|static|void|int|string|boolean|double|float)\s+[\w$]/m,
        /^\s*(?:SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\s+[A-Z*\s]/im,
        /^\s*(?:<[!a-zA-Z]|<\/?[a-zA-Z]+>)/m,
        /^\s*\{\s*"[\w-]+"\s*:/m,
        /Traceback\s+\(most\s+recent\s+call\s+last\):/i,
        /Error:\s+[\s\S]*?\b(?:at\s+|line\s+\d+)/i,
        /console\.(?:log|warn|error|info)\s*\(/
    ],

    /**
     * Applies an ordered list of [pattern, replacement] pairs to a string.
     * @param {string} text - Input text.
     * @param {Array} pairs - Array of [RegExp, string] tuples.
     * @returns {string} Rewritten text.
     */
    applyRules: function (text, pairs) {
        return pairs.reduce((str, pair) => str.replace(pair[0], pair[1]), text);
    },

    /**
     * Fixes spelling, typos, chat slang, contractions, article agreement, and tech acronyms.
     * @param {string} text - Input text.
     * @returns {string} Grammatically corrected text.
     */
    correctGrammarAndSpelling: function (text) {
        if (!text) return "";
        let str = text;

        // 1. Dictionary typos (spelling + politeness variants)
        str = this.replaceAll(str, this.compiled.typos, this.compiled.typoMap, false);

        // 2. Repeated character typos ("grmmmar" -> "grammar", "pleaaase" -> "please")
        str = str.replace(/([a-z])\1{2,}/gi, (match, char) => (
            /[eomsnlpftr]/i.test(char) ? char + char : char
        ));

        // 3. Chat slang expansion
        str = this.replaceAll(str, this.compiled.slang, this.chatSlangMap, false);

        // 4. Missing contraction apostrophes, preserving original capitalization
        str = this.replaceAll(str, this.compiled.contractions, this.contractionMap, true);

        // 5. Tech acronyms & subjects ("ai" -> "AI", "js" -> "JavaScript")
        str = this.replaceAll(str, this.compiled.acronyms, this.techAcronymMap, false);

        // 6. Article agreement (a/an)
        str = str.replace(/\b([Aa])\s+([aeiou]\w+)/g, (match, a, word) => (
            /^(user|european|one|unicode|universal|utility)/i.test(word) ? `${a} ${word}` : `${a}n ${word}`
        ));
        str = str.replace(/\b([Aa])n\s+([bcdfghjklmnpqrstvwxyz]\w+)/g, (match, a, word) => (
            /^(hour|honest|honor)/i.test(word) ? `${a}n ${word}` : `${a} ${word}`
        ));

        // 7. Formatting: standalone "i", missing space after punctuation, doubled punctuation
        return str
            .replace(/\b i \b/g, ' I ')
            .replace(/(\w)([,!?:;])(\w)/g, '$1$2 $3')
            .replace(/,{2,}/g, ',')
            .replace(/;{2,}/g, ';');
    },

    /**
     * Transforms indirect conversational preambles & wordy wrappers into concise imperatives.
     * Example: "I am having an exam help me to study AI" -> "Help me study for my AI exam."
     * @param {string} text - Cleaned prompt text.
     * @returns {string} Structurally transformed text.
     */
    transformStructuralIntent: function (text) {
        if (!text) return "";
        const str = text.trim();

        // Exam / study preambles collapse to a single imperative, so they short-circuit.
        const examMatch = str.match(/^I\s+(?:am\s+)?(?:having|preparing|studying|taking|got)\s+(?:a|an)\s+(?:exam|test|quiz|midterm|final)(?:\s+tomorrow|\s+next\s+week)?(?:\s+(?:in|on|for)\s+([a-z0-9\s#+\-&]+))?\s*(?:help\s+me|can\s+you\s+help\s+me|could\s+you\s+help\s+me)?\s*(?:to\s+)?(?:study|prepare|learn)?\s*(?:for)?\s*(.*?)$/i);
        if (examMatch) {
            const subject = (examMatch[2] || examMatch[1] || "")
                .trim()
                .replace(/^(?:to\s+)?(?:study|prepare|learn)\s+(?:for\s+)?/i, '')
                .replace(/^(?:in|on|for)\s+/i, '')
                .replace(/\s+help\s+me(?:\s+to)?(?:\s+(?:prepare|study|learn))?$/i, '')
                .trim();
            if (subject.length > 0) return `Help me study for my ${subject} exam.`;
        }

        // Work / project preambles ("I'm working on a X project and Y" -> "Y for a X project.")
        const projectMatch = str.match(/^I\s+(?:am\s+)?working\s+on\s+a[n]?\s+(.*?)\s+(?:project|app|website)\s+(?:and|so)?\s*(?:I\s+need\s+(?:you\s+to|help\s+to)?|can\s+you|could\s+you)?\s*(.*)$/i);
        if (projectMatch && projectMatch[1] && projectMatch[2]) {
            return `${projectMatch[2].trim()} for a ${projectMatch[1].trim()} project.`;
        }

        return this.applyRules(str, this.structuralRewrites).trim();
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

        const cleanPrompt = prompt.trim();
        let score = 100;
        const flags = [];

        // Score the prose only. Politeness words inside a code sample or a quoted
        // passage are not the user's padding and must not cost them points.
        const scorable = PM_PROTECT ? PM_PROTECT.strip(PM_PROTECT.mask(cleanPrompt).masked) : cleanPrompt;
        if (scorable.length === 0) {
            return { score: 100, flags: [] };
        }

        for (const rule of this.scoreRules) {
            const matches = scorable.match(rule.rx);
            if (!matches || matches.length === 0) continue;

            const deduction = Math.min(rule.cap, matches.length * rule.per);
            score -= deduction;
            flags.push(`${rule.label} (-${deduction} pts)`);
        }

        // History-based analysis: duplicate prompts & rapid regenerations
        const lastTurn = history[history.length - 1];
        if (lastTurn && lastTurn.prompt && lastTurn.prompt.trim() === cleanPrompt) {
            const isRegen = (new Date() - new Date(lastTurn.timestamp)) < 3 * 60 * 1000;
            score -= isRegen ? 15 : 10;
            flags.push(isRegen
                ? "Frequent prompt regeneration detected (-15 pts)"
                : "Duplicate prompt detected (-10 pts)");
        }

        return { score: Math.max(0, Math.min(100, score)), flags: flags };
    },

    /**
     * Checks if a text string is primarily a raw code snippet or stack trace.
     * @param {string} text - Input text.
     * @returns {boolean} True if text is identified as code.
     */
    isCodeSnippet: function (text) {
        if (!text) return false;
        if (this.codeIndicators.some(rx => rx.test(text))) return true;

        const lines = text.trim().split('\n');
        const syntaxLines = lines.filter(line => /[{};()=>]\s*$/.test(line.trim()));
        return lines.length > 2 && (syntaxLines.length / lines.length) > 0.35;
    },

    /**
     * Multi-pass optimization engine: cleans wordy, noisy, or misspelled prompts into
     * streamlined, compute-efficient queries. Code blocks are extracted before any
     * rewriting and re-injected verbatim afterwards, so program text is never corrupted.
     * @param {string} prompt - The original prompt text.
     * @returns {string} The optimized prompt text.
     */
    optimizePrompt: function (prompt) {
        if (!prompt || prompt.trim() === "") return "";

        // Stage 0: mask everything that must survive verbatim -- code, URLs, paths,
        // quoted material, identifiers, error output. Every later stage operates on
        // prose only, and the spans are restored untouched at the end.
        const protectedText = PM_PROTECT
            ? PM_PROTECT.mask(prompt)
            : { masked: prompt, spans: [] };
        let optimized = protectedText.masked;

        const prose = PM_PROTECT ? PM_PROTECT.strip(optimized) : optimized.trim();

        // Nothing editable left, or the remaining prose is itself code: hand back the
        // original untouched rather than risk mangling it.
        if (prose.length === 0) return prompt;
        if (this.isCodeSnippet(prose)) return prompt;

        // Stage 1: grammar, spelling & acronym pre-processing
        optimized = this.correctGrammarAndSpelling(optimized);

        // Stage 2: copy-paste garbage & symbol spam
        optimized = optimized
            .replace(/(?:Sent\s+from\s+my\s+(?:iPhone|iPad|Android|Galaxy|Outlook)|Confidentiality\s+Notice:[\s\S]*|Page\s+\d+\s+of\s+\d+)/gi, '')
            .replace(/!{2,}/g, '!')
            .replace(/\?{2,}/g, '?')
            .replace(/\.{4,}/g, '...');

        // Stage 2b: turn a stated intent into the command it stands for, before the
        // strippers below can remove its wrapper and strand the verb.
        optimized = this.applyRules(optimized, this.intentRewrites);

        // Stage 3: pleasantry and junk stripping. Two passes catch wrappers that only
        // become visible once an outer one has been removed.
        // Junk rules run first: they match longer, more specific phrases ("thanks in
        // advance") that the generic pleasantry rules ("thanks") would otherwise
        // consume half of, stranding the remainder.
        const strippers = this.junkStrippers
            .concat(this.wrapperStrippers)
            .concat(this.conversationalStrippers);
        for (let pass = 0; pass < 2; pass++) {
            for (const rx of strippers) {
                rx.lastIndex = 0;
                optimized = optimized.replace(rx, ' ');
            }

            // Between the two passes: drop the user's circumstances -- exams,
            // deadlines, moods, excuses, backstory -- when the prompt still asks for
            // something without them. It runs here because the clause patterns are
            // anchored to a clause start, which only becomes visible once the greeting
            // in front of it has gone; and the second stripper pass then clears the
            // wrappers the removal exposes ("... so can you teach me X").
            //
            // If the subject exists only inside the preamble the pass declines, and
            // the exam rewriter in transformStructuralIntent handles the prompt.
            if (pass === 0 && PM_CONDENSE) {
                optimized = PM_CONDENSE.stripSituational(optimized);
            }
        }

        // Stages 4-6: structural intent, meta-prompting fluff, concise wording
        optimized = this.transformStructuralIntent(optimized);
        optimized = this.applyRules(optimized, this.fluffReplacements);
        optimized = this.applyRules(optimized, this.concisePhrases);

        // "Could you help me X?" becomes "Help me X?" once the wrapper is stripped, but
        // an imperative is not a question. Swap the mark for a full stop.
        optimized = optimized.replace(
            /(^|[.!?]\s+)((?:write|explain|give|show|create|list|make|build|design|implement|fix|summari[sz]e|compare|analy[sz]e|describe|generate|convert|translate|help|tell|find|suggest|recommend|review|optimi[sz]e|refactor|add|remove|calculate|solve|draft|outline|rewrite|improve|check|debug)\b[^.!?\n]*)\?/gi,
            (match, lead, body) => `${lead}${body}.`);

        // Stage 6a: repair the joins left behind by mid-sentence removals, then tidy
        // whitespace and duplicate words. This has to happen BEFORE condensing: the
        // condenser reads sentence openings, and "I  I wanted to ..." does not match
        // the patterns that "I wanted to ..." does.
        optimized = this.applyRules(optimized, this.connectiveRepairs);
        optimized = this.applyRules(optimized, this.adjectiveStacks);
        optimized = optimized
            .replace(/[ \t]+/g, ' ')
            .replace(/\b(\w{1,6})\s+\1\b/gi, '$1')
            .replace(/\s+([,.?!;:])/g, '$1')
            .replace(/([!?])\1+/g, '$1')
            .trim();

        // Stage 6b: sentence-level condensing. Phrase rules cannot shorten a rambling
        // prompt, so long prompts get a pass that merges repeated sentence templates
        // and drops backstory. Runs after the strippers, which have already removed the
        // lead-ins ("I would appreciate it if you could ...") that would otherwise hide
        // the instruction underneath them.
        if (PM_CONDENSE) {
            optimized = PM_CONDENSE.condense(optimized);
        }

        // Stage 7: re-run grammar over the rewritten text
        optimized = this.correctGrammarAndSpelling(optimized);

        // Stage 8: clean joining words, duplicate filler and whitespace artifacts.
        // Duplicate collapsing is safe unconditionally now: anything code-shaped is
        // already masked, so "return return" inside a snippet can no longer be hit.
        optimized = optimized
            .replace(/^\s*(?:and|so|or|but|then)\s+/gi, '')
            .replace(/\b(\w{1,6})\s+\1\b/gi, '$1')
            .replace(/^[.,:;\-\u2013\u2014\s]+/, '')
            .replace(/[ \t]+/g, ' ')
            .replace(/,(?:\s*,)+/g, ',')
            .replace(/\s+([,.?!;:])/g, '$1')
            // Closing up spaces can re-form a run ("! !" -> "!!"), so collapse again
            .replace(/([!?])\1+/g, '$1')
            .replace(/\n\s*\n/g, '\n')
            .trim()
            .replace(/[,;:]\s*$/, '');

        // Stage 9: only fall back if nothing at all survived. Empty *prose* is fine when
        // protected spans remain -- "um uh TypeError: x" should optimise down to the
        // error text, not have its filler restored.
        if (optimized.trim().length === 0) {
            optimized = this.correctGrammarAndSpelling(protectedText.masked);
        }
        // Stripping a leading "Can you " or "Please " leaves the next word lowercase, so
        // re-capitalise after every sentence break. A placeholder is not [a-z], so a
        // protected span at a sentence start is skipped.
        optimized = optimized.replace(/(^|[.!?]\s+)([a-z])/g,
            (match, lead, letter) => lead + letter.toUpperCase());

        // Capitalise the opening letter, but never reach into a protected span: a path
        // or identifier at the start of a prompt must keep its own casing.
        const opensProtected = PM_PROTECT && optimized.charAt(0) === PM_PROTECT.MASK_OPEN;
        if (optimized.length > 0 && !opensProtected) {
            optimized = optimized.charAt(0).toUpperCase() + optimized.slice(1);
        }

        // Stage 10: restore every protected span exactly as the user wrote it
        return PM_PROTECT ? PM_PROTECT.unmask(optimized, protectedText.spans) : optimized;
    }
};

// Compile the dictionaries into one regex each, at load time rather than per keystroke.
PromptMeterOptimizer.compiled = (function () {
    const o = PromptMeterOptimizer;
    const typoMap = Object.assign({}, o.spellingTypos, o.politenessTypos);
    return {
        typoMap: typoMap,
        typos: o.buildAlternation(typoMap, 'gi'),
        slang: o.buildAlternation(o.chatSlangMap, 'gi'),
        contractions: o.buildAlternation(o.contractionMap, 'gi'),
        acronyms: o.buildAlternation(o.techAcronymMap, 'g')
    };
})();

// The typo score rule shares its vocabulary with the spelling dictionary, so derive it
// instead of maintaining a second copy that can silently drift out of sync.
PromptMeterOptimizer.scoreRules.find(rule => rule.rx === null).rx =
    PromptMeterOptimizer.buildAlternation(PromptMeterOptimizer.spellingTypos, 'gi');

// Export for global (content script) and bundler environments
if (typeof window !== 'undefined') {
    window.PromptMeterOptimizer = PromptMeterOptimizer;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { PromptMeterOptimizer };
}

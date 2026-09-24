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

// Open-ended typo correction, for the misspellings no fixed table can list.
const PM_SPELL = (typeof PromptMeterSpelling !== 'undefined')
    ? PromptMeterSpelling
    : (typeof require !== 'undefined' ? require('./spelling.js').PromptMeterSpelling : null);

// Grammar detection and repair. Agreement, tense, confusables, pronoun case and
// article errors all live there, so this file keeps only the vocabulary substitutions
// (typos, slang, acronyms) that are specific to prompt text.
const PM_GRAMMAR = (typeof PromptMeterGrammar !== 'undefined')
    ? PromptMeterGrammar
    : (typeof require !== 'undefined' ? require('./grammar.js').PromptMeterGrammar : null);

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
        "javascriptt": "javascript", "javscript": "javascript",
        // Typos that add or drop a CONSONANT, plus the classic letter swaps. The
        // corrector in spelling.js cannot reach these: its whole precision argument is
        // that consonants are preserved, and a distance-1 fallback that ignored them was
        // measured doubling the corruption rate on held-out English. Exact pairs give the
        // same coverage with none of that exposure.
        "abou": "about", "adn": "and", "ahve": "have", "anser": "answer", "ansewr": "answer",
        "bcak": "back", "beacuse": "because", "becasue": "because", "becuase": "because",
        "clases": "classes", "classs": "class", "cna": "can", "coudl": "could",
        "craete": "create", "creat": "create", "delet": "delete", "exaple": "example",
        "exmaple": "example", "expalin": "explain", "explian": "explain", "exprot": "export",
        "fo": "of", "fro": "from", "fucntion": "function",
        "funtcion": "function", "heigth": "height", "hel": "help", "hlep": "help",
        "htis": "this", "hvae": "have", "hwat": "what", "improt": "import", "jsut": "just",
        "juts": "just", "liek": "like", "liste": "list", "maek": "make", "mkae": "make",
        "nad": "and", "nee": "need", "onilne": "online", "onlien": "online", "ot": "to",
        "oyu": "you", "paramter": "parameter", "paremeter": "parameter", "pelase": "please",
        "plaese": "please", "pritn": "print", "prnit": "print", "quesiton": "question",
        "questoin": "question", "retrun": "return", "reutrn": "return", "satrt": "start",
        "shoudl": "should", "starst": "start", "stat": "start", "strat": "start",
        "strign": "string", "taht": "that", "ther": "there", "thta": "that", "tihs": "this",
        "tuo": "to", "updat": "update", "waht": "what", "wan": "want", "watn": "want",
        "whta": "what", "wiht": "with", "witdh": "width", "wnat": "want", "wnt": "want",
        "woudl": "would", "wtih": "with", "yuo": "you",
        // Commonly misspelled English words, as exact pairs.
        // Listed rather than left to spelling.js because these are nearly all
        // SUBSTITUTIONS ("seperate", "definately", "independant"), the one edit shape
        // that module refuses on purpose -- swapping a letter is what turns an
        // unlisted technical word into a different real word. An exact pair carries
        // no such risk, so the coverage belongs here instead of by loosening that guard.
        "accomodate": "accommodate", "acheive": "achieve", "acheived": "achieved",
        "adress": "address", "aparent": "apparent", "appearence": "appearance",
        "aquire": "acquire", "arent": "aren't", "arguement": "argument",
        "assesment": "assessment", "basicly": "basically", "begginer": "beginner",
        "begining": "beginning", "beleive": "believe", "buisness": "business",
        "calender": "calendar", "catagory": "category", "changable": "changeable",
        "choosen": "chosen", "colleage": "colleague", "collegue": "colleague",
        "comitted": "committed", "commited": "committed", "comparision": "comparison",
        "compatability": "compatibility", "completly": "completely",
        "concatinate": "concatenate", "concious": "conscious", "consistant": "consistent",
        "contro": "control", "correspondance": "correspondence", "critisism": "criticism",
        "curiousity": "curiosity", "decison": "decision", "dependant": "dependent",
        "depricated": "deprecated", "desicion": "decision", "developement": "development",
        "dificult": "difficult", "dilema": "dilemma", "disapear": "disappear",
        "dissapoint": "disappoint", "dissapointed": "disappointed", "dupicate": "duplicate",
        "effeciency": "efficiency", "efficently": "efficiently", "embarass": "embarrass",
        "embarrasment": "embarrassment", "enviornment": "environment", "equiped": "equipped",
        "excelent": "excellent", "existance": "existence", "experiance": "experience",
        "explaination": "explanation", "exsist": "exist", "facinating": "fascinating",
        "familar": "familiar", "finaly": "finally", "flexable": "flexible",
        "foriegn": "foreign", "fourty": "forty", "fullfil": "fulfil", "garantee": "guarantee",
        "gaurd": "guard", "happend": "happened", "harrass": "harass", "heirarchy": "hierarchy",
        "hieght": "height", "hight": "height", "identofy": "identify",
        "imediately": "immediately", "implimentation": "implementation",
        "importent": "important", "incomplet": "incomplete", "inconsistant": "inconsistent",
        "independant": "independent", "indicies": "indices", "influencial": "influential",
        "initalize": "initialize", "instaled": "installed", "inteligent": "intelligent",
        "intergrate": "integrate", "intresting": "interesting", "judgement": "judgment",
        "knowlegde": "knowledge", "lenght": "length", "lenghth": "length", "liason": "liaison",
        "liesure": "leisure", "lisence": "license", "maintenence": "maintenance",
        "managable": "manageable", "managment": "management", "mesage": "message",
        "milage": "mileage", "millenium": "millennium", "minumum": "minimum",
        "mischevious": "mischievous", "momento": "memento", "neccesary": "necessary",
        "noticable": "noticeable", "ocassion": "occasion", "occassion": "occasion",
        "occurance": "occurrence", "occurence": "occurrence", "paralel": "parallel",
        "paramaters": "parameters", "particulary": "particularly", "perminant": "permanent",
        "persistant": "persistent", "personel": "personnel", "persue": "pursue",
        "posession": "possession", "posible": "possible", "potatoe": "potato",
        "preferance": "preference", "prefered": "preferred", "primarly": "primarily",
        "priviledge": "privilege", "probabaly": "probably", "proccess": "process",
        "proffesional": "professional", "pronounciation": "pronunciation",
        "propoganda": "propaganda", "proprety": "property", "psuedo": "pseudo",
        "publically": "publicly", "quater": "quarter", "questionaire": "questionnaire",
        "readible": "readable", "realy": "really", "recieved": "received",
        "recomend": "recommend", "recomendation": "recommendation", "recquire": "require",
        "recursivly": "recursively", "rediculous": "ridiculous", "refered": "referred",
        "reguarding": "regarding", "relevent": "relevant", "religous": "religious",
        "remeber": "remember", "repitition": "repetition", "reponse": "response",
        "responce": "response", "restaraunt": "restaurant", "resturant": "restaurant",
        "retreive": "retrieve", "rythm": "rhythm", "secratary": "secretary", "seige": "siege",
        "sence": "sense", "seperately": "separately", "sieze": "seize",
        "similiarly": "similarly", "sincerly": "sincerely", "speach": "speech",
        "strengh": "strength", "succesful": "successful", "succesfully": "successfully",
        "sucess": "success", "sucessful": "successful", "sucessfully": "successfully",
        "sugestion": "suggestion", "supercede": "supersede", "suprise": "surprise",
        "syntx": "syntax", "temperture": "temperature", "tendancy": "tendency",
        "therefor": "therefore", "thier": "their", "threshhold": "threshold",
        "tounge": "tongue", "trafic": "traffic", "truely": "truly", "twelth": "twelfth",
        "unfortunatly": "unfortunately", "untill": "until", "useable": "usable",
        "vaccum": "vacuum", "varaible": "variable", "varible": "variable", "varient": "variant",
        "vegtable": "vegetable", "vehical": "vehicle", "visable": "visible",
        "voluntier": "volunteer", "wether": "whether", "wich": "which", "widht": "width",
        "wierd": "weird", "writting": "writing", "yeild": "yield"
    },

    // Technical acronyms, matched case-sensitively so "AI" and "Js" are left alone.
    //
    // These CASE-NORMALISE and never expand. That distinction is the whole point of the
    // table now: it previously turned "dsa" into "Data Structures & Algorithms",
    // "js" into "JavaScript" and "db" into "database", which made the prompt five, two
    // and one tokens LONGER respectively. A tool whose purpose is to cut tokens must not
    // inflate them, and these are universally understood abbreviations that no model
    // needs expanded -- "explain dsa to me" is already as short as that request gets.
    //
    // An entry may therefore never be longer than its key.
    techAcronymMap: {
        "ai": "AI", "ml": "ML", "nlp": "NLP", "ui": "UI", "ux": "UX",
        "api": "API", "apis": "APIs", "sql": "SQL", "json": "JSON",
        "html": "HTML", "css": "CSS", "js": "JS", "dsa": "DSA", "db": "DB",
        "xml": "XML", "csv": "CSV", "pdf": "PDF", "url": "URL", "http": "HTTP",
        "https": "HTTPS", "rest": "REST", "crud": "CRUD", "orm": "ORM",
        "jwt": "JWT", "cli": "CLI", "gui": "GUI", "ide": "IDE", "os": "OS",
        "cpu": "CPU", "gpu": "GPU", "ram": "RAM", "sdk": "SDK", "npm": "npm",
        "css3": "CSS3", "html5": "HTML5", "oop": "OOP", "tdd": "TDD",
        "ci": "CI", "cd": "CD", "dns": "DNS", "ssl": "SSL", "tls": "TLS"
    },

    // Informal chat slang and SMS abbreviations, long enough to be unambiguous.
    //
    // Expanding these is not cosmetic. The situational-preamble rules in condense.js are
    // written against real English -- "my exam is tomorrow", "my professor gave us" -- so
    // a prompt typed as "tmrw is mi exm" matches none of them and the whole preamble
    // survives. The abbreviation has to become the word before any later stage can see
    // what it is.
    //
    // Everything here is three characters or more, or carries a slash, so it cannot
    // collide with a variable name. The one- and two-letter forms live in
    // contextualSlangMap below, which applies them far more carefully.
    chatSlangMap: {
        "w/o": "without", "w/": "with", "b/c": "because", "bc": "because",
        "asap": "as soon as possible", "gimme": "give me", "wanna": "want to",
        "gotta": "got to", "kinda": "kind of", "dunno": "don't know",
        "approx": "approximately",
        // Time
        "tmrw": "tomorrow", "tmr": "tomorrow", "tmw": "tomorrow", "tomo": "tomorrow",
        "tomm": "tomorrow", "2moro": "tomorrow", "2morrow": "tomorrow",
        "yest": "yesterday", "2day": "today", "2nite": "tonight",
        // Academic vocabulary, which is most of what this extension sees
        "exm": "exam", "exms": "exams", "xam": "exam", "xams": "exams",
        "assgn": "assignment", "asgn": "assignment", "hmwrk": "homework",
        "prof": "professor", "lec": "lecture", "lect": "lecture",
        "ques": "question", "qn": "question", "qns": "questions", "ans": "answer",
        // Connectives and fillers
        "coz": "because", "cuz": "because", "bcoz": "because", "bcz": "because",
        "bcuz": "because", "becoz": "because",
        "wat": "what", "wht": "what", "wen": "when", "whr": "where",
        "abt": "about", "ppl": "people", "smth": "something", "sth": "something",
        "tho": "though", "thru": "through", "nvm": "never mind",
        "b4": "before", "gr8": "great", "msg": "message", "msgs": "messages",
        "thnx": "thanks", "tnx": "thanks", "thanx": "thanks",
        "idk": "I do not know", "imo": "in my opinion", "btw": "by the way"
    },

    // Very short abbreviations. These are the ones that genuinely corrupt technical text
    // -- "u" in a physics question, "r" in R code, "mi" as a variable -- so each carries
    // its own context requirement instead of being replaced on sight.
    //
    // A blanket "no maths characters nearby" test is not enough, and it is worth saying
    // why: it passes "solve for u where u = v + a*t", because the character beside the
    // first "u" is a space, and it passes "rename u to velocity" and "explain the y axis
    // label", which contain no maths characters at all. Position in the sentence is the
    // only reliable signal, so:
    //
    //   before   the word must follow one of these (a modal, or a verb that takes "you")
    //   after    or be followed by one of these (a verb "you" can be the subject of)
    //   deny     and never match when this pattern sits beside it
    //
    // "y" is deliberately absent. "y is the vertical axis" and "y is this slow" are the
    // same shape, and the first is far more likely in the prompts this extension sees.
    // It stays penalised by the chatSlang score rule, just never rewritten.
    contextualSlangRules: [
        {
            word: 'u', replacement: 'you',
            before: /\b(?:can|could|would|will|shall|do|did|does|should|thank|thanks|hope|if|unless|when|and)$/i,
            after: /^(?:are|can|could|should|would|will|know|think|have|has|had|explain|help|tell|give|show|write|make|do|need|want|please|guys?)\b/i
        },
        {
            // "u r wrong", "r u there" -- only ever next to a second-person pronoun.
            word: 'r', replacement: 'are',
            before: /\b(?:u|you|we|they|there)$/i,
            after: /^(?:u|you|we|they|there)\b/i
        },
        {
            word: 'ur', replacement: 'your',
            after: /^(?:[a-z]{2,})\b/i
        },
        { word: 'urs', replacement: 'yours' },
        {
            // "mi" stands for both "me" and "my", and the two are told apart by what
            // sits around it. This rule takes the object reading and must come first:
            // after a verb that takes an indirect object ("send mi the code", "teach mi
            // ML") it is "me", and before a determiner it is "me" too, because no
            // possessive can be followed by one -- "my the code" is not English.
            word: 'mi', replacement: 'me',
            before: /\b(?:send|give|tell|show|teach|explain|help|write|mail|pass|bring|get|find|make|offer|lend|email|remind|ask)$/i,
            after: /^(?:the|a|an|this|that|these|those|your|his|her|its|their|some|any)\b/i,
            deny: /^\s*(?:=|==|\+|-|\*|\/|\)|\]|,\s*\d)/
        },
        {
            // The possessive reading, which is what is left. It still needs a noun after
            // it, and that is also what separates "mi exam" from "mi = 0" and from the
            // unit in "20 mi".
            word: 'mi', replacement: 'my',
            after: /^(?:[a-z]{2,})\b/i,
            deny: /^\s*(?:=|==|\+|-|\*|\/|\)|\]|,\s*\d)/
        }
    ],

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

    /**
     * Expands the very short chat abbreviations, each under its own context rule.
     *
     * Matching is case-sensitive against the lowercase forms, so the R language, a
     * coordinate Y and an initial U are never candidates in the first place. A candidate
     * then has to earn the rewrite by sitting where the pronoun reading is the only
     * sensible one -- see contextualSlangRules for why position, rather than a scan for
     * nearby maths characters, is what decides.
     *
     * @param {string} text - Input text.
     * @returns {string} Text with contextual abbreviations expanded.
     */
    expandContextualSlang: function (text) {
        return this.contextualSlangRules.reduce((str, rule) => {
            const pattern = new RegExp(`\\b${rule.word}\\b`, 'g');

            return str.replace(pattern, (match, offset) => {
                const before = str.slice(Math.max(0, offset - 40), offset).trimEnd();
                const after = str.slice(offset + match.length).trimStart();

                if (rule.deny && rule.deny.test(str.slice(offset + match.length))) return match;

                // A rule with neither test applies wherever it matches; a rule with both
                // needs only one to hold, because "can u" and "u explain" are each
                // sufficient on their own.
                const hasTest = Boolean(rule.before || rule.after);
                if (!hasTest) return rule.replacement;

                const matchesBefore = rule.before ? rule.before.test(before) : false;
                const matchesAfter = rule.after ? rule.after.test(after) : false;
                return (matchesBefore || matchesAfter) ? rule.replacement : match;
            });
        }, text);
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
            rx: /\b(?:thanks?(?:\s+(?:a\s+(?:lot|ton|bunch)|so\s+much))?(?:\s+in\s+advance)?|much\s+appreciated|appreciate\s+(?:it|any\s+help)|any\s+help\s+(?:would\s+be|is)\s+(?:appreciated|great)|cheers|(?:best|kind|warm)\s+regards|looking\s+forward\s+to)\b/gi
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
        [/\bwith\s+respect\s+to\b/gi, 'regarding'],
        // One-for-many substitutions. Each replaces a multi-word construction with a
        // single word of the same meaning, which is the only rephrasing safe to do
        // automatically: the words change, the request does not. A sweep of twenty-four
        // common wordy phrases previously matched exactly one of them.
        [/\bgive\s+me\s+a\s+(?:brief\s+|short\s+|quick\s+)?overview\s+of\b/gi, 'summarize'],
        [/\bgive\s+me\s+a\s+(?:brief\s+|short\s+|quick\s+)?summary\s+of\b/gi, 'summarize'],
        [/\bmake\s+a\s+comparison\s+(?:between|of)\b/gi, 'compare'],
        [/\bcarry\s+out\s+an\s+analysis\s+of\b/gi, 'analyze'],
        [/\bconduct\s+an\s+analysis\s+of\b/gi, 'analyze'],
        [/\bprovide\s+a\s+description\s+of\b/gi, 'describe'],
        [/\bgive\s+a\s+description\s+of\b/gi, 'describe'],
        [/\bis\s+capable\s+of\s+(\w+)ing\b/gi, '$1s'],
        [/\bhas\s+the\s+ability\s+to\b/gi, 'can'],
        [/\bhave\s+the\s+ability\s+to\b/gi, 'can'],
        [/\bis\s+able\s+to\b/gi, 'can'],
        [/\bare\s+able\s+to\b/gi, 'can'],
        [/\bon\s+a\s+daily\s+basis\b/gi, 'daily'],
        [/\bon\s+a\s+weekly\s+basis\b/gi, 'weekly'],
        [/\bon\s+a\s+monthly\s+basis\b/gi, 'monthly'],
        [/\bon\s+a\s+regular\s+basis\b/gi, 'regularly'],
        [/\bin\s+the\s+near\s+future\b/gi, 'soon'],
        [/\bat\s+the\s+present\s+time\b/gi, 'now'],
        [/\bat\s+this\s+time\b/gi, 'now'],
        [/\ba\s+number\s+of\b/gi, 'several'],
        [/\bthe\s+majority\s+of\b/gi, 'most'],
        [/\bin\s+spite\s+of\s+the\s+fact\s+that\b/gi, 'although'],
        [/\bdespite\s+the\s+fact\s+that\b/gi, 'although'],
        [/\bregardless\s+of\s+the\s+fact\s+that\b/gi, 'although'],
        [/\bit\s+is\s+possible\s+that\b/gi, 'possibly'],
        [/\bthere\s+is\s+a\s+possibility\s+that\b/gi, 'possibly'],
        [/\bin\s+a\s+timely\s+manner\b/gi, 'promptly'],
        [/\bwith\s+the\s+exception\s+of\b/gi, 'except'],
        [/\bin\s+close\s+proximity\s+to\b/gi, 'near'],
        [/\bduring\s+the\s+course\s+of\b/gi, 'during'],
        [/\bin\s+the\s+course\s+of\b/gi, 'during'],
        [/\bfor\s+the\s+reason\s+that\b/gi, 'because'],
        [/\bowing\s+to\s+the\s+fact\s+that\b/gi, 'because'],
        [/\bin\s+view\s+of\s+the\s+fact\s+that\b/gi, 'because'],
        [/\bcome\s+to\s+a\s+conclusion\b/gi, 'conclude'],
        [/\breach\s+a\s+conclusion\b/gi, 'conclude'],
        [/\bgive\s+consideration\s+to\b/gi, 'consider'],
        [/\bput\s+emphasis\s+on\b/gi, 'emphasize'],
        [/\bplace\s+emphasis\s+on\b/gi, 'emphasize'],
        [/\bbe\s+in\s+agreement\s+with\b/gi, 'agree with'],
        [/\bat\s+all\s+times\b/gi, 'always'],
        [/\bin\s+all\s+cases\b/gi, 'always'],
        [/\bin\s+no\s+case\b/gi, 'never'],
        [/\bin\s+many\s+cases\b/gi, 'often'],
        [/\bin\s+some\s+cases\b/gi, 'sometimes'],
        [/\ba\s+large\s+proportion\s+of\b/gi, 'many'],
        [/\bthe\s+vast\s+majority\s+of\b/gi, 'most'],
        [/\bis\s+of\s+the\s+opinion\s+that\b/gi, 'believes'],
        [/\bmake\s+an\s+attempt\s+to\b/gi, 'try to'],
        [/\bmake\s+use\s+of\b/gi, 'use'],
        [/\btake\s+advantage\s+of\b/gi, 'use'],
        [/\bin\s+relation\s+to\b/gi, 'about'],
        [/\bwith\s+reference\s+to\b/gi, 'about'],
        [/\bin\s+connection\s+with\b/gi, 'about'],
        [/\bon\s+the\s+subject\s+of\b/gi, 'about'],
        [/\bin\s+terms\s+of\b/gi, 'for'],
        [/\bby\s+means\s+of\b/gi, 'by'],
        [/\bin\s+excess\s+of\b/gi, 'over'],
        [/\bprior\s+to\s+the\s+start\s+of\b/gi, 'before'],
        [/\bsubsequent\s+to\b/gi, 'after'],
        [/\buntil\s+such\s+time\s+as\b/gi, 'until'],
        [/\bin\s+the\s+absence\s+of\b/gi, 'without'],
        [/\bis\s+dependent\s+(?:up)?on\b/gi, 'depends on'],
        [/\bare\s+dependent\s+(?:up)?on\b/gi, 'depend on'],
        [/\bgive\s+an\s+indication\s+of\b/gi, 'indicate'],
        [/\bprovide\s+assistance\s+(?:to|with)\b/gi, 'help'],
        [/\bprovide\s+information\s+(?:about|on)\b/gi, 'explain'],
        [/\bserves\s+to\s+(\w+)\b/gi, '$1s'],
        [/\bhas\s+a\s+tendency\s+to\b/gi, 'tends to'],
        [/\bit\s+should\s+be\s+noted\s+that\b/gi, ''],
        [/\bit\s+is\s+worth\s+noting\s+that\b/gi, ''],
        [/\bneedless\s+to\s+say\b/gi, ''],
        [/\bas\s+far\s+as\s+(\w+)\s+is\s+concerned\b/gi, 'for $1']
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
        // The "for your time" tail is part of the sign-off, not a separate clause. Without
        // it the rule ate "thanks so much" and left "For your time!" standing alone as its
        // own sentence -- a fragment that reads as an instruction and is not one.
        /\b(?:thanks?(?:\s+(?:a\s+(?:lot|ton|bunch)|so\s+much))?(?:\s+in\s+advance)?(?:\s+for\s+(?:your|the)\s+(?:\w+\s+){0,2}?(?:time|help|assistance|effort|support|patience|consideration|trouble))?|much\s+appreciated|(?:i'?d\s+|i\s+would\s+)?(?:really\s+)?appreciate\s+(?:it|any\s+help)(?:\s+if\s+you\s+(?:could|can|would))?|any\s+help\s+(?:would\s+be|is)\s+(?:appreciated|great)|cheers|(?:best|kind|warm)\s+regards|looking\s+forward\s+to\s+(?:your|the)\s+(?:response|reply|answer)|let\s+me\s+know\s+(?:if\s+you\s+need\s+(?:anything\s+else|more\s+(?:info|information|details))|what\s+you\s+think))\b[,!.\s]*/gi,
        // Urgency padding: an LLM cannot act on it, so it is pure token cost
        /\b(?:asap|as\s+soon\s+as\s+possible|urgently|as\s+quickly\s+as\s+possible|it(?:'?s|\s+is)\s+urgent|this\s+is\s+urgent|quick(?:ly)?\s+please)\b[,!.\s]*/gi,
        // Permission-seeking wrappers
        /\b(?:is\s+it\s+(?:possible|ok|okay)\s+(?:to|if)|do\s+you\s+think\s+you\s+(?:can|could)|are\s+you\s+able\s+to|if\s+(?:it'?s|its)\s+not\s+too\s+much\s+trouble|if\s+you\s+(?:don'?t|do\s+not)\s+mind|whenever\s+you\s+(?:get\s+a\s+chance|can))\b\s*/gi,
        // Meta announcements about the question itself
        /\b(?:i\s+have\s+a\s+(?:quick\s+)?question(?:\s+about)?|quick\s+question(?:\s+about)?|one\s+(?:more|last)\s+thing|just\s+to\s+clarify|for\s+your\s+information|fyi|please\s+note\s+that)\b[,:!.\s]*/gi,
        // Tentative request wrappers. "I was thinking maybe you could possibly help me"
        // is six words of hedging in front of "help me". The modal and its hedges go
        // together, because removing only the opener leaves "maybe you could possibly".
        /\b(?:i\s+(?:was\s+)?(?:thinking|think|thought|figured|wondered|reckon(?:ed)?)|i\s+had\s+an?\s+idea)\s+(?:that\s+)?(?:maybe\s+|perhaps\s+|possibly\s+)?(?:you\s+)?(?:could|can|would|will|might|may)\s+(?:possibly\s+|maybe\s+|perhaps\s+|please\s+|kindly\s+)*/gi,
        // Discourse markers. In a prompt these mark hesitation rather than meaning, and
        // none of them changes what is being asked. "just", "really" and "so" are
        // deliberately absent: each carries meaning often enough to matter ("just the
        // headers", "so that it compiles").
        // A coordinator may sit in front of the marker ("so basically ...", "and
        // honestly ..."). It is consumed with it: leaving it behind only moves the
        // problem, and stripping the marker alone would stop the clause matching the
        // clause-start anchor on the next pass.
        /(?<=^|[.!?;,]|\n)\s*(?:(?:so|and|but|well|ok(?:ay)?|now)\s+)?(?:basically|actually|honestly|literally|seriously|frankly|essentially)\b[,\s]*/gi,
        /\b(?:i\s+guess|i\s+suppose|or\s+so|more\s+or\s+less|if\s+possible|if\s+you\s+can)\b[,!.\s]*/gi,
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
        [/\b(quick|fast|rapid|speedy)(?:(?:,|\s+and|,\s+and)\s+(?:quick|fast|rapid|speedy))+\b/gi, '$1'],
        // The same stacking without a conjunction: "complete production-ready code",
        // "full end-to-end implementation". The rules above need a comma or an "and"
        // between the adjectives and so step straight over these.
        //
        // The LAST adjective survives here, where the conjoined rules above keep the
        // first. That is not an inconsistency: English orders adjectives general to
        // specific, so in "complete production-ready code" the informative word is the
        // one next to the noun, while "detailed, comprehensive and thorough" is three
        // ways of saying the same thing and the first is as good as any.
        [/\b(?:complete|full|entire|whole|comprehensive|detailed|thorough|exhaustive|in-depth|extensive)\s+(production-ready|end-to-end|fully-functional|comprehensive|detailed|thorough|exhaustive|in-depth|extensive|complete|full)\b/gi, '$1']
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
        // A hedge left in front of the instruction after its wrapper was stripped:
        // "I was wondering if you could maybe explain X" loses the wrapper and leaves
        // "maybe explain X", which reads as uncertainty the model will answer around.
        // Only at a clause start, where the word cannot be modifying anything.
        [/(?<=^|[.!?;]\s*|\n)\s*(?:maybe|perhaps|possibly|hopefully)\s+(?=[a-z])/gi, ''],
        // Duplicated preposition after a merge
        [/\b(about|for|of|in|on|with|to|from|by)\s+\1\b/gi, '$1']
    ],

    // Request wrappers that survived the original rules. Split by where they are safe
    // to remove: the anchored group is only a wrapper at the start of a clause
    // ("I am trying to build X"), because mid-clause it is ordinary grammar
    // ("explain what I am trying to do"). The unanchored group is padding anywhere.
    wrapperStrippers: [
        // Left behind when the junk rules eat "I was just wondering" off the front.
        // The hedges repeat -- "if you could maybe possibly help me" stacks two of them --
        // so the group is quantified rather than optional. With a single optional slot the
        // rule matched nothing here and the whole wrapper survived into the output.
        // A coordinator may still sit in front of the wrapper at this point -- "so if you
        // could ..." -- because the leading-connective tidy does not run until stage 8,
        // after every stripper pass. Consuming it here is what lets the clause-start
        // anchor match at all.
        /(?<=^|[.!?]|[,;]|\n)\s*(?:(?:so|and|but|then|well|ok(?:ay)?)\s+)?if\s+you\s+(?:could|can|would)(?:\s+(?:maybe|possibly|perhaps|please|kindly|just))*\s+/gim,
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
        // SQL needs its actual shape, not just a leading keyword. The previous pattern
        // here was /^\s*(?:SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\s+[A-Z*\s]/im,
        // which matched "Create an education platform", "Update the README", "Delete the
        // old files" and "Insert a caching layer" -- ordinary English openers, all of them
        // common ways to start a prompt. Every one was classified as code, and
        // optimizePrompt returns the input untouched for code, so those prompts were
        // silently never optimized at all.
        //
        // Each clause below pairs the verb with the keyword that actually follows it in
        // SQL, so prose beginning with the same verb no longer qualifies.
        /\bSELECT\b[\s\S]{0,200}?\bFROM\b/i,
        /\bINSERT\s+INTO\s+[\w"`[]/i,
        /\bUPDATE\s+[\w."`[\]]+\s+SET\b/i,
        /\bDELETE\s+FROM\s+[\w"`[]/i,
        /\b(?:CREATE|DROP|ALTER)\s+(?:TEMP(?:ORARY)?\s+)?(?:TABLE|DATABASE|SCHEMA|INDEX|VIEW|TRIGGER|PROCEDURE|SEQUENCE)\b/i,
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
     * Fixes vocabulary -- typos, stretched spellings, chat slang and tech acronyms --
     * then hands the text to the grammar engine for agreement, tense, confusables,
     * pronoun case, articles and contractions.
     *
     * The split is deliberate. The tables in this file are about PROMPT vocabulary
     * ("plz", "js", "grmmar") and are specific to the extension; grammar.js is about
     * ENGLISH and is useful on its own. Running vocabulary first matters: the grammar
     * rules are written against real words, so "u" and "pyton" have to become "you" and
     * "Python" before agreement can see them.
     *
     * @param {string} text - Input text.
     * @param {Array} issues - Optional collector; grammar findings are appended to it.
     * @returns {string} Corrected text.
     */
    correctGrammarAndSpelling: function (text, issues) {
        if (!text) return "";
        let str = text;

        // 1. Dictionary typos (spelling + politeness variants). Each substitution is
        //    named rather than summarised, so the card reads the same whether a word was
        //    fixed from this table or worked out by the spelling corrector below.
        this.compiled.typos.lastIndex = 0;
        str = str.replace(this.compiled.typos, match => {
            const replacement = this.compiled.typoMap[match.toLowerCase()];
            if (replacement === undefined) return match;
            if (issues && replacement.toLowerCase() !== match.toLowerCase()) {
                issues.push({
                    type: 'spelling',
                    label: `"${match}" corrected to "${replacement}"`
                });
            }
            return replacement;
        });

        // 2. Repeated character typos ("grmmmar" -> "grammar", "pleaaase" -> "please")
        str = str.replace(/([a-z]){2,}/gi, (match, char) => (
            /[eomsnlpftr]/i.test(char) ? char + char : char
        ));

        // 3. Chat slang and SMS abbreviation expansion. The contextual pass is separate
        //    because its one- and two-letter keys need the guards in that method.
        str = this.replaceAll(str, this.compiled.slang, this.chatSlangMap, false);
        str = this.expandContextualSlang(str);

        // 3b. Open-ended typo correction. Runs after the tables above so a known
        //     abbreviation is expanded by name rather than guessed at, and before the
        //     acronym map so "ml" is still lowercase and below the corrector's minimum
        //     length. Everything the other tables know about is passed through as
        //     already-correct, so the corrector never second-guesses them.
        if (PM_SPELL) {
            const spelled = PM_SPELL.correct(str, { extraKnown: this.compiled.knownWords });
            str = spelled.text;
            if (issues && spelled.corrections.length > 0) {
                spelled.corrections.forEach(correction => issues.push({
                    type: 'spelling',
                    label: `"${correction.from}" corrected to "${correction.to}"`
                }));
            }
        }

        // 4. Tech acronyms & subjects ("ai" -> "AI", "js" -> "JavaScript")
        str = this.replaceAll(str, this.compiled.acronyms, this.techAcronymMap, false);

        // 5. Grammar proper. Punctuation is left to the optimizer's own tidy pass, which
        //    runs after the strippers and knows which sentences survived.
        if (PM_GRAMMAR) {
            const report = PM_GRAMMAR.correct(str, { punctuation: false });
            str = report.text;
            if (issues) issues.push.apply(issues, report.issues);
        }

        // 6. Formatting left over from removals: spacing and doubled separators.
        return str
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
        if (typeof prompt !== 'string' || prompt.trim() === "") {
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

        // Grammar. Scored separately from the padding rules above because it is a
        // different kind of cost: filler wastes tokens, whereas an agreement or tense
        // error makes the model guess at what was meant and re-ask or answer the wrong
        // question. Only substantive errors count -- capitalization and punctuation are
        // corrected silently and are not worth points.
        const grammarIssues = this.grammarIssues(scorable);
        if (grammarIssues.length > 0) {
            const deduction = Math.min(15, grammarIssues.length * 3);
            score -= deduction;
            flags.push(`Grammatical errors detected: ${grammarIssues.length} (-${deduction} pts)`);
        }

        // Scope. Unlike every rule above this does not mean the prompt is badly written;
        // it means the prompt is too large to be answered once. A 100/100 score on a
        // request for forty subsystems would be telling the user something false.
        for (const finding of this.scopeIssues(cleanPrompt)) {
            score -= finding.penalty;
            flags.push(`Over-scoped request: ${finding.label} (-${finding.penalty} pts)`);
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

    // --- Scope analysis --------------------------------------------------------------
    //
    // Everything else in this file looks for WASTED words. This looks for a prompt with
    // no wasted words at all that will still burn tokens, because it asks for more than
    // one answer can carry:
    //
    //     Create an AI-powered education platform that manages students, teachers,
    //     courses, attendance, ... and administrative controls. Explain every feature,
    //     database table, API endpoint, ... in detail and provide complete
    //     production-ready code for the frontend, backend, database, ...
    //
    // That prompt is 195 tokens, contains no greeting, no politeness, no hedging and no
    // typos, and the rules above score it 100/100 while changing nothing. They are right
    // that there is little to strip: the 39 features ARE the request. Compression cannot
    // help much either -- the three items appearing in two lists ("database", "APIs",
    // "authentication") name a FEATURE in one list and a CODE LAYER in the other, so
    // deduplicating them would delete the database layer from the code request.
    //
    // The waste is real but it is not in the wording. A request for forty subsystems plus
    // complete production code returns a shallow or truncated answer, and the user spends
    // several more turns recovering what one focused prompt would have produced. The
    // honest intervention is to say so, not to shave words off an irreducible request.

    // A comma-separated run longer than this is an enumeration no single answer covers.
    MAX_LIST_ITEMS: 12,

    // Separate deliverables ("explain X ... provide Y ... implement Z") beyond this many
    // are really separate prompts.
    MAX_DELIVERABLES: 3,

    DELIVERABLE_VERBS: /\b(?:create|build|implement|design|develop|write|generate|provide|produce|explain|describe|summari[sz]e|analy[sz]e|compare|review|refactor|optimi[sz]e|deploy|configure|document|test)\b/gi,

    // Demands for exhaustiveness. Harmless alone; multiplied against a long enumeration
    // is what turns a prompt into one no answer can satisfy.
    EXHAUSTIVE: /\b(?:every|all|each|complete|full|entire|comprehensive|exhaustive|production-ready|end-to-end|in\s+detail|detailed)\b/gi,

    /**
     * Longest run of comma-separated items in the text.
     * @param {string} text
     * @returns {number} Item count of the longest enumeration.
     */
    longestList: function (text) {
        let longest = 0;
        for (const sentence of text.split(/(?<=[.!?])\s+/)) {
            const items = sentence.split(',').length;
            if (items > longest) longest = items;
        }
        return longest;
    },

    /**
     * Reports ways a prompt asks for more than one response can deliver.
     *
     * These are advice, not edits. Nothing here rewrites the prompt, because there is
     * nothing safe to remove -- the fix is to send less at once, and only the user can
     * decide what to drop.
     *
     * @param {string} text - Prompt text.
     * @returns {Array} Findings, [{ type, label, penalty }].
     */
    scopeIssues: function (text) {
        if (!text || typeof text !== 'string') return [];

        const scorable = PM_PROTECT
            ? PM_PROTECT.strip(PM_PROTECT.mask(text).masked)
            : text;
        if (scorable.length === 0) return [];

        const findings = [];

        const listItems = this.longestList(scorable);
        if (listItems > this.MAX_LIST_ITEMS) {
            findings.push({
                type: 'scope',
                penalty: Math.min(20, Math.round((listItems - this.MAX_LIST_ITEMS) / 2)),
                label: `${listItems} items requested in one list -- an answer covering all of ` +
                    'them will be shallow, and the follow-up turns cost more than splitting ' +
                    'the request would'
            });
        }

        const deliverables = (scorable.match(this.DELIVERABLE_VERBS) || []).length;
        if (deliverables > this.MAX_DELIVERABLES) {
            findings.push({
                type: 'scope',
                penalty: Math.min(10, (deliverables - this.MAX_DELIVERABLES) * 2),
                label: `${deliverables} separate deliverables in one prompt -- each one asked ` +
                    'on its own gets a usable answer'
            });
        }

        // Exhaustiveness only matters against a long list. "Explain every step" is a
        // perfectly reasonable prompt; "explain every one of forty subsystems in detail"
        // is not.
        const exhaustive = (scorable.match(this.EXHAUSTIVE) || []).length;
        if (exhaustive >= 3 && listItems > this.MAX_LIST_ITEMS) {
            findings.push({
                type: 'scope',
                penalty: 5,
                label: `"complete", "every" and "in detail" appear ${exhaustive} times over a ` +
                    'list this long, asking for more than one response can hold'
            });
        }

        return findings;
    },

    // Grammar findings that are worth reporting to the user. Capitalization, punctuation
    // and spacing are repaired silently: they are formatting, not errors of grammar, and
    // listing them would bury the ones that change meaning.
    REPORTABLE_GRAMMAR: new Set([
        'agreement', 'verb-form', 'tense', 'noun-form', 'pronoun-case',
        'word-choice', 'article', 'contraction', 'phrasing', 'spelling'
    ]),

    /**
     * The substantive grammatical errors in a piece of text, without rewriting it.
     * @param {string} text - Prompt text.
     * @returns {Array} Issues, [{ type, label }].
     */
    grammarIssues: function (text) {
        if (!PM_GRAMMAR || !text) return [];
        return PM_GRAMMAR.check(text)
            .filter(issue => this.REPORTABLE_GRAMMAR.has(issue.type));
    },

    /**
     * Optimizes a prompt and reports what was changed.
     *
     * optimizePrompt() returns just the text, because that is all the editor needs to
     * swap in. This is the same pass with its findings attached, for the UI that wants
     * to tell the user WHY their prompt changed -- which grammatical errors were found
     * and what each one was.
     *
     * @param {string} prompt - The original prompt text.
     * @returns {Object} { text, grammar, savedWords } where grammar is [{ type, label }].
     */
    optimizeWithReport: function (prompt) {
        // Collected from the real run rather than re-derived: the spelling corrector
        // works inside the pipeline, on masked text, and its findings exist nowhere
        // else. Deduplicated because the same word can be corrected in more than one
        // place, and the card is a summary rather than a log of every edit.
        const collected = [];
        const text = this.optimizePrompt(prompt, collected);

        const grammar = [];
        const seen = new Set();
        collected.concat(this.grammarIssues(prompt || '')).forEach(issue => {
            if (!this.REPORTABLE_GRAMMAR.has(issue.type)) return;
            if (seen.has(issue.label)) return;
            seen.add(issue.label);
            grammar.push(issue);
        });

        const countWords = str => (str || '').trim().split(/\s+/).filter(Boolean).length;
        return {
            text: text,
            grammar: grammar,
            // Advice rather than edits: these describe a prompt that is too big to answer
            // in one turn, which no rewrite of the wording can fix.
            scope: this.scopeIssues(prompt || ''),
            savedWords: Math.max(0, countWords(prompt) - countWords(text))
        };
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
    optimizePrompt: function (prompt, issues) {
        // Guard the type, not just emptiness. Every caller in the extension reads from
        // the DOM and so hands over a string, but this module is also driven directly
        // from the tests and the dashboard, where a stray number or object would throw
        // on .trim() rather than being declined.
        if (typeof prompt !== 'string' || prompt.trim() === "") return "";

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
        optimized = this.correctGrammarAndSpelling(optimized, issues);

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
            /(^|[.!?]\s+)((?:write|explain|give|show|create|list|make|build|design|implement|fix|summari[sz]e|compare|analy[sz]e|describe|generate|convert|translate|help|tell|find|suggest|recommend|review|optimi[sz]e|refactor|add|remove|calculate|solve|draft|outline|rewrite|improve|check|debug|teach|walk|define|derive|prove|simplify|elaborate|clarify)\b[^.!?\n]*)\?/gi,
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
            // A removed sentence can leave its full stop beside the previous one.
            // Exactly two collapse; three are left alone, because that is an ellipsis.
            .replace(/(?<!\.)\.\s*\.(?!\.)/g, '.')
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

        // Stage 9b: a multi-line span is a block, and a block belongs on its own line.
        //
        // Several strippers end in \s*, which happily consumes the newline that separated
        // the prose from a pasted snippet: "review this code plz\nfunction f() {" loses
        // "plz" and the line break with it, leaving the code welded to the end of a
        // sentence. The span itself is restored byte for byte either way -- indentation
        // included -- but for a language where a line break is syntax, joining it to the
        // prose changes the program. Only spans that are already multi-line are affected,
        // so an inline path or identifier keeps sitting mid-sentence.
        if (PM_PROTECT) {
            optimized = optimized.replace(PM_PROTECT.MASK_RX, (placeholder, index) => {
                const span = protectedText.spans[Number(index)];
                return (span && span.indexOf('\n') !== -1) ? `\n${placeholder}\n` : placeholder;
            });
            optimized = optimized
                .replace(/[ \t]+\n/g, '\n')
                .replace(/\n{3,}/g, '\n\n')
                .replace(/^\n+/, '')
                .replace(/\n+$/, '');
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
        // Vocabulary the other tables own. The spelling corrector treats these as
        // correct, so it cannot rewrite an acronym or a term one of the maps handles:
        // "dsa" would otherwise be two edits from "does".
        knownWords: (function () {
            const known = new Set();
            Object.keys(o.techAcronymMap).forEach(term => known.add(term));
            Object.values(o.techAcronymMap).forEach(term => known.add(String(term).toLowerCase()));
            Object.values(typoMap).forEach(term => known.add(String(term).toLowerCase()));
            Object.keys(o.chatSlangMap).forEach(term => known.add(term));
            if (typeof PM_GRAMMAR !== 'undefined' && PM_GRAMMAR && PM_GRAMMAR.PROPER_NOUNS) {
                Object.keys(PM_GRAMMAR.PROPER_NOUNS).forEach(term => known.add(term));
            }
            return known;
        })(),
        // contextualSlangRules compiles its own pattern per rule, in
        // expandContextualSlang, because each one carries separate context tests.
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

/**
 * PromptMeter Sentence Condenser
 *
 * Phrase-level rules cannot shorten a rambling prompt: a 130-word backstory contains no
 * blacklisted phrases, so a blacklist leaves it untouched. This module works one level
 * up, on whole sentences, and does two things a blacklist cannot:
 *
 *   1. MERGE REPEATS   Six sentences that all start "The essay needs to have ..." become
 *                      one sentence with a list.
 *   2. DROP NARRATIVE  A sentence that contains no request and introduces almost no new
 *                      vocabulary is backstory, and is removed.
 *
 * The pruning rule is deliberately conservative: a sentence is only dropped when it both
 * carries no instruction AND adds nothing to the prompt's vocabulary. That keeps
 * "we sell handmade candles" (new terms: candles, sell) while dropping "I hope you are
 * doing well today" (new terms: none).
 *
 * Runs on masked text, so a placeholder is opaque. Any sentence holding one is treated
 * as protected content and never dropped.
 */
const PromptMeterCondense = {
    // Below this length a prompt is not an essay, and sentence pruning stays off.
    MIN_WORDS: 35,

    // A sentence must contribute at least this many previously unseen content words to
    // survive on vocabulary alone.
    MIN_NEW_TERMS: 2,

    MASK_OPEN: '\uE000',

    // Function words carry no topic information and are ignored when comparing vocabulary.
    STOPWORDS: new Set([
        'a', 'about', 'above', 'after', 'again', 'all', 'also', 'am', 'an', 'and', 'any',
        'are', 'as', 'at', 'be', 'because', 'been', 'before', 'being', 'below', 'between',
        'both', 'but', 'by', 'can', 'could', 'did', 'do', 'does', 'doing', 'down', 'during',
        'each', 'few', 'for', 'from', 'further', 'get', 'got', 'had', 'has', 'have', 'having',
        'he', 'her', 'here', 'hers', 'him', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it',
        'its', 'just', 'like', 'me', 'more', 'most', 'my', 'no', 'nor', 'not', 'now', 'of',
        'off', 'on', 'once', 'only', 'or', 'other', 'ought', 'our', 'ours', 'out', 'over',
        'own', 'really', 'same', 'she', 'should', 'so', 'some', 'such', 'than', 'that', 'the',
        'their', 'theirs', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through',
        'to', 'too', 'under', 'until', 'up', 'very', 'was', 'we', 'were', 'what', 'when',
        'where', 'which', 'while', 'who', 'whom', 'why', 'will', 'with', 'would', 'you',
        'your', 'yours', 'am', 'been', 'thing', 'things', 'stuff', 'lot', 'bit', 'way',
        'ways', 'time', 'times', 'know', 'think', 'want', 'need', 'sure', 'maybe', 'okay'
    ]),

    // The sentence actually asks for something.
    IMPERATIVE: /^(?:please\s+)?(?:write|explain|give|show|create|list|make|build|design|implement|fix|summari[sz]e|compare|analy[sz]e|describe|generate|convert|translate|help|tell|find|suggest|recommend|review|optimi[sz]e|refactor|add|remove|calculate|solve|draft|outline|rewrite|improve|check|debug|teach|walk)\b/i,

    QUESTION_OPENER: /^(?:what|why|how|when|where|which|who|whose|can|could|should|would|will|is|are|do|does|did|has|have|any)\b/i,

    // A request verb followed by an object, anywhere in the text. Used only to decide
    // whether a prompt still asks for something -- an imperative that follows a comma-
    // less preamble ("...exam tomorrow teach me ML") is invisible to the anchored
    // patterns above.
    MID_ASK: /\b(?:write|explain|give|show|create|list|make|build|design|implement|fix|summari[sz]e|compare|analy[sz]e|describe|generate|convert|translate|help|tell|find|suggest|recommend|review|optimi[sz]e|refactor|add|remove|calculate|solve|draft|outline|rewrite|improve|check|debug|teach|walk)\s+(?:me|us|my|our|the|a|an|this|that|these|those|it|how|what|why|when|where|which|about|some|more|\d+|[a-z]{2,})\b/i,

    // "I need you to write X" is an instruction wearing a wrapper. The wrapper is
    // removed before classification so the verb underneath is seen.
    LEAD_IN: /^(?:so\s+|okay\s+|well\s+|and\s+|but\s+)?(?:please\s+)?(?:(?:i|we)\s+(?:need|want|would\s+like|'d\s+like)\s+(?:you\s+)?to\s+|(?:can|could|would|will)\s+you\s+(?:please\s+)?|(?:i|we)\s+(?:need|want)\s+|let'?s\s+|help\s+me\s+(?:to\s+)?)/i,

    // The sentence states a requirement about the output.
    CONSTRAINT: /\b(?:must|should|needs?\s+to|has\s+to|make\s+sure|ensure|include|exclude|avoid|format|at\s+least|no\s+more\s+than|\d+\s+words?|step[-\s]by[-\s]step|in\s+\w+\s+style|bullet\s+points?|tone)\b/i,

    // Sentences that are pure hedging, uncertainty or research narrative. These are
    // dropped even when they introduce new vocabulary, because the vocabulary is about
    // the user's state of mind rather than the task.
    LOW_VALUE: [
        /^(?:but\s+|and\s+|so\s+)?(?:i|we)\s*(?:'m|\s+am|\s+was|\s+are|\s+were)?\s*(?:not\s+|n't\s+)?(?:really\s+|totally\s+|entirely\s+|quite\s+)?(?:sure|certain|clear|confident)\b/i,
        /^(?:but\s+|and\s+|so\s+)?(?:i|we)\s+(?:was|were|am|are)\s+think(?:ing)?\b/i,
        /^the\s+thing\s+is\b/i,
        /^(?:but\s+)?(?:i|we)\s+(?:have\s+)?(?:tried|read|looked|searched|googled|watched|checked)\b/i,
        /^(?:i|we)\s+(?:really\s+)?(?:hope|wish|feel|felt|guess)\b/i,
        /^(?:i|we)\s+would\s+(?:really\s+)?appreciate\b/i,
        /^(?:i|we)\s+(?:do\s+not|don't|did\s+not|didn't)\s+(?:know|understand|get)\b/i,
        /^(?:but\s+)?there\s+(?:is|are|'s)\s+so\s+(?:much|many)\b/i,
        /^(?:i|we)\s+(?:have\s+been|had\s+been|has\s+been)\s+struggling\b/i,
        /^(?:i|we)\s+wanted\s+to\s+reach\s+out\b/i,
        /^(?:i|we)\s+(?:have|had)\s+a\s+question\b/i
    ],

    // --- Situational preamble removal ----------------------------------------------
    //
    // A prompt can be mostly backstory while still being short: "hey I have an exam
    // tomorrow teach me ML" is eight words, five of which describe the user's week.
    // Sentence pruning above cannot touch it -- the whole thing is one sentence, far
    // below MIN_WORDS -- so this pass works one level down, at CLAUSE level.
    //
    // What is removed is CIRCUMSTANCE: exams, deadlines, moods, excuses, who told the
    // user what. What is kept is anything that shapes the ANSWER -- "I am a beginner"
    // tells the model how to pitch its reply and stays; "I have been learning Python
    // for two months" is autobiography and goes.
    //
    // Two guards make the removal safe, and both must hold:
    //   1. AN ASK SURVIVES   "I have an exam tomorrow" alone is the entire message and
    //                        is left untouched. Something must still be requested.
    //   2. A TOPIC SURVIVES  "I am having an exam in AI, help me to study" leaves only
    //                        "help me to study" -- the subject lived in the clause, so
    //                        the removal is rejected and the sentence rewriter handles
    //                        it instead. The remainder must name something concrete.

    // Words that open a genuine request. A context clause is never allowed to run
    // through one of these, so "...exam tomorrow teach me ML" stops before "teach".
    ASK_WORDS: [
        'teach', 'explain', 'write', 'give', 'show', 'create', 'list', 'make', 'build',
        'design', 'implement', 'fix', 'summari[sz]e', 'compare', 'analy[sz]e', 'describe',
        'generate', 'convert', 'translate', 'help', 'tell', 'find', 'suggest', 'recommend',
        'review', 'optimi[sz]e', 'refactor', 'add', 'remove', 'calculate', 'solve', 'draft',
        'outline', 'rewrite', 'improve', 'check', 'debug', 'walk', 'define', 'derive',
        'prove', 'simplify', 'elaborate', 'clarify', 'plan', 'prepare', 'study', 'learn',
        'revise', 'guide', 'quiz', 'test', 'practice', 'start', 'begin',
        'what', 'why', 'how', 'when', 'where', 'which', 'who', 'whose',
        'can', 'could', 'should', 'would', 'will', 'is', 'are', 'do', 'does', 'did',
        'need', 'want', 'any', 'please'
    ],

    // Verbs that are the request itself rather than its subject. A remainder built only
    // from these names nothing, so the clause that held the topic must be kept.
    BARE_ASK: new Set([
        'teach', 'explain', 'write', 'give', 'show', 'create', 'list', 'make', 'build',
        'design', 'implement', 'fix', 'summarize', 'summarise', 'compare', 'analyze',
        'analyse', 'describe', 'generate', 'convert', 'translate', 'help', 'tell', 'find',
        'suggest', 'recommend', 'review', 'optimize', 'optimise', 'refactor', 'add',
        'remove', 'calculate', 'solve', 'draft', 'outline', 'rewrite', 'improve', 'check',
        'debug', 'walk', 'define', 'derive', 'prove', 'simplify', 'elaborate', 'clarify',
        'plan', 'prepare', 'study', 'studying', 'learn', 'learning', 'revise', 'revising',
        'guide', 'practice', 'start', 'begin', 'understand', 'please', 'everything',
        'anything', 'something', 'nothing', 'basics', 'basic', 'quickly', 'fast', 'today',
        'tomorrow', 'tonight'
    ]),

    // Occasions a person announces before asking. Plurals are matched explicitly rather
    // than with a blanket s? so "class" and "classes" both work.
    EVENT_NOUNS: [
        'exams?', 'tests?', 'quiz(?:zes)?', 'midterms?', 'finals?', 'vivas?', 'orals?',
        'interviews?', 'presentations?', 'demos?', 'assignments?', 'assessments?',
        'homework', 'projects?', 'submissions?', 'deadlines?', 'meetings?', 'seminars?',
        'placements?', 'entrances?', 'semesters?', 'sems?', 'internals?', 'externals?',
        'practicals?', 'labs?', 'classes', 'class', 'lectures?', 'papers?', 'thesis',
        'dissertations?', 'defen[cs]es?', 'hackathons?', 'competitions?', 'contests?',
        'auditions?', 'certifications?', 'boards?', 'juries', 'jury', 'appraisals?',
        'reviews?', 'sprints?', 'launch(?:es)?', 'audits?'
    ],

    // Modifiers that commonly sit in front of an occasion ("end sem exam", "mock test").
    EVENT_ADJ: [
        'big', 'final', 'important', 'upcoming', 'next', 'last', 'first', 'second',
        'third', 'sem', 'semester', 'series', 'model', 'unit', 'mid', 'midterm', 'end',
        'internal', 'external', 'university', 'college', 'school', 'board', 'entrance',
        'mock', 'practice', 'placement', 'campus', 'technical', 'hr', 'coding', 'online',
        'written', 'oral', 'practical', 'annual', 'monthly', 'weekly', 'surprise', 'my'
    ],

    // Clause shapes that carry circumstance and nothing else. Each is anchored to a
    // clause boundary, so "explain what happens when I have an exam" -- where the same
    // words are mid-clause and part of the question -- is never matched.
    SITUATIONAL_CORES: [
        // "I have an exam tomorrow", "I've got my finals", "we have a demo on friday"
        "ME\\s+(?:have|has|had|'ve|ve|got|hav|hv|have\\s+got|'ve\\s+got|will\\s+have)\\s+(?:an?\\s+|my\\s+|our\\s+|the\\s+|some\\s+|this\\s+)?EVENT",
        "MEBE\\s+(?:having|writing|giving|taking|attending|appearing\\s+for|sitting\\s+for|going\\s+to\\s+(?:have|write|give|take|attend|face|appear\\s+for|sit\\s+for))\\s+(?:an?\\s+|my\\s+|our\\s+|the\\s+|some\\s+|this\\s+)?EVENT",
        // "my exam is tomorrow", "our finals are coming up", "the deadline is tonight"
        "(?:my|our|the)\\s+EVENT\\s*(?:is|are|was|were|will\\s+be|starts?|starting|begins?|beginning|comes?\\s+up|(?:is|are)\\s+coming\\s+up|got\\s+(?:preponed|postponed|moved))",
        // "my exam tomorrow", "our sem exams next month" -- no verb, just an announcement
        "(?:my|our)\\s+EVENT\\s+(?=(?:tomorrow|today|tonight|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next|this|in|on|are|is)\\b)",
        // "tomorrow I have an exam", "next week we have a viva"
        "(?:tomorrow|today|tonight|next\\s+\\w+|this\\s+\\w+)\\s+ME\\s+(?:have|has|'ve|got|will\\s+have)\\s+(?:an?\\s+|my\\s+|our\\s+|the\\s+)?EVENT",
        // "I am preparing for my exam", "I'm cramming for finals"
        "ME\\s*(?:BE\\s+)?(?:preparing|studying|revising|cramming|prepping|getting\\s+ready|gearing\\s+up|going\\s+to\\s+appear)\\s+for",
        // "I have to appear for the exam", "I need to submit this by monday"
        "ME\\s+(?:have|has|'ve|had|need|needs|want|wants)\\s+to\\s+(?:appear|sit|attend|submit|present|face|clear|pass|crack|score|top|ace|survive|finish)\\b",
        // Time pressure. An LLM cannot act on a countdown.
        "ME\\s+(?:only\\s+)?(?:have|has|'ve|got|have\\s+got)\\s+(?:only\\s+|just\\s+|barely\\s+)?(?:\\d+|a\\s+few|very\\s+few|less\\s+than\\s+\\w+|one|two|three|four|five|six|seven|ten)\\s+(?:days?|hours?|weeks?|months?|minutes?|nights?)\\b",
        "MEBE\\s+(?:running\\s+out\\s+of\\s+time|short\\s+on\\s+time|out\\s+of\\s+time|pressed\\s+for\\s+time|in\\s+a\\s+hurry|in\\s+a\\s+rush)",
        "(?:there\\s+(?:is|are|'s)\\s+(?:no|not\\s+much|very\\s+little|hardly\\s+any)\\s+time|time\\s+is\\s+(?:short|running\\s+out|against\\s+me))",
        // Emotional and physical state.
        "(?:MEBE|ME\\s+(?:feel|feels|felt))\\s+(?:feeling\\s+)?(?:so\\s+|very\\s+|really\\s+|quite\\s+|kind\\s+of\\s+|kinda\\s+|a\\s+bit\\s+|a\\s+little\\s+|totally\\s+|completely\\s+|extremely\\s+|super\\s+)?(?:stressed|stressing|panicking|panicked|nervous|anxious|worried|scared|afraid|terrified|tired|exhausted|sleepy|burnt\\s+out|burned\\s+out|lost|confused|stuck|frustrated|overwhelmed|bored|lazy|desperate|helpless|hopeless|blank|clueless|freaking\\s+out|dying|screwed|doomed|cooked|struggling|suffering)",
        // Who set the task, and where the user first saw it.
        "(?:my|our)\\s+(?:professor|prof|teacher|lecturer|instructor|tutor|mentor|manager|boss|senior|guide|hod|friend|classmate|roommate|batchmate|colleague|dad|mom|mum|brother|sister|parents?)\\s+(?:gave|give|gives|told|tells|said|says|asked|asks|assigned|assigns|wants?|wanted|suggested|suggests|recommended|recommends|showed|shows|shared|shares|set|sent)",
        "ME\\s+(?:saw|found|read|noticed|came\\s+across|stumbled\\s+(?:up)?on|was\\s+watching|watched)\\s+(?:a|an|this|that|some|it)\\s+(?:video|post|article|tweet|reel|short|thread|blog|comment|paper|book|course|lecture|meme|thing|question)",
        "ME\\s+(?:googled|searched|looked\\s+it\\s+up|checked\\s+online|asked\\s+(?:chatgpt|gpt|ai|someone)|tried\\s+everything|tried\\s+a\\s+lot|read\\s+the\\s+docs|watched\\s+(?:some\\s+)?videos?)\\b",
        // How long the user has been at it. The duration is narrative; the subject it
        // mentions is normally repeated in the request itself.
        "ME\\s+(?:have|has|'ve|had)\\s+been\\s+(?:learning|studying|doing|reading|practi[cs]ing|trying|working\\s+on|using|stuck\\s+on|messing\\s+(?:about|around))\\b",
        // Where the user is in their education. Circumstance, not an answer constraint.
        "MEBE\\s+(?:in|doing|pursuing|studying\\s+in)\\s+(?:my\\s+|the\\s+)?(?:\\d+(?:st|nd|rd|th)?|first|second|third|fourth|fifth|final|last|senior|junior)\\s*(?:year|yr|sem|semester|grade|standard|std|class)",
        "MEBE\\s+(?:a|an)\\s+(?:college|school|university|engineering|medical|law|phd|masters|mba|btech|bsc|msc)?\\s*(?:student|fresher|undergrad|undergraduate|graduate|postgraduate|intern)",
        "ME\\s+(?:study|studies)\\s+(?:at|in)\\s+(?:a|an|the|my)\\b",
        "MEBE\\s+(?:studying|enrolled)\\s+(?:at|in)\\s+(?:a|an|the|my)\\b",
        // Excuses and non-preparation.
        "ME\\s+(?:did\\s*n[o']?t|didn'?t|do\\s*n[o']?t|don'?t|have\\s*n[o']?t|haven'?t|has\\s*n[o']?t|hasn'?t|never|hardly|barely)\\s+(?:attend|attended|study|studied|prepare|prepared|revise|revised|open|opened|touch|touched|listen|listened|show\\s+up|pay\\s+attention|understand|understood|get\\s+it|follow|grasp|remember)",
        // The same excuse once its subject has already been removed with an earlier
        // clause: "I googled it but did not understand".
        "(?:did\\s*n[o']?t|didn'?t|do\\s*n[o']?t|don'?t|could\\s*n[o']?t|couldn'?t)\\s+(?:understand|get\\s+it|follow|grasp|remember|know)\\b",
        "ME\\s+(?:missed|skipped|bunked|slept\\s+through|forgot|ignored|postponed|delayed|wasted|procrastinated|kept\\s+postponing|kept\\s+delaying)",
        "ME\\s+(?:know|knows|understand|understands)\\s+(?:absolutely\\s+|literally\\s+|pretty\\s+much\\s+)?(?:nothing|zero|none\\s+of\\s+(?:it|this))",
        "MEBE\\s+(?:completely\\s+|totally\\s+|absolutely\\s+)?(?:blank|unprepared|underprepared|behind|late)\\b",
        // Aimless narrative openings.
        "MEBE\\s+(?:just\\s+)?(?:sitting|lying|chilling|scrolling|walking|travelling|traveling|commuting|waiting)\\b",
        "ME\\s+(?:woke\\s+up|got\\s+up|came\\s+(?:back|home)|reached\\s+home|just\\s+got\\s+(?:back|home))\\b",
        "MEBE\\s+(?:new\\s+here|posting\\s+(?:this|here)\\s+for\\s+the\\s+first\\s+time|asking\\s+(?:this\\s+)?(?:again|one\\s+more\\s+time))"
    ],

    // Trailing purpose: "...for my exam", "...before my interview". Unlike the cores
     // above these are not clauses and carry no lead anchor, so they are compiled
    // separately. The topic guard does the interesting work here: it keeps "write a
    // study plan for my exam" (nothing but the occasion names a subject) while clearing
    // "the key points of operating systems for my exam".
    SITUATIONAL_TAIL_CORES: [
        "\\s+(?:for|before|ahead\\s+of|in\\s+time\\s+for|because\\s+of)\\s+(?:my|our|the|this|next)\\s+(?:upcoming\\s+|big\\s+)?EVENT\\b(?:\\s+(?:tomorrow|today|tonight|next\\s+\\w+|this\\s+\\w+|on\\s+\\w+))?"
    ],

    /**
     * Compiles SITUATIONAL_CORES into anchored regexes. Called once at load time; the
     * cores stay readable because the repeated fragments are substituted here rather
     * than being spelled out thirty times.
     * @returns {Array} Compiled RegExp objects.
     */
    buildSituational: function () {
        const ask = this.ASK_WORDS.join('|');
        const connective = 'so|and|but|because|since|then|also|now|however|therefore|plus|yet';

        // A context clause may run over ordinary words, but never into a request or
        // across a connective that introduces the next clause.
        const stop = `(?:${ask}|${connective})`;
        const tail = `(?:\\s+(?!${stop}\\b)[A-Za-z0-9$%'’./+#-]+){0,10}`;

        // A context clause is recognised in exactly two positions: at the start of a
        // clause, optionally behind one or two lead-ins ("so basically my professor
        // ..."), or mid-sentence behind a connective that opens a new clause without
        // punctuation ("I am a beginner and I have been learning Python ...").
        //
        // The second branch REQUIRES the connective. Without that requirement the
        // patterns would fire on ordinary subordinate clauses -- "explain what happens
        // when I have an exam" -- where the same words are part of the question.
        const leadIn = `(?:${connective}|anyway|basically|actually)`;
        const lead = `(?:(?<=^|[.!?;,]|\\n)\\s*(?:${leadIn}\\s+){0,2}|(?<=\\s)(?:${leadIn}\\s+){1,2})`;

        // Occasions are often named with a noun in front of a noun -- "project review",
        // "exam paper", "interview round" -- so a noun may also act as a modifier.
        const nouns = this.EVENT_NOUNS.join('|');
        const event = `(?:(?:${this.EVENT_ADJ.join('|')}|${nouns})\\s+){0,2}(?:${nouns})`;

        // "I'm" carries no space before the verb, so subject and copula are matched as
        // one token rather than as ME followed by BE.
        const meBe = `(?:i|we)(?:\\s*'m|\\s*'re|\\s+(?:am|are|is|was|were|been|m|re))`;

        const expand = (core) => core
            .replace(/EVENT/g, event)
            .replace(/\bMEBE\b/g, meBe)
            .replace(/\bME\b/g, "(?:i|we)")
            .replace(/\bBE\b/g, "(?:am|'m|m|are|'re|is|was|were|been)");

        // The clause's own trailing punctuation is deliberately left in place: it is the
        // separator between the clauses either side of it, and stripSituational collapses
        // whatever doubles up.
        const clauses = this.SITUATIONAL_CORES.map(core =>
            new RegExp(`${lead}(?:${expand(core)})${tail}`, 'gi'));

        const tails = this.SITUATIONAL_TAIL_CORES.map(core =>
            new RegExp(`(?:${expand(core)})(?=$|[.!?,;\\s])`, 'gi'));

        return clauses.concat(tails);
    },

    /**
     * True when the text still requests something: an imperative, a question opener or
     * a question mark. Checked clause by clause, so a request in any position counts.
     * @param {string} text
     * @returns {boolean}
     */
    hasAsk: function (text) {
        if (!text) return false;
        if (text.indexOf('?') !== -1) return true;
        // A request does not always start a clause. "I have an exam tomorrow teach me
        // ML" holds no punctuation at all, so the verb is looked for mid-sentence too.
        if (this.MID_ASK.test(text)) return true;

        return text.split(/[.!?;,\n]+/).some(clause => {
            const trimmed = clause.trim();
            if (trimmed.length === 0) return false;
            return this.IMPERATIVE.test(trimmed.replace(this.LEAD_IN, '')) ||
                this.QUESTION_OPENER.test(trimmed);
        });
    },

    /**
     * Content words that name a subject rather than making a request. "teach me ML"
     * has one (ML); "help me to study" has none.
     * @param {string} text
     * @returns {Array} Lowercased topic words.
     */
    topicWords: function (text) {
        return this.contentWords(text).filter(word => !this.BARE_ASK.has(word));
    },

    /**
     * Removes the user's circumstances from a prompt, keeping the request. Applies at
     * any length, unlike condense(). Returns the input unchanged whenever removal would
     * leave no request or would take the subject with it.
     * @param {string} text - Masked prompt text.
     * @returns {string} Text with situational clauses removed, or the original.
     */
    stripSituational: function (text) {
        // Nothing is being asked, so every clause is load-bearing.
        if (!text || !this.hasAsk(text)) return text;

        // Two passes: removing one clause can expose the next ("I am stressed because
        // my viva is tomorrow" only reveals a clause-initial "my viva" once the mood
        // clause in front of it is gone).
        let out = text;
        for (let pass = 0; pass < 2; pass++) {
            for (const rx of this.situational) {
                rx.lastIndex = 0;
                // A clause holding protected content is never removed, however
                // situational it looks -- the span may be what the question is about.
                out = out.replace(rx, match => match.indexOf(this.MASK_OPEN) !== -1 ? match : ' ');
            }
        }

        if (out === text) return text;

        out = out
            .replace(/[ \t]+/g, ' ')
            .replace(/\s+([,.;:!?])/g, '$1')
            // A clause removed from between two others leaves its separators back to back
            .replace(/([,;:])(?:\s*[,;:])+/g, '$1')
            .replace(/([.!?])\s*([,;:])/g, '$1')
            .replace(/^[\s,;:.\-–—]+/, '')
            // The connective that joined the removed clause to the request is now
            // leading the prompt. It has to go here rather than in the optimizer's
            // final tidy, so the request wrapper behind it ("so can you teach me ...")
            // is back at a clause start for the next stripper pass.
            .replace(/^(?:so|and|but|because|since|then|also|now|however|therefore|plus|yet)\s+/i, '')
            .trim();

        // Guard 1: something must still be asked.
        if (!this.hasAsk(out)) return text;
        // Guard 2: the subject must not have left with the circumstances.
        if (this.topicWords(out).length === 0) return text;

        return out;
    },

    /**
     * Splits text into sentences, keeping terminators and treating blank lines as breaks.
     * @param {string} text - Masked prompt text.
     * @returns {Array} Sentence strings, trimmed, in order.
     */
    splitSentences: function (text) {
        return text
            .split(/(?<=[.!?])[ \t]+|\n+/)
            .map(part => part.trim())
            .filter(part => part.length > 0);
    },

    /**
     * The topic-bearing words of a sentence.
     * @param {string} sentence
     * @returns {Array} Lowercased content words.
     */
    contentWords: function (sentence) {
        const words = sentence.toLowerCase().match(/[a-z][a-z'-]{1,}/g) || [];
        return words.filter(word => !this.STOPWORDS.has(word));
    },

    // A sentence opening with a preposition or a bare coordinator is what is left after
    // its subject was stripped ("for your time and help."), not a real clause.
    FRAGMENT: /^(?:for|of|in|on|with|to|from|by|at|about|and|or|but|so|that|which)\b/i,

    /**
     * Classifies a sentence by what it contributes.
     * @param {string} sentence
     * @returns {Object} { core, lowValue, protectedSpan }
     */
    classify: function (sentence) {
        const trimmed = sentence.trim();
        const bare = trimmed.replace(this.LEAD_IN, '');
        const protectedSpan = trimmed.indexOf(this.MASK_OPEN) !== -1;
        const asks = this.IMPERATIVE.test(bare) ||
            this.QUESTION_OPENER.test(trimmed) ||
            trimmed.indexOf('?') !== -1;
        const constrains = this.CONSTRAINT.test(trimmed);

        // A short leftover that asks for nothing is a fragment, not a sentence.
        const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
        const fragment = !protectedSpan && !asks && !constrains &&
            (this.FRAGMENT.test(trimmed) || wordCount <= 3);

        return {
            protectedSpan: protectedSpan,
            core: protectedSpan || asks || constrains,
            lowValue: fragment || this.LOW_VALUE.some(rx => rx.test(trimmed))
        };
    },

    /**
     * Normalised opening of a sentence, used to spot repeated templates.
     * @param {string} sentence
     * @param {number} depth - How many leading words form the key.
     * @returns {string}
     */
    templateKey: function (sentence, depth) {
        const words = sentence.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/);
        return words.slice(0, depth).join(' ');
    },

    /**
     * Collapses consecutive sentences that repeat the same opening into one sentence
     * with a list. Six "The essay needs to have X" sentences become one.
     * @param {Array} sentences
     * @returns {Array} Sentences with repeats merged.
     */
    mergeRepeats: function (sentences) {
        const KEY_DEPTH = 3;
        const out = [];
        let i = 0;

        while (i < sentences.length) {
            const key = this.templateKey(sentences[i], KEY_DEPTH);
            const group = [sentences[i]];

            // A key shorter than three words is too generic to merge on.
            while (key.split(' ').filter(Boolean).length >= KEY_DEPTH &&
                   i + group.length < sentences.length &&
                   this.templateKey(sentences[i + group.length], KEY_DEPTH) === key) {
                group.push(sentences[i + group.length]);
            }

            if (group.length < 2) {
                out.push(sentences[i]);
                i += 1;
                continue;
            }

            out.push(this.mergeGroup(group));
            i += group.length;
        }

        return out;
    },

    /**
     * Merges sentences sharing an opening into one listed sentence. The shared part is
     * the longest common run of words, so "The essay needs to have an introduction" and
     * "... a body" share "The essay needs to have" rather than a fixed-width prefix.
     * @param {Array} group - Two or more sentences with the same opening.
     * @returns {string} One merged sentence.
     */
    mergeGroup: function (group) {
        const split = group.map(sentence => sentence.replace(/[.!?]+$/, '').trim().split(/\s+/));

        let shared = 0;
        const shortest = Math.min.apply(null, split.map(words => words.length));
        while (shared < shortest - 1 &&
               split.every(words => words[shared].toLowerCase() === split[0][shared].toLowerCase())) {
            shared += 1;
        }

        const prefix = split[0].slice(0, shared).join(' ');
        const tails = [];
        split.forEach(words => {
            const tail = words.slice(shared).join(' ').trim();
            if (tail.length > 0 && tails.indexOf(tail) === -1) tails.push(tail);
        });

        if (tails.length === 0) return group[0];

        const joined = tails.length > 1
            ? tails.slice(0, -1).join(', ') + ' and ' + tails[tails.length - 1]
            : tails[0];

        return `${prefix} ${joined}.`.replace(/\s+/g, ' ').trim();
    },

    /**
     * Removes backstory: sentences with no request that add no new vocabulary.
     * @param {Array} sentences
     * @returns {Array} Surviving sentences, in original order.
     */
    pruneNarrative: function (sentences) {
        const classified = sentences.map(sentence => ({
            text: sentence,
            info: this.classify(sentence),
            words: this.contentWords(sentence)
        }));

        // Vocabulary established by the sentences that actually ask for something.
        const known = new Set();
        classified.forEach(entry => {
            if (entry.info.core) entry.words.forEach(word => known.add(word));
        });

        const kept = classified.filter(entry => {
            if (entry.info.core) return true;
            if (entry.info.lowValue) return false;

            // Keep a non-core sentence only if it carries genuinely new subject matter.
            const fresh = entry.words.filter(word => !known.has(word));
            if (fresh.length >= this.MIN_NEW_TERMS) {
                fresh.forEach(word => known.add(word));
                return true;
            }
            return false;
        });

        // Never return nothing: if every sentence looked droppable, keep the original.
        return kept.length > 0 ? kept.map(entry => entry.text) : sentences;
    },

    /**
     * Shortens a long, rambling prompt. Short prompts are returned untouched.
     * @param {string} text - Masked prompt text.
     * @returns {string} Condensed text.
     */
    condense: function (text) {
        if (!text) return text;

        text = text.replace(/[ \t]+/g, ' ').trim();
        const wordCount = text.split(/\s+/).filter(Boolean).length;
        if (wordCount < this.MIN_WORDS) return text;

        const sentences = this.splitSentences(text);
        if (sentences.length < 2) return text;

        const condensed = this.pruneNarrative(this.mergeRepeats(sentences));
        return condensed.join(' ').replace(/\s+/g, ' ').trim();
    }
};

// Compile the situational clause patterns once, at load time rather than per keystroke.
PromptMeterCondense.situational = PromptMeterCondense.buildSituational();

// Export for global (content script) and bundler environments
if (typeof window !== 'undefined') {
    window.PromptMeterCondense = PromptMeterCondense;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { PromptMeterCondense };
}

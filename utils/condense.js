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
// The trained phrase classifier, when one is loaded. Optional by design: with no model
// present every path below falls back to the rules alone and behaviour is unchanged.
const PM_ML = (typeof PromptMeterML !== 'undefined')
    ? PromptMeterML
    : (typeof require !== 'undefined' ? require('./ml-classifier.js').PromptMeterML : null);

const PromptMeterCondense = {
    // --- Machine-learning assist ------------------------------------------------------
    //
    // The classifier is a second opinion, never the decision maker. It is consulted in
    // exactly two situations, and the asymmetry between them is deliberate:
    //
    //   VETO     the rules want to drop a sentence, but the model is confident it is
    //            IMPORTANT. The sentence stays. Cheap to be wrong -- a few extra tokens.
    //
    //   PROPOSE  the rules want to keep a sentence and no rule matched it, but the model
    //            is very confident it is removable. It goes. Expensive to be wrong, so
    //            the bar is much higher, and the existing guards still apply on top.
    //
    // A sentence the rules classify as core -- it asks something, constrains the output,
    // or holds protected content -- is never offered to the model at all. No confidence
    // level lets the classifier delete the user's actual request.
    // Both thresholds are set from measured precision rather than taste, and re-derived
    // whenever the model is refitted. Running 5-fold cross-validated probabilities over
    // the corpus and asking, at each cut-off, how often the rule that fires is right:
    //
    //   PROPOSE (removable >= t)        VETO (keep >= t)
    //     t     fires  precision          t     fires  precision
    //    0.85    314     0.978           0.70     68     0.941
    //    0.88    274     0.985           0.75     52     0.962
    //    0.90    229     0.991           0.80     45     0.956
    //    0.92    172     0.994           0.85     35     0.943
    //
    // Both moved when the corpus grew to 621 rows and the search picked C=4.0, which is
    // why the file says to re-derive them. PROPOSE drops from 0.92 to 0.90: it deletes
    // the user's own text, so it is still held to ~99% precision, but the better-fitted
    // model now reaches that at 0.90 and fires 57 more times for it. VETO drops from
    // 0.80 to 0.75, which is better on both axes at once -- higher precision (0.962
    // against 0.956) AND more firings (52 against 45).
    //
    // Re-derive these after retraining. They describe a particular fitted model, not a
    // property of the approach.
    ML_KEEP_VETO: 0.75,
    ML_DROP_PROPOSE: 0.90,

    /** The classifier, or null when no model is loaded. */
    ml: function () {
        return (PM_ML && PM_ML.isAvailable()) ? PM_ML : null;
    },

    /**
     * True when the model is confident enough that a piece of text carries the
     * instruction to overrule a rule that wanted to remove it.
     * @param {string} text
     * @returns {boolean}
     */
    mlVetoesRemoval: function (text) {
        const engine = this.ml();
        if (!engine) return false;

        const advice = engine.advise(text);
        return Boolean(advice && advice.keep >= this.ML_KEEP_VETO);
    },

    /**
     * True when the model is confident enough that a piece of text is filler, padding or
     * repetition to suggest removing it where no rule matched.
     * @param {string} text
     * @returns {boolean}
     */
    mlProposesRemoval: function (text) {
        const engine = this.ml();
        if (!engine) return false;

        const advice = engine.advise(text);
        return Boolean(advice && advice.removable >= this.ML_DROP_PROPOSE);
    },

    // Below this length sentence pruning stays off.
    //
    // This was 35, on the reasoning that a shorter prompt is not an essay and has no
    // padding to find. That is true of the RULES -- a blacklist needs bulk to work on --
    // but it also switched off the classifier for almost every real prompt, because the
    // propose path below only runs inside condense(). Backstory a rule has never seen
    // ("my cousin just adopted two rescue cats from the shelter") sat in two-sentence
    // prompts untouched, even with the model calling it removable at 0.93.
    //
    // 15 is low enough to cover an ordinary two-sentence prompt and high enough that a
    // one-line question is still never pruned. The guards that make this safe are
    // unchanged and do the real work: a sentence that asks, constrains or holds
    // protected content is never offered to the model, the propose threshold is set for
    // ~99% precision, and pruneNarrative never returns an empty prompt.
    MIN_WORDS: 15,

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
    IMPERATIVE: /^(?:please\s+)?(?:write|explain|give|show|create|list|make|build|design|implement|fix|summari[sz]e|compare|analy[sz]e|describe|generate|convert|translate|help|tell|find|suggest|recommend|review|optimi[sz]e|refactor|add|remove|calculate|solve|draft|outline|rewrite|improve|check|debug|teach|walk|provide|include|use|keep|focus|mention|discuss|elaborate|cite|avoid|go\s+(?:in|into|through|over)|reason|propose|plan|prepare|predict|estimate|evaluate|identify|define|derive|prove|imagine|act|pretend|assume|consider|label|classify|categori[sz]e|rate|rank|grade|answer|respond|reply|extract|tag|sort|initiate|start|begin|continue|narrate|simulate|play|roleplay|brainstorm|stay|remember|pretend|introduce|greet|wait|ask|say|return|output|print|read|draw|sketch|paint|compose|invent|predict|guess|choose|pick|select|name|count|convert|format)\b/i,

    QUESTION_OPENER: /^(?:what|why|how|when|where|which|who|whose|can|could|should|would|will|is|are|do|does|did|has|have|any)\b/i,

    // A request verb followed by an object, anywhere in the text. Used only to decide
    // whether a prompt still asks for something -- an imperative that follows a comma-
    // less preamble ("...exam tomorrow teach me ML") is invisible to the anchored
    // patterns above.
    // ...or a stated need for a deliverable: "...tomorrow I need notes for dma".
    MID_NEED: /\b(?:i|we)\s+(?:really\s+)?(?:need|want|would\s+like|'d\s+like)\s+(?:some\s+|a\s+|an\s+|the\s+|short\s+|quick\s+|good\s+)*(?:notes|help|tips|ideas|summary|summaries|explanation|answers?|examples?|code|list|plan|steps|questions|essay|email|letter|program|solution|guide|overview|outline|report|advice|suggestions|recommendations|points|definition|diagram|table|script)\b/i,

    MID_ASK: /\b(?:write|explain|give|show|create|list|make|build|design|implement|fix|summari[sz]e|compare|analy[sz]e|describe|generate|convert|translate|help|tell|find|suggest|recommend|review|optimi[sz]e|refactor|add|remove|calculate|solve|draft|outline|rewrite|improve|check|debug|teach|walk)\s+(?:me|us|my|our|the|a|an|this|that|these|those|it|how|what|why|when|where|which|about|some|more|\d+|[a-z]{2,})\b/i,

    // "I need you to write X" is an instruction wearing a wrapper. The wrapper is
    // removed before classification so the verb underneath is seen.
    LEAD_IN: /^(?:so\s+|okay\s+|well\s+|and\s+|but\s+)?(?:please\s+)?(?:(?:i|we)\s+(?:need|want|would\s+like|'d\s+like)\s+(?:you\s+)?to\s+|(?:can|could|would|will)\s+you\s+(?:please\s+)?|(?:i|we)\s+(?:need|want)\s+|let'?s\s+|help\s+me\s+(?:to\s+)?)/i,

    // The sentence states a requirement about the output.
    CONSTRAINT: /\b(?:must|should|needs?\s+to|has\s+to|make\s+sure|ensure|include|exclude|avoid|format|at\s+least|no\s+more\s+than|\d+\s+words?|step[-\s]by[-\s]step|in\s+\w+\s+style|bullet\s+points?|tone)\b|^(?:you|your)\s+(?:will|must|should|shall|are|is|have|live|work|like|love|hate|speak|know|only|need\s+to|have\s+to|may|can)\b|^let'?s\b|^let\s+us\b|\bideally\b|\bpreferably\b|\b(?:would|'d)\s+(?:want|prefer|like)\b|\bi\s+prefer\b|^i\s+will\s+(?:say|tell|give|type|send|provide|ask|paste|share|be)\b/i,

    // The sentence reports a symptom: something is broken, failing or wrong.
    //
    // This is core content, not narrative. "The codes don't work properly and I don't
    // know why" IS the question -- the training corpus labels its own examples of this
    // shape ("my code throws a TypeError on line 42", "the API returns a 401") as
    // IMPORTANT -- but it asks for nothing and constrains nothing, so without this
    // pattern the rules classify it as non-core and hand it to the model. The model then
    // reads the "I have a doubt ... I don't know why" frame around it, calls it
    // removable at 0.95, and the user's actual problem is deleted while "help me"
    // survives. A sentence describing a malfunction is never offered to the model.
    PROBLEM: /\b(?:does\s*n[o']?t\s+work|do\s*n[o']?t\s+work|not\s+working|(?:not|n't)\s+able\s+to|unable\s+to|won'?t\s+(?:turn|start|boot|load|open|charge|connect)|gone\s+(?:blank|black|dead)|(?:screen|display)\s+(?:is\s+)?(?:blank|black)|is\s*n[o']?t\s+working|fails?|failing|failed|crash(?:es|ed|ing)?|throws?|threw|errors?|exception|traceback|bug|broken|breaks?|wrong|incorrect|inconsistent|unexpected|times?\s+out|timed\s+out|hangs?|freezes?|stuck|returns?\s+(?:a\s+|an\s+)?(?:\d{3}|null|undefined|nothing|empty|duplicate))\b/i,

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
        // Doubt about the question, not a fact about the user: "I don't know any
        // Japanese" is the constraint a Japan travel plan has to work around.
        /^(?:i|we)\s+(?:do\s+not|don't|did\s+not|didn't)\s+(?:really\s+)?(?:know|understand|get)\b(?!\s+(?:any|a\s+word\s+of|much)\s+[A-Z]?[a-z]+(?:ese|ish|ian|an|ch|ic)?\b(?<!\s(?:any|much)\s(?:of|about)))/i,
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
        // "I need notes for dma", "I want a summary": a stated need is the request.
        // Without these, "I have an exam tomorrow I need notes for dma" found no ask
        // once the exam clause was gone, and kept the whole prompt.
        'need', 'want',
        'what', 'why', 'how', 'when', 'where', 'which', 'who', 'whose',
        'can', 'could', 'should', 'would', 'will', 'is', 'are', 'do', 'does', 'did',
        'need', 'want', 'please'
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
        // "tomorrow is my exam", "monday is the deadline" -- the mirror image of the
        // clause above, with the occasion after the copula instead of in front of it.
        // Both word orders are common and neither implies the other, so both are listed.
        "(?:tomorrow|today|tonight|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next\\s+\\w+|this\\s+\\w+)\\s+(?:is|are|was|were|will\\s+be)\\s+(?:my|our|the|a|an)\\s+EVENT",
        // "my exam tomorrow", "our sem exams next month" -- no verb, just an announcement
        "(?:my|our)\\s+EVENT\\s+(?=(?:tomorrow|today|tonight|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next|this|in|on|are|is)\\b)",
        // "tomorrow I have an exam", "next week we have a viva"
        "(?:tomorrow|today|tonight|next\\s+\\w+|this\\s+\\w+)\\s+ME\\s+(?:have|has|'ve|got|will\\s+have)\\s+(?:an?\\s+|my\\s+|our\\s+|the\\s+)?EVENT",
        // "I am preparing for my exam", "I'm cramming for finals"
        "ME\\s*(?:BE\\s+)?(?:preparing|studying|revising|cramming|prepping|getting\\s+ready|gearing\\s+up|going\\s+to\\s+appear)\\s+for",
        // "I have to appear for the exam", "I need to submit this by monday"
        // Not "finish": "I need to finish it all in a month" is the time frame the advice
        // has to fit, and stripping it answered a different question.
        "ME\\s+(?:have|has|'ve|had|need|needs|want|wants)\\s+to\\s+(?:appear|sit|attend|submit|present|face|clear|pass|crack|score|top|ace|survive)\\b",
        // Time pressure. An LLM cannot act on a countdown.
        "ME\\s+(?:only\\s+)?(?:have|has|'ve|got|have\\s+got)\\s+(?:only\\s+|just\\s+|barely\\s+)?(?:\\d+|a\\s+few|very\\s+few|less\\s+than\\s+\\w+|one|two|three|four|five|six|seven|ten)\\s+(?:days?|hours?|weeks?|months?|minutes?|nights?)\\b",
        "MEBE\\s+(?:running\\s+out\\s+of\\s+time|short\\s+on\\s+time|out\\s+of\\s+time|pressed\\s+for\\s+time|in\\s+a\\s+hurry|in\\s+a\\s+rush)",
        "(?:there\\s+(?:is|are|'s)\\s+(?:no|not\\s+much|very\\s+little|hardly\\s+any)\\s+time|time\\s+is\\s+(?:short|running\\s+out|against\\s+me))",
        // Emotional and physical state.
        "(?:MEBE|ME\\s+(?:feel|feels|felt))\\s+(?:feeling\\s+)?(?:so\\s+|very\\s+|really\\s+|quite\\s+|kind\\s+of\\s+|kinda\\s+|a\\s+bit\\s+|a\\s+little\\s+|totally\\s+|completely\\s+|extremely\\s+|super\\s+)?(?:stressed|stressing|panicking|panicked|nervous|anxious|worried|scared|afraid|terrified|tired|exhausted|sleepy|burnt\\s+out|burned\\s+out|lost|confused|stuck|frustrated|overwhelmed|bored|lazy|desperate|helpless|hopeless|blank|clueless|freaking\\s+out|dying|screwed|doomed|cooked|struggling|suffering)(?!\\s+(?:that|about|if|whether|of|with|by|because|to|on|in)\\b)",
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
        "ME\\s+ADV(?:did\\s*n[o']?t|didn'?t|do\\s*n[o']?t|don'?t|have\\s*n[o']?t|haven'?t|has\\s*n[o']?t|hasn'?t|never|hardly|barely)\\s+ADV(?:attend|attended|study|studied|prepare|prepared|revise|revised|open|opened|touch|touched|listen|listened|show\\s+up|pay\\s+attention|understand|understood|get\\s+it|follow|grasp|remember)",
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
        // (?!...): the occasion word modifying a following noun is not an occasion --
        // "ideas for my final year project" lost "for my final" and read "ideas year".
        "\\s+(?:for|before|ahead\\s+of|in\\s+time\\s+for|because\\s+of)\\s+(?:my|our|the|this|next)\\s+(?:upcoming\\s+|big\\s+)?EVENT\\b(?!\\s+(?:year|yr|years|project|projects|round|version|draft|answer|report|presentation|thesis|submission|semester|sem|grade|class|term|stage|phase|level|step|product|design|model|code|output|results?|score|marks|topics?|syllabus|portion))(?:\\s+(?:tomorrow|today|tonight|next\\s+\\w+|this\\s+\\w+|on\\s+\\w+))?"
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
        // "now" and "also" open a clause often enough to be lead-ins, but they also sit
        // harmlessly inside one ("...for 2 months now"). Stopping a context clause on
        // them strands the word as its own sentence, so they are excluded here.
        const hardStop = connective.split('|').filter(w => w !== 'now' && w !== 'also').join('|');
        const stop = `(?:${ask}|${hardStop})`;
        // A dot only inside a token ("Node.js", "3.5"): as a token's last character it
        // is the sentence's full stop, and taking it glued the next sentence on --
        // "...before and I am panicking lol. Can you give me" became "before give me".
        // Nor into "I need ..." / "we want ...": a new clause that states the request,
        // run on without punctuation ("I have an exam tomorrow I need notes for dma").
        const tail = `(?:\\s+(?!${stop}\\b)(?!(?:i|we)\\s+(?:need|want|would|'d)\\b)[A-Za-z0-9$%'’/+#-]+(?:\\.[A-Za-z0-9]+)*){0,10}`;

        // A context clause is recognised in exactly two positions: at the start of a
        // clause, optionally behind one or two lead-ins ("so basically my professor
        // ..."), or mid-sentence behind a connective that opens a new clause without
        // punctuation ("I am a beginner and I have been learning Python ...").
        //
        // The second branch REQUIRES the connective. Without that requirement the
        // patterns would fire on ordinary subordinate clauses -- "explain what happens
        // when I have an exam" -- where the same words are part of the question.
        const leadIn = `(?:${connective}|anyway|basically|actually)`;
        // A lead-in may be followed by a comma rather than a space ("So basically, I am
        // in 3rd year ..."), which would otherwise strand it at the front of the prompt.
        const lead = `(?:(?<=^|[.!?;,]|\\n)\\s*(?:${leadIn}[,\\s]+){0,2}|(?<=\\s)(?:${leadIn}[,\\s]+){1,2})`;

        // Occasions are often named with a noun in front of a noun -- "project review",
        // "exam paper", "interview round" -- so a noun may also act as a modifier.
        const nouns = this.EVENT_NOUNS.join('|');
        const event = `(?:(?:${this.EVENT_ADJ.join('|')}|${nouns})\\s+){0,2}(?:${nouns})`;

        // "I'm" carries no space before the verb, so subject and copula are matched as
        // one token rather than as ME followed by BE.
        const meBe = `(?:i|we)(?:\\s*'m|\\s*'re|\\s+(?:am|are|is|was|were|been|m|re))`;

        // ADV is an optional adverb slot: "I honestly do not understand" reads as a clause
        // shape the negation patterns would otherwise miss.
        const adverb = "(?:honestly\\s+|really\\s+|actually\\s+|literally\\s+|still\\s+|simply\\s+|just\\s+|even\\s+|truly\\s+)?";

        const expand = (core) => core
            .replace(/EVENT/g, event)
            .replace(/\bMEBE\b/g, meBe)
            .replace(/\bADV\b/g, adverb)
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
        if (this.MID_ASK.test(text) || this.MID_NEED.test(text)) return true;

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
                out = out.replace(rx, (...args) => {
                    // Offset and string are the last two arguments whatever groups
                    // the pattern captures.
                    const [match] = args;
                    const offset = args[args.length - 2];
                    const whole = args[args.length - 1];
                    // A clause holding protected content is never removed, however
                    // situational it looks -- the span may be what the question is about.
                    if (match.indexOf(this.MASK_OPEN) !== -1) return match;
                    // Stopped short of a parenthetical: removing it would strand
                    // "(worth 30% of my grade!) and I need..." at the front.
                    if (/^\s*\(/.test(whole.slice(offset + match.length))) return match;
                    // The clause must end where something else begins: punctuation, a
                    // connective, or the request. Stopping mid-phrase strands the rest:
                    // "Everybody is hiring and I am tired of the retail management position
                    // I have been in for the last 5 years" became "Everybody is hiring the
                    // last 5 years" when the ten-word tail ran out before the clause did.
                    // Question words and auxiliaries are not a new start mid-sentence:
                    // "but I didn't really understand what they meant" left "what they
                    // meant" hanging off the sentence before.
                    this.situationalEnd = this.situationalEnd || new RegExp(
                        '^\\s*(?:$|[.,;:!?\\n)]|(?:so|and|but|because|since|then|also|now|however|therefore|plus|yet|can|could|would|will|please|i|we|'
                        + this.ASK_WORDS.filter((w) => !/^(?:what|why|how|when|where|which|who|whose|is|are|do|does|did|should|need|want|can|could|would|will|please)$/.test(w)).join('|')
                        + ')\\b)', 'i');
                    if (!this.situationalEnd.test(whole.slice(offset + match.length))) return match;
                    // The rest still points at what the clause named: "I forgot the
                    // password to my phone, is there a way to get it unlocked?" lost the
                    // phone and kept "it".
                    const remainder = whole.slice(0, offset) + ' ' + whole.slice(offset + match.length);
                    // Any clause, not only one that owns something: "i dont understand
                    // pointers in c can u explain it simply" became "Explain it simply".
                    // Only a pronoun AFTER the clause points back into it.
                    // and only as the thing acted on ("explain it", "get it unlocked"), not
                    // "make it short", where "it" is the answer.
                    // "My brother says you shouldn't put butter on a burn. Is this true?"
                    // came back as "Is this true?".
                    if (/\b(?:explain|fix|solve|unlock|reset|use|do|understand|get|open|repair|recover|find|describe|teach|clarify|simplify|check|debug|run|install)\s+(?:it|them|this|that|these|those)\b|\b(?:is|was|are)\s+(?:this|that|it)\s+(?:true|right|correct|normal|safe|real|possible|good|bad|a\s+myth)\b/i.test(whole.slice(offset + match.length))
                        && this.topicWords(match).some((w) => !/^(?:exams?|tests?|tomorrow|today|tonight|week|month|year|time|days?|hours?)$/.test(w)
                            && remainder.toLowerCase().indexOf(w) === -1)) return match;
                    // Nor may it be the main clause of a sentence that opened with a
                    // subordinate one: "When approaching a problem I don't know, I feel
                    // scared" lost its main clause and left "When approaching ... with."
                    if (/(?:^|[.!?]\s*)(?:when|whenever|while|if|although|though|because|since|as|after|before|once|whether)\b[^.!?]*,?\s*$/i
                        .test(whole.slice(0, offset))) return match;
                    // Second opinion: the pattern matched, but if the model reads this
                    // clause as the instruction itself, leave it alone.
                    if (this.mlVetoesRemoval(match)) return match;
                    // The occasion goes, its subject stays. "I have an exam tomorrow on
                    // operating systems so explain deadlocks" lost "operating systems"
                    // with the exam, and the guards below only ask that SOME topic is
                    // left. The subject becomes a heading instead: "Operating systems:".
                    const when = String.raw`(?:tomorrow|today|tonight|(?:next|this)\s+\w+|on\s+\w+day)`;
                    const notTopic = String.raw`(?!(?:tomorrow|today|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next|this|my|our|the|a|an|week|month|morning|evening)\b)`;
                    this.eventSubject = this.eventSubject || new RegExp(String.raw`\b(?:${this.EVENT_NOUNS.join('|')})\s+(?:${when}\s+)?(?:on|in|about|of)\s+((?:${notTopic}[A-Za-z0-9+#.'-]+\s*){1,6})(?:${when}\b)?[\s.,;!?]*$`, 'i');
                    const subject = this.eventSubject.exec(match);
                    if (subject) {
                        const rest = (whole.slice(0, offset) + ' ' + whole.slice(offset + match.length)).toLowerCase();
                        const missing = this.topicWords(subject[1])
                            .filter((w) => rest.indexOf(w) === -1);
                        // A short vowel-poor subject is an acronym: "dbms" -> "DBMS:", not "Dbms:".
                        const topic = subject[1].trim().replace(/^[A-Za-z]{2,5}$/,
                            (w) => (w.length <= 2 || !/[aeiou].*[aeiou]/i.test(w) ? w.toUpperCase() : w));
                        if (missing.length) return ' ' + topic + ': ';
                    }
                    return ' ';
                });
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
            // The same connective behind a kept subject heading ("Operating systems: so").
            .replace(/^([^:.!?\n]{1,60}:)\s*(?:so|and|but|because|since|then|also|now)\s+/i, '$1 ')
            .replace(/^[a-z]/, (c) => c.toUpperCase())
            .trim();

        // Guard 1: something must still be asked.
        if (!this.hasAsk(out)) return text;
        // Guard 2: the subject must not have left with the circumstances.
        if (this.topicWords(out).length === 0) return text;
        // Guard 4: the request is only a generic noun ("tips", "ideas", "advice") with
        // nothing saying what about, and the removed clause held the topic. "I am
        // preparing for my interview so can you give me some tips" became "Give tips".
        const GENERIC = /^(?:tips?|advice|ideas?|suggestions?|guidance|help|notes?|questions?|resources?|plan|strategy|strategies|recommendations?|some|me|give|share|list|suggest|provide|any|good|best|few)$/;
        const left = this.topicWords(out);
        if (left.length && left.every((word) => GENERIC.test(word))
            && !/\b(?:on|for|about|regarding|to|of)\s+\w/i.test(out)) return text;
        // Guard 3: the request points back at what was removed. "I am really confused
        // about pointers in C, can you explain them with a simple example" kept a topic
        // word ("example") and lost the topic: "Explain them with a simple example".
        if (/\b(?:explain|describe|teach|show|clarify|simplify|break\s+down|go\s+over|help\s+me\s+with|tell\s+me\s+about)\s+(?:them|it|this|that|these|those)\b/i.test(out)) {
            const kept = new Set(this.topicWords(out));
            if (this.topicWords(text).some((word) => !kept.has(word))) return text;
        }

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
    // A segment that carries DATA rather than prose.
    //
    // contentWords() only matches [a-z]+, so a line of numbers, a bracketed list or a
    // "Label: value" row has zero content words. The pruner read that as "introduces no
    // new subject matter" and dropped it, and the fragment test below finished the job
    // on anything three words or shorter. Measured over 4,000 real prompts that lost the
    // numbers in 2.0% of them and the operators in 1.4%:
    //
    //   "Output the 3rd and 7th element of the following list:\n[1, 5, 8, 11, 15, ...]"
    //     -> "Output the 3rd and 7th element of the following list"
    //
    // The request survived and the data it operates on did not, which leaves a prompt
    // that cannot be answered at all. Anything matching these is treated as core.
    DATA_SEGMENT: [
        /\d/,                          // any digit: quantities, dates, ids, versions
        /^\s*[-*•·]\s+\S/,   // a bullet
        /^\s*\w[\w \t/&'-]{0,40}:\s*\S/, // Label: value
        /[[\]{}|]/,                    // brackets, braces, table pipes
        /[<>=+*/^%]/,                  // operators
        /^[A-Za-z][\w+#.-]*$/,          // a bare item on its own line: Java, C++, Node.js
        /\S,\s*\S+,\s*\S/              // a comma-separated series
    ],

    /**
     * True when a segment is data the prompt operates on rather than prose about it.
     * @param {string} trimmed
     * @returns {boolean}
     */
    carriesData: function (trimmed) {
        // Answer options: "(B) foliate. (C) precipitate." were three-word fragments and
        // the multiple-choice question lost every option but the first.
        if (/^(?:\(?[A-Ha-h1-9]\)|[A-Ha-h1-9][.:]\s|[ivx]+\)\s)/.test(trimmed)) return true;
        return this.DATA_SEGMENT.some(rx => rx.test(trimmed));
    },

    classify: function (sentence) {
        const trimmed = sentence.trim();
        const bare = trimmed.replace(this.LEAD_IN, '');
        const protectedSpan = trimmed.indexOf(this.MASK_OPEN) !== -1;
        const data = this.carriesData(trimmed);
        // MID_ASK catches a request that does not open the sentence ("...tomorrow, teach
        // me ML"), which the anchored patterns cannot see. Every clause here widens what
        // counts as core, which only ever keeps MORE -- the safe direction.
        const asks = this.IMPERATIVE.test(bare) ||
            this.QUESTION_OPENER.test(trimmed) ||
            this.MID_ASK.test(trimmed) ||
            trimmed.indexOf('?') !== -1;
        // "Also between your and you're." continues the request before it; its words
        // are function words, so it looked empty and was dropped.
        const continues = /^(?:also|and also|plus|as well as|then)\b/i.test(trimmed);
        const constrains = this.CONSTRAINT.test(trimmed) || this.PROBLEM.test(trimmed) || continues;

        // A short leftover that asks for nothing is a fragment, not a sentence -- unless
        // it is data, where being short is normal. "Quantity: 3" and "C++" are three
        // words or fewer and are the whole point of the prompt they sit in.
        const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
        const fragment = !protectedSpan && !asks && !constrains && !data &&
            // A sentence opening with a preposition is a leftover only when no clause
            // follows: "In a coin toss game, you bet with a coin." and "In windows it
            // was impossible" were dropped as fragments.
            // "For the given input text, label the sentiment ..." was the instruction.
            ((this.FRAGMENT.test(trimmed) && wordCount <= 6
                && !/\b(?:it|you|he|she|they|we|i|there|this|that|which)\s+[a-z']+/i.test(trimmed))
                // Three words can be a whole sentence: "She prefers gin.", "You are
                // talkative.", "Be super succinct." A short leftover has no verb.
                || (wordCount <= 3
                    && !/\b(?:is|are|was|were|be|am|has|have|had|prefers?|likes?|loves?|hates?|wants?|needs?|uses?|works?|lives?|added|removed|taken|eaten)\b/i.test(trimmed)
                    && !/^(?:be|do|use|keep|make|add|give|show|list|write|stay|avoid|answer|reply|respond|include|go|stop|start)\b/i.test(trimmed)));

        return {
            protectedSpan: protectedSpan,
            data: data,
            core: protectedSpan || asks || constrains || data,
            lowValue: fragment || (!data && this.LOW_VALUE.some(rx => rx.test(trimmed)))
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
    pruneNarrative: function (sentences, minNewTerms) {
        // Caller-supplied floor, so an aggressive pass can keep less.
        const threshold = minNewTerms || this.MIN_NEW_TERMS;
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

        // A sentence the next one leans on. "There's a girl in my class... It's normal,
        // right?" and "Beavers live near rivers. What do they build?" lost their first
        // sentence and left a pronoun pointing at nothing.
        // Also "this view", "that claim" anywhere in the next sentence: "Renewable energy
        // is the future. Give arguments for and against this view." lost its first half.
        const REFERS_BACK = /^\W*(?:it|it's|its|this|that|these|those|they|they're|them|their|he|she|his|her|him)\b|\b(?:he|she|they|him|them|his|her|their)\b|\b(?:this|that|these|those)\s+(?:views?|opinions?|ideas?|claims?|statements?|points?|arguments?|approach|situation|problems?|issues?|case|topic|question|text|plan|belief|theory|assumption|stance|position)\b/i;
        // "it" or "this" acted on later points back too: "My hair is damaged due to hair
        // dye. What is the best product to restore it?" lost the hair.
        const ACTS_ON_IT = /\b(?:restore|fix|repair|treat|cure|clean|improve|use|solve|handle|stop|prevent|get\s+rid\s+of|deal\s+with|remove|replace|reset|unlock|recover|explain|categori[sz]e|classify|label|rate|translate|summari[sz]e|rewrite|correct|proofread|analy[sz]e|check|review)\s+(?:it|them|this|that)\b|\b(?:is|was|are)\s+(?:this|that|it)\s+(?:true|right|correct|normal|safe|real|possible|good|bad|a\s+myth)\b/i;
        const leanedOn = (index) => index + 1 < classified.length
            && (REFERS_BACK.test(classified[index + 1].text)
                || classified.slice(index + 1).some((later) => ACTS_ON_IT.test(later.text)));

        // A question that only makes sense with what came before it ("What could be the
        // reason?", "How do I fix it?") makes every earlier sentence its subject.
        // "For some reasons I can't open my company's website. I'm sure my internet is
        // working fine. What could be the reason?" was cut to the last sentence alone.
        // "I have had dengue fever and was told a second infection is worse. How is
        // that, and am I affected by this?" -- the question is about the sentence before.
        const ABOUT_THAT = /\b(?:how|why)\s+(?:is|was|does|did|would|could)\s+(?:that|this|it)\b|\bis\s+(?:that|this|it)\s+(?:true|right|correct|normal|possible|safe|real|bad|good)\b|\b(?:by|about|with)\s+(?:this|that)\s*[?.!]?$/i;
        const FIRST_PERSON = /\b(?:i|i'm|im|i've|i'd|i'll|me|my|mine|myself|we|we're|we've|our|ours|us)\b/i;
        const NUMBER = /\d|\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|hundred|thousand|million|half|twice|double|triple|dozen)\b/i;
        const DEPENDENT_ASK = /\b(?:the\s+(?:reason|cause|problem|issue|fix|solution)|what\s+(?:should|can|could)\s+i\s+do|how\s+(?:do|can|should)\s+i\s+(?:fix|solve|stop|handle)\s+(?:it|this|that)|why\s+(?:is|does|did|would)\s+(?:it|this|that)|what(?:'s|\s+is)\s+(?:wrong|happening|going\s+on))\b/i;
        // Advice for the user's own situation: the situation is the input. "I've been
        // looking to get a raise. My work ethic is very high and I always deliver. What
        // should I say to my boss?" lost both facts the answer was meant to use.
        const ADVICE = /\b(?:what\s+should\s+i\s+(?:say|tell|write|ask|do|choose|pick|buy|use|study|learn)|should\s+i\b|what\s+(?:would|do)\s+you\s+(?:suggest|recommend|advise)|how\s+(?:do|can|should)\s+i\s+(?:convince|persuade|negotiate|ask|approach|tell|handle|deal|respond|reply))|\b(?:recommend|suggest|advise)\b[^.?!]*\b(?:i|me|my)\b/i;
        // The request works on text the prompt supplies: "Categorize this sentence ...
        // I am so proud of the work I did today." lost the sentence to be categorised.
        const PAYLOAD = /\b(?:this|these|the\s+following|following|below|above|given)\s+(?:sentences?|texts?|paragraphs?|passages?|reviews?|tweets?|statements?|emails?|messages?|posts?|comments?|story|stories|poems?|essays?|articles?|code|data|lists?|words?|phrases?|quotes?|lines?|questions?)\b/i;
        // A request that names no subject of its own -- "Write a conclusion for me",
        // "Give me a name for it" -- takes its subject from the rest of the prompt.
        // "I am doing a project on twitter sentiment analysis. Can you write a
        // conclusion for me" came back as "Write a conclusion".
        const DELIVERABLE = new Set(['conclusion', 'introduction', 'intro', 'summary', 'essay', 'report',
            'answer', 'code', 'email', 'letter', 'story', 'poem', 'abstract', 'title', 'titles', 'name',
            'names', 'ideas', 'idea', 'plan', 'outline', 'list', 'description', 'caption', 'bio', 'paragraph',
            'review', 'response', 'reply', 'script', 'program', 'function', 'solution', 'explanation',
            'tips', 'advice', 'suggestions', 'help', 'something', 'one', 'it', 'this', 'that']);
        const subjectless = !classified.some((entry) => entry.info.core
            && this.topicWords(entry.text).some((w) => !DELIVERABLE.has(w) && w.length > 2));
        const dependent = subjectless || classified.some((entry) => entry.info.core
            && (DEPENDENT_ASK.test(entry.text) || ABOUT_THAT.test(entry.text) || ADVICE.test(entry.text)
                || PAYLOAD.test(entry.text)
                // "Where is the cup, and how many items are in it?" is answered by
                // every step of the story; "What jobs would that lead to?" by the
                // sentence "that" stands for.
                || /\b(?:where\s+(?:is|are|was|were)|how\s+many|how\s+much|who\s+(?:has|is|won|wins)|what\s+(?:colou?r|happened|happens))\b/i.test(entry.text)
                || /\b(?:would|will|does|did|can|could|is|was)\s+(?:that|this)\b/i.test(entry.text)
                // A bare short question ("Where is water?", "Who won?") is about the
                // story told before it, and every step of the story can be the answer.
                || (/\?\s*$/.test(entry.text) && entry.text.split(/\s+/).length <= 7)
                // A question about the user ("What rating would I give ...?") is
                // answered from what they said about themselves.
                || /\b(?:would|should|could|will|do|did|am)\s+i\b|\bfor\s+someone\s+like\s+me\b/i.test(entry.text)
                // "Please help me." alone asks for help with what came before it.
                || /^(?:please\s+)?help\s+(?:me|us)\s*[.!?]?$/i.test(entry.text.trim())));

        // A sentence stating a problem is the situation being asked about, not backstory.
        const PROBLEM = /\b(?:can'?t|cannot|won'?t|doesn'?t|isn'?t|not\s+working|unable|error|fails?|failed|failing|broken|crash(?:es|ed|ing)?|stuck|freez(?:es|ing)|slow|issue|problem|bug)\b/i;

        const kept = classified.filter((entry, index) => {
            // A sentence that asks, constrains, or holds protected content is the
            // user's request. The rules keep it and the model is never asked.
            if (entry.info.core) return true;
            if (leanedOn(index)) return true;
            if (dependent || PROBLEM.test(entry.text)) return true;
            // A premise. Backstory is about the USER -- their week, their mood, their
            // history -- and is written in the first person. A sentence about anything
            // else is a fact the request is built on: "In a coin toss game, you bet with
            // a coin. If you win, you will get a coin. ... What is the expected value?"
            // came back as the last sentence alone, and "A carton has six eggs. Two are
            // added. ..." lost "Two are added" -- the puzzle without its numbers.
            if (NUMBER.test(entry.text)) return true;
            // A claim the user wants checked: "I've read that hydrogen peroxide is the
            // best way, but I'm not sure." is the question, not doubt.
            if (/\b(?:read|heard|told|saw|says?|said|claims?|thought)\s+(?:that|somewhere|online)\b/i.test(entry.text)) return true;
            if (!FIRST_PERSON.test(entry.text) && !entry.info.lowValue) return true;

            if (entry.info.lowValue) {
                // Rules say drop. The model may veto.
                return this.mlVetoesRemoval(entry.text);
            }

            // Keep a non-core sentence only if it carries genuinely new subject matter.
            const fresh = entry.words.filter(word => !known.has(word));
            if (fresh.length >= threshold) {
                // Rules say keep. The model may propose dropping it -- new vocabulary
                // is not the same as new information, and this is where a blacklist is
                // blind: "I have been revising all night for tomorrow" introduces four
                // unseen words and says nothing the model can act on.
                // Never a stated goal: "I want to remotely control my RaspberryPi from
                // kilometers away, independent from mobile service" is the spec the
                // answer has to meet, and the model called it removable at >0.9.
                // Nor what the user already has: "I have a users table and a transactions
                // table" is the starting point of the schema they asked for.
                const goal = /\b(?:want|need|trying|try|goal\s+is|would\s+like|'d\s+like|planning|plan|hoping|aim)\s+to\b|\b(?:i|we)\s+(?:have|already\s+have|got|made|wrote|created|built|use|am\s+using|are\s+using)\s+(?:a|an|the|some|two|three|this|these|my|our)\b/i;
                // Nor a sentence that shares its subject with the rest of the prompt: the
                // model is for chit-chat ("my cousin adopted two cats"), and it removed
                // "Sometimes I have apple cores sitting out" from "Why do the apple cores
                // change color?" and "My friend thinks pineapple on pizza is bad" from an
                // argument about pineapple on pizza.
                const elsewhere = new Set();
                classified.forEach((other) => {
                    if (other !== entry) other.words.forEach((w) => elsewhere.add(w));
                });
                const shared = entry.words.some((w) => w.length > 3 && elsewhere.has(w));
                if (!goal.test(entry.text) && !shared && this.mlProposesRemoval(entry.text)) return false;

                fresh.forEach(word => known.add(word));
                return true;
            }

            // Rules say drop: no request, no new subject matter. The model may veto.
            return this.mlVetoesRemoval(entry.text);
        });

        // Never return nothing: if every sentence looked droppable, keep the original.
        return kept.length > 0 ? kept.map(entry => entry.text) : sentences;
    },

    /**
     * Shortens a long, rambling prompt. Short prompts are returned untouched.
     * @param {string} text - Masked prompt text.
     * @returns {string} Condensed text.
     */
    condense: function (text, options) {
        if (!text) return text;

        // Thresholds are overridable so a caller can ask for a harder pass without this
        // module having to know what a compression tier is. Omitting them gives exactly
        // what every existing caller got, so the seam changes nothing by existing.
        const minWords = (options && options.minWords) || this.MIN_WORDS;
        const minNewTerms = (options && options.minNewTerms) || this.MIN_NEW_TERMS;

        text = text.replace(/[ \t]+/g, ' ').trim();

        // Every rule below reads English through [a-z]. A Malayalam or Japanese sentence
        // has no content words to it, so it looked like pure narrative and was dropped:
        // a three-sentence Malayalam request came back as its first sentence. Text this
        // module cannot read is text it must not prune.
        const letters = text.match(/\p{L}/gu) || [];
        const latin = text.match(/\p{Script=Latin}/gu) || [];
        if (letters.length && latin.length / letters.length < 0.65) return text;

        const wordCount = text.split(/\s+/).filter(Boolean).length;
        if (wordCount < minWords) return text;

        const sentences = this.splitSentences(text);
        if (sentences.length < 2) return text;

        // Which segments began a new line in the original. Joining everything with a
        // space flattened "Item: Apple iPad Pro\nQuantity: 3" into one run, which reads
        // as a single garbled value rather than two fields -- the request survives and
        // its shape does not. Keyed by text rather than index on purpose: mergeRepeats
        // rewrites some segments, and a rewritten one simply misses the lookup and
        // falls back to a space, which is the safe direction.
        const startedLine = new Set();
        text.split(/\n+/).forEach((line, index) => {
            const first = this.splitSentences(line)[0];
            if (index > 0 && first) startedLine.add(first.trim());
        });

        const condensed = this.pruneNarrative(this.mergeRepeats(sentences), minNewTerms);
        return condensed
            .map((part, index) => (
                index > 0 && startedLine.has(part.trim()) ? '\n' + part : part
            ))
            .join(' ')
            .replace(/[ \t]+/g, ' ')
            .replace(/[ \t]*\n[ \t]*/g, '\n')
            .trim();
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

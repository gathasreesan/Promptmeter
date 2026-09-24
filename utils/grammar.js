/**
 * PromptMeter Grammar Engine
 *
 * Finds and repairs the grammatical errors people actually make when typing a prompt in
 * a hurry, and reports each one so the UI can say what was wrong rather than silently
 * rewriting the user's words.
 *
 * Why a rule engine and not the classifier: the model in ml-classifier.js answers a
 * judgement call -- "does this sentence carry the instruction?" -- where reasonable
 * people disagree. Grammar is the opposite: "he go" is wrong, "he goes" is right, and
 * there is nothing to learn. A rule over a closed word class is exact and auditable
 * where a statistical model would invent corrections.
 *
 * Every rule follows the same contract:
 *
 *   PRECISION OVER RECALL   A wrong "correction" corrupts the user's meaning, which is
 *                           worse than leaving an error in place. Rules fire on closed
 *                           classes (pronouns, modals, known verbs) and decline anything
 *                           ambiguous. Where a pattern has a legitimate reading -- "a bug
 *                           that affects users", "send it to many people", "all it does
 *                           is print" -- the rule is narrowed until that reading is safe.
 *   REPORT WHAT CHANGED     Every edit records an issue describing it, so corrections are
 *                           visible and reviewable rather than invisible.
 *
 * Runs on masked text: placeholders (U+E000...U+E001) are not word characters, so no
 * rule below can reach inside code, a URL or a quoted span.
 */
const PromptMeterGrammar = {

    MASK_OPEN: '\uE000',
    MASK_CLOSE: '\uE001',

    // ---------------------------------------------------------------------------
    // Word classes. Closed sets on purpose -- see the precision contract above.
    // ---------------------------------------------------------------------------

    // Inflected form -> base form, for verbs the -s rule cannot undo.
    IRREGULAR_BASE: {
        'has': 'have', 'had': 'have', 'is': 'be', 'are': 'be', 'am': 'be', 'was': 'be',
        'were': 'be', 'been': 'be', 'does': 'do', 'did': 'do', 'goes': 'go', 'went': 'go',
        'says': 'say', 'makes': 'make', 'takes': 'take', 'comes': 'come', 'knows': 'know',
        'gets': 'get', 'gives': 'give', 'finds': 'find', 'thinks': 'think',
        'tells': 'tell', 'becomes': 'become', 'leaves': 'leave', 'feels': 'feel',
        'brings': 'bring', 'begins': 'begin', 'keeps': 'keep', 'holds': 'hold',
        'writes': 'write', 'wrote': 'write', 'written': 'write', 'stands': 'stand',
        'hears': 'hear', 'means': 'mean', 'meets': 'meet', 'runs': 'run', 'pays': 'pay',
        'sits': 'sit', 'speaks': 'speak', 'leads': 'lead', 'grows': 'grow',
        'loses': 'lose', 'sends': 'send', 'builds': 'build', 'understands': 'understand',
        'draws': 'draw', 'breaks': 'break', 'spends': 'spend', 'chooses': 'choose',
        'reads': 'read', 'buys': 'buy', 'teaches': 'teach', 'catches': 'catch',
        'throws': 'throw', 'sells': 'sell', 'shows': 'show', 'eats': 'eat',
        'sees': 'see', 'seeks': 'seek', 'deals': 'deal'
    },

    // Base -> third-person singular, where adding -s alone gets it wrong.
    IRREGULAR_THIRD: {
        'be': 'is', 'have': 'has', 'do': 'does', 'go': 'goes', 'can': 'can',
        'will': 'will', 'may': 'may', 'must': 'must', 'shall': 'shall'
    },

    // Verbs whose past tense is spelled like the base form. An agreement rule cannot
    // tell "she read the book yesterday" from "she read books" and so leaves them alone.
    AMBIGUOUS_PAST: new Set(['read', 'set', 'put', 'cut', 'let', 'hit', 'cost', 'hurt',
        'shut', 'split', 'spread', 'quit', 'bet', 'burst', 'cast']),

    // Verbs a pronoun subject may be followed by. Restricting the agreement rules to
    // this list is what stops them mangling noun phrases: in "the works of Shakespeare"
    // the word follows a determiner rather than a pronoun, so no rule below can see it.
    VERBS: new Set(['be', 'have', 'do', 'go', 'get', 'make', 'know', 'think', 'take',
        'see', 'come', 'want', 'look', 'use', 'find', 'give', 'tell', 'work', 'call',
        'try', 'ask', 'need', 'feel', 'become', 'leave', 'put', 'mean', 'keep', 'let',
        'begin', 'seem', 'help', 'talk', 'turn', 'start', 'show', 'hear', 'play', 'run',
        'move', 'like', 'live', 'believe', 'hold', 'bring', 'happen', 'write', 'provide',
        'sit', 'stand', 'lose', 'pay', 'meet', 'include', 'continue', 'set', 'learn',
        'change', 'lead', 'understand', 'watch', 'follow', 'stop', 'create', 'speak',
        'read', 'spend', 'grow', 'open', 'walk', 'win', 'teach', 'offer', 'remember',
        'consider', 'appear', 'buy', 'serve', 'send', 'build', 'stay', 'fall',
        'cut', 'reach', 'remain', 'suggest', 'raise', 'pass', 'sell', 'require',
        'report', 'decide', 'pull', 'return', 'explain', 'hope', 'develop', 'carry',
        'break', 'receive', 'agree', 'support', 'produce', 'eat', 'cover',
        'catch', 'draw', 'choose', 'cause', 'listen', 'realize', 'wonder',
        'check', 'fix', 'add', 'remove', 'compare', 'convert', 'generate', 'analyze',
        'summarize', 'design', 'implement', 'refactor', 'debug', 'optimize', 'review',
        'solve', 'calculate', 'describe', 'define', 'improve', 'train', 'test',
        'deploy', 'install', 'render', 'parse', 'store', 'fetch',
        'handle', 'process', 'validate', 'update', 'delete', 'insert',
        'connect', 'load', 'save', 'print', 'display', 'search']),

    // Contractions typed without their apostrophe. Kept here rather than in the
    // optimizer because a missing apostrophe is a grammatical error in its own right,
    // and because every agreement rule below needs the apostrophe already in place:
    // "doesnt works" is invisible to a pattern written against "doesn't".
    CONTRACTIONS: {
        'im': "I'm", 'dont': "don't", 'cant': "can't", 'wont': "won't",
        'ive': "I've", 'youre': "you're", 'theyre': "they're", 'isnt': "isn't",
        'arent': "aren't", 'doesnt': "doesn't", 'didnt': "didn't", 'wasnt': "wasn't",
        'werent': "weren't", 'havent': "haven't", 'hasnt': "hasn't",
        'couldnt': "couldn't", 'wouldnt': "wouldn't", 'shouldnt': "shouldn't",
        'whats': "what's", 'theres': "there's", 'thats': "that's",
        'youll': "you'll", 'theyll': "they'll", 'weve': "we've", 'youve': "you've"
        // "were", "id", "ill" and "lets" are deliberately absent: each is an ordinary
        // English word, so expanding it would corrupt correct text far more often than
        // it would repair a missing apostrophe.
    },

    // Nouns with no plural form. "informations" and "datas" are the classic tells.
    UNCOUNTABLE: {
        'informations': 'information', 'datas': 'data', 'softwares': 'software',
        'hardwares': 'hardware', 'advices': 'advice', 'equipments': 'equipment',
        'researches': 'research', 'feedbacks': 'feedback', 'knowledges': 'knowledge',
        'furnitures': 'furniture', 'luggages': 'luggage',
        'evidences': 'evidence', 'homeworks': 'homework',
        'moneys': 'money', 'musics': 'music',
        'traffics': 'traffic', 'weathers': 'weather',
        'vocabularies': 'vocabulary', 'literatures': 'literature'
    },

    // Plurals people regularise by mistake.
    IRREGULAR_PLURAL: {
        'childs': 'children', 'childrens': 'children', 'mans': 'men', 'mens': 'men',
        'womans': 'women', 'womens': 'women', 'peoples': 'people',
        'foots': 'feet', 'teeths': 'teeth', 'criterias': 'criteria',
        'phenomenas': 'phenomena', 'analysises': 'analyses', 'thesises': 'theses',
        'matrixs': 'matrices', 'vertexs': 'vertices', 'datums': 'data'
    },

    // Proper nouns and technologies that belong capitalised. The map is matched
    // case-sensitively against the lowercase spelling only: a user who typed "Python"
    // or "PYTHON" meant it, and a mid-sentence capital may be a real name.
    PROPER_NOUNS: {
        'python': 'Python', 'javascript': 'JavaScript', 'typescript': 'TypeScript',
        'java': 'Java', 'kotlin': 'Kotlin', 'golang': 'Go',
        'rust': 'Rust', 'php': 'PHP', 'perl': 'Perl', 'scala': 'Scala',
        'haskell': 'Haskell', 'matlab': 'MATLAB', 'react': 'React', 'angular': 'Angular',
        'svelte': 'Svelte', 'django': 'Django', 'flask': 'Flask',
        'laravel': 'Laravel', 'nodejs': 'Node.js',
        'pytorch': 'PyTorch', 'tensorflow': 'TensorFlow',
        'keras': 'Keras', 'numpy': 'NumPy', 'sklearn': 'scikit-learn',
        'docker': 'Docker', 'kubernetes': 'Kubernetes', 'linux': 'Linux',
        'ubuntu': 'Ubuntu', 'macos': 'macOS', 'android': 'Android',
        'github': 'GitHub', 'gitlab': 'GitLab', 'mysql': 'MySQL',
        'postgres': 'PostgreSQL', 'postgresql': 'PostgreSQL', 'sqlite': 'SQLite',
        'mongodb': 'MongoDB', 'redis': 'Redis', 'firebase': 'Firebase',
        'azure': 'Azure', 'powerpoint': 'PowerPoint',
        'photoshop': 'Photoshop', 'figma': 'Figma', 'chatgpt': 'ChatGPT',
        'openai': 'OpenAI', 'anthropic': 'Anthropic', 'microsoft': 'Microsoft',
        'english': 'English', 'spanish': 'Spanish', 'french': 'French',
        'german': 'German', 'hindi': 'Hindi', 'chinese': 'Chinese',
        'japanese': 'Japanese', 'arabic': 'Arabic',
        'january': 'January', 'february': 'February', 'april': 'April',
        'june': 'June', 'july': 'July', 'august': 'August', 'september': 'September',
        'october': 'October', 'november': 'November', 'december': 'December',
        'monday': 'Monday', 'tuesday': 'Tuesday', 'wednesday': 'Wednesday',
        'thursday': 'Thursday', 'friday': 'Friday', 'saturday': 'Saturday',
        'sunday': 'Sunday'
    },

    // ---------------------------------------------------------------------------
    // Rule tables. Each row is [pattern, replacement, explanation].
    // ---------------------------------------------------------------------------

    /**
     * Confusable word pairs, disambiguated by the words around them.
     *
     * Each pattern is narrowed until the legitimate reading of the same words is safe.
     * "there" is only rewritten to "their" in front of a noun it could not modify;
     * "than" is never rewritten to "then", because "better than I can" is correct.
     */
    CONFUSABLES: [
        // their / there / they're
        [/\bthere\s+(?=(?:own|house|home|car|books?|jobs?|names?|code|work|ideas?|answers?|team|parents|friends|kids|children|data|problems?)\b)/gi,
            'their ', "'there' (a place) should be 'their' (belonging to them)"],
        [/\bthere\s+going\s+to\b/gi, "they're going to", "'there going' should be 'they're going'"],
        [/\btheir\s+(?=(?:is|are|was|were)\b)/gi, 'there ', "'their' should be 'there' before is/are"],
        [/\bthey're\s+(?=(?:own|house|home|car|books?|jobs?|names?|code|work|ideas?|answers?|team|parents|friends|kids|children)\b)/gi,
            'their ', "'they're' (they are) should be 'their' (belonging to them)"],
        [/\bthier\b/gi, 'their', "'thier' is a misspelling of 'their'"],

        // its / it's
        [/\bits\s+(?=(?:a|an|the|not|been|going|important|possible|clear|better|worth|hard|easy|time|good|bad|fine|ready|done|correct|wrong|useful|working|broken|available|enough|still|just|only|really|very|too)\b)/gi,
            "it's ", "'its' (possessive) should be 'it's' (it is)"],
        [/\bit's\s+(?=(?:own|value|name|size|type|purpose|length|contents?|output|input|results?|performance|accuracy|behaviou?r|structure)\b)/gi,
            'its ', "'it's' (it is) should be 'its' (possessive)"],

        // your / you're. "your right" and "your wrong" are deliberately absent: "your
        // right hand" and "your wrong answer" are both ordinary possessives.
        [/\byour\s+(?=(?:a|an|the|going|welcome|correct|sure|able|not)\b)/gi,
            "you're ", "'your' (possessive) should be 'you're' (you are)"],
        [/\byou're\s+(?=(?:answers?|response|code|output|reply|help|time|opinion|name|task|job|turn|version|model|analysis|suggestions?)\b)/gi,
            'your ', "'you're' (you are) should be 'your' (possessive)"],

        // whose / who's
        [/\bwho's\s+(?=(?:name|job|code|turn|fault|idea|book|car|house)\b)/gi,
            'whose ', "'who's' (who is) should be 'whose' (possessive)"],

        // then / than. Only the comparative direction is safe to correct: "faster then"
        // is always wrong, while "than I can" is always right.
        [/\b(better|worse|faster|slower|more|less|larger|smaller|bigger|greater|higher|lower|cheaper|older|newer|easier|harder|rather|other|longer|shorter|stronger|weaker)\s+then\b/gi,
            '$1 than', "'then' should be 'than' after a comparison"],

        // loose / lose
        [/\bloose\s+(?=(?:the|a|an|my|your|our|their|his|her|its|this|that|it|them|data|points?|money|time|track|weight|connection|access)\b)/gi,
            'lose ', "'loose' (not tight) should be 'lose' (to misplace)"],

        // affect / effect. "this"/"that" are excluded from the noun rule -- "a bug that
        // affects users" is a relative clause, not a determiner plus noun.
        [/\b(the|an|any|no|some|side|positive|negative|main|overall)\s+affects?\b/gi,
            (m, det) => `${det} effect${/affects\b/i.test(m) ? 's' : ''}`,
            "'affect' (verb) should be 'effect' (noun)"],
        [/\b(it|they|these|those)\s+effects?\s+(?=(?:the|a|an|your|our|my|his|her|its|how|what)\b)/gi,
            (m, subj) => `${subj} affect${/^(?:it)$/i.test(subj) ? 's' : ''} `,
            "'effect' (noun) should be 'affect' (verb)"],

        // to / too. "to many people" and "to complex systems" are valid prepositional
        // phrases, so the bare adjective list is not enough -- each rule below needs
        // either a copula in front or a following "to" to rule that reading out.
        [/\bto\s+much\b/gi, 'too much', "'to much' should be 'too much'"],
        [/\b(is|are|was|were|be|been|seems?|looks?|feels?|gets?|got)\s+to\s+(?=(?:many|little|few|long|short|big|small|late|early|slow|fast|hard|easy|expensive|complicated|complex|simple|difficult|broad|narrow|vague|general|specific)\b)/gi,
            '$1 too ', "'to' should be 'too' (excessively)"],
        [/\bto\s+(many|long|short|big|small|late|early|slow|fast|hard|easy|expensive|complicated|complex|difficult|broad|narrow|vague|general|specific)\s+(?=to\b)/gi,
            'too $1 ', "'to' should be 'too' (excessively)"],

        // Assorted fixed expressions with no competing reading.
        [/\bdefinately\b/gi, 'definitely', "'definately' is a misspelling of 'definitely'"],
        [/\b(should|could|would|must|might)\s+of\b/gi, '$1 have', "'$1 of' should be '$1 have'"],
        [/\balot\b/gi, 'a lot', "'alot' is two words: 'a lot'"],
        [/\beveryday\s+(?=(?:i|we|you|they|he|she|it)\b)/gi, 'every day ',
            "'everyday' (ordinary) should be 'every day' (each day)"],

        // Countable vs uncountable quantifiers. "fewer" counts items, "less" measures a
        // mass, and the same split separates "number" from "amount". Both fire only in
        // front of an explicit plural noun, which is the unambiguously wrong case --
        // "use less memory" and "the amount of data" are correct and are left alone.
        [/\bless\s+(?=(?:files|items|errors|bugs|users|records|rows|lines|tests|steps|words|tokens|people|things|options|results|changes|requests|queries|examples|columns|fields|pages|characters)\b)/gi,
            'fewer ', "'less' measures a mass; use 'fewer' for things you can count"],
        [/\bamount\s+of\s+(?=(?:files|items|errors|bugs|users|records|rows|lines|tests|steps|words|tokens|people|things|options|results|changes|requests|queries|examples|columns|fields|pages|characters)\b)/gi,
            'number of ', "'amount of' measures a mass; use 'number of' for countable things"],

        // An object pronoun follows a preposition: "between you and me", not "and I".
        // Anchored to the preposition, so an ordinary compound subject ("you and I should
        // meet") is untouched.
        [/\b(between|among|amongst|with|for|to|from|like|besides|without)\s+(\w+\s+and)\s+I\b/g,
            '$1 $2 me', "after a preposition the pronoun is 'me', not 'I'"],

        [/\bcould\s+care\s+less\b/gi, "couldn't care less",
            "'could care less' states the opposite of what is meant"]
    ],

    /**
     * Verb-frame, preposition and redundancy errors: the words are spelled correctly but
     * the pattern around them is wrong. These are exactly the errors a spell checker
     * passes over untouched.
     */
    FRAME_FIXES: [
        [/\bexplain\s+(?:me|us)\s+(?:about\s+)?/gi, 'explain ', "'explain me about X' should be 'explain X'"],
        [/\bexplain\s+about\b/gi, 'explain', "'explain about' should be 'explain'"],
        // "explain to me how X works" -- the indirect object is the model's only possible
        // audience, so naming it carries nothing. Anchored to a following word so
        // "explain it to me" and "explain to me and my team" are untouched.
        [/\bexplain\s+to\s+me\s+(?=(?:how|what|why|when|where|which|the|a|an|this|that|in|simply)\b)/gi,
            'explain ', "'explain to me X' should be 'explain X'"],
        [/\b(discuss|describe|mention|emphasi[sz]e)\s+(?:about|on)\b/gi, '$1', "'$1 about' should be just '$1'"],
        [/\b(compris(?:es|e|ed))\s+of\b/gi, '$1', "'comprise of' should be 'comprise'"],
        [/\b(return|reply|revert)\s+back\b/gi, '$1', "'$1 back' is redundant"],
        [/\brepeat\s+again\b/gi, 'repeat', "'repeat again' is redundant"],
        [/\b(?:in|at)\s+the\s+meanwhile\b/gi, 'meanwhile', "'in the meanwhile' should be 'meanwhile'"],
        [/\bcapable\s+to\b/gi, 'capable of', "'capable to' should be 'capable of'"],
        [/\bmore\s+(better|worse|faster|slower|easier|harder|higher|lower|bigger|smaller)\b/gi,
            '$1', "'more $1' is a double comparative"],
        [/\bmost\s+(best|worst|fastest|slowest|easiest|hardest|simplest)\b/gi,
            '$1', "'most $1' is a double superlative"],
        // Double negatives. The negated quantifier becomes its positive-polarity form.
        [/\b(don'?t|doesn'?t|didn'?t|can'?t|won'?t|couldn'?t|shouldn'?t|wouldn'?t|isn'?t|aren'?t)\s+((?:have|get|see|know|want|need|do)\s+)?(no|none|nothing|never)\b/gi,
            (m, neg, verb, quantifier) => {
                const positive = { no: 'any', none: 'any', nothing: 'anything', never: 'ever' };
                return `${neg} ${verb || ''}${positive[quantifier.toLowerCase()]}`;
            },
            'double negative'],
        // An uncountable noun takes no article -- but only where it is the head of the
        // phrase. "an information system" and "a feedback loop" are compound nouns and
        // must survive, so the noun has to be followed by a clause boundary.
        [/\b(?:a|an)\s+(advice|information|feedback|homework|knowledge|evidence|luggage|furniture)\b(?=\s*(?:[.,;:!?]|$|\s+(?:about|on|for|from|regarding|to|that|which|please)\b))/gi,
            '$1', "uncountable nouns take no 'a'/'an'"]
    ],

    // ---------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------

    /**
     * Compiles a lookup map into one word-bounded alternation regex, longest key first
     * so overlapping keys resolve to the more specific match.
     * @param {Object} map - Lookup table of term -> replacement.
     * @param {string} flags - Regex flags.
     * @returns {RegExp}
     */
    buildMap: function (map, flags) {
        const keys = Object.keys(map)
            .sort((a, b) => b.length - a.length)
            .map(k => k.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&'));
        return new RegExp('\\b(?:' + keys.join('|') + ')\\b', flags);
    },

    /**
     * Third-person singular form of a verb ("go" -> "goes", "try" -> "tries").
     * @param {string} base
     * @returns {string}
     */
    thirdPerson: function (base) {
        const lower = base.toLowerCase();
        if (this.IRREGULAR_THIRD[lower]) return this.IRREGULAR_THIRD[lower];
        if (/(?:s|sh|ch|x|z|o)$/.test(lower)) return lower + 'es';
        if (/[^aeiou]y$/.test(lower)) return lower.slice(0, -1) + 'ies';
        return lower + 's';
    },

    /**
     * Base form of a verb, undoing the -s/-es/-ies inflection. Returns null when the
     * word is not a recognised verb, which is what keeps nouns out of the agreement
     * rules: "the codes" and "he codes" are indistinguishable in isolation.
     * @param {string} word
     * @returns {string|null}
     */
    baseForm: function (word) {
        const lower = word.toLowerCase();
        if (this.IRREGULAR_BASE[lower]) return this.IRREGULAR_BASE[lower];
        if (this.VERBS.has(lower)) return lower;

        let candidate = null;
        if (/ies$/.test(lower)) candidate = lower.slice(0, -3) + 'y';
        else if (/(?:ses|shes|ches|xes|zes|oes)$/.test(lower)) candidate = lower.slice(0, -2);
        else if (/s$/.test(lower)) candidate = lower.slice(0, -1);

        return (candidate && this.VERBS.has(candidate)) ? candidate : null;
    },

    /**
     * Copies the capitalisation of `model` onto `word`.
     * @param {string} word - The replacement.
     * @param {string} model - The text being replaced.
     * @returns {string}
     */
    matchCase: function (word, model) {
        if (!model) return word;
        if (model === model.toUpperCase() && model.length > 1) return word.toUpperCase();
        if (model[0] === model[0].toUpperCase()) return word.charAt(0).toUpperCase() + word.slice(1);
        return word;
    },

    /**
     * Applies a [pattern, replacement, explanation] table, recording one issue per rule
     * that actually changed something. An explanation may contain "$1", which is filled
     * from the same capture group the replacement uses.
     * @param {string} text
     * @param {Array} rules
     * @param {Array} issues - Collector, appended to in place.
     * @param {string} type - Issue category.
     * @returns {string}
     */
    applyTable: function (text, rules, issues, type) {
        return rules.reduce((str, rule) => {
            const pattern = rule[0];
            pattern.lastIndex = 0;
            const result = str.replace(pattern, rule[1]);
            if (result === str) return str;

            let note = rule[2];
            if (typeof note === 'string' && note.indexOf('$1') !== -1) {
                pattern.lastIndex = 0;
                const first = pattern.exec(str);
                pattern.lastIndex = 0;
                note = note.replace(/\$1/g, first && first[1] ? first[1].toLowerCase() : '');
            }
            issues.push({ type: type, label: note });
            return result;
        }, text);
    },

    // ---------------------------------------------------------------------------
    // Passes
    // ---------------------------------------------------------------------------

    /**
     * Subject-verb agreement for pronoun subjects, plus the "auxiliary + inflected verb"
     * error ("should has", "to writes", "doesn't works").
     *
     * Only pronoun subjects are handled. A noun subject has to be known singular or
     * plural before it can agree with anything, and guessing that from the surface form
     * is precisely where an agreement checker starts corrupting text.
     *
     * @param {string} text
     * @param {Array} issues - Collector, appended to in place.
     * @returns {string}
     */
    fixAgreement: function (text, issues) {
        let out = text;

        // Plural / first-person subject with a singular verb.
        out = out.replace(/\b(i|we|you|they)\s+(has|is|was|does|wasn't|isn't|doesn't|hasn't)\b/gi,
            (match, subject, verb) => {
                const plural = {
                    has: 'have', is: 'are', was: 'were', does: 'do',
                    "wasn't": "weren't", "isn't": "aren't", "doesn't": "don't", "hasn't": "haven't"
                };
                let fixed = plural[verb.toLowerCase()];
                // "I" is its own agreement class: am/was, not are/were.
                if (subject.toLowerCase() === 'i') {
                    const forI = { are: 'am', were: 'was', "aren't": 'am not', "weren't": "wasn't" };
                    fixed = forI[fixed] || fixed;
                }
                // "I was" maps through were and straight back to was. Nothing changed,
                // so there is no error to report.
                if (fixed === verb.toLowerCase()) return match;
                issues.push({ type: 'agreement', label: `"${subject} ${verb}" should be "${subject} ${fixed}"` });
                return `${subject} ${this.matchCase(fixed, verb)}`;
            });

        // "I" takes am/was, never are/were. This needs its own rule because the plural
        // rule above cannot carry it: "are" is correct for we, you and they, so it is
        // not in that rule's list of verbs to replace.
        // The lookbehind keeps it off a compound subject. "He and I were talking" is
        // correct and is what fixCompoundAgreement just produced; without this guard the
        // rule undoes that repair and puts the singular verb straight back.
        out = out.replace(/(?<!\b(?:and|or)\s)\bI\s+(are|were|aren't|weren't)\b/g, (match, verb) => {
            const forI = { are: 'am', were: 'was', "aren't": 'am not', "weren't": "wasn't" };
            const fixed = forI[verb.toLowerCase()];
            issues.push({ type: 'agreement', label: `"I ${verb}" should be "I ${fixed}"` });
            return `I ${fixed}`;
        });

        // Singular subject with a plural verb.
        out = out.replace(/\b(he|she|it|this|that)\s+(have|are|were|do|don't|aren't|weren't|haven't)\b/gi,
            (match, subject, verb) => {
                const singular = {
                    have: 'has', are: 'is', were: 'was', do: 'does',
                    "don't": "doesn't", "aren't": "isn't", "weren't": "wasn't", "haven't": "hasn't"
                };
                const fixed = singular[verb.toLowerCase()];
                issues.push({ type: 'agreement', label: `"${subject} ${verb}" should be "${subject} ${fixed}"` });
                return `${subject} ${this.matchCase(fixed, verb)}`;
            });

        // "he go" -> "he goes". Restricted to known verbs, and skipping the ones whose
        // past tense is spelled like the base ("she read the book" is already correct).
        out = out.replace(/\b(he|she|it)\s+([a-z]+)\b/gi, (match, subject, word) => {
            const lower = word.toLowerCase();
            if (!this.VERBS.has(lower)) return match;
            if (this.AMBIGUOUS_PAST.has(lower)) return match;
            const fixed = this.thirdPerson(lower);
            if (fixed === lower) return match;
            issues.push({ type: 'agreement', label: `"${subject} ${word}" should be "${subject} ${fixed}"` });
            return `${subject} ${this.matchCase(fixed, word)}`;
        });

        // "I goes" / "they writes" -> the base form.
        out = out.replace(/\b(i|we|you|they)\s+([a-z]+s)\b/gi, (match, subject, word) => {
            const base = this.baseForm(word);
            if (!base || base === word.toLowerCase()) return match;
            // The word must be the PRESENT third-person form of that base. Without this
            // check a past tense ending in -s is rebased instead of left alone, and
            // "I was wondering" becomes "I be wondering".
            if (this.thirdPerson(base) !== word.toLowerCase()) return match;
            issues.push({ type: 'agreement', label: `"${subject} ${word}" should be "${subject} ${base}"` });
            return `${subject} ${this.matchCase(base, word)}`;
        });

        // A modal, an infinitive "to", or do-support is always followed by a base verb:
        // "should has" -> "should have", "to writes" -> "to write", "doesn't works".
        out = out.replace(
            /\b(can|could|will|would|shall|should|may|might|must|to|do|does|did|don't|doesn't|didn't|can't|couldn't|won't|wouldn't|shouldn't|let's|help\s+(?:me|us))\s+([a-z']+)\b/gi,
            (match, auxiliary, word) => {
                const lower = word.toLowerCase();
                const base = this.IRREGULAR_BASE[lower] ||
                    (/s$/.test(lower) ? this.baseForm(lower) : null);
                if (!base || base === lower) return match;
                // "to" also introduces noun phrases ("to the store"), so the word has to
                // be a verb this module knows before it is touched.
                if (!this.VERBS.has(base)) return match;
                // The pseudo-cleft "all it does is print the value" is correct English,
                // so do-support is never allowed to rewrite a following be-verb.
                if (base === 'be' && /^(?:do|does|did)$/i.test(auxiliary)) return match;
                issues.push({ type: 'verb-form', label: `"${auxiliary} ${word}" should be "${auxiliary} ${base}"` });
                return `${auxiliary} ${this.matchCase(base, word)}`;
            });

        return out;
    },

    /**
     * Expands contractions typed without their apostrophe, and fixes a/an agreement.
     *
     * Both are prerequisites for the agreement pass rather than cosmetic touch-ups:
     * "doesnt works" cannot match a rule written against "doesn't", and "a apple" is the
     * same class of error as "he go".
     * @param {string} text
     * @param {Array} issues
     * @returns {string}
     */
    fixForms: function (text, issues) {
        // A contraction typed with the apostrophe replaced by a space: "i m havng",
        // "i ve tried", "u ll see". The pronoun anchors it, so the stranded letter cannot
        // be mistaken for a variable.
        let out = text.replace(/\b(i|we|you|they|he|she|it)\s+(m|ve|ll|d|re)\b/gi,
            (match, subject, fragment) => {
                const expansion = {
                    m: 'am', ve: 'have', ll: 'will', d: 'would', re: 'are'
                }[fragment.toLowerCase()];
                // "I m" is "I am", but "we m" is nothing -- only expand a pairing that
                // exists. "m" and "re" belong to specific subjects.
                const subjectLower = subject.toLowerCase();
                if (fragment.toLowerCase() === 'm' && subjectLower !== 'i') return match;
                if (fragment.toLowerCase() === 're' && ['we', 'you', 'they'].indexOf(subjectLower) === -1) {
                    return match;
                }
                issues.push({
                    type: 'contraction',
                    label: `"${subject} ${fragment}" should be "${subject} ${expansion}"`
                });
                return `${subject} ${expansion}`;
            });

        out = out.replace(this.compiled.contractions, match => {
            const fixed = this.CONTRACTIONS[match.toLowerCase()];
            issues.push({ type: 'contraction', label: `"${match}" is missing an apostrophe: "${fixed}"` });
            return this.matchCase(fixed, match);
        });

        // "a apple" -> "an apple". The exceptions are words whose spelling and sound
        // disagree: "a user" and "a European" start with a consonant sound.
        out = out.replace(/\b([Aa])\s+([aeiou]\w+)/g, (match, article, word) => {
            if (/^(?:user|useful|unique|union|united|universal|university|unicode|utility|european|one|once)/i.test(word)) return match;
            issues.push({ type: 'article', label: `"a ${word}" should be "an ${word}"` });
            return `${article}n ${word}`;
        });

        // "an book" -> "a book", with the reverse exceptions: "an hour", "an honest".
        out = out.replace(/\b([Aa])n\s+([b-df-hj-np-tv-z]\w+)/gi, (match, article, word) => {
            if (/^(?:hour|honest|honou?r|heir)/i.test(word)) return match;
            issues.push({ type: 'article', label: `"an ${word}" should be "a ${word}"` });
            return `${article} ${word}`;
        });

        return out;
    },

    /**
     * Do-support across an intervening subject: "how does machine learning works" ->
     * "how does machine learning work". The auxiliary already carries the tense and
     * agreement, so the main verb must be bare however far away it sits.
     *
     * The gap is capped at four words and may not contain a clause boundary or another
     * verb-bearing auxiliary, which keeps the rule inside a single clause.
     * @param {string} text
     * @param {Array} issues
     * @returns {string}
     */
    fixDoSupport: function (text, issues) {
        return text.replace(
            /\b(do|does|did)\s+((?:[a-z][\w'-]*\s+){1,4}?)([a-z]+s)\b/gi,
            (match, auxiliary, middle, word) => {
                if (/\b(?:and|but|or|because|which|that|who|is|are|was|were|has|have|had|not|to)\b/i.test(middle)) {
                    return match;
                }
                const base = this.baseForm(word);
                if (!base || base === word.toLowerCase() || !this.VERBS.has(base)) return match;
                issues.push({ type: 'verb-form', label: `after "${auxiliary}" the verb is bare: "${base}", not "${word}"` });
                return `${auxiliary} ${middle}${this.matchCase(base, word)}`;
            });
    },

    /**
     * Agreement patterns that a pronoun-subject rule cannot see.
     *
     * fixAgreement handles "he go" and "I has" because the subject is a pronoun and its
     * number is certain. These are the cases where the number lives somewhere else:
     *
     *   EXISTENTIAL   "there is many errors" -- the real subject follows the verb
     *   QUANTIFIED    "each of the files are broken" -- "each" is singular; the plural
     *                 noun beside the verb is inside a prepositional phrase, not the
     *                 subject, and it is what drags the verb the wrong way
     *   HEAD NOUN     "the list of items were long" -- same shape, opposite direction
     *
     * All three are safe because the determiner fixes the number by itself: "each",
     * "every", "one of" and "neither" are singular whatever noun follows them.
     * @param {string} text
     * @param {Array} issues
     * @returns {string}
     */
    fixDistantAgreement: function (text, issues) {
        let out = text;

        // "there is many errors" / "there are a problem"
        out = out.replace(/\bthere\s+(is|are|was|were)\s+((?:a|an|one)\s+|many\s+|several\s+|few\s+|two\s+|three\s+|some\s+)?([a-z]+)\b/gi,
            (match, verb, determiner, noun) => {
                const singularCue = /^(?:a|an|one)\s+$/i.test(determiner || '');
                const pluralCue = /^(?:many|several|few|two|three)\s+$/i.test(determiner || '');
                if (!singularCue && !pluralCue) return match;

                const past = /^(?:was|were)$/i.test(verb);
                const wanted = singularCue
                    ? (past ? 'was' : 'is')
                    : (past ? 'were' : 'are');
                if (wanted === verb.toLowerCase()) return match;

                const cue = (determiner || '').trim();
                issues.push({
                    type: 'agreement',
                    // Built by concatenation rather than by tidying a template afterwards:
                    // the previous .replace(/\s+"/g, '"') removed the space before every
                    // closing quote, so the label read 'should be"there are many"'.
                    label: '"there ' + verb + (cue ? ' ' + cue : '') + '" should be '
                        + '"there ' + wanted + (cue ? ' ' + cue : '') + '"'
                });
                return `there ${this.matchCase(wanted, verb)} ${determiner || ''}${noun}`;
            });

        // "each of the files are broken", "one of the tests fail", "neither option work"
        // The optional middle is either an "of ..." phrase or a single bare noun
        // ("neither option are correct"). A pronoun is excluded there: in "one thing I
        // do" the pronoun is the subject of its own clause, and treating it as the
        // middle would rewrite a correct verb into "I does".
        out = out.replace(/\b(each|every|either|neither|one)\s+(of\s+(?:the\s+|these\s+|those\s+|my\s+|our\s+|your\s+)?[a-z]+\s+|(?!(?:i|you|we|they|he|she|it|that|which|who|there)\b)[a-z]+\s+)?(are|were|have|do)\b/gi,
            (match, quantifier, middle, verb) => {
                const singular = { are: 'is', were: 'was', have: 'has', do: 'does' };
                const fixed = singular[verb.toLowerCase()];
                issues.push({
                    type: 'agreement',
                    label: `"${quantifier}" is singular, so the verb is "${fixed}", not "${verb}"`
                });
                return `${quantifier} ${middle || ''}${this.matchCase(fixed, verb)}`;
            });

        // "the list of items were long" -- the head noun before "of" sets the number.
        out = out.replace(/\b(the|a|an|this|that|my|our|your)\s+([a-z]+)\s+of\s+([a-z]+)\s+(are|were)\b/gi,
            (match, determiner, head, inner, verb) => {
                // Only when the head is singular and the inner noun is plural, which is
                // the shape that misleads. A plural head ("the lists of items were") is
                // already correct.
                if (/s$/i.test(head) || !/s$/i.test(inner)) return match;
                // Quantifier heads take their number from what they count, so "a number
                // of users are affected" and "a couple of tests were failing" are both
                // right. Treating them like "the list of items" inverts a correct verb.
                if (/^(?:number|couple|lot|handful|majority|minority|percent|percentage|total|bunch|series|set|group|pair|few|plenty|variety|range)$/i.test(head)) {
                    return match;
                }
                const singular = { are: 'is', were: 'was' };
                const fixed = singular[verb.toLowerCase()];
                issues.push({
                    type: 'agreement',
                    label: `the subject is "${head}", so the verb is "${fixed}", not "${verb}"`
                });
                return `${determiner} ${head} of ${inner} ${this.matchCase(fixed, verb)}`;
            });

        return out;
    },


    /**
     * Pronoun case in compound subjects: "me and him was talking" -> "he and I were
     * talking". An object pronoun in subject position is one of the most common written
     * errors and one of the safest to repair, because a compound followed by a finite
     * verb can only be a subject.
     * @param {string} text
     * @param {Array} issues
     * @returns {string}
     */
    fixPronounCase: function (text, issues) {
        const subjectForm = { me: 'I', him: 'he', her: 'she', us: 'we', them: 'they' };

        return text.replace(
            /(?<=^|[.!?;,]\s*|\s)(me|him|her|us|them)\s+and\s+(me|him|her|us|them|i|he|she|we|they)\s+(?=(?:was|were|is|are|am|have|has|had|will|would|can|could|should|need|want|think|know)\b)/gi,
            (match, first, second) => {
                const a = subjectForm[first.toLowerCase()] || first;
                const b = subjectForm[second.toLowerCase()] || second;
                // English convention puts the first person last.
                const ordered = (a === 'I') ? `${b} and I` : `${a} and ${b}`;
                issues.push({ type: 'pronoun-case', label: `"${first} and ${second}" should be "${ordered}"` });
                return ordered + ' ';
            });
    },

    /**
     * A compound subject is plural. Runs immediately after fixPronounCase, which leaves
     * "he and I was" behind when it repairs "me and him was".
     * @param {string} text
     * @param {Array} issues
     * @returns {string}
     */
    fixCompoundAgreement: function (text, issues) {
        // Both conjuncts must be pronouns. A looser pattern matches any "X and Y is",
        // which catches ordinary coordinated clauses -- "explain how it works and what
        // is the difference" -- and turns a correct verb into a wrong one.
        return text.replace(/\b((?:he|she|i|we|they|you|it)\s+and\s+(?:he|she|i|we|they|you|it))\s+(was|is|has|does)\b/gi,
            (match, subject, verb) => {
                const plural = { was: 'were', is: 'are', has: 'have', does: 'do' };
                const fixed = plural[verb.toLowerCase()];
                issues.push({ type: 'agreement', label: `a compound subject takes "${fixed}", not "${verb}"` });
                return `${subject} ${this.matchCase(fixed, verb)}`;
            });
    },

    /**
     * Tense agreement with an explicit past-time marker: "yesterday he go" -> "went".
     * Only fires in a sentence that names a past time, which is the only evidence strong
     * enough to justify changing a tense. Sentences are processed with their separators
     * preserved, so a marker in one sentence cannot reach into the next and a multi-line
     * prompt keeps its line breaks.
     * @param {string} text
     * @param {Array} issues
     * @returns {string}
     */
    fixTense: function (text, issues) {
        const PAST = {
            'go': 'went', 'goes': 'went', 'buy': 'bought', 'buys': 'bought',
            'see': 'saw', 'sees': 'saw', 'take': 'took', 'takes': 'took',
            'make': 'made', 'makes': 'made', 'write': 'wrote', 'writes': 'wrote',
            'run': 'ran', 'runs': 'ran', 'give': 'gave', 'gives': 'gave',
            'get': 'got', 'gets': 'got', 'come': 'came', 'comes': 'came',
            'say': 'said', 'says': 'said', 'tell': 'told', 'tells': 'told',
            'find': 'found', 'finds': 'found', 'think': 'thought', 'thinks': 'thought',
            'know': 'knew', 'knows': 'knew', 'send': 'sent', 'sends': 'sent',
            'build': 'built', 'builds': 'built', 'try': 'tried', 'tries': 'tried',
            'use': 'used', 'uses': 'used', 'work': 'worked', 'works': 'worked',
            'call': 'called', 'calls': 'called', 'ask': 'asked', 'asks': 'asked',
            'happen': 'happened', 'happens': 'happened'
        };
        const PAST_MARKER = /\b(?:yesterday|last\s+(?:night|week|month|year|time)|ago|earlier\s+today|this\s+morning)\b/i;

        // A capturing split keeps the separators in the array, so join('') restores the
        // original spacing and newlines exactly.
        return text.split(/((?<=[.!?])\s+)/).map((part, index) => {
            if (index % 2 === 1) return part;
            if (!PAST_MARKER.test(part)) return part;

            let converted = false;
            let out = part.replace(/\b(i|we|you|they|he|she|it)\s+([a-z]+)\b/gi,
                (match, subject, verb) => {
                    const past = PAST[verb.toLowerCase()];
                    if (!past) return match;
                    converted = true;
                    issues.push({ type: 'tense', label: `"${verb}" should be past tense "${past}"` });
                    return `${subject} ${this.matchCase(past, verb)}`;
                });

            // A verb coordinated with one that was just moved into the past shares its
            // subject and so shares its tense: "he went to the store and buy milk".
            // Only applies once a conversion has actually happened in this sentence,
            // which is what stops it firing on an ordinary "and" in the present tense.
            if (converted) {
                out = out.replace(/\b(and|then)\s+([a-z]+)\b/gi, (match, joiner, verb) => {
                    const past = PAST[verb.toLowerCase()];
                    if (!past) return match;
                    issues.push({ type: 'tense', label: `"${verb}" should be past tense "${past}"` });
                    return `${joiner} ${this.matchCase(past, verb)}`;
                });
            }

            return out;
        }).join('');
    },

    /**
     * Uncountable nouns wrongly pluralised, and irregular plurals wrongly regularised.
     * @param {string} text
     * @param {Array} issues
     * @returns {string}
     */
    fixNouns: function (text, issues) {
        let out = text;

        out = out.replace(this.compiled.uncountable, match => {
            const fixed = this.UNCOUNTABLE[match.toLowerCase()];
            issues.push({ type: 'noun-form', label: `"${match}" is uncountable; use "${fixed}"` });
            return this.matchCase(fixed, match);
        });

        out = out.replace(this.compiled.irregularPlural, match => {
            const fixed = this.IRREGULAR_PLURAL[match.toLowerCase()];
            issues.push({ type: 'noun-form', label: `the plural of "${match}" is "${fixed}"` });
            return this.matchCase(fixed, match);
        });

        return out;
    },

    /**
     * Capitalises the pronoun "I", known proper nouns, and sentence openings.
     * @param {string} text
     * @param {Array} issues
     * @returns {string}
     */
    fixCapitalization: function (text, issues) {
        let out = text;
        let changed = false;

        // Standalone "i" is always capitalised.
        const withI = out.replace(/(^|[^\w'])i(?=[^\w']|$)/g, '$1I');
        if (withI !== out) { changed = true; out = withI; }

        // Known proper nouns. The compiled regex is case-sensitive over lowercase keys,
        // so only an all-lowercase spelling is touched.
        const withNouns = out.replace(this.compiled.properNouns,
            match => this.PROPER_NOUNS[match] || match);
        if (withNouns !== out) { changed = true; out = withNouns; }

        if (changed) issues.push({ type: 'capitalization', label: 'capitalization corrected' });

        // Sentence openings, last, so it also catches openings the rules above exposed.
        const withSentences = out.replace(/(^|[.!?]\s+)([a-z])/g,
            (match, lead, letter) => lead + letter.toUpperCase());
        if (withSentences !== out) {
            out = withSentences;
            if (!changed) issues.push({ type: 'capitalization', label: 'sentence capitalization corrected' });
        }

        return out;
    },

    /**
     * Normalises spacing and punctuation: no space before a comma, one after it, no runs
     * of terminators, and a full stop at the end of a sentence that has none.
     *
     * The rule that inserts a space after a full stop requires a lowercase pair in front
     * and a capital after, so "Node.js" and "3.5" are left alone.
     * @param {string} text
     * @param {Array} issues
     * @returns {string}
     */
    fixPunctuation: function (text, issues) {
        const before = text;

        let out = text
            .replace(/\s+([,.;:!?])/g, '$1')
            .replace(/([,;:])(?=[^\s\d])/g, '$1 ')
            .replace(/([a-z]{2})\.(?=[A-Z])/g, '$1. ')
            .replace(/([!?])(?=[A-Za-z])/g, '$1 ')
            .replace(/,{2,}/g, ',')
            .replace(/([!?])\1+/g, '$1')
            .replace(/[ \t]{2,}/g, ' ')
            .trim();

        if (out !== before) issues.push({ type: 'punctuation', label: 'spacing and punctuation normalized' });

        // A prompt that ends mid-air gets a full stop -- unless it ends in a placeholder,
        // where the user's own content (a path, a code span) closes the sentence.
        const last = out.charAt(out.length - 1);
        if (out.length > 0 && !/[.!?:;]/.test(last) && last !== this.MASK_CLOSE &&
            /[A-Za-z0-9)"']/.test(last) && out.split(/\s+/).length > 2) {
            out += '.';
            issues.push({ type: 'punctuation', label: 'missing final punctuation added' });
        }

        return out;
    },

    // ---------------------------------------------------------------------------
    // Entry points
    // ---------------------------------------------------------------------------

    /**
     * Corrects the grammar of a piece of text and reports every change made.
     *
     * Order matters. Confusables and noun forms run first so the agreement pass sees the
     * corrected word ("datas is" becomes "data is", not "datas are"). Pronoun case runs
     * before compound agreement, which repairs the verb the case fix orphans.
     *
     * @param {string} text - Prompt text, already masked if protection is in use.
     * @param {Object} options - { punctuation: false } to skip the punctuation pass, for
     *        callers that run their own tidy afterwards.
     * @returns {Object} { text, issues } where issues is [{ type, label }].
     */
    correct: function (text, options) {
        if (!text || typeof text !== 'string') return { text: text || '', issues: [] };

        const settings = options || {};
        const issues = [];
        let out = text;

        out = this.fixForms(out, issues);
        out = this.applyTable(out, this.CONFUSABLES, issues, 'word-choice');
        out = this.fixNouns(out, issues);
        out = this.applyTable(out, this.FRAME_FIXES, issues, 'phrasing');
        out = this.fixPronounCase(out, issues);
        out = this.fixCompoundAgreement(out, issues);
        out = this.fixTense(out, issues);
        out = this.fixAgreement(out, issues);
        out = this.fixDistantAgreement(out, issues);
        out = this.fixDoSupport(out, issues);
        out = this.fixCapitalization(out, issues);

        if (settings.punctuation !== false) {
            out = this.fixPunctuation(out, issues);
        }

        return { text: out, issues: issues };
    },

    /**
     * Reports grammatical errors without rewriting anything.
     * @param {string} text
     * @returns {Array} Issues, [{ type, label }].
     */
    check: function (text) {
        return this.correct(text, { punctuation: false }).issues;
    }
};

// Compile the lookup tables into one regex each, at load time rather than per keystroke.
PromptMeterGrammar.compiled = {
    contractions: PromptMeterGrammar.buildMap(PromptMeterGrammar.CONTRACTIONS, 'gi'),
    uncountable: PromptMeterGrammar.buildMap(PromptMeterGrammar.UNCOUNTABLE, 'gi'),
    irregularPlural: PromptMeterGrammar.buildMap(PromptMeterGrammar.IRREGULAR_PLURAL, 'gi'),
    properNouns: PromptMeterGrammar.buildMap(PromptMeterGrammar.PROPER_NOUNS, 'g')
};

// Export for global (content script) and bundler environments
if (typeof window !== 'undefined') {
    window.PromptMeterGrammar = PromptMeterGrammar;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { PromptMeterGrammar };
}

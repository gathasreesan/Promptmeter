/**
 * PromptMeter Spelling Corrector
 *
 * Repairs typos that no dictionary of fixed pairs can reach. The abbreviation tables in
 * optimizer.js handle known shorthand ("tmrw", "plz"); this handles the open-ended case,
 * where somebody typing quickly drops letters out of an ordinary word.
 *
 * WHY CONSONANT SKELETONS
 *
 * A general edit-distance corrector over a word list is the obvious design and a bad one
 * here: at distance 1 "redis" reaches "reds", "numpy" reaches "bumpy", and a prompt full
 * of technical words quietly turns into a different prompt. The precision has to come
 * from somewhere narrower than "these two strings are similar".
 *
 * It comes from how people actually mistype. They drop and transpose VOWELS and they
 * keep CONSONANTS, in that order, overwhelmingly:
 *
 *     havng -> having      hvng = hvng
 *     shrt  -> short       shrt = shrt
 *     recieve -> receive   rcv  = rcv
 *     undrestand -> understand   ndrstnd = ndrstnd
 *     teh -> the           th   = th
 *
 * So a candidate must have the EXACT same consonant skeleton as the typo, with runs of
 * repeated letters collapsed so that dropping half of a double ("tomorow", "necesary")
 * still matches.
 *
 * THE SECOND GUARD: EDIT SHAPE
 *
 * Skeletons alone are not enough, and an earlier version proved it by rewriting "stack"
 * to "stuck", "heap" to "hope", "leaf" to "life" and "enum" to "name" -- each a real word
 * the dictionary simply did not list. Sorting real typos by the SHAPE of the edit
 * separates the two groups cleanly:
 *
 *     DELETIONS      havng/having, shrt/short, diffrence/difference   accepted
 *     INSERTIONS     compleate/complete                               accepted
 *     TRANSPOSITION  teh/the, recieve/receive, undrestand/understand  accepted
 *     SUBSTITUTION   stack/stuck, heap/hope, leaf/life, cuda/code     REJECTED
 *
 * Every corruption was a substitution, because swapping one letter for another is what
 * turns an unlisted word into a different real word. Refusing substitutions costs some
 * recall -- "spellong" for "spelling" is one, and is no longer caught -- and buys the
 * guarantee that an unlisted technical term survives the corrector untouched.
 *
 * TWO MORE GUARDS, BOTH FOUND THE SAME WAY
 *
 * The first letter must survive. Sweeping common English turned up "every" becoming
 * "very", "along" becoming "long", "apart" becoming "part" and "ahead" becoming "head"
 * -- one family, all of them a real word losing its opening letter. People drop letters
 * from the middle of a word, not off the front, so comparing the first character rules
 * out the whole class where listing the words would have fixed only those four.
 *
 * A skeleton of one consonant is not evidence. "bee" reduces to "b", which it shares
 * with "be", "by" and "buy", and the frequency ranking then picks the commonest rather
 * than the one that was meant. Two consonants is the floor.
 *
 * TRUNCATION, AND WHY IT IS ALMOST ENTIRELY DISABLED
 *
 * Completing a typo that is the prefix of a longer word ("Monda" for "Monday") sounds
 * safe and is not: a sweep of thirty-five ordinary words produced seven wrong
 * completions -- "mark" to "market", "count" to "country", "star" to "start", "ever" to
 * "every". English is full of words that begin other words, and no dictionary fixes that
 * because both sides are real words. The rule now completes only into the closed set of
 * twenty day and month names, where truncation is common and nothing else is a prefix.
 *
 * WHAT IT REFUSES TO DO
 *
 * Ambiguity is resolved toward the commoner word, and only when that word is a strictly
 * better fit; otherwise the typo is left alone. Leaving a typo in place costs the user
 * nothing, while changing a word they meant corrupts their prompt -- the same
 * precision-over-recall contract the rest of the pipeline follows. Recall is also bounded
 * by the dictionary below: a word it does not list can never be a correction.
 *
 * Runs on masked text. Placeholders are private-use characters and digits, so the
 * word pattern below cannot match inside one.
 */

// Dictionary, ordered by rough frequency: the index of a word is its rank, and rank is
// what breaks a tie between two equally-good corrections ("shrt" is far more likely to
// be "short" than "shirt"). Membership matters more than exact ordering -- a word in
// this list is never altered, so the technical vocabulary at the end is load-bearing.
const PM_WORDS = [
    // --- Function words and the most common verbs ---------------------------------
    'the a an and or but if then than that this these those there here it its is are was',
    'were be been being am do does did done doing have has had having will would can could',
    'shall should may might must not no yes of to in on at by for with from as into over',
    'under about after before between during through above below up down out off again',
    'once all any both each few more most other some such only own same so very just also',
    'how what when where which who whom whose why because while until since unless whether',
    'i me my mine myself you your yours we us our ours they them their theirs he him his',
    'she her hers one two three four five six seven eight nine ten first second third last',
    'next previous new old good bad best worst better worse big small large little long short',
    'high low fast slow easy hard simple complex clear quick early late full empty right wrong',
    'same different similar common general specific main major minor real true false',

    // --- Everyday verbs -------------------------------------------------------------
    'go goes going went gone come comes coming came get gets getting got make makes making',
    'made take takes taking took know knows knowing knew think thinks thinking thought',
    'see sees seeing saw look looks looking want wants wanting need needs needing',
    'give gives giving gave tell tells telling told work works working worked',
    'call calls calling called try tries trying tried ask asks asking asked',
    'use uses using used find finds finding found keep keeps keeping kept',
    'let lets leave leaves leaving left put puts putting mean means meaning meant',
    'show shows showing showed seem seems help helps helping helped',
    'turn turns start starts starting started run runs running ran move moves moving',
    'live lives living like likes liking believe hold holds bring brings happen happens',
    'write writes writing wrote written provide provides sit sits stand stands',
    'lose loses losing lost pay pays meet meets include includes including included',
    'continue set sets setting learn learns learning learned change changes changing',
    'lead leads understand understands understanding understood watch watches follow follows',
    'stop stops create creates creating created speak speaks read reads reading',
    'spend spends grow grows open opens walk walks win wins teach teaches teaching taught',
    'offer offers remember remembers consider considers appear appears buy buys',
    'serve serves send sends sending sent build builds building built stay stays',
    'fall falls cut cuts reach reaches remain remains suggest suggests raise raises',
    'pass passes sell sells require requires report reports decide decides',
    'pull pulls return returns returning returned explain explains explaining explained',
    'hope hopes develop develops carry carries break breaks receive receives',
    'agree agrees support supports produce produces eat eats cover covers',
    'catch catches draw draws choose chooses cause causes listen listens',
    'realize realizes wonder wonders check checks checking checked fix fixes fixing fixed',
    'add adds adding added remove removes removing removed compare compares comparing',
    'convert converts generate generates generating analyze analyzes analyse',
    'summarize summarizes summarise describe describes describing described',
    'design designs implement implements improve improves improving improved',
    'review reviews solve solves calculate calculates define defines list lists',
    'train trains test tests testing tested deploy deploys install installs',
    'render renders parse parses store stores fetch fetches handle handles handling',
    'process processes validate validates update updates updating updated',
    'delete deletes insert inserts select selects connect connects load loads',
    'save saves print prints display displays search searches sort sorts filter filters',

    // --- Everyday nouns ---------------------------------------------------------------
    'time year day days week weeks month months hour hours minute minutes morning evening',
    'night today tomorrow yesterday monday tuesday wednesday thursday friday saturday sunday',
    'january february march april may june july august september october november december',
    'people person man woman child children thing things way ways part parts place places',
    'case cases point points number numbers group groups problem problems question questions',
    'answer answers fact facts idea ideas word words name names example examples reason reasons',
    'result results difference differences change changes end ends kind kinds type types',
    'form forms level levels line lines order orders side sides state states system systems',
    'life world school student students teacher teachers class classes course courses',
    'exam exams test quiz midterm final finals assignment assignments homework project projects',
    'semester subject subjects topic topics chapter chapters lesson lessons study studies',
    'professor lecture lectures notes note book books paper papers essay essays report reports',
    'summary article articles story stories letter letters email message messages',
    'job jobs company business team teams meeting meetings deadline deadlines interview interviews',
    'money cost price value values amount total rate rates percent size sizes length width',
    'home house room car food water air land city country area areas market family friend friends',
    'hand head eye face body health mind heart power energy light color colors music picture',
    'video image images text texts title titles page pages section sections list step steps',
    'plan plans goal goals task tasks process job detail details format formats style styles',
    'language languages english history science math maths physics chemistry biology economics',
    'spelling grammar schedule schedules sentence sentences paragraph paragraphs meaning',
    'advance advanced except exception accept accepts expect expects expected',
    'access accesses accessible address addresses account accounts amount amounts',
    'attempt attempts approach approaches assume assumes avoid avoids benefit',
    'concept concepts context contexts control controls correct corrects',
    'depend depends effect effects effort efforts expert experts export exports',
    'import imports impact impacts insert inserts instance instances intend',
    'object objects observe occur occurs offer offers output outputs',
    'perform performs permit permits prevent prevents produce protect protects',
    'reduce reduces reflect reflects reject rejects relate relates repeat repeats',
    'replace replaces respect respond responds restrict result results',
    'select selects submit submits succeed success suggest supply supplies',
    'instead besides however therefore moreover furthermore otherwise although though',
    'without within across against among behind beyond toward towards upon despite',
    'whole entire total partial several various multiple single double triple',
    'above below front back top bottom middle center centre inside outside',
    'every everyone everything everywhere anyone anything someone something nothing',
    // Common short words. Short words are the weak spot -- one edit is a quarter of a
    // four-letter word -- and the dictionary is the only thing that protects them,
    // since a word it lists is never altered.
    'cup cap cat dog pig cow box bag bin can lid pen key map net rod pin nut bar bat',
    'hat hit hop hub hug hurt half hall hand hard harm hate have head heal heap heat',
    'men man boy girl kid sun sky sea ice oil gas tin iron gold wood rock sand dust',
    'rain snow wind heat cold warm cool dry wet hot rat bee ant fox owl hen cub pup',
    'ore rate rain cold mean bed cot mat rug tag pad log bug web bit ram arg num str',
    'int bool char byte dir src bin lib doc val var env plan form port sign mark',
    'star count plant round sound card art war far press cover note side head',
    'along apart aside ahead around across behind beside beyond during throughout',
    'another either neither enough almost nearly quite already perhaps probably',
    'reference references source sources definition definitions instruction instructions',
    'description descriptions explanation explanations comparison comparisons suggestion suggestions',

    // --- Adjectives and adverbs --------------------------------------------------------
    'able available possible impossible important necessary useful helpful correct incorrect',
    'sure certain clear obvious difficult simple detailed comprehensive thorough brief concise',
    'short long quick slow strong weak heavy light deep shallow wide narrow thick thin',
    'free busy ready done finished complete incomplete broken working valid invalid',
    'accurate precise exact rough basic advanced beginner intermediate expert professional',
    'happy sad angry tired stressed confused lost stuck worried nervous excited bored',
    'really very quite rather almost always never often sometimes usually rarely still yet',
    'already soon later now then here there everywhere anywhere somewhere together alone',
    'well better badly much many little less least enough too enough perhaps maybe probably',
    'actually basically honestly literally simply clearly obviously especially particularly',

    // --- Prompt and technical vocabulary ------------------------------------------------
    'code codes coding function functions method methods class classes object objects',
    'variable variables value values array arrays list lists string strings integer float',
    'boolean null undefined true false loop loops condition conditions statement statements',
    'file files folder folder directory directories path paths script scripts program programs',
    'application applications app apps software hardware computer server servers client clients',
    'database databases table tables query queries record records field fields index indexes',
    'api apis endpoint endpoints request requests response responses error errors exception',
    'bug bugs issue issues fix fixes feature features version versions release releases',
    'test tests testing debug debugging deploy deployment build builds compile compiler',
    'library libraries framework frameworks package packages module modules component components',
    'algorithm algorithms structure structures recursion iteration complexity performance',
    'memory storage cache network internet website websites browser browsers page url link links',
    'user users account accounts password login logout session sessions token tokens',
    'input output data information content context example sample template templates',
    'python javascript typescript java kotlin swift rust golang ruby php perl scala haskell',
    'react angular svelte django flask laravel spring node express numpy pandas pytorch',
    'tensorflow keras sklearn docker kubernetes linux ubuntu windows macos android',
    'github gitlab git mysql postgres postgresql sqlite mongodb redis firebase aws azure',
    'html css json xml yaml sql bash shell terminal command commands flag flags option options',
    'machine learning model models training dataset datasets neural network networks',
    'regression classification clustering accuracy precision recall matrix vector vectors',
    'gradient descent backpropagation overfitting regularization tokenization embedding embeddings',
    'transformer transformers attention prompt prompts token tokens chatbot assistant',
    // Short technical words. These matter out of proportion to their number: a short
    // word the dictionary does not list is the one at risk of being "corrected" into
    // a different real word, so the common ones are spelled out here.
    'stack heap queue leaf node nodes edge edges graph graphs tree trees root branch',
    'enum struct union pointer pointers reference dict tuple set map hash key keys',
    'async await const var let init args kwargs lambda yield return break continue',
    'cors csrf ssl tls dns tcp udp http https url uri uuid jwt oauth rest grpc soap',
    'npm npx yarn pnpm env venv pip conda cuda gpu cpu ram rom ssd disk cache buffer',
    'repo commit branch merge rebase clone push pull fork diff patch stash tag',
    'regex regexp utf ascii unicode byte bytes bit bits hex binary decimal octal',
    'csv tsv pdf png jpg jpeg svg gif zip tar log logs conf config ini toml lock',
    'vue vite webpack babel eslint jest pytest mocha nginx apache flask axios lodash',
    'scipy matplotlib jupyter notebook colab pandas seaborn plotly numpy sklearn',
    'cron daemon thread threads process mutex lock semaphore socket port host proxy',
    'schema schemas migration migrations orm crud auth admin token payload header'
].join(' ').split(/\s+/).filter(Boolean);

const PromptMeterSpelling = {

    // Below this length a word carries too little signal: "th", "hw" and "ur" have dozens
    // of plausible expansions and no way to choose between them.
    MIN_LENGTH: 3,

    // A truncation may be at most this many characters shorter than the intended word,
    // so "Monda" reaches "Monday" but "co" does not reach "considering".
    MAX_TRUNCATION: 3,

    // Beyond this many edits the two words are not a typo of each other, whatever their
    // skeletons say. The budget is proportional rather than flat: three edits is a slip
    // in a ten-letter word and a different word entirely in a five-letter one. A flat
    // cap of 3 let "access" reach "css" -- same collapsed skeleton, and "css" is a
    // subsequence of "access", so only the size of the edit gives it away.
    MAX_DISTANCE: 3,

    /**
     * Edit budget for a pair of words, scaled to the longer one.
     * @param {string} word
     * @param {string} candidate
     * @returns {number}
     */
    budget: function (word, candidate) {
        const longest = Math.max(word.length, candidate.length);
        return Math.min(this.MAX_DISTANCE, Math.max(1, Math.floor(longest / 3)));
    },

    /**
     * Consonant skeleton: the word with every vowel removed.
     *
     * This is the whole precision story. Two words share a skeleton only when they differ
     * purely in vowels, which is what a dropped or transposed letter almost always is.
     * @param {string} word - Lowercased word.
     * @returns {string}
     */
    skeleton: function (word) {
        // Repeated letters collapse as well as vowels dropping. Dropping one half of a
        // double consonant is its own common slip -- "tomorow", "necesary", "sucessful"
        // -- and without this the skeletons differ ("tmrrw" against "tmrw") and the
        // correction is missed entirely.
        return word.replace(/(.)\1+/g, '$1').replace(/[aeiou]/g, '');
    },

    /**
     * Damerau-Levenshtein distance, used to rank candidates that share a skeleton and to
     * reject ones that share it by coincidence.
     * @param {string} a
     * @param {string} b
     * @returns {number}
     */
    distance: function (a, b) {
        if (a === b) return 0;
        const rows = a.length + 1;
        const cols = b.length + 1;
        const grid = new Array(rows);
        for (let i = 0; i < rows; i++) {
            grid[i] = new Array(cols).fill(0);
            grid[i][0] = i;
        }
        for (let j = 0; j < cols; j++) grid[0][j] = j;

        for (let i = 1; i < rows; i++) {
            for (let j = 1; j < cols; j++) {
                const cost = a[i - 1] === b[j - 1] ? 0 : 1;
                grid[i][j] = Math.min(
                    grid[i - 1][j] + 1,
                    grid[i][j - 1] + 1,
                    grid[i - 1][j - 1] + cost
                );
                // Transposition: "recieve" is one edit from "receive", not two.
                if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
                    grid[i][j] = Math.min(grid[i][j], grid[i - 2][j - 2] + cost);
                }
            }
        }
        return grid[rows - 1][cols - 1];
    },

    /** True when the dictionary already knows this word, so it is not a typo. */
    known: function (word) {
        return this.rank.has(word);
    },

    /** True when every character of `part` appears in `whole`, in order. */
    isSubsequence: function (part, whole) {
        let i = 0;
        for (let j = 0; j < whole.length && i < part.length; j++) {
            if (part[i] === whole[j]) i++;
        }
        return i === part.length;
    },

    /** True when the two words differ only by swapping one adjacent pair. */
    isTransposition: function (a, b) {
        if (a.length !== b.length) return false;
        const differing = [];
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) differing.push(i);
            if (differing.length > 2) return false;
        }
        return differing.length === 2 &&
            differing[1] === differing[0] + 1 &&
            a[differing[0]] === b[differing[1]] &&
            a[differing[1]] === b[differing[0]];
    },

    /**
     * True when the edit from `word` to `candidate` is a shape people actually produce.
     *
     * This is the guard that makes the corrector safe, and it was added after watching an
     * earlier version rewrite "stack" to "stuck", "heap" to "hope", "leaf" to "life" and
     * "enum" to "name" -- every one of them a technical word the dictionary happened not
     * to list. Sorting real typos by edit shape separates the two groups cleanly:
     *
     *   DELETIONS      havng/having, shrt/short, diffrence/difference   -- accepted
     *   INSERTIONS     compleate/complete                               -- accepted
     *   TRANSPOSITION  teh/the, recieve/receive, undrestand/understand  -- accepted
     *   SUBSTITUTION   stack/stuck, heap/hope, leaf/life, cuda/code     -- REJECTED
     *
     * Substitution is where the corruption lives, because swapping one letter for another
     * turns a word the dictionary does not know into a different real word. Dropping it
     * costs a little recall -- "spellong" for "spelling" is a substitution and is no
     * longer caught -- and buys back the guarantee that an unlisted technical term
     * survives contact with the corrector.
     *
     * @param {string} word - The suspected typo.
     * @param {string} candidate - The proposed correction.
     * @returns {boolean}
     */
    isPlausibleEdit: function (word, candidate) {
        // The first letter must survive. People drop letters out of the middle of a word,
        // not off the front, so a correction that changes the opening character is far
        // more likely to be one real word being mistaken for another. Every gap a sweep
        // of common English turned up had exactly this shape -- "every" to "very",
        // "along" to "long", "apart" to "part", "aside" to "side", "ahead" to "head" --
        // and one comparison rules out the whole family, where listing the words would
        // only fix the five that happened to be tested.
        if (word[0] !== candidate[0]) return false;

        if (word.length < candidate.length) return this.isSubsequence(word, candidate);
        if (word.length > candidate.length) return this.isSubsequence(candidate, word);
        return this.isTransposition(word, candidate);
    },

    /**
     * Best correction for a single lowercased word, or null to leave it alone.
     *
     * @param {string} word - Lowercased, alphabetic.
     * @returns {string|null}
     */
    correctWord: function (word) {
        if (this.cache.has(word)) return this.cache.get(word);

        const result = this.resolve(word);
        this.cache.set(word, result);
        return result;
    },

    /**
     * Uncached correction lookup. Tries the skeleton rule, then truncation.
     * @param {string} word
     * @returns {string|null}
     */
    resolve: function (word) {
        if (word.length < this.MIN_LENGTH) return null;
        if (this.known(word)) return null;

        // A skeleton of one consonant carries almost no evidence -- "bee" reduces to "b",
        // which it shares with "be", "by", "buy" and a dozen others, and the ranking then
        // picks whichever is commonest rather than whichever was meant. Two consonants is
        // the minimum that says anything about the word.
        if (this.skeleton(word).length < 2) return null;

        // Both rules contribute candidates and they are ranked together. Ranking them
        // separately lets a poor skeleton match pre-empt a good truncation: "monda" has
        // the same skeleton as "mind" (two edits away) but is a prefix of "monday" (one
        // edit away), and whichever rule ran first would win rather than the better fit.
        const candidates = (this.skeletonIndex.get(this.skeleton(word)) || [])
            .concat(this.truncations(word));

        let best = null;
        let bestDistance = Infinity;
        let tied = false;

        for (const candidate of candidates) {
            if (!this.isPlausibleEdit(word, candidate)) continue;
            const gap = this.distance(word, candidate);
            if (gap > this.budget(word, candidate)) continue;

            if (gap < bestDistance) {
                best = candidate;
                bestDistance = gap;
                tied = false;
            } else if (gap === bestDistance) {
                // Equal fit: the commoner word wins, which is what makes "shrt" resolve
                // to "short" rather than "shirt". Rank order is the tie-break, and the
                // dictionary is ordered by frequency for exactly this.
                if (this.rank.get(candidate) < this.rank.get(best)) {
                    best = candidate;
                } else {
                    tied = true;
                }
            }
        }

        // A tie the ranking could not separate means there is no clear intent to recover.
        return (best && !tied) ? best : null;
    },

    // Calendar names, the one place truncation is safe to complete.
    //
    // A general prefix rule cannot work. English is full of words that begin other words,
    // and a sweep of thirty-five ordinary ones turned up seven wrong completions --
    // "mark" to "market", "count" to "country", "star" to "start", "mat" to "math",
    // "ever" to "every". No dictionary fixes that, because the typo and the completion are
    // both real words; the rule itself is the problem.
    //
    // Day and month names are different: they are a closed set of twenty, people really do
    // stop typing them early ("Monda", "Tuesda", "Januar"), and no ordinary word is a
    // prefix of one. Restricting completion to this set keeps the case that motivated the
    // rule and removes the class of error it was generating.
    CALENDAR: [
        'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
        'january', 'february', 'march', 'april', 'june', 'july', 'august',
        'september', 'october', 'november', 'december', 'today', 'tomorrow', 'yesterday'
    ],

    /**
     * Calendar names the typo is a prefix of ("monda" for "monday").
     * @param {string} word
     * @returns {Array} Candidate words.
     */
    truncations: function (word) {
        if (word.length < 4) return [];
        return this.CALENDAR.filter(candidate =>
            candidate.length > word.length &&
            candidate.length - word.length <= this.MAX_TRUNCATION &&
            candidate.startsWith(word));
    },

    /**
     * Corrects every misspelled word in a piece of text.
     *
     * Words carrying a digit, an underscore, an inner capital or a leading capital in
     * mid-sentence position are skipped: those are identifiers and names, not prose, and
     * the dictionary has no business guessing at them. A capitalised word at the start of
     * a sentence is ordinary prose and is corrected, with its capital restored.
     *
     * That mid-sentence rule costs real corrections -- "on Monda" is left alone where
     * "on monda" is fixed -- and it is still the right trade. Prompts are full of names
     * the dictionary has never seen, and rewriting somebody's colleague or library into
     * the nearest dictionary word is far worse than leaving a capitalised typo in place.
     *
     * @param {string} text - Prompt text, already masked if protection is in use.
     * @param {Object} options - { extraKnown: Set } of words to treat as correct.
     * @returns {Object} { text, corrections } where corrections is [{ from, to }].
     */
    correct: function (text, options) {
        if (!text || typeof text !== 'string') return { text: text || '', corrections: [] };

        const settings = options || {};
        const extraKnown = settings.extraKnown || null;
        const corrections = [];

        const out = text.replace(/[A-Za-z][A-Za-z']*/g, (match, offset) => {
            // Identifiers, acronyms and names: anything but plain lowercase prose.
            if (/[A-Z]/.test(match.slice(1))) return match;
            if (match.indexOf("'") !== -1) return match;

            const lower = match.toLowerCase();
            if (extraKnown && extraKnown.has(lower)) return match;

            const capitalised = match[0] !== lower[0];
            if (capitalised && !this.opensSentence(text, offset)) return match;

            const fixed = this.correctWord(lower);
            if (!fixed || fixed === lower) return match;

            corrections.push({ from: match, to: fixed });
            return capitalised ? fixed.charAt(0).toUpperCase() + fixed.slice(1) : fixed;
        });

        return { text: out, corrections: corrections };
    },

    /**
     * True when the character offset is the first word of the text or of a sentence.
     * @param {string} text
     * @param {number} offset
     * @returns {boolean}
     */
    opensSentence: function (text, offset) {
        for (let i = offset - 1; i >= 0; i--) {
            const character = text.charAt(i);
            if (/\s/.test(character)) continue;
            return /[.!?\n]/.test(character);
        }
        return true;
    }
};

// Index the dictionary once, at load time rather than per keystroke.
PromptMeterSpelling.rank = new Map();
PromptMeterSpelling.skeletonIndex = new Map();
PromptMeterSpelling.cache = new Map();

PM_WORDS.forEach((word, index) => {
    // A word listed twice keeps its first, commoner rank.
    if (PromptMeterSpelling.rank.has(word)) return;
    PromptMeterSpelling.rank.set(word, index);

    const key = PromptMeterSpelling.skeleton(word);
    if (!PromptMeterSpelling.skeletonIndex.has(key)) {
        PromptMeterSpelling.skeletonIndex.set(key, []);
    }
    PromptMeterSpelling.skeletonIndex.get(key).push(word);
});

// Export for global (content script) and bundler environments
if (typeof window !== 'undefined') {
    window.PromptMeterSpelling = PromptMeterSpelling;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { PromptMeterSpelling, PM_WORDS };
}

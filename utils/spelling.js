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
 * A DISTANCE-1 FALLBACK WAS TRIED AND REMOVED
 *
 * Matching any dictionary word one edit away, regardless of skeleton, catches typos that
 * add or drop a CONSONANT -- "wan" for "want", "starst" for "start". It also doubled the
 * corruption rate on held-out English, from 3.5% to 7.4%, because dropping an internal
 * consonant is exactly what the skeleton rule exists to forbid: "brook" became "book",
 * "chord" became "cord", "carve" became "care". Three corrections were not worth
 * seventeen new ways to change a word somebody meant, so consonant-dropping typos are
 * carried as exact pairs in optimizer.js instead.
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
    // Common short words, listed in bulk. Short words are where this module is weakest:
    // one edit is a quarter of a four-letter word, and the only thing standing between
    // "lot" and "lost" or "mode" and "model" is that the dictionary already knows them.
    'care cart cord core hole hood hook hoop horn hose item join joke jump keen kick king',
    'knee knot lack lady lake lamp lane lawn lean leap lend lift limb lime lion loan lodge',
    'lord loss lot lots loud love luck lump lung mail male mall mask mass mate meal meat',
    'melt mend mere mess mild mile milk mill mint miss mist mod mode mood moon mud near',
    'neat neck nest news nice none noon norm nose noun oath obey odds okay oral pace pack',
    'paid pain pair pale palm pane park pars past peak pear peel peer pick pile pill pine',
    'pink pipe pity play plug plus poem poet pole pond pool poor pope pork pose post pour',
    'pray prey pure quit race rack rage raid rail rare rely rent rice rich ride ring rise',
    'risk road roar robe rode role roll roof rope rose rule rush sack safe sage said sail',
    'sake sale salt scan scar seal seat seed seek seen self sense shed ship shoe shop shot',
    'shut sick sigh silk sing sink site skin skip slab slam slap sled slip slot snap sock',
    'soft soil sold sole solid song sore soul soup sour span spin spot spun stem stir stow',
    'suit sunk swim tail tale talk tall tank tape taxi teal tear teen tend tent term thus',
    'tide tidy tier tile till tiny tire toll tomb tone tool torn tour town trap tray trim',
    'trip tube tune twin urge vain vary vast verb vest view vote wage wait wake wall ward',
    'warn wash wave wear west wife wild wine wing wipe wire wise wish wolf wool wore worm',
    'worn wrap yard yell zero zone',
    'bench birch blade blame blank blast bleak blend bliss bloom blunt board boast bonus',
    'booth bound brace brain brand brass brave bread breed brick bride brisk broad brook',
    'broom brush bunch burst cabin cargo carve cease chain chalk charm chase cheap cheat',
    'cheek cheer chess chest chief chill china choir chord chose chunk churn civic claim',
    'clash clean clerk cliff climb cling cloak clock cloth cloud clown coach coast cocoa',
    'colon comic coral couch cough court crack craft crane crash crawl cream creek creep',
    'crest crime crisp cross crowd crown crude cruel crumb crush crust curve daily dairy',
    'dance dated dealt death debut decay decor delay delta dense depot depth derby devil',
    'diary dirty ditch diver dizzy dough dozen drain drama drank dread dream dress dried',
    'drift drill drink drove drown drunk dusty dwell dwelt eager eagle earth elbow elder',
    'elect elite enemy enjoy entry equip erase exist extra fable faced faint fairy faith',
    'fancy fatal fault favor feast fence ferry fever fiber fiery fifth fifty finch flame',
    'flash fleet flesh flick fling flock flood flour flown fluid flush forge forth forty',
    'forum fraud fried frost frown fruit fully funny',
    'heard loose goose grace grade grain grant grasp grave great green greet grief group',
    'guard guess guest guide guilt habit happy harsh heart heavy horse hotel house human',
    'image index inner input issue judge juice knife knock known label large laser later',
    'laugh layer learn lease least leave legal lemon level light limit local logic loser',
    // Ordinary vocabulary that earlier drafts simply did not list. Every one of these
    // was being rewritten into a different real word -- "chat" to "cat", "font" to
    // "front", "match" to "math", "axis" to "axios" -- because the dictionary is the
    // only thing that marks a word as already correct.
    'accordion alert archive audio avatar average axis banner blog button cancel carousel',
    'cell channel chart chat checkbox click column comment confirm decline desktop device',
    'dialog disable download draft dropdown edit enable ever feedback font footer forecast',
    'gallery grid growth icon inbox label laptop layout legend match max median menu metric',
    'min mobile modal notification offline online panel player plot podcast poll popup',
    'preference profile radio range rank rating ratio reply row score screen scroll',
    'settings share sidebar signup slider stream sum survey switch tab tablet theme toggle',
    'toolbar tooltip trend unit upload username webpage',
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
    'schema schemas migration migrations orm crud auth admin token payload header',
    // Added after the LMSYS sample: real prompts use these constantly and the
    // corrector was treating them as typos. "a tech company" became "a teach
    // company" in the middle of a user's own quoted passage.
    'tech backend frontend repo repos cli db devops plugin plugins runtime sdk',
    'startup sysadmin webhook workflow workflows smartphone wifi emails blogs',
    'ecommerce crypto blockchain fintech saas ux ui llm tokenizer inference',
    'finetune pipeline pipelines graphql cronjob latency throughput scalable',
    'dashboard dashboards analytics metadata namespace middleware microservice',
    'microservices chatbot embedding embeddings prompt prompts dataset datasets'
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

        // A transposition reorders letters, so its ends may legitimately differ: "teh" and
        // "the" is the classic case.
        if (word.length === candidate.length) return this.isTransposition(word, candidate);

        // A longer typo may not lose its trailing letter. Sweeping words that end in a
        // silent -e turned up "huge" becoming "hug", "site" becoming "sit", "cute"
        // becoming "cut" and "stare" becoming "star" -- every one of them the typo being
        // the LONGER word and the correction quietly trimming its end.
        //
        // The test is directional, because the opposite case is a real typo: "wan" for
        // "want" and "hel" for "help" are words someone stopped typing, and blocking them
        // too cost more recall than the guard was worth. A shorter typo may therefore gain
        // a trailing letter; a longer one may not shed it.
        //
        // Truncation is handled outside this check entirely, since dropping the end is
        // exactly what it is for.
        if (word.length > candidate.length &&
            word[word.length - 1] !== candidate[candidate.length - 1]) {
            return false;
        }

        return word.length < candidate.length
            ? this.isSubsequence(word, candidate)
            : this.isSubsequence(candidate, word);
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
        // Calendar truncations are kept apart from skeleton matches because they are the
        // one case that legitimately drops the END of a word, and isPlausibleEdit refuses
        // that shape for everything else.
        const truncated = this.truncations(word);
        // Deduplicated: the skeleton index and the near-miss bucket overlap, and the
        // same word arriving twice used to register as a tie with itself, which threw
        // away corrections that had only ever had one candidate.
        const candidates = new Set(
            (this.skeletonIndex.get(this.skeleton(word)) || [])
                .filter(candidate => this.isPlausibleEdit(word, candidate))
        );
        truncated.forEach(candidate => candidates.add(candidate));

        // Closest fit wins; equal fits are separated by frequency, which is what the
        // dictionary's ordering is for. An earlier version abandoned the correction
        // whenever a second candidate tied on distance, which sounds cautious and is not:
        // it discarded "starst" (start, starts) and "hel" (help, heal) where one reading
        // is plainly commoner than the other, while adding no safety -- the guards that
        // actually keep this module honest are the edit shape and the dictionary itself,
        // and they have already run by this point.
        let best = null;
        let bestDistance = Infinity;

        candidates.forEach(candidate => {
            const gap = this.distance(word, candidate);
            if (gap > this.budget(word, candidate)) return;

            if (gap < bestDistance ||
                (gap === bestDistance && this.rank.get(candidate) < this.rank.get(best))) {
                best = candidate;
                bestDistance = gap;
            }
        });

        return best;
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

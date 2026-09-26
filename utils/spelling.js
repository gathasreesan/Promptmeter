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
,

    // --- General English ------------------------------------------------------------
    //
    // Source: the google-10000-english frequency list (first20hours/google-10000-english),
    // filtered to alphabetic words of three letters or more, minus everything already
    // listed above and every key in the typo and slang tables.
    //
    // This is here because the corrector was CORRUPTING more than it fixed. Measured over
    // 8,000 real prompts with the previous 2,191-word list, 1,556 of its 2,287 corrections
    // landed on words that were already correct English: "met" became "meet", "non"
    // became "none", "com" became "come". A word the dictionary does not know looks
    // exactly like a misspelling, so coverage is not a nice-to-have here, it is the
    // difference between a corrector and a corrupter.
    //
    // It also fixes the reported miss: "fnite" could never reach "finite", because
    // "finite" was not a word this file had heard of.
    'aaa aaron abandoned abc aberdeen abilities ability aboriginal abortion abraham abroad abs',
    'absence absent absolute absolutely absorption abstract abstracts abu abuse academic academics',
    'academy acc accent acceptable acceptance accepted accepting accessed accessibility accessing',
    'accessories accessory accident accidents accommodate accommodation accommodations accompanied',
    'accompanying accomplish accomplished accordance according accordingly accountability',
    'accounting accreditation accredited accurately accused acdbentity ace acer achieve achieved',
    'achievement achievements achieving acid acids acknowledge acknowledged acm acne acoustic',
    'acquire acquired acquisition acquisitions acre acres acrobat acrylic act acting action actions',
    'activated activation active actively activists activities activity actor actors actress acts',
    'actual acute ada adam adams adaptation adapted adapter adapters adaptive adaptor addiction',
    'addition additional additionally additions addressed addressing adelaide adequate adidas',
    'adipex adjacent adjust adjustable adjusted adjustment adjustments administered administration',
    'administrative administrator administrators admission admissions admit admitted adobe',
    'adolescent adopt adopted adoption adrian ads adsl adult adults advancement advances advantage',
    'advantages adventure adventures adverse advert advertise advertisement advertisements',
    'advertiser advertisers advertising advice advise advised advisor advisors advisory advocacy',
    'advocate adware aerial aerospace affair affairs affect affected affecting affects affiliate',
    'affiliated affiliates affiliation afford affordable afghanistan afraid africa african',
    'afternoon afterwards age aged agencies agency agenda agent agents ages aggregate aggressive',
    'aging ago agreed agreement agreements agricultural agriculture aid aids aim aimed aims',
    'aircraft airfare airline airlines airplane airport airports aka ala alabama alan alarm alaska',
    'albania albany albert alberta album albums albuquerque alcohol alerts alex alexander',
    'alexandria alfred algebra algeria ali alias alice alien align alignment alike alive allah',
    'allan alleged allen allergy alliance allied allocated allocation allow allowance allowed',
    'allowing allows alloy alpha alphabetical alpine alt alter altered alternate alternative',
    'alternatively alternatives alto aluminium aluminum alumni amanda amateur amazing amazon',
    'ambassador amber ambien ambient amd amend amended amendment amendments amenities america',
    'american americans americas amino amongst amp ampland amplifier amsterdam amy ana anaheim',
    'analog analysis analyst analysts analytical analyzed anatomy anchor ancient andale anderson',
    'andorra andrea andreas andrew andrews andy angel angela angeles angels anger angle angola',
    'animal animals animated animation anime ann anna anne annex annie anniversary annotated',
    'annotation announce announced announcement announcements announces annoying annual annually',
    'anonymous answered answering antarctica antenna anthony anthropology anti antibodies antibody',
    'anticipated antigua antique antiques antivirus antonio anxiety anybody anymore anytime anyway',
    'aol apartment apartments apnic apollo apparatus apparel apparent apparently appeal appeals',
    'appearance appeared appearing appendix apple appliance appliances applicable applicant',
    'applicants applied applies apply applying appointed appointment appointments appraisal',
    'appreciate appreciated appreciation appropriate appropriations approval approve approved',
    'approximate approximately apr apt aqua aquarium aquatic arab arabia arabic arbitrary',
    'arbitration arbor arc arcade arch architect architects architectural architecture archived',
    'archives arctic arena argentina argue argued argument arguments arise arising arizona arkansas',
    'arlington arm armed armenia armor arms armstrong army arnold arrange arranged arrangement',
    'arrangements arrest arrested arrival arrivals arrive arrived arrives arrow arthritis arthur',
    'artificial artist artistic artists arts artwork aruba asbestos ash ashley asia asian asin asn',
    'asp aspect aspects assault assembled assembly assess assessed assessing assessment assessments',
    'asset assets assign assigned assist assistance assisted assists associate associated',
    'associates association associations assumed assuming assumption assumptions assurance assure',
    'assured asthma astrology astronomy asus asylum ata ate athens athletes athletic athletics ati',
    'atlanta atlantic atlas atm atmosphere atmospheric atom atomic attach attached attachment',
    'attachments attack attacked attacks attempted attempting attend attendance attended attending',
    'attitude attitudes attorney attorneys attract attraction attractions attractive attribute',
    'attributes auburn auckland auction auctions aud audi audience audit auditor aug aurora aus',
    'austin australia australian austria authentic authentication author authorities authority',
    'authorization authorized authors auto automated automatic automatically automation automobile',
    'automobiles automotive autos autumn availability ave avenue avg avi aviation avoiding avon',
    'award awarded awards aware awareness away awesome awful aye azerbaijan babe babes babies baby',
    'bachelor backed background backgrounds backing backup bacon bacteria bacterial badge baghdad',
    'bags bahamas bahrain bailey baker baking balance balanced bald bali ball ballet balloon ballot',
    'baltimore ban banana band bands bandwidth bang bangkok bangladesh bank banking bankruptcy',
    'banks banned banners baptist barbados barbara barbie barcelona bare barely bargain bargains',
    'barn barnes barrel barrier barriers barry bars base baseball based baseline basement basename',
    'bases basics basin basis basket basketball baskets bass batch bath bathroom bathrooms baths',
    'batman batteries battery battle battlefield bay bbc bbs beach beaches beads beam bean beans',
    'bear bearing bears beast beastality beat beatles beats beautiful beautifully beauty beaver',
    'became become becomes becoming bedding bedford bedroom bedrooms beds beef beer began begin',
    'beginners beginning begins begun behalf behavior behavioral beijing beings belarus belfast',
    'belgium belief beliefs believed believes belize belkin bell belle belly belong belongs belt',
    'belts ben benchmark bend beneath beneficial benefits benjamin bennett bent benz berkeley',
    'berlin bermuda bernard berry bestsellers bet beta beth betting betty beverage beverages',
    'beverly bhutan bias bible biblical bibliographic bibliography bicycle bid bidder bidding bids',
    'bigger biggest bike bikes bikini bill billing billion bills billy bind binding bingo bio',
    'biodiversity biographies biography biol biological bios biotechnology bird birds birmingham',
    'birth birthday bishop bite biz bizarre bizrate black blackberry blackjack blacks blades blah',
    'blair blake blanket bleeding bless blessed blind blink block blocked blocking blocks blogger',
    'bloggers blogging blond blonde blood bloomberg blow blowing blue blues bluetooth blvd bmw',
    'boards boat boating boats bob bobby boc bodies bold bolivia bolt bomb bon bond bonds bone',
    'bones booking bookings bookmark bookmarks bookstore boom boost boot boots booty border borders',
    'boring born borough bosnia boss boston bother botswana bottle bottles bought boulder boulevard',
    'boundaries boundary bouquet boutique bow bowl bowling boxed boxes boxing boys bra bracelet',
    'bracelets bracket brad bradford bradley brake brakes branches brandon brands bras brazil',
    'brazilian breach breakdown breakfast breaking breast breath breathing breeding breeds brian',
    'bridal bridge bridges briefing briefly briefs bright brighton brilliant bringing brisbane',
    'bristol britain britannica british britney broadband broadcast broadcasting broader broadway',
    'brochure brochures broke broker brokers bronze brooklyn brooks brother brothers brought brown',
    'browse browsing bruce brunei brunette brunswick brussels brutal bryan bryant bubble buck bucks',
    'budapest buddy budget budgets buf buffalo bufing builder builders buildings bulgaria bulgarian',
    'bulk bull bullet bulletin bumper bundle bunny burden bureau buried burke burlington burn',
    'burner burning burns burton bus buses bush businesses butler butter butterfly buttons butts',
    'buyer buyers buying buzz bye cab cabinet cabinets cable cables cached cad cadillac cafe cage',
    'cake cakes cal calcium calculated calculation calculations calculator calculators calendar',
    'calendars calgary calibration california calm calvin cam cambodia cambridge camcorder',
    'camcorders camel camera cameras cameron cameroon camp campaign campaigns campbell camping',
    'camps campus cams canada canadian canal canberra cancellation cancelled cancer candidate',
    'candidates candle candles candy cannon canon cant canvas canyon capabilities capability',
    'capable capacity cape capital capitol caps captain capture captured carb carbon cardiac',
    'cardiff cardiovascular cards career careers careful carefully carey caribbean caring carl',
    'carlo carlos carmen carnival carol carolina caroline carpet carried carrier carriers carroll',
    'carrying cars carter cartoon cartoons cartridge cartridges cas casa casey cash cashiers casino',
    'casinos casio cassette cast casting castle casual catalog catalogs catalogue catalyst',
    'categories category catering cathedral catherine catholic cats cattle caught caused causing',
    'caution cave cayman cbs ccd cdna cds cdt cedar ceiling celebrate celebration celebrities',
    'celebrity celebs cells cellular celtic cement cemetery census cent centered centers central',
    'centres cents centuries century ceo ceramic ceremony certainly certificate certificates',
    'certification certified cet cfr cgi chad chains chair chairman chairs challenge challenged',
    'challenges challenging chamber chambers champagne champion champions championship',
    'championships chan chance chancellor chances changed changelog channels chaos chapel character',
    'characteristic characteristics characterization characterized characters charge charged',
    'charger chargers charges charging charitable charity charles charleston charlie charlotte',
    'charming charms charter charts chassis cheaper cheapest cheats checklist checkout cheers',
    'cheese chef chelsea chem chemical chemicals chen cheque cherry chester chevrolet chevy chi',
    'chicago chick chicken chicks childhood childrens chile chinese chip chips cho chocolate choice',
    'choices cholesterol choosing chorus chosen chris christ christian christianity christians',
    'christina christine christmas christopher chrome chronic chronicle chronicles chrysler chubby',
    'chuck church churches cia cialis ciao cigarette cigarettes cincinnati cindy cinema cingular',
    'cio cir circle circles circuit circuits circular circulation circumstances circus cisco',
    'citation citations cite cited cities citizen citizens citizenship citysearch civil civilian',
    'civilization claimed claims claire clan clara clarity clark clarke classic classical classics',
    'classified classifieds classroom clause clay cleaner cleaners cleaning cleanup clearance',
    'cleared clearing cleveland clicking clicks climate climbing clinic clinical clinics clinton',
    'clip clips clocks close closed closely closer closes closest closing closure clothes clothing',
    'clouds cloudy club clubs cluster clusters cms cnet cnn coaches coaching coal coalition coastal',
    'coat coated coating cocktail cod coffee cognitive cohen coin coins col cole coleman colin',
    'collaboration collaborative collapse collar colleague colleagues collect collectables',
    'collected collectible collectibles collecting collection collections collective collector',
    'collectors college colleges collins cologne colombia colonial colony colorado colored columbia',
    'columbus columnists columns com combat combination combinations combine combined combines',
    'combining combo comedy comfort comfortable comics comm commander commentary commented comments',
    'commerce commercial commission commissioner commissioners commissions commitment commitments',
    'committed committee committees commodities commodity commonly commons commonwealth communicate',
    'communication communications communist communities community comp compact companies companion',
    'compaq comparable comparative compared compatibility compatible compensation compete competent',
    'competing competition competitions competitive competitors compilation compiled complaint',
    'complaints complement completed completely completing completion compliance compliant',
    'complicated complications complimentary comply composed composer composite composition',
    'compound compounds compressed compression compromise computation computational compute',
    'computed computers computing con concentrate concentration concentrations conceptual concern',
    'concerned concerning concerns concert concerts conclude concluded conclusion conclusions',
    'concord concrete conditional conditioning condo condos conduct conducted conducting conference',
    'conferences conferencing confidence confident confidential confidentiality configuration',
    'configurations configure configured configuring confirmation confirmed conflict conflicts',
    'confusion congo congratulations congress congressional conjunction connected connecticut',
    'connecting connection connections connectivity connector connectors cons conscious',
    'consciousness consecutive consensus consent consequence consequences consequently conservation',
    'conservative considerable consideration considerations considered considering consist',
    'consistency consistent consistently consisting consists console consoles consolidated',
    'consolidation consortium conspiracy constant constantly constitute constitutes constitution',
    'constitutional constraint constraints construct constructed construction consult consultancy',
    'consultant consultants consultation consulting consumer consumers consumption contact',
    'contacted contacting contacts contain contained container containers containing contains',
    'contamination contemporary contents contest contests continent continental continually',
    'continued continues continuing continuity continuous continuously contract contracting',
    'contractor contractors contracts contrary contrast contribute contributed contributing',
    'contribution contributions contributor contributors controlled controller controllers',
    'controlling controversial controversy convenience convenient convention conventional',
    'conventions convergence conversation conversations conversion converted converter convertible',
    'convicted conviction convinced cook cookbook cooked cookie cookies cooking cooler cooling',
    'cooper cooperation cooperative coordinate coordinated coordinates coordination coordinator cop',
    'cope copied copies copper copy copying copyright copyrighted copyrights cordless cork corn',
    'cornell corner corners cornwall corp corporate corporation corporations corps corpus corrected',
    'correction corrections correctly correlation correspondence corresponding corruption cos',
    'cosmetic cosmetics costa costs costume costumes cottage cottages cotton council councils',
    'counsel counseling counted counter counters counties counting countries counts county couple',
    'coupled couples coupon coupons courage courier courtesy courts cove coverage covered covering',
    'cowboy cradle crafts craig craps crawford crazy creation creations creative creativity creator',
    'creature creatures credit credits crew cricket crimes criminal crisis criteria criterion',
    'critical criticism critics crm croatia crop crops crossing crossword crucial cruise cruises',
    'cruz cry crystal cst ctrl cuba cube cubic cuisine cult cultural culture cultures cumulative',
    'cups cure curious currencies currency current currently curriculum cursor curtis curves',
    'custody custom customer customers customize customized customs cute cutting cvs cyber cycle',
    'cycles cycling cylinder cyprus czech dad daddy daisy dakota dale dallas dam damage damaged',
    'damages dame dan dana dancing danger dangerous daniel danish danny dans dare dark darkness',
    'darwin das dash dat date dates dating daughter daughters dave david davidson davis dawn dayton',
    'ddr dead deadly deaf deal dealer dealers dealing deals dealtime dean dear deaths debate debian',
    'deborah debt dec decade decades decent decided decision decisions deck declaration declare',
    'declared declined decorating decorative decrease decreased dedicated dee deemed deeper deeply',
    'deer def default defeat defects defence defend defendant defense defensive deferred deficit',
    'defined defining definitely degree degrees del delaware delayed delays delegation deleted',
    'delhi delicious delight deliver delivered delivering delivers delivery dell deluxe dem demand',
    'demanding demands demo democracy democrat democratic democrats demographic demonstrate',
    'demonstrated demonstrates demonstration den denial denied denmark dennis density dental',
    'dentists denver deny department departmental departments departure dependence dependent',
    'depending deposit deposits depression dept deputy der derek derived des descending desert',
    'deserve designated designation designed designer designers designing desirable desire desired',
    'desk desktops desperate destination destinations destiny destroy destroyed destruction detect',
    'detected detection detective detector determination determine determined determines',
    'determining detroit deutsch deutsche deutschland dev devel developed developer developers',
    'developing development developmental developments deviant deviation devices devon devoted',
    'diabetes diagnosis diagnostic diagram dial dialogue diameter diamond diamonds diana diane dice',
    'dicke dictionaries dictionary die died diego dies diesel diet dietary differ differential',
    'differently difficulties difficulty diffs dig digest digit digital dim dimension dimensional',
    'dimensions dining dinner dip diploma direct directed direction directions directive directly',
    'director directors dirt dis disabilities disability disabled disagree disappointed disaster',
    'disc discharge disciplinary discipline disciplines disclaimer disclaimers disclose disclosure',
    'disco discount discounted discounts discover discovered discovery discrete discretion',
    'discrimination discs discuss discussed discusses discussing discussion discussions disease',
    'diseases dish dishes disks disney disorder disorders dispatch dispatched displayed displaying',
    'disposal disposition dispute disputes dist distance distances distant distinct distinction',
    'distinguished distribute distributed distribution distributions distributor distributors',
    'district districts disturbed div dive diverse diversity divide divided dividend divine diving',
    'division divisions divorce divx diy dna dock docs doctor doctors doctrine document documentary',
    'documentation documented documents dod dodge doe dogs doll dollar dollars dolls dom domain',
    'domains dome domestic dominant dominican don donald donate donated donation donations donna',
    'donor donors dont doom door doors dos dosage dose dot doubt doug douglas dover dow',
    'downloadable downloaded downloading downloads downtown dozens dpi drag dragon drainage',
    'dramatic dramatically drawing drawings drawn dreams dressed dresses dressing drew drilling',
    'drinking drinks drive driven driver drivers drives driving drop dropped drops drug drugs drum',
    'drums dryer dsc dsl dts dual dubai dublin duck dude due dui duke dumb dump duncan duo',
    'duplicate durable duration durham dutch duties duty dvd dvds dying dylan dynamic dynamics',
    'eagles ear earl earlier earliest earn earned earning earnings earrings ears earthquake ease',
    'easier easily east easter eastern eating eau ebay ebony ebook ebooks echo eclipse eco',
    'ecological ecology economic economies economy ecuador eddie eden edgar edinburgh edited',
    'editing edition editions editor editorial editorials editors edmonton eds edt educated',
    'education educational educators edward edwards effective effectively effectiveness efficiency',
    'efficient efficiently egg eggs egypt egyptian elderly elected election elections electoral',
    'electric electrical electricity electro electron electronic electronics elegant element',
    'elementary elements elephant elevation eleven eligibility eligible eliminate elimination',
    'elizabeth ellen elliott ellis else elsewhere elvis emacs embassy embedded emerald emergency',
    'emerging emily eminem emirates emission emissions emma emotional emotions emperor emphasis',
    'empire empirical employ employed employee employees employer employers employment enabled',
    'enables enabling enb enclosed enclosure encoding encounter encountered encourage encouraged',
    'encourages encouraging encryption encyclopedia endangered ended endif ending endless endorsed',
    'endorsement enemies enforcement eng engage engaged engagement engaging engine engineer',
    'engineering engineers engines england enhance enhanced enhancement enhancements enhancing',
    'enjoyed enjoying enlarge enlargement enormous enquiries enquiry enrolled enrollment ensemble',
    'ensure ensures ensuring ent enter entered entering enterprise enterprises enters entertaining',
    'entertainment entirely entities entitled entity entrance entrepreneur entrepreneurs entries',
    'envelope environment environmental environments enzyme eos epa epic epinions episode episodes',
    'epson equal equality equally equation equations equilibrium equipment equipped equity',
    'equivalent era eric ericsson erik erotica erp escape escorts espn essence essential',
    'essentially essentials essex est establish established establishing establishment estate',
    'estates estimate estimated estimates estimation estonia etc eternal ethernet ethical ethics',
    'ethiopia ethnic eugene eur euro europe european euros eva eval evaluate evaluated evaluating',
    'evaluation evaluations evanescence evans eve even event events eventually everybody everyday',
    'evidence evident evil evolution exactly examination examinations examine examined examines',
    'examining exceed excel excellence excellent exceptional exceptions excerpt excess excessive',
    'exchange exchanges excitement exciting exclude excluded excluding exclusion exclusive',
    'exclusively excuse exec execute executed execution executive executives exempt exemption',
    'exercise exercises exhaust exhibit exhibition exhibitions exhibits existed existence existing',
    'exists exit exotic exp expand expanded expanding expansion expansys expectations expedia',
    'expenditure expenditures expense expenses expensive experience experienced experiences',
    'experiencing experiment experimental experiments expertise expiration expired expires explicit',
    'explicitly exploration explore explorer exploring explosion expo exposed exposure expressed',
    'expression expressions ext extend extended extending extends extension extensions extensive',
    'extent exterior external extract extraction extraordinary extras extreme extremely eyed eyes',
    'fabric fabrics fabulous faces facial facilitate facilities facility facing factor factors',
    'factory faculty fail failed failing fails failure failures fair fairfield fairly fake fallen',
    'falling fame familiar families famous fan fans fantastic fantasy faq faqs fare fares farm',
    'farmer farmers farming farms fascinating fashion faster fastest fat fate father fathers fatty',
    'favorite favorites favors fax fbi fcc fda fear fears feat featured featuring feb fed federal',
    'federation fee feed feeding feeds feel feeling feelings feels fees feet fell fellow fellowship',
    'felt female females feof ferrari festival festivals fetish fewer fibre fiction fifteen fig',
    'fight fighter fighters fighting figure figured figures fiji filed filename filing fill filled',
    'filling film filme films filtering fin finally finance finances financial financing',
    'findarticles finder findings findlaw fine finest finger fingers finish finishing finite',
    'finland finnish fioricet fire fired firefox fireplace fires firewall firewire firm firms',
    'firmware fiscal fish fisher fisheries fishing fist fit fitness fits fitted fitting fixtures',
    'flashers flashing flat flavor fleece flex flexibility flexible flickr flight flights flip',
    'floating floor flooring floors floppy floral florence florida florist florists flow flower',
    'flowers flows floyd flu flux fly flyer flying foam focal focus focused focuses focusing fog',
    'fold folders folding folk folks followed following fonts foo foods fool foot footage football',
    'footwear forbes forbidden force forced forces ford forecasts foreign forest forestry forests',
    'forever forget forgot forgotten formal formation formatting formed former formerly forming',
    'formula fort fortune forums forward forwarding fossil foster foto fotos fought foul foundation',
    'foundations founded founder fountain fourth fraction fragrance fragrances frame framed frames',
    'framing france franchise francis francisco frank frankfurt franklin fraser fred frederick',
    'freebsd freedom freelance freely freeware freeze freight french frequencies frequency frequent',
    'frequently fresh fri fridge friendly friendship frog frontier frontpage frozen fruits ftp fuel',
    'fuji fujitsu fun functional functionality functioning fund fundamental fundamentals funded',
    'funding fundraising funds funeral funk funky fur furnished furnishings furniture further',
    'fusion future futures fuzzy fwd gabriel gadgets gage gain gained gains galaxy gale galleries',
    'gambling game gamecube games gamespot gaming gamma gang gap gaps garage garbage garcia garden',
    'gardening gardens garlic garmin gary gasoline gate gates gateway gather gathered gathering',
    'gauge gay gays gazette gba gbp gcc gdp gear geek gel gem gen gender gene genealogy generally',
    'generated generation generations generator generators generic generous genes genesis genetic',
    'genetics geneva genius genome genre genres gentle gentleman gently genuine geo geographic',
    'geographical geography geological geology geometry george georgia gerald german germany ghana',
    'ghost ghz giant giants gibraltar gibson gift gifts gig gilbert girlfriend girls gis given glad',
    'glance glasgow glass glasses glen glenn global globe glory glossary gloves glow glucose gmbh',
    'gmc gmt gnome gnu goat gods golden golf gonna goods google gordon gore gorgeous gospel gossip',
    'gothic goto gotten gourmet governance governing government governmental governments governor',
    'gpl gps grab grad grades gradually graduate graduated graduates graduation graham grams grand',
    'grande granny granted grants graphic graphical graphics gras grass grateful gratis gratuit',
    'gravity gray greater greatest greatly greece greek greene greenhouse greensboro greeting',
    'greetings greg gregory grenada grew grey griffin grill grip grocery groove gross ground',
    'grounds groundwater grove growing grown gsm gst gtk guam guarantee guaranteed guarantees',
    'guardian guards guatemala guestbook guests gui guidance guided guidelines guides guild guilty',
    'guinea guitar guitars gulf gun guns guru guy guyana guys gym gzip habitat habits hack hacker',
    'hair hairy haiti halifax halloween halo ham hamburg hamilton hammer hampshire hampton handbags',
    'handbook handed handheld handhelds handled handmade hands handy hang hanging hans hansen',
    'happened happening happiness harassment harbor hardcover harder hardly hardwood harley harmful',
    'harmony harold harper harris harrison harry hart hartford harvard harvest harvey hats haven',
    'hawaii hawaiian hawk hay hayes hazard hazardous hazards hdtv headed headers heading headline',
    'headlines headphones headquarters heads headset healing healthcare healthy hear hearing',
    'hearings hearts heated heater heath heather heating heaven heavily hebrew heel height heights',
    'held helen helena helicopter hello helmet hence henderson henry hepatitis herald herb herbal',
    'herbs hereby herein heritage hero heroes herself hewlett hey hidden hide hierarchy higher',
    'highest highland highlight highlighted highlights highly highs highway highways hiking hill',
    'hills hilton himself hindu hint hints hip hire hired hiring hispanic hist historic historical',
    'hitachi hits hitting hiv hobbies hobby hockey holdem holder holders holding holdings holes',
    'holiday holidays holland hollow holly hollywood holmes holocaust holy homeland homeless',
    'homepage homes hometown hon honda honduras honest honey hong honolulu honor honors hoped',
    'hopefully hoping hopkins horizon horizontal hormone horrible horror horses hospital',
    'hospitality hospitals hosted hostel hostels hosting hosts hotels hotmail hottest hourly',
    'household households houses housewares housewives housing houston howard howto href hrs hudson',
    'huge hugh hughes hugo hull humanitarian humanities humanity humans humidity humor hundred',
    'hundreds hung hungarian hungary hunger hungry hunt hunter hunting huntington hurricane husband',
    'hwy hybrid hydraulic hydrocodone hydrogen hygiene hypothesis hypothetical hyundai ian ibm',
    'iceland icons icq ict idaho ide ideal identical identification identified identifier',
    'identifies identify identifying identity idle idol ids ieee ignore ignored iii ill illegal',
    'illinois illness illustrated illustration illustrations imagination imagine imaging img',
    'immediate immediately immigrants immigration immune immunology impaired imperial',
    'implementation implemented implementing implications implied implies importance importantly',
    'imported impose imposed impressed impression impressive improvement improvements inappropriate',
    'inc incentive incentives inch inches incidence incident incidents incl inclusion inclusive',
    'income incoming incorporate incorporated increase increased increases increasing increasingly',
    'incredible incurred ind indeed independence independent independently indexed india indian',
    'indiana indianapolis indians indicate indicated indicates indicating indication indicator',
    'indicators indices indie indigenous indirect individual individually individuals indonesia',
    'indonesian indoor induced induction industrial industries industry inexpensive inf infant',
    'infants infected infection infections infectious infinite inflation influence influenced',
    'influences info inform informal informational informative informed infrared infrastructure',
    'infringement ing ingredients inherited initial initially initiated initiative initiatives',
    'injection injured injuries injury ink inkjet inline inn innocent innovation innovations',
    'innovative inns inputs inquire inquiries inquiry ins insects inserted insertion insider',
    'insight insights inspection inspections inspector inspiration inspired installation',
    'installations installed installing instant instantly institute institutes institution',
    'institutional institutions instructional instructor instructors instrument instrumental',
    'instrumentation instruments insulation insulin insurance insured intake integral integrate',
    'integrated integrating integration integrity intel intellectual intelligence intelligent',
    'intended intense intensity intensive intent intention inter interact interaction interactions',
    'interactive interest interested interesting interests interface interfaces interference',
    'interim interior internal international internationally internship interpretation interpreted',
    'interracial intersection interstate interval intervals intervention interventions intimate',
    'intl intranet intro introduce introduced introduces introducing introduction introductory',
    'invasion invention inventory invest investigate investigated investigation investigations',
    'investigator investigators investing investment investments investor investors invisible',
    'invision invitation invitations invite invited invoice involve involved involvement involves',
    'involving ion iowa ipaq ipod ips ira iran iraq iraqi irc ireland irish irrigation irs isa',
    'isaac isbn islam islamic island islands isle iso isolated isolation isp israel israeli issn',
    'issued ist istanbul italia italian italiano italic italy items itself itunes ivory jack jacket',
    'jackets jackie jackson jacksonville jacob jade jaguar jail jake jam jamaica james jamie jan',
    'jane janet japan japanese jar jason jay jazz jean jeans jeep jeff jefferson jeffrey jelsoft',
    'jennifer jenny jeremy jerry jersey jerusalem jesse jessica jesus jet jets jewel jewellery',
    'jewelry jewish jews jill jim jimmy joan joe joel john johnny johns johnson johnston joined',
    'joining joins joint jokes jon jonathan jones jordan jose joseph josh joshua journal journalism',
    'journalist journalists journals journey joy joyce juan judges judgment judicial judy jul julia',
    'julian julie jumping jun junction jungle junior junk jurisdiction jury justice justify justin',
    'juvenile jvc kai kansas karaoke karen karl karma kate kathy katie katrina kay kazakhstan kde',
    'keith kelkoo kelly ken kennedy kenneth kenny keno kent kentucky kenya kernel kerry kevin',
    'keyboard keyboards keyword keywords kidney kids kijiji kill killed killer killing kills',
    'kilometers kim kinase kingdom kings kingston kirk kiss kissing kit kitchen kits kitty klein',
    'knight knights knit knitting knives knowledge knowledgestorm kodak kong korea korean kruger',
    'kurt kuwait kyle lab labeled labels labor laboratories laboratory labs lace ladder laden',
    'ladies lafayette laid lakes lamb lamps lan lancaster lance landing lands landscape landscapes',
    'lanes lang lanka laos lap laptops largely larger largest larry las lasting lat lately latest',
    'latex latin latina latinas latino latitude latter latvia lauderdale laughing launch launched',
    'launches laundry laura lauren law lawrence laws lawsuit lawyer lawyers lay layers lazy lbs lcd',
    'leader leaders leadership leading league learners leasing leather lebanon led lee leeds leg',
    'legacy legally legendary legends legislation legislative legislature legitimate legs leisure',
    'len lender lenders lending lens lenses leo leon leonard leone les lesbian lesbians leslie',
    'lesser letting leu levitra levy lewis lexington lexmark lexus liabilities liability liable',
    'liberal liberia liberty librarian libs licence license licensed licenses licensing licking lie',
    'liechtenstein lies lifestyle lifetime lightbox lighter lighting lightning lights lightweight',
    'liked likelihood likely likewise lil limitation limitations limited limiting limits limousines',
    'lincoln linda lindsay linear lined lingerie linked linking lions lip lips liquid lisa listed',
    'listening listing listings listprice lit lite literacy literary literature lithuania',
    'litigation livecam lived liver liverpool livestock liz llc lloyd llp loaded loading loans',
    'lobby loc locale locally locate located location locations locator locked locking locks',
    'lodging logan logged logging logical logistics logitech logo logos lol london lone lonely',
    'longer longest longitude looked looksmart lookup lopez los losses lottery lotus lou louis',
    'louise louisiana louisville lounge loved lovely lover lovers loves loving lower lowest lows',
    'ltd lucas lucia lucky lucy luggage luis luke lunch luther luxembourg luxury lycos lying lynn',
    'lyric lyrics mac macedonia machinery machines macintosh macro macromedia mad madagascar',
    'madison madness madonna madrid mae mag magazine magazines magic magical magnet magnetic',
    'magnificent magnitude mai maiden mailed mailing mailman mails mailto maine mainland mainly',
    'mainstream maintain maintained maintaining maintains maintenance majority maker makers makeup',
    'malawi malaysia maldives males mali malpractice malta mambo manage managed management manager',
    'managers managing manchester mandate mandatory manga manhattan manitoba manner manor manual',
    'manually manuals manufacture manufactured manufacturer manufacturers manufacturing maple',
    'mapping maps mar marathon marble marc marco marcus mardi margaret margin maria mariah marie',
    'marijuana marilyn marina marine mario marion maritime marked marker markers marketing',
    'marketplace markets marking marks marriage married marriott mars marsh marshall mart martha',
    'martial martin marvel mary maryland mas mason massachusetts massage massive master mastercard',
    'masters matched matches matching material materials maternity mathematical mathematics mating',
    'mats matt matter matters matthew mattress mature maui mauritius maximize maximum mayor mazda',
    'mba mcdonald meals meaningful meanwhile measure measured measurement measurements measures',
    'measuring mechanical mechanics mechanism mechanisms med medal media mediawiki medicaid medical',
    'medicare medication medications medicine medicines medieval meditation mediterranean medium',
    'medline meetup mega mel melbourne melissa mem member members membership membrane memo',
    'memorabilia memorial memories memphis mens ment mental mention mentioned mentor menus mercedes',
    'merchandise merchant merchants mercury mercy merely merger merit merry mesa mesh messaging',
    'messenger met meta metabolism metal metallic metallica metals meter meters methodology metres',
    'metro metropolitan mexican mexico meyer mhz mia miami mic mice michael michel michelle',
    'michigan micro microphone microsoft microwave mid midi midlands midnight midwest mighty mike',
    'mil milan mileage miles military millennium miller million millions mills milton milwaukee',
    'mime minds mineral minerals mines mini miniature minimal minimize minimum mining minister',
    'ministers ministries ministry minneapolis minnesota minolta minority mins minus miracle mirror',
    'mirrors misc miscellaneous missed missile missing mission missions mississippi missouri',
    'mistake mistakes mistress mit mitchell mitsubishi mix mixed mixer mixing mixture mlb mls',
    'mobiles mobility modeling modelling modem modems moderate moderator moderators modern modes',
    'modification modifications modified modify mods modular moisture mold moldova molecular',
    'molecules mom moment moments momentum moms mon monaco monetary mongolia monica monitor',
    'monitored monitoring monitors monkey mono monroe monster monsters montana monte montgomery',
    'monthly montreal moore moral morgan morocco morris morrison mortality mortgage mortgages',
    'moscow moses moss mostly motel motels mother motherboard mothers motion motivated motivation',
    'motor motorcycle motorcycles motorola motors mount mountain mountains mounted mounting mounts',
    'mouse mouth moved movement movements movers movie movies mozambique mozilla mpeg mpegs mpg mph',
    'mrna mrs msgid msgstr msie msn mtv mug multi multimedia mumbai munich municipal municipality',
    'murder murphy murray muscle muscles museum museums musical musician musicians muslim muslims',
    'mustang mutual muze myanmar myers myrtle mysimon myspace mysterious mystery myth nail nails',
    'naked nam named namely namibia nancy nano naples narrative nasa nascar nasdaq nashville nasty',
    'nat nathan nation national nationally nations nationwide native nato natural naturally',
    'naturals nature naughty nav naval navigate navigation navigator navy nba nbc ncaa nearby',
    'nearest nebraska nec necessarily necessity necklace needed needle negative negotiation',
    'negotiations neighbor neighborhood neighbors neil nelson neo neon nepal nerve nested',
    'netherlands netscape networking neutral nevada nevertheless newark newbie newcastle newer',
    'newest newfoundland newly newman newport newsletter newsletters newspaper newspapers newton',
    'nextel nfl nhl nhs niagara nicaragua nicholas nick nickel nickname nicole niger nigeria',
    'nightlife nightmare nights nike nikon nil nintendo nirvana nissan nitrogen noble nobody noise',
    'nokia nominated nomination nominations non nonprofit nor norfolk normal normally norman north',
    'northeast northern northwest norton norway norwegian notebooks noted notice noticed notices',
    'notifications notified notify notion notre nottingham nov nova novel novels novelty nowhere',
    'nsw ntsc nuclear nudist nuke numeric numerical numerous nurse nursery nurses nursing nutrition',
    'nutritional nuts nutten nvidia nyc nylon oak oakland oaks oasis obesity obituaries obj',
    'objective objectives obligation obligations observation observations observed observer obtain',
    'obtained obtaining occasion occasional occasionally occasions occupation occupational',
    'occupations occupied occurred occurrence occurring ocean oclc oct odd oecd oem offense',
    'offensive offered offering offerings office officer officers offices official officially',
    'officials offset offshore ohio oils oklahoma older oldest olive oliver olympic olympics',
    'olympus omaha oman omega omissions ones ongoing onion ons ontario onto ooo oops opened opening',
    'openings opera operate operated operates operating operation operational operations operator',
    'operators opinion opinions opponent opponents opportunities opportunity opposed opposite',
    'opposition opt optical optics optimal optimization optimize optimum optional oracle orange',
    'orbit orchestra ordered ordering ordinance ordinary oregon org organ organic organisation',
    'organisations organisms organization organizational organizations organize organized organizer',
    'organizing oriental orientation oriented origin original originally origins orlando orleans',
    'oscar others ottawa ought ourselves outcome outcomes outdoor outdoors outer outlet outlets',
    'outline outlined outlook outreach outsourcing outstanding oval oven overall overcome overhead',
    'overnight overseas overview owen owned owner owners ownership owns oxford oxide oxygen ozone',
    'pac pacific packaging packard packed packet packets packing packs pads painful paint paintball',
    'painted painting paintings pairs pakistan pal palace palestine palestinian palmer pam pamela',
    'pan panama panasonic panels panic pants pantyhose paperback paperbacks papua par para parade',
    'paradise paraguay parallel parameter parameters parcel parent parental parenting parents paris',
    'parish parker parking parks parliament parliamentary partially participant participants',
    'participate participated participating participation particle particles particular parties',
    'partition partly partner partners partnership partnerships party pas paso passage passed',
    'passenger passengers passing passion passive passport passwords pasta paste pastor pat patches',
    'patent patents pathology patient patients patio patricia patrick patrol pattern patterns paul',
    'pavilion paxil payable payday paying payment payments paypal payroll pci pcs pct pda pdas pdt',
    'peace peaceful pearl peas pediatric pee peeing peers penalties penalty pencil pendant pending',
    'penetration penguin peninsula penn pennsylvania penny pens pension pensions pentium peoples',
    'pepper per perceived percentage perception perfect perfectly performances performed performer',
    'performing perfume period periodic periodically periods peripheral peripherals permalink',
    'permanent permission permissions permitted perry persian persistent personal personality',
    'personalized personally personals personnel persons perspective perspectives perth peru pest',
    'pet pete peter petersburg peterson petite petition petroleum pets pgp phantom pharmaceutical',
    'pharmaceuticals pharmacies pharmacology pharmacy phase phases phd phenomenon phentermine phi',
    'phil philadelphia philip philippines philips phillips philosophy phoenix phone phones photo',
    'photograph photographer photographers photographic photographs photography photos photoshop',
    'phpbb phrase phrases phys physical physically physician physicians physiology piano pic',
    'pichunter picked picking picks pickup picnic pics pictures pie piece pieces pierce pierre pike',
    'pillow pills pilot ping pins pioneer pipes pirates pit pitch pittsburgh pix pixel pixels pizza',
    'placed placement placing plain plains plaintiff plane planes planet planets planned planner',
    'planners planning plants plasma plastic plastics plate plates platform platforms platinum',
    'playback played players playing playlist plays playstation plaza plc pleasant please pleased',
    'pleasure pledge plenty plots plumbing plymouth pmc pmid pocket pockets pod podcasts poems',
    'poetry pointed pointing poison pokemon poker poland polar police policies policy polish',
    'polished political politicians politics polls pollution polo poly polyester polymer polyphonic',
    'pontiac pools pop popular popularity population populations por porcelain porsche portable',
    'portal porter portfolio portion portions portland portrait portraits ports portsmouth portugal',
    'portuguese pos posing position positioning positions positive possess possession possibilities',
    'possibility possibly postage postal postcard postcards posted poster posters posting postings',
    'postposted posts pot potato potatoes potential potentially potter pottery poultry pound pounds',
    'poverty powder powell powered powerful powerpoint powers powerseller ppc ppm practical',
    'practice practices practitioner practitioners prague prairie praise prayer prayers pre',
    'preceding precious precipitation precisely predict predicted prediction predictions prefer',
    'preferences preferred prefers prefix pregnancy pregnant preliminary premier premiere premises',
    'premium prep prepaid preparation prepare prepared preparing prerequisite prescribed',
    'prescription presence present presentation presentations presented presenting presently',
    'presents preservation preserve president presidential pressed pressing pressure preston pretty',
    'prev preventing prevention preview previews previously priced prices pricing pride priest',
    'primarily primary prime prince princess princeton principal principle principles printable',
    'printed printer printers printing prior priorities priority prison prisoner prisoners privacy',
    'private privilege privileges prix prize prizes pro probability probe proc procedure procedures',
    'proceed proceeding proceedings proceeds processed processing processor processors procurement',
    'produced producer producers producing product production productions productive productivity',
    'products profession professionals profiles profit profits programme programmer programmers',
    'programmes programming progress progressive prohibited projected projection projector',
    'projectors prominent promise promised promises promising promo promote promoted promotes',
    'promoting promotion promotional promotions promptly proof propecia proper properly properties',
    'property prophet proportion proposal proposals propose proposed proposition proprietary pros',
    'prospect prospective prospects prostate prostores prot protected protecting protection',
    'protective protein proteins protest protocol protocols prototype proud proudly prove proved',
    'proven provided providence provider providers providing province provinces provincial',
    'provision provisions prozac psi psp pst psychiatry psychological psychology pts pty pub public',
    'publication publications publicity publicly publish published publisher publishers publishing',
    'pubmed pubs puerto pulled pulling pulse pump pumps punch punishment punk pupils puppy purchase',
    'purchased purchases purchasing purple purpose purposes purse pursuant pursue pursuit pushed',
    'pushing puzzle puzzles pvc qatar qld qty quad qualification qualifications qualified qualify',
    'qualifying qualities quality quantitative quantities quantity quantum quarter quarterly',
    'quarters que quebec queen queens queensland quest questionnaire qui quickly quiet quilt',
    'quizzes quotations quote quoted quotes rabbit races rachel racial racing racks radar radiation',
    'radical radios radius railroad railway rainbow raised raising raleigh rally ralph ranch rand',
    'random randy ranger rangers ranges ranging ranked ranking rankings ranks rap rapid rapidly',
    'rapids rated ratings rational ratios rats raw ray raymond rays rca reached reaching reaction',
    'reactions reader readers readily readings realistic reality realized realm realtor realtors',
    'realty rear reasonable reasonably reasoning rebate rebates rebecca rebel rebound rec receipt',
    'received receiver receivers receiving recent recently reception receptor receptors recipe',
    'recipes recipient recipients recognition recognize recognized recommend recommendation',
    'recommendations recommended recommends reconstruction recorded recorder recorders recording',
    'recordings recover recovered recovery recreation recreational recruiting recruitment recycling',
    'red redeem redhead reduced reducing reduction reductions reed reef reel ref refer referenced',
    'referral referrals referred referring refers refinance refine refined reflected reflection',
    'reflections reform reforms refresh refrigerator refugees refund refurbished refuse refused reg',
    'regard regarded regarding regardless regards reggae regime region regional regions register',
    'registered registrar registration registry regular regularly regulated regulation regulations',
    'regulatory rehab rehabilitation reid rejected related relating relation relations relationship',
    'relationships relative relatively relatives relax relaxation relay released relevance relevant',
    'reliability reliable reliance relief religion religions religious reload relocation relying',
    'remainder remained remaining remark remarkable remarks remedies remedy remembered remind',
    'reminder remix remote removable removal renaissance rendered rendering renew renewable renewal',
    'reno rental rentals rep repair repairs repeated replaced replacement replacing replica',
    'replication replied replies reported reporter reporters reporting repository represent',
    'representation representations representative representatives represented representing',
    'represents reprint reprints reproduce reproduced reproduction reproductive republic republican',
    'republicans reputation requested requesting required requirement requirements requiring res',
    'rescue research researcher researchers reseller reservation reservations reserve reserved',
    'reserves reservoir reset residence resident residential residents resist resistance resistant',
    'resolution resolutions resolve resolved resort resorts resource resources respected respective',
    'respectively respiratory responded respondent respondents responding responsibilities',
    'responsibility responsible restaurant restaurants restoration restore restored restricted',
    'restriction restrictions restructuring resulted resulting resume resumes retail retailer',
    'retailers retain retained retention retired retirement retreat retrieval retrieve retrieved',
    'retro reunion reuters rev reveal revealed reveals revelation revenge revenue revenues reverse',
    'reviewed reviewer reviewing revised revision revisions revolution revolutionary reward rewards',
    'reynolds rfc rhode rhythm ribbon rica richard richards richardson richmond rick ricky rico rid',
    'rider riders rides ridge riding rights rim rings ringtone ringtones rio rip ripe rising risks',
    'river rivers riverside rna roads rob robbie robert roberts robertson robin robinson robot',
    'robots robust rochester rocket rocks rocky roger rogers roland roles rolled roller rolling',
    'rolls roman romance romania romantic rome ron ronald roommate roommates rooms roots rosa roses',
    'ross roster rotary rotation rouge roughly roulette rounds route router routers routes routine',
    'routines routing rover rows roy royal royalty rpg rpm rrp rss rubber rugby rugs ruled rules',
    'ruling runner rural russell russia russian ruth rwanda ryan sacramento sacred sacrifice saddam',
    'safari safely safer safety sagem sailing saint saints salad salaries salary salem sales sally',
    'salmon salon salvador salvation sam samba samoa samples sampling samsung samuel san sandra',
    'sandwich sandy sans santa sanyo sao sap sapphire sara sarah sas saskatchewan sat satellite',
    'satin satisfaction satisfactory satisfied satisfy saturn sauce saudi savage savannah saved',
    'saver saving savings say saying says sbjct scale scales scanned scanner scanners scanning',
    'scared scary scenario scenarios scene scenes scenic scheduled scheduling scheme schemes',
    'scholar scholars scholarship scholarships schools sci sciences scientific scientist scientists',
    'scoop scope scored scores scoring scotia scotland scott scottish scout scratch screening',
    'screens screensaver screensavers screenshot screenshots screw scripting scsi scuba sculpture',
    'seafood sealed sean searched searching seas season seasonal seasons seating seats seattle sec',
    'secondary seconds secret secretariat secretary secrets sector sectors secure secured securely',
    'securities security seeds seeker seekers seeking seeks seemed sega segment segments selected',
    'selecting selection selections selective seller sellers selling semi semiconductor seminar',
    'seminars sen senate senator senators sender senegal senior seniors sensitive sensitivity',
    'sensor sensors seo sep separate separated separately separation sept seq sequence sequences',
    'ser serbia serial series serious seriously serum served service services serving settle',
    'settled settlement setup seventh severe sewing sexual sexuality sexually shade shades shadow',
    'shadows shaft shake shakespeare shakira shame shanghai shannon shape shaped shapes shared',
    'shareholders shares shareware sharing shark sharon sharp shaved shaw sheep sheer sheet sheets',
    'sheffield shelf shelter shepherd sheriff sherman shield shift shine shipment shipments shipped',
    'shipping ships shirt shirts shock shoes shoot shooting shopper shoppers shopping shops',
    'shopzilla shore shortcuts shorter shortly shorts shots shoulder showcase shower showers shown',
    'showtimes shuttle sic sie siemens sierra sig sight sigma signal signals signature signatures',
    'signed significance significant significantly signing signs silence silent silicon silly',
    'silver sim similarly simon simplified simpson simpsons sims simulation simulations',
    'simultaneously sin singapore singer singh singing singles sip sir sister sisters sitemap sites',
    'sitting situated situation situations sixth sized skating ski skiing skill skilled skills',
    'skins skirt skirts sku skype slave sleep sleeping sleeps sleeve slide slides slideshow slight',
    'slightly slim slope slots slovak slovakia slovenia slowly smaller smallest smart smell smile',
    'smilies smith smithsonian smoke smoking smooth sms smtp snake snapshot snowboard soa soc',
    'soccer social societies society sociology socks sodium sofa softball sol solar solaris soldier',
    'soldiers solely solo solomon solution solutions solved solving soma somalia somebody somehow',
    'somerset somewhat son songs sonic sons sony soonest sophisticated sorry sorted sought souls',
    'sounds soundtrack south southampton southeast southern southwest soviet sox spa space spaces',
    'spain spam spanish spank spanking sparc spare spas spatial speaker speakers speaking spears',
    'spec special specialist specialists specialized specializing specially specials specialties',
    'specialty species specifically specification specifications specifics specified specifies',
    'specify specs spectacular spectrum speech speeches speed speeds spell spencer spending spent',
    'sperm sphere spice spider spies spine spirit spirits spiritual spirituality split spoke spoken',
    'spokesman sponsor sponsored sponsors sponsorship sport sporting sports spotlight spots spouse',
    'spray spread spreading springer springfield springs sprint spy spyware squad square sri',
    'stability stable stadium staff staffing stage stages stainless stake stakeholders stamp stamps',
    'stan standard standards standing standings stanford stanley starring stars starsmerchant',
    'starter stated statewide static stating station stationery stations statistical statistics',
    'stats status statute statutes statutory stayed staying std ste steady steal steam steel',
    'steering stephanie stephen stereo sterling steve steven stevens stewart stick sticker stickers',
    'sticks sticky stock stockholm stockings stocks stolen stomach stone stones stood stopped',
    'stopping stored storm straight strain strand strange stranger strap strategic strategies',
    'strategy streaming streams street streets strength strengthen strengthening strengths stress',
    'stretch strict strictly strike strikes striking strip stripes strips stroke stronger strongly',
    'struck structural structured struggle stuart stud studied studio studios studying stuff',
    'stuffed stunning stupid stylish stylus sub subaru subcommittee subdivision subjective sublime',
    'sublimedirectory submission submissions submitted submitting subscribe subscriber subscribers',
    'subscription subscriptions subsection subsequent subsequently subsidiaries subsidiary',
    'substance substances substantial substantially substitute subtle suburban successful',
    'successfully sucking sudan sudden suddenly sue suffer suffered suffering sufficient',
    'sufficiently sugar suggested suggesting suicide suitable suite suited suites suits sullivan',
    'summaries summer summit sunglasses sunny sunrise sunset sunshine super superb superintendent',
    'superior supervision supervisor supervisors supplement supplemental supplements supplied',
    'supplier suppliers supported supporters supporting suppose supposed supreme sur surely surf',
    'surface surfaces surfing surge surgeon surgeons surgery surgical surname surplus surprise',
    'surprised surprising surrey surround surrounded surrounding surveillance surveys survival',
    'survive survivor survivors susan suse suspect suspected suspended suspension sussex',
    'sustainability sustainable sustained suzuki swap swaziland sweden swedish sweet swimming swing',
    'swingers swiss switched switches switching switzerland sword sydney symantec symbol symbols',
    'sympathy symphony symposium symptoms sync syndicate syndication syndrome synopsis syntax',
    'synthesis synthetic syracuse syria sys systematic tablets tabs tackle tactics tagged tags',
    'tahoe taiwan taken talent talented tales talked talking talks tamil tampa tan tanks tanzania',
    'tap tapes target targeted targets tariff taste tattoo tax taxation taxes taylor tba tea tears',
    'technical technician technique techniques techno technological technologies technology',
    'techrepublic ted teddy tee teenage teens teeth tel telecharger telecom telecommunications',
    'telephone telephony telescope television televisions temp temperature temperatures temple',
    'temporal temporarily temporary tenant tender tennessee tennis tension terminals termination',
    'terminology terms terrace terrain terrible territories territory terror terrorism terrorist',
    'terrorists terry testament testimonials testimony tex texas textbook textbooks textile',
    'textiles texture tft tgp thai thailand thank thanks thanksgiving thats theater theaters',
    'theatre thee theft thehun themes themselves theology theorem theoretical theories theory',
    'therapeutic therapist therapy thereafter thereby thereof thermal thesaurus thesis theta',
    'thickness thinkpad thirty thomas thompson thomson thong thongs thoroughly thou thoughts',
    'thousand thousands threaded threat threatened threatening threats threshold thriller throat',
    'throw throwing thrown throws thu thumb thumbnail thumbnails thumbs thumbzilla thunder thy',
    'ticket tickets tie tied ties tiffany tiger tigers tight til tiles tim timber timeline timely',
    'timer times timing timothy tion tions tip tips tires tissue titanium titans titled titten tmp',
    'tobacco tobago todd toddler toe toilet tokyo tolerance tom tomato tomatoes tommy ton toner',
    'tones tongue tonight tons tony toolbox toolkit tools tooth tops toronto torture toshiba',
    'totally totals touch touched tough touring tourism tourist tournament tournaments tours tower',
    'towers towns township toxic toy toyota toys trace track trackback trackbacks tracked tracker',
    'tracking tracks tract tractor tracy trade trademark trademarks trader trades trading tradition',
    'traditional traditions traffic tragedy trail trailer trailers trails trained trainer trainers',
    'tramadol trance trans transaction transactions transcript transcription transcripts transexual',
    'transexuales transfer transferred transfers transform transformation transit transition',
    'translate translated translation translations translator transmission transmit transmitted',
    'transparency transparent transport transportation transsexual trash trauma travel traveler',
    'travelers traveling traveller travelling travels travesti travis treasure treasurer treasures',
    'treasury treat treated treating treatment treatments treaty trek trembl tremendous trends treo',
    'tri trial trials triangle tribal tribe tribes tribunal tribune tribute trick tricks trigger',
    'trinidad trinity trio tripadvisor trips triumph trivia troops tropical trouble troubleshooting',
    'trout troy truck trucks truly trunk trust trusted trustee trustees trusts truth tsunami tub',
    'tubes tucson tue tuition tulsa tumor tuner tunes tuning tunisia tunnel turbo turkey turkish',
    'turned turner turning turtle tutorial tutorials tvs twelve twenty twice twiki twins twist',
    'twisted tyler typical typically typing uganda ugly ukraine ultimate ultimately ultra ultram',
    'una unable unauthorized unavailable uncertainty uncle und undergraduate underground underlying',
    'undertake undertaken underwear undo une unemployment unexpected unfortunately uni unified',
    'uniform unions uniprotkb unique united units unity univ universal universe universities',
    'university unix unknown unlike unlikely unlimited unlock unnecessary unsigned unsubscribe',
    'untitled unto unusual unwrap upc upcoming upgrade upgrades upgrading uploaded upper ups upset',
    'urban urgent urls uruguay urw usa usage usb usc usd usda usgs usps usr usual utah utc',
    'utilities utility utilization utilize utils uzbekistan vacancies vacation vacations vaccine',
    'vacuum valentine validation validity valium valley valuable valuation valued valve valves',
    'vampire van vancouver vanilla variance variation variations varied varies varieties variety',
    'varying vat vatican vault vbulletin vcr vegas vegetable vegetables vegetarian vegetation',
    'vehicle vehicles velocity velvet vendor vendors venezuela venice venture ventures venue venues',
    'ver verbal verde verification verified verify verizon vermont vernon verse versus vertex',
    'vertical verzeichnis vessel vessels veteran veterans veterinary vhs via vic vice victim',
    'victims victor victoria victorian victory vid videos vids vienna vietnam vietnamese viewed',
    'viewer viewers viewing viewpicture views vii viii viking villa village villages villas vincent',
    'vintage vinyl violation violations violence violent violin vip viral virgin virginia virtual',
    'virtually virtue virus viruses visa visibility visible vision visit visited visiting visitor',
    'visitors visits vista visual vital vitamin vitamins vocabulary vocal vocals vocational voice',
    'voices void voip vol volkswagen volleyball volt voltage volume volumes voluntary volunteer',
    'volunteers volvo von voted voters votes voting voyeurweb voyuer vpn vsnet vulnerability',
    'vulnerable wages wagner wagon waiting waiver wal wales walked walker walking wallace wallet',
    'wallpaper wallpapers walls walnut walt walter wanted warcraft ware warehouse warming warned',
    'warner warning warnings warrant warranties warranty warren warrior warriors wars washer',
    'washing washington waste watched watching waterproof waters watershed watson watt watts wav',
    'waves wax wayne wealth weapon weapons wearing weather webcam webcams webcast weblog weblogs',
    'webmaster webmasters webshots webster wed wedding weddings weed weekend weekends weekly weight',
    'weighted weights weird welcome welding welfare wellington wellness wells welsh wendy wesley',
    'western westminster whale whatever whats wheat wheel wheels whenever whereas wherever whilst',
    'white wholesale wichita wicked widely wider widescreen widespread wiki wikipedia wilderness',
    'wildlife wiley william williams willing willow wilson window winds windsor wines wings winner',
    'winners winning winston winter wired wireless wires wiring wisconsin wisdom wishes wishing',
    'wishlist wit witch withdrawal witness witnesses wives wizard wma women womens won wonderful',
    'wondering wooden woods worcester wordpress worker workers workforce workout workplace workshop',
    'workshops workstation worldcat worlds worldwide worry worship worth worthy wound wow wrapped',
    'wrapping wrestling wright wrist writer writers writings wto www wyoming xanax xbox xerox xhtml',
    'yacht yahoo yale yamaha yang yards yea yeah yearly years yeast yellow yemen yen yields yoga',
    'york yorkshire young younger yourself youth yrs yugoslavia yukon zambia zdnet zealand zen',
    'zimbabwe zinc zoloft zones zoning zoo zoom zope zshops zum zus'
,

    // Short technical abbreviations people actually type. They are too short and too
    // rare in a general frequency list to arrive with it, and every one of them sits
    // one edit from a common word -- "stat" from "start", "req" from "red".
    'calc cfg ctx cwd dirs envs func funcs idx imgs impl param params pkg pkgs prod req stat stats util vals'
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

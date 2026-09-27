import { log } from 'apify';
import { XMLParser } from 'fast-xml-parser';

// Official Congress.gov bill status data, republished by the Government Publishing
// Office as public-domain bulk XML on GovInfo. No API key, no account, and
// govinfo.gov's robots.txt allows /bulkdata. One XML file per bill.
const BULK_BASE = 'https://www.govinfo.gov/bulkdata/BILLSTATUS';
const SITEMAP_BASE = 'https://www.govinfo.gov/sitemap/bulkdata/BILLSTATUS';
const LISTING_BASE = 'https://www.govinfo.gov/bulkdata/json/BILLSTATUS';

const USER_AGENT = 'policy-funding-radar (Apify actor; https://github.com/timmKal01/policy-funding-radar)';
const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;
const REQUEST_TIMEOUT_MS = 30_000;
const CONCURRENCY = 10;
// Bill numbers are assigned in introduction order, so walking each bill type from
// its highest number down, a few consecutive bills older than the window means
// the rest are older too.
const OLD_STREAK_LIMIT = 3;

const BILL_TYPES = ['hr', 's', 'hres', 'sres', 'hjres', 'sjres', 'hconres', 'sconres'];
const DISPLAY_PREFIX = {
    hr: 'H.R.', s: 'S.', hres: 'H.Res.', sres: 'S.Res.',
    hjres: 'H.J.Res.', sjres: 'S.J.Res.', hconres: 'H.Con.Res.', sconres: 'S.Con.Res.',
};
const CONGRESS_GOV_TYPE = {
    hr: 'house-bill', s: 'senate-bill', hres: 'house-resolution', sres: 'senate-resolution',
    hjres: 'house-joint-resolution', sjres: 'senate-joint-resolution',
    hconres: 'house-concurrent-resolution', sconres: 'senate-concurrent-resolution',
};

// GovTrack's status vocabulary and labels (github.com/govtrack/govtrack.us-web, bill/status.py),
// kept so existing currentStatus filters and status values carry over unchanged.
export const STATUS_LABELS = {
    introduced: 'Introduced',
    reported: 'Ordered Reported',
    pass_over_house: 'Passed House (Senate next)',
    pass_over_senate: 'Passed Senate (House next)',
    passed_simpleres: 'Agreed To (Simple Resolution)',
    passed_constamend: 'Agreed To (Constitutional Amendment Proposal)',
    passed_concurrentres: 'Agreed To (Concurrent Resolution)',
    passed_bill: 'Passed House & Senate (President next)',
    pass_back_house: 'Passed House with Changes (back to Senate)',
    pass_back_senate: 'Passed Senate with Changes (back to House)',
    conference_passed_house: 'Conference Report Agreed to by House (Senate next)',
    conference_passed_senate: 'Conference Report Agreed to by Senate (House next)',
    prov_kill_suspensionfailed: 'Failed Under Suspension',
    prov_kill_cloturefailed: 'Failed Cloture',
    prov_kill_pingpongfail: 'Failed to Resolve Differences',
    prov_kill_veto: 'Vetoed (No Override Attempt)',
    fail_originating_house: 'Failed House',
    fail_originating_senate: 'Failed Senate',
    fail_second_house: 'Passed Senate, Failed House',
    fail_second_senate: 'Passed House, Failed Senate',
    override_pass_over_house: 'Vetoed & House Overrides (Senate Next)',
    override_pass_over_senate: 'Vetoed & Senate Overrides (House Next)',
    vetoed_pocket: 'Pocket Vetoed',
    vetoed_override_fail_originating_house: 'Vetoed & Override Failed in House',
    vetoed_override_fail_originating_senate: 'Vetoed & Override Failed in Senate',
    vetoed_override_fail_second_house: 'Vetoed & Override Passed Senate, Failed in House',
    vetoed_override_fail_second_senate: 'Vetoed & Override Passed House, Failed in Senate',
    enacted_signed: 'Enacted \u2014 Signed by the President',
    enacted_veto_override: 'Enacted \u2014 Veto Overridden',
    enacted_tendayrule: 'Enacted \u2014 By 10 Day Rule',
    enacted_unknown: 'Enacted (Unknown Final Step)',
    enacted_incorporation: 'Enacted \u2014 incorporated into another bill',
};

// A bill in one of these can take no further action (GovTrack's BillStatus.final_status).
const FINAL_STATUSES = new Set([
    'enacted_signed', 'enacted_veto_override', 'enacted_tendayrule', 'enacted_unknown',
    'passed_simpleres', 'passed_constamend', 'passed_concurrentres',
    'fail_originating_house', 'fail_originating_senate', 'fail_second_house', 'fail_second_senate',
    'vetoed_pocket', 'vetoed_override_fail_originating_house', 'vetoed_override_fail_originating_senate',
    'vetoed_override_fail_second_house', 'vetoed_override_fail_second_senate',
]);

const NEXT_CHAMBER = {
    pass_over_house: 'senate', pass_back_house: 'senate', conference_passed_house: 'senate', override_pass_over_house: 'senate',
    pass_over_senate: 'house', pass_back_senate: 'house', conference_passed_senate: 'house', override_pass_over_senate: 'house',
};

const XML_STATUS_TO_KEY = {
    INTRODUCED: 'introduced',
    REFERRED: 'introduced',
    REPORTED: 'reported',
    'PASS_OVER:HOUSE': 'pass_over_house',
    'PASS_OVER:SENATE': 'pass_over_senate',
    'PASSED:SIMPLERES': 'passed_simpleres',
    'PASSED:CONSTAMEND': 'passed_constamend',
    'PASSED:CONCURRENTRES': 'passed_concurrentres',
    'PASSED:BILL': 'passed_bill',
    'PASS_BACK:HOUSE': 'pass_back_house',
    'PASS_BACK:SENATE': 'pass_back_senate',
    'CONFERENCE:PASSED:HOUSE': 'conference_passed_house',
    'CONFERENCE:PASSED:SENATE': 'conference_passed_senate',
    'PROV_KILL:SUSPENSIONFAILED': 'prov_kill_suspensionfailed',
    'PROV_KILL:CLOTUREFAILED': 'prov_kill_cloturefailed',
    'PROV_KILL:PINGPONGFAIL': 'prov_kill_pingpongfail',
    'PROV_KILL:VETO': 'prov_kill_veto',
    'FAIL:ORIGINATING:HOUSE': 'fail_originating_house',
    'FAIL:ORIGINATING:SENATE': 'fail_originating_senate',
    'FAIL:SECOND:HOUSE': 'fail_second_house',
    'FAIL:SECOND:SENATE': 'fail_second_senate',
    'VETOED:OVERRIDE_PASS_OVER:HOUSE': 'override_pass_over_house',
    'VETOED:OVERRIDE_PASS_OVER:SENATE': 'override_pass_over_senate',
    'VETOED:POCKET': 'vetoed_pocket',
    'VETOED:OVERRIDE_FAIL_ORIGINATING:HOUSE': 'vetoed_override_fail_originating_house',
    'VETOED:OVERRIDE_FAIL_ORIGINATING:SENATE': 'vetoed_override_fail_originating_senate',
    'VETOED:OVERRIDE_FAIL_SECOND:HOUSE': 'vetoed_override_fail_second_house',
    'VETOED:OVERRIDE_FAIL_SECOND:SENATE': 'vetoed_override_fail_second_senate',
    'ENACTED:SIGNED': 'enacted_signed',
    'ENACTED:VETO_OVERRIDE': 'enacted_veto_override',
    'ENACTED:TENDAYRULE': 'enacted_tendayrule',
    'ENACTED:UNKNOWN': 'enacted_unknown',
};

const xmlParser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: true,
    isArray: (name) => name === 'item',
});

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Returns the Response, or null for a 404 when allowNotFound is set. */
async function fetchWithRetry(url, { allowNotFound = false, headers = {} } = {}) {
    let lastError;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        let res;
        try {
            res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, ...headers }, signal: controller.signal });
        } catch (err) {
            lastError = err.name === 'AbortError' ? new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms: ${url}`) : err;
            if (attempt < MAX_ATTEMPTS) {
                await sleep(1000 * 2 ** (attempt - 1));
                continue;
            }
            throw lastError;
        } finally {
            clearTimeout(timeoutId);
        }
        if (res.ok) return res;
        if (res.status === 404 && allowNotFound) return null;
        if (!TRANSIENT_STATUSES.has(res.status)) {
            const body = await res.text();
            throw new Error(`GovInfo request failed: ${res.status} ${res.statusText}: ${url} ${body.slice(0, 200)}`);
        }
        lastError = new Error(`GovInfo request failed: ${res.status} ${res.statusText}: ${url}`);
        if (attempt < MAX_ATTEMPTS) await sleep(1000 * 2 ** (attempt - 1));
    }
    throw lastError;
}

async function mapWithConcurrency(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    async function worker() {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i]);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

export function currentCongress(date = new Date()) {
    const year = date.getUTCFullYear();
    let congress = Math.floor((year - 1789) / 2) + 1;
    // A new Congress convenes on January 3 of odd years.
    if (year % 2 === 1 && date.getUTCMonth() === 0 && date.getUTCDate() < 3) congress -= 1;
    return congress;
}

function congressStartDate(congress) {
    return `${1789 + 2 * (congress - 1)}-01-03`;
}

function ordinal(n) {
    const tens = n % 100;
    if (tens >= 11 && tens <= 13) return `${n}th`;
    return `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th'}`;
}

// ---------------------------------------------------------------------------
// Status: a JS port of the action-text rules GovTrack itself uses, from the
// unitedstates/congress project (congress/tasks/bill_info.py: actions_for,
// action_for, parse_bill_action, new_status_after_vote).
// ---------------------------------------------------------------------------

function cleanActionText(text) {
    let line = String(text ?? '').replace(/<\/?[Aa]( \S.*?)?>/g, '');
    // Drop the trailing "(CR H1234-1235; text: CR S567)" style references.
    const refs = line.match(/\s*\(([^)]+)\)\s*$/);
    if (refs) line = line.slice(0, refs.index) + line.slice(refs.index + refs[0].length);
    return line;
}

// Library of Congress (source code 9) lines often repeat the House/Senate floor
// action just before them; drop those so a vote isn't counted twice.
function dedupeActions(items) {
    const kept = [];
    let prev = null;
    for (const item of items) {
        if (!item.text) continue;
        let keep = true;
        if (prev && String(item.sourceSystem?.code) === '9') {
            if (item.actionDate === prev.actionDate
                && (item.actionTime === prev.actionTime || !item.actionTime || !prev.actionTime)
                && cleanActionText(item.text).replaceAll(' ', '').endsWith(cleanActionText(prev.text).replaceAll(' ', ''))) {
                keep = false;
            }
        }
        prev = item;
        if (keep) kept.push(item);
    }
    return kept;
}

function statusAfterVote(voteType, passed, chamber, billType, suspension, amended, title, prevStatus) {
    const isConstAmend = ['hjres', 'sjres'].includes(billType)
        && title.startsWith('Proposing an amendment to the Constitution of the United States');
    if (voteType === 'vote') {
        if (passed) {
            if (billType === 'hres' || billType === 'sres') return 'PASSED:SIMPLERES';
            return chamber === 'h' ? 'PASS_OVER:HOUSE' : 'PASS_OVER:SENATE';
        }
        if (suspension) return 'PROV_KILL:SUSPENSIONFAILED';
        return chamber === 'h' ? 'FAIL:ORIGINATING:HOUSE' : 'FAIL:ORIGINATING:SENATE';
    }
    if (voteType === 'vote2' || voteType === 'pingpong') {
        if (passed) {
            if (amended) return chamber === 'h' ? 'PASS_BACK:HOUSE' : 'PASS_BACK:SENATE';
            if (isConstAmend) return 'PASSED:CONSTAMEND';
            if (billType === 'hconres' || billType === 'sconres') return 'PASSED:CONCURRENTRES';
            return 'PASSED:BILL';
        }
        if (voteType === 'pingpong') return 'PROV_KILL:PINGPONGFAIL';
        if (suspension) return 'PROV_KILL:SUSPENSIONFAILED';
        return chamber === 'h' ? 'FAIL:SECOND:HOUSE' : 'FAIL:SECOND:SENATE';
    }
    if (voteType === 'cloture') {
        return passed ? null : 'PROV_KILL:CLOTUREFAILED';
    }
    if (voteType === 'override') {
        const originating = billType[0] === chamber;
        const where = chamber === 'h' ? 'HOUSE' : 'SENATE';
        if (!passed) return `VETOED:OVERRIDE_FAIL_${originating ? 'ORIGINATING' : 'SECOND'}:${where}`;
        return originating ? `VETOED:OVERRIDE_PASS_OVER:${where}` : 'ENACTED:VETO_OVERRIDE';
    }
    if (voteType === 'conference' && passed) {
        if (prevStatus.startsWith('CONFERENCE:PASSED:')) {
            if (isConstAmend) return 'PASSED:CONSTAMEND';
            if (billType === 'hconres' || billType === 'sconres') return 'PASSED:CONCURRENTRES';
            return 'PASSED:BILL';
        }
        return chamber === 'h' ? 'CONFERENCE:PASSED:HOUSE' : 'CONFERENCE:PASSED:SENATE';
    }
    return null;
}

const HOUSE_VOTE_RE = new RegExp('('
    + [
        'On passage',
        'Passed House',
        'Two-thirds of the Members present having voted in the affirmative the bill is passed,?',
        'On motion to suspend the rules and pass the (?:bill|resolution)',
        'On agreeing to the (?:resolution|conference report)',
        'On motion to suspend the rules and agree to the (?:resolution|conference report)',
        'House Agreed to Senate Amendments.*?',
        'On motion (?:that )?the House (?:suspend the rules and )?(?:agree(?: with an amendment)? to|concur in) the Senate amendments?(?: to the House amendments?| to the Senate amendments?)*',
    ].join('|')
    + ')'
    + '(, the objections of the President to the contrary notwithstanding.?)?'
    + String.raw`(, as amended| \(Amended\))?`
    + String.raw`\.? (Passed|Failed|Agreed to|Rejected)?`
    + ' ?(by voice vote|without objection|by (the Yeas and Nays?|Yea-Nay Vote|recorded vote)'
    + String.raw`(:? \(2/3 required\))?: (\d+ ?- ?\d+(, \d+ Present)? [ \)]*)?\((Roll no\.|Record Vote No:) \d+\))`, 'i');

const HOUSE_DEEMED_RE = /Passed House pursuant to|House agreed to Senate amendment (with amendment )?pursuant to|Pursuant to the provisions of [HSCONJRES. ]+ \d+, [HSCONJRES. ]+ \d+ is considered passed House/i;

const HOUSE_TABLED_RE = new RegExp('On motion to table the measure Agreed to'
    + ' ?(by voice vote|without objection|by (the Yeas and Nays|Yea-Nay Vote|recorded vote)'
    + String.raw`: (\d+ - \d+(, \d+ Present)? [ \)]*)?\((Roll no\.|Record Vote No:) \d+\))`, 'i');

const SENATE_VOTE_RE = new RegExp('('
    + [
        'Passed Senate',
        'Failed of passage in Senate',
        'Disagreed to in Senate',
        'Resolution agreed to in Senate',
        'Senate (?:agreed to|concurred in) (?:the )?(?:conference report|House amendment(?: to the Senate amendments?| to the House amendments?)*)',
        'Senate receded from its amendment and concurred',
        String.raw`Cloture \S*\s?on the motion to proceed .*?not invoked in Senate`,
        'Cloture(?: motion)? on the motion to proceed to the (?:bill|measure) invoked in Senate',
        'Cloture invoked in Senate',
        'Cloture on (?:the motion to (?:proceed to |concur in )(?:the House amendment (?:to the Senate amendment )?to )?)(?:the bill|H.R. .*) (?:not )?invoked in Senate',
        '(?:Introduced|Received|Submitted) in the Senate, (?:read twice, |considered, |read the third time, )+and (?:passed|agreed to)',
    ].join('|')
    + ')'
    + '(,?.*,?) '
    + String.raw`(without objection|by Unanimous Consent|by Voice Vote|(?:by )?Yea-Nay( Vote)?\. \d+\s*-\s*\d+\. Record Vote (No|Number): \d+)`, 'i');

const OLD_STYLE_PASSED_RE = /Measure passed (House|Senate)(, amended(?: \(.*?\)|, with an amendment to the title)?)?(?:,? in lieu[^,]*)?(?:, roll call #(\d+) \(\d+-\d+\))?/i;
const OLD_STYLE_AMENDMENT_RE = /(House|Senate) agreed to (?:House|Senate) amendments?( with an amendment)?( under Suspension of the Rules)?(?:, roll call #(\d+) \(\d+-\d+\))?\./i;

/** Returns the new XML-style status code set by one action line, or null. */
function parseActionStatus(rawLine, prevStatus, { type, number, title }) {
    if (/^(H|S)\.Amdt\.(\d+)/i.test(rawLine)) return null;

    const line = rawLine.replaceAll(', the Passed', ', Passed');
    let status = null;
    const setStatus = (value) => { if (value) status = value; };

    let m = line.match(HOUSE_VOTE_RE);
    if (m) {
        const [, motion, isOverrideText, asAmendedText, passFail, how] = m;
        const passed = /Passed House|House Agreed to/i.test(motion)
            || /(ayes|yeas) had prevailed/i.test(line)
            || (passFail !== undefined && /Pass|Agreed/i.test(passFail));
        const isOverride = Boolean(isOverrideText) || motion.includes('Two-thirds of the Members present');
        let voteType;
        if (isOverride) voteType = 'override';
        else if (/(agree (with an amendment )?to|concur in) the Senate amendment/i.test(line)) voteType = 'pingpong';
        else if (/conference report/i.test(line)) voteType = 'conference';
        else voteType = type[0] === 'h' ? 'vote' : 'vote2';
        const isRoll = /\((Roll no\.|Record Vote No:) (\d+)\)/i.test(how);
        const suspension = isRoll && motion.includes('On motion to suspend the rules');
        const asAmended = Boolean(asAmendedText) || motion.includes('the House agree with an amendment');
        setStatus(statusAfterVote(voteType, passed, 'h', type, suspension, asAmended, title, prevStatus));
    }

    // Passed House without its own vote, e.g. "deemed" passed by a rule.
    if (HOUSE_DEEMED_RE.test(line)) {
        let voteType = type[0] === 'h' ? 'vote' : 'vote2';
        if (line.includes('agreed to Senate amendment')) voteType = 'pingpong';
        const asAmended = line.includes('with amendment') || line.includes('as amended');
        setStatus(statusAfterVote(voteType, true, 'h', type, false, asAmended, title, prevStatus));
    }

    m = line.match(/Pursuant to .* the following bills passed under suspension of the rules: (.*)\.$/i);
    if (m) {
        let asAmended = null;
        const billList = m[1]
            .replaceAll('and the following resolution was agreed to under suspension of the rules: ', '')
            .replaceAll('and the following resolutions were agreed to under suspension of the rules: ', '')
            .replaceAll('and ', '');
        for (const billItem of billList.split(/\s*(?:;|,(?! as amended))\s*/)) {
            const parts = billItem.toLowerCase().replaceAll('.', '').replaceAll(' ', '').split(',');
            if (parts[0] === `${type}${number}`) asAmended = parts.length > 1;
        }
        if (asAmended !== null) {
            const voteType = type[0] === 'h' ? 'vote' : 'vote2';
            setStatus(statusAfterVote(voteType, true, 'h', type, false, asAmended, title, prevStatus));
        }
    }

    // An agreed-to motion to table the measure kills it in its originating chamber.
    if (HOUSE_TABLED_RE.test(line) && (['INTRODUCED', 'REFERRED', 'REPORTED'].includes(prevStatus) || type === 'hres')) {
        setStatus(statusAfterVote('vote', false, 'h', type, false, false, title, prevStatus));
    }

    m = line.replaceAll('  ', ' ').match(SENATE_VOTE_RE);
    if (m) {
        const [, motion, extra] = m;
        let passed;
        if (/disagreed|not invoked/i.test(motion)) passed = false;
        else passed = /passed|agreed|concurred|invoked/i.test(motion);
        let voteType;
        if (/over veto/i.test(extra)) voteType = 'override';
        else if (/conference report/i.test(motion)) voteType = 'conference';
        else if (/cloture/i.test(motion)) voteType = 'cloture';
        else if (/Senate agreed to (the )?House amendment|Senate concurred in (the )?House amendment/i.test(motion)) voteType = 'pingpong';
        else voteType = type[0] === 's' ? 'vote' : 'vote2';
        const asAmended = /with amendments|with an amendment/i.test(extra);
        setStatus(statusAfterVote(voteType, passed, 's', type, false, asAmended, title, prevStatus));
    }

    m = line.match(OLD_STYLE_PASSED_RE);
    if (m) {
        const chamber = m[1][0].toLowerCase();
        const voteType = type[0] === chamber ? 'vote' : 'vote2';
        setStatus(statusAfterVote(voteType, true, chamber, type, false, Boolean(m[2]), title, prevStatus));
    }

    m = line.match(OLD_STYLE_AMENDMENT_RE);
    if (m) {
        const chamber = m[1][0].toLowerCase();
        setStatus(statusAfterVote('pingpong', true, chamber, type, false, Boolean(m[2]), title, prevStatus));
    }

    const notYetReported = prevStatus === 'INTRODUCED' || prevStatus === 'REFERRED';
    if (/Ordered to be Reported|Committee Agreed to Seek Consideration Under Suspension of the Rules/i.test(line) && notYetReported) status = 'REPORTED';
    if (/Committee on (.*)\. (Original measure )?[Rr]eported (to Senate )?by/i.test(line) && notYetReported) status = 'REPORTED';
    if (/Reported to Senate from the (.*?)( \(without written report\))?\./i.test(line) && notYetReported) status = 'REPORTED';
    if (/Committee on (.*)\. Discharged (by Unanimous Consent)?/i.test(line) && notYetReported) status = 'REPORTED';

    if (/Signed by President/i.test(line)) status = 'ENACTED:SIGNED';
    if (/Pocket Vetoed by President/i.test(line)) status = 'VETOED:POCKET';
    else if (/Vetoed by President/i.test(line)) status = 'PROV_KILL:VETO';
    if (/Sent to Archivist of the United States unsigned/i.test(line)) status = 'ENACTED:TENDAYRULE';

    if (/^(?:Became )?(Public|Private) Law(?: No:)? ([\d-]+)\./i.test(line)) {
        if (['ENACTED:SIGNED', 'ENACTED:VETO_OVERRIDE', 'ENACTED:TENDAYRULE'].includes(prevStatus)) {
            // final administrative step, status already set
        } else if (prevStatus === 'PROV_KILL:VETO' || prevStatus.startsWith('VETOED:')) {
            status = 'ENACTED:VETO_OVERRIDE';
        } else {
            status = 'ENACTED:UNKNOWN';
        }
    }

    if (/Referred to (?:the )?(House|Senate)?\s?(?:Committee|Subcommittee)?/i.test(line) && prevStatus === 'INTRODUCED') {
        status = 'REFERRED';
    }

    return status;
}

function deriveStatus(actionItems, ctx) {
    // Actions come newest first; replay them oldest first.
    const actions = dedupeActions(actionItems).reverse();
    let status = 'INTRODUCED';
    let statusDate = ctx.introducedDate;
    for (const action of actions) {
        const newStatus = parseActionStatus(cleanActionText(action.text), status, ctx);
        if (newStatus) {
            status = newStatus;
            statusDate = action.actionDate || statusDate;
        }
    }
    return { status: XML_STATUS_TO_KEY[status] ?? 'introduced', statusDate };
}

// ---------------------------------------------------------------------------
// Fetching and parsing
// ---------------------------------------------------------------------------

function formatSponsorName(sponsor, type) {
    const fullName = String(sponsor.fullName ?? '');
    const lastNameAt = sponsor.lastName ? fullName.indexOf(sponsor.lastName) : -1;
    const prefix = lastNameAt > 0 ? fullName.slice(0, lastNameAt).trim() : fullName.split(' ')[0];
    const name = [sponsor.firstName, sponsor.middleName, sponsor.lastName].filter(Boolean).join(' ');
    const district = type.startsWith('h') && sponsor.district !== undefined && sponsor.district !== '' ? sponsor.district : '';
    return `${prefix} ${name} [${sponsor.party}-${sponsor.state}${district}]`;
}

function toBillRecord(bill, congress, type, number) {
    const titleItems = bill.titles?.item ?? [];
    const officialTitle = titleItems.find((t) => /^Official Title/i.test(t.titleType ?? ''))?.title ?? bill.title ?? '';
    const introducedDate = bill.introducedDate || null;
    const { status, statusDate } = deriveStatus(bill.actions?.item ?? [], {
        type, number: String(number), title: String(officialTitle), introducedDate,
    });
    const originChamber = String(bill.originChamber || (type[0] === 'h' ? 'House' : 'Senate')).toLowerCase();
    const sponsor = bill.sponsors?.item?.[0];

    return {
        statusCode: status,
        searchText: [bill.title, ...titleItems.map((t) => t.title)].filter(Boolean).join('\n'),
        typeIndex: BILL_TYPES.indexOf(type),
        number,
        record: {
            billNumber: `${DISPLAY_PREFIX[type]} ${number}`,
            title: bill.title || officialTitle || null,
            congress,
            chamber: status === 'introduced' || status === 'reported' ? originChamber : (NEXT_CHAMBER[status] ?? null),
            status: STATUS_LABELS[status],
            statusDate,
            introducedDate,
            isAlive: congress === currentCongress() && !FINAL_STATUSES.has(status),
            sponsorName: sponsor ? formatSponsorName(sponsor, type) : null,
            sponsorState: sponsor?.state || null,
            link: bill.legislationUrl || `https://www.congress.gov/bill/${ordinal(congress)}-congress/${CONGRESS_GOV_TYPE[type]}/${number}`,
        },
    };
}

const listingCache = new Map();
const billCache = new Map();
const fetchStats = { attempted: 0, failed: 0 };

/** Bill numbers published for one Congress and bill type, highest first. */
function listBillNumbers(congress, type) {
    const key = `${congress}${type}`;
    if (!listingCache.has(key)) {
        listingCache.set(key, (async () => {
            let names;
            try {
                const res = await fetchWithRetry(`${SITEMAP_BASE}/${congress}${type}/sitemap.xml`, { allowNotFound: true });
                if (!res) return [];
                names = await res.text();
            } catch (err) {
                // The sitemap is the fast path; the JSON directory listing is the same data, slower.
                log.warning(`GovInfo sitemap failed for ${key}, using the directory listing: ${err.message}`);
                const res = await fetchWithRetry(`${LISTING_BASE}/${congress}/${type}`, {
                    allowNotFound: true,
                    headers: { Accept: 'application/json' },
                });
                if (!res) return [];
                names = ((await res.json()).files ?? []).map((f) => f.name).join('\n');
            }
            const numbers = new Set();
            for (const m of names.matchAll(new RegExp(`BILLSTATUS-${congress}${type}(\\d+)\\.xml`, 'g'))) {
                numbers.add(Number(m[1]));
            }
            return [...numbers].sort((a, b) => b - a);
        })());
    }
    return listingCache.get(key);
}

/**
 * Fetches one bill's XML but defers the (comparatively slow) full parse: most
 * bills are ruled out by date or keyword from the raw text alone.
 */
function getBillEntry(congress, type, number) {
    const key = `${congress}${type}${number}`;
    if (!billCache.has(key)) {
        billCache.set(key, (async () => {
            fetchStats.attempted++;
            try {
                const res = await fetchWithRetry(`${BULK_BASE}/${congress}/${type}/BILLSTATUS-${congress}${type}${number}.xml`, { allowNotFound: true });
                if (!res) return null;
                const xml = await res.text();
                // The bill's own introducedDate is the first one in the file, ahead of any nested sections.
                const introducedDate = xml.match(/<introducedDate>([^<]+)<\/introducedDate>/)?.[1] ?? null;
                return { congress, type, number, introducedDate, xml, bill: undefined };
            } catch (err) {
                fetchStats.failed++;
                log.warning(`Skipping ${DISPLAY_PREFIX[type]} ${number} (${ordinal(congress)} Congress): ${err.message}`);
                return null;
            }
        })());
    }
    return billCache.get(key);
}

function parseBillEntry(entry) {
    if (entry.bill === undefined) {
        try {
            const bill = xmlParser.parse(entry.xml)?.billStatus?.bill;
            entry.bill = bill ? toBillRecord(bill, entry.congress, entry.type, entry.number) : null;
        } catch (err) {
            log.warning(`Skipping ${DISPLAY_PREFIX[entry.type]} ${entry.number}: unreadable XML (${err.message})`);
            entry.bill = null;
        }
        entry.xml = null;
    }
    return entry.bill;
}

function newestFirst(a, b) {
    if (a.record.introducedDate !== b.record.introducedDate) return a.record.introducedDate < b.record.introducedDate ? 1 : -1;
    if (a.record.congress !== b.record.congress) return b.record.congress - a.record.congress;
    if (a.typeIndex !== b.typeIndex) return a.typeIndex - b.typeIndex;
    return b.number - a.number;
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Singular and plural spellings of a word, so "centers" also finds "center". */
function wordForms(word) {
    const bases = new Set([word]);
    if (/[^aeiou]ies$/.test(word) && word.length > 4) bases.add(`${word.slice(0, -3)}y`);
    else if (/(s|x|z|ch|sh)es$/.test(word) && word.length > 4) bases.add(word.slice(0, -2));
    else if (/[^siu]s$/.test(word) && word.length > 4) bases.add(word.slice(0, -1));
    const forms = new Set();
    for (const base of bases) {
        forms.add(base).add(`${base}s`).add(`${base}es`);
        if (/[^aeiou]y$/.test(base)) forms.add(`${base.slice(0, -1)}ies`);
    }
    return [...forms];
}

function commonPrefix(words) {
    return words.reduce((prefix, word) => {
        let i = 0;
        while (i < prefix.length && prefix[i] === word[i]) i++;
        return prefix.slice(0, i);
    });
}

/**
 * Every word must appear in the bill's titles (whole words; singular and plural
 * both match). "Quoted phrases" match as a phrase; an uppercase OR separates
 * alternatives, e.g. `artificial intelligence OR AI`.
 */
function buildKeywordMatcher(keyword) {
    const alternatives = String(keyword ?? '').split(/\s+OR\s+/).map((alternative) => [...alternative.matchAll(/"([^"]+)"|(\S+)/g)]
        .map((m) => (m[1] ?? m[2]).trim().toLowerCase())
        .filter(Boolean)).filter((terms) => terms.length > 0);
    if (alternatives.length === 0) return null;

    // The last word of each term (or phrase) may be singular or plural.
    const parsed = alternatives.map((terms) => terms.map((term) => {
        const words = term.split(/\s+/);
        const last = words.pop();
        const forms = /\w$/.test(last) ? wordForms(last) : [last];
        return { words, forms };
    }));
    const patterns = parsed.map((terms) => terms.map(({ words, forms }) => {
        const lastWord = `(?:${forms.map(escapeRegExp).join('|')})`;
        const body = [...words.map(escapeRegExp), lastWord].join('\\s+');
        const first = words[0] ?? forms[0];
        const start = /^\w/.test(first) ? '\\b' : '';
        const end = /\w$/.test(forms[0]) ? '\\b' : '';
        return new RegExp(`${start}${body}${end}`, 'i');
    }));
    // Cheap superset check on the raw XML: a title match needs every word of the
    // keyword (the shared stem, for the singular/plural word) somewhere in the file.
    const tokens = parsed.map((terms) => terms.flatMap(({ words, forms }) => [...words, commonPrefix(forms)]
        .flatMap((word) => word.match(/\w+/g) ?? [])));

    return {
        matches: (titles) => patterns.some((alt) => alt.every((re) => re.test(titles))),
        mightMatch: (rawXml) => {
            const lower = rawXml.toLowerCase();
            return tokens.some((alt) => alt.every((token) => lower.includes(token)));
        },
    };
}

/**
 * Bills introduced in the last `daysBack` days, newest first, optionally filtered
 * by title keyword, GovTrack-style status code, and Congress number.
 */
export async function fetchBills({ keyword, currentStatus, congress, daysBack, maxResults }) {
    if (currentStatus && !STATUS_LABELS[currentStatus]) {
        throw new Error(`Unknown currentStatus "${currentStatus}". Valid values: ${Object.keys(STATUS_LABELS).join(', ')}`);
    }

    const now = new Date();
    const cutoff = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const latestCongress = currentCongress(now);

    let congresses;
    if (congress) {
        const congressEnd = congressStartDate(congress + 1);
        if (congressEnd < cutoff) {
            log.warning(`The ${ordinal(congress)} Congress ended ${congressEnd}, before this ${daysBack}-day window starts (${cutoff}). Raise daysBack or clear the Congress filter.`);
            return [];
        }
        if (congress > latestCongress) {
            log.warning(`The ${ordinal(congress)} Congress has not started yet (current: ${ordinal(latestCongress)}).`);
            return [];
        }
        congresses = [congress];
    } else {
        congresses = [latestCongress];
        // Early in a new Congress, the window can reach back into the previous one.
        if (congressStartDate(latestCongress) > cutoff) congresses.push(latestCongress - 1);
    }

    const keywordMatcher = buildKeywordMatcher(keyword);
    const cursors = [];
    for (const c of congresses) {
        for (const type of BILL_TYPES) {
            cursors.push({ congress: c, type, numbers: [], pos: 0, frontier: '9999-12-31', oldStreak: 0, done: false });
        }
    }
    await Promise.all(cursors.map(async (cursor) => {
        cursor.numbers = await listBillNumbers(cursor.congress, cursor.type);
        if (cursor.numbers.length === 0) cursor.done = true;
    }));

    const found = [];
    const attemptedBefore = fetchStats.attempted;
    const failedBefore = fetchStats.failed;
    let batchSize = 10;

    for (;;) {
        // Once there are enough matches, a bill type whose next bill can be no newer
        // than the oldest match we'd keep has nothing left to add.
        if (found.length >= maxResults) {
            found.sort(newestFirst);
            const oldestKept = found[maxResults - 1].record.introducedDate;
            for (const cursor of cursors) {
                if (cursor.frontier <= oldestKept) cursor.done = true;
            }
        }
        const active = cursors.filter((cursor) => !cursor.done);
        if (active.length === 0) break;

        const jobs = [];
        for (const cursor of active) {
            for (const number of cursor.numbers.slice(cursor.pos, cursor.pos + batchSize)) jobs.push({ cursor, number });
            cursor.pos += batchSize;
        }
        const entries = await mapWithConcurrency(jobs, CONCURRENCY, ({ cursor, number }) => getBillEntry(cursor.congress, cursor.type, number));

        jobs.forEach(({ cursor }, i) => {
            const entry = entries[i];
            if (!entry) return;
            const introducedDate = entry.introducedDate ?? parseBillEntry(entry)?.record.introducedDate;
            if (!introducedDate) return;
            cursor.frontier = introducedDate;
            if (introducedDate < cutoff) {
                cursor.oldStreak++;
                return;
            }
            cursor.oldStreak = 0;
            if (keywordMatcher && entry.xml && !keywordMatcher.mightMatch(entry.xml)) return;
            const bill = parseBillEntry(entry);
            if (!bill) return;
            if (keywordMatcher && !keywordMatcher.matches(bill.searchText)) return;
            if (currentStatus && bill.statusCode !== currentStatus) return;
            found.push(bill);
        });
        for (const cursor of active) {
            if (cursor.oldStreak >= OLD_STREAK_LIMIT || cursor.pos >= cursor.numbers.length) cursor.done = true;
        }
        batchSize = Math.min(batchSize * 2, 50);
    }

    const attempted = fetchStats.attempted - attemptedBefore;
    const failed = fetchStats.failed - failedBefore;
    if (failed > 0 && failed >= Math.max(5, attempted * 0.1)) {
        throw new Error(`GovInfo bulk data is failing: ${failed} of ${attempted} bill files could not be fetched.`);
    }
    log.info(`Checked ${attempted} new bill file(s) on GovInfo${failed ? ` (${failed} skipped after errors)` : ''}.`);

    found.sort(newestFirst);
    return found.slice(0, maxResults).map((bill) => bill.record);
}

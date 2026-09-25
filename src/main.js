import { Actor, log } from 'apify';
import { fetchBills } from './govtrack.js';
import { fetchDocuments } from './fedregister.js';
import { fetchOpportunities } from './grants.js';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const { daysBack = 30, maxResultsPerSource = 10 } = input;
let { keywords } = input;

/** Must match the event name configured in this Actor's pay-per-event pricing on Apify. */
const KEYWORD_SEARCHED_EVENT = 'keyword-searched';

// An empty run (first click in the Console, Apify's daily health check) must
// still return data, or Apify flags the actor "under maintenance".
if (keywords === undefined || (Array.isArray(keywords) && keywords.length === 0)) {
    keywords = ['data centers'];
    log.info('No keywords given; defaulting to the example "data centers".');
}
if (!Array.isArray(keywords)) {
    throw new Error('Input "keywords" must be an array, e.g. ["data centers"].');
}

const endDate = new Date();
const startDate = new Date(endDate.getTime() - daysBack * 24 * 60 * 60 * 1000);
const limit = Math.min(maxResultsPerSource, 50);

for (const keyword of keywords) {
    log.info(`Scanning for "${keyword}"`);

    const [billsResult, documentsResult, opportunitiesResult] = await Promise.allSettled([
        fetchBills({ keyword, daysBack, maxResults: limit }),
        fetchDocuments({ keyword, startDate, endDate, limit }),
        fetchOpportunities({ keyword, startDate, limit }),
    ]);

    const congressBills = billsResult.status === 'fulfilled' ? billsResult.value : [];
    const federalRegisterDocuments = documentsResult.status === 'fulfilled' ? documentsResult.value : [];
    const grantOpportunities = opportunitiesResult.status === 'fulfilled' ? opportunitiesResult.value : [];

    const errors = [billsResult, documentsResult, opportunitiesResult]
        .filter((r) => r.status === 'rejected')
        .map((r) => r.reason?.message ?? String(r.reason));
    if (errors.length > 0) {
        log.warning(`One or more sources failed for "${keyword}"`, { errors });
    }

    await Actor.pushData({
        keyword,
        daysBack,
        congressBills,
        federalRegisterDocuments,
        grantOpportunities,
        totalItems: congressBills.length + federalRegisterDocuments.length + grantOpportunities.length,
        sourceErrors: errors,
        checkedAt: new Date().toISOString(),
    });

    await Actor.charge({ eventName: KEYWORD_SEARCHED_EVENT });

    log.info(`"${keyword}": ${congressBills.length} bills, ${federalRegisterDocuments.length} regulations, ${grantOpportunities.length} grants`);
}

await Actor.exit();

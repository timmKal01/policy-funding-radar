const UA = 'PolicyFundingRadar/0.1 (+contact: policy-funding-radar-admin@example.com)';
const API_URL = 'https://api.grants.gov/v1/api/search2';

const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;
const REQUEST_TIMEOUT_MS = 15_000;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, options) {
    let lastError;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        let res;
        try {
            res = await fetch(url, { ...options, signal: controller.signal });
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
        if (!TRANSIENT_STATUSES.has(res.status)) {
            throw new Error(`Grants.gov request failed: ${res.status} ${res.statusText}`);
        }
        lastError = new Error(`Grants.gov request failed: ${res.status} ${res.statusText}`);
        if (attempt < MAX_ATTEMPTS) await sleep(1000 * 2 ** (attempt - 1));
    }
    throw lastError;
}

/** Grants.gov returns dates as "MM/DD/YYYY" strings. */
function parseOppDate(mmddyyyy) {
    if (!mmddyyyy) return null;
    const [month, day, year] = mmddyyyy.split('/').map(Number);
    return new Date(Date.UTC(year, month - 1, day));
}

export async function fetchOpportunities({ keyword, startDate, limit }) {
    const body = {
        rows: Math.min(limit * 2, 100), // over-fetch a bit since we filter by date client-side
        oppStatuses: 'posted',
        sortBy: 'openDate|desc',
    };
    if (keyword) body.keyword = keyword;

    const res = await fetchWithRetry(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
        body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.errorcode) throw new Error(`Grants.gov API error: ${data.msg}`);

    const hits = data.data?.oppHits ?? [];

    return hits
        .filter((h) => {
            const opened = parseOppDate(h.openDate);
            return opened && opened >= startDate;
        })
        .slice(0, limit)
        .map((h) => ({
            opportunityId: h.id,
            opportunityNumber: h.number,
            title: h.title,
            agency: h.agency,
            openDate: h.openDate,
            closeDate: h.closeDate || null,
            status: h.oppStatus,
            opportunityUrl: `https://www.grants.gov/search-results-detail/${h.id}`,
        }));
}

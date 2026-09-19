const BASE_URL = 'https://www.govtrack.us/api/v2/bill';

const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;
const REQUEST_TIMEOUT_MS = 15_000;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url) {
    let lastError;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        let res;
        try {
            res = await fetch(url, { headers: { Connection: 'close' }, signal: controller.signal });
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
            const body = await res.text();
            throw new Error(`GovTrack API request failed: ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
        }
        lastError = new Error(`GovTrack API request failed: ${res.status} ${res.statusText}`);
        if (attempt < MAX_ATTEMPTS) await sleep(1000 * 2 ** (attempt - 1));
    }
    throw lastError;
}

export async function fetchBills({ keyword, daysBack, maxResults }) {
    const cutoff = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    const url = new URL(BASE_URL);
    url.searchParams.set('introduced_date__gte', cutoffStr);
    url.searchParams.set('sort', '-introduced_date');
    url.searchParams.set('limit', String(Math.min(maxResults, 100)));
    if (keyword) url.searchParams.set('q', keyword);

    const res = await fetchWithRetry(url);
    const data = await res.json();

    return (data.objects ?? []).map((bill) => ({
        billNumber: bill.display_number,
        title: bill.title_without_number,
        congress: bill.congress,
        chamber: bill.current_chamber,
        status: bill.current_status_label,
        statusDate: bill.current_status_date,
        introducedDate: bill.introduced_date,
        isAlive: bill.is_alive,
        sponsorName: bill.sponsor?.name ?? null,
        sponsorState: bill.sponsor_role?.state ?? null,
        link: bill.link,
    }));
}

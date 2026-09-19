const UA = 'PolicyFundingRadar/0.1 (+contact: policy-funding-radar-admin@example.com)';
const BASE_URL = 'https://www.federalregister.gov/api/v1/documents.json';

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
            throw new Error(`Federal Register request failed: ${res.status} ${res.statusText}`);
        }
        lastError = new Error(`Federal Register request failed: ${res.status} ${res.statusText}`);
        if (attempt < MAX_ATTEMPTS) await sleep(1000 * 2 ** (attempt - 1));
    }
    throw lastError;
}

const FIELDS = ['document_number', 'title', 'type', 'agencies', 'publication_date', 'comments_close_on', 'html_url', 'abstract'];

function isoDate(d) {
    return d.toISOString().slice(0, 10);
}

export async function fetchDocuments({ keyword, startDate, endDate, limit }) {
    const params = new URLSearchParams();
    params.set('conditions[publication_date][gte]', isoDate(startDate));
    params.set('conditions[publication_date][lte]', isoDate(endDate));
    params.set('per_page', String(limit));
    params.set('order', 'newest');
    if (keyword) params.set('conditions[term]', keyword);
    for (const f of FIELDS) params.append('fields[]', f);

    const res = await fetchWithRetry(`${BASE_URL}?${params}`, { headers: { 'User-Agent': UA } });
    const data = await res.json();
    return (data.results ?? []).map((doc) => ({
        documentNumber: doc.document_number,
        title: doc.title,
        type: doc.type,
        agencies: (doc.agencies ?? []).map((a) => a.name).filter(Boolean),
        publicationDate: doc.publication_date,
        commentsCloseOn: doc.comments_close_on ?? null,
        abstract: doc.abstract,
        htmlUrl: doc.html_url,
    }));
}

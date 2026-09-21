# Policy & Funding Radar: Bills, Rules & Grants by Keyword

Give it a keyword. Get back one combined report: matching U.S. Congress
bills, new Federal Register regulations, and open Grants.gov funding
opportunities: three government portals, one search.

## Who this is for

- **Government-affairs and lobbying teams** tracking legislative and regulatory activity on an issue.
- **Nonprofits, universities, and research orgs** scanning for both policy developments and funding opportunities on the same topic.
- **Policy researchers and journalists** who currently check congress.gov, federalregister.gov, and grants.gov separately for the same story.

## Input

| Field | Type | Description |
|---|---|---|
| `keywords` | array | One search per keyword, e.g. `["data centers", "broadband"]`. |
| `daysBack` | integer (default `30`) | How far back to search across all three sources. |
| `maxResultsPerSource` | integer (default `10`) | Cap on results per source, per keyword. |

```json
{
  "keywords": ["data centers"],
  "daysBack": 30
}
```

## Output

One record per keyword:

```json
{
  "keyword": "data centers",
  "daysBack": 30,
  "congressBills": [
    { "billNumber": "H.R. 1234", "title": "...", "status": "Introduced", "sponsorName": "...", "link": "..." }
  ],
  "federalRegisterDocuments": [
    { "documentNumber": "2026-12345", "title": "...", "type": "Rule", "agencies": ["Department of Energy"], "publicationDate": "2026-09-10", "htmlUrl": "..." }
  ],
  "grantOpportunities": [
    { "opportunityNumber": "...", "title": "...", "agency": "...", "openDate": "09/01/2026", "closeDate": "11/01/2026", "opportunityUrl": "..." }
  ],
  "totalItems": 7,
  "sourceErrors": [],
  "checkedAt": "2026-09-19T12:00:00.000Z"
}
```

If one source fails (a portal outage, for example) the other two still
return normally: `sourceErrors` lists which source(s) failed and why,
rather than failing the whole keyword.

## How it works

Three official, direct API calls per keyword, no scraping, no proxy:

- **GovTrack.us** for Congress bills (same source as [Congress Bill Tracker](https://github.com/timmKal01/congress-bill-tracker))
- **Federal Register API** for new rules, proposed rules, and notices (same source as [Federal Register Tracker](https://github.com/timmKal01/federal-register-tracker))
- **Grants.gov API** for open funding opportunities (same source as [Grant Opportunity Tracker](https://github.com/timmKal01/grant-opportunity-tracker))

## Pricing note

Billed per **keyword searched**, not per item returned: one charge covers the
combined lookup across Congress bills, federal regulations, and grant
opportunities for that keyword, whether it turns up zero results or dozens
across all three sources.

## Related products

- [Congress Bill Tracker](https://github.com/timmKal01/congress-bill-tracker): bill search with more filters (status, sponsor state, specific Congress), not bundled with regulations or grants
- [Federal Register Tracker](https://github.com/timmKal01/federal-register-tracker): regulation search with agency/document-type filters
- [Grant Opportunity Tracker](https://github.com/timmKal01/grant-opportunity-tracker): grant search with agency filters
- [Federal Grant Award Tracker](https://github.com/timmKal01/federal-grant-award-tracker): grants already *awarded*, for tracking who got funded rather than what's open

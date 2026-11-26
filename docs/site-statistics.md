# Admin statistics and related providers

## User interface

The admin navigation links to `/admin/statisztikak.html`. The page uses the existing
CMS session; all statistics API routes require the existing admin role. Public
navigation continues to omit admin links.

The dashboard shows estimated unique visitors for today and the current Monday–Sunday
week, page views and saved inquiries, a fourteen-day daily visitor chart, and searchable,
paginated article and provider tables. The content tables and totals can show today,
this week, the last thirty calendar days, or all retained aggregate data. All calendar
boundaries use `Europe/Budapest`, including daylight-saving changes.

No historical page views are manufactured. The migration records the actual start of
measurement. Earlier contact inquiries are backfilled once where retained records
allow it; personal data previously erased cannot be reconstructed.

## Measurement

`lib/site-statistics.cjs` instruments successful public HTML responses with the local
`statistics.js` script. The script submits a signed, expiring page token once the page
is visible. A unique database receipt prevents a retry of the same token from counting
twice. An actual new page load receives a new token and can count as another view.
Invalid tokens, cross-origin submissions, recognized robots, prefetches, previews,
admin pages, signed-in administrators, and requests with DNT/GPC enabled are excluded.
Statistics failures do not prevent public HTML from being served.

Visitor numbers are estimates, not a count of identified people. A week-specific HMAC
of the transient IP address and user-agent string deduplicates visits. Shared networks
and identical browsers can reduce the estimate; browser or network changes can increase
it. Weekly visitors are deduplicated over the whole week rather than calculated by
adding daily visitor counts. The stable secret is derived from `CMS_JWT_SECRET` with a
separate purpose label; rotating that secret can count an existing visitor again.

No analytics cookie, local-storage identifier, raw IP, raw user agent, search term,
referrer, or visitor-to-page history is stored. Temporary visitor keys contain only a
daily/weekly bucket and a hash and cannot be joined to individual page aggregates.
Hourly cleanup retains a fifteen-calendar-day window of visitor buckets; signed-token
receipts expire after approximately six hours. Aggregate counters remain available.
The public data-use page describes this behavior without claiming legal exemptions.

The database migration installs an `AFTER INSERT` trigger on
`directory_contact_inquiries`. Each saved inquiry counts once, including inquiries
waiting for email setup or delivery. Retries and changes in delivery status do not
increment the count. Aggregate counts survive subsequent personal-data erasure.
The backfill and trigger installation share the existing migration transaction and
lock contact inserts to avoid a gap or double count.

## API

- `GET /api/admin/statistics?range=week`: start date, timezone, today/week counts,
  selected-period totals, fourteen-day trend.
- `GET /api/admin/statistics/articles?range=week&q=&page=1&page_size=25`: per-article views.
- `GET /api/admin/statistics/listings?range=week&q=&page=1&page_size=25`: per-profile
  views and saved inquiries.
- `POST /api/public/statistics/view`: same-origin signed-token collection endpoint.

Valid ranges are `today`, `week`, `30days`, and `all`. Admin responses are private and
not cached. SQL filters are parameterized. Empty and unavailable data have distinct UI
states; an unavailable read does not appear as a measured zero.

## Related providers

`lib/related-providers.cjs` maps article topics and relevant age/specialism signals to
ranked directory categories. It randomly samples within a relevance tier, with a limit
of four unique, published providers or organizations in active categories. Clinical
topics are not filled from alternative-service categories. Each card links to its
actual public profile and shows its category and location/online availability.

The selection appears to the left of article text on desktop and below the text on
small screens. An optional provider-query error does not break the article. Topic
mapping changes belong in `providerSelection`/`TOPIC_TIERS` and should be accompanied
by relevant selection tests; do not substitute unverified fabricated profiles.

## Verification

The GitHub Actions workflow runs focused unit and PostgreSQL tests, existing catalog,
contact, editorial and MCP regression checks, and `scripts/test-statistics-browser.cjs`.
The browser test verifies actual view aggregation, private access, admin exclusions,
saved-inquiry counts, dashboard search/pagination, four provider links, and responsive
layout. Its fixtures run only against a disposable local test database and send no real
email. Desktop and mobile screenshots are included in the workflow artifacts.

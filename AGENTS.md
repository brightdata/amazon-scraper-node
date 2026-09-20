# For coding agents working in this repository

Read this before changing anything. Every line below was verified against the
live API or the installed SDK, `@brightdata/sdk` 1.2.0, on 2026-09-20.

## The one that costs money

Reviews bill one credit per review, and **there is no working cap in this SDK**.

- The API takes `max_reviews`, and Bright Data's own documented sample sets it
  to 20. `AmazonCollectReviewsFilterSchema` declares only `url` and
  `reviews_to_not_include`, and is strict, so `max_reviews` is rejected.
- `limitPerInput`, the SDK's own cap, returns **zero rows** on the reviews
  dataset. Measured three times across two products, `success: true`,
  `status: "ready"`, no error row. The same option behaves normally on
  products.
- So the only reviews call that returns anything is the uncapped one.
  `B0CRMZHDG8` reports 205,036 reviews. That is one call.

Tracked in [sdk-js#37](https://github.com/brightdata/sdk-js/issues/37). Until it
is fixed, no README block may call `collectReviews` or `reviews`, and a test
enforces that. Use the REST endpoint directly if you need a bounded slice.

## Caps in general

`limitPerInput` is the only bound on a discovery call, and it is silently
stripped unless `async: true` is passed alongside it. The options schema is a
union keyed on `async`, and the sync half drops unknown keys, so the cap
vanishes with no error. The typed `DiscoverOptions` tells you to omit `async`,
which means the correctly typed call is the uncapped one. Tracked in
[sdk-js#36](https://github.com/brightdata/sdk-js/issues/36). Pass both, always.

Verified: `discoverProductsByKeyword` with `limitPerInput: 3` returned exactly
3 rows.

## Auth

- The SDK reads `apiKey`, then `BRIGHTDATA_API_TOKEN` or `BRIGHTDATA_API_KEY`,
  then the credentials `bdata login` stored.
- This SDK does not read a `.env` file. Node 20 loads one: `node --env-file=.env`.
- Always `new bdclient({ autoCreateZones: false })`. Zone creation needs a
  payment method and this repository never uses a zone.

## How the API behaves

- Amazon lives on `client.scrape.amazon`. The products dataset is
  `gd_l7q7dkf244hwjntr0`, the id the control panel shows, and it holds about
  300 million records.
- Poll options are milliseconds. `pollTimeout` defaults to 600000.
- The API quotes about 7 seconds per input, and a single product usually
  returns in 12 to 25 seconds. Keyword discovery is far less predictable: the
  same call took 32 s once and 547 s another time. `live.yml` allows a block
  15 minutes for that reason.
- Every ASIN goes in one job. The API bills per record, not per job.
- A batch returns rows in no guaranteed order. `attribute()` matches each row
  to its ASIN by the row's own `asin`, falling back to the ASIN inside
  `input_url`, `url` or `input.url`. Never match by position.
- A dead ASIN comes back as a row whose error reads "The navigation resulted in
  a dead page (404 status code)". Match the message, not a code.
- One credit per record. 5,000 credits are free each month, and the products
  scraper is priced at $1.50 per 1,000 records.

## What the SDK does not expose

The API accepts more than the SDK's filters allow. Checked against
`GET /datasets/v3/scrapers?domain=amazon.com`:

- Products `collect_by_url` takes `url`, `asin`, `origin_url`, `zipcode`,
  `language`, `all_variations`. The SDK filter takes `url`, `zipcode`,
  `language` and rejects the other three. So an ASIN has to be written as a
  `/dp/` URL, which is what `productUrl()` does.
- There is a fifth Amazon scraper, the products global dataset
  (`gd_lwhideng15g8jg63s7`), with discovery by **seller** and by **brand** and a
  `domain` parameter for other Amazon sites. Neither SDK exposes it.
- The four datasets this SDK does reach: products `gd_l7q7dkf244hwjntr0`
  (119 fields), reviews `gd_le8e811kzy4ggddlq` (31), sellers
  `gd_lhotzucw1etoe5iw1k` (29), product search `gd_lwdb4vjm1ehb499uxs` (30).

## The schema

- Never hardcode a field list. A product carries the fields that apply to it:
  the two products in the README returned 99 and 100 fields out of 119.
- The API marks `seller_name`, `zipcode` and `coupon` as `pii: true`. The
  sellers dataset also marks `email` and `seller_phone_number`, so treat that
  one with more care than products.
- Read the schema with the raw metadata endpoint, as the field-table step in
  `live.yml` does.
- The full documentation index: https://docs.brightdata.com/llms.txt

## The API stalls in waves

On 2026-09-16, building the Instagram twin, the API went through stretches of
about an hour where most jobs sat until the poll deadline and returned
`status: "timeout"` with no rows. A red live check whose only symptom is
timeouts is probably a bad wave: rerun it before looking for a code change.

## Working here

- `npm test` runs offline and needs no token. `npm run lint` must pass.
- CI installs from the README's own commands on an empty machine. A weekly
  workflow executes every fenced block in the README against the real API.
- The field table and the "last verified" badge are rewritten by the daily run.
  Do not edit either by hand.
- Keep it small: 14 files and about 350 lines of JavaScript in `src/`. Do not
  add retries, deduplication, scheduling, databases or concurrency.

/**
 * Get Amazon products by ASIN, or by the URL that carries one.
 *
 *     ASINs -> collectProducts -> ScrapeJob -> full product records
 *
 * Every ASIN asked for goes into one job. The API bills per record, not per
 * job, and a job takes about the same time for one URL as for ten.
 *
 * The SDK's product filter accepts only url, zipcode and language, and rejects
 * `asin` outright, although the API takes it. So an ASIN is turned into a
 * /dp/ URL here rather than passed through.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { bdclient } from "@brightdata/sdk";

/** The SDK polls in milliseconds and gives up at 600000 by default. */
export const POLL_TIMEOUT_MS = 600_000;
export const POLL_INTERVAL_MS = 5_000;

/** Which Amazon site the ASINs are read from. */
export const DOMAIN = "https://www.amazon.com";

/** An ASIN is ten characters, letters and digits. Most begin with B0. */
const ASIN = /^[A-Z0-9]{10}$/i;

/**
 * The SDK constructor, behind one indirection.
 *
 * ES module exports are read-only bindings, so a test cannot replace an
 * imported class the way Python's monkeypatch replaces a module attribute.
 */
export const sdk = { bdclient };

/** Accept B0CRMZHDG8, a /dp/ URL, a /gp/product/ URL, or one with a query. */
export function cleanAsin(input) {
  const raw = String(input ?? "").trim();
  const fromPath = raw.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/i);
  const candidate = fromPath ? fromPath[1] : raw.split("?")[0].split("#")[0].replace(/\/+$/, "");
  if (!ASIN.test(candidate)) {
    throw new Error(`${JSON.stringify(raw)} is not an Amazon ASIN`);
  }
  return candidate.toUpperCase();
}

export function productUrl(input) {
  return `${DOMAIN}/dp/${cleanAsin(input)}`;
}

/** Flatten a ScrapeResult, or an array of them, into plain objects. */
export function rows(result) {
  if (Array.isArray(result)) return result.flatMap(rows);
  let data = result && typeof result === "object" && "data" in result ? result.data : result;
  if (data && typeof data === "object" && !Array.isArray(data)) data = [data];
  if (!Array.isArray(data)) return [];
  return data.filter((row) => row && typeof row === "object" && !Array.isArray(row));
}

/**
 * A failed or timed out request carries no rows to explain itself.
 *
 * Without this check the run prints "0 products", which reads like an ASIN
 * that does not exist rather than a request that never came back.
 */
export function envelopeError(result) {
  if (!result || result.success !== false) return null;
  return String(result.error ?? result.status ?? "request failed");
}

/** The ASIN a row answers for, from whichever field carries it. */
export function rowAsin(row) {
  const direct = typeof row.asin === "string" ? row.asin : "";
  if (ASIN.test(direct)) return direct.toUpperCase();
  const source = String(row.input_url ?? row.url ?? row.input?.url ?? "");
  const found = source.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
  return found ? found[1].toUpperCase() : "";
}

/** What happened to one ASIN. */
export class Outcome {
  constructor({ asin, product = null, error = null }) {
    this.asin = asin;
    this.product = product;
    this.error = error;
  }

  get ok() {
    return this.error === null;
  }

  /** One line a reader can understand without having read the source. */
  line() {
    if (!this.ok) return `failed  ${this.asin}: ${this.error}`;
    const title = String(this.product?.title ?? "").slice(0, 48);
    return `got     ${this.asin}: ${Object.keys(this.product ?? {}).length} fields${title ? ` (${title})` : ""}`;
  }
}

/**
 * Match each returned row back to the ASIN that asked for it.
 *
 * A batch returns rows in no guaranteed order, and an error row for a dead
 * ASIN carries the input it failed on rather than a product. Matching on the
 * ASIN inside whichever field is present is the only link back.
 */
export function attribute(asins, result) {
  const byAsin = new Map();
  const unmatched = [];

  for (const row of rows(result)) {
    const found = rowAsin(row);
    if (found && asins.includes(found) && !byAsin.has(found)) byAsin.set(found, row);
    else unmatched.push(row);
  }

  // Rows that name no ASIN we asked for, in order, so nothing is dropped.
  for (const asin of asins) {
    if (!byAsin.has(asin) && unmatched.length) byAsin.set(asin, unmatched.shift());
  }

  return asins.map((asin) => {
    const row = byAsin.get(asin);
    if (!row) return new Outcome({ asin, error: "the API returned no row for this ASIN" });
    if (row.error) return new Outcome({ asin, error: String(row.error) });
    return new Outcome({ asin, product: row });
  });
}

/**
 * Run `fn` with the client passed in, or with one we open and own.
 *
 * A client we opened holds an undici pool, so the process would not exit until
 * it is closed. A client the caller passed is theirs to close.
 */
export async function withClient(client, fn) {
  if (client) return fn(client);
  // autoCreateZones defaults to true: the SDK creates Web Unlocker and SERP
  // zones on the first request, which this scraper never uses. Creating a zone
  // needs a payment method, so leaving it on breaks the first run for free
  // accounts.
  const owned = new sdk.bdclient({ autoCreateZones: false });
  try {
    return await fn(owned);
  } finally {
    await owned.close();
  }
}

/** Fetch every ASIN in one job. Never throws: a failure becomes Outcomes. */
export async function scrape(inputs, { client = null } = {}) {
  const values = [...inputs];
  const asins = [];
  const rejected = new Map();
  for (const value of values) {
    try {
      asins.push(cleanAsin(value));
    } catch (error) {
      rejected.set(String(value), new Outcome({ asin: String(value), error: error.message }));
    }
  }

  const wanted = [...new Set(asins)];
  let found = new Map();
  if (wanted.length) {
    const outcomes = await withClient(client, async (opened) => {
      try {
        // includeErrors is off unless asked for, and the orchestrated products()
        // helper cannot pass it, so collect plus toResult is the only path that
        // reports a dead ASIN instead of silently returning nothing.
        const job = await opened.scrape.amazon.collectProducts(
          wanted.map((asin) => `${DOMAIN}/dp/${asin}`),
          { async: true, includeErrors: true },
        );
        const result = await job.toResult({
          pollInterval: POLL_INTERVAL_MS,
          pollTimeout: POLL_TIMEOUT_MS,
        });
        const failed = envelopeError(result);
        if (failed) return wanted.map((asin) => new Outcome({ asin, error: failed }));
        return attribute(wanted, result);
      } catch (error) {
        const message = `${error?.constructor?.name ?? "Error"}: ${error?.message ?? error}`;
        return wanted.map((asin) => new Outcome({ asin, error: message }));
      }
    });
    found = new Map(outcomes.map((outcome) => [outcome.asin, outcome]));
  }

  // One Outcome per input, in the order asked.
  return values.map((value) => {
    const raw = String(value);
    if (rejected.has(raw)) return rejected.get(raw);
    return found.get(cleanAsin(value)) ?? new Outcome({ asin: raw, error: "no result" });
  });
}

/** Write one JSON file: when it ran, and the product found per ASIN. */
export async function write(outcomes, path) {
  const document = {
    generated_at: new Date().toISOString(),
    products: outcomes.map((o) => ({ asin: o.asin, product: o.product })),
  };
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  return target;
}

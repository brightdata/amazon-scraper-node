/** These run without a token. The client is a stub. */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, before, describe, test } from "node:test";

import { attribute, cleanAsin, productUrl, rowAsin, scrape, sdk, write } from "../src/scrape.js";
import { main } from "../src/cli.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const run = promisify(execFile);
const STANLEY = "B0CRMZHDG8";
const OWALA = "B085DVHQ57";

let temp;
before(async () => {
  temp = await mkdtemp(join(tmpdir(), "amzscraper-"));
});
after(async () => {
  await rm(temp, { recursive: true, force: true });
});

/** A client whose one Amazon call returns canned rows. */
function stub(records, { capture } = {}) {
  const collectProducts = async (input, options) => {
    if (capture) capture.push({ input, options });
    if (records instanceof Error) throw records;
    return { toResult: async () => ({ success: true, status: "ready", data: records }) };
  };
  return { scrape: { amazon: { collectProducts } } };
}

function envelope(fields) {
  return {
    scrape: { amazon: { collectProducts: async () => ({ toResult: async () => fields }) } },
  };
}

async function withFakeSdk(Fake, body) {
  const real = sdk.bdclient;
  sdk.bdclient = Fake;
  try {
    return await body();
  } finally {
    sdk.bdclient = real;
  }
}

describe("ASIN input", () => {
  test("an ASIN, a dp URL, a gp/product URL and lower case all name the same product", () => {
    assert.equal(cleanAsin(STANLEY), STANLEY);
    assert.equal(cleanAsin("b0crmzhdg8"), STANLEY);
    assert.equal(cleanAsin(`https://www.amazon.com/Quencher-FlowState/dp/${STANLEY}`), STANLEY);
    assert.equal(cleanAsin(`https://www.amazon.com/gp/product/${OWALA}/?th=1`), OWALA);
    assert.equal(productUrl(STANLEY), `https://www.amazon.com/dp/${STANLEY}`);
  });

  test("anything that is not an ASIN is refused before any request", () => {
    for (const bad of ["not-an-asin", "", "B0CRMZHDG", "https://www.amazon.com/"]) {
      assert.throws(() => cleanAsin(bad), /is not an Amazon ASIN/, String(bad));
    }
  });
});

describe("what the API answers", () => {
  test("a product comes back against the ASIN that asked for it", async () => {
    const records = [
      { asin: OWALA, title: "Owala FreeSip" },
      { asin: STANLEY, title: "STANLEY Quencher" },
    ];
    const [stanley, owala] = await scrape([STANLEY, OWALA], { client: stub(records) });

    assert.equal(stanley.product.title, "STANLEY Quencher", "rows come back in no guaranteed order");
    assert.equal(owala.product.title, "Owala FreeSip");
  });

  test("a row that carries no asin field is matched on its input_url", () => {
    const [outcome] = attribute([STANLEY], {
      data: [{ input_url: `https://www.amazon.com/dp/${STANLEY}`, title: "STANLEY Quencher" }],
    });

    assert.ok(outcome.ok);
    assert.equal(outcome.product.title, "STANLEY Quencher");
  });

  test("rowAsin reads the asin field, then the url, and is case insensitive", () => {
    assert.equal(rowAsin({ asin: "b0crmzhdg8" }), STANLEY);
    assert.equal(rowAsin({ url: `https://www.amazon.com/gp/product/${OWALA}` }), OWALA);
    assert.equal(rowAsin({ input: { url: `https://www.amazon.com/dp/${STANLEY}` } }), STANLEY);
    assert.equal(rowAsin({ title: "no identifier at all" }), "");
  });

  test("an error row fails only the ASIN it belongs to", async () => {
    const records = [
      { asin: STANLEY, title: "STANLEY Quencher" },
      { input: { url: `https://www.amazon.com/dp/${OWALA}` }, error: "Page not found" },
    ];
    const [good, bad] = await scrape([STANLEY, OWALA], { client: stub(records) });

    assert.ok(good.ok);
    assert.equal(bad.line(), `failed  ${OWALA}: Page not found`);
  });

  test("an ASIN the API never returned is a failure, not a silent gap", async () => {
    const [only] = await scrape([STANLEY], { client: stub([]) });

    assert.ok(!only.ok);
    assert.match(only.error, /no row/);
  });

  test("a timed out request fails every ASIN in the batch", async () => {
    const client = envelope({ success: false, data: null, error: null, status: "timeout" });
    const outcomes = await scrape([STANLEY, OWALA], { client });

    assert.deepEqual(outcomes.map((o) => o.error), ["timeout", "timeout"]);
  });

  test("one bad input does not stop the others being fetched", async () => {
    const [good, bad] = await scrape([STANLEY, "not-an-asin"], {
      client: stub([{ asin: STANLEY, title: "STANLEY Quencher" }]),
    });

    assert.ok(good.ok);
    assert.match(bad.error, /is not an Amazon ASIN/);
  });

  test("a thrown request does not end the run", async () => {
    const [outcome] = await scrape([STANLEY], { client: stub(new RangeError("boom")) });

    assert.equal(outcome.error, "RangeError: boom");
  });

  test("error rows are asked for, and every ASIN goes in one job as a dp URL", async () => {
    const capture = [];
    await scrape([STANLEY, `https://www.amazon.com/gp/product/${OWALA}`], {
      client: stub([], { capture }),
    });

    assert.equal(capture.length, 1, "a batch must be one job, not one job per ASIN");
    assert.deepEqual(capture[0].options, { async: true, includeErrors: true });
    assert.deepEqual(capture[0].input, [
      `https://www.amazon.com/dp/${STANLEY}`,
      `https://www.amazon.com/dp/${OWALA}`,
    ]);
  });

  test("the same ASIN asked for twice is fetched once and answered twice", async () => {
    const capture = [];
    const outcomes = await scrape([STANLEY, `https://www.amazon.com/dp/${STANLEY}`], {
      client: stub([{ asin: STANLEY, title: "STANLEY Quencher" }], { capture }),
    });

    assert.equal(capture[0].input.length, 1, "a duplicate ASIN must not be billed twice");
    assert.equal(outcomes.length, 2);
    assert.ok(outcomes.every((o) => o.ok));
  });
});

describe("writing the file", () => {
  test("a run writes what it found", async () => {
    const product = { asin: STANLEY, title: "STANLEY Quencher" };
    const outcomes = await scrape([STANLEY], { client: stub([product]) });

    assert.equal(outcomes[0].line(), `got     ${STANLEY}: 2 fields (STANLEY Quencher)`);

    const path = await write(outcomes, join(temp, "out.json"));
    const document = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(document.products, [{ asin: STANLEY, product }]);
    assert.ok(document.generated_at);
  });
});

describe("the client we own", () => {
  test("a client we opened is always closed", async () => {
    const calls = [];
    class Fake {
      constructor() {
        calls.push("new");
        Object.assign(this, stub([{ asin: STANLEY }]));
      }
      async close() {
        calls.push("close");
      }
    }
    await withFakeSdk(Fake, async () => {
      const [outcome] = await scrape([STANLEY]);
      assert.ok(outcome.ok);
    });
    assert.deepEqual(calls, ["new", "close"]);
  });

  test("we do not ask the SDK to create zones", async () => {
    let seen;
    class Fake {
      constructor(options) {
        seen = options;
        Object.assign(this, stub([]));
      }
      async close() {}
    }
    await withFakeSdk(Fake, () => scrape([STANLEY]));
    assert.equal(seen.autoCreateZones, false);
  });
});

describe("the command", () => {
  async function fakeCli(records, argv) {
    class Fake {
      constructor() {
        Object.assign(this, stub(records));
      }
      async close() {}
    }
    return withFakeSdk(Fake, () => main(argv));
  }

  test("the exit code says whether every ASIN worked", async () => {
    const ok = await fakeCli([{ asin: STANLEY, title: "t" }], [STANLEY, "--out", join(temp, "ok.json")]);
    assert.equal(ok, 0);

    const bad = await fakeCli(
      [{ input: { url: `https://www.amazon.com/dp/${STANLEY}` }, error: "boom" }],
      [STANLEY, "--out", join(temp, "bad.json")],
    );
    assert.equal(bad, 1);
  });

  test("no ASIN is refused with the usage, not a stack trace", async () => {
    const written = [];
    const real = process.stderr.write;
    process.stderr.write = (chunk) => (written.push(String(chunk)), true);
    try {
      assert.equal(await main([]), 2);
    } finally {
      process.stderr.write = real;
    }
    assert.match(written.join(""), /usage: amazon-scraper/);
  });

  test("a missing token is a message, not a stack trace", async () => {
    const written = [];
    const real = process.stderr.write;
    process.stderr.write = (chunk) => (written.push(String(chunk)), true);
    const { AuthenticationError } = await import("@brightdata/sdk");
    class Fake {
      constructor() {
        throw new AuthenticationError("No API token found. Run `npx @brightdata/cli login`");
      }
    }
    let code;
    try {
      code = await withFakeSdk(Fake, () => main([STANLEY]));
    } finally {
      process.stderr.write = real;
    }
    assert.equal(code, 2);
    assert.match(written.join(""), /export BRIGHTDATA_API_TOKEN/);
  });

  test("piped output keeps the header before the error", async () => {
    const env = { ...process.env, HOME: temp, PATH: process.env.PATH };
    delete env.BRIGHTDATA_API_TOKEN;
    delete env.BRIGHTDATA_API_KEY;
    let stdout = "";
    let code = 0;
    try {
      const done = await run(process.execPath, [join(ROOT, "src/cli.js"), STANLEY], {
        cwd: temp,
        env,
        timeout: 60_000,
      });
      stdout = done.stdout + done.stderr;
    } catch (error) {
      code = error.code;
      stdout = `${error.stdout}${error.stderr}`;
    }
    assert.equal(code, 2, stdout);
    assert.ok(stdout.indexOf("Fetching 1 Amazon product") < stdout.indexOf("API token required"));
  });
});

describe("the SDK contract the README relies on", () => {
  test("every Amazon method the README names exists", async () => {
    const { AmazonAPI } = await import(
      join(ROOT, "node_modules/@brightdata/sdk/dist/esm/api/scrape/amazon.mjs")
    );
    for (const name of [
      "collectProducts",
      "collectReviews",
      "collectSellers",
      "collectProductSearch",
      "discoverProductsByKeyword",
      "discoverProductsByCategoryURL",
      "discoverProductsByBestSellerURL",
      "discoverProductsByUPC",
      "products",
      "reviews",
      "sellers",
    ]) {
      assert.equal(typeof AmazonAPI.prototype[name], "function", name);
    }
  });

  test("the products filter rejects asin, so an ASIN has to become a URL", async () => {
    const { AmazonCollectProductsFilterSchema: schema } = await import(
      join(ROOT, "node_modules/@brightdata/sdk/dist/esm/schemas/filters/amazon.mjs")
    );
    const url = `https://www.amazon.com/dp/${STANLEY}`;
    assert.equal(schema.safeParse({ url }).success, true);
    // The API accepts asin, origin_url and all_variations. The SDK filter does not.
    assert.equal(schema.safeParse({ url, asin: STANLEY }).success, false);
    assert.equal(schema.safeParse({ url, all_variations: false }).success, false);
  });

  test("the reviews filter rejects max_reviews, which is why the README never runs reviews", async () => {
    const { AmazonCollectReviewsFilterSchema: schema } = await import(
      join(ROOT, "node_modules/@brightdata/sdk/dist/esm/schemas/filters/amazon.mjs")
    );
    const url = `https://www.amazon.com/dp/${STANLEY}`;
    assert.equal(schema.safeParse({ url }).success, true);
    // max_reviews is the API's own cap and its documented sample uses it.
    // limitPerInput, the SDK's alternative, returns zero rows on this dataset.
    // So there is no working cap, and reviews bill one credit each.
    // https://github.com/brightdata/sdk-js/issues/37
    assert.equal(schema.safeParse({ url, max_reviews: 20 }).success, false);
  });

  test("limitPerInput survives only when async is passed too", async () => {
    const { DatasetOptionsSchema: schema } = await import(
      join(ROOT, "node_modules/@brightdata/sdk/dist/esm/schemas/datasets.mjs")
    );
    // Without async the options match the sync half of the union, which strips
    // unknown keys, so the cap vanishes with no error.
    // https://github.com/brightdata/sdk-js/issues/36
    assert.equal(schema.parse({ includeErrors: true, limitPerInput: 3 }).limitPerInput, undefined);
    assert.equal(
      schema.parse({ async: true, includeErrors: true, limitPerInput: 3 }).limitPerInput,
      3,
    );
  });

  test("polling is measured in milliseconds, so a timeout is not off by a thousand", async () => {
    const { pollUntilReady } = await import(
      join(ROOT, "node_modules/@brightdata/sdk/dist/esm/utils/polling.mjs")
    );
    const started = Date.now();
    await assert.rejects(
      () => pollUntilReady("sd_x", async () => ({ status: "running" }), {
        pollInterval: 10,
        pollTimeout: 60,
      }),
      /timeout|timed out/i,
    );
    assert.ok(Date.now() - started < 5_000, "a 60 ms timeout waited for seconds");
  });
});

describe("the README", () => {
  test("the excerpt is the start of the example file", async () => {
    const sample = await readFile(join(ROOT, "examples/sample_output.json"), "utf8");
    const readme = await readFile(join(ROOT, "README.md"), "utf8");

    assert.ok(
      readme.includes(sample.split("\n").slice(0, 19).join("\n")),
      "README excerpt drifted from the file",
    );
    assert.ok(readme.includes("](examples/sample_output.json)"));
  });

  test("every in-page link has its heading", async () => {
    const readme = await readFile(join(ROOT, "README.md"), "utf8");
    const anchors = new Set(
      [...readme.matchAll(/^#{1,6} (.+)$/gm)].map(([, heading]) =>
        heading.toLowerCase().replace(/[^a-z0-9 -]/g, "").replace(/ /g, "-"),
      ),
    );
    for (const [, anchor] of readme.matchAll(/\]\(#([^)]+)\)/g)) {
      assert.ok(anchors.has(anchor), `#${anchor} points at no heading`);
    }
  });

  test("no runnable block calls reviews, which cannot be capped", async () => {
    const readme = await readFile(join(ROOT, "README.md"), "utf8");
    const blocks = [...readme.matchAll(/```javascript\n([\s\S]*?)```/g)].map((m) => m[1]);
    for (const code of blocks) {
      assert.ok(
        !/collectReviews|\.reviews\(/.test(code),
        "a reviews call in a runnable block would bill one credit per review, every week",
      );
    }
  });
});

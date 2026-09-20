#!/usr/bin/env node
/** amazon-scraper B0CRMZHDG8 B085DVHQ57 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { BRDError } from "@brightdata/sdk";

import { scrape, write } from "./scrape.js";

/** The SDK's own advice names a JavaScript option. A command has no such thing. */
const NO_TOKEN = [
  "API token required but not found.",
  "  export BRIGHTDATA_API_TOKEN=YOUR_API_KEY   token: https://brightdata.com/cp/setting/users",
  "  or run once: npx -p @brightdata/cli bdata login",
].join("\n");

const USAGE = `usage: amazon-scraper ASIN [ASIN ...] [--out PATH]

  ASIN         an ASIN such as B0CRMZHDG8, or a product URL carrying one
  --out PATH   output file, default amazon.json`;

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const CLEAR_LINE = "\r[2K";

/** Seconds as h:mm:ss, the shape a reader can read at a glance. */
function clock(seconds) {
  const mm = String(Math.floor(seconds / 60) % 60).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");
  return `${Math.floor(seconds / 3600)}:${mm}:${ss}`;
}

/**
 * A spinner and a running clock, so a minute of waiting looks alive.
 * Outside a terminal it prints one plain line instead, because a log wants a
 * line, not an animation.
 */
function waiting(label) {
  if (!process.stdout.isTTY) {
    process.stdout.write(`asking  ${label}...\n`);
    return () => {};
  }
  const started = Date.now();
  let frame = 0;
  const tick = () => {
    const spin = FRAMES[frame++ % FRAMES.length];
    process.stdout.write(`${CLEAR_LINE}${spin} ${label} ${clock(Math.floor((Date.now() - started) / 1000))}`);
  };
  tick();
  const timer = setInterval(tick, 100);
  timer.unref();
  return () => {
    clearInterval(timer);
    process.stdout.write(CLEAR_LINE); // leave the line clean for the result
  };
}

export async function main(argv = process.argv.slice(2)) {
  let asins;
  let out;
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: { out: { type: "string" } },
      allowPositionals: true,
    });
    asins = positionals;
    out = values.out ?? "amazon.json";
    if (!asins.length) throw new Error("give at least one ASIN");
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${USAGE}\n`);
    return 2;
  }

  process.stdout.write(
    `Fetching ${asins.length} Amazon product${asins.length === 1 ? "" : "s"}: ${asins.join(", ")}\n` +
      "One job for all of them. One credit per product.\n",
  );

  let outcomes = [];
  try {
    const done = waiting(`${asins.length} product${asins.length === 1 ? "" : "s"}`);
    try {
      outcomes = await scrape(asins);
    } finally {
      done();
    }
  } catch (error) {
    // Almost always a missing token, which reads as a crash under a stack trace.
    if (!(error instanceof BRDError)) throw error;
    const message = String(error?.message ?? error);
    process.stderr.write(`${/token/i.test(message) ? NO_TOKEN : message}\n`);
    return 2;
  }

  for (const outcome of outcomes) process.stdout.write(`${outcome.line()}\n`);

  const path = await write(outcomes, out);
  const found = outcomes.filter((outcome) => outcome.ok).length;
  process.stdout.write(`\nSaved ${found} of ${outcomes.length} products as JSON to ${path}\n`);
  return outcomes.every((outcome) => outcome.ok) ? 0 : 1;
}

/**
 * Is this file the program being run?
 *
 * Comparing `import.meta.url` to `file://${argv[1]}` is wrong twice over. A
 * path with a space encodes to %20 on one side only, and `npm install -g`
 * puts a symlink on PATH, so argv[1] is the link while import.meta.url is the
 * file it points at. Either mismatch makes the installed command exit 0 and
 * do nothing at all.
 */
function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  process.exitCode = await main();
}

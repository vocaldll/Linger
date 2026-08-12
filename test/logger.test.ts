import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatLogLine, formatTimestamp } from "../src/logger.js";

const DATE = new Date(2026, 7, 12, 6, 27, 9, 256);

describe("logger formatting", () => {
  it("uses a readable local timestamp without milliseconds", () => {
    assert.equal(formatTimestamp(DATE), "2026-08-12 06:27:09");
    assert.equal(
      formatLogLine("info", "Steam account connected", { account: "vocal", visible: true }, { date: DATE }),
      "[2026-08-12 06:27:09] INFO  Steam account connected | account=vocal visible=true"
    );
  });

  it("quotes complex values and strips control characters from messages", () => {
    assert.equal(
      formatLogLine("warn", "Retry\nstarted", { error: "Logged in elsewhere", value: null }, { date: DATE }),
      '[2026-08-12 06:27:09] WARN  Retry started | error="Logged in elsewhere" value=null'
    );
  });

  it("adds ANSI styling only when color is requested", () => {
    const colored = formatLogLine("error", "Connection failed", {}, { color: true, date: DATE });
    assert.match(colored, /\u001b\[31mERROR\u001b\[0m/u);
    assert.doesNotMatch(formatLogLine("error", "Connection failed", {}, { date: DATE }), /\u001b\[/u);
  });
});

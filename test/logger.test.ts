import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatLogLine, formatTimestamp } from "../src/logger.js";

const DATE = new Date(2026, 7, 12, 6, 27, 9, 256);

describe("logger formatting", () => {
  it("uses a full local timestamp and aligned account and subsystem columns", () => {
    assert.equal(formatTimestamp(DATE), "2026-08-12 06:27:09");
    assert.equal(
      formatLogLine("info", "steam", "Connected", { account: "vocal", visible: true }, { date: DATE }),
      "[2026-08-12 06:27:09] INFO  vocal        steam    Connected | visible=true"
    );
  });

  it("quotes complex values and strips control characters from messages", () => {
    assert.equal(
      formatLogLine("warn", "steam", "Retry\nstarted", { error: "Logged in elsewhere", value: null }, { date: DATE }),
      '[2026-08-12 06:27:09] WARN  —            steam    Retry started | error="Logged in elsewhere" value=null'
    );
  });

  it("adds ANSI styling only when color is requested", () => {
    const informational = formatLogLine("info", "steam", "Connected", {}, { color: true, date: DATE });
    const colored = formatLogLine("error", "steam", "Connection failed", {}, { color: true, date: DATE });
    assert.match(informational, /\u001b\[38;2;154;111;188mINFO \u001b\[0m/u);
    assert.match(colored, /\u001b\[31mERROR\u001b\[0m/u);
    assert.match(informational, /\u001b\[38;2;198;163;223m— {11}\u001b\[0m/u);
    assert.doesNotMatch(formatLogLine("error", "steam", "Connection failed", {}, { date: DATE }), /\u001b\[/u);
  });
});

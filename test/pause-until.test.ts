import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatPauseUntil, parsePauseUntil } from "../src/tui/pause-until.js";

describe("pause deadline input", () => {
	it("converts an explicit local date to a stored UTC deadline", () => {
		const expected = new Date(2030, 8, 10, 14, 30);
		assert.equal(
			parsePauseUntil("2030-09-10 14:30", 0),
			expected.toISOString(),
		);
		assert.match(formatPauseUntil(expected.toISOString()), /2030/);
	});

	it("rejects ambiguous input, impossible dates, and past deadlines", () => {
		for (const invalid of [
			"09/10/30",
			"2030-02-30 14:30",
			"2030-13-01 14:30",
			"2030-09-10 25:00",
			"2030-09-10 14:60",
		]) {
			assert.throws(() => parsePauseUntil(invalid, 0));
		}
		assert.throws(
			() =>
				parsePauseUntil(
					"2030-09-10 14:30",
					new Date(2030, 8, 10, 14, 30).getTime(),
				),
			/future date and time/,
		);
	});
});

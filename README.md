# Linger

Linger is a terminal-based Steam hour booster and card farmer with multi-account support.

> [!WARNING]
> Linger automates playtime and trading-card farming, which Steam prohibits under Sections 4.C–D of the [Steam Subscriber Agreement](https://store.steampowered.com/subscriber_agreement/). Valve may restrict or terminate affected accounts. Use at your own risk.

## Features

- Manage multiple Steam accounts through an interactive TUI
- Sign in using a Steam Mobile QR code or credentials; passwords are never stored
- Browse and search your library or add games manually by AppID
- Boost multiple games, set total-hour targets, and review card-farming queues before starting
- Configure visibility, custom game titles, away messages, and recent activity
- Recover disconnected sessions and apply configuration changes automatically
- Inspect live activity, timers, farming progress, and errors across the fleet
- Encrypt saved session tokens with a local master key

## Quick start

Requires Node.js 24 or newer and pnpm 11.

```sh
pnpm install
pnpm build
pnpm manage
pnpm start
```

Open the manager again at any time; the runner applies configuration changes automatically.

Inspect the current fleet or open the live dashboard in another terminal:

```sh
node dist/src/cli.js status
node dist/src/cli.js status --watch
node dist/src/cli.js status --json
```

## Docker

Build the image, configure accounts, and start the service:

```sh
docker compose build
docker compose run --rm linger manage
docker compose up -d
```

Follow the runner logs with `docker compose logs -f linger`.

Open the live fleet dashboard with `docker compose exec linger node dist/src/cli.js status --watch`.

Compose stores `linger.sqlite`, `master.key`, and `steam-device-id` in the `linger-data` volume mounted at `/app/data`.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `LINGER_DATA_DIR` | `./data` | Directory for the database, generated master key, and Steam device identity |
| `LINGER_DB_PATH` | `<data dir>/linger.sqlite` | Override the SQLite database path |
| `LINGER_MASTER_KEY` | Generated automatically | Encryption key with at least 32 characters |
| `LINGER_MASTER_KEY_FILE` | — | Read the encryption key from a file; takes precedence over `LINGER_MASTER_KEY` |
| `LINGER_RECONCILE_INTERVAL_MS` | `2000` | How often the runner checks for account changes |
| `LINGER_LOG_LEVEL` | `info` | Minimum log level: `debug`, `info`, `warn`, or `error` |

Back up the data directory or Docker volume as a unit. Deleting it removes Linger's configuration, and saved account tokens cannot be decrypted if the master key is lost.

`steam-device-id` is generated randomly on first run and gives every installation a stable identity when connecting to Steam. It contains no hostname or hardware identifier and is never sent to Steam directly. Copying the data directory also copies this identity.

## Operational notes

- Steam supports at most 32 simultaneous game entries. A custom title uses one slot, and recent-activity clearing reserves three. Games can still be configured using AppIDs if the library is unavailable.

- Card farming temporarily replaces normal hour boosting. When the queue finishes, boosting resumes, or the account is disabled if no normal presence is configured.

- The card-farming planner shows Steam's reported drops alongside cached playtime. Games can be excluded, reordered manually, or sorted by fewest drops or least playtime. Exclusions are remembered per account, and the queue can optionally be rescanned after each game.

- Planner scans require the runner. A disabled account connects invisibly for the scan without starting a game, then disconnects unless the reviewed queue is started.

- Linger does not assume a fixed playtime before a card drop. [Steam lets each developer configure its game's minimum](https://partner.steamgames.com/doc/marketing/tradingcards?l=english), so the planner does not derive an ETA from a universal threshold.

- Auto-stop targets apply to normal hour boosting only. Card farming may carry a game beyond its target; Linger checks the current Steam playtime before normal boosting resumes.

- Steam has no documented API for remaining card drops, so detection relies on Community badge markup. Ambiguous, rate-limited, or logged-out responses are retried rather than treated as zero drops.

- If an account starts playing elsewhere, Linger pauses and reconnects automatically after the game exits. Invisible accounts may take longer to detect.

- Auto Restart is enabled by default per account. When disabled, a disconnected session remains stopped until you request a manual restart, re-authenticate, re-enable the account, or turn Auto Restart back on.

## Development

```sh
pnpm check
pnpm test
```

---

<sub>Not affiliated with Valve Corporation or Steam. All trademarks belong to their respective owners. Released under the [MIT License](LICENSE).</sub>

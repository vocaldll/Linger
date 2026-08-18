# Linger

Linger is a terminal-based Steam hour booster and card farmer with multi-account support.

> [!WARNING]
> Using Linger to boost playtime or automatically farm trading cards violates Section 4.C, "Automation," of the [Steam Subscriber Agreement](https://store.steampowered.com/subscriber_agreement/). Valve prohibits automation that fakes playtime or earns rewards without genuine user input. Under Section 4.D, Valve may restrict or terminate affected Steam accounts. Use Linger at your own risk.

## Features

- Manage multiple Steam accounts through an interactive TUI
- Sign in with a Steam Mobile QR code or Steam credentials
- Use Steam passwords only during sign-in and never save them locally
- Preserve user privacy with no telemetry and a random Steam device identity generated separately for each installation instead of from hostname or hardware data
- Browse and search your Steam library
- Add games manually by AppID
- Boost multiple games simultaneously
- Stop boosting selected games at configured total-hour targets
- Automatically farm available trading-card drops
- Reconnect disconnected accounts automatically
- Configure online visibility per account
- Send a configurable away message with a 30-minute per-sender cooldown
- Display a custom game title
- Clear recent Steam activity
- Encrypt saved Steam session tokens with a local master key
- Apply configuration changes without restarting the runner

## Requirements

- Node.js 24 or newer
- pnpm 11

## Quick start

Install and build Linger, open the manager to add accounts, then start the runner:

```sh
pnpm install
pnpm build
pnpm manage
pnpm start
```

The manager can be opened again while the runner is active. Configuration changes are picked up automatically.

## Docker

Build the image, configure accounts, and start the service:

```sh
docker compose build
docker compose run --rm linger manage
docker compose up -d
```

Follow the runner logs with `docker compose logs -f linger`.

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

- Auto-stop targets apply to normal hour boosting only. Card farming may carry a game beyond its target; Linger checks the current Steam playtime before normal boosting resumes.

- Steam has no documented API for remaining card drops, so detection relies on Community badge markup. Ambiguous, rate-limited, or logged-out responses are retried rather than treated as zero drops.

- If an account starts playing elsewhere, Linger pauses and reconnects automatically after the game exits. Invisible accounts may take longer to detect.

## Development

```sh
pnpm check
pnpm test
```

---

<sub>Not affiliated with Valve Corporation or Steam. All trademarks belong to their respective owners. Released under the [MIT License](LICENSE).</sub>

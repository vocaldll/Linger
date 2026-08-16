# Linger

Linger is a terminal-based, multi-account Steam hour booster and card farmer. It keeps configured games active through Steam, automatically farms available trading-card drops, reconnects accounts when needed, and stores account configuration in a local SQLite database.

![Linger account manager showing multiple accounts and account configuration](docs/showcase.png)

## Features

- Manage multiple Steam accounts from an interactive TUI
- Sign in using a Steam Mobile QR code or username, password, and Steam Guard
- Pick games from the account's Steam library, with search and playtime sorting
- Automatically farm every currently available Steam trading-card drop, one game at a time
- Add AppIDs manually when a game is unavailable in the library picker
- Configure visibility, a custom game title, and recent-activity clearing per account
- Encrypt saved Steam tokens with a local master key

## Requirements

- Node.js 24 or newer
- pnpm 11

## Setup

```sh
pnpm install
pnpm build
```

Open the manager and add an account:

```sh
pnpm manage
```

Then start the runner:

```sh
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

Follow the runner logs with:

```sh
docker compose logs -f linger
```

### Docker data

The included Compose file mounts the `linger-data` volume at `/app/data` inside the container. It contains:

- `/app/data/linger.sqlite` — accounts, settings, and cached game libraries
- `/app/data/master.key` — the key used to encrypt saved Steam tokens

Docker manages the volume's location on the host. To inspect it, run:

```sh
docker volume inspect linger-data
```

Removing the volume deletes Linger's configuration. Keep the volume backed up as a unit so the database and encryption key stay together.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `LINGER_DATA_DIR` | `./data` | Directory for the database and generated master key |
| `LINGER_DB_PATH` | `<data dir>/linger.sqlite` | Override the SQLite database path |
| `LINGER_MASTER_KEY` | Generated automatically | Encryption key with at least 32 characters |
| `LINGER_MASTER_KEY_FILE` | — | Read the encryption key from a file; takes precedence over `LINGER_MASTER_KEY` |
| `LINGER_RECONCILE_INTERVAL_MS` | `2000` | How often the runner checks for account changes |

Keep the data directory or configured master key backed up. Saved account tokens cannot be decrypted if the key is lost.

## Notes

Steam supports at most 32 simultaneous game entries. A custom game title uses one slot, and recent-activity clearing reserves three additional slots. If Steam cannot return an account's library, games can still be configured using AppIDs.

Card farming temporarily replaces the configured hour-boosting presence. Linger scans the authenticated Steam Community badge pages, persists the farming queue, and checks the active game when Steam announces new inventory items or after a periodic fallback interval. Once the queue is complete, card farming turns itself off and normal hour boosting resumes. If no normal AppIDs or custom game are configured, the account is disabled instead.

Steam does not expose remaining card drops through its documented API, so this feature depends on the badge and game-card page markup. Unexpected, incomplete, rate-limited, or logged-out responses are treated as errors and retried; they are never interpreted as an empty queue or zero remaining drops.

When Steam disconnects Linger because the account is playing elsewhere, Linger uses its last authenticated Community session to check the account's own profile every 30 seconds. Two consecutive online results confirm that the game has exited and allow an early reconnect. Because Steam's invisible mode appears offline both while playing and after exit, two consecutive offline results trigger one reconnect probe instead. If Steam rejects that probe as logged in elsewhere, or if the profile response is expired or unrecognized, Linger falls back to a 45-minute retry.

## Development

```sh
pnpm check
pnpm test
```

---

<sub>Not affiliated with Valve Corporation or Steam. All trademarks belong to their respective owners. Released under the [MIT License](LICENSE).</sub>

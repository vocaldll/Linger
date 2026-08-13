# Linger

Linger is a terminal-based, multi-account Steam hour booster. It keeps configured games active through Steam, reconnects accounts when needed, and stores account configuration in a local SQLite database.

## Features

- Manage multiple Steam accounts from an interactive TUI
- Sign in using a Steam Mobile QR code or username, password, and Steam Guard
- Pick games from the account's Steam library, with search and playtime sorting
- Add AppIDs manually when a game is unavailable in the library picker
- Configure visibility, a custom game title, and recent-activity clearing per account
- Encrypt saved Steam tokens with a local master key

## Requirements

- Node.js 24 or newer
- pnpm 11

## Setup

```sh
corepack enable
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

## Development

```sh
pnpm check
pnpm test
```

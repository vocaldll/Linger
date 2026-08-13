import {
  createPrompt,
  isBackspaceKey,
  isDownKey,
  isEnterKey,
  isSpaceKey,
  isTabKey,
  isUpKey,
  useKeypress,
  usePagination,
  usePrefix,
  useState,
  type Status
} from "@inquirer/core";
import { styleText } from "node:util";
import {
  GAME_SORT_LABELS,
  filterOwnedGames,
  formatPlaytime,
  sortOwnedGames,
  type GameSort,
  type OwnedGame
} from "../domain/game-library.js";

export type GamePickerResult = {
  action: "save" | "cancel" | "manual" | "sort";
  selectedAppIds: number[];
  sort: GameSort;
  query: string;
  activeAppId: number | null;
};

type GamePickerConfig = {
  games: readonly OwnedGame[];
  selectedAppIds: readonly number[];
  sort: GameSort;
  maximumSelected: number;
  allowEmpty: boolean;
  initialQuery?: string;
  initialActiveAppId?: number | null;
  notice?: string;
  pageSize?: number;
};

type GamePickerContext = {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  clearPromptOnDone?: boolean;
  signal?: AbortSignal;
};

type PickerEntry = OwnedGame & { manuallyAdded: boolean };

export function buildPickerEntries(
  games: readonly OwnedGame[],
  selectedAppIds: readonly number[],
  sort: GameSort,
  query = ""
): PickerEntry[] {
  const ownedIds = new Set(games.map((game) => game.appId));
  const manuallyAdded = selectedAppIds
    .filter((appId) => !ownedIds.has(appId))
    .map((appId) => ({
      appId,
      name: `AppID ${appId}`,
      playtimeForever: 0,
      manuallyAdded: true
    }));
  const owned = sortOwnedGames(games, sort).map((game) => ({ ...game, manuallyAdded: false }));
  return filterOwnedGames([...manuallyAdded, ...owned], query);
}

function truncate(value: string, maximumLength: number): string {
  return value.length <= maximumLength ? value : `${value.slice(0, maximumLength - 1)}…`;
}

export const gamePicker: (
  config: GamePickerConfig,
  context?: GamePickerContext
) => Promise<GamePickerResult> = createPrompt<GamePickerResult, GamePickerConfig>((config, done) => {
  const [status, setStatus] = useState<Status>("idle");
  const [selectedAppIds, setSelectedAppIds] = useState([...config.selectedAppIds]);
  const [query, setQuery] = useState(config.initialQuery ?? "");
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const entries = buildPickerEntries(config.games, selectedAppIds, config.sort, query);
  const initialActive = Math.max(
    0,
    entries.findIndex((game) => game.appId === config.initialActiveAppId)
  );
  const [active, setActive] = useState(initialActive);
  const activeIndex = Math.min(active, Math.max(0, entries.length - 1));
  const prefix = usePrefix({ status });

  const complete = (action: GamePickerResult["action"]): void => {
    const result: GamePickerResult = {
      action,
      selectedAppIds,
      sort: config.sort,
      query,
      activeAppId: action === "sort" ? null : (entries[activeIndex]?.appId ?? null)
    };
    setStatus("done");
    done(result);
  };

  useKeypress((key) => {
    const pressed = key as typeof key & { meta?: boolean; sequence?: string };
    if (searching) {
      if (key.name === "escape") {
        setQuery("");
        setSearching(false);
        setActive(0);
      } else if (isTabKey(key) || isEnterKey(key)) {
        setSearching(false);
      } else if (isBackspaceKey(key)) {
        setQuery(query.slice(0, -1));
        setActive(0);
      } else if (
        !key.ctrl &&
        !pressed.meta &&
        pressed.sequence &&
        [...pressed.sequence].length === 1
      ) {
        setQuery(`${query}${pressed.sequence}`);
        setActive(0);
      }
      return;
    }

    if (isUpKey(key) && entries.length > 0) {
      setError(null);
      setActive(Math.max(0, activeIndex - 1));
    } else if (isDownKey(key) && entries.length > 0) {
      setError(null);
      setActive(Math.min(entries.length - 1, activeIndex + 1));
    } else if (isSpaceKey(key) && entries.length > 0) {
      const appId = entries[activeIndex]!.appId;
      if (selectedAppIds.includes(appId)) {
        setSelectedAppIds(selectedAppIds.filter((selected) => selected !== appId));
        setError(null);
      } else if (selectedAppIds.length >= config.maximumSelected) {
        setError(`You can select at most ${config.maximumSelected} games with the current settings`);
      } else {
        setSelectedAppIds([...selectedAppIds, appId]);
        setError(null);
      }
    } else if (pressed.sequence === "/" || key.name === "/") {
      setSearching(true);
      setError(null);
    } else if (key.name === "s") {
      complete("sort");
    } else if (key.name === "m") {
      complete("manual");
    } else if (key.name === "escape") {
      if (query) {
        setQuery("");
        setActive(0);
      } else {
        complete("cancel");
      }
    } else if (isEnterKey(key)) {
      if (!config.allowEmpty && selectedAppIds.length === 0) {
        setError("Select at least one game or add an AppID manually");
      } else {
        complete("save");
      }
    }
  });

  const nameWidth = Math.max(16, Math.min(42, (process.stdout.columns || 80) - 34));
  const paginatedEntries = usePagination({
    items: entries,
    active: activeIndex,
    pageSize: config.pageSize ?? 10,
    loop: false,
    renderItem({ item, isActive }) {
      const checked = selectedAppIds.includes(item.appId);
      const cursor = isActive ? styleText("cyan", "›") : " ";
      const checkbox = checked ? styleText("green", "[x]") : "[ ]";
      const name = truncate(item.name, nameWidth).padEnd(nameWidth);
      const detail = item.manuallyAdded
        ? "manually added"
        : `${formatPlaytime(item.playtimeForever)} · AppID ${item.appId}`;
      const row = `${cursor} ${checkbox} ${name} ${styleText("dim", detail)}`;
      return isActive ? styleText("cyan", row) : row;
    }
  });
  const page =
    entries.length === 0
      ? styleText(
          "dim",
          query ? "  No games match this search." : "  No library games available."
        )
      : paginatedEntries;

  if (status === "done") {
    return `${prefix} Choose boosted games ${styleText("cyan", `${selectedAppIds.length} selected`)}`;
  }

  const count = `${selectedAppIds.length} / ${config.maximumSelected}`;
  const searchLine = searching
    ? `${styleText("bold", "Search:")} ${query}${styleText("cyan", "_")}`
    : query
      ? `${styleText("bold", "Filter:")} ${query}`
      : null;
  const help = searching
    ? `${styleText("bold", "type")} search · ${styleText("bold", "enter/tab")} browse · ${styleText("bold", "esc")} clear`
    : [
        `${styleText("bold", "↑↓")} move`,
        `${styleText("bold", "space")} toggle`,
        `${styleText("bold", "/")} search`,
        `${styleText("bold", "s")} sort`,
        `${styleText("bold", "m")} enter AppIDs`,
        `${styleText("bold", "enter")} save`,
        `${styleText("bold", "esc")} clear/cancel`
      ].join(styleText("dim", " · "));

  return [
    `${prefix} ${styleText("bold", "Choose boosted games")} ${styleText("cyan", count)}`,
    `${styleText("dim", "Sort:")} ${GAME_SORT_LABELS[config.sort]}`,
    searchLine,
    "",
    page,
    "",
    config.notice ? styleText("green", config.notice) : null,
    error ? styleText("red", error) : null,
    styleText("dim", help)
  ]
    .filter((line): line is string => line !== null)
    .join("\n")
    .trimEnd();
});

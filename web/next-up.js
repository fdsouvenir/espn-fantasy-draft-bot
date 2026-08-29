const BASE_POSITIONS = ["QB", "RB", "WR", "TE"];

function needPriority(needs, position) {
  const need = needs.find((candidate) => {
    const value = typeof candidate === "string" ? candidate : candidate.position ?? candidate.slot;
    return String(value).toUpperCase() === position;
  });
  if (!need) return 1;
  const priority = String(
    typeof need === "string" ? "open" : need.priority ?? need.status ?? "open",
  ).toLowerCase();
  if (["urgent", "high", "open"].includes(priority)) return 0;
  return ["met", "filled"].includes(priority) ? 2 : 1;
}

export function positionIsSuppressed(needs, position) {
  const anotherStarterIsOpen = BASE_POSITIONS.some(
    (candidate) => candidate !== position && needPriority(needs, candidate) === 0,
  );
  return anotherStarterIsOpen && needPriority(needs, position) === 2;
}

export function selectNextUpLanes(players, needs, compareByRole) {
  const best = (positions) => [...players]
    .filter(
      (player) => positions.includes(player.position) &&
        !positionIsSuppressed(needs, player.position),
    )
    .sort(compareByRole)[0] ?? null;

  return {
    backfield: best(["RB"]),
    receiver: best(["WR"]),
    other: best(["TE", "QB"]),
  };
}

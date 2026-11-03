type CompletionSnapshot = {
  active?: boolean;
  done?: boolean;
  startedAt?: number;
};

/** Only a live, uninterrupted active → done transition is a completion bell. */
export function createWorkCompletionTransition() {
  let activeTurn: number | undefined;
  let completedTurn = 0;

  return {
    disconnect() {
      activeTurn = undefined;
    },
    observe(type: "snapshot" | "start" | "done", next: CompletionSnapshot) {
      const startedAt = next.startedAt;
      if (
        typeof startedAt !== "number" ||
        !Number.isFinite(startedAt) ||
        startedAt <= 0
      ) {
        activeTurn = undefined;
        return null;
      }
      if (type === "done") {
        const live =
          next.done === true &&
          next.active === false &&
          activeTurn === startedAt &&
          startedAt > completedTurn;
        activeTurn = undefined;
        completedTurn = Math.max(completedTurn, startedAt);
        return live ? startedAt : null;
      }
      // A completed snapshot is replay, including the first frame on reconnect.
      activeTurn =
        next.active === true && !next.done && startedAt > completedTurn
          ? startedAt
          : undefined;
      return null;
    },
  };
}

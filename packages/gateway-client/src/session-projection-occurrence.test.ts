import { describe, expect, it } from "vitest";
import {
  createSessionProjection,
  reduceSessionProjection,
  reconcileSessionProjectionSnapshot,
  type SessionProjectionScope,
  type SessionProjectionState,
} from "./session-projection.js";

const scope: SessionProjectionScope = {
  sessionKey: "agent:main:occurrence",
  sessionId: "session-1",
  agentId: "main",
  lifecycleRevision: 1,
  activeLeafEntryId: "leaf-1",
};
const user = {
  role: "user",
  content: "show the checks",
  __openclaw: { id: "user-1", seq: 1, runId: "run-1" },
};
const final = { role: "assistant", content: "checks complete" };

function liveFinal(): SessionProjectionState {
  let state = reduceSessionProjection(createSessionProjection(scope, [user]), {
    type: "runTerminal",
    runId: "run-1",
    status: "completed",
    message: final,
  });
  state = reduceSessionProjection(state, {
    type: "messagePersisted",
    message: final,
    envelope: { runId: "run-1" },
  });
  for (const entry of state.entries) {
    if (entry.message === final) {
      entry.occurrenceKey = "stream-body-1";
    }
  }
  return state;
}

function savedFinal(id = "answer-1", text = "checks complete") {
  return {
    role: "assistant",
    content: text,
    stopReason: "stop",
    __openclaw: { id, seq: 2, runId: "run-1" },
  };
}

function keys(state: SessionProjectionState) {
  return state.entries.flatMap((entry) =>
    entry.occurrenceKey === undefined ? [] : [entry.occurrenceKey],
  );
}

describe("session projection occurrence continuity", () => {
  it.each(["event", "snapshot"] as const)(
    "retains definitive %s adoption and two cloned snapshots",
    (arrival) => {
      const saved = savedFinal();
      let state =
        arrival === "event"
          ? reduceSessionProjection(liveFinal(), { type: "messagePersisted", message: saved })
          : reduceSessionProjection(liveFinal(), {
              type: "snapshotLoaded",
              messages: [user, saved],
            });
      for (let reload = 0; reload < 2; reload += 1) {
        expect(keys(state)).toEqual(["stream-body-1"]);
        expect(
          state.entries.find((entry) => entry.identity?.id === "answer-1")?.occurrenceKey,
        ).toBe("stream-body-1");
        state = reduceSessionProjection(state, {
          type: "snapshotLoaded",
          messages: structuredClone([user, saved]),
        });
      }
      expect(keys(state)).toEqual(["stream-body-1"]);
      expect(state.messages).toEqual([user, saved]);
      expect(JSON.stringify(state.messages)).not.toContain("occurrenceKey");
    },
  );

  it("keeps a distinct same-run final independent", () => {
    let state = reduceSessionProjection(liveFinal(), {
      type: "messagePersisted",
      message: savedFinal(),
    });
    const second = savedFinal("answer-2", "a different answer");
    second["__openclaw"].seq = 3;
    state = reduceSessionProjection(state, { type: "messagePersisted", message: second });
    expect(state.messages).toEqual([user, savedFinal(), second]);
    expect(keys(state)).toEqual(["stream-body-1"]);
    expect(state.entries.at(-1)?.occurrenceKey).toBeUndefined();
  });

  it("does not alias tentative history or duplicate identity when inference rolls back", () => {
    const tentative = { ...savedFinal(), stopReason: "toolUse" };
    let state = reduceSessionProjection(liveFinal(), {
      type: "snapshotLoaded",
      messages: [user, tentative],
    });
    expect(state.runs["run-1"]?.inferredSnapshotTerminal?.entry.occurrenceKey).toBe(
      "stream-body-1",
    );
    expect(keys(state)).toEqual([]);
    const later = savedFinal("later-answer", "the run continued");
    later["__openclaw"].seq = 3;
    state = reduceSessionProjection(state, {
      type: "snapshotLoaded",
      messages: structuredClone([user, tentative, later]),
    });
    expect(state.messages).toContain(final);
    expect(keys(state)).toEqual(["stream-body-1"]);
    expect(
      state.entries.find((entry) => entry.identity?.id === "answer-1")?.occurrenceKey,
    ).toBeUndefined();
    expect(new Set(keys(state)).size).toBe(keys(state).length);
  });

  it.each([
    { sessionKey: "agent:main:other" },
    { sessionId: "session-2" },
    { agentId: "other" },
    { lifecycleRevision: 2 },
    { activeLeafEntryId: "leaf-2" },
  ])("retires continuity on scope change %j", (change) => {
    const previous = liveFinal();
    // A stale event cannot switch scope; the snapshot owner explicitly accepts the new scope.
    expect(
      reduceSessionProjection(previous, {
        type: "snapshotLoaded",
        scope: { ...scope, ...change },
        messages: [user, savedFinal()],
      }),
    ).toBe(previous);
    const state = reconcileSessionProjectionSnapshot(previous, [user, savedFinal()], {
      ...scope,
      ...change,
    });
    expect(keys(state)).toEqual([]);
  });

  it("does not mint client occurrence keys from external message metadata", () => {
    const message = {
      ...savedFinal(),
      occurrenceKey: "forged",
      __openclaw: {
        ...savedFinal()["__openclaw"],
        occurrenceKey: "also-forged",
      },
    };
    expect(keys(createSessionProjection(scope, [message, structuredClone(message)]))).toEqual([]);
  });

  it("does not duplicate an occurrence when a snapshot repeats a durable row", () => {
    const saved = savedFinal();
    const state = reduceSessionProjection(
      reduceSessionProjection(liveFinal(), {
        type: "messagePersisted",
        message: saved,
      }),
      { type: "snapshotLoaded", messages: [user, saved, structuredClone(saved)] },
    );
    expect(keys(state)).toEqual(["stream-body-1"]);
    expect(state.entries.filter((entry) => entry.occurrenceKey !== undefined)).toHaveLength(1);
  });

  it("resets ambiguous saved-to-duplicate snapshots without changing row admission", () => {
    const saved = savedFinal();
    let state = reduceSessionProjection(liveFinal(), {
      type: "snapshotLoaded",
      messages: [user, saved],
    });
    state = reduceSessionProjection(state, {
      type: "snapshotLoaded",
      messages: structuredClone([user, saved]),
    });
    expect(keys(state)).toEqual(["stream-body-1"]);
    state = reduceSessionProjection(state, {
      type: "snapshotLoaded",
      messages: structuredClone([user, saved, saved]),
    });
    expect(state.messages).toHaveLength(3);
    expect(keys(state)).toEqual([]);
  });
});

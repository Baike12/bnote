import { describe, expect, it } from "vitest";
import {
  notifySessionsChanged,
  onRemoteAttachRequest,
  onSessionsChanged,
  requestRemoteAttach,
  setPendingCodeNewSession,
  setPendingCodeSession,
  setPendingRemoteAttach,
  takePendingCodeNewSession,
  takePendingCodeSession,
  takePendingRemoteAttach,
} from "./sessionRequest";

describe("pending session pick", () => {
  it("lands only in the checkout it was recorded for, once", () => {
    setPendingCodeSession("/p/a", "s1");
    expect(takePendingCodeSession("/p/a")).toBe("s1");
    expect(takePendingCodeSession("/p/a")).toBeNull();
  });

  it("a pick for another checkout is dropped, not carried over", () => {
    setPendingCodeSession("/p/a", "s1");
    expect(takePendingCodeSession("/p/b")).toBeNull();
    expect(takePendingCodeSession("/p/a")).toBeNull();
  });
});

describe("pending new session", () => {
  it("marks exactly the checkout that should start fresh", () => {
    setPendingCodeNewSession("/p/a");
    expect(takePendingCodeNewSession("/p/a")).toBe(true);
    expect(takePendingCodeNewSession("/p/a")).toBe(false);
  });

  it("a marker for another checkout is dropped", () => {
    setPendingCodeNewSession("/p/a");
    expect(takePendingCodeNewSession("/p/b")).toBe(false);
    expect(takePendingCodeNewSession("/p/a")).toBe(false);
  });
});

describe("session record changes", () => {
  it("announces the project whose records changed, and stops when unsubscribed", () => {
    const seen: string[] = [];
    const off = onSessionsChanged((workdir) => seen.push(workdir));
    notifySessionsChanged("/p/a");
    off();
    notifySessionsChanged("/p/b");
    expect(seen).toEqual(["/p/a"]);
  });
});

describe("remote attach requests", () => {
  it("lands once in the checkout it was recorded for", () => {
    setPendingRemoteAttach("/p/a", "t1");
    expect(takePendingRemoteAttach("/p/a")).toBe("t1");
    expect(takePendingRemoteAttach("/p/a")).toBeNull();
  });

  it("a pick for another checkout is dropped", () => {
    setPendingRemoteAttach("/p/a", "t1");
    expect(takePendingRemoteAttach("/p/b")).toBeNull();
    expect(takePendingRemoteAttach("/p/a")).toBeNull();
  });

  it("notifies the mounted panel and stops after unsubscribe", () => {
    const seen: string[] = [];
    const off = onRemoteAttachRequest((id) => seen.push(id));
    requestRemoteAttach("t1");
    off();
    requestRemoteAttach("t2");
    expect(seen).toEqual(["t1"]);
  });
});

import { describe, expect, it } from "vitest";
import {
  setPendingCodeNewSession,
  setPendingCodeSession,
  takePendingCodeNewSession,
  takePendingCodeSession,
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

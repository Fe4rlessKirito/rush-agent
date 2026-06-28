import { beforeEach, describe, expect, it, vi } from "vitest";
import { useNotificationStore } from "./notificationStore";

describe("notification store", () => {
  beforeEach(() => {
    vi.useRealTimers();
    useNotificationStore.getState().clear();
  });

  it("adds reusable app notifications with defaults", () => {
    const id = useNotificationStore.getState().notify({
      title: "Deep Research started",
      message: "The run is saved to Library.",
    });

    const notification = useNotificationStore.getState().notifications[0];
    expect(notification.id).toBe(id);
    expect(notification.title).toBe("Deep Research started");
    expect(notification.message).toBe("The run is saved to Library.");
    expect(notification.tone).toBe("info");
    expect(notification.durationMs).toBe(4200);
  });

  it("dismisses notifications by id", () => {
    const keep = useNotificationStore.getState().notify({ title: "Keep" });
    const remove = useNotificationStore.getState().notify({ title: "Remove" });

    useNotificationStore.getState().dismiss(remove);

    expect(useNotificationStore.getState().notifications.map((item) => item.id)).toEqual([keep]);
  });

  it("keeps the newest five notifications", () => {
    for (let i = 0; i < 7; i += 1) {
      useNotificationStore.getState().notify({ title: `Toast ${i}` });
    }

    expect(useNotificationStore.getState().notifications.map((item) => item.title)).toEqual([
      "Toast 6",
      "Toast 5",
      "Toast 4",
      "Toast 3",
      "Toast 2",
    ]);
  });
});

import { create } from "zustand";

export type NotificationTone = "info" | "success" | "warning" | "error";

export interface AppNotification {
  id: string;
  title: string;
  message?: string;
  tone: NotificationTone;
  createdAt: number;
  durationMs: number;
}

interface NotifyInput {
  title: string;
  message?: string;
  tone?: NotificationTone;
  durationMs?: number;
}

interface NotificationState {
  notifications: AppNotification[];
  notify: (input: NotifyInput) => string;
  dismiss: (id: string) => void;
  clear: () => void;
}

function newId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export const useNotificationStore = create<NotificationState>()((set) => ({
  notifications: [],
  notify: (input) => {
    const id = newId();
    const notification: AppNotification = {
      id,
      title: input.title,
      message: input.message,
      tone: input.tone ?? "info",
      durationMs: input.durationMs ?? 4200,
      createdAt: Date.now(),
    };
    set((state) => ({
      notifications: [notification, ...state.notifications].slice(0, 5),
    }));
    return id;
  },
  dismiss: (id) =>
    set((state) => ({
      notifications: state.notifications.filter((notification) => notification.id !== id),
    })),
  clear: () => set({ notifications: [] }),
}));

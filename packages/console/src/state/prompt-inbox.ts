/** "Edit and resend as fetch": hands a snippet to the Console prompt. */
import { create } from 'zustand';

interface PromptInbox {
  text: string | null;
  set(text: string): void;
  take(): string | null;
}

export const usePromptInbox = create<PromptInbox>((set, get) => ({
  text: null,
  set: (text) => set({ text }),
  take: () => {
    const t = get().text;
    if (t !== null) set({ text: null });
    return t;
  },
}));

// The context waiting to go with a chat's next message (a project's notes, included chats, mentions),
// kept the same way for a Claude chat and a Codex chat (see ClaudeSession.addContext, CodexSession.addContext).
import type { ContextPart } from './projects';

/** Context given at one time, and what runs once it has gone (with the chat's session id and the keys that went). */
export interface ContextEntry {
  parts: ContextPart[];
  delivered: (sessionId: string | null, keys: string[]) => void;
}

export class PendingContext {
  private entries: ContextEntry[] = [];

  /** Adds `parts` to go with the next message; several added before then go together. */
  add(parts: ContextPart[], delivered: ContextEntry['delivered']): void {
    if (parts.length > 0) this.entries.push({ parts, delivered });
  }

  /** The keys of what is waiting to go: not to be given again meanwhile. */
  keys(): Set<string> {
    return new Set(this.entries.flatMap((each) => each.parts.map((part) => part.key)));
  }

  /** Takes back what is waiting whose key `unwanted` names. */
  withdraw(unwanted: (key: string) => boolean): void {
    for (const each of this.entries) each.parts = each.parts.filter((part) => !unwanted(part.key));
  }

  /** Everything waiting, taken out to go now. */
  take(): ContextEntry[] {
    return this.entries.splice(0);
  }
}

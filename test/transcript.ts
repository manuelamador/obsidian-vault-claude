// Messages as a chat's transcript holds them, for the tests.
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';

export const message = (type: 'user' | 'assistant', content: unknown, uuid = ''): SessionMessage =>
  ({ type, uuid, session_id: 's', parent_tool_use_id: null, parent_agent_id: null, message: { role: type, content } }) as SessionMessage;
/** A prompt of yours, its uuid its text. */
export const prompt = (text: string) => message('user', text, text);
export const answer = (text: string) => message('assistant', [{ type: 'text', text }]);
export const call = (id: string) => message('assistant', [{ type: 'tool_use', id, name: 'Read', input: {} }]);
export const result = (id: string) => message('user', [{ type: 'tool_result', tool_use_id: id, content: 'x' }]);

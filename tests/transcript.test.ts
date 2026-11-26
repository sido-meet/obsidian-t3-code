import { expect, it } from 'vitest';
import { Transcript } from '../src/t3/transcript';

it('replaces streamed text by message ID and finishes only the matching run', () => {
  const transcript = new Transcript();
  transcript.receive({ kind: 'snapshot', projection: { messages: [], runs: [] } });
  const event = (type: string, payload: unknown) => transcript.receive({ kind: 'event', event: { type, payload } });
  event('run.created', { id: 'r', userMessageId: 'q', status: 'running' });
  event('turn-item.updated', { type: 'assistant_message', messageId: 'a', text: 'Hel', runId: 'r' });
  event('turn-item.updated', { type: 'assistant_message', messageId: 'a', text: 'Hello', runId: 'r' });
  event('run.updated', { id: 'old', userMessageId: 'previous', status: 'completed' });
  expect(transcript.messages).toEqual([{ id: 'a', role: 'assistant', text: 'Hello', streaming: true }]);
  expect(transcript.activeRun?.id).toBe('r');
  event('run.updated', { id: 'r', userMessageId: 'q', status: 'completed' });
  expect(transcript.activeRun).toBeUndefined();
  expect(transcript.messages[0]?.streaming).toBe(false);
});

it('replaces the transcript when a reconnect supplies a new snapshot', () => {
  const transcript = new Transcript();
  for (const text of ['Partial', 'Complete']) {
    transcript.receive({ kind: 'snapshot', projection: {
      messages: [{ id: 'a', role: 'assistant', text, streaming: false }], runs: [],
    } });
  }
  expect(transcript.messages).toEqual([{ id: 'a', role: 'assistant', text: 'Complete', streaming: false }]);
});

it('ignores unknown events and keeps the finalized copy of a message', () => {
  const transcript = new Transcript();
  const event = (type: string, payload: unknown) => transcript.receive({ kind: 'event', event: { type, payload } });
  transcript.receive(null);
  transcript.receive({ kind: 'synchronized' });
  transcript.receive({ kind: 'snapshot', projection: { messages: null, runs: null } });
  event('run.updated', { id: false });
  event('run.updated', { id: 'r', userMessageId: false });
  event('run.updated', { id: 'r', userMessageId: 'q' });
  event('message.updated', { role: 'assistant', text: 'Missing ID' });
  event('message.updated', { id: 'a', role: 'system', text: 'Ignored' });
  event('message.updated', { id: 'a', role: 'assistant', text: false });
  event('message.updated', { id: 'a', role: 'assistant', text: 'Final', streaming: false, runId: null });
  event('turn-item.updated', { type: 'terminal_command', messageId: 'tool' });
  event('turn-item.updated', { type: 'assistant_message', messageId: 'a', text: 'Late', runId: 'r' });
  expect(transcript.messages).toEqual([{ id: 'a', role: 'assistant', text: 'Final', streaming: false }]);
});

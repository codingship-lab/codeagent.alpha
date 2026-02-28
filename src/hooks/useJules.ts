import { useState, useCallback } from 'react';

export function useJules() {
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sendMessage = useCallback(async (messages: any[], onEvent: (event: any) => void) => {
    setIsStreaming(true);
    setError(null);

    try {
      const response = await fetch('/api/arena/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages }),
      });

      if (!response.ok) throw new Error('Failed to start stream');
      if (!response.body) throw new Error('No response body');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const packets = buffer.split('\n\n');
        buffer = packets.pop() || '';

        for (const packet of packets) {
          if (!packet.trim()) continue;
          const dataLine = packet.split('\n').find(line => line.startsWith('data: '));
          if (dataLine) {
            const payload = JSON.parse(dataLine.slice(6));
            onEvent(payload);
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsStreaming(false);
    }
  }, []);

  return { sendMessage, isStreaming, error };
}

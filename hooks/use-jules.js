'use client';

import { useCallback, useState } from 'react';
import { runtimeApiUrl } from '@/lib/runtime-api';

export function useJules(runtimeApiBaseUrl) {
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState(null);

  const sendMessage = useCallback(
    async (messages, onEvent) => {
      setIsStreaming(true);
      setError(null);

      try {
        if (!runtimeApiBaseUrl) {
          throw new Error('NEXT_PUBLIC_RUNTIME_API_BASE_URL is not configured.');
        }

        const response = await fetch(runtimeApiUrl('/api/arena/stream'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages })
        });

        if (!response.ok) {
          throw new Error('Failed to start stream');
        }

        if (!response.body) {
          throw new Error('No response body');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const packets = buffer.split('\n\n');
          buffer = packets.pop() || '';

          for (const packet of packets) {
            if (!packet.trim()) {
              continue;
            }

            const dataLine = packet.split('\n').find((line) => line.startsWith('data: '));
            if (!dataLine) {
              continue;
            }

            const payload = JSON.parse(dataLine.slice(6));
            onEvent(payload);
          }
        }
      } catch (streamError) {
        setError(streamError instanceof Error ? streamError.message : 'Unknown error');
      } finally {
        setIsStreaming(false);
      }
    },
    [runtimeApiBaseUrl]
  );

  return { sendMessage, isStreaming, error };
}

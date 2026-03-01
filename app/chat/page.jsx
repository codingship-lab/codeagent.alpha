import { Suspense } from 'react';
import { ChatPageWithSearchParams } from '@/components/pages/chat-page';

export default function Page() {
  return (
    <Suspense fallback={null}>
      <ChatPageWithSearchParams />
    </Suspense>
  );
}

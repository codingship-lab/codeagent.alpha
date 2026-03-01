'use client';

import { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AvatarButton } from '@/components/AvatarButton';
import { GitHubSyncButton } from '@/components/GitHubSyncButton';
import { FloatingComposer } from '@/components/FloatingComposer';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Maximize2, MessageSquare, Eye } from 'lucide-react';

export function ChatPage({ initialPrompt = '' }) {
  const router = useRouter();
  const [messages, setMessages] = useState([]);
  const [activeTab, setActiveTab] = useState('chat');
  const [syncStatus, setSyncStatus] = useState('idle');

  useEffect(() => {
    if (initialPrompt) {
      setMessages([{ role: 'user', content: initialPrompt }]);
    }
  }, [initialPrompt]);

  const handleSync = () => {
    setSyncStatus('syncing');
    setTimeout(() => setSyncStatus('success'), 2000);
    setTimeout(() => setSyncStatus('idle'), 4000);
  };

  return (
    <div className="h-screen bg-background flex flex-col overflow-hidden font-sans">
      <header className="flex items-center justify-between px-8 py-4 border-b border-border/50 bg-background/80 backdrop-blur-xl z-10">
        <div className="flex items-center gap-3 cursor-pointer" onClick={() => router.push('/')}>
          <div className="size-9 bg-primary rounded-full flex items-center justify-center">
            <span className="text-white font-black text-lg">C</span>
          </div>
          <span className="text-xl font-black tracking-tighter hidden sm:inline text-foreground uppercase italic">
            CodeAgent
          </span>
        </div>

        <div className="flex items-center gap-4">
          <GitHubSyncButton status={syncStatus} onClick={handleSync} />
          <AvatarButton />
        </div>
      </header>

      <main className="flex-1 flex flex-col min-h-0 relative">
        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col min-h-0">
          <div className="flex items-center justify-between px-8 py-3">
            <TabsList className="bg-secondary border border-border h-11 p-1 rounded-full px-1">
              <TabsTrigger
                value="chat"
                className="gap-2 rounded-full px-8 data-[state=active]:bg-primary data-[state=active]:text-white font-bold uppercase text-xs tracking-widest transition-all"
              >
                <MessageSquare className="h-4 w-4" />
                Chat
              </TabsTrigger>
              <TabsTrigger
                value="preview"
                className="gap-2 rounded-full px-8 data-[state=active]:bg-primary data-[state=active]:text-white font-bold uppercase text-xs tracking-widest transition-all"
              >
                <Eye className="h-4 w-4" />
                Preview
              </TabsTrigger>
            </TabsList>

            <Button
              variant="ghost"
              size="icon"
              className="h-10 w-10 rounded-full text-muted-foreground hover:text-foreground hover:bg-muted/50"
            >
              <Maximize2 className="h-5 w-5" />
            </Button>
          </div>

          <TabsContent value="chat" className="flex-1 overflow-y-auto p-8 space-y-8 scrollbar-hide m-0">
            <div className="max-w-3xl mx-auto space-y-8 pb-32">
              {messages.map((msg, i) => (
                <div key={i} className={cn('flex flex-col', msg.role === 'user' ? 'items-end' : 'items-start')}>
                  <div
                    className={cn(
                      'max-w-[85%] rounded-[30px] px-6 py-4 text-[15px] leading-relaxed',
                      msg.role === 'user'
                        ? 'bg-primary text-white font-medium'
                        : 'bg-secondary border border-border text-foreground'
                    )}
                  >
                    {msg.content}
                  </div>
                </div>
              ))}
            </div>
          </TabsContent>

          <TabsContent
            value="preview"
            className="flex-1 bg-white m-0 rounded-[40px] overflow-hidden shadow-2xl mx-6 mb-6 border-4 border-secondary"
          >
            <div className="h-full w-full flex items-center justify-center text-slate-400">
              <iframe className="w-full h-full border-none" title="Preview" />
            </div>
          </TabsContent>
        </Tabs>

        {activeTab === 'chat' && (
          <div className="absolute bottom-0 left-0 right-0 p-6 bg-gradient-to-t from-background via-background/80 to-transparent">
            <FloatingComposer onSubmit={(text) => setMessages((prev) => [...prev, { role: 'user', content: text }])} />
          </div>
        )}
      </main>
    </div>
  );
}

function cn(...inputs) {
  return inputs.filter(Boolean).join(' ');
}

export function ChatPageWithSearchParams() {
  const searchParams = useSearchParams();
  const initialPrompt = searchParams.get('prompt') || '';

  return <ChatPage initialPrompt={initialPrompt} />;
}

import { useState } from "react"
import { Textarea } from "@/components/ui/textarea"
import { Button } from "@/components/ui/button"
import { Plus, Send } from "lucide-react"

interface FloatingComposerProps {
  onSubmit: (text: string) => void
}

export function FloatingComposer({ onSubmit }: FloatingComposerProps) {
  const [prompt, setPrompt] = useState("")

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (prompt.trim()) {
      onSubmit(prompt)
      setPrompt("")
    }
  }

  return (
    <div className="sticky bottom-6 w-full max-w-3xl mx-auto px-4">
      <div className="bg-[#1A1A1A]/95 backdrop-blur-3xl border border-white/5 rounded-3xl p-2 shadow-2xl flex items-end gap-1">
        <form onSubmit={handleSubmit} className="flex-1 flex items-end gap-1">
           <Button variant="ghost" size="icon" className="h-10 w-10 rounded-full text-muted-foreground hover:text-foreground shrink-0 bg-white/5">
              <Plus className="h-5 w-5" />
            </Button>
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Reply to CodeAgent..."
              className="flex-1 bg-transparent border-none focus-visible:ring-0 text-foreground placeholder:text-muted-foreground/40 min-h-[44px] max-h-[200px] py-3 px-4 resize-none text-[14px]"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit(e);
                }
              }}
            />
            <Button
              type="submit"
              size="icon"
              className="h-10 w-10 rounded-2xl bg-primary text-white hover:scale-105 transition-all shrink-0 shadow-[0_4px_15px_rgba(0,85,255,0.3)]"
              disabled={!prompt.trim()}
            >
              <Send className="h-4 w-4" />
            </Button>
        </form>
      </div>
    </div>
  )
}

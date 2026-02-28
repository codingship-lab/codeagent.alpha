import { useState } from "react"
import { Textarea } from "@/components/ui/textarea"
import { Button } from "@/components/ui/button"
import { Plus, Send, ChevronDown } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

interface MainComposerProps {
  onSubmit: (text: string) => void
  placeholder?: string
}

export function MainComposer({ onSubmit, placeholder = "Let's build an enterprise solution that..." }: MainComposerProps) {
  const [prompt, setPrompt] = useState("")

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (prompt.trim()) {
      onSubmit(prompt)
      setPrompt("")
    }
  }

  return (
    <div className="w-full max-w-3xl bg-[#1A1A1A] border border-white/5 rounded-3xl p-3 shadow-2xl transition-all">
      <form onSubmit={handleSubmit} className="flex flex-col space-y-3">
        <Textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={placeholder}
          className="w-full bg-transparent border-none focus-visible:ring-0 text-foreground placeholder:text-muted-foreground/50 text-[15px] resize-none min-h-[60px] max-h-[200px] px-4 py-2"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSubmit(e);
            }
          }}
        />
        <div className="flex items-center justify-between px-2 pb-1">
          <div className="flex items-center gap-4">
             <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full bg-white/5 text-muted-foreground hover:text-foreground">
                <Plus className="h-4 w-4" />
             </Button>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-8 px-0 rounded-full gap-2 hover:bg-transparent text-muted-foreground hover:text-foreground border-none">
                  <div className="size-4 rounded-full border border-white/20 flex items-center justify-center">
                    <div className="size-1 bg-white/60 rounded-full" />
                  </div>
                  <div className="flex flex-col -space-y-1">
                    <ChevronDown className="h-2.5 w-2.5 opacity-30" />
                  </div>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="bg-popover border-border rounded-xl">
                <DropdownMenuItem>Claude 3.5 Sonnet</DropdownMenuItem>
                <DropdownMenuItem>GPT-4o</DropdownMenuItem>
                <DropdownMenuItem>Kimi K2</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <div className="flex items-center gap-3">
            <Button
              type="submit"
              size="sm"
              className="h-10 px-5 rounded-full bg-primary text-white hover:scale-105 active:scale-95 transition-all font-bold text-[13px] gap-2 shadow-[0_4px_15px_rgba(0,85,255,0.4)]"
              disabled={!prompt.trim()}
            >
              <span>Build now</span>
              <Send className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </form>
    </div>
  )
}

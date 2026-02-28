import { MainComposer } from "@/components/MainComposer"
import { AvatarButton } from "@/components/AvatarButton"
import { useNavigate } from "react-router-dom"

export function Home() {
  const navigate = useNavigate()

  const handlePromptSubmit = (prompt: string) => {
    navigate("/chat", { state: { initialPrompt: prompt } })
  }

  return (
    <div className="min-h-screen bg-background flex flex-col font-sans overflow-hidden">
      <header className="flex items-center justify-between px-8 py-6">
        <div className="flex items-center gap-3">
           <div className="size-10 bg-primary rounded-full flex items-center justify-center shadow-[0_0_20px_rgba(0,85,255,0.4)]">
             <span className="text-white font-black text-xl">C</span>
           </div>
           <span className="text-xl font-bold tracking-tighter text-foreground uppercase italic">CodeAgent</span>
        </div>
        <AvatarButton />
      </header>

      <main className="flex-1 flex flex-col items-center justify-center px-6 pb-32">
        <div className="text-center mb-10 space-y-3">
          <h1 className="text-3xl md:text-5xl font-black tracking-tighter text-foreground whitespace-nowrap scale-y-110 origin-center uppercase italic opacity-90">
            what are your plans for <span className="text-gradient">today?</span>
          </h1>
          <p className="text-muted-foreground text-sm md:text-base font-medium tracking-tight opacity-70">
            Build apps by communicating with AI
          </p>
        </div>

        <MainComposer onSubmit={handlePromptSubmit} />

        <div className="flex flex-wrap justify-center gap-3 mt-16">
          {["Refactor Python script", "Explain Redux toolkit", "Debug API route"].map((suggestion) => (
            <button
              key={suggestion}
              className="px-6 py-2 rounded-full border border-border text-[10px] font-black text-muted-foreground hover:border-primary hover:text-primary transition-all uppercase tracking-[0.2em] bg-secondary/20"
              onClick={() => handlePromptSubmit(suggestion)}
            >
              {suggestion}
            </button>
          ))}
        </div>
      </main>
    </div>
  )
}

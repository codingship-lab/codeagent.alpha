import { Button } from "@/components/ui/button"
import { Github, RefreshCw, Check, AlertCircle } from "lucide-react"
import { cn } from "@/lib/utils"

type SyncStatus = 'idle' | 'syncing' | 'success' | 'error'

interface GitHubSyncButtonProps {
  status: SyncStatus
  onClick: () => void
}

export function GitHubSyncButton({ status, onClick }: GitHubSyncButtonProps) {
  return (
    <Button
      variant="outline"
      size="sm"
      className={cn(
        "h-9 gap-2 border-border bg-card",
        status === 'success' && "border-green-500/50 text-green-500",
        status === 'error' && "border-red-500/50 text-red-500"
      )}
      onClick={onClick}
      disabled={status === 'syncing'}
    >
      {status === 'idle' && <Github className="h-4 w-4" />}
      {status === 'syncing' && <RefreshCw className="h-4 w-4 animate-spin" />}
      {status === 'success' && <Check className="h-4 w-4" />}
      {status === 'error' && <AlertCircle className="h-4 w-4" />}
      <span className="hidden sm:inline">Sync GitHub</span>
    </Button>
  )
}

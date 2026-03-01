'use client';

import { User, Settings, FileText, CreditCard, Moon, Globe } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';

export function AvatarButton() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="relative h-12 w-12 rounded-full p-0 overflow-hidden hover:bg-muted/50 transition-colors"
        >
          <Avatar className="h-10 w-10">
            <AvatarImage src="https://github.com/shadcn.png" alt="@shadcn" />
            <AvatarFallback>JD</AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent className="w-64 bg-popover border-border rounded-[24px] p-2 mt-2" align="end" forceMount>
        <DropdownMenuLabel className="font-normal px-4 py-3">
          <div className="flex flex-col space-y-1">
            <p className="text-sm font-semibold leading-none">jules</p>
            <p className="text-xs leading-none text-muted-foreground">jules@example.com</p>
          </div>
        </DropdownMenuLabel>

        <DropdownMenuSeparator className="mx-2" />
        <DropdownMenuGroup className="p-1">
          <DropdownMenuItem className="rounded-lg px-3 py-2">
            <User className="mr-3 h-5 w-5 opacity-70" />
            <span className="font-medium">Profile</span>
          </DropdownMenuItem>
          <DropdownMenuItem className="rounded-lg px-3 py-2">
            <Settings className="mr-3 h-5 w-5 opacity-70" />
            <span className="font-medium">Settings</span>
          </DropdownMenuItem>
        </DropdownMenuGroup>

        <DropdownMenuSeparator className="mx-2" />
        <DropdownMenuGroup className="p-1">
          <DropdownMenuItem className="rounded-lg px-3 py-2">
            <FileText className="mr-3 h-5 w-5 opacity-70" />
            <span className="font-medium">Documentation</span>
          </DropdownMenuItem>
          <DropdownMenuItem className="rounded-lg px-3 py-2">
            <CreditCard className="mr-3 h-5 w-5 opacity-70" />
            <span className="font-medium">Credits</span>
          </DropdownMenuItem>
        </DropdownMenuGroup>

        <DropdownMenuSeparator className="mx-2" />
        <DropdownMenuGroup className="p-1">
          <DropdownMenuItem className="rounded-lg px-3 py-2">
            <Moon className="mr-3 h-5 w-5 opacity-70" />
            <span className="font-medium">Theme</span>
            <div className="ml-auto flex gap-1">
              <span className="text-[10px] bg-secondary text-secondary-foreground px-2 py-0.5 rounded-full">Dark</span>
            </div>
          </DropdownMenuItem>
          <DropdownMenuItem className="rounded-lg px-3 py-2">
            <Globe className="mr-3 h-5 w-5 opacity-70" />
            <span className="font-medium">Language</span>
            <div className="ml-auto flex gap-1">
              <span className="text-[10px] bg-secondary text-secondary-foreground px-2 py-0.5 rounded-full">EN</span>
            </div>
          </DropdownMenuItem>
        </DropdownMenuGroup>

        <DropdownMenuSeparator className="mx-2" />
        <DropdownMenuItem className="rounded-lg px-3 py-2 text-destructive focus:bg-destructive/10 focus:text-destructive">
          Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

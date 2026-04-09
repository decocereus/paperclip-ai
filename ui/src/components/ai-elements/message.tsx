"use client";

import type { ComponentProps, HTMLAttributes } from "react";
import { memo } from "react";
import { Streamdown } from "streamdown";
import { cn } from "@/lib/utils";

export type MessageRole = "user" | "assistant" | "system" | "tool";

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: MessageRole;
};

export function Message({ className, from, ...props }: MessageProps) {
  return (
    <div
      className={cn(
        "group flex w-full max-w-[98%] flex-col gap-1.5",
        from === "user" ? "is-user ml-auto items-end justify-end" : "is-assistant items-start",
        className,
      )}
      {...props}
    />
  );
}

export type MessageContentProps = HTMLAttributes<HTMLDivElement> & {
  tone?: "default" | "muted";
};

export function MessageContent({
  children,
  className,
  tone = "default",
  ...props
}: MessageContentProps) {
  return (
    <div
      className={cn(
        "flex min-w-0 max-w-full flex-col gap-2 overflow-hidden text-sm",
        "group-[.is-user]:max-w-[90%] group-[.is-user]:rounded-2xl group-[.is-user]:bg-primary/12 group-[.is-user]:px-3.5 group-[.is-user]:py-2.5 group-[.is-user]:text-foreground",
        "group-[.is-assistant]:w-full",
        tone === "muted" && "rounded-xl border border-border/70 bg-muted/20 px-3 py-2.5 text-muted-foreground",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export type MessageResponseProps = ComponentProps<typeof Streamdown>;

export const MessageResponse = memo(function MessageResponse({
  className,
  ...props
}: MessageResponseProps) {
  return (
    <Streamdown
      className={cn(
        "prose prose-neutral dark:prose-invert max-w-none break-words text-sm",
        "prose-pre:overflow-x-auto prose-pre:rounded-xl prose-pre:border prose-pre:border-border/70 prose-pre:bg-background/80",
        "prose-code:text-[0.9em] prose-li:my-1 prose-p:leading-6 prose-headings:tracking-tight",
        className,
      )}
      {...props}
    />
  );
});

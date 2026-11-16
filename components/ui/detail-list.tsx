import * as React from "react"

import { cn } from "@/lib/utils"

/** Review rows: label on the left, value on the right. */
function DetailList({ className, ...props }: React.ComponentProps<"dl">) {
  return (
    <dl
      data-slot="detail-list"
      className={cn("flex flex-col gap-3 text-sm", className)}
      {...props}
    />
  )
}

/**
 * A long value (address, txid) that does not fit beside its label wraps
 * onto its own line under it. `stack` always puts it there. Values are mono
 * (amounts, addresses, txids); pass mono={false} for words.
 */
function DetailRow({
  label,
  children,
  mono = true,
  stack = false,
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "children"> & {
  label: React.ReactNode
  children: React.ReactNode
  mono?: boolean
  stack?: boolean
}) {
  return (
    <div
      data-slot="detail-row"
      className={cn(
        stack
          ? "flex flex-col gap-1"
          : "flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1",
        className
      )}
      {...props}
    >
      <dt className="text-muted-foreground shrink-0">{label}</dt>
      <dd
        className={cn(
          "max-w-full min-w-0 wrap-anywhere",
          !stack && "ml-auto text-right",
          mono && "font-mono"
        )}
      >
        {children}
      </dd>
    </div>
  )
}

export { DetailList, DetailRow }

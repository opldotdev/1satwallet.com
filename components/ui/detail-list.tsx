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
 * A value sits at the right of its label. A long one (address, txid) that
 * does not fit beside it wraps onto its own line under the label,
 * left-aligned. `stack` always puts it there. Values are mono (amounts,
 * addresses, txids); pass mono={false} for words.
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
      {/* justify-between puts the value at the right while it shares the
          label's line, and at the start of its own line once it wraps. */}
      <dd
        className={cn("max-w-full min-w-0 wrap-anywhere", mono && "font-mono")}
      >
        {children}
      </dd>
    </div>
  )
}

export { DetailList, DetailRow }

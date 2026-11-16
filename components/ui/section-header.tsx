import * as React from "react"

import { cn } from "@/lib/utils"

function SectionHeader({
  title,
  description,
  action,
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "title"> & {
  title: React.ReactNode
  description?: React.ReactNode
  /** Trailing control, such as the section's one primary action. */
  action?: React.ReactNode
}) {
  return (
    <div
      data-slot="section-header"
      className={cn("flex items-center justify-between gap-4", className)}
      {...props}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <h2 className="text-lg leading-tight font-semibold tracking-tight">
          {title}
        </h2>
        {description && (
          <p className="text-muted-foreground text-sm">{description}</p>
        )}
      </div>
      {action && (
        <div
          data-slot="section-header-action"
          className="flex shrink-0 items-center gap-2"
        >
          {action}
        </div>
      )}
    </div>
  )
}

export { SectionHeader }

import * as React from "react"

import { cn } from "@/lib/utils"

function SectionHeader({
  title,
  description,
  action,
  as: Heading = "h2",
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "title"> & {
  title: React.ReactNode
  description?: React.ReactNode
  /** Trailing control, such as the section's one primary action. */
  action?: React.ReactNode
  /** Heading level: h2 for a page section, h3 for a section inside one. */
  as?: "h2" | "h3"
}) {
  return (
    <div
      data-slot="section-header"
      className={cn("flex items-center justify-between gap-4", className)}
      {...props}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <Heading className="text-lg leading-tight font-semibold tracking-tight">
          {title}
        </Heading>
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

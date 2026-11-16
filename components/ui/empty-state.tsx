import type { LucideIcon } from "lucide-react"
import * as React from "react"

import { cn } from "@/lib/utils"

/** Nothing to show yet. Loading is a Skeleton, never this. */
function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "title"> & {
  icon?: LucideIcon
  title: React.ReactNode
  description?: React.ReactNode
  action?: React.ReactNode
}) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        "flex flex-col items-center gap-3 px-4 py-12 text-center",
        className
      )}
      {...props}
    >
      {Icon && (
        <div className="bg-muted text-muted-foreground flex size-12 items-center justify-center rounded-full">
          <Icon aria-hidden="true" className="size-6" />
        </div>
      )}
      <div className="flex max-w-sm flex-col gap-1">
        <p className="text-base font-medium">{title}</p>
        {description && (
          <p className="text-muted-foreground text-sm">{description}</p>
        )}
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  )
}

export { EmptyState }

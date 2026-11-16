import { cva, type VariantProps } from "class-variance-authority"
import { CircleAlert, Info, TriangleAlert } from "lucide-react"
import * as React from "react"

import { cn } from "@/lib/utils"

const noticeVariants = cva(
  "flex items-start gap-3 rounded-lg border p-3 text-sm [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0",
  {
    variants: {
      tone: {
        info: "bg-muted/50 [&>svg]:text-muted-foreground",
        warning: "border-warning/30 bg-warning/10 [&>svg]:text-warning",
        danger:
          "border-destructive/30 bg-destructive/10 [&>svg]:text-destructive",
      },
    },
    defaultVariants: {
      tone: "info",
    },
  }
)

const ICONS = {
  info: Info,
  warning: TriangleAlert,
  danger: CircleAlert,
} as const

/** An inline banner: a short message with a tone icon on the left. */
function Notice({
  tone,
  title,
  children,
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "title"> &
  VariantProps<typeof noticeVariants> & {
    title?: React.ReactNode
  }) {
  const Icon = ICONS[tone ?? "info"]
  return (
    <div
      data-slot="notice"
      data-tone={tone ?? "info"}
      role={tone === "danger" ? "alert" : undefined}
      className={cn(noticeVariants({ tone }), className)}
      {...props}
    >
      <Icon aria-hidden="true" />
      <div className="flex min-w-0 flex-col gap-1">
        {title && <p className="font-medium">{title}</p>}
        {children && (
          <div className={cn(title && "text-muted-foreground")}>{children}</div>
        )}
      </div>
    </div>
  )
}

export { Notice, noticeVariants }

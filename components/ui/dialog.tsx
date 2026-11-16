"use client"

import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { XIcon } from "lucide-react"

import { cn } from "@/lib/utils"

function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/50",
        className
      )}
      {...props}
    />
  )
}

/**
 * The surface shared by Dialog and AlertDialog. From sm: a centered dialog
 * that scrolls inside once it is taller than the viewport. Under sm: a bottom
 * sheet, full width, that slides up and clears the home indicator.
 *
 * Padding comes from --dialog-spacing (16px on phones, 24px from sm). To
 * change it, override the variable, not p-*: e.g.
 * `[--dialog-spacing:--spacing(6)] sm:[--dialog-spacing:--spacing(8)]`, or
 * `[--dialog-spacing:0px]` for an edge-to-edge layout. A p-* class would drop
 * the home-indicator padding and misplace the close control.
 */
const dialogSurfaceClassName = cn(
  "bg-background data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed top-[50%] left-[50%] z-50 w-full max-w-[calc(100%-2rem)] max-h-[calc(100dvh-4rem)] translate-x-[-50%] translate-y-[-50%] overflow-y-auto overscroll-contain rounded-xl border shadow-lg duration-200 sm:max-w-lg",
  "max-sm:top-auto max-sm:right-0 max-sm:bottom-0 max-sm:left-0 max-sm:w-full max-sm:max-w-none max-sm:max-h-[calc(100dvh-3rem)] max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-b-none max-sm:border-b-0 max-sm:data-[state=open]:zoom-in-100 max-sm:data-[state=closed]:zoom-out-100 max-sm:data-[state=open]:slide-in-from-bottom max-sm:data-[state=closed]:slide-out-to-bottom",
  "[--dialog-spacing-default:--spacing(4)] sm:[--dialog-spacing-default:--spacing(6)] [--dialog-spacing:var(--dialog-spacing-default)] p-(--dialog-spacing) pb-[max(var(--dialog-spacing),env(safe-area-inset-bottom))]"
)

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean
}) {
  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          dialogSurfaceClassName,
          // One column, like a grid: children keep their height and the
          // dialog scrolls. Flex rather than grid so the close control can
          // stay pinned for the whole scroll (a sticky grid item only sticks
          // within its own row). The gap comes from --dialog-gap; override
          // the variable, not gap-*, so the close control takes no space.
          "flex flex-col *:shrink-0 [--dialog-gap:--spacing(4)] gap-(--dialog-gap)",
          // DialogHeader keeps its text clear of the 44px close control (and
          // centered on phones). Reserved even while a caller hides the
          // control, so a title does not reflow when it comes back.
          "[--dialog-header-pr:max(0px,calc(3rem-var(--dialog-spacing)))] max-sm:[--dialog-header-pl:var(--dialog-header-pr)]",
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          // Last in the DOM so focus order and Radix's initial focus are
          // unchanged; shown first and sticky so the close control stays in
          // reach on a long, scrolled sheet. It spans the padding box and
          // takes no height, so the layout is the same as an absolute close.
          <div
            data-slot="dialog-close-anchor"
            className="sticky top-0 z-10 order-first -mx-(--dialog-spacing) -mt-(--dialog-spacing) mb-[calc(var(--dialog-spacing)-var(--dialog-gap))] h-0"
          >
            <DialogPrimitive.Close
              data-slot="dialog-close"
              className="ring-offset-background focus-visible:ring-ring absolute top-1 right-1 flex size-11 items-center justify-center rounded-md opacity-70 transition-opacity hover:opacity-100 focus-visible:ring-2 focus-visible:outline-hidden disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
            >
              <XIcon />
              <span className="sr-only">Close</span>
            </DialogPrimitive.Close>
          </div>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn(
        "flex flex-col gap-2 pr-[var(--dialog-header-pr,0px)] pl-[var(--dialog-header-pl,0px)] text-center sm:text-left",
        className
      )}
      {...props}
    />
  )
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 max-sm:*:w-full sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    />
  )
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-lg leading-none font-semibold", className)}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
  dialogSurfaceClassName,
}

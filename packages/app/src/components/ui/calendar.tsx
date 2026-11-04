import { ChevronLeft, ChevronRight } from "lucide-react"
import type { ComponentProps } from "react"
import { DayPicker } from "react-day-picker"
import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export type CalendarProps = ComponentProps<typeof DayPicker>

/** Module-level so DayPicker gets a stable component identity across renders. */
function CalendarChevron({
  className,
  orientation,
}: {
  className?: string
  orientation?: "up" | "down" | "left" | "right"
}) {
  const Icon = orientation === "left" ? ChevronLeft : ChevronRight
  return <Icon className={cn("size-4", className)} />
}

/**
 * shadcn-style calendar (react-day-picker v10), restyled with the app's tokens.
 *
 * Ported from the v8 markup, so two structural differences matter:
 * - The nav is no longer inside the caption: it's a sibling of the months,
 *   overlaid on the caption row (`months` is the positioning context).
 * - Modifier classes (`selected`, `today`, `outside`, `disabled`) land on the
 *   cell, not the button — and so does `aria-selected`. Button styling is
 *   therefore reached through `[&>button]`.
 */
function Calendar({ className, classNames, showOutsideDays = true, ...props }: CalendarProps) {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn("p-3", className)}
      classNames={{
        months: "relative flex flex-col gap-2 sm:flex-row",
        month: "flex flex-col gap-4",
        month_caption: "flex items-center justify-center pt-1",
        caption_label: "text-sm font-medium",
        nav: "absolute inset-x-1 top-0 z-10 flex items-center justify-between",
        button_previous: cn(
          buttonVariants({ variant: "outline" }),
          "size-7 bg-transparent p-0 opacity-50 hover:opacity-100 aria-disabled:pointer-events-none",
        ),
        button_next: cn(
          buttonVariants({ variant: "outline" }),
          "size-7 bg-transparent p-0 opacity-50 hover:opacity-100 aria-disabled:pointer-events-none",
        ),
        month_grid: "w-full border-collapse space-x-1",
        weekdays: "flex",
        weekday: "w-8 rounded-md text-[0.8rem] font-normal text-muted-foreground",
        week: "mt-2 flex w-full",
        day: "relative p-0 text-center text-sm focus-within:relative focus-within:z-20 aria-selected:bg-accent first:aria-selected:rounded-l-md last:aria-selected:rounded-r-md",
        day_button: cn(buttonVariants({ variant: "ghost" }), "size-8 p-0 font-normal"),
        selected:
          "[&>button]:bg-primary [&>button]:text-primary-foreground [&>button]:hover:bg-primary [&>button]:hover:text-primary-foreground [&>button]:focus:bg-primary [&>button]:focus:text-primary-foreground",
        today: "[&>button]:bg-accent [&>button]:text-accent-foreground",
        outside: "[&>button]:text-muted-foreground aria-selected:[&>button]:text-muted-foreground",
        disabled: "[&>button]:text-muted-foreground [&>button]:opacity-50",
        hidden: "invisible",
        ...classNames,
      }}
      components={{ Chevron: CalendarChevron }}
      {...props}
    />
  )
}

export { Calendar }

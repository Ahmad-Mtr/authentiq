import { cn } from "@workspace/ui/lib/utils"

/**
 * The Authentiq mark: a geometric lowercase "a" on the primary colour. The
 * glyph is dark, not the primary-foreground white, so it stays legible on
 * a light primary. public/favicon.svg is the same drawing with fixed colours.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      aria-hidden="true"
      className={cn("size-8 shrink-0", className)}
    >
      <rect width="32" height="32" rx="9" className="fill-primary" />
      <circle
        cx="14.5"
        cy="17.5"
        r="5.75"
        fill="none"
        strokeWidth="3.25"
        className="stroke-[oklch(0.2_0.03_160)]"
      />
      <path
        d="M21.875 10.5v13"
        fill="none"
        strokeWidth="3.25"
        strokeLinecap="round"
        className="stroke-[oklch(0.2_0.03_160)]"
      />
    </svg>
  )
}

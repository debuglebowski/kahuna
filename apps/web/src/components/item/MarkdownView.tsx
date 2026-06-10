import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

/**
 * Renders a markdown note body. `react-markdown` escapes raw HTML by default
 * (no `dangerouslySetInnerHTML`), so this is XSS-safe. Styled with a compact
 * prose-ish ruleset using the design tokens (no `@tailwindcss/typography` dep).
 */
export function MarkdownView({ children }: { children: string }) {
  return (
    <div className="space-y-2 text-sm text-foreground [&_a]:text-primary [&_a]:underline [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[0.85em] [&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_li]:ml-4 [&_ol]:list-decimal [&_ul]:list-disc">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  )
}

import { QueryClientProvider } from "@tanstack/react-query"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { createBrowserRouter, RouterProvider } from "react-router-dom"
import { TooltipProvider } from "@/components/ui/tooltip"
import { App } from "./App"
import "./index.css"
import { APP_TITLE } from "./lib/appEnv"
import { queryClient } from "./lib/queryClient"
import "./lib/theme"

const root = document.getElementById("root")
if (!root) throw new Error("root element missing")

// Qualifies the tab with "(dev)" off the dev server, so a stack of tabs across
// environments is distinguishable. index.html's static title is the pre-boot value.
document.title = APP_TITLE

// A data router (vs the declarative <BrowserRouter>) so `useBlocker` works —
// the full-page settings editors use it to guard unsaved edits. App's internal
// <Routes> keep working as descendant routes under this single catch-all.
const router = createBrowserRouter([{ path: "*", element: <App /> }])

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
)

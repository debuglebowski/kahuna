import { lazy, Suspense, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

// Heavy canvas/WebGL code loads on demand — the lazy fallback is a black
// overlay, indistinguishable from the intros' opening frame.
const CoronationIntro = lazy(() =>
  import("@/components/intro/CoronationIntro").then((m) => ({ default: m.CoronationIntro })),
)
const GenesisIntro = lazy(() =>
  import("@/components/intro/GenesisIntro").then((m) => ({ default: m.GenesisIntro })),
)
const MonolithIntro = lazy(() =>
  import("@/components/intro/MonolithIntro").then((m) => ({ default: m.MonolithIntro })),
)
const OdysseyIntro = lazy(() =>
  import("@/components/intro/OdysseyIntro").then((m) => ({ default: m.OdysseyIntro })),
)

type IntroKey = "coronation" | "genesis" | "monolith" | "odyssey"

const INTROS: { key: IntroKey; title: string; tagline: string; beats: string; tech: string }[] = [
  {
    key: "coronation",
    title: "Coronation",
    tagline: "Gold forge sting",
    beats:
      "Embers rise from black → a vortex forges a wireframe crown over three hammer beats → blaze → the wordmark cools from gold to white → curtain lift.",
    tech: "Canvas 2D particles",
  },
  {
    key: "genesis",
    title: "Genesis",
    tagline: "Your universe being born",
    beats:
      "Concept nodes ping into a void → relation edges draw with traveling light → the graph settles, pulses once → every node flies home into the UI.",
    tech: "d3-force + canvas",
  },
  {
    key: "monolith",
    title: "Monolith",
    tagline: "WebGL throne room",
    beats:
      "Volumetric beams sweep a dark hall → an obsidian slab turns, the etched wordmark legible only where light crosses → the beam locks, flares, whiteout reveal.",
    tech: "Raw WebGL shader",
  },
  {
    key: "odyssey",
    title: "Odyssey",
    tagline: "Space → Earth → a glowing screen",
    beats:
      "Starfield drift → lightspeed streaks → Earth approach on the night side → atmosphere dive over city lights → zoom into a lone glowing computer screen.",
    tech: "Canvas 2D, layered parallax",
  },
]

const CHAIN_OPTIONS: { key: IntroKey | null; label: string }[] = [
  { key: null, label: "Nothing" },
  { key: "coronation", label: "Coronation" },
  { key: "genesis", label: "Genesis" },
  { key: "monolith", label: "Monolith" },
]

/**
 * Dev playground for the app-intro concepts (`/intro-lab`, not linked from the
 * sidebar). Each intro is a self-contained full-screen overlay implementing
 * `IntroProps`; Odyssey can chain straight into a second intro, mimicking the
 * "land on a computer, then the real intro starts" idea.
 */
export function IntroLab() {
  const [playing, setPlaying] = useState<IntroKey | null>(null)
  const [chain, setChain] = useState<IntroKey | null>(null)

  const handleDone = () => setPlaying((cur) => (cur === "odyssey" && chain ? chain : null))

  return (
    <div className="mx-auto w-full max-w-3xl space-y-8 py-8">
      <header className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight">Intro Lab</h1>
        <p className="text-sm text-muted-foreground">
          Try out the candidate app intros. Click or press Esc during playback to skip.
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
        {INTROS.map((intro) => (
          <Card key={intro.key} className="gap-4">
            <CardHeader>
              <CardTitle>{intro.title}</CardTitle>
              <CardDescription>{intro.tagline}</CardDescription>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">{intro.beats}</CardContent>
            <CardFooter className="mt-auto justify-between gap-2">
              <Badge variant="outline">{intro.tech}</Badge>
              <Button size="sm" onClick={() => setPlaying(intro.key)}>
                Play
              </Button>
            </CardFooter>
          </Card>
        ))}
      </div>

      <section className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed p-4">
        <span className="mr-1 text-sm text-muted-foreground">After Odyssey, chain into:</span>
        {CHAIN_OPTIONS.map((opt) => (
          <Button
            key={opt.label}
            size="xs"
            variant={chain === opt.key ? "default" : "outline"}
            onClick={() => setChain(opt.key)}
          >
            {opt.label}
          </Button>
        ))}
      </section>

      {playing && (
        <Suspense fallback={<div className="fixed inset-0 z-[100] bg-black" />}>
          {playing === "coronation" && <CoronationIntro onDone={handleDone} />}
          {playing === "genesis" && <GenesisIntro onDone={handleDone} />}
          {playing === "monolith" && <MonolithIntro onDone={handleDone} />}
          {playing === "odyssey" && <OdysseyIntro onDone={handleDone} />}
        </Suspense>
      )}
    </div>
  )
}

// Client-safe barrel: the decay/momentum pure fns + types, with NO engine
// service (pg/node) imports — importable from the browser via the package's
// `./computed` export. Keep this file dependency-free.

export {
  DEFAULT_DECAY_BANDS,
  type DecayBand,
  type DecayParams,
  type DecayResult,
  decay,
} from "./decay"
export {
  DEFAULT_WINDOW_DAYS,
  type MomentumLabel,
  type MomentumParams,
  type MomentumResult,
  momentum,
} from "./momentum"

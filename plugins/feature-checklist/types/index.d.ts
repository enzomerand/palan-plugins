export type Check = { isDone: boolean; note?: string; isLaunched?: boolean }
export type BrowserTests = {
  status: 'done' | 'not_done' | 'not_applicable'
  note?: string
}
export type Item = { id: string; what: string; why?: string; isLaunched: boolean }
export type Decision = { id: string; what: string; answer?: string }
export type Report = {
  id: string
  feature: string
  simplification: Check
  review: Check
  browserTests: BrowserTests
  discarded: Item[]
  toDecide: Decision[]
  risks: Item[]
  merge: Check
}

declare module 'claude-code' {
  interface PluginState {
    'feature-checklist': { report: Shaped<Report | null>; paneShown: boolean }
  }
}

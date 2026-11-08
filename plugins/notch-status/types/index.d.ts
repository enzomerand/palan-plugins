/** L'état d'une session, tel que son fichier le publie. */
export type Status = 'working' | 'waiting' | 'done' | 'error' | 'ended'

/** Une autre session vivante dans le même arbre de travail. */
export type Neighbour = { id: string; title: string; status: Status }

/** La fenêtre d'usage de 7 jours du forfait : la part utilisée et sa remise à zéro (ISO 8601). */
export type WeekUsage = { percent: number; resetsAt: string | null }

declare module 'claude-code' {
  interface PluginState {
    'notch-status': { neighbours: Neighbour[]; week: WeekUsage | null }
  }
}

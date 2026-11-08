import { atom, read, update as setAtom } from 'claude-code'
import type { EngineInterface as Engine, Register, SessionRateLimit } from 'claude-code'

import type { Neighbour, Status, WeekUsage } from '../types'

/*
 * notch-status : publie l'état de chaque session Claude Code dans
 * ~/.claude/notch/sessions/<id>.json. L'app ClaudeNotch (dossier app/) lit
 * ces fichiers et les affiche dans l'encoche du Mac.
 *
 *   working  Claude travaille (un tour est en cours)
 *   waiting  Claude attend ta réponse (permission, question, plan à valider)
 *   done     le tour est fini, Claude attend ton prochain message
 *   error    le tour s'est arrêté sur une erreur d'API
 *   ended    la session est fermée (l'app supprime le fichier)
 *
 * L'aiguilleur lit les fichiers des autres sessions vivantes pour qu'elles ne
 * se marchent pas dessus. Il ne refuse rien : il demande ton accord avant
 *   - de modifier (Edit, Write) un fichier qu'une autre session a modifié il y a moins de 15 min ;
 *   - de changer de branche, remiser ou effacer (switch, checkout, stash,
 *     reset --hard, clean -f, rebase) dans un dossier où une autre session travaille ;
 *   - d'écrire (Edit, Write) hors du projet de la session.
 * Un bandeau au-dessus de la saisie nomme les autres sessions du même dossier.
 *
 * Au pied de la saisie, une pilule montre l'usage de la semaine du forfait (la
 * fenêtre de 7 jours) ; son texte n'apparaît qu'au survol.
 *
 * Un hook qui échoue est sauté par le moteur : l'outil, la décision ou le dessin
 * de l'app passent alors tels quels. Le mod ne bloque jamais rien par panne.
 */

type SessionFile = {
  version: 1
  id: string
  status: Status
  title: string
  /** Vrai une fois le titre pris d'un message tapé par la personne. */
  titleFromPerson?: boolean
  project: string
  cwd: string
  /** Racine normalisée de l'arbre de travail git (un worktree a la sienne), null hors git. */
  checkout?: string | null
  branch: string | null
  hostBundleId: string | null
  hostName: string | null
  surface: string | null
  isInteractive: boolean
  lastPrompt: string
  lastAnswer: string
  waitingFor: string | null
  /** Fichiers modifiés par la session : chemin normalisé → heure de la dernière écriture. */
  claims?: Record<string, number>
  startedAt: number
  statusSince: number
  updatedAt: number
}

type Context = Pick<SessionFile, 'cwd' | 'checkout' | 'project' | 'branch' | 'hostBundleId' | 'hostName' | 'surface'>

type Change = (current: SessionFile) => Partial<SessionFile> | Promise<Partial<SessionFile>>

type Conflict = {
  /** Ce que la boîte de dialogue montre. */
  reason: string
  /** Ce que l'encoche affiche pendant l'attente. */
  short: string
  /** Ce que l'accord de la personne couvre ensuite, sans redemander. */
  grant?: () => void
}

/** L'app considère une session morte sans nouvelles depuis 2 minutes. */
const HEARTBEAT_MS = 20_000
const ALIVE_MS = 120_000
/** Un fichier modifié reste « pris » par sa session pendant 15 minutes. */
const CLAIM_MS = 15 * 60_000
/** Le bandeau relit les autres sessions toutes les 10 secondes. */
const NEIGHBOURS_MS = 10_000
/** Outils qui attendent toujours la personne, quel que soit le mode. */
const PERSON_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode'])
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
/** Les verbes git qui touchent tout l'arbre de travail : la branche, les fichiers non validés. */
const GIT_RISKY = new Set(['switch', 'checkout', 'stash', 'reset', 'clean', 'rebase'])
const APP_PATH = 'app/build/ClaudeNotch.app'

const STATUS_LABEL: Record<Status, string> = {
  working: 'en cours',
  waiting: 'attend ta réponse',
  done: 'terminée',
  error: 'en erreur',
  ended: 'fermée',
}

/** La pilule au pied de la saisie (bureau), en pixels : sa largeur et son épaisseur. */
const WEEK_WIDTH = 96
const WEEK_HEIGHT = 6
/** Dans un terminal, qui n'a pas de SVG : un trait de caractères d'un quart de ligne. */
const WEEK_GLYPH = '▂'
const WEEK_CELLS = 12
/** Les couleurs du SVG, qui ne lit pas le thème : orange Claude, ambre, rouge. */
const WEEK_COLORS = { claude: '#D97757', warning: '#E8A33D', error: '#E5484D' } as const
const WEEK_STORE_KEY = 'week'

const neighbours = atom({ plugin: 'notch-status', key: 'neighbours' } as const, [])
const week = atom({ plugin: 'notch-status', key: 'week' } as const, null)

const clean = (text: string, max: number): string => {
  const plain = text
    .replace(/<(system-reminder|command-[a-z-]+|local-command-[a-z-]+)>[\s\S]*?<\/\1>/g, ' ')
    .replace(/<[^>]{1,80}>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain
}

const baseName = (path: string): string => path.split('/').filter(Boolean).pop() ?? path

const parentOf = (path: string): string => path.slice(0, path.lastIndexOf('/')) || '/'

const within = (path: string, dir: string): boolean => path === dir || path.startsWith(dir === '/' ? '/' : `${dir}/`)

/**
 * Un chemin absolu et sans détour : `~` développé, un chemin relatif résolu
 * depuis `cwd`, `.` et `..` retirés, /private/tmp et /private/var ramenés à
 * /tmp et /var (macOS). Les liens symboliques ne sont pas suivis.
 */
function normalize(path: string, cwd: string, home = ''): string {
  const full =
    path === '~' || path.startsWith('~/') ? home + path.slice(1) : path.startsWith('/') ? path : `${cwd}/${path}`
  const parts: string[] = []
  for (const part of full.split('/')) {
    if (part === '..') parts.pop()
    else if (part !== '' && part !== '.') parts.push(part)
  }
  return `/${parts.join('/')}`.replace(/^\/private\/(tmp|var)(?=\/|$)/, '/$1')
}

/** Où une session travaille : son arbre de travail git, sinon son dossier. */
const placeOf = (session: SessionFile): string => normalize(session.checkout ?? session.cwd, '/')

const minutes = (ms: number): string => (ms < 60_000 ? "moins d'une minute" : `${Math.round(ms / 60_000)} min`)

const nameOf = (session: SessionFile): string => `« ${clean(session.title, 40) || 'sans titre'} »`

const keepRecent = (claims: Record<string, number>, now: number): Record<string, number> =>
  Object.fromEntries(Object.entries(claims).filter(([, at]) => now - at < CLAIM_MS))

const argsOf = (input: unknown): Record<string, unknown> =>
  (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>

/** Le fichier qu'un outil d'écriture va modifier, tel que l'appel le nomme. */
const targetOf = (tool: string, input: unknown): string | null => {
  if (!WRITE_TOOLS.has(tool)) return null
  const args = argsOf(input)
  const path = args.file_path ?? args.notebook_path
  return typeof path === 'string' && path !== '' ? path : null
}

/**
 * Les mots d'une commande shell, segment par segment (séparés par &&, ||, ;, |
 * ou un retour à la ligne), guillemets et échappements respectés. Assez pour
 * suivre les `cd` et lire les commandes git ; pas un vrai shell.
 */
function shellSegments(command: string): string[][] {
  const segments: string[][] = []
  let words: string[] = []
  let word = ''
  let hasWord = false
  let quote = ''
  const endWord = () => {
    if (hasWord) words.push(word)
    word = ''
    hasWord = false
  }
  const endSegment = () => {
    endWord()
    if (words.length > 0) segments.push(words)
    words = []
  }
  for (let i = 0; i < command.length; i++) {
    const c = command.charAt(i)
    if (quote !== '') {
      if (c === quote) quote = ''
      else word += c
    } else if (c === '"' || c === "'") {
      quote = c
      hasWord = true
    } else if (c === '\\' && i + 1 < command.length) {
      word += command.charAt(++i)
      hasWord = true
    } else if (c === ' ' || c === '\t') endWord()
    else if (c === ';' || c === '\n' || c === '&' || c === '|') endSegment()
    else {
      word += c
      hasWord = true
    }
  }
  endSegment()
  return segments
}

/**
 * La première commande git de la ligne qui toucherait tout l'arbre de travail,
 * et le dossier où elle tourne (les `cd` qui la précèdent, son `-C`), ou null.
 */
function riskyGit(command: string, cwd: string, home: string): { verb: string; dir: string } | null {
  let dir = cwd
  for (const [program, ...rest] of shellSegments(command)) {
    if (program === 'cd') {
      if (rest[0] !== '-') dir = normalize(rest[0] ?? '~', dir, home)
      continue
    }
    if (program !== 'git') continue
    // Les options globales, avant le verbe : -C <dossier>, -c <clé=valeur>, --no-pager…
    let here = dir
    let i = 0
    while ((rest[i] ?? '').startsWith('-')) {
      if (rest[i] === '-C' && rest[i + 1] !== undefined) here = normalize(rest[i + 1] ?? '', here, home)
      i += rest[i] === '-C' || rest[i] === '-c' ? 2 : 1
    }
    const verb = rest[i] ?? ''
    const args = rest.slice(i + 1)
    if (!GIT_RISKY.has(verb)) continue
    if (verb === 'stash' && (args[0] === 'list' || args[0] === 'show')) continue
    if (verb === 'reset' && !args.includes('--hard')) continue
    if (verb === 'clean' && !args.some(arg => arg === '--force' || /^-[a-zA-Z]*f/.test(arg))) continue
    return { verb: `git ${verb}`, dir: here }
  }
  return null
}

/** Ce que Claude attend, en une ligne courte. */
const describe = (tool: string, input: unknown): string => {
  const args = argsOf(input)
  const text = (key: string): string => (typeof args[key] === 'string' ? (args[key] as string) : '')
  if (tool === 'Bash') return clean(`Bash : ${text('command')}`, 70)
  if (tool === 'ExitPlanMode') return 'Valider le plan'
  if (tool === 'AskUserQuestion') {
    const questions = Array.isArray(args.questions) ? args.questions : []
    const first = questions[0] as { question?: unknown } | undefined
    return typeof first?.question === 'string' ? clean(`Question : ${first.question}`, 70) : 'Une question pour toi'
  }
  if (text('file_path') !== '') return `${tool} : ${baseName(text('file_path'))}`
  if (tool.startsWith('mcp__')) {
    const [, server = '', name = ''] = tool.split('__')
    return `${name} (${server})`
  }
  return tool
}

/** Le fichier d'une autre session, tel qu'on peut s'y fier. */
const isSessionFile = (value: unknown): value is SessionFile => {
  const s = value as Partial<SessionFile> | null
  return (
    typeof s === 'object' &&
    s !== null &&
    s.version === 1 &&
    typeof s.id === 'string' &&
    typeof s.status === 'string' &&
    typeof s.title === 'string' &&
    typeof s.cwd === 'string' &&
    typeof s.updatedAt === 'number' &&
    (s.claims === undefined || (typeof s.claims === 'object' && s.claims !== null))
  )
}

/** « dans 1 j 14 h », « dans 14 h », « dans 3 j » : jours et heures, sans les zéros ; sous une heure, en minutes. */
const until = (ms: number): string => {
  const days = Math.floor(ms / 86_400_000)
  const hours = Math.floor((ms % 86_400_000) / 3_600_000)
  if (days === 0 && hours === 0) return `dans ${Math.max(1, Math.round(ms / 60_000))} min`
  return `dans ${[days > 0 ? `${days} j` : '', hours > 0 ? `${hours} h` : ''].filter(Boolean).join(' ')}`
}

/** La fenêtre de 7 jours parmi celles que l'API rapporte, ou null. */
const weekOf = (limits: readonly SessionRateLimit[]): WeekUsage | null => {
  const found = limits.find(limit => limit.kind === 'seven_day')
  return found === undefined ? null : { percent: found.percentUsed, resetsAt: found.resetsAt ?? null }
}

/** Une lecture dont la semaine est finie (ou sans date) ne dit plus rien. */
const isOver = (reading: WeekUsage, now: number): boolean =>
  reading.resetsAt === null || Date.parse(reading.resetsAt) <= now

/** La pilule en SVG, à sa taille exacte : une piste et sa part remplie, aux bouts ronds. */
function weekSvg(percent: number, color: string): string {
  const width = WEEK_WIDTH
  const height = WEEK_HEIGHT
  // Une part non nulle reste visible : au moins un rond.
  const filled = percent > 0 ? Math.max(height, (width * percent) / 100) : 0
  const pill = (w: number, paint: string) =>
    `<rect width="${w.toFixed(1)}" height="${height}" rx="${height / 2}" ${paint}/>`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    pill(width, 'fill="#8a8a8a" fill-opacity="0.3"') +
    (filled > 0 ? pill(filled, `fill="${color}"`) : '') +
    '</svg>'
  )
}

// L'état de la session, propre à ce chargement du module.
let file: SessionFile | undefined
let home: string | undefined
let isInteractive = false
let stopTimers: (() => void) | undefined
/** Vrai une fois qu'une réponse de cette session a rapporté la limite de 7 jours. */
let weekSeen = false
/** Les appels d'outils qui attendent la personne en ce moment. */
const asking = new Set<string>()
/** Les écritures passent l'une après l'autre, dans l'ordre des évènements. */
let chain: Promise<void> = Promise.resolve()
/** Fichier → heure de la modification d'une autre session que la personne a acceptée. */
const grantedFiles = new Map<string, number>()
/** Dossiers où la session peut écrire sans demander : ceux où la personne a accepté, ceux ajoutés (/add-dir). */
const grantedPlaces = new Set<string>()
/** L'accord en attente, par appel d'outil : appliqué si l'appel a bien tourné. */
const approvals = new Map<string, () => void>()
/** Les fichiers des autres sessions déjà lus, par nom : relus seulement quand ils changent. */
const seen = new Map<string, { mtimeMs: number; session: SessionFile | undefined }>()

async function homeDir($: Engine): Promise<string> {
  home ??= await $.env.get('HOME')
  if (home === undefined || home === '') throw new Error('HOME is not set')
  return home
}

async function sessionsDir($: Engine): Promise<string> {
  return `${await homeDir($)}/.claude/notch/sessions`
}

/** La racine normalisée de l'arbre de travail git qui contient `dir`, ou null. */
async function gitTop($: Engine, dir: string): Promise<string | null> {
  const run = await $.process
    .run(['git', 'rev-parse', '--show-toplevel'], { cwd: dir, timeoutMs: 3000 })
    .catch(() => undefined)
  const top = run?.exitCode === 0 ? run.stdout.trim() : ''
  return top === '' ? null : normalize(top, '/')
}

async function readContext($: Engine): Promise<Context> {
  const cwd = await $.session.cwd()
  const [repo, git, checkout, hostBundleId, hostName, surface] = await Promise.all([
    $.session.repo().catch(() => null),
    $.process.run(['git', 'branch', '--show-current'], { cwd, timeoutMs: 3000 }).catch(() => undefined),
    gitTop($, cwd),
    $.env.get('__CFBundleIdentifier'),
    $.env.get('TERM_PROGRAM'),
    $.session.surface().catch(() => null),
  ])
  return {
    cwd,
    checkout,
    project: cwd.includes('/scratch-workspaces/') ? 'Sans dossier' : baseName(repo?.root ?? cwd),
    branch: git?.exitCode === 0 && git.stdout.trim() !== '' ? git.stdout.trim() : null,
    hostBundleId: hostBundleId ?? null,
    hostName: hostName ?? null,
    surface: surface ?? null,
  }
}

async function loadFile($: Engine, id: string): Promise<SessionFile | undefined> {
  try {
    const saved: unknown = JSON.parse(await $.fs.read(`${await sessionsDir($)}/${id}.json`))
    return isSessionFile(saved) && saved.id === id ? saved : undefined
  } catch {
    return undefined
  }
}

function update($: Engine, change: Change): Promise<void> {
  chain = chain
    .then(async () => {
      const id = await $.session.id()
      const now = await $.clock.now()
      let current = file?.id === id ? file : await loadFile($, id)
      current ??= {
        version: 1,
        id,
        status: 'done',
        title: '',
        ...(await readContext($)),
        isInteractive,
        lastPrompt: '',
        lastAnswer: '',
        waitingFor: null,
        startedAt: now,
        statusSince: now,
        updatedAt: now,
      }
      const updated: SessionFile = { ...current, ...(await change(current)), updatedAt: now }
      if (updated.status !== current.status) updated.statusSince = now
      file = updated
      await $.fs.write(`${await sessionsDir($)}/${id}.json`, JSON.stringify(updated))
    })
    .catch(error => {
      void $.ui.log(`notch-status: ${String(error)}`, { to: 'debug' })
    })
  return chain
}

/**
 * Les autres sessions vivantes, d'après leurs fichiers. Seuls les fichiers dont
 * la date a changé depuis la dernière lecture sont relus ; un fichier illisible
 * (en cours d'écriture) garde sa lecture précédente jusqu'au prochain passage.
 */
async function readOthers($: Engine): Promise<SessionFile[]> {
  const dir = await sessionsDir($)
  const mine = `${await $.session.id()}.json`
  const now = await $.clock.now()
  const entries = (await $.fs.list(dir).catch(() => [])).filter(
    entry => entry.kind === 'file' && entry.name.endsWith('.json') && entry.name !== mine && now - entry.mtimeMs < ALIVE_MS,
  )
  const names = new Set(entries.map(entry => entry.name))
  for (const name of seen.keys()) if (!names.has(name)) seen.delete(name)
  const sessions = await Promise.all(
    entries.map(async entry => {
      const cached = seen.get(entry.name)
      if (cached?.mtimeMs === entry.mtimeMs) return cached.session
      try {
        const parsed: unknown = JSON.parse(await $.fs.read(`${dir}/${entry.name}`))
        const session = isSessionFile(parsed) ? parsed : undefined
        seen.set(entry.name, { mtimeMs: entry.mtimeMs, session })
        return session
      } catch {
        return cached?.session
      }
    }),
  )
  return sessions.filter(
    (session): session is SessionFile =>
      session !== undefined && session.status !== 'ended' && now - session.updatedAt < ALIVE_MS,
  )
}

/** Le dossier de la session et son arbre de travail git. */
async function whereAmI($: Engine): Promise<{ cwd: string; checkout: string | null }> {
  const cwd = await $.session.cwd()
  if (file?.cwd === cwd && file.checkout !== undefined) return { cwd, checkout: file.checkout }
  return { cwd, checkout: await gitTop($, cwd) }
}

/** Ce qu'un appel d'outil risque de casser chez une autre session, ou null. */
async function findConflict($: Engine, tool: string, input: unknown): Promise<Conflict | null> {
  const command = argsOf(input).command
  if (tool === 'Bash' && typeof command === 'string') {
    if (!command.includes('git')) return null
    const [here, home] = await Promise.all([whereAmI($), homeDir($)])
    const risky = riskyGit(command, here.cwd, home)
    if (risky === null) return null
    const target = risky.dir === here.cwd ? here.checkout : await gitTop($, risky.dir)
    if (target === null) return null
    const others = (await readOthers($)).filter(other => placeOf(other) === target)
    if (others.length === 0) return null
    const who = others.map(other => `${nameOf(other)}, ${STATUS_LABEL[other.status]}`).join(' ; ')
    const count = others.length === 1 ? 'Une autre session travaille' : `${others.length} autres sessions travaillent`
    return {
      reason: `${count} dans ${baseName(target)} (${who}). « ${risky.verb} » changerait aussi sa branche ou ses fichiers. Continuer ? Un worktree éviterait le conflit.`,
      short: `${risky.verb} : ${others.length === 1 ? 'une autre session' : `${others.length} sessions`} dans ce dossier`,
    }
  }

  const raw = targetOf(tool, input)
  if (raw === null) return null
  const [here, home, others, now] = await Promise.all([whereAmI($), homeDir($), readOthers($), $.clock.now()])
  const path = normalize(raw, here.cwd, home)
  let holder: SessionFile | undefined
  let at = 0
  for (const other of others) {
    const claimed = other.claims?.[path] ?? 0
    if (claimed > now - CLAIM_MS && claimed > at && claimed > (grantedFiles.get(path) ?? 0)) {
      holder = other
      at = claimed
    }
  }
  if (holder !== undefined) {
    const claimed = at
    return {
      reason: `${baseName(path)} a été modifié il y a ${minutes(now - at)} par une autre session (${nameOf(holder)}, ${STATUS_LABEL[holder.status]}). Le modifier aussi ?`,
      short: `${baseName(path)} : aussi modifié par ${nameOf(holder)}`,
      grant: () => grantedFiles.set(path, claimed),
    }
  }

  const root = here.checkout ?? normalize(here.cwd, '/')
  const safe = [root, normalize(here.cwd, '/'), `${home}/.claude`, '/tmp', '/var/folders', ...grantedPlaces]
  if (safe.some(dir => within(path, dir))) return null
  const place = (await gitTop($, parentOf(path))) ?? parentOf(path)
  if (grantedPlaces.has(place)) return null
  return {
    reason: `${baseName(path)} est dans ${baseName(place)}, hors du projet de cette session (${baseName(root)}). Écrire quand même ?`,
    short: `Écriture hors projet : ${baseName(place)}`,
    grant: () => grantedPlaces.add(place),
  }
}

/** Retient qu'un fichier vient d'être modifié par cette session. */
async function claim($: Engine, raw: string): Promise<void> {
  const [now, cwd, home] = await Promise.all([$.clock.now(), $.session.cwd(), homeDir($)])
  const path = normalize(raw, cwd, home)
  await update($, current => ({ claims: keepRecent({ ...current.claims, [path]: now }, now) }))
}

/** Relit les autres sessions du même arbre de travail, pour le bandeau. */
async function refreshNeighbours($: Engine): Promise<void> {
  if (file === undefined || file.status === 'ended') return
  const mine = placeOf(file)
  const list: Neighbour[] = (await readOthers($))
    .filter(other => placeOf(other) === mine)
    .map(other => ({ id: other.id, title: clean(other.title, 40) || 'sans titre', status: other.status }))
  await setAtom($, neighbours, previous => (JSON.stringify(previous) === JSON.stringify(list) ? previous : list))
}

/** Affiche une lecture de la semaine (ou rien) ; `save` la garde pour les prochaines sessions. */
async function showWeek($: Engine, reading: WeekUsage | null, save: boolean): Promise<void> {
  await setAtom($, week, previous =>
    previous?.percent === reading?.percent && previous?.resetsAt === reading?.resetsAt ? previous : reading,
  )
  if (save && reading !== null) await $.store.set(WEEK_STORE_KEY, reading)
}

/**
 * Au démarrage : la lecture de l'API si elle en a une, sinon la dernière gardée,
 * en attendant la première réponse, et seulement si sa semaine n'est pas finie.
 */
async function loadWeek($: Engine): Promise<void> {
  const live = weekOf((await $.session.usage()).rateLimits)
  if (live !== null) {
    weekSeen = true
    return showWeek($, live, true)
  }
  const saved = (await $.store.get(WEEK_STORE_KEY)) as WeekUsage | undefined
  if (typeof saved?.percent === 'number' && !isOver(saved, await $.clock.now())) await showWeek($, saved, false)
}

/** Lance l'app de l'encoche ; avec `build`, la compile d'abord si elle manque (première fois). */
async function launchApp($: Engine, build = false): Promise<string> {
  const app = `${$.plugin.root}/${APP_PATH}`
  if (!(await $.fs.exists(app))) {
    if (!build) return "L'app de l'encoche n'est pas encore compilée : tape /notch."
    const built = await $.process.run(['zsh', `${$.plugin.root}/app/build.sh`], { timeoutMs: 180_000 })
    if (built.exitCode !== 0) {
      return `La compilation a échoué (les Xcode Command Line Tools sont-ils installés ?) : ${built.stderr.trim().slice(-300)}`
    }
  }
  const opened = await $.process.run(['open', '-g', app], { timeoutMs: 10_000 })
  return opened.exitCode === 0 ? "L'app de l'encoche tourne." : `open a échoué : ${opened.stderr.trim()}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    isInteractive = e.isInteractive
    // Après un rechargement du mod, on reprend le fichier déjà écrit.
    file = await loadFile($, await $.session.id())
    stopTimers?.()
    const stops = [
      $.clock.every(HEARTBEAT_MS, () => {
        if (file !== undefined && file.status !== 'ended') void update($, () => ({}))
      }),
    ]
    // Le bandeau n'a de sens que là où quelqu'un regarde.
    if (isInteractive) stops.push($.clock.every(NEIGHBOURS_MS, () => void refreshNeighbours($).catch(() => undefined)))
    stopTimers = () => stops.forEach(timer => timer.cancel())
    await $.command.register({ name: 'notch', description: "Compile si besoin et relance l'app de l'encoche (ClaudeNotch)." })
    void launchApp($).catch(() => undefined)
    void loadWeek($).catch(() => undefined)
    return started
  })

  // L'usage de la semaine, que le moteur pousse après chaque tour. La pilule ne
  // vaut que pour un abonnement qui a la limite de 7 jours : tant qu'aucune
  // réponse de la session ne l'a rapportée (clé d'API, autre abonnement), la
  // lecture gardée s'efface ; une réponse qui l'omet ensuite garde la dernière.
  on('session.measure', async ($, e, next) => {
    const reading = weekOf(e.rateLimits)
    if (reading !== null) weekSeen = true
    if (reading !== null || !weekSeen) await showWeek($, reading, true).catch(() => undefined)
    return next(e)
  })

  // Les dossiers ajoutés à la session (/add-dir) font partie de son projet.
  on('classic.DirectoryAdded', async ($, e, next) => {
    grantedPlaces.add(normalize(e.directory, '/'))
    return next(e)
  })

  on('command.run', { command: 'notch' }, async $ => ({ text: await launchApp($, true) }))

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      asking.clear()
      approvals.clear()
      void update($, async current => ({
        ...(await readContext($)),
        status: 'working',
        waitingFor: null,
        // Titre provisoire, remplacé par le premier message tapé (prompt.submit).
        title: current.title || clean(e.text, 80),
      })).then(() => refreshNeighbours($).catch(() => undefined))
    }
    return next(e)
  })

  // Le titre et le dernier message viennent de ce que la personne a tapé,
  // jamais d'un message que le moteur ou l'app injecte (notification, évènement).
  on('prompt.submit', async ($, e, next) => {
    const text = clean(e.text, 120)
    if (e.isMeta !== true && e.command === undefined && text !== '') {
      void update($, current => ({
        lastPrompt: text,
        title: current.titleFromPerson === true ? current.title : clean(e.text, 80),
        titleFromPerson: true,
      }))
    }
    return next(e)
  })

  // Le verdict de la chaîne (règles, mode) passe d'abord. L'aiguilleur change en
  // « ask » un appel qui gênerait une autre session, en gardant la raison du
  // moteur s'il demandait déjà ; un refus reste un refus.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    const conflict = verdict.decision === 'deny' ? null : await findConflict($, e.tool, e.input).catch(() => null)
    const result =
      conflict === null
        ? verdict
        : {
            decision: 'ask' as const,
            reason: verdict.decision === 'ask' && verdict.reason ? `${conflict.reason} (${verdict.reason})` : conflict.reason,
          }
    if (result.decision === 'ask' && e.tool_use_id !== undefined) {
      asking.add(e.tool_use_id)
      if (conflict?.grant !== undefined) approvals.set(e.tool_use_id, conflict.grant)
      // La boîte de dialogue n'affiche pas toujours la raison (le terminal la tait) :
      // une notification la donne, pour que la personne sache pourquoi on lui demande.
      if (conflict !== null) void $.ui.toast(`⚠ ${conflict.reason}`, { timeoutMs: 15_000 })
      const waitingFor = conflict?.short ?? describe(e.tool, e.input)
      void update($, () => ({ status: 'waiting', waitingFor }))
    }
    return result
  })

  // La demande d'accord (tool.check) a lieu pendant `next(e)` : c'est après lui
  // qu'on sait si l'appel a tourné, donc si la personne a accepté.
  on('tool.call', async ($, e, next) => {
    const id = e.tool_use_id
    if (PERSON_TOOLS.has(e.tool)) {
      asking.add(id)
      void update($, () => ({ status: 'waiting', waitingFor: describe(e.tool, e) }))
    }
    try {
      const outcome = await next(e)
      if (outcome.deny === undefined) {
        approvals.get(id)?.()
        const raw = targetOf(e.tool, e)
        if (raw !== null && outcome.isError !== true) void claim($, raw).catch(() => undefined)
      }
      return outcome
    } finally {
      approvals.delete(id)
      if (asking.delete(id) && asking.size === 0) {
        void update($, current => (current.status === 'waiting' ? { status: 'working', waitingFor: null } : {}))
      }
    }
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      asking.clear()
      void update($, () => ({
        status: e.reason === 'error' ? 'error' : 'done',
        waitingFor: null,
        lastAnswer: e.reason === 'aborted' ? 'Interrompue' : clean(e.answer, 140),
      }))
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (file?.id === e.sessionId) await update($, () => ({ status: 'ended', waitingFor: null }))
    return next(e)
  })

  // Le bandeau au-dessus de la saisie : seulement quand d'autres sessions
  // travaillent dans le même arbre de travail.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, neighbours)
    if (e.props.hasSurvey || list.length === 0) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const count = list.length === 1 ? 'Une autre session travaille' : `${list.length} autres sessions travaillent`
    const names = list
      .slice(0, 3)
      .map(other => `« ${other.title} » (${STATUS_LABEL[other.status]})`)
      .join(', ')
    return (
      <Box>
        <Text color="warning">
          ⚠ {count} dans ce dossier : {names}
          {list.length > 3 ? ', …' : ''}
        </Text>
      </Box>
    )
  })

  // Le pied de la saisie : les modes de l'app (« focus »…) tels qu'elle les
  // montre, puis la pilule de l'usage de la semaine, sans fond. Son texte n'est
  // qu'une étiquette cachée, que la surface révèle au survol.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const usage = await read($, week)
    const now = await $.clock.now()
    if (usage === null || isOver(usage, now)) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const percent = Math.max(0, Math.min(100, usage.percent))
    const tone = usage.percent >= 90 ? 'error' : usage.percent >= 75 ? 'warning' : 'claude'
    const label = `${Math.round(usage.percent)} %`
    const reset = usage.resetsAt === null ? '' : ` · ${until(Date.parse(usage.resetsAt) - now)}`
    const modes = e.props.modes.length > 0 ? <Text dimColor>{e.props.modes.join(' & ')}</Text> : null

    let track
    let tip
    if (e.surface === 'terminal') {
      // Le terminal : le trait en caractères, et l'étiquette posée sur la barre.
      const filled = Math.round((percent / 100) * WEEK_CELLS)
      track = (
        <Box>
          <Text color={tone}>{WEEK_GLYPH.repeat(filled)}</Text>
          <Text color="inactive">{WEEK_GLYPH.repeat(WEEK_CELLS - filled)}</Text>
        </Box>
      )
      tip = <Text color="inverseText" backgroundColor={tone}>{` Semaine ${label}${reset} `}</Text>
    } else {
      // Le bureau : la pilule en SVG ; l'étiquette s'ouvre dans sa propre carte.
      const { Svg } = $.ui.resolve(e)
      track = (
        <Svg
          source={weekSvg(percent, WEEK_COLORS[tone])}
          alt={`Semaine ${label}${reset}`}
          width={WEEK_WIDTH}
          height={WEEK_HEIGHT}
        />
      )
      tip = (
        <Text>
          Semaine{' '}
          <Text color={tone} weight="semibold">
            {label}
          </Text>
          {reset}
        </Text>
      )
    }

    return (
      <Box alignItems="center">
        {modes}
        <Box key="semaine" marginLeft={modes === null ? 0 : 1} alignItems="center">
          {track}
          <Box position="absolute" top={0} right={0} display="none" hover={{ display: 'flex' }}>
            {tip}
          </Box>
        </Box>
      </Box>
    )
  })
}

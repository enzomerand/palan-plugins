import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const NOW = 1_800_000_000_000
const HOME = '/Users/u'
const SESSIONS = `${HOME}/.claude/notch/sessions`

/** Les arbres de travail git connus du test : un dossier → sa racine. */
const TOPS: Record<string, string> = {
  '/p/site': '/p/site',
  '/p/site/src': '/p/site',
  '/p/site-wt': '/p/site-wt',
  '/p/boutique': '/p/boutique',
}

type Other = { id: string; title: string; status: string; checkout: string; claims?: Record<string, number>; updatedAt?: number }

const sessionFile = (other: Other) => ({
  version: 1,
  project: 'site',
  cwd: other.checkout,
  branch: 'main',
  hostBundleId: null,
  hostName: null,
  surface: 'desktop',
  isInteractive: true,
  lastPrompt: '',
  lastAnswer: '',
  waitingFor: null,
  startedAt: NOW - 3_600_000,
  statusSince: NOW - 60_000,
  updatedAt: NOW - 10_000,
  ...other,
})

/** Le moteur sous le mod : cette session dans /p/site, et les autres sessions données. */
function engine(
  on: Parameters<TestBody>[1],
  others: Other[],
  base: 'allow' | 'ask' | 'deny' = 'allow',
): void {
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? HOME : undefined }))
  on('clock.now', () => ({ value: NOW }))
  on('session.id', () => ({ value: 'me' }))
  on('session.cwd', () => ({ value: '/p/site' }))
  on('process.run', (_, e) => {
    const top = TOPS[e.init?.cwd ?? '']
    return { value: { exitCode: top === undefined ? 128 : 0, stdout: top === undefined ? '' : `${top}\n`, stderr: '' } } as never
  })
  on('fs.list', () => ({
    value: others.map(other => ({ name: `${other.id}.json`, kind: 'file', size: 1, mtimeMs: other.updatedAt ?? NOW - 10_000 })),
  }) as never)
  on('fs.read', (_, e) => {
    const other = others.find(o => e.path === `${SESSIONS}/${o.id}.json`)
    if (other === undefined) throw new Error('ENOENT')
    return { value: JSON.stringify(sessionFile(other)) }
  })
  on('fs.write', () => ({ value: undefined }))
  // Sans le mod, le moteur laisserait tout passer (ou refuserait tout).
  on('tool.check', () => ({ decision: base, reason: 'règle' }))
}

const MENU: Other = { id: 'menu', title: 'Page contact', status: 'working', checkout: '/p/site' }

test("modifier un fichier qu'une autre session vient de modifier demande l'accord", async ($, on) => {
  engine(on, [{ ...MENU, claims: { '/p/site/header.php': NOW - 3 * 60_000 } }])

  const verdict = await $.tool.check({ tool: 'Edit', input: { file_path: '/p/site/header.php' } })

  expect(verdict.decision).toBe('ask')
  expect(verdict.reason).toContain('header.php')
  expect(verdict.reason).toContain('« Page contact »')
  expect(verdict.reason).toContain('il y a 3 min')
})

test('une modification vieille de plus de 15 min, ou une session morte, ne gêne rien', async ($, on) => {
  engine(on, [
    { ...MENU, claims: { '/p/site/header.php': NOW - 20 * 60_000 } },
    { id: 'dead', title: 'Ancienne', status: 'working', checkout: '/p/site', updatedAt: NOW - 5 * 60_000, claims: { '/p/site/footer.php': NOW - 60_000 } },
  ])

  expect((await $.tool.check({ tool: 'Edit', input: { file_path: '/p/site/header.php' } })).decision).toBe('allow')
  expect((await $.tool.check({ tool: 'Write', input: { file_path: '/p/site/footer.php' } })).decision).toBe('allow')
})

test("changer de branche à côté d'une autre session demande l'accord", async ($, on) => {
  engine(on, [MENU])

  const verdict = await $.tool.check({ tool: 'Bash', input: { command: 'git switch -c feat/seo' } })
  expect(verdict.decision).toBe('ask')
  expect(verdict.reason).toContain('« git switch »')
  expect(verdict.reason).toContain('« Page contact », en cours')

  for (const command of ['git stash', 'git reset --hard HEAD', 'git -C /p/site checkout main', 'npm test && git clean -fd']) {
    expect((await $.tool.check({ tool: 'Bash', input: { command } })).decision).toBe('ask')
  }
  for (const command of ['git status', 'git stash list', 'git reset HEAD~1', 'git -C /p/boutique switch main']) {
    expect((await $.tool.check({ tool: 'Bash', input: { command } })).decision).toBe('allow')
  }
})

test('la détection git lit la commande comme un shell : guillemets, options globales, cd', async ($, on) => {
  engine(on, [MENU])

  // Le verbe après les options globales ; --force comme -f.
  for (const command of ['git --no-pager stash', 'git -c core.pager=cat checkout main', 'git clean --force', 'cd /p/site/src && git switch main']) {
    expect((await $.tool.check({ tool: 'Bash', input: { command } })).decision).toBe('ask')
  }
  // Du texte entre guillemets n'est pas une commande ; un cd vers un autre dossier change la cible.
  for (const command of ['git commit -m "fix git checkout"', 'echo "git stash"', 'cd /p/boutique && git switch main', "cd '/p/site-wt'; git stash"]) {
    expect((await $.tool.check({ tool: 'Bash', input: { command } })).decision).toBe('allow')
  }
})

test('les chemins sont normalisés avant d’être comparés', async ($, on) => {
  engine(on, [{ ...MENU, claims: { '/p/site/header.php': NOW - 60_000 } }])

  // Un détour par .. ne fait pas sortir de la vérification hors projet…
  const escaped = await $.tool.check({ tool: 'Write', input: { file_path: '/p/site/../boutique/menu.php' } })
  expect(escaped.decision).toBe('ask')
  expect(escaped.reason).toContain('dans boutique')
  // …ni de celle des fichiers pris ; /private/tmp et /tmp sont le même dossier.
  expect((await $.tool.check({ tool: 'Edit', input: { file_path: '/p/site/src/../header.php' } })).decision).toBe('ask')
  expect((await $.tool.check({ tool: 'Write', input: { file_path: '/private/tmp/x.txt' } })).decision).toBe('allow')
})

test('quand le moteur demandait déjà, sa raison est gardée', async ($, on) => {
  engine(on, [MENU], 'ask')

  const verdict = await $.tool.check({ tool: 'Bash', input: { command: 'git switch main' } })
  expect(verdict.decision).toBe('ask')
  expect(verdict.reason).toContain('« git switch »')
  expect(verdict.reason).toContain('(règle)')
})

test('une session dans un autre worktree ne gêne pas', async ($, on) => {
  engine(on, [{ ...MENU, checkout: '/p/site-wt' }])

  expect((await $.tool.check({ tool: 'Bash', input: { command: 'git switch main' } })).decision).toBe('allow')
})

test("écrire hors du projet de la session demande l'accord, sauf dans ~/.claude et /tmp", async ($, on) => {
  engine(on, [])

  const verdict = await $.tool.check({ tool: 'Write', input: { file_path: '/p/boutique/menu.php' } })
  expect(verdict.decision).toBe('ask')
  expect(verdict.reason).toContain('dans boutique, hors du projet de cette session (site)')

  for (const file_path of ['/p/site/src/a.ts', 'src/b.ts', `${HOME}/.claude/notes.md`, '/tmp/x.txt']) {
    expect((await $.tool.check({ tool: 'Write', input: { file_path } })).decision).toBe('allow')
  }
})

test('un refus du moteur reste un refus', async ($, on) => {
  engine(on, [], 'deny')

  expect((await $.tool.check({ tool: 'Write', input: { file_path: '/p/boutique/menu.php' } })).decision).toBe('deny')
})

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

const band = (surface: (typeof SURFACES)[number], maxRows = 3) =>
  ({
    plugin: 'notch-status',
    surface,
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows, bodyColumns: 100 },
  }) as never

const footer = (surface: 'terminal' | 'desktop', modes: string[] = []) =>
  ({ plugin: 'notch-status', surface, component: 'SessionMode', props: { modes } }) as never

const IN_3_DAYS = new Date(NOW + 3.5 * 86_400_000).toISOString()

test('le bandeau nomme les autres sessions du dossier, sur chaque surface', async ($, on) => {
  on('state.get', (_, e) => ({
    value: { value: e.key === 'neighbours' ? [{ id: 'menu', title: 'Page contact', status: 'working' }] : null, version: 1 },
  }))

  for (const surface of SURFACES) {
    const ui = await $.ui.mount(band(surface))
    const warning = await ui.find({ type: 'Text', text: /Page contact/ })
    expect(warning?.text).toBe('⚠ Une autre session travaille dans ce dossier : « Page contact » (en cours)')
    expect(await ui.find({ type: 'Text', text: /Semaine/ })).toBeUndefined()
    await ui.unmount()
  }
})

test("la pilule du pied de la saisie montre l'usage de la semaine, le texte au survol", async ($, on) => {
  on('clock.now', () => ({ value: NOW }))
  on('store.set', () => ({ value: undefined }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  // Ce que l'app dessine quand le mod la laisse faire.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

  await $.session.measure({
    context: {},
    rateLimits: [
      { kind: 'five_hour', percentUsed: 80 },
      { kind: 'seven_day', percentUsed: 32, resetsAt: IN_3_DAYS },
    ],
    changed: ['rateLimits'],
  } as never)

  // Le bureau : une pilule SVG de 96 × 6 px, remplie à 32 %, après les modes de l'app.
  const desktop = await $.ui.mount(footer('desktop', ['focus']))
  const svg = await desktop.find({ type: 'Svg' })
  const source = String((svg?.props as { source?: unknown } | undefined)?.source)
  expect(source).toContain('width="96" height="6" viewBox="0 0 96 6"')
  expect(source).toContain('<rect width="30.7" height="6" rx="3" fill="#D97757"/>')
  expect(svg?.props).toMatchObject({ alt: 'Semaine 32 % · dans 3 j 12 h', width: 96, height: 6 })
  expect((await desktop.find({ type: 'Text', text: /^focus$/ }))?.text).toBe('focus')
  // Le texte n'est qu'une étiquette révélée au survol.
  expect((await desktop.find({ type: 'Text', text: /^Semaine/ }))?.text).toBe('Semaine 32 % · dans 3 j 12 h')
  await desktop.unmount()

  // Le terminal : le trait en caractères, 4 remplis sur 12.
  const terminal = await $.ui.mount(footer('terminal'))
  expect((await terminal.find({ type: 'Text', text: /^▂+$/ }))?.text).toBe('▂'.repeat(4))
  expect((await terminal.find({ type: 'Text', text: /Semaine/ }))?.text).toBe(' Semaine 32 % · dans 3 j 12 h ')
  await terminal.unmount()

  // Le bandeau au-dessus de la saisie ne montre plus la barre : il laisse l'app dessiner.
  const above = await $.ui.mount(band('desktop'))
  expect((await above.find({ type: 'Text' }))?.text).toBe('engine')
  expect(await above.find({ type: 'Svg' })).toBeUndefined()
  await above.unmount()
})

test("sans lecture d'usage, le pied de la saisie reste celui de l'app", async ($, on) => {
  on('state.get', () => ({ value: { value: null, version: 1 } }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

  const ui = await $.ui.mount(footer('desktop', ['focus']))
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  expect(await ui.find({ type: 'Svg' })).toBeUndefined()
  await ui.unmount()
})

test("à 95 %, la pilule passe au rouge", async ($, on) => {
  on('clock.now', () => ({ value: NOW }))
  on('state.get', (_, e) => ({
    value: { value: e.key === 'week' ? { percent: 95, resetsAt: IN_3_DAYS } : [], version: 1 },
  }))

  const ui = await $.ui.mount(footer('desktop'))
  const svg = await ui.find({ type: 'Svg' })
  expect(String((svg?.props as { source?: unknown } | undefined)?.source)).toContain('fill="#E5484D"')
  await ui.unmount()
})

/** Ce que le moteur pousse après un tour : les fenêtres de limite de la réponse. */
const measure = (rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]) =>
  ({ context: {}, rateLimits, changed: ['rateLimits'] }) as never

test('le délai de remise à zéro : jours et heures, sans les zéros', async ($, on) => {
  on('clock.now', () => ({ value: NOW }))
  on('store.set', () => ({ value: undefined }))
  on('session.measure', (_, e) => ({ changed: e.changed }))

  const cases: [number, string][] = [
    [38 * 3_600_000, 'Semaine 10 % · dans 1 j 14 h'],
    [14 * 3_600_000 + 20 * 60_000, 'Semaine 10 % · dans 14 h'],
    [2 * 86_400_000 + 30 * 60_000, 'Semaine 10 % · dans 2 j'],
    [40 * 60_000, 'Semaine 10 % · dans 40 min'],
  ]
  for (const [ms, text] of cases) {
    await $.session.measure(measure([{ kind: 'seven_day', percentUsed: 10, resetsAt: new Date(NOW + ms).toISOString() }]))
    const ui = await $.ui.mount(footer('desktop'))
    expect((await ui.find({ type: 'Text', text: /^Semaine/ }))?.text).toBe(text)
    await ui.unmount()
  }
})

/** Le moteur pour les tests de la pilule : l'horloge, le stockage, la mesure, son propre dessin. */
function weekEngine(on: Parameters<TestBody>[1], saved: unknown = null): void {
  // L'état du mod, en mémoire : la lecture gardée au départ, puis ce que le mod écrit.
  const state = new Map<string, { value: unknown; version: number }>([['week', { value: saved, version: 1 }]])
  on('state.get', (_, e) => ({ value: state.get(e.key) ?? { value: e.key === 'week' ? null : [], version: 0 } }))
  on('state.set', (_, e) => {
    const version = (state.get(e.key)?.version ?? 0) + 1
    state.set(e.key, { value: e.value, version })
    return { value: { isSet: true as const, version } }
  })
  on('clock.now', () => ({ value: NOW }))
  on('store.set', () => ({ value: undefined }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
}

const hasPill = async ($: Parameters<TestBody>[0]) => {
  const ui = await $.ui.mount(footer('desktop'))
  const svg = await ui.find({ type: 'Svg' })
  await ui.unmount()
  return svg !== undefined
}

test("sans limite de 7 jours dans les réponses (clé d'API, autre abonnement), la lecture gardée s'efface", async ($, on) => {
  weekEngine(on, { percent: 50, resetsAt: IN_3_DAYS })

  expect(await hasPill($)).toBe(true)
  await $.session.measure(measure([]))
  expect(await hasPill($)).toBe(false)
})

test("une réponse qui omet la limite de 7 jours, après d'autres qui l'ont rapportée, garde la pilule", async ($, on) => {
  weekEngine(on)

  await $.session.measure(measure([{ kind: 'seven_day', percentUsed: 50, resetsAt: IN_3_DAYS }]))
  expect(await hasPill($)).toBe(true)
  await $.session.measure(measure([{ kind: 'five_hour', percentUsed: 20 }]))
  expect(await hasPill($)).toBe(true)
})

test('une semaine finie ne montre plus son ancien pourcentage', async ($, on) => {
  weekEngine(on, { percent: 80, resetsAt: new Date(NOW - 60_000).toISOString() })

  expect(await hasPill($)).toBe(false)
})

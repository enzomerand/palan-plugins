import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { BrowserTests, Check, Decision, Item, Report } from '../types'

const PANE = 'feature-checklist'
const TITLE = 'Bilan feature'
const TOOL = 'mcp__feature-checklist__report'

// Change the tag when Report's fields change: an earlier version's value is
// then read as null rather than half-understood.
const report = atom(
  { plugin: 'feature-checklist', key: 'report' } as const,
  null as Report | null,
  { shape: 'report-3' },
)
// Whether a surface draws the pane now: the band's button shows otherwise.
const paneShown = atom({ plugin: 'feature-checklist', key: 'paneShown' } as const, false)

const openPane = async ($: EngineInterface) => {
  const opened = await $.ui.open({ id: PANE, title: TITLE })
  await update($, paneShown, () => opened.isPlaced)
  return opened
}

const syncPaneShown = async ($: EngineInterface) => {
  const panes = await $.ui.panes()
  await update($, paneShown, () => panes.some(one => one.id === PANE && one.isPlaced))
}

const check = (description: string) => ({
  type: 'object',
  description,
  properties: {
    done: { type: 'boolean' },
    note: { type: 'string', description: 'Une phrase : ce qui reste, ce qui bloque, ou pourquoi.' },
  },
  required: ['done'],
})

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    feature: { type: 'string', description: 'Nom court de la fonctionnalité (titre de la pull request).' },
    simplification: check('Simplification faite (trace refactor: ou RAS vérifiée).'),
    review: check('Boucle de revue close, aucun bloquant restant.'),
    browser_tests: {
      type: 'object',
      properties: {
        status: { enum: ['done', 'not_done', 'not_applicable'] },
        note: { type: 'string' },
      },
      required: ['status'],
    },
    discarded: {
      type: 'array',
      description: 'Ce qui était demandé et n’a pas été fait. Tableau vide = néant.',
      items: {
        type: 'object',
        properties: { what: { type: 'string' }, why: { type: 'string' } },
        required: ['what'],
      },
    },
    to_decide: {
      type: 'array',
      description: 'Ce qui attend un arbitrage du propriétaire, une question par entrée. Tableau vide = néant.',
      items: { type: 'string' },
    },
    risks: {
      type: 'array',
      description: 'Ce qui peut mal tourner. Tableau vide = néant.',
      items: {
        type: 'object',
        properties: { what: { type: 'string' } },
        required: ['what'],
      },
    },
    merge: check('Fusionnée sur main et poussée.'),
  },
  required: ['feature', 'simplification', 'review', 'browser_tests', 'discarded', 'risks', 'merge'],
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

// A model sometimes sends an array or an object as its JSON text.
const parsed = (value: unknown): unknown => {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// The fields the model must send again: one missing or malformed would read
// as « néant » or ☐, a report cleaner or worse than the cycle really was.
const problems = (e: Record<string, unknown>): string[] => {
  const tests = parsed(e.browser_tests)
  return [
    !text(e.feature) && 'feature',
    ...(['simplification', 'review', 'merge'] as const).map(key => {
      const value = parsed(e[key])
      return !(isObject(value) && typeof value.done === 'boolean') && `${key}.done`
    }),
    !(isObject(tests) && ['done', 'not_done', 'not_applicable'].includes(String(tests.status))) &&
      'browser_tests.status',
    ...(['discarded', 'risks'] as const).map(key => !Array.isArray(parsed(e[key])) && key),
    e.to_decide !== undefined && !Array.isArray(parsed(e.to_decide)) && 'to_decide',
  ].filter((one): one is string => typeof one === 'string')
}

const toCheck = (value: unknown): Check => {
  const v = parsed(value) as { done: boolean; note?: unknown }
  return { isDone: v.done, note: text(v.note) }
}

const toBrowserTests = (value: unknown): BrowserTests => {
  const v = parsed(value) as { status: BrowserTests['status']; note?: unknown }
  return { status: v.status, note: text(v.note) }
}

const toItems = (value: unknown, prefix: string): Item[] => {
  const list = parsed(value)
  return (Array.isArray(list) ? list : []).flatMap((raw, index) => {
    const v = (raw ?? {}) as { what?: unknown; why?: unknown }
    const what = text(typeof raw === 'string' ? raw : v.what)
    return what ? [{ id: `${prefix}-${index}`, what, why: text(v.why), isLaunched: false }] : []
  })
}

const toReport = (e: Record<string, unknown>, id: string): Report => ({
  id,
  feature: text(e.feature) ?? 'Fonctionnalité',
  simplification: toCheck(e.simplification),
  review: toCheck(e.review),
  browserTests: toBrowserTests(e.browser_tests),
  discarded: toItems(e.discarded, 'discarded'),
  toDecide: toItems(e.to_decide, 'decide').map(({ id, what }) => ({ id, what })),
  risks: toItems(e.risks, 'risk'),
  merge: toCheck(e.merge),
})

// A `{ tool: TOOL }` matcher typed through `on` makes TypeScript expand every
// connected MCP tool's input (TS2589 once a few hundred are connected). The
// matcher has to stay: without it every tool call of the session, its whole
// input with it, would cross to the hooks worker. So this one goes untyped.
type UntypedOn = (
  event: 'tool.call',
  matcher: { tool: string },
  hook: ($: EngineInterface, e: Record<string, unknown>) => Promise<unknown>,
) => { catch: (fallback: () => unknown) => void }

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // Side by side, and none may keep the session from starting: a tool that
    // failed to register only leaves the skill writing its table.
    await Promise.allSettled([
      $.tool.register({
        name: 'report',
        description:
          'Bilan de fin du cycle feature : à appeler à la place du tableau final. ' +
          'Affiche simplification, revue de code, tests navigateur, écarté, à décider, ' +
          'risques et fusion dans le panneau latéral « Bilan feature ».',
        inputSchema: INPUT_SCHEMA,
        isDeferred: true,
      }),
      $.command.register({
        name: 'bilan-feature',
        description: 'Rouvre le panneau du dernier bilan feature',
      }),
      syncPaneShown($),
    ])

    return next(e)
  })

  on('command.run', { command: 'bilan-feature' }, async $ => {
    await openPane($)

    return { text: 'Panneau « Bilan feature » ouvert.' }
  })

  // A surface that attaches seats the panes left waiting for one.
  on('session.attach', async ($, e, next) => {
    const attached = await next(e)
    await syncPaneShown($).catch(() => undefined)
    return attached
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const closed = await next(e)
    await update($, paneShown, () => false).catch(() => undefined)
    return closed
  })

  // A /clear ends the conversation the report was about.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await Promise.allSettled([update($, report, () => null), $.ui.close({ id: PANE })])
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, report)) === null || (await read($, paneShown))) {
      return next(e)
    }
    const { Box, Button } = $.ui.resolve(e)

    return (
      <Box>
        <Button key="open-bilan" label="📋 Bilan feature" onPress={() => openPane($)} />
      </Box>
    )
  })

  ;(on as unknown as UntypedOn)('tool.call', { tool: TOOL }, async ($, e) => {
    const wrong = problems(e)
    if (wrong.length > 0) {
      return {
        deny:
          `Bilan non affiché, champs absents ou mal formés : ${wrong.join(', ')}. ` +
          'Rappelle l’outil avec tous les champs.',
      }
    }
    // A new id per report, so a press on a drawing of the previous one marks nothing.
    await update($, report, current => toReport(e, String(Number(current?.id ?? 0) + 1)))
    const opened = await openPane($)

    // An unplaced pane stays open and is drawn once a surface takes it. The
    // desktop app's sessions say they are not interactive, as a `-p` run
    // does, so nothing tells the two apart: the table never comes back here.
    return {
      result: opened.isPlaced
        ? 'Bilan affiché dans le panneau « Bilan feature ». N’écris pas le tableau dans la conversation.'
        : `Bilan enregistré dans le panneau « Bilan feature », pas encore affiché (${opened.reason}). ` +
          'N’écris pas le tableau : dis seulement, en une ligne, que le bouton « 📋 Bilan feature » ' +
          'au-dessus de la saisie, ou /bilan-feature, l’affiche.',
    }
  }).catch(() => ({
    result: 'Le panneau n’a pas pu s’afficher : écris le tableau final dans la conversation.',
  }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    // Mobile draws no text field: decisions are then answered in the chat.
    const Input = e.surface !== 'mobile' && 'Input' in elements ? elements.Input : undefined
    const r = await read($, report)

    if (!r) {
      return (
        <Text dimColor>
          Aucun bilan pour l’instant : il s’affiche à la fin d’un cycle feature.
        </Text>
      )
    }

    // The terminal draws a row of ─ exactly as wide as the pane's body. A
    // graphical surface sizes that glyph its own way, so a row of it wraps
    // there; an empty bordered Box takes a whole row (its two borders a row
    // apart) and an Svg leaf drew nothing. So: one row of ─ cut to a single
    // line, placed out past the body's side padding, where the pane clips it
    // along with the cut's ellipsis.
    const rule = () =>
      e.surface === 'terminal' ? (
        <Text dimColor>{'─'.repeat(Math.max(1, e.props.bodyColumns))}</Text>
      ) : (
        <Box height={1}>
          <Box position="absolute" top={0} left={-8} right={-8} overflow="hidden">
            <Text dimColor wrap="truncate">
              {'─'.repeat(600)}
            </Text>
          </Box>
        </Box>
      )

    // Marks first, and only on the report this drawing shows, so a second
    // press before the redraw sends nothing; a refused prompt unmarks.
    // `mark` answers undefined when the item is already in the state asked.
    const send = async (prompt: string, mark: (current: Report, isOn: boolean) => Report | undefined) => {
      let isFirst = false
      await update($, report, current => {
        const marked = current?.id === r.id ? mark(current, true) : undefined
        isFirst = marked !== undefined
        return marked ?? current
      })
      if (!isFirst) return
      void $.prompt.submit({ text: prompt }).catch(() =>
        update($, report, current => (current?.id === r.id ? mark(current, false) : undefined) ?? current),
      )
    }

    const launch = (kind: 'discarded' | 'risks', item: Item) => () =>
      send(
        kind === 'discarded'
          ? `Fais maintenant ce qui avait été écarté dans le bilan de « ${r.feature} » : ${item.what}` +
              (item.why ? ` (écarté parce que : ${item.why})` : '') +
              '.'
          : `Traite maintenant ce risque relevé dans le bilan de « ${r.feature} » : ${item.what}`,
        (current, isOn) =>
          current[kind].some(one => one.id === item.id && one.isLaunched !== isOn)
            ? {
                ...current,
                [kind]: current[kind].map(one =>
                  one.id === item.id ? { ...one, isLaunched: isOn } : one,
                ),
              }
            : undefined,
      )

    const answer = (decision: Decision) => async (value: string) => {
      const said = value.trim()
      if (said === '') return
      await send(
        `Ma décision sur « ${decision.what} » (bilan de « ${r.feature} ») : ${said}`,
        (current, isOn) =>
          current.toDecide.some(one => one.id === decision.id && Boolean(one.answer) !== isOn)
            ? {
                ...current,
                toDecide: current.toDecide.map(one =>
                  one.id === decision.id ? { ...one, answer: isOn ? said : undefined } : one,
                ),
              }
            : undefined,
      )
    }

    const merge = () =>
      send(
        `Fusionne maintenant « ${r.feature} » : vérifie d’abord chaque condition de fusion ` +
          'du cycle feature, et arrête-toi si l’une n’est pas remplie.',
        (current, isOn) =>
          Boolean(current.merge.isLaunched) !== isOn
            ? { ...current, merge: { ...current.merge, isLaunched: isOn } }
            : undefined,
      )

    const launched = () => <Text color="success">✓ lancé</Text>

    const sectionTitle = (icon: string, label: string, count: number) => (
      <Text bold>
        {icon} {label}
        {count ? <Text dimColor> · {count}</Text> : ''}
      </Text>
    )

    const status = (mark: '☑' | '☐' | '–') => (
      <Text bold color={mark === '☑' ? 'success' : mark === '☐' ? 'error' : 'inactive'}>
        {mark === '–' ? 'sans objet' : mark}
      </Text>
    )

    const row = (icon: string, label: string, right: RenderElement, note?: string) => (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1} justifyContent="space-between" alignItems="center">
          <Text>
            {icon} {label}
          </Text>
          {right}
        </Box>
        {note && <Text dimColor>   {note}</Text>}
      </Box>
    )

    const markOf = (c: Check) => (c.isDone ? '☑' : '☐')

    const itemSection = (icon: string, label: string, kind: 'discarded' | 'risks') => {
      const items = r[kind]
      return (
        <Box flexDirection="column" gap="sm">
          {sectionTitle(icon, label, items.length)}
          {items.length === 0 && <Text dimColor>néant</Text>}
          {items.map(item => (
            <Box flexDirection="row" gap={1} justifyContent="space-between" alignItems="center">
              <Box flexDirection="column" flexShrink={1}>
                <Text>• {item.what}</Text>
                {item.why && <Text dimColor>  {item.why}</Text>}
              </Box>
              {item.isLaunched ? (
                launched()
              ) : (
                <Button key={item.id} label="Traiter" onPress={launch(kind, item)} />
              )}
            </Box>
          ))}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap="sm">
        <Text bold>{r.feature}</Text>

        {rule()}
        <Box flexDirection="column">
          {row('🧹', 'Simplification', status(markOf(r.simplification)), r.simplification.note)}
          {row('🔍', 'Revue de code', status(markOf(r.review)), r.review.note)}
          {row(
            '🌐',
            'Tests navigateur',
            status(
              r.browserTests.status === 'done'
                ? '☑'
                : r.browserTests.status === 'not_applicable'
                  ? '–'
                  : '☐',
            ),
            r.browserTests.note,
          )}
        </Box>

        {rule()}
        {itemSection('⛔', 'Écarté', 'discarded')}

        {r.toDecide.length > 0 && (
          <>
            {rule()}
            <Box flexDirection="column" gap="sm">
              {sectionTitle('❓', 'À décider', r.toDecide.length)}
              {r.toDecide.map(decision => (
                <Box flexDirection="column" gap="sm">
                  <Text>• {decision.what}</Text>
                  {decision.answer ? (
                    <Text color="success">✓ Répondu : {decision.answer}</Text>
                  ) : Input ? (
                    <Input
                      key={decision.id}
                      placeholder="Ta décision…"
                      submitLabel="Envoyer"
                      onSubmit={answer(decision)}
                    />
                  ) : (
                    <Text dimColor>Réponds dans la conversation.</Text>
                  )}
                </Box>
              ))}
            </Box>
          </>
        )}

        {rule()}
        {itemSection('⚠️', 'Risques', 'risks')}

        {rule()}
        {row(
          '🔀',
          'Fusion / merge',
          r.merge.isDone ? (
            status('☑')
          ) : r.merge.isLaunched ? (
            launched()
          ) : (
            <Button key="merge" label="Fusionner" onPress={merge} />
          ),
          r.merge.note,
        )}
      </Box>
    )
  })
}

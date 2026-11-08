import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

type Engine = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]
type Surface = 'terminal' | 'desktop' | 'vscode' | 'mobile'

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

const PANE = {
  plugin: 'feature-checklist',
  component: 'Pane',
  requestId: 'feature-checklist',
  props: {
    title: 'Bilan feature',
    isFocused: false,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

const BAND = {
  plugin: 'feature-checklist',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 60,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const REPORT = {
  tool: 'mcp__feature-checklist__report',
  feature: 'Export CSV',
  simplification: { done: true },
  review: { done: true },
  browser_tests: { status: 'not_applicable' },
  discarded: [{ what: 'Export Excel', why: 'hors périmètre' }],
  to_decide: ['Inclure les lignes archivées ?'],
  risks: [{ what: 'Fichiers volumineux non paginés' }],
  merge: { done: false, note: 'Revue humaine attendue' },
} as const

// Typed loosely: the typed form expands every connected MCP tool (TS2589).
const callTool = ($: { tool: { call: unknown } }, input: object) =>
  ($.tool.call as (input: object) => Promise<unknown>)(input)

// The engine beneath the plugin: it places panes or not, and draws what the mod leaves.
const engine = (on: On, isPlaced = true) => {
  on('ui.open', () => ({ value: isPlaced ? { isPlaced: true } : { isPlaced: false, reason: 'narrow' } }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
}

// The prompts the mod submits, in order.
const prompts = (on: On) => {
  const sent: string[] = []
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  return sent
}

const pane = <P extends Surface>($: Engine, surface: P) => $.ui.mount({ ...PANE, surface })

// Whether a surface draws a Button or an Input by key, labelled for a failure.
const seen = async ($: Engine, target: typeof PANE | typeof BAND, surface: Surface, key: string) => {
  const ui = await $.ui.mount({ ...target, surface })
  const found = (await ui.find({ key })) !== undefined
  await ui.unmount()
  return [surface, key, found]
}

test('the report fills the pane, on every surface', async ($, on) => {
  engine(on)
  expect(JSON.stringify(await callTool($, REPORT))).toContain('panneau')

  for (const surface of SURFACES) {
    const ui = await pane($, surface)
    expect((await ui.find({ type: 'Text', text: /Export CSV/ }))?.text).toBe('Export CSV')
    expect(await ui.find({ type: 'Text', text: /Reste/ })).toBeUndefined()
    // The terminal's rule is a row of ─ exactly the body's width; elsewhere one cut to a line.
    const rule = await ui.find({ type: 'Text', text: /─────/ })
    expect([surface, rule?.text.length]).toEqual([surface, surface === 'terminal' ? 50 : 600])
    for (const text of [/sans objet/, /Inclure les lignes/, /Revue humaine attendue/]) {
      const found = (await ui.find({ type: 'Text', text })) !== undefined
      expect([surface, String(text), found]).toEqual([surface, String(text), true])
    }
    await ui.unmount()
    for (const key of ['discarded-0', 'risk-0', 'merge']) {
      expect(await seen($, PANE, surface, key)).toEqual([surface, key, true])
    }
    // Mobile draws no text field: the decision is answered in the chat there.
    expect(await seen($, PANE, surface, 'decide-0')).toEqual([surface, 'decide-0', surface !== 'mobile'])
  }
})

test('a button sends its item as a prompt and is then marked launched', async ($, on) => {
  engine(on)
  const sent = prompts(on)
  await callTool($, REPORT)

  const ui = await pane($, 'terminal')
  await ui.press({ key: 'risk-0' })
  expect(sent).toEqual([
    'Traite maintenant ce risque relevé dans le bilan de « Export CSV » : Fichiers volumineux non paginés',
  ])
  await ui.unmount()

  for (const surface of ['terminal', 'desktop'] as const) {
    expect(await seen($, PANE, surface, 'risk-0')).toEqual([surface, 'risk-0', false])
    expect(await seen($, PANE, surface, 'discarded-0')).toEqual([surface, 'discarded-0', true])
    const drawn = await pane($, surface)
    expect(await drawn.find({ type: 'Text', text: /lancé/ })).toBeDefined()
    await drawn.unmount()
  }
})

test('two presses before the redraw send one prompt', async ($, on) => {
  engine(on)
  const sent = prompts(on)
  await callTool($, REPORT)

  const ui = await pane($, 'terminal')
  await Promise.allSettled([ui.press({ key: 'merge' }), ui.press({ key: 'merge' })])
  expect(sent).toHaveLength(1)
  expect(sent[0]).toContain('Fusionne maintenant « Export CSV »')
  await ui.unmount()
  expect(await seen($, PANE, 'desktop', 'merge')).toEqual(['desktop', 'merge', false])
})

test('a refused prompt takes the mark back', async ($, on) => {
  engine(on)
  on('prompt.submit', () => {
    throw new Error('refused')
  })
  await callTool($, REPORT)

  const ui = await pane($, 'terminal')
  await ui.press({ key: 'discarded-0' })
  await ui.unmount()
  expect(await seen($, PANE, 'terminal', 'discarded-0')).toEqual(['terminal', 'discarded-0', true])
})

test('a decision typed under its question is sent and then shown as answered', async ($, on) => {
  engine(on)
  const sent = prompts(on)
  await callTool($, REPORT)

  const ui = await pane($, 'terminal')
  await ui.input({ key: 'decide-0', text: '   ' })
  expect(sent).toHaveLength(0)
  await ui.input({ key: 'decide-0', text: 'Non, on les exclut' })
  expect(sent).toEqual([
    'Ma décision sur « Inclure les lignes archivées ? » (bilan de « Export CSV ») : Non, on les exclut',
  ])
  await ui.unmount()

  for (const surface of ['terminal', 'desktop'] as const) {
    expect(await seen($, PANE, surface, 'decide-0')).toEqual([surface, 'decide-0', false])
    const drawn = await pane($, surface)
    expect((await drawn.find({ type: 'Text', text: /Répondu/ }))?.text).toContain('Non, on les exclut')
    await drawn.unmount()
  }
})

test('the merge button is gone once the feature is merged', async ($, on) => {
  engine(on)
  await callTool($, { ...REPORT, merge: { done: true } })

  expect(await seen($, PANE, 'desktop', 'merge')).toEqual(['desktop', 'merge', false])
  const ui = await pane($, 'desktop')
  expect(await ui.find({ type: 'Text', text: /☑/ })).toBeDefined()
  await ui.unmount()
})

test('a malformed report is refused, naming the fields, and a JSON text is read', async ($, on) => {
  engine(on)

  const refused = JSON.stringify(
    await callTool($, { ...REPORT, risks: undefined, merge: { done: 'yes' }, browser_tests: { status: 'ok' } }),
  )
  expect(refused).toContain('merge.done')
  expect(refused).toContain('browser_tests.status')
  expect(refused).toContain('risks')
  const empty = await pane($, 'desktop')
  expect((await empty.find({ type: 'Text' }))?.text).toMatch(/Aucun bilan/)
  await empty.unmount()

  await callTool($, { ...REPORT, discarded: JSON.stringify(REPORT.discarded) })
  expect(await seen($, PANE, 'desktop', 'discarded-0')).toEqual(['desktop', 'discarded-0', true])
})

test('another tool call never reaches the mod', async ($, on) => {
  engine(on)
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: 'Bash', command: 'ls' })

  const ui = await pane($, 'desktop')
  expect((await ui.find({ type: 'Text' }))?.text).toMatch(/Aucun bilan/)
  await ui.unmount()
})

test('an unplaced pane replaces the table with one line pointing at the band', async ($, on) => {
  engine(on, false)
  const ran = JSON.stringify(await callTool($, REPORT))
  expect(ran).toContain('N’écris pas le tableau')
  expect(ran).toContain('📋 Bilan feature')
  expect(ran).toContain('/bilan-feature')
})

test('the band offers the pane only while a report exists and the pane is not shown', async ($, on) => {
  let isPlaced = false
  on('ui.open', () => ({ value: isPlaced ? { isPlaced: true } : { isPlaced: false, reason: 'narrow' } }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

  expect(await seen($, BAND, 'desktop', 'open-bilan')).toEqual(['desktop', 'open-bilan', false])

  await callTool($, REPORT)
  for (const surface of SURFACES) {
    expect(await seen($, BAND, surface, 'open-bilan')).toEqual([surface, 'open-bilan', true])
  }

  // A press asks for the pane, which is then drawn: the button goes.
  isPlaced = true
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'open-bilan' })
  expect(await ui.find({ key: 'open-bilan' })).toBeUndefined()
  await ui.unmount()
})

test('a /clear drops the report, and with it the band and the pane', async ($, on) => {
  engine(on, false)
  on('ui.close', () => ({ value: undefined }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))

  await callTool($, REPORT)
  expect(await seen($, BAND, 'desktop', 'open-bilan')).toEqual(['desktop', 'open-bilan', true])

  await $.session.end({ reason: 'clear', sessionId: 's1' } as never)
  expect(await seen($, BAND, 'desktop', 'open-bilan')).toEqual(['desktop', 'open-bilan', false])
  const ui = await pane($, 'desktop')
  expect((await ui.find({ type: 'Text' }))?.text).toMatch(/Aucun bilan/)
  await ui.unmount()
})

test('with no report yet the pane says so', async $ => {
  const ui = await pane($, 'desktop')
  expect((await ui.find({ type: 'Text' }))?.text).toMatch(/Aucun bilan/)
  await ui.unmount()
})

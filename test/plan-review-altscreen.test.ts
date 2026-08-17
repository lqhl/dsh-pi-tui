/**
 * Regression guard for plan-review under the real fullscreen renderer
 * (TuiAltScreen). The overlay is a small bottom decision bar; the full plan
 * renders in the transcript's exit_plan_mode tool card and is scrolled by the
 * alt-screen viewport (PgUp/PgDn), which must NOT be swallowed by the overlay.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Container, ScrollView, Text, TuiAltScreen, VStack } from '@earendil-works/pi-tui'
import { askQuestions } from '../src/ui/overlays.js'
import { ToolCardView } from '../src/ui/views.js'
import type { ChatItem } from '../src/core/model.js'
import { MockTerminal } from './mock-terminal.js'

const tick = (ms = 50): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const press = (terminal: MockTerminal, data: string): void => {
  assert.ok(terminal.onInput !== undefined, 'terminal input callback must be wired')
  terminal.onInput(data)
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '')
}

const PLAN = Array.from({ length: 40 }, (_, i) => `plan body line ${i + 1}`).join('\n')

function planReviewRequest(plan: string) {
  return {
    questions: [
      {
        id: 'plan-review',
        header: 'Plan review',
        question: 'Approve this plan and leave plan mode?',
        detail: plan,
        options: [
          { label: 'Approve', description: 'Leave plan mode; carry out the plan.' },
          { label: 'Keep planning', description: 'Stay in plan mode.' },
        ],
        intent: { kind: 'plan-review', approve: 'Approve' } as const,
      },
    ],
  }
}

/** The app's transcript + footer layout, with the plan tool card already folded. */
function setup(plan: string) {
  const terminal = new MockTerminal()
  terminal.width = 80
  terminal.height = 24
  const tui = new TuiAltScreen(terminal)
  const messages = new Container()
  const item: ChatItem = {
    id: 0,
    kind: 'tool',
    text: '',
    streaming: false,
    tool: {
      callId: 'p1',
      name: 'exit_plan_mode',
      argsPreview: 'plan',
      status: 'running',
      planText: plan,
    },
  }
  messages.addChild(new ToolCardView(item))
  tui.setLayoutRoot(
    new VStack([
      {
        component: new ScrollView(messages, { follow: 'end', primary: true, overscroll: 'chain' }),
        basis: 0,
        grow: 1,
        minSize: 1,
      },
      { component: new Text('status bar', 1, 0), basis: 'auto', shrink: 1, minSize: 1 },
    ]),
  )
  return { tui, terminal }
}

test('alt-screen: PgUp scrolls the transcript plan while the decision bar stays pinned', async () => {
  const { tui, terminal } = setup(PLAN)
  tui.start()
  const answerPromise = askQuestions(tui, planReviewRequest(PLAN))
  tui.requestRender()
  await tick()

  const before = stripAnsi(terminal.output)
  assert.ok(before.includes('plan body line'), 'plan card renders in the transcript')
  assert.ok(before.includes('→'), 'decision list must be visible')
  assert.ok(before.includes('Keep planning'), 'keep-planning option must be visible')
  // The plan overflows the transcript viewport and follows the end, so the
  // viewport sits below the top (there is content to scroll up to).
  assert.ok(
    tui.viewportTop > 0,
    `transcript should follow the plan's end (scrollTop ${tui.viewportTop})`,
  )

  press(terminal, '\x1b[5~') // PageUp scrolls the transcript viewport, not the overlay
  await tick()

  assert.equal(tui.viewportTop, 0, 'PgUp should scroll the transcript to the top')
  assert.ok(stripAnsi(terminal.output).includes('Keep planning'), 'decision bar stayed pinned')

  // Enter still approves through the focused decision bar.
  press(terminal, '\r')
  const answer = await answerPromise
  assert.deepEqual(answer.answers, [{ id: 'plan-review', selected: ['Approve'] }])
  tui.stop()
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TuiMainScreen } from '@earendil-works/pi-tui'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import { askQuestions } from '../src/ui/overlays.js'
import { MockTerminal } from './mock-terminal.js'

const tick = (ms = 50): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const press = (terminal: MockTerminal, data: string): void => {
  assert.ok(terminal.onInput !== undefined, 'terminal input callback must be wired')
  terminal.onInput(data)
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '')
}

/** Mirrors dsh-plan-mode's real exit_plan_mode review request shape. */
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

test('plan-review overlay shows the decision bar and approves on Enter', async () => {
  const terminal = new MockTerminal()
  const tui = new TuiMainScreen(terminal)
  tui.start()

  const plan = Array.from({ length: 30 }, (_, i) => `plan body line ${i + 1}`).join('\n')
  const answerPromise = askQuestions(tui, planReviewRequest(plan))

  tui.requestRender()
  await tick()

  const output = stripAnsi(terminal.output)
  // SelectList marks the selected item with "→ "; the approve option is first
  // and selected, so its marker proves the decision list rendered (the question
  // text alone contains "Approve", so it can't be used as the signal).
  assert.ok(output.includes('→'), 'selected (approve) list item must be visible in the frame')
  assert.ok(output.includes('Keep planning'), 'keep-planning option must be visible in the frame')
  assert.ok(
    output.includes('PgUp/PgDn scroll the plan'),
    'scroll hint must be visible in the frame',
  )
  // The plan body no longer renders inside the overlay — it lives in the
  // transcript's exit_plan_mode tool card, which the main viewport scrolls.
  assert.ok(!output.includes('plan body line 1'), 'plan body must not render in the overlay')

  // The approve option is first, so Enter approves.
  press(terminal, '\r')
  const answer = await answerPromise
  assert.deepEqual(answer.answers, [{ id: 'plan-review', selected: ['Approve'] }])
  tui.stop()
})

test('Esc on a plan review dismisses with ASK_CANCELLED (chat instead)', async () => {
  const terminal = new MockTerminal()
  const tui = new TuiMainScreen(terminal)
  tui.start()

  const answerPromise = askQuestions(tui, planReviewRequest('# Plan\nplan body'))

  tui.requestRender()
  await tick()
  press(terminal, '\x1b')

  await assert.rejects(answerPromise, (error: unknown) => {
    assert.ok(
      error instanceof UserQuestionError,
      `expected UserQuestionError, got ${String(error)}`,
    )
    assert.equal(error.code, 'ASK_CANCELLED')
    return true
  })
  tui.stop()
})
